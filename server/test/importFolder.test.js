import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-import-test-"));

process.env.DATABASE_FILE = path.join(tempRoot, "test.db");
process.env.UPLOADS_DIR = path.join(tempRoot, "uploads");
process.env.OPENAI_API_KEY = "";

const { initializeDatabase } = await import("../src/initDatabase.js");
const { db } = await import("../src/database.js");
const { importPdfFolder } = await import("../src/scripts/importFolder.js");

initializeDatabase();

after(() => {
  if (typeof db.close === "function") {
    db.close();
  }

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("database init adds file_md5 before creating the import hash index on legacy databases", () => {
  const legacyDbPath = path.join(tempRoot, "legacy-no-md5.db");
  const legacyUploadsDir = path.join(tempRoot, "legacy-uploads");
  const legacyDb = new DatabaseSync(legacyDbPath);

  legacyDb.exec(`
    CREATE TABLE documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vehicle_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      original_filename TEXT NOT NULL,
      stored_filename TEXT,
      file_path TEXT,
      file_type TEXT,
      system TEXT NOT NULL,
      subsystem TEXT,
      document_type TEXT NOT NULL,
      source TEXT,
      notes TEXT,
      extracted_text TEXT,
      extraction_status TEXT NOT NULL DEFAULT 'not_attempted',
      page_count INTEGER,
      is_favorite INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  legacyDb.close();

  const script = `
    process.env.DATABASE_FILE = ${JSON.stringify(legacyDbPath)};
    process.env.UPLOADS_DIR = ${JSON.stringify(legacyUploadsDir)};
    const { initializeDatabase } = await import("./server/src/initDatabase.js");
    const { db } = await import("./server/src/database.js");
    initializeDatabase();
    const hasFileMd5 = db
      .prepare("PRAGMA table_info(documents)")
      .all()
      .some((column) => column.name === "file_md5");
    const hashIndex = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_documents_file_md5'")
      .get();
    db.close();
    if (!hasFileMd5) throw new Error("file_md5 column missing");
    if (!hashIndex) throw new Error("file_md5 index missing");
  `;

  assert.doesNotThrow(() => {
    execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: path.resolve(__dirname, "..", ".."),
      stdio: "pipe",
    });
  });
});

function createMinimalPdfBuffer({ pageText = "" } = {}) {
  const escapedText = pageText
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
  const textCommand = escapedText
    ? `BT\n/F1 12 Tf\n72 720 Td\n(${escapedText}) Tj\nET`
    : "";
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Count 1 /Kids [3 0 R] >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n",
    `4 0 obj\n<< /Length ${Buffer.byteLength(textCommand, "utf8")} >>\nstream\n${textCommand}\nendstream\nendobj\n`,
    "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
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
  chunks.push("xref\n0 6\n");
  chunks.push("0000000000 65535 f \n");

  for (let objectId = 1; objectId <= objects.length; objectId += 1) {
    chunks.push(`${String(offsets[objectId]).padStart(10, "0")} 00000 n \n`);
  }

  chunks.push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

  return Buffer.from(chunks.join(""), "utf8");
}

function makeImportSource() {
  const sourceDir = fs.mkdtempSync(path.join(tempRoot, "source-pdfs-"));
  const nestedDir = path.join(sourceDir, "nested");
  fs.mkdirSync(nestedDir, { recursive: true });
  const textPdfBuffer = createMinimalPdfBuffer({
    pageText:
      "Toyota Corolla coolant sensor diagnostic procedure with connector inspection and resistance testing steps.",
  });

  fs.writeFileSync(path.join(sourceDir, "Valid Test.pdf"), textPdfBuffer);
  fs.writeFileSync(path.join(sourceDir, "Z Duplicate Bytes.pdf"), textPdfBuffer);
  fs.writeFileSync(
    path.join(nestedDir, "Image Only.pdf"),
    createMinimalPdfBuffer()
  );
  fs.writeFileSync(
    path.join(sourceDir, "Bad File.pdf"),
    "this is not a readable pdf"
  );

  return sourceDir;
}

test("bulk importer imports readable PDFs, skips byte duplicates, tolerates bad files, and counts image-only PDFs", async () => {
  const sourceDir = makeImportSource();

  const firstReport = await importPdfFolder(sourceDir, {
    system: "Reference",
    documentType: "Repair Manual",
    source: "Bulk Import Test",
  });

  assert.equal(firstReport.totalPdfFiles, 4);
  assert.equal(firstReport.imported, 2);
  assert.equal(firstReport.skipped, 1);
  assert.equal(firstReport.failed, 1);
  assert.equal(firstReport.imageOnly, 1);
  assert.equal(firstReport.results.imported.length, 2);
  assert.equal(firstReport.results.skipped[0].reason, "duplicate_md5");
  assert.equal(firstReport.results.failed[0].reason, "extraction_failed");

  const importedRows = db
    .prepare(`
      SELECT id, original_filename, stored_filename, file_path, file_md5, extraction_status
      FROM documents
      WHERE source = ?
      ORDER BY original_filename ASC
    `)
    .all("Bulk Import Test");

  assert.equal(importedRows.length, 2);
  assert.ok(importedRows.every((row) => row.file_md5));
  assert.ok(importedRows.every((row) => String(row.file_path).startsWith("server/uploads/")));
  assert.ok(importedRows.every((row) =>
    fs.existsSync(path.join(process.env.UPLOADS_DIR, String(row.stored_filename)))
  ));

  const validPdf = importedRows.find((row) => String(row.original_filename) === "Valid Test.pdf");
  assert.ok(validPdf);
  assert.match(String(validPdf.stored_filename), /^Valid-Test-[a-f0-9]{8}\.pdf$/);

  const imageOnlyPdf = importedRows.find((row) => String(row.original_filename) === "Image Only.pdf");
  assert.ok(imageOnlyPdf);
  assert.equal(imageOnlyPdf.extraction_status, "no_text_found");

  const chunkCount = db
    .prepare("SELECT COUNT(*) AS total FROM document_chunks WHERE document_id = ?")
    .get(validPdf.id).total;
  assert.ok(Number(chunkCount) > 0);

  const secondReport = await importPdfFolder(sourceDir, {
    system: "Reference",
    documentType: "Repair Manual",
    source: "Bulk Import Test",
  });

  assert.equal(secondReport.imported, 0);
  assert.equal(secondReport.skipped, 3);
  assert.equal(secondReport.failed, 1);
  assert.equal(secondReport.imageOnly, 1);

  const rowsAfterSecondRun = db
    .prepare("SELECT COUNT(*) AS total FROM documents WHERE source = ?")
    .get("Bulk Import Test").total;
  assert.equal(rowsAfterSecondRun, 2);
});
