import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-fix-helper-seed-"));

process.env.DATABASE_FILE = path.join(tempRoot, "seed.db");
process.env.UPLOADS_DIR = path.join(tempRoot, "uploads");
// This suite is specifically about the demo/sample seed, which is now opt-in.
process.env.SEED_DEMO = "true";

const { db } = await import("../src/database.js");
const { config } = await import("../src/config.js");
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

test("every seeded document points at a real file on disk", () => {
  initializeDatabase();

  const documents = db.prepare("SELECT stored_filename FROM documents").all();

  assert.ok(documents.length >= 1, "demo seeding should create at least one document");

  for (const document of documents) {
    const filePath = path.join(config.uploadsDir, String(document.stored_filename));
    assert.ok(
      fs.existsSync(filePath),
      `seeded document file should exist on disk: ${document.stored_filename}`
    );
  }
});
