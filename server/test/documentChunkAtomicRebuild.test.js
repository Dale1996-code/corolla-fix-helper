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
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-fix-helper-chunk-atomic-"));
process.env.DATABASE_FILE = path.join(tempRoot, "chunks.db");
process.env.UPLOADS_DIR = path.join(tempRoot, "uploads");

const { db } = await import("../src/database.js");
const { initializeDatabase } = await import("../src/initDatabase.js");
const { rebuildDocumentChunksFromPages } = await import(
  "../src/services/documentChunkService.js"
);

initializeDatabase();

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
    { pageNumber: 1, text: "Original page one" },
    { pageNumber: 2, text: "Original page two" },
  ]);
  const before = db
    .prepare("select chunk_text from document_chunks where document_id = ? order by page_number")
    .all(documentId);
  assert.equal(before.length, 2);

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
    .prepare("select chunk_text from document_chunks where document_id = ? order by page_number")
    .all(documentId);

  assert.equal(after.length, 2, "the rollback must restore the original chunk count");
  assert.deepEqual(
    after.map((row) => row.chunk_text),
    before.map((row) => row.chunk_text),
    "the document must not be left empty or partially rebuilt"
  );
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
