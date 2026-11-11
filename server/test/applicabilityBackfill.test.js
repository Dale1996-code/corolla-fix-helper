import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { after, beforeEach } from "node:test";

// `npm run backfill:applicability` (N5 P2) fills scope_at_start / scope_version
// for chunks stored before the rebuild computed them, or under older tagger
// rules. It reads only stored chunks -- no PDF, no model, no network -- writes
// only with --apply, one document per transaction, and touches nothing but the
// two scope columns. The scope it stores must equal what the chunk rebuild
// stores for the same pages, or a re-extraction would silently change it.

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-fix-helper-applicability-backfill-"));
process.env.DATABASE_FILE = path.join(tempRoot, "backfill.db");
process.env.UPLOADS_DIR = path.join(tempRoot, "uploads");

const { db, withTransaction } = await import("../src/database.js");
const { initializeDatabase } = await import("../src/initDatabase.js");
const { rebuildDocumentChunksFromPages } = await import("../src/services/documentChunkService.js");
const { APPLICABILITY_SCOPE_VERSION } = await import("../src/services/applicabilityScope.js");
const { runApplicabilityBackfill } = await import("../src/services/applicabilityBackfill.js");

initializeDatabase();

after(() => {
  if (typeof db.close === "function") {
    db.close();
  }

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

beforeEach(() => {
  db.exec("DELETE FROM document_chunks; DELETE FROM documents;");
});

function seedDocument(title = "Specs") {
  const vehicleId = db.prepare("SELECT id FROM vehicles LIMIT 1").get()?.id;
  const info = db
    .prepare(
      `INSERT INTO documents (vehicle_id, title, original_filename, stored_filename, system, document_type)
       VALUES (?, ?, ?, ?, 'Engine', 'Repair Manual')`
    )
    .run(vehicleId, title, `${title}.pdf`, `${title}-${Math.random()}.pdf`);
  return Number(info.lastInsertRowid);
}

/** A page long enough for three chunks, with "(for <engine>)" at word 10. */
function longPageWithBlock(engine) {
  const words = Array.from({ length: 450 }, (_, index) => `w${index + 1}`);
  words.splice(9, 1, "(for", `${engine})`);
  return words.join(" ");
}

/** A document whose scopes depend on page carry and on a block spanning chunks. */
function seedScopedDocument() {
  const documentId = seedDocument();
  rebuildDocumentChunksFromPages(documentId, [
    { pageNumber: 1, text: "Vehicle > Engine > Torque Specifications (2AZ-FE) NOTICE: bolt 30 N*m" },
    { pageNumber: 2, text: "Bolt 40 N*m" },
    { pageNumber: 3, text: longPageWithBlock("2ZR-FE") },
  ]);
  return documentId;
}

const scopeRows = () =>
  db
    .prepare(
      "SELECT id, document_id, page_number, chunk_index, scope_at_start, scope_version FROM document_chunks ORDER BY id"
    )
    .all()
    .map((row) => ({ ...row }));

const clearScopes = () => db.exec("UPDATE document_chunks SET scope_at_start = NULL, scope_version = NULL");

const apply = (options = {}) => runApplicabilityBackfill(db, { apply: true, withTransaction, ...options });

test("a dry run reports what it would tag and writes nothing", () => {
  seedScopedDocument();
  seedScopedDocument();
  clearScopes();
  const before = scopeRows();

  const summary = runApplicabilityBackfill(db);

  assert.equal(summary.applied, false);
  assert.equal(summary.scopeVersion, APPLICABILITY_SCOPE_VERSION);
  assert.equal(summary.totalChunks, 10);
  assert.equal(summary.currentBefore, 0);
  assert.equal(summary.documentsToTag, 2);
  assert.equal(summary.chunksToTag, 10);
  assert.equal(summary.taggedChunks, 0);
  // What each chunk would start under, per engine ("not stated" = no marker).
  assert.deepEqual(summary.engineAtStart, { "not stated": 2, "2AZ-FE": 4, "2ZR-FE": 4 });
  assert.deepEqual(scopeRows(), before, "a dry run must not write");
});

test("--apply stores exactly the scope the chunk rebuild stores", () => {
  seedScopedDocument();
  const fromRebuild = scopeRows();
  assert.ok(fromRebuild.every((row) => row.scope_version === APPLICABILITY_SCOPE_VERSION), "precondition");
  clearScopes();

  const summary = apply();

  assert.equal(summary.applied, true);
  assert.equal(summary.taggedDocuments, 1);
  assert.equal(summary.taggedChunks, 5);
  assert.equal(summary.currentAfter, 5);
  assert.deepEqual(summary.engineAtStart, { "not stated": 1, "2AZ-FE": 2, "2ZR-FE": 2 });
  assert.deepEqual(scopeRows(), fromRebuild);
});

test("the backfill never touches chunk text, embeddings, or embedding versions", () => {
  const documentId = seedScopedDocument();
  const embedding = Buffer.from(new Float32Array([0.5, -0.25, 1]).buffer);
  db.prepare("UPDATE document_chunks SET embedding = ?, embedding_version = 'model@3' WHERE document_id = ?").run(
    embedding,
    documentId
  );
  clearScopes();
  const readOtherColumns = () =>
    db
      .prepare(
        `SELECT id, document_id, page_number, chunk_index, chunk_text, embedding, embedding_version, created_at
         FROM document_chunks ORDER BY id`
      )
      .all()
      .map((row) => ({ ...row }));
  const before = readOtherColumns();

  apply();

  assert.deepEqual(readOtherColumns(), before);
});

test("it is resumable: --limit tags some documents, the next run the rest, then nothing", () => {
  const first = seedScopedDocument();
  const second = seedScopedDocument();
  clearScopes();

  const partial = apply({ limit: 1 });
  assert.equal(partial.taggedDocuments, 1);
  assert.equal(partial.remainingDocuments, 1);
  const tagged = (documentId) =>
    db
      .prepare("SELECT COUNT(*) AS c FROM document_chunks WHERE document_id = ? AND scope_version = ?")
      .get(documentId, APPLICABILITY_SCOPE_VERSION).c;
  assert.equal(tagged(first), 5);
  assert.equal(tagged(second), 0);

  const rest = apply();
  assert.equal(rest.taggedDocuments, 1);
  assert.equal(rest.remainingDocuments, 0);
  assert.equal(tagged(second), 5);

  const again = apply();
  assert.equal(again.documentsToTag, 0);
  assert.equal(again.taggedChunks, 0);
  assert.equal(again.currentBefore, 10);
});

test("--document-id tags only that document", () => {
  const first = seedScopedDocument();
  seedScopedDocument();
  clearScopes();

  const summary = apply({ documentId: first });

  assert.equal(summary.taggedDocuments, 1);
  assert.deepEqual(
    [...new Set(scopeRows().filter((row) => row.scope_version !== null).map((row) => row.document_id))],
    [first]
  );
});

test("chunks tagged under older tagger rules are tagged again", () => {
  seedScopedDocument();
  const current = scopeRows();
  db.exec("UPDATE document_chunks SET scope_version = 'scope-v0'");

  const summary = apply();

  assert.equal(summary.currentBefore, 0);
  assert.equal(summary.taggedChunks, 5);
  assert.deepEqual(scopeRows(), current);
});

test("a document whose stored chunks do not follow the chunk window is left alone and reported", () => {
  const good = seedScopedDocument();
  const odd = seedDocument("Odd");
  // Two chunks on one page that do not share the 40-word overlap: the page text
  // cannot be rebuilt, so neither chunk's starting word can be placed.
  const insert = db.prepare(
    "INSERT INTO document_chunks (document_id, page_number, chunk_index, chunk_text) VALUES (?, 1, ?, ?)"
  );
  insert.run(odd, 0, Array.from({ length: 200 }, (_, index) => `a${index}`).join(" "));
  insert.run(odd, 1, "(for 2AZ-FE) torque 9 N*m");
  // A missing chunk index (0, then 2) is the same problem.
  const gap = seedDocument("Gap");
  db.prepare(
    "INSERT INTO document_chunks (document_id, page_number, chunk_index, chunk_text) VALUES (?, 1, 0, 'Bolt 9 N*m'), (?, 1, 2, 'Bolt 12 N*m')"
  ).run(gap, gap);
  clearScopes();

  const summary = apply();

  assert.deepEqual(summary.skipped.window_mismatch, [odd, gap]);
  assert.equal(summary.taggedDocuments, 1);
  assert.equal(summary.remainingDocuments, 2, "skipped documents are still to do");
  for (const row of scopeRows().filter((row) => row.document_id !== good)) {
    assert.equal(row.scope_at_start, null);
    assert.equal(row.scope_version, null);
  }
});

test("a tagger failure leaves that document untouched and the others are still tagged", () => {
  const failing = seedScopedDocument();
  const fine = seedScopedDocument();
  clearScopes();
  let calls = 0;

  const summary = apply({
    computeScopeColumns: (pages) => {
      calls += 1;
      if (calls === 1) {
        throw new Error("tagger bug");
      }
      return realComputeScopeColumns(pages);
    },
  });

  assert.deepEqual(summary.skipped.tagger_failed, [failing]);
  assert.equal(summary.taggedDocuments, 1);
  assert.ok(scopeRows().filter((row) => row.document_id === failing).every((row) => row.scope_version === null));
  assert.ok(scopeRows().filter((row) => row.document_id === fine).every((row) => row.scope_version !== null));
});

const { computeChunkScopeColumns: realComputeScopeColumns } = await import(
  "../src/services/chunkScopePersistence.js"
);

test("a document rebuilt while the backfill runs keeps its new chunks and is reported", () => {
  const documentId = seedScopedDocument();
  clearScopes();

  const summary = apply({
    computeScopeColumns: (pages) => {
      // The server re-extracts the document between the backfill's read and
      // its write: every chunk gets a new id and the rebuild's own scope.
      rebuildDocumentChunksFromPages(documentId, [
        { pageNumber: 1, text: "Vehicle > Engine > Specs (2ZR-FE) NOTICE: bolt 30 N*m" },
      ]);
      return realComputeScopeColumns(pages);
    },
  });

  assert.deepEqual(summary.skipped.changed_during_run, [documentId]);
  assert.equal(summary.taggedChunks, 0);
  const rows = scopeRows();
  assert.equal(rows.length, 1);
  assert.equal(JSON.parse(rows[0].scope_at_start).engine, null, "the rebuild's scope for its first word survives");
  assert.equal(rows[0].scope_version, APPLICABILITY_SCOPE_VERSION);
});

test("the backfill makes no network calls", (t) => {
  seedScopedDocument();
  clearScopes();
  const fetchMock = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("the backfill must not call the network");
  });

  runApplicabilityBackfill(db);
  apply();

  assert.equal(fetchMock.mock.callCount(), 0);
});

