import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import request from "supertest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, "fixtures");

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-fix-helper-server-"));
const testClientDistDir = path.join(tempRoot, "client-dist");
const testAssetDir = path.join(testClientDistDir, "assets");

process.env.DATABASE_FILE = path.join(tempRoot, "test.db");
process.env.UPLOADS_DIR = path.join(tempRoot, "uploads");
process.env.PORT = "4100";
process.env.CLIENT_PORT = "5174";
process.env.OPENAI_API_KEY = "";

fs.mkdirSync(testAssetDir, { recursive: true });
fs.writeFileSync(
  path.join(testClientDistDir, "index.html"),
  '<!doctype html><html><body><div id="root">Built Corolla app</div></body></html>'
);
fs.writeFileSync(path.join(testAssetDir, "app.js"), "console.log('built asset');");

const { createApp } = await import("../src/app.js");
const { db } = await import("../src/database.js");
const {
  AI_NOT_CONFIGURED_MESSAGE,
  NOT_FOUND_MESSAGE,
  askQuestionUsingDocuments,
} = await import("../src/services/aiAnswerService.js");
const { retrieveKeywordChunks } = await import("../src/services/chunkRetrievalService.js");
const {
  backfillDocumentChunks,
  rebuildDocumentChunksFromPages,
  rebuildDocumentChunksFromStoredPdf,
} = await import("../src/services/documentChunkService.js");

const app = createApp({ clientDistDir: testClientDistDir });

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

function buildSingleLinePdfText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function createFakePdfBuffer(pageTexts) {
  const cleanedPageTexts = pageTexts.map((pageText) => buildSingleLinePdfText(pageText));
  const objectLines = [];
  const pageObjectIds = [];
  const contentObjectIds = [];

  for (let pageIndex = 0; pageIndex < cleanedPageTexts.length; pageIndex += 1) {
    const pageObjectId = 3 + pageIndex * 2;
    const contentObjectId = pageObjectId + 1;
    pageObjectIds.push(pageObjectId);
    contentObjectIds.push(contentObjectId);
  }

  const fontObjectId = 3 + cleanedPageTexts.length * 2;

  objectLines.push(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`);
  objectLines.push(
    `2 0 obj\n<< /Type /Pages /Count ${pageObjectIds.length} /Kids [${pageObjectIds
      .map((id) => `${id} 0 R`)
      .join(" ")}] >>\nendobj\n`
  );

  for (let pageIndex = 0; pageIndex < cleanedPageTexts.length; pageIndex += 1) {
    const pageObjectId = pageObjectIds[pageIndex];
    const contentObjectId = contentObjectIds[pageIndex];
    const escapedText = escapePdfText(cleanedPageTexts[pageIndex]);
    const streamContent = `BT\n/F1 12 Tf\n72 720 Td\n(${escapedText}) Tj\nET`;
    const streamLength = Buffer.byteLength(streamContent, "utf8");

    objectLines.push(
      `${pageObjectId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontObjectId} 0 R >> >> /Contents ${contentObjectId} 0 R >>\nendobj\n`
    );
    objectLines.push(
      `${contentObjectId} 0 obj\n<< /Length ${streamLength} >>\nstream\n${streamContent}\nendstream\nendobj\n`
    );
  }

  objectLines.push(
    `${fontObjectId} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`
  );

  const chunks = ["%PDF-1.4\n"];
  const offsets = [0];
  let offset = Buffer.byteLength(chunks[0], "utf8");

  for (const objectLine of objectLines) {
    offsets.push(offset);
    chunks.push(objectLine);
    offset += Buffer.byteLength(objectLine, "utf8");
  }

  const xrefOffset = offset;
  const objectCount = objectLines.length + 1;

  chunks.push(`xref\n0 ${objectCount}\n`);
  chunks.push("0000000000 65535 f \n");

  for (let objectId = 1; objectId < objectCount; objectId += 1) {
    chunks.push(`${String(offsets[objectId]).padStart(10, "0")} 00000 n \n`);
  }

  chunks.push(`trailer\n<< /Size ${objectCount} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

  return Buffer.from(chunks.join(""), "utf8");
}

function insertFakeDocument({
  title,
  originalFilename,
  storedFilename,
  system = "Engine",
  documentType = "Repair Manual",
  notes = "",
}) {
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
        notes,
        extracted_text,
        extraction_status,
        page_count
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      vehicle.id,
      title,
      originalFilename,
      storedFilename,
      `server/uploads/${storedFilename}`,
      "application/pdf",
      system,
      documentType,
      notes,
      "",
      "completed",
      null
    );

  return Number(result.lastInsertRowid);
}

function getChunkRows(documentId) {
  return db
    .prepare(`
      SELECT page_number, chunk_index, chunk_text
      FROM document_chunks
      WHERE document_id = ?
      ORDER BY page_number ASC, chunk_index ASC
    `)
    .all(documentId);
}

test("GET /api/settings returns vehicle and runtime info", async () => {
  const response = await request(app).get("/api/settings");

  assert.equal(response.status, 200);
  assert.equal(typeof response.body.vehicle.id, "number");
  assert.equal(typeof response.body.vehicle.make, "string");
  assert.equal(response.body.runtime.databaseFile, process.env.DATABASE_FILE);
  assert.equal(response.body.runtime.uploadsDir, process.env.UPLOADS_DIR);
  assert.equal(response.body.runtime.pathsEditable, false);
  assert.ok(Array.isArray(response.body.documentDefaults.commonSystems));
  assert.ok(response.body.documentDefaults.commonSystems.includes("Engine"));
  assert.ok(Array.isArray(response.body.documentDefaults.documentTypes));
  assert.equal(response.body.backupExport.supported, true);
});

