import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { after } from "node:test";

// The read-only applicability report (N5 P1) over a scratch database of
// SYNTHETIC documents. The report is handed a { readOnly: true } connection, so
// any write it attempted would throw here.

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-applicability-report-"));
const databaseFile = path.join(tempRoot, "test.db");

process.env.DATABASE_FILE = databaseFile;
process.env.UPLOADS_DIR = path.join(tempRoot, "uploads");

const { db } = await import("../src/database.js");
const { initializeDatabase } = await import("../src/initDatabase.js");
const { buildApplicabilityReport, buildCsvReport, parseArguments, runCli } = await import(
  "../src/scripts/diagnoseApplicability.js"
);

initializeDatabase();

const vehicleId = db.prepare("SELECT id FROM vehicles ORDER BY id LIMIT 1").get().id;
const insertDocument = db.prepare(`
  INSERT INTO documents (vehicle_id, title, original_filename, system, document_type)
  VALUES (?, ?, ?, 'Imported Documents', 'Repair Manual')
`);
const insertChunk = db.prepare(`
  INSERT INTO document_chunks (document_id, page_number, chunk_index, chunk_text)
  VALUES (?, ?, ?, ?)
`);

function addDocument(filename, pages) {
  const documentId = Number(insertDocument.run(vehicleId, filename, filename).lastInsertRowid);
  pages.forEach((text, index) => {
    if (text !== null) {
      insertChunk.run(documentId, index + 1, 0, text);
    }
  });
  return documentId;
}

const mixedId = addDocument("ac-torque.pdf", [
  "ALLDATA DIY article export 2009 Toyota Corolla L4-1.8L (2ZR-FE) Vehicle > Heating > A/C Torque Specifications HINT: COMPRESSOR (for 2AZ-FE) Compressor x Engine 25 N*m COMPRESSOR (for 2ZR-FE) Compressor x Engine 25 N*m",
]);
const otherId = addDocument("position-of-parts-2az.pdf", [
  "Vehicle > Locations > Position Of Parts (2AZ-FE) Locations: relay box and fuse block",
  "Bracket bolt torque 18 N*m for the relay box bracket, tighten in two passes and check the clearance afterwards",
]);
addDocument("brake-pads.pdf", ["Brake pad minimum thickness 1.0 mm"]);
const emptyId = addDocument("scan-no-text.pdf", [null]);

after(() => {
  if (typeof db.close === "function") {
    db.close();
  }
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function readOnlyReport(options) {
  const readOnly = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return buildApplicabilityReport(readOnly, options);
  } finally {
    readOnly.close();
  }
}

test("--engine is normalized like the Settings field", () => {
  assert.equal(parseArguments(["--engine", "2zr-fe"]).engine, "2ZR-FE");
  assert.equal(parseArguments(["--output-dir", "x", "--limit", "5"]).limit, 5);
  assert.equal(parseArguments([]).engine, undefined);
});

test("with no engine code saved and no --engine, the CLI refuses and writes nothing (Review Focus 3)", async () => {
  const outputDir = path.join(tempRoot, "refused");
  const previousExitCode = process.exitCode;

  await runCli(["--output-dir", outputDir]);

  try {
    assert.equal(process.exitCode, 1);
    assert.ok(!fs.existsSync(outputDir), "no report may be written when the engine is unknown");
  } finally {
    process.exitCode = previousExitCode;
  }
});

test("documents are classified by content markers, never by the account header", () => {
  const report = readOnlyReport({ ownerEngine: "2ZR-FE" });

  assert.deepEqual(report.documentClasses, { none: 2, owner_only: 0, mixed: 1, other_only: 1 });
  assert.equal(report.accountHeader.documents, 1);
  assert.equal(report.accountHeader.headerOnlyDocuments, 0, "the A/C table names 2ZR-FE in its own rows");
  assert.equal(report.pagesWithBothInlineBlocks, 1);
  assert.equal(report.specChunks.mixed, 1);
  assert.deepEqual(report.totals, { documents: 4, pages: 4, chunks: 4 });
});

test("a page that names no engine inherits its article's engine", () => {
  const report = readOnlyReport({ ownerEngine: "2ZR-FE" });

  assert.ok(report.entryScope.inheritingOther >= 1, JSON.stringify(report.entryScope));
  const other = report.documents.find((document) => document.id === otherId);
  assert.equal(other.documentClass, "other_only");
  assert.equal(other.pagesOther, 1);
});

test("a document with zero chunks is listed as unscoped and does not throw (Review Focus 5)", () => {
  const report = readOnlyReport({ ownerEngine: "2ZR-FE" });
  const empty = report.documents.find((document) => document.id === emptyId);

  assert.equal(empty.documentClass, "none");
  assert.equal(empty.chunks, 0);
  assert.equal(empty.pages, 0);
});

test("the CSV has a header and one row per document", () => {
  const report = readOnlyReport({ ownerEngine: "2ZR-FE" });
  const lines = buildCsvReport(report.documents).split("\n");

  assert.equal(lines.length, 5);
  assert.match(lines[0], /^id,filename,pages,chunks,documentClass,headerOnly,pagesOwner,pagesOther,pagesMixed,unresolvedPages$/);
  assert.ok(lines.some((line) => line.startsWith(`${mixedId},ac-torque.pdf,`)));
});

test("--limit reports only the first documents", () => {
  assert.equal(readOnlyReport({ ownerEngine: "2ZR-FE", limit: 2 }).documents.length, 2);
});

test("with --engine the CLI writes JSON and CSV to the output folder", async () => {
  const outputDir = path.join(tempRoot, "written");
  const previousExitCode = process.exitCode;

  await runCli(["--engine", "2ZR-FE", "--output-dir", outputDir]);

  try {
    assert.notEqual(process.exitCode, 1);
    assert.ok(fs.existsSync(path.join(outputDir, "applicability-report.json")));
    assert.ok(fs.existsSync(path.join(outputDir, "applicability-report.csv")));
  } finally {
    process.exitCode = previousExitCode;
  }
});
