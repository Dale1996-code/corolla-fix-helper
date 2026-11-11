import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

// The plan flagged rebuildDocumentChunksFromPages as a data-loss risk: "hard
// DELETEs before rebuilding, so a partial failure leaves a document unusable".
// That is NO LONGER TRUE -- the delete and the inserts already run inside one
// BEGIN IMMEDIATE / COMMIT / ROLLBACK transaction. Rather than rewrite working
// code, this pins the property so it cannot silently regress.
//
// Audit 1B-04 widened it: persisting an extraction updates the document row AND
// rebuilds its chunks, and those once committed separately. The last test pins
// that a failed rebuild now rolls the row back too.
//
// N5 P2 widened it again: each chunk's applicability scope (`scope_at_start`,
// `scope_version`) is written by the SAME inserts, so a re-extraction replaces
// text and scope together, and a failed one leaves the old scopes exactly as
// they were. Nothing reads the scope yet; these tests only pin what is stored.
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-fix-helper-chunk-atomic-"));
process.env.DATABASE_FILE = path.join(tempRoot, "chunks.db");
process.env.UPLOADS_DIR = path.join(tempRoot, "uploads");

const { db } = await import("../src/database.js");
const { initializeDatabase } = await import("../src/initDatabase.js");
const { rebuildDocumentChunksFromPages } = await import(
  "../src/services/documentChunkService.js"
);
const { persistExtractionResult } = await import("../src/services/documentService.js");
const { APPLICABILITY_SCOPE_VERSION } = await import("../src/services/applicabilityScope.js");

initializeDatabase();

const NO_SCOPE = { engine: null, plant: null };
const AZ_ARTICLE = { value: "2AZ-FE", exclude: false, kind: "article_title" };

/** Every chunk of a document with its stored scope parsed back from JSON. */
function storedScopes(documentId) {
  return db
    .prepare(
      `select page_number, chunk_index, scope_at_start, scope_version
       from document_chunks where document_id = ? order by page_number, chunk_index`
    )
    .all(documentId)
    .map((row) => ({
      page: row.page_number,
      chunk: row.chunk_index,
      scope: row.scope_at_start === null ? null : JSON.parse(row.scope_at_start),
      version: row.scope_version,
    }));
}

/** A page long enough for three chunks, with "(for <engine>)" at word 10. */
function longPageWithBlock(engine) {
  const words = Array.from({ length: 450 }, (_, index) => `w${index + 1}`);
  words.splice(9, 1, "(for", `${engine})`);
  return words.join(" ");
}

