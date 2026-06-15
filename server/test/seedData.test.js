import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-fix-helper-seed-"));

process.env.DATABASE_FILE = path.join(tempRoot, "seed.db");
process.env.UPLOADS_DIR = path.join(tempRoot, "uploads");

const { db } = await import("../src/database.js");
const { initializeDatabase } = await import("../src/initDatabase.js");

const SEED_DOCUMENT_FILENAME = "2009-corolla-maintenance-sample.pdf";

function getSeedDocumentId() {
  return db
    .prepare("SELECT id FROM documents WHERE original_filename = ?")
    .get(SEED_DOCUMENT_FILENAME)?.id;
}

after(() => {
  if (typeof db.close === "function") {
    db.close();
  }

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("initializeDatabase seeds retrievable chunks for the sample document", () => {
  initializeDatabase();

  const seedDocumentId = getSeedDocumentId();
  assert.ok(seedDocumentId, "seed document should exist");

  const chunks = db
    .prepare("SELECT chunk_text FROM document_chunks WHERE document_id = ?")
    .all(seedDocumentId);

  assert.ok(chunks.length >= 1, "seed document should have at least one chunk");
  assert.match(String(chunks[0].chunk_text), /oil/i);
});

test("initializeDatabase does not duplicate seed chunks across restarts", () => {
  initializeDatabase();
  initializeDatabase();

  const seedDocumentId = getSeedDocumentId();
  const chunks = db
    .prepare("SELECT id FROM document_chunks WHERE document_id = ?")
    .all(seedDocumentId);

  assert.equal(chunks.length, 1, "re-running init must not duplicate seed chunks");
});
