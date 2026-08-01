import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-pdf-ocr-test-"));

process.env.DATABASE_FILE = path.join(tempRoot, "test.db");
process.env.UPLOADS_DIR = path.join(tempRoot, "uploads");
// Pin the AI feature flags too. config.js calls dotenv.config() at import,
// so without this a developer's local server/.env leaks into the suite --
// setting ASK_EVIDENCE_CONTRACT=true there made these tests take the
// evidence path and attempt REAL API calls. Cases that want the contract
// enable it explicitly via the evidenceContract option.
process.env.ASK_EVIDENCE_CONTRACT = "false";

process.env.OPENAI_API_KEY = "";
process.env.OCR_ENABLED = "true";

const { initializeDatabase } = await import("../src/initDatabase.js");
const { db } = await import("../src/database.js");
const { askQuestionUsingDocuments } = await import("../src/services/aiAnswerService.js");
const { retrieveKeywordChunks } = await import("../src/services/chunkRetrievalService.js");
const { rebuildDocumentChunksFromPages } = await import("../src/services/documentChunkService.js");
const { searchDocuments } = await import("../src/services/documentService.js");
const { extractPdfData } = await import("../src/services/pdfService.js");

initializeDatabase();

after(() => {
  if (typeof db.close === "function") {
    db.close();
  }

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function escapePdfText(text) {
  return String(text || "")
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

function createMinimalPdfBuffer({ pageText = "", pageTexts = null } = {}) {
  const normalizedPageTexts = Array.isArray(pageTexts) ? pageTexts : [pageText];
  const pageObjects = [];
  const kids = [];
  const fontObjectId = 3 + normalizedPageTexts.length * 2;

  normalizedPageTexts.forEach((text, index) => {
    const pageObjectId = 3 + index * 2;
    const contentObjectId = pageObjectId + 1;
    const escapedText = escapePdfText(String(text || "").replace(/\s+/g, " ").trim());
    const textCommand = escapedText
      ? `BT\n/F1 12 Tf\n72 720 Td\n(${escapedText}) Tj\nET`
      : "";

    kids.push(`${pageObjectId} 0 R`);
    pageObjects.push(
      `${pageObjectId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontObjectId} 0 R >> >> /Contents ${contentObjectId} 0 R >>\nendobj\n`,
      `${contentObjectId} 0 obj\n<< /Length ${Buffer.byteLength(textCommand, "utf8")} >>\nstream\n${textCommand}\nendstream\nendobj\n`
    );
  });

  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    `2 0 obj\n<< /Type /Pages /Count ${normalizedPageTexts.length} /Kids [${kids.join(" ")}] >>\nendobj\n`,
    ...pageObjects,
    `${fontObjectId} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`,
  ];
  const chunks = ["%PDF-1.4\n"];
  const offsets = [0];
  let offset = Buffer.byteLength(chunks[0], "utf8");

  for (const object of objects) {
    offsets.push(offset);
    chunks.push(object);
    offset += Buffer.byteLength(object, "utf8");
  }

  const xrefOffset = offset;
  chunks.push(`xref\n0 ${objects.length + 1}\n`);
  chunks.push("0000000000 65535 f \n");

  for (let objectId = 1; objectId <= objects.length; objectId += 1) {
    chunks.push(`${String(offsets[objectId]).padStart(10, "0")} 00000 n \n`);
  }

  chunks.push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

  return Buffer.from(chunks.join(""), "utf8");
}

function insertDocument({ title, originalFilename, extractedText }) {
  const vehicle = db.prepare("SELECT id FROM vehicles ORDER BY id ASC LIMIT 1").get();

  assert.ok(vehicle);

  const result = db
    .prepare(`
      INSERT INTO documents (
        vehicle_id,
        title,
        original_filename,
        stored_filename,
        file_path,
        file_type,
        system,
        document_type,
        extracted_text,
        extraction_status,
        page_count
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      vehicle.id,
      title,
      originalFilename,
      originalFilename,
      `server/uploads/${originalFilename}`,
      "application/pdf",
      "Electrical",
      "Wiring Diagram",
      extractedText,
      "completed_with_ocr",
      1
    );

  return Number(result.lastInsertRowid);
}

test("OCR leaves normal text PDFs on the existing text extraction path", async () => {
  const pdfBuffer = createMinimalPdfBuffer({
    pageText:
      "Toyota Corolla alternator wiring diagram connector A21 charging circuit inspection steps.",
  });
  let ocrCalls = 0;

  const result = await extractPdfData(pdfBuffer, {
    ocrPage: async () => {
      ocrCalls += 1;
      return { text: "This should not be needed." };
    },
  });

  assert.equal(result.extractionStatus, "completed");
  assert.equal(ocrCalls, 0);
  assert.equal(result.pageCount, 1);
  assert.equal(result.pages.length, 1);
  assert.match(result.extractedText, /alternator wiring diagram/i);
});

test("OCR runs when a PDF page has too little extractable text", async () => {
  const pdfBuffer = createMinimalPdfBuffer();
  const calls = [];

  const result = await extractPdfData(pdfBuffer, {
    ocrPage: async ({ pageNumber, pageText }) => {
      calls.push({ pageNumber, pageText });
      return {
        text: "OCR connector C12 wire colors are red white and black on page one.",
      };
    },
  });

  assert.deepEqual(calls, [{ pageNumber: 1, pageText: "" }]);
  assert.equal(result.extractionStatus, "completed_with_ocr");
  assert.equal(result.pageCount, 1);
  assert.deepEqual(result.pages, [
    {
      pageNumber: 1,
      text: "OCR connector C12 wire colors are red white and black on page one.",
    },
  ]);
});

test("OCR output becomes document chunks that preserve the source page", async () => {
  const uniqueTag = "ocrchunks";
  const documentId = insertDocument({
    title: `OCR chunk test ${uniqueTag}`,
    originalFilename: `${uniqueTag}.pdf`,
    extractedText: `${uniqueTag} fuse panel wire color text from OCR.`,
  });

  const summary = rebuildDocumentChunksFromPages(documentId, [
    {
      pageNumber: 4,
      text: `${uniqueTag} fuse panel wire color text from OCR.`,
    },
  ]);
  const rows = db
    .prepare(`
      SELECT page_number, chunk_text
      FROM document_chunks
      WHERE document_id = ?
    `)
    .all(documentId);

  assert.equal(summary.chunkCount, 1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].page_number, 4);
  assert.match(rows[0].chunk_text, /fuse panel wire color/i);
});

test("Search and Ask can retrieve OCR-created document text and chunks", async () => {
  const uniqueTag = "ocrretrieve";
  const ocrText = `${uniqueTag} blue yellow wire junction block connector pin 7 text from OCR.`;
  const documentId = insertDocument({
    title: `OCR retrieval test ${uniqueTag}`,
    originalFilename: `${uniqueTag}.pdf`,
    extractedText: ocrText,
  });

  rebuildDocumentChunksFromPages(documentId, [
    {
      pageNumber: 9,
      text: ocrText,
    },
  ]);

  const searchResults = searchDocuments({
    query: `${uniqueTag} blue yellow wire`,
  });

  assert.ok(searchResults.length >= 1);
  assert.equal(searchResults[0].id, documentId);
  assert.equal(searchResults[0].snippetField, "Extracted text");
  assert.match(searchResults[0].snippet, /blue yellow wire/i);

  const askResult = await askQuestionUsingDocuments(`${uniqueTag} connector pin 7`, {
    isAiConfigured: true,
    retrieveChunks: (question, options) => retrieveKeywordChunks(question, options),
    generateAnswerText: async ({ citations }) =>
      `The OCR chunk cites page ${citations[0].pageNumber}.`,
  });

  assert.equal(askResult.status, "answered");
  assert.equal(askResult.citations[0].documentId, documentId);
  assert.equal(askResult.citations[0].pageNumber, 9);
  assert.match(askResult.citations[0].snippet, /connector pin 7/i);
});

test("missing OCR tools produce a clear optional-dependency warning", async () => {
  const pdfBuffer = createMinimalPdfBuffer({ pageTexts: ["", ""] });
  const calls = [];

  const result = await extractPdfData(pdfBuffer, {
    ocrPage: async ({ pageNumber }) => {
      calls.push(pageNumber);
      const error = new Error("spawn tesseract ENOENT");
      error.code = "ENOENT";
      throw error;
    },
  });

  assert.deepEqual(calls, [1]);
  assert.match(result.extractionStatus, /^ocr_unavailable:/);
  assert.match(result.extractionStatus, /Tesseract and Poppler/i);
  assert.equal(result.extractedText, "");
  assert.equal(result.pageCount, 2);
  assert.deepEqual(result.pages, []);
});