test("a dry run reads a database from before migration 008 without migrating it", () => {
  seedScopedDocument();
  const oldFile = path.join(tempRoot, `pre-008-${Date.now()}.db`);
  db.exec(`VACUUM INTO '${oldFile.replace(/'/g, "''")}'`);
  const writable = new DatabaseSync(oldFile);
  writable.exec("ALTER TABLE document_chunks DROP COLUMN scope_at_start");
  writable.exec("ALTER TABLE document_chunks DROP COLUMN scope_version");
  writable.close();

  const readOnly = new DatabaseSync(oldFile, { readOnly: true });
  try {
    const summary = runApplicabilityBackfill(readOnly);

    assert.equal(summary.migrationPending, true);
    assert.equal(summary.currentBefore, 0);
    assert.equal(summary.chunksToTag, 5);
    assert.equal(summary.taggedChunks, 0);
    const columns = readOnly.prepare("PRAGMA table_info(document_chunks)").all().map((column) => column.name);
    assert.ok(!columns.includes("scope_at_start"), "a dry run must not add the columns");
  } finally {
    readOnly.close();
  }

  const again = new DatabaseSync(oldFile, { readOnly: true });
  try {
    assert.throws(
      () => runApplicabilityBackfill(again, { apply: true, withTransaction }),
      /migration 008/,
      "--apply refuses a database whose columns are missing"
    );
  } finally {
    again.close();
  }
});