after(() => {
  if (typeof db.close === "function") {
    db.close();
  }

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function seedDocument() {
  const vehicleId = db.prepare("select id from vehicles limit 1").get()?.id;
  const info = db
    .prepare(
      `insert into documents (vehicle_id, title, original_filename, stored_filename, system, document_type)
       values (?, ?, ?, ?, ?, ?)`
    )
    .run(vehicleId, "Torque Specs", "torque.pdf", "torque-abc.pdf", "Engine", "Reference");

  return Number(info.lastInsertRowid);
}

function chunkCount(documentId) {
  return db
    .prepare("select count(*) c from document_chunks where document_id = ?")
    .get(documentId).c;
}

test("a successful rebuild replaces the previous chunks", () => {
  const documentId = seedDocument();

  rebuildDocumentChunksFromPages(documentId, [
    { pageNumber: 1, text: "Oil pan drain plug 37 Nm" },
  ]);
  const first = chunkCount(documentId);
  assert.ok(first > 0);

  rebuildDocumentChunksFromPages(documentId, [
    { pageNumber: 1, text: "Replaced page one text" },
    { pageNumber: 2, text: "Replaced page two text" },
  ]);

  const rows = db
    .prepare("select chunk_text from document_chunks where document_id = ? order by page_number")
    .all(documentId);

  assert.equal(rows.length, 2);
  assert.match(rows[0].chunk_text, /Replaced page one/);
  assert.ok(
    !rows.some((row) => /drain plug/.test(row.chunk_text)),
    "old chunks must be gone after a successful rebuild"
  );
});

test("a failed rebuild rolls back and leaves the previous chunks intact", () => {
  const documentId = seedDocument();

  rebuildDocumentChunksFromPages(documentId, [
    { pageNumber: 1, text: "Vehicle > Engine > Specs (2AZ-FE) NOTICE: Original page one" },
    { pageNumber: 2, text: "Original page two" },
  ]);
  const before = db
    .prepare(
      "select chunk_text, scope_at_start, scope_version from document_chunks where document_id = ? order by page_number"
    )
    .all(documentId);
  assert.equal(before.length, 2);
  assert.deepEqual(JSON.parse(before[1].scope_at_start).engine, AZ_ARTICLE, "precondition: page 2 is scoped");

  // Force a failure partway through the inserts. Two page objects with the same
  // pageNumber both produce chunk_index 0, violating
  // UNIQUE(document_id, page_number, chunk_index) on the SECOND insert -- after
  // the DELETE has already run. That is exactly the "document left unusable"
  // scenario the plan was worried about.
  assert.throws(() =>
    rebuildDocumentChunksFromPages(documentId, [
      { pageNumber: 1, text: "New page one" },
      { pageNumber: 1, text: "Duplicate page one collides on the unique index" },
    ])
  );

  const after = db
    .prepare(
      "select chunk_text, scope_at_start, scope_version from document_chunks where document_id = ? order by page_number"
    )
    .all(documentId);

  assert.equal(after.length, 2, "the rollback must restore the original chunk count");
  assert.deepEqual(
    after.map((row) => row.chunk_text),
    before.map((row) => row.chunk_text),
    "the document must not be left empty or partially rebuilt"
  );
  assert.deepEqual(
    after.map((row) => [row.scope_at_start, row.scope_version]),
    before.map((row) => [row.scope_at_start, row.scope_version]),
    "the old chunks must keep their old scopes"
  );
});

test("a failed rebuild while persisting an extraction rolls the document row back too (1B-04)", () => {
  const documentId = seedDocument();

  persistExtractionResult(documentId, {
    extractedText: "Vehicle > Engine > Specs (2AZ-FE) NOTICE: Original page one\n\nOriginal page two",
    extractionStatus: "completed",
    pageCount: 2,
    pages: [
      { pageNumber: 1, text: "Vehicle > Engine > Specs (2AZ-FE) NOTICE: Original page one" },
      { pageNumber: 2, text: "Original page two" },
    ],
  });

  const readRow = () =>
    db
      .prepare("select extracted_text, extraction_status, page_count from documents where id = ?")
      .get(documentId);
  const readChunks = () =>
    db
      .prepare(
        "select chunk_text, scope_at_start, scope_version from document_chunks where document_id = ? order by page_number"
      )
      .all(documentId)
      .map((row) => [row.chunk_text, row.scope_at_start, row.scope_version]);
  const rowBefore = readRow();
  const chunksBefore = readChunks();

  assert.equal(rowBefore.page_count, 2);
  assert.equal(chunksBefore.length, 2);
  assert.equal(chunksBefore[1][2], APPLICABILITY_SCOPE_VERSION, "precondition: the chunks carry a scope");

  // The row UPDATE succeeds; the rebuild then collides on the unique index (see
  // the test above). Before 1B-04 the row kept the new text over the old chunks.
  assert.throws(() =>
    persistExtractionResult(documentId, {
      extractedText: "New text that must not survive the failure",
      extractionStatus: "completed_with_ocr",
      pageCount: 7,
      pages: [
        { pageNumber: 1, text: "New page one" },
        { pageNumber: 1, text: "Duplicate page one collides on the unique index" },
      ],
    })
  );

  assert.deepEqual(readRow(), rowBefore, "the document row must roll back with its chunks");
  assert.deepEqual(readChunks(), chunksBefore, "the chunks must be left exactly as they were");
  assert.equal(db.isTransaction, false, "no transaction may be left open after the failure");
});

test("other documents are untouched by a rebuild", () => {
  const keep = seedDocument();
  const rebuild = seedDocument();

  rebuildDocumentChunksFromPages(keep, [{ pageNumber: 1, text: "Keep this text" }]);
  rebuildDocumentChunksFromPages(rebuild, [{ pageNumber: 1, text: "Rebuild this text" }]);
  rebuildDocumentChunksFromPages(rebuild, [{ pageNumber: 1, text: "Rebuilt again" }]);

  assert.equal(chunkCount(keep), 1);
  assert.match(
    db.prepare("select chunk_text from document_chunks where document_id = ?").get(keep)
      .chunk_text,
    /Keep this text/
  );
});

// ---- N5 P2: the scope is written with the chunks ----

test("a rebuild stores every chunk's starting scope and the tagger version", () => {
  const documentId = seedDocument();

  rebuildDocumentChunksFromPages(documentId, [
    { pageNumber: 1, text: "Vehicle > Engine > Torque Specifications (2AZ-FE) NOTICE: bolt 30 N*m" },
    { pageNumber: 2, text: "Bolt 40 N*m" },
    { pageNumber: 3, text: longPageWithBlock("2ZR-FE") },
  ]);

  const rows = storedScopes(documentId);
  assert.equal(rows.length, 5);
  assert.ok(
    rows.every((row) => row.version === APPLICABILITY_SCOPE_VERSION),
    "every chunk must record which tagger rules produced its scope"
  );
  // Page 1's only chunk starts at "Vehicle", BEFORE the title names an engine.
  assert.deepEqual(rows[0].scope, NO_SCOPE);
  // Page 2 names no engine, but the article title on page 1 still scopes it --
  // context the rebuild has because it holds every page of the document.
  assert.deepEqual(rows[1].scope, { engine: AZ_ARTICLE, plant: null });
  // Page 3, chunk 0 starts under the carried title; chunks 1 and 2 start inside
  // the "(for 2ZR-FE)" block that chunk 0 opened, though they never name it.
  assert.deepEqual(rows[2].scope, { engine: AZ_ARTICLE, plant: null });
  for (const row of rows.slice(3)) {
    assert.deepEqual(row.scope, {
      engine: { value: "2ZR-FE", exclude: false, kind: "inline_for" },
      plant: null,
    });
  }
});

test("the account header alone is never stored as a 2ZR-FE scope", () => {
  const documentId = seedDocument();

  rebuildDocumentChunksFromPages(documentId, [
    {
      pageNumber: 1,
      text: "2009 Toyota Corolla L4-1.8L (2ZR-FE) Vehicle > Brakes > Front Pad Replacement HINT: torque 107 N*m",
    },
    { pageNumber: 2, text: "Caliper bracket bolt 107 N*m" },
  ]);

  for (const row of storedScopes(documentId)) {
    assert.deepEqual(row.scope, NO_SCOPE);
    assert.equal(row.version, APPLICABILITY_SCOPE_VERSION);
  }
});

test("re-extraction recomputes the scope from the new text in the same rebuild", () => {
  const documentId = seedDocument();

  rebuildDocumentChunksFromPages(documentId, [
    { pageNumber: 1, text: "Vehicle > Engine > Specs (2AZ-FE) NOTICE: bolt 30 N*m" },
    { pageNumber: 2, text: "Bolt 40 N*m" },
  ]);
  assert.deepEqual(storedScopes(documentId)[1].scope.engine, AZ_ARTICLE);

  rebuildDocumentChunksFromPages(documentId, [
    { pageNumber: 1, text: "Vehicle > Engine > Specs (2ZR-FE) NOTICE: bolt 30 N*m" },
    { pageNumber: 2, text: "Bolt 40 N*m" },
  ]);

  const rows = storedScopes(documentId);
  assert.equal(rows.length, 2, "the old chunks and their scopes are gone");
  assert.deepEqual(rows[1].scope.engine, { value: "2ZR-FE", exclude: false, kind: "article_title" });
});

test("persisting an extraction stores the scope with the chunks", () => {
  const documentId = seedDocument();

  persistExtractionResult(documentId, {
    extractedText: "x",
    extractionStatus: "completed",
    pageCount: 1,
    pages: [{ pageNumber: 1, text: longPageWithBlock("2AZ-FE") }],
  });

  const rows = storedScopes(documentId);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0].scope, NO_SCOPE, "chunk 0 starts before the marker");
  assert.equal(rows[2].scope.engine.value, "2AZ-FE");
});