test("PUT /api/settings/vehicle updates the stored vehicle profile", async () => {
  const updatedVehicle = {
    year: 2010,
    make: "Toyota",
    model: "Matrix",
    trim: "S",
    engine: "1.8L",
  };

  const updateResponse = await request(app)
    .put("/api/settings/vehicle")
    .send(updatedVehicle);

  assert.equal(updateResponse.status, 200);
  assert.equal(updateResponse.body.vehicle.year, updatedVehicle.year);
  assert.equal(updateResponse.body.vehicle.model, updatedVehicle.model);
  assert.equal(updateResponse.body.vehicle.trim, updatedVehicle.trim);

  const getResponse = await request(app).get("/api/settings");

  assert.equal(getResponse.status, 200);
  assert.equal(getResponse.body.vehicle.year, updatedVehicle.year);
  assert.equal(getResponse.body.vehicle.model, updatedVehicle.model);
  assert.equal(getResponse.body.vehicle.trim, updatedVehicle.trim);
});

test("PUT /api/settings/document-defaults updates reusable document defaults", async () => {
  const updatedDefaults = {
    commonSystems: ["Engine", "Cooling", "Electrical"],
    documentTypes: ["Repair Manual", "Inspection", "Reference"],
  };

  const updateResponse = await request(app)
    .put("/api/settings/document-defaults")
    .send(updatedDefaults);

  assert.equal(updateResponse.status, 200);
  assert.deepEqual(
    updateResponse.body.documentDefaults.commonSystems,
    updatedDefaults.commonSystems
  );
  assert.deepEqual(
    updateResponse.body.documentDefaults.documentTypes,
    updatedDefaults.documentTypes
  );

  const getResponse = await request(app).get("/api/settings");

  assert.equal(getResponse.status, 200);
  assert.deepEqual(
    getResponse.body.documentDefaults.commonSystems,
    updatedDefaults.commonSystems
  );
  assert.deepEqual(
    getResponse.body.documentDefaults.documentTypes,
    updatedDefaults.documentTypes
  );
});

test("existing core routes still respond after the app startup refactor", async () => {
  const [healthResponse, documentsResponse, symptomsResponse] = await Promise.all([
    request(app).get("/api/health"),
    request(app).get("/api/documents"),
    request(app).get("/api/symptoms"),
  ]);

  assert.equal(healthResponse.status, 200);
  assert.equal(healthResponse.body.status, "ok");
  assert.equal(documentsResponse.status, 200);
  assert.ok(Array.isArray(documentsResponse.body.documents));
  assert.equal(symptomsResponse.status, 200);
  assert.ok(Array.isArray(symptomsResponse.body.symptoms));
});

test("serves the built frontend while keeping API routes separate", async () => {
  const [rootResponse, frontendRouteResponse, assetResponse, healthResponse] =
    await Promise.all([
      request(app).get("/"),
      request(app).get("/documents/123"),
      request(app).get("/assets/app.js"),
      request(app).get("/api/health"),
    ]);

  assert.equal(rootResponse.status, 200);
  assert.match(rootResponse.headers["content-type"], /html/);
  assert.match(rootResponse.text, /Built Corolla app/);

  assert.equal(frontendRouteResponse.status, 200);
  assert.match(frontendRouteResponse.headers["content-type"], /html/);
  assert.match(frontendRouteResponse.text, /Built Corolla app/);

  assert.equal(assetResponse.status, 200);
  assert.match(assetResponse.headers["content-type"], /javascript/);
  assert.match(assetResponse.text, /built asset/);

  assert.equal(healthResponse.status, 200);
  assert.equal(healthResponse.body.status, "ok");
});

test("documents API exposes favorite, bookmark, and tag fields", async () => {
  const response = await request(app).get("/api/documents");

  assert.equal(response.status, 200);
  assert.ok(Array.isArray(response.body.documents));
  assert.ok(response.body.documents.length > 0);

  const firstDocument = response.body.documents[0];

  assert.equal(typeof firstDocument.isFavorite, "boolean");
  assert.equal(typeof firstDocument.isBookmarked, "boolean");
  assert.ok(Array.isArray(firstDocument.tags));
});

test("seed document is bookmarked and carries starter tags", async () => {
  const response = await request(app).get("/api/documents");

  const seedDocument = response.body.documents.find(
    (document) => document.title === "Sample Maintenance Schedule"
  );

  assert.ok(seedDocument);
  assert.equal(seedDocument.isBookmarked, true);
  assert.deepEqual(
    [...seedDocument.tags].sort(),
    ["engine", "maintenance", "sample"]
  );
});

test("PUT /api/documents/:id updates bookmark flag and replaces tags", async () => {
  const vehicle = db.prepare("SELECT id FROM vehicles ORDER BY id ASC LIMIT 1").get();
  assert.ok(vehicle);

  const documentId = Number(
    db
      .prepare(`
        INSERT INTO documents (
          vehicle_id,
          title,
          original_filename,
          system,
          document_type
        )
        VALUES (?, ?, ?, ?, ?)
      `)
      .run(vehicle.id, "Tag Edit Target", "tag-edit-target.pdf", "Brakes", "Reference")
      .lastInsertRowid
  );

  const firstUpdate = await request(app)
    .put(`/api/documents/${documentId}`)
    .send({
      isBookmarked: true,
      tags: ["Brakes", "torque-specs", "brakes"],
    });

  assert.equal(firstUpdate.status, 200);
  assert.equal(firstUpdate.body.document.isBookmarked, true);
  // Duplicate "brakes"/"Brakes" collapses to one tag, preserving first spelling.
  assert.deepEqual(firstUpdate.body.document.tags, ["Brakes", "torque-specs"]);

  const secondUpdate = await request(app)
    .put(`/api/documents/${documentId}`)
    .send({ tags: "brakes, calipers" });

  assert.equal(secondUpdate.status, 200);
  // Bookmark flag is untouched when not included in the body.
  assert.equal(secondUpdate.body.document.isBookmarked, true);
  // "brakes" reuses the existing "Brakes" tag, keeping one canonical spelling.
  assert.deepEqual([...secondUpdate.body.document.tags].sort(), ["Brakes", "calipers"]);

  const cleared = await request(app)
    .put(`/api/documents/${documentId}`)
    .send({ tags: [] });

  assert.equal(cleared.status, 200);
  assert.deepEqual(cleared.body.document.tags, []);
});

