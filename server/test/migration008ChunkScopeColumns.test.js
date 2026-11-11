import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

// Migration 008 (N5 P2) adds two NULLABLE columns to document_chunks:
// `scope_at_start` (the applicability scope in effect at the chunk's first
// word, as JSON) and `scope_version` (which tagger rules produced it, like
// `embedding_version`). The migration only adds the columns. It computes
// nothing, so existing chunks read NULL -- "not computed yet" -- until
// `npm run backfill:applicability` fills them, and startup stays as fast as it
// was. It must not touch a chunk's text, embedding, or embedding version.

const MIGRATION = "008_document_chunk_applicability_scope";
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-fix-helper-migration008-"));

process.env.DATABASE_FILE = path.join(tempRoot, "migration008.db");
process.env.UPLOADS_DIR = path.join(tempRoot, "uploads");

const { db } = await import("../src/database.js");
const { initializeDatabase } = await import("../src/initDatabase.js");

initializeDatabase();

after(() => {
  if (typeof db.close === "function") {
    db.close();
  }

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function chunkColumns() {
  return new Map(
    db
      .prepare("PRAGMA table_info(document_chunks)")
      .all()
      .map((column) => [column.name, column])
  );
}

function seedDocument() {
  const vehicleId = db.prepare("SELECT id FROM vehicles LIMIT 1").get()?.id;
  const info = db
    .prepare(
      `INSERT INTO documents (vehicle_id, title, original_filename, stored_filename, system, document_type)
       VALUES (?, 'Torque Specs', 'torque.pdf', 'torque-abc.pdf', 'Engine', 'Reference')`
    )
    .run(vehicleId);

  return Number(info.lastInsertRowid);
}

test("migration 008 adds nullable scope_at_start and scope_version text columns", () => {
  const columns = chunkColumns();

  for (const name of ["scope_at_start", "scope_version"]) {
    const column = columns.get(name);
    assert.ok(column, `document_chunks.${name} must exist`);
    assert.equal(column.type, "TEXT");
    assert.equal(column.notnull, 0, `${name} must be nullable: NULL means "not computed yet"`);
    assert.equal(column.dflt_value, null, `${name} must have no default`);
  }

  const recorded = db
    .prepare("SELECT COUNT(*) AS c FROM schema_migrations WHERE name = ?")
    .get(MIGRATION).c;
  assert.equal(recorded, 1);
});

test("upgrading a pre-008 database keeps every chunk's text and embedding and leaves scope NULL", () => {
  // Rebuild the shape of a database that stopped at migration 007.
  db.exec("ALTER TABLE document_chunks DROP COLUMN scope_at_start");
  db.exec("ALTER TABLE document_chunks DROP COLUMN scope_version");
  db.prepare("DELETE FROM schema_migrations WHERE name = ?").run(MIGRATION);

  const documentId = seedDocument();
  const embedding = Buffer.from(new Float32Array([0.25, -0.5, 1]).buffer);
  db.prepare(
    `INSERT INTO document_chunks (document_id, page_number, chunk_index, chunk_text, embedding, embedding_version)
     VALUES (?, 1, 0, 'Oil pan drain plug 37 Nm (for 2AZ-FE)', ?, 'text-embedding-3-small@512')`
  ).run(documentId, embedding);
  const readChunk = () =>
    db
      .prepare(
        "SELECT id, page_number, chunk_index, chunk_text, embedding, embedding_version FROM document_chunks WHERE document_id = ?"
      )
      .get(documentId);
  const before = readChunk();

  initializeDatabase();

  assert.ok(chunkColumns().has("scope_at_start"));
  assert.ok(chunkColumns().has("scope_version"));
  assert.deepEqual(readChunk(), before, "the migration must not rewrite an existing chunk");
  assert.deepEqual(
    {
      ...db
        .prepare("SELECT scope_at_start, scope_version FROM document_chunks WHERE document_id = ?")
        .get(documentId),
    },
    { scope_at_start: null, scope_version: null },
    "the migration computes no scope; the backfill does"
  );
});

test("running init again does not re-apply migration 008", () => {
  initializeDatabase();
  initializeDatabase();

  const recorded = db
    .prepare("SELECT COUNT(*) AS c FROM schema_migrations WHERE name = ?")
    .get(MIGRATION).c;
  assert.equal(recorded, 1);
});
