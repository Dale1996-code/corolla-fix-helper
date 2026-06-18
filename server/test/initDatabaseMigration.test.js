import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-fix-helper-migration-"));

process.env.DATABASE_FILE = path.join(tempRoot, "legacy.db");
process.env.UPLOADS_DIR = path.join(tempRoot, "uploads");

const { db } = await import("../src/database.js");
const { initializeDatabase } = await import("../src/initDatabase.js");

after(() => {
  if (typeof db.close === "function") {
    db.close();
  }

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("initializeDatabase migrates legacy document_chunks before indexing embeddings", () => {
  db.exec(`
    CREATE TABLE document_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id INTEGER NOT NULL,
      page_number INTEGER NOT NULL,
      chunk_index INTEGER NOT NULL,
      chunk_text TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (document_id, page_number, chunk_index)
    );
  `);

  initializeDatabase();

  const columns = db.prepare("PRAGMA table_info(document_chunks)").all();
  const columnNames = columns.map((column) => column.name);
  const indexes = db.prepare("PRAGMA index_list(document_chunks)").all();

  assert.ok(columnNames.includes("embedding"));
  assert.ok(columnNames.includes("embedding_version"));
  assert.ok(
    indexes.some((index) => index.name === "idx_document_chunks_embedding_version")
  );
});

test("initializeDatabase creates the attachments table and its entity index", () => {
  initializeDatabase();

  const attachmentsTable = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'attachments'"
    )
    .get();
  assert.ok(attachmentsTable, "attachments table should exist");

  const columnNames = db
    .prepare("PRAGMA table_info(attachments)")
    .all()
    .map((column) => column.name);

  for (const expectedColumn of [
    "id",
    "entity_type",
    "entity_id",
    "original_filename",
    "stored_filename",
    "mime_type",
  ]) {
    assert.ok(
      columnNames.includes(expectedColumn),
      `attachments table should have a ${expectedColumn} column`
    );
  }

  const indexes = db.prepare("PRAGMA index_list(attachments)").all();
  assert.ok(
    indexes.some((index) => index.name === "idx_attachments_entity"),
    "attachments table should have idx_attachments_entity"
  );
});
