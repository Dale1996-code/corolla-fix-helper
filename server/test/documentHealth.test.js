import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { after } from "node:test";

// N8 slice 1: the read-only document-health report, over two INVENTED
// libraries built in a temp folder. One is healthy and must report nothing; the
// other has one document per kind of damage. The report only ever gets a
// { readOnly: true } connection, so any write it attempted would throw here.

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-document-health-"));
const templateFile = path.join(tempRoot, "template.db");

process.env.DATABASE_FILE = templateFile;
process.env.UPLOADS_DIR = path.join(tempRoot, "unused-uploads");

const { db } = await import("../src/database.js");
const { initializeDatabase } = await import("../src/initDatabase.js");
const {
  DOCUMENT_HEALTH_PROBLEMS,
  classifyDocumentHealth,
  resolveStoredPdfName,
} = await import("../src/services/documentHealth.js");
const { buildDocumentHealthReport, buildCsvReport, formatConsoleReport, parseArguments, runCli } =
  await import("../src/scripts/diagnoseDocumentHealth.js");

const CURRENT = "text-embedding-3-small@512";
const OLD = "text-embedding-3-small@1536";

initializeDatabase();
const vehicleId = db.prepare("SELECT id FROM vehicles ORDER BY id LIMIT 1").get().id;

/**
 * Copy the empty, fully migrated schema into a new library file (VACUUM INTO,
 * the same way the owner's real database is snapshotted), then fill it.
 */
function makeLibrary(name, documents) {
  const databaseFile = path.join(tempRoot, `${name}.db`);
  const uploadsDir = path.join(tempRoot, `${name}-uploads`);
  fs.mkdirSync(uploadsDir, { recursive: true });
  db.exec(`VACUUM INTO '${databaseFile.replace(/'/g, "''")}'`);

  const writable = new DatabaseSync(databaseFile);
  const insertDocument = writable.prepare(`
    INSERT INTO documents
      (vehicle_id, title, original_filename, stored_filename, file_path, system, document_type, extraction_status)
    VALUES (?, ?, ?, ?, ?, 'Imported Documents', 'Repair Manual', ?)
  `);
  const insertChunk = writable.prepare(`
    INSERT INTO document_chunks (document_id, page_number, chunk_index, chunk_text, embedding_version)
    VALUES (?, ?, 0, ?, ?)
  `);
  const ids = {};

  for (const document of documents) {
    const storedFilename = document.storedFilename === undefined
      ? `${document.key}.pdf`
      : document.storedFilename;
    const id = Number(
      insertDocument.run(
        vehicleId,
        document.title || document.key,
        `${document.key}.pdf`,
        storedFilename,
        document.filePath ?? null,
        document.status || "completed"
      ).lastInsertRowid
    );
    ids[document.key] = id;

    if (document.writeFile !== false && storedFilename) {
      fs.writeFileSync(path.join(uploadsDir, path.basename(storedFilename)), "%PDF-1.4 invented");
    }

    (document.chunks || []).forEach((version, index) => {
      insertChunk.run(id, index + 1, `Invented chunk ${index + 1} for ${document.key}`, version);
    });
  }

  writable.close();
  return { databaseFile, uploadsDir, ids };
}

function readOnlyReport(library, options = {}) {
  const readOnly = new DatabaseSync(library.databaseFile, { readOnly: true });
  try {
    return buildDocumentHealthReport(readOnly, {
      uploadsDir: library.uploadsDir,
      embeddingVersion: CURRENT,
      ...options,
    });
  } finally {
    readOnly.close();
  }
}

const healthy = makeLibrary("healthy", [
  { key: "brake-pads", chunks: [CURRENT, CURRENT] },
  { key: "oil-change", chunks: [CURRENT] },
  { key: "with-warning", status: "completed_with_warning: one page was blank", chunks: [CURRENT] },
]);

const damaged = makeLibrary("damaged", [
  { key: "fine", chunks: [CURRENT] },
  { key: "file-gone", writeFile: false, chunks: [CURRENT] },
  { key: "no-filename", storedFilename: null, chunks: [CURRENT] },
  { key: "never-chunked", chunks: [] },
  { key: "parse-failed", status: "failed: Invalid PDF structure", chunks: [] },
  { key: "scanned", status: "completed_with_ocr", chunks: [CURRENT] },
  { key: "scanned-warn", status: "completed_with_ocr_warning: ocr_failed: page 3", chunks: [CURRENT] },
  { key: "ocr-missing", status: "ocr_unavailable: OCR needs Tesseract and Poppler (pdftoppm).", chunks: [] },
  { key: "ocr-partial", status: "completed_with_warning: ocr_failed: page 2 unreadable", chunks: [CURRENT] },
  { key: "old-embedding", chunks: [CURRENT, OLD, null] },
  { key: "=formula-title", title: "=HYPERLINK(\"x\")", chunks: [CURRENT] },
]);