test("a tagger failure still saves the chunks, with no scope rather than a guessed one", (t) => {
  const documentId = seedDocument();
  const warn = t.mock.method(console, "warn", () => {});

  const summary = rebuildDocumentChunksFromPages(
    documentId,
    [{ pageNumber: 1, text: "Vehicle > Engine > Specs (2AZ-FE) NOTICE: bolt 30 N*m" }],
    {
      computeScopeColumns: () => {
        throw new Error("tagger bug");
      },
    }
  );

  assert.equal(summary.chunkCount, 1, "uploading or re-extracting a PDF must not start failing");
  assert.deepEqual(storedScopes(documentId), [{ page: 1, chunk: 0, scope: null, version: null }]);
  // Log-safe: the document id and nothing from the manual or the error.
  assert.equal(warn.mock.callCount(), 1);
  assert.ok(String(warn.mock.calls[0].arguments[0]).includes(`document ${documentId};`));
  assert.doesNotMatch(String(warn.mock.calls[0].arguments.join(" ")), /tagger bug|NOTICE|2AZ-FE/);
});

test("a non-default chunk window stores no scope, since the tagger cuts at 200/40 words", () => {
  const documentId = seedDocument();

  rebuildDocumentChunksFromPages(documentId, [{ pageNumber: 1, text: longPageWithBlock("2AZ-FE") }], {
    chunkWordSize: 50,
    chunkWordOverlap: 10,
  });

  const rows = storedScopes(documentId);
  assert.ok(rows.length > 3, "the custom window still chunks the page");
  assert.ok(rows.every((row) => row.scope === null && row.version === null));
});

test("a page the chunker skips does not scope the pages after it", () => {
  const documentId = seedDocument();

  rebuildDocumentChunksFromPages(documentId, [
    // No valid page number: the chunker stores nothing for it, so the backfill
    // (which only sees stored chunks) could never see this title either.
    { pageNumber: 0, text: "Vehicle > Engine > Specs (2AZ-FE) NOTICE: bolt 30 N*m" },
    { pageNumber: 1, text: "Bolt 40 N*m" },
  ]);

  assert.deepEqual(storedScopes(documentId), [
    { page: 1, chunk: 0, scope: NO_SCOPE, version: APPLICABILITY_SCOPE_VERSION },
  ]);
});
