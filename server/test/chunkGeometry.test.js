import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

// The applicability tagger (N5) must know exactly where each stored chunk starts
// inside its page, and it rebuilds page text from stored chunks. Both depend on
// the chunker's window, so these tests pin the shared geometry against the real
// chunker rather than a copy of its numbers. documentChunkService imports the
// database, hence the scratch paths.

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-chunk-geometry-"));

process.env.DATABASE_FILE = path.join(tempRoot, "test.db");
process.env.UPLOADS_DIR = path.join(tempRoot, "uploads");

const {
  CHUNK_WORD_OVERLAP,
  CHUNK_WORD_SIZE,
  CHUNK_WORD_STEP,
  chunkStartWordIndex,
  normalizeChunkWords,
  reconstructPageWords,
} = await import("../src/services/chunkGeometry.js");
const { chunkPageText } = await import("../src/services/documentChunkService.js");
const { db } = await import("../src/database.js");

after(() => {
  if (typeof db.close === "function") {
    db.close();
  }

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function syntheticPage(wordCount) {
  return Array.from({ length: wordCount }, (_, index) => `w${index + 1}`).join("  \n ");
}

test("the window is 200 words with a 40-word overlap", () => {
  assert.equal(CHUNK_WORD_SIZE, 200);
  assert.equal(CHUNK_WORD_OVERLAP, 40);
  assert.equal(CHUNK_WORD_STEP, 160);
});

test("chunk i starts at word i * step, exactly as the chunker cuts it", () => {
  const text = syntheticPage(470);
  const chunks = chunkPageText(text);

  assert.equal(chunks.length, 3);
  chunks.forEach((chunk, index) => {
    assert.equal(chunk.split(" ")[0], `w${chunkStartWordIndex(index) + 1}`);
  });
});

test("stored chunks rebuild their page word for word", () => {
  const text = syntheticPage(470);

  assert.equal(
    reconstructPageWords(chunkPageText(text)).join(" "),
    normalizeChunkWords(text).join(" ")
  );
});

test("a one-word page and an empty page rebuild without loss", () => {
  assert.deepEqual(reconstructPageWords(chunkPageText("only")), ["only"]);
  assert.deepEqual(reconstructPageWords([]), []);
  assert.deepEqual(normalizeChunkWords(""), []);
  assert.deepEqual(normalizeChunkWords(undefined), []);
});