after(() => {
  if (typeof db.close === "function") {
    db.close();
  }
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function problemCodes(report, key, library = damaged) {
  const entry = report.documents.find((row) => row.documentId === library.ids[key]);
  return entry ? entry.problems.map((problem) => problem.code) : [];
}

test("a healthy library reports no problems at all", () => {
  const report = readOnlyReport(healthy);

  assert.equal(report.totalDocuments, 3);
  assert.equal(report.totalChunks, 4);
  assert.equal(report.documentsNeedingAttention, 0);
  assert.equal(report.healthyDocuments, 3);
  assert.deepEqual(report.documents, []);
  for (const entry of report.summary) {
    assert.equal(entry.count, 0, `${entry.code} should be 0 on a healthy library`);
  }
});

test("each kind of damage is flagged on exactly the document that has it", () => {
  const report = readOnlyReport(damaged);

  assert.deepEqual(problemCodes(report, "fine"), []);
  assert.deepEqual(problemCodes(report, "file-gone"), ["missing-file"]);
  assert.deepEqual(problemCodes(report, "no-filename"), ["missing-file"]);
  assert.deepEqual(problemCodes(report, "never-chunked"), ["zero-chunks"]);
  assert.deepEqual(problemCodes(report, "parse-failed"), ["extraction-failed", "zero-chunks"]);
  assert.deepEqual(problemCodes(report, "scanned"), ["ocr-used"]);
  assert.deepEqual(problemCodes(report, "scanned-warn"), ["ocr-gap", "ocr-used"]);
  assert.deepEqual(problemCodes(report, "ocr-missing"), ["zero-chunks", "ocr-gap"]);
  assert.deepEqual(problemCodes(report, "ocr-partial"), ["ocr-gap"]);
  assert.deepEqual(problemCodes(report, "old-embedding"), ["embedding-pending"]);
});

test("the summary counts documents per problem, and the totals add up", () => {
  const report = readOnlyReport(damaged);
  const counts = Object.fromEntries(report.summary.map((entry) => [entry.code, entry.count]));

  assert.deepEqual(counts, {
    "missing-file": 2,
    "extraction-failed": 1,
    "zero-chunks": 3,
    "ocr-gap": 3,
    "embedding-pending": 1,
    "ocr-used": 2,
  });
  assert.equal(report.totalDocuments, 11);
  assert.equal(report.documentsNeedingAttention, 9);
  assert.equal(report.healthyDocuments, 2);
  assert.deepEqual(
    report.summary.map((entry) => entry.code),
    DOCUMENT_HEALTH_PROBLEMS.map((problem) => problem.code),
    "every problem is listed, even at zero, in one fixed order"
  );
});

test("embedding-pending counts the chunks behind it, including never-embedded ones", () => {
  const report = readOnlyReport(damaged);
  const entry = report.documents.find((row) => row.documentId === damaged.ids["old-embedding"]);

  assert.equal(entry.chunkCount, 3);
  assert.equal(entry.pendingEmbeddingChunks, 2);
  assert.equal(report.pendingEmbeddingChunks, 2);
});

test("the embedding version decides what is pending, not a hard-coded value", () => {
  const report = readOnlyReport(healthy, { embeddingVersion: OLD });
  const pending = report.summary.find((entry) => entry.code === "embedding-pending");

  assert.equal(pending.count, 3);
  assert.equal(report.embeddingVersion, OLD);
});

test("the file check is read-only and never reaches outside the uploads folder", () => {
  assert.equal(resolveStoredPdfName({ stored_filename: "../../secret.pdf" }), "secret.pdf");
  assert.equal(resolveStoredPdfName({ stored_filename: null, file_path: "C:/x/y/z.pdf" }), "z.pdf");
  assert.equal(resolveStoredPdfName({ stored_filename: "", file_path: "" }), "");

  // A file named in the row but sitting one folder up is still "missing".
  fs.writeFileSync(path.join(tempRoot, "outside.pdf"), "%PDF-1.4");
  const library = makeLibrary("traversal", [
    { key: "escape", storedFilename: "../outside.pdf", writeFile: false, chunks: [CURRENT] },
  ]);
  const report = readOnlyReport(library);
  assert.deepEqual(problemCodes(report, "escape", library), ["missing-file"]);
});

test("a folder with the PDF's name is not a stored PDF", () => {
  const library = makeLibrary("folder-not-file", [
    { key: "dir", writeFile: false, chunks: [CURRENT] },
  ]);
  fs.mkdirSync(path.join(library.uploadsDir, "dir.pdf"));
  assert.deepEqual(problemCodes(readOnlyReport(library), "dir", library), ["missing-file"]);
});

test("classifyDocumentHealth is a pure rule table over gathered evidence", () => {
  assert.deepEqual(
    classifyDocumentHealth({ fileFound: true, extractionStatus: "completed", chunkCount: 2, pendingEmbeddingChunks: 0 }),
    []
  );
  // not_attempted and no_text_found are not proof of anything on their own (see
  // zeroChunkDiagnostics.js); the missing chunks are what the owner can act on.
  assert.deepEqual(
    classifyDocumentHealth({ fileFound: true, extractionStatus: "no_text_found", chunkCount: 0, pendingEmbeddingChunks: 0 })
      .map((problem) => problem.code),
    ["zero-chunks"]
  );
});

test("building the report changes neither the database file nor the uploads folder", () => {
  const before = {
    database: fs.readFileSync(damaged.databaseFile),
    uploads: fs.readdirSync(damaged.uploadsDir).sort(),
  };

  readOnlyReport(damaged);

  assert.ok(before.database.equals(fs.readFileSync(damaged.databaseFile)), "database bytes changed");
  assert.deepEqual(fs.readdirSync(damaged.uploadsDir).sort(), before.uploads);
});

test("the CSV has one row per flagged document and neutralizes spreadsheet formulas", () => {
  const report = readOnlyReport(damaged);
  const lines = buildCsvReport(report.documents).split("\n");

  assert.equal(lines.length, report.documents.length + 1);
  assert.match(lines[0], /^documentId,title,originalFilename,storedFilename,problems,/);
  const formulaRow = lines.find((line) => line.includes("HYPERLINK"));
  assert.equal(formulaRow, undefined, "a clean document is not in the CSV");

  const csv = buildCsvReport([
    { documentId: 1, title: "=HYPERLINK(\"x\")", problems: [{ code: "zero-chunks" }] },
  ]);
  assert.match(csv.split("\n")[1], /^1,"'=HYPERLINK\(""x""\)"/);
});

test("the console report prints a count per problem and a short list", () => {
  const report = readOnlyReport(damaged);
  const text = formatConsoleReport(report, { show: 1 });

  assert.match(text, /Document health report \(read-only\)/);
  assert.match(text, /Documents needing attention:\s+9 of 11/);
  assert.match(text, /\s3\s+Zero chunks/);
  // --show 1 lists one document per problem and says how many it left out.
  assert.match(text, /\.\.\. and 2 more/);
  const healthyText = formatConsoleReport(readOnlyReport(healthy));
  assert.doesNotMatch(healthyText, /\.\.\. and/);
  assert.match(healthyText, /No documents need attention/);
});

test("argument parsing", () => {
  assert.deepEqual(parseArguments([]), { outputDir: "", show: 10 });
  assert.deepEqual(parseArguments(["--output-dir", "x", "--show", "3"]), { outputDir: "x", show: 3 });
  assert.equal(parseArguments(["--show", "nope"]).show, 10);
  assert.equal(parseArguments(["--show", "0"]).show, 0);
});

test("the CLI writes JSON and CSV, makes no network call, and leaves the library untouched", async () => {
  const outputDir = path.join(tempRoot, "cli-out");
  const databaseBefore = fs.readFileSync(damaged.databaseFile);
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  let fetchCalls = 0;
  const printed = [];

  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("the document-health report must not call the network");
  };
  console.log = (line) => printed.push(String(line));

  try {
    await runCli(["--output-dir", outputDir], {
      databaseFile: damaged.databaseFile,
      uploadsDir: damaged.uploadsDir,
      embeddingVersion: CURRENT,
    });
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  }

  assert.equal(fetchCalls, 0);
  assert.equal(process.exitCode ?? 0, 0);
  assert.ok(databaseBefore.equals(fs.readFileSync(damaged.databaseFile)), "database bytes changed");

  const json = JSON.parse(fs.readFileSync(path.join(outputDir, "document-health-report.json"), "utf8"));
  assert.equal(json.documentsNeedingAttention, 9);
  const csv = fs.readFileSync(path.join(outputDir, "document-health-report.csv"), "utf8");
  assert.equal(csv.trim().split("\n").length, 10);
  assert.ok(printed.some((line) => line.includes("JSON report:")));
});

test("the CLI refuses a database file that does not exist instead of creating one", async () => {
  const missing = path.join(tempRoot, "does-not-exist.db");
  const outputDir = path.join(tempRoot, "refused-out");
  const previousExitCode = process.exitCode;
  const originalError = console.error;
  console.error = () => {};

  try {
    await runCli(["--output-dir", outputDir], {
      databaseFile: missing,
      uploadsDir: damaged.uploadsDir,
      embeddingVersion: CURRENT,
    });
    assert.equal(process.exitCode, 1);
    assert.ok(!fs.existsSync(missing), "a missing database must not be created");
    assert.ok(!fs.existsSync(outputDir), "no report may be written when the database is missing");
  } finally {
    console.error = originalError;
    process.exitCode = previousExitCode;
  }
});