test("search API filters documents by tag and bookmark and matches tag keywords", async () => {
  const vehicle = db.prepare("SELECT id FROM vehicles ORDER BY id ASC LIMIT 1").get();
  assert.ok(vehicle);

  const documentId = Number(
    db
      .prepare(`
        INSERT INTO documents (
          vehicle_id,
          title,
          original_filename,
          system,
          document_type,
          is_bookmarked
        )
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(
        vehicle.id,
        "Suspension overhaul writeup",
        "suspension-overhaul.pdf",
        "Suspension",
        "Reference",
        1
      ).lastInsertRowid
  );

  await request(app)
    .put(`/api/documents/${documentId}`)
    .send({ tags: ["struts", "alignment"] });

  const tagFiltered = await request(app)
    .get("/api/search/documents")
    .query({ tag: "struts" });

  assert.equal(tagFiltered.status, 200);
  assert.ok(tagFiltered.body.results.some((result) => result.id === documentId));
  assert.ok(
    tagFiltered.body.results.every((result) =>
      result.tags.map((tag) => tag.toLowerCase()).includes("struts")
    )
  );
  assert.ok(tagFiltered.body.filters.tags.includes("struts"));

  const bookmarkFiltered = await request(app)
    .get("/api/search/documents")
    .query({ bookmarked: "true", tag: "alignment" });

  assert.equal(bookmarkFiltered.status, 200);
  assert.ok(bookmarkFiltered.body.results.some((result) => result.id === documentId));
  assert.ok(bookmarkFiltered.body.results.every((result) => result.isBookmarked === true));

  const keywordMatched = await request(app)
    .get("/api/search/documents")
    .query({ q: "alignment" });

  assert.equal(keywordMatched.status, 200);
  assert.ok(keywordMatched.body.results.some((result) => result.id === documentId));
});

test("POST /api/documents/:id/extract re-runs extraction and updates status fields", async () => {
  const vehicle = db.prepare("SELECT id FROM vehicles ORDER BY id ASC LIMIT 1").get();
  assert.ok(vehicle);

  const sourcePdf = path.join(fixturesDir, "sample-maintenance-schedule.pdf");
  const storedFilename = "extract-rerun-test.pdf";
  const uploadedPdfPath = path.join(process.env.UPLOADS_DIR, storedFilename);
  fs.copyFileSync(sourcePdf, uploadedPdfPath);

  const documentId = Number(
    db.prepare(`
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
    `).run(
      vehicle.id,
      "Extraction retry test document",
      "extract-rerun-test.pdf",
      storedFilename,
      `server/uploads/${storedFilename}`,
      "application/pdf",
      "Engine",
      "Reference",
      "",
      "failed: prior error",
      null
    ).lastInsertRowid
  );

  const response = await request(app).post(`/api/documents/${documentId}/extract`);

  assert.equal(response.status, 200);
  assert.equal(response.body.message, "Extraction re-run complete.");
  assert.equal(response.body.document.id, documentId);
  assert.ok(["completed", "no_text_found"].includes(response.body.document.extractionStatus));
  assert.equal(typeof response.body.document.extractedText, "string");
  assert.equal(typeof response.body.document.pageCount, "number");
});

test("POST /api/documents/:id/extract returns 404 when document does not exist", async () => {
  const response = await request(app).post("/api/documents/999999/extract");

  assert.equal(response.status, 404);
  assert.equal(response.body.error, "Document not found.");
});

test("notes API returns linked symptom and procedure details", async () => {
  const vehicle = db.prepare("SELECT id FROM vehicles ORDER BY id ASC LIMIT 1").get();

  assert.ok(vehicle);

  const symptomId = Number(
    db.prepare(`
      INSERT INTO symptoms (vehicle_id, title, system, status)
      VALUES (?, ?, ?, ?)
    `).run(vehicle.id, "Rough idle at stoplight", "Engine", "monitoring").lastInsertRowid
  );

  const procedureId = Number(
    db.prepare(`
      INSERT INTO procedures (vehicle_id, title, system, difficulty)
      VALUES (?, ?, ?, ?)
    `).run(vehicle.id, "Throttle body cleaning", "Engine", "beginner").lastInsertRowid
  );

  const symptomNoteResponse = await request(app)
    .post("/api/notes")
    .send({
      title: "Track idle change after cleaning",
      content: "Watch RPM after the next cold start.",
      noteType: "observation",
      relatedEntityType: "symptom",
      relatedEntityId: symptomId,
    });

  assert.equal(symptomNoteResponse.status, 201);
  assert.equal(symptomNoteResponse.body.note.relatedEntityType, "symptom");
  assert.equal(symptomNoteResponse.body.note.relatedEntityId, symptomId);
  assert.equal(symptomNoteResponse.body.note.linkedSymptom.title, "Rough idle at stoplight");
  assert.equal(symptomNoteResponse.body.note.linkedSymptom.status, "monitoring");

  const procedureNoteResponse = await request(app)
    .post("/api/notes")
    .send({
      title: "Use the basic throttle body walkthrough",
      content: "Start with the easy version before removing extra parts.",
      noteType: "repair_log",
      relatedEntityType: "procedure",
      relatedEntityId: procedureId,
    });

  assert.equal(procedureNoteResponse.status, 201);
  assert.equal(procedureNoteResponse.body.note.relatedEntityType, "procedure");
  assert.equal(procedureNoteResponse.body.note.relatedEntityId, procedureId);
  assert.equal(procedureNoteResponse.body.note.linkedProcedure.title, "Throttle body cleaning");
  assert.equal(procedureNoteResponse.body.note.linkedProcedure.difficulty, "beginner");

  const listResponse = await request(app).get("/api/notes");

  assert.equal(listResponse.status, 200);

  const symptomNote = listResponse.body.notes.find(
    (note) => note.title === "Track idle change after cleaning"
  );
  const procedureNote = listResponse.body.notes.find(
    (note) => note.title === "Use the basic throttle body walkthrough"
  );

  assert.ok(symptomNote);
  assert.equal(symptomNote.linkedSymptom.title, "Rough idle at stoplight");
  assert.equal(symptomNote.linkedProcedure, null);

  assert.ok(procedureNote);
  assert.equal(procedureNote.linkedProcedure.title, "Throttle body cleaning");
  assert.equal(procedureNote.linkedSymptom, null);
});

test("notes API updates linked note targets across documents, symptoms, and procedures", async () => {
  const vehicle = db.prepare("SELECT id FROM vehicles ORDER BY id ASC LIMIT 1").get();

  assert.ok(vehicle);

  const documentId = Number(
    db.prepare(`
      INSERT INTO documents (
        vehicle_id,
        title,
        original_filename,
        stored_filename,
        file_path,
        file_type,
        system,
        document_type
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      vehicle.id,
      "Idle inspection notes",
      "idle-inspection.pdf",
      "idle-inspection-copy.pdf",
      "C:/temp/idle-inspection.pdf",
      "application/pdf",
      "Engine",
      "Reference"
    ).lastInsertRowid
  );

  const symptomId = Number(
    db.prepare(`
      INSERT INTO symptoms (vehicle_id, title, system, status)
      VALUES (?, ?, ?, ?)
    `).run(vehicle.id, "Idle drops after warmup", "Engine", "monitoring").lastInsertRowid
  );

  const procedureId = Number(
    db.prepare(`
      INSERT INTO procedures (vehicle_id, title, system, difficulty)
      VALUES (?, ?, ?, ?)
    `).run(vehicle.id, "Idle relearn steps", "Engine", "intermediate").lastInsertRowid
  );

  const createdResponse = await request(app)
    .post("/api/notes")
    .send({
      title: "Start from the idle inspection PDF",
      content: "Check the baseline document first.",
      noteType: "general",
      relatedEntityType: "document",
      relatedEntityId: documentId,
    });

  assert.equal(createdResponse.status, 201);
  assert.equal(createdResponse.body.note.linkedDocument.title, "Idle inspection notes");
  assert.equal(createdResponse.body.note.linkedSymptom, null);
  assert.equal(createdResponse.body.note.linkedProcedure, null);

  const noteId = createdResponse.body.note.id;

  const symptomUpdateResponse = await request(app)
    .put(`/api/notes/${noteId}`)
    .send({
      relatedEntityType: "symptom",
      relatedEntityId: symptomId,
    });

  assert.equal(symptomUpdateResponse.status, 200);
  assert.equal(symptomUpdateResponse.body.note.relatedEntityType, "symptom");
  assert.equal(symptomUpdateResponse.body.note.relatedEntityId, symptomId);
  assert.equal(symptomUpdateResponse.body.note.linkedDocument, null);
  assert.equal(symptomUpdateResponse.body.note.linkedSymptom.title, "Idle drops after warmup");
  assert.equal(symptomUpdateResponse.body.note.linkedProcedure, null);

  const procedureUpdateResponse = await request(app)
    .put(`/api/notes/${noteId}`)
    .send({
      relatedEntityType: "procedure",
      relatedEntityId: procedureId,
    });

  assert.equal(procedureUpdateResponse.status, 200);
  assert.equal(procedureUpdateResponse.body.note.relatedEntityType, "procedure");
  assert.equal(procedureUpdateResponse.body.note.relatedEntityId, procedureId);
  assert.equal(procedureUpdateResponse.body.note.linkedDocument, null);
  assert.equal(procedureUpdateResponse.body.note.linkedSymptom, null);
  assert.equal(procedureUpdateResponse.body.note.linkedProcedure.title, "Idle relearn steps");
});

let uniqueCounter = 0;

function nextUniqueTag(prefix) {
  uniqueCounter += 1;
  const safePrefix = String(prefix).replace(/[^a-zA-Z0-9]/g, "");
  return `${safePrefix}${uniqueCounter}qxzv`;
}

test("Goal A DB init creates document_chunks table", () => {
  const table = db
    .prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name = 'document_chunks'
    `)
    .get();

  assert.ok(table);
});

test("Goal A chunk rebuild from stored fake PDF preserves page numbers", async () => {
  const uniqueTag = nextUniqueTag("chunk-pages");
  const storedFilename = `${uniqueTag}.pdf`;
  const absoluteFilePath = path.join(process.env.UPLOADS_DIR, storedFilename);

  fs.writeFileSync(
    absoluteFilePath,
    createFakePdfBuffer([
      `${uniqueTag} page one content about coolant sensor wiring.`,
      `${uniqueTag} page two content about torque specification values.`,
    ])
  );

  const documentId = insertFakeDocument({
    title: `Chunking ${uniqueTag}`,
    originalFilename: `${uniqueTag}.pdf`,
    storedFilename,
  });

  const rebuildSummary = await rebuildDocumentChunksFromStoredPdf(documentId);

  assert.equal(rebuildSummary.documentId, documentId);
  assert.ok(rebuildSummary.chunkCount >= 2);

  const rows = getChunkRows(documentId);
  const pageNumbers = [...new Set(rows.map((row) => row.page_number))];

  assert.deepEqual(pageNumbers, [1, 2]);
});

test("Goal A idempotent chunk backfill keeps chunk rows identical across runs", async () => {
  const uniqueTag = nextUniqueTag("backfill-idempotent");
  const storedFilename = `${uniqueTag}.pdf`;
  const absoluteFilePath = path.join(process.env.UPLOADS_DIR, storedFilename);

  fs.writeFileSync(
    absoluteFilePath,
    createFakePdfBuffer([
      `${uniqueTag} page one describes transmission solenoid checks.`,
      `${uniqueTag} page two describes resistance check values and connector pins.`,
    ])
  );

  const documentId = insertFakeDocument({
    title: `Backfill ${uniqueTag}`,
    originalFilename: `${uniqueTag}.pdf`,
    storedFilename,
  });

  const firstBackfill = await backfillDocumentChunks();

  assert.ok(firstBackfill.totalDocuments >= firstBackfill.rebuiltDocuments);
  assert.ok(firstBackfill.rebuiltDocuments >= 1);

  const firstRows = getChunkRows(documentId).map((row) => ({
    page_number: row.page_number,
    chunk_index: row.chunk_index,
    chunk_text: row.chunk_text,
  }));

  const secondBackfill = await backfillDocumentChunks();

  assert.ok(secondBackfill.totalDocuments >= secondBackfill.rebuiltDocuments);
  assert.ok(secondBackfill.rebuiltDocuments >= 1);

  const secondRows = getChunkRows(documentId).map((row) => ({
    page_number: row.page_number,
    chunk_index: row.chunk_index,
    chunk_text: row.chunk_text,
  }));

  assert.deepEqual(secondRows, firstRows);
  assert.ok(secondRows.length > 0);
});

test("Goal A retrieval returns top matching keyword chunks", () => {
  const uniqueTag = nextUniqueTag("retrieval");
  const documentId = insertFakeDocument({
    title: `Retrieval ${uniqueTag}`,
    originalFilename: `${uniqueTag}.pdf`,
    storedFilename: `${uniqueTag}.pdf`,
  });

  rebuildDocumentChunksFromPages(documentId, [
    {
      pageNumber: 1,
      text: `${uniqueTag} ignition coil misfire diagnostic sequence spark verification primary resistance.`,
    },
    {
      pageNumber: 2,
      text: `${uniqueTag} wheel alignment toe adjustment guidance for road drift.`,
    },
  ]);

  const results = retrieveKeywordChunks(`${uniqueTag} ignition coil resistance`);

  assert.ok(results.length > 0);
  assert.equal(results[0].documentId, documentId);
  assert.equal(results[0].pageNumber, 1);
});

test("Goal A POST /api/ask returns graceful AI not configured response when key is missing", async () => {
  const uniqueTag = nextUniqueTag("ask-no-key");
  const documentId = insertFakeDocument({
    title: `No Key ${uniqueTag}`,
    originalFilename: `${uniqueTag}.pdf`,
    storedFilename: `${uniqueTag}.pdf`,
  });

  rebuildDocumentChunksFromPages(documentId, [
    {
      pageNumber: 1,
      text: `${uniqueTag} alternator belt tension check with 10mm deflection.`,
    },
  ]);

  const response = await request(app)
    .post("/api/ask")
    .send({ question: `${uniqueTag} alternator belt tension` });

  assert.equal(response.status, 200);
  assert.equal(response.body.status, "ai_not_configured");
  assert.equal(response.body.answer, AI_NOT_CONFIGURED_MESSAGE);
  assert.deepEqual(response.body.citations, []);
});

test("Goal B POST /api/ask accepts conversation history and returns rewritten query", async () => {
  const history = [
    {
      role: "user",
      content: "What is the front brake caliper mounting bolt torque?",
    },
    {
      role: "assistant",
      content:
        "The front brake caliper mounting bolt torque is 34 N*m according to the front brake manual.",
    },
  ];
  let seenQuestion = "";
  let seenHistory = [];

  const askApp = createApp({
    askQuestion: async (question, options = {}) => {
      seenQuestion = question;
      seenHistory = options.history;

      return {
        status: "answered",
        answer: "The rear brake caliper mounting bolt torque is 34 N*m.",
        standaloneQuestion: "What is the rear brake caliper mounting bolt torque?",
        citations: [],
      };
    },
  });

  const response = await request(askApp)
    .post("/api/ask")
    .send({ question: "What about the rear ones?", history });

  assert.equal(response.status, 200);
  assert.equal(seenQuestion, "What about the rear ones?");
  assert.deepEqual(seenHistory, history);
  assert.equal(response.body.question, "What about the rear ones?");
  assert.equal(
    response.body.standaloneQuestion,
    "What is the rear brake caliper mounting bolt torque?"
  );
  assert.equal(response.body.status, "answered");
});

test("Goal B ask rewrites follow-up before rerunning retrieval", async () => {
  const history = [
    {
      role: "user",
      content: "What is the front brake caliper mounting bolt torque?",
    },
    {
      role: "assistant",
      content:
        "The front brake caliper mounting bolt torque is 34 N*m according to the front brake manual.",
    },
  ];
  const retrievalQueries = [];
  const rewrittenQuestion = "What is the rear brake caliper mounting bolt torque?";

  const result = await askQuestionUsingDocuments("What about the rear ones?", {
    history,
    isAiConfigured: true,
    rewriteQuestion: async ({ question, history: rewriteHistory }) => {
      assert.equal(question, "What about the rear ones?");
      assert.deepEqual(rewriteHistory, history);
      return rewrittenQuestion;
    },
    retrieveChunks: async (retrievalQuestion, options) => {
      retrievalQueries.push(retrievalQuestion);
      assert.equal(options.mode, "hybrid");

      return [
        {
          documentId: 77,
          documentTitle: "Rear Brake Manual",
          originalFilename: "rear-brake-manual.pdf",
          pageNumber: 7,
          chunkIndex: 2,
          chunkText:
            "Install the rear brake caliper mounting bolts. Torque: 34 N*m (350 kgf*cm, 25 ft*lbf).",
          retrievalMode: "hybrid",
          semanticScore: 0.91,
          totalQueryTerms: 8,
          chunkMatchedTerms: 7,
        },
      ];
    },
    generateAnswerText: async ({ question, originalQuestion, citations }) => {
      assert.equal(question, rewrittenQuestion);
      assert.equal(originalQuestion, "What about the rear ones?");
      assert.equal(citations[0].documentTitle, "Rear Brake Manual");

      return [
        "The rear brake caliper mounting bolt torque is",
        '"34 N*m (350 kgf*cm, 25 ft*lbf)" [Rear Brake Manual, page 7].',
      ].join(" ");
    },
  });

  assert.deepEqual(retrievalQueries, [rewrittenQuestion]);
  assert.equal(result.status, "answered");
  assert.equal(result.standaloneQuestion, rewrittenQuestion);
  assert.ok(result.answer.includes("34 N*m"));
  assert.equal(result.citations[0].pageNumber, 7);
  assert.ok(result.citations[0].snippet.includes("25 ft*lbf"));
});

test("Goal A not-found response does not call model", async () => {
  const uniqueTag = nextUniqueTag("ask-not-found");
  let modelCallCount = 0;

  const askApp = createApp({
    askQuestion: (question) =>
      askQuestionUsingDocuments(question, {
        isAiConfigured: true,
        generateAnswerText: async () => {
          modelCallCount += 1;
          return "This should not be called for not-found.";
        },
      }),
  });

  const response = await request(askApp)
    .post("/api/ask")
    .send({ question: `zzzznotfoundtoken${uniqueCounter} mysteryterm${uniqueCounter}` });

  assert.equal(response.status, 200);
  assert.equal(response.body.status, "not_found");
  assert.equal(response.body.answer, NOT_FOUND_MESSAGE);
  assert.deepEqual(response.body.citations, []);
  assert.equal(modelCallCount, 0);
});

test("Goal A citation matching returns server-built citations from retrieved chunks", async () => {
  const uniqueTag = nextUniqueTag("ask-citations");
  const documentId = insertFakeDocument({
    title: `Citation ${uniqueTag}`,
    originalFilename: `${uniqueTag}.pdf`,
    storedFilename: `${uniqueTag}.pdf`,
  });

  rebuildDocumentChunksFromPages(documentId, [
    {
      pageNumber: 3,
      text: `${uniqueTag} oil drain plug torque is 27 ft-lb and should be confirmed with a torque wrench.`,
    },
  ]);

  const askApp = createApp({
    askQuestion: (question) =>
      askQuestionUsingDocuments(question, {
        isAiConfigured: true,
        retrieveChunks: (retrievalQuestion, options) =>
          retrieveKeywordChunks(retrievalQuestion, options),
        generateAnswerText: async ({ citations }) =>
          `Use citation ${citations[0].pageNumber} for the torque value.`,
      }),
  });

  const response = await request(askApp)
    .post("/api/ask")
    .send({ question: `${uniqueTag} oil drain plug torque` });

  assert.equal(response.status, 200);
  assert.equal(response.body.status, "answered");
  assert.equal(typeof response.body.answer, "string");
  assert.ok(response.body.answer.includes("torque"));
  assert.ok(Array.isArray(response.body.citations));
  assert.ok(response.body.citations.length >= 1);
  assert.equal(response.body.citations[0].documentId, documentId);
  assert.equal(response.body.citations[0].pageNumber, 3);
  assert.ok(response.body.citations[0].snippet.includes("27 ft-lb"));
});

test("Goal A fake PDF eval set returns expected citation pages and honest not-found", async () => {
  const uniqueTag = nextUniqueTag("eval-set");
  const storedFilename = `${uniqueTag}.pdf`;
  const absoluteFilePath = path.join(process.env.UPLOADS_DIR, storedFilename);

  fs.writeFileSync(
    absoluteFilePath,
    createFakePdfBuffer([
      `${uniqueTag} engine oil capacity is 4.4 quarts with filter replacement.`,
      `${uniqueTag} spark plug gap specification is 0.044 inches for the 1.8L engine.`,
      `${uniqueTag} transmission fluid type is Toyota ATF WS only.`,
      `${uniqueTag} tire pressure should be 32 psi front and rear when cold.`,
      `${uniqueTag} battery charging voltage range is 13.8 to 14.5 volts at idle.`,
    ])
  );

  const documentId = insertFakeDocument({
    title: `Eval ${uniqueTag}`,
    originalFilename: `${uniqueTag}.pdf`,
    storedFilename,
  });

  await rebuildDocumentChunksFromStoredPdf(documentId);

  let modelCallCount = 0;

  const evalCases = [
    {
      question: `${uniqueTag} what is engine oil capacity`,
      expectedPage: 1,
    },
    {
      question: `${uniqueTag} what is the spark plug gap`,
      expectedPage: 2,
    },
    {
      question: `${uniqueTag} which transmission fluid type is required`,
      expectedPage: 3,
    },
    {
      question: `${uniqueTag} recommended tire pressure`,
      expectedPage: 4,
    },
    {
      question: `zzzznotinthepdf${uniqueCounter} coolantbleedpattern${uniqueCounter}`,
      expectedPage: null,
    },
  ];

  for (const evalCase of evalCases) {
    const result = await askQuestionUsingDocuments(evalCase.question, {
      isAiConfigured: true,
      retrieveChunks: (retrievalQuestion, options) =>
        retrieveKeywordChunks(retrievalQuestion, options),
      generateAnswerText: async ({ citations }) => {
        modelCallCount += 1;
        return `Answer based on page ${citations[0].pageNumber}.`;
      },
    });

    if (evalCase.expectedPage === null) {
      assert.equal(result.status, "not_found");
      assert.equal(result.answer, NOT_FOUND_MESSAGE);
      assert.deepEqual(result.citations, []);
      continue;
    }

    assert.equal(result.status, "answered");
    assert.ok(result.citations.length > 0);
    assert.equal(result.citations[0].documentId, documentId);
    assert.equal(result.citations[0].pageNumber, evalCase.expectedPage);
  }

  assert.equal(modelCallCount, 4);
});

test("search API keeps legacy document search compatible with /api/search/documents", async () => {
  const vehicle = db.prepare("SELECT id FROM vehicles ORDER BY id ASC LIMIT 1").get();

  assert.ok(vehicle);

  db.prepare(`
    INSERT INTO documents (
      vehicle_id,
      title,
      original_filename,
      stored_filename,
      file_path,
      file_type,
      system,
      document_type,
      notes,
      extracted_text,
      is_favorite
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    vehicle.id,
    "Thermostat replacement bulletin",
    "thermostat-bulletin.pdf",
    "thermostat-bulletin-copy.pdf",
    "C:/temp/thermostat-bulletin.pdf",
    "application/pdf",
    "Cooling",
    "Bulletin",
    "Use this bulletin when the thermostat housing starts seeping.",
    "Thermostat torque specs and coolant refill notes.",
    1
  );

  const [legacyResponse, documentsResponse] = await Promise.all([
    request(app).get("/api/search").query({ q: "thermostat", system: "Cooling" }),
    request(app).get("/api/search/documents").query({ q: "thermostat", system: "Cooling" }),
  ]);

  assert.equal(legacyResponse.status, 200);
  assert.equal(documentsResponse.status, 200);
  assert.deepEqual(legacyResponse.body, documentsResponse.body);
  assert.ok(legacyResponse.body.results.length >= 1);
  assert.equal(legacyResponse.body.results[0].title, "Thermostat replacement bulletin");
  assert.equal(legacyResponse.body.results[0].system, "Cooling");
  assert.equal(legacyResponse.body.results[0].documentType, "Bulletin");
  assert.match(legacyResponse.body.results[0].snippet, /thermostat/i);
  assert.ok(Array.isArray(legacyResponse.body.filters.systems));
  assert.ok(legacyResponse.body.filters.systems.includes("Cooling"));
  assert.ok(Array.isArray(legacyResponse.body.filters.documentTypes));
  assert.ok(legacyResponse.body.filters.documentTypes.includes("Bulletin"));
});

test("GET /api/search/symptoms returns matching symptoms with filters and snippets", async () => {
  const vehicle = db.prepare("SELECT id FROM vehicles ORDER BY id ASC LIMIT 1").get();

  assert.ok(vehicle);

  const documentId = Number(
    db.prepare(`
      INSERT INTO documents (
        vehicle_id,
        title,
        original_filename,
        stored_filename,
        file_path,
        file_type,
        system,
        document_type
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      vehicle.id,
      "Idle airflow diagram",
      "idle-airflow-diagram.pdf",
      "idle-airflow-diagram-copy.pdf",
      "C:/temp/idle-airflow-diagram.pdf",
      "application/pdf",
      "Engine",
      "Diagram"
    ).lastInsertRowid
  );

  const symptomId = Number(
    db.prepare(`
      INSERT INTO symptoms (
        vehicle_id,
        title,
        description,
        system,
        suspected_causes,
        confidence,
        status,
        notes
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      vehicle.id,
      "Idle surge after warm start",
      "The idle climbs and drops for a few seconds after a warm restart.",
      "Engine",
      "Dirty throttle body or vacuum leak",
      "high",
      "monitoring",
      "Check the throttle plate before replacing parts."
    ).lastInsertRowid
  );

  db.prepare(`
    INSERT INTO symptom_documents (symptom_id, document_id)
    VALUES (?, ?)
  `).run(symptomId, documentId);

  db.prepare(`
    INSERT INTO symptoms (
      vehicle_id,
      title,
      description,
      system,
      status
    )
    VALUES (?, ?, ?, ?, ?)
  `).run(
    vehicle.id,
    "Rear brake squeak",
    "Short squeak during light braking.",
    "Brakes",
    "open"
  );

  const response = await request(app)
    .get("/api/search/symptoms")
    .query({ q: "throttle", system: "Engine", status: "monitoring" });

  assert.equal(response.status, 200);
  assert.equal(response.body.total, 1);
  assert.equal(response.body.results[0].title, "Idle surge after warm start");
  assert.equal(response.body.results[0].system, "Engine");
  assert.equal(response.body.results[0].status, "monitoring");
  assert.equal(response.body.results[0].confidence, "high");
  assert.match(response.body.results[0].snippet, /throttle/i);
  assert.equal(response.body.results[0].snippetField, "Suspected causes");
  assert.equal(response.body.results[0].linkedDocumentCount, 1);
  assert.equal(response.body.results[0].linkedDocuments.length, 1);
  assert.equal(response.body.results[0].linkedDocuments[0].title, "Idle airflow diagram");
  assert.ok(response.body.filters.systems.includes("Engine"));
  assert.ok(response.body.filters.systems.includes("Brakes"));
  assert.ok(response.body.filters.statuses.includes("monitoring"));
  assert.ok(response.body.filters.statuses.includes("open"));
});

test("GET /api/search/procedures returns matching procedures with filters and snippets", async () => {
  const vehicle = db.prepare("SELECT id FROM vehicles ORDER BY id ASC LIMIT 1").get();

  assert.ok(vehicle);

  const documentId = Number(
    db.prepare(`
      INSERT INTO documents (
        vehicle_id,
        title,
        original_filename,
        stored_filename,
        file_path,
        file_type,
        system,
        document_type
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      vehicle.id,
      "Throttle cleaning checklist",
      "throttle-cleaning-checklist.pdf",
      "throttle-cleaning-checklist-copy.pdf",
      "C:/temp/throttle-cleaning-checklist.pdf",
      "application/pdf",
      "Engine",
      "Checklist"
    ).lastInsertRowid
  );

  const procedureId = Number(
    db.prepare(`
      INSERT INTO procedures (
        vehicle_id,
        title,
        system,
        difficulty,
        tools_needed,
        parts_needed,
        safety_notes,
        steps,
        notes,
        confidence
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      vehicle.id,
      "Clean the throttle body",
      "Engine",
      "beginner",
      "Socket set and shop towels",
      "Throttle body cleaner",
      "Keep hands clear of the throttle plate edge.",
      "Remove the intake tube, spray cleaner, and wipe the throttle body.",
      "Use light pressure so the coating is not damaged.",
      "medium"
    ).lastInsertRowid
  );

  db.prepare(`
    INSERT INTO procedure_documents (procedure_id, document_id)
    VALUES (?, ?)
  `).run(procedureId, documentId);

  db.prepare(`
    INSERT INTO procedures (
      vehicle_id,
      title,
      system,
      difficulty,
      steps
    )
    VALUES (?, ?, ?, ?, ?)
  `).run(
    vehicle.id,
    "Replace cabin air filter",
    "HVAC",
    "beginner",
    "Open the glove box and swap the filter."
  );

  const response = await request(app)
    .get("/api/search/procedures")
    .query({ q: "cleaner", system: "Engine", difficulty: "beginner" });

  assert.equal(response.status, 200);
  assert.equal(response.body.total, 1);
  assert.equal(response.body.results[0].title, "Clean the throttle body");
  assert.equal(response.body.results[0].system, "Engine");
  assert.equal(response.body.results[0].difficulty, "beginner");
  assert.match(response.body.results[0].snippet, /cleaner/i);
  assert.equal(response.body.results[0].snippetField, "Parts needed");
  assert.equal(response.body.results[0].linkedDocumentCount, 1);
  assert.equal(response.body.results[0].linkedDocuments.length, 1);
  assert.equal(
    response.body.results[0].linkedDocuments[0].title,
    "Throttle cleaning checklist"
  );
  assert.ok(response.body.filters.systems.includes("Engine"));
  assert.ok(response.body.filters.systems.includes("HVAC"));
  assert.ok(response.body.filters.difficulties.includes("beginner"));
});

test("GET /api/search/notes returns matching notes with filters and linked entity details", async () => {
  const vehicle = db.prepare("SELECT id FROM vehicles ORDER BY id ASC LIMIT 1").get();

  assert.ok(vehicle);

  const procedureId = Number(
    db.prepare(`
      INSERT INTO procedures (vehicle_id, title, system, difficulty)
      VALUES (?, ?, ?, ?)
    `).run(vehicle.id, "Torque wheel lug nuts", "Wheels", "beginner").lastInsertRowid
  );

  const documentId = Number(
    db.prepare(`
      INSERT INTO documents (
        vehicle_id,
        title,
        original_filename,
        stored_filename,
        file_path,
        file_type,
        system,
        document_type
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      vehicle.id,
      "Wheel torque spec sheet",
      "wheel-torque-specs.pdf",
      "wheel-torque-specs-copy.pdf",
      "C:/temp/wheel-torque-specs.pdf",
      "application/pdf",
      "Wheels",
      "Specification"
    ).lastInsertRowid
  );

  const createdProcedureNote = await request(app)
    .post("/api/notes")
    .send({
      title: "Wheel torque reminder",
      content: "Torque the lug nuts again after 50 miles.",
      noteType: "reminder",
      relatedEntityType: "procedure",
      relatedEntityId: procedureId,
    });

  assert.equal(createdProcedureNote.status, 201);

  const createdDocumentNote = await request(app)
    .post("/api/notes")
    .send({
      title: "Wheel spec reference",
      content: "The PDF has the factory torque numbers.",
      noteType: "general",
      relatedEntityType: "document",
      relatedEntityId: documentId,
    });

  assert.equal(createdDocumentNote.status, 201);

  const response = await request(app)
    .get("/api/search/notes")
    .query({ q: "torque", noteType: "reminder", relatedEntityType: "procedure" });

  assert.equal(response.status, 200);
  assert.equal(response.body.total, 1);
  assert.equal(response.body.results[0].title, "Wheel torque reminder");
  assert.equal(response.body.results[0].noteType, "reminder");
  assert.equal(response.body.results[0].relatedEntityType, "procedure");
  assert.equal(response.body.results[0].linkedTitle, "Torque wheel lug nuts");
  assert.equal(response.body.results[0].linkedProcedure.title, "Torque wheel lug nuts");
  assert.equal(response.body.results[0].linkedDocument, null);
  assert.match(response.body.results[0].snippet, /torque/i);
  assert.equal(response.body.results[0].snippetField, "Content");
  assert.ok(response.body.filters.noteTypes.includes("reminder"));
  assert.ok(response.body.filters.noteTypes.includes("general"));
  assert.ok(response.body.filters.relatedEntityTypes.includes("procedure"));
  assert.ok(response.body.filters.relatedEntityTypes.includes("document"));
});


test("DELETE /api/documents/:id removes document file and clears links safely", async () => {
  const vehicle = db.prepare("SELECT id FROM vehicles ORDER BY id ASC LIMIT 1").get();
  assert.ok(vehicle);

  const insertDocument = db.prepare(`
    INSERT INTO documents (
      vehicle_id,
      title,
      original_filename,
      stored_filename,
      file_path,
      file_type,
      system,
      document_type,
      extraction_status,
      is_favorite
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const storedFilename = "delete-me.pdf";
  const filePath = path.join(process.env.UPLOADS_DIR, storedFilename);
  fs.writeFileSync(filePath, "%PDF-1.4 test");

  const documentId = Number(
    insertDocument.run(
      vehicle.id,
      "Delete Me",
      storedFilename,
      storedFilename,
      `server/uploads/${storedFilename}`,
      "application/pdf",
      "Engine",
      "Reference",
      "completed",
      0
    ).lastInsertRowid
  );

  const symptomId = Number(
    db.prepare(`INSERT INTO symptoms (vehicle_id, title, status) VALUES (?, ?, ?)`)
      .run(vehicle.id, "Linked symptom", "open").lastInsertRowid
  );
  db.prepare("INSERT INTO symptom_documents (symptom_id, document_id) VALUES (?, ?)").run(symptomId, documentId);

  const procedureId = Number(
    db.prepare(`INSERT INTO procedures (vehicle_id, title, status) VALUES (?, ?, ?)`)
      .run(vehicle.id, "Linked procedure", "draft").lastInsertRowid
  );
  db.prepare("INSERT INTO procedure_documents (procedure_id, document_id) VALUES (?, ?)").run(procedureId, documentId);

  db.prepare(`
    INSERT INTO notes (vehicle_id, title, content, related_entity_type, related_entity_id, document_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(vehicle.id, "Linked note", "Keep this for now.", "document", documentId, documentId);

  const response = await request(app).delete(`/api/documents/${documentId}`);

  assert.equal(response.status, 200);
  assert.equal(response.body.cleanup.symptomLinksRemoved, 1);
  assert.equal(response.body.cleanup.procedureLinksRemoved, 1);
  assert.equal(response.body.cleanup.noteLinksCleared, 1);

  const deletedDocument = db.prepare("SELECT id FROM documents WHERE id = ?").get(documentId);
  assert.equal(deletedDocument, undefined);

  const noteAfterDelete = db.prepare("SELECT related_entity_type, related_entity_id, document_id FROM notes WHERE title = ?").get("Linked note");
  assert.equal(noteAfterDelete.related_entity_type, "none");
  assert.equal(noteAfterDelete.related_entity_id, null);
  assert.equal(noteAfterDelete.document_id, null);

  assert.equal(fs.existsSync(filePath), false);
});
