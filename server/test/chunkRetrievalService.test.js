import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-fix-helper-retrieval-"));

process.env.DATABASE_FILE = path.join(tempRoot, "test.db");
process.env.UPLOADS_DIR = path.join(tempRoot, "uploads");
// No OPENAI_API_KEY: a keyword match on an unembedded chunk must not need one.
delete process.env.OPENAI_API_KEY;

const { db } = await import("../src/database.js");
const { initializeDatabase } = await import("../src/initDatabase.js");
const { retrieveRelevantChunks } = await import(
  "../src/services/chunkRetrievalService.js"
);

initializeDatabase();

after(() => {
  if (typeof db.close === "function") {
    db.close();
  }

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function insertDocument() {
  const vehicle = db.prepare("SELECT id FROM vehicles ORDER BY id ASC LIMIT 1").get();
  assert.ok(vehicle);

  return Number(
    db
      .prepare(`
        INSERT INTO documents (
          vehicle_id, title, original_filename, stored_filename, file_path,
          file_type, system, document_type, extracted_text, extraction_status, page_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        vehicle.id,
        "Oil filter notes",
        "oil-filter.pdf",
        "oil-filter.pdf",
        "server/uploads/oil-filter.pdf",
        "application/pdf",
        "Engine",
        "Repair Manual",
        "",
        "completed",
        1
      ).lastInsertRowid
  );
}

test("hybrid retrieval returns an unembedded chunk that matches a keyword", async () => {
  // Clean slate so only this chunk is present and nothing is embedded.
  db.exec("DELETE FROM document_chunks");

  const documentId = insertDocument();
  db.prepare(`
    INSERT INTO document_chunks (document_id, page_number, chunk_index, chunk_text)
    VALUES (?, 1, 0, ?)
  `).run(documentId, "oil filter 2009 Corolla replacement interval");

  // Default mode is hybrid. With no embeddings present yet, retrieval must still
  // find the chunk by keyword — and without calling the embedding API.
  const results = await retrieveRelevantChunks("oil filter");

  const match = results.find((result) => result.documentId === documentId);
  assert.ok(match, "expected the unembedded keyword match to be returned");
  assert.match(match.chunkText, /oil filter/i);
});
