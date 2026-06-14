import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-fix-helper-embeddings-"));

process.env.DATABASE_FILE = path.join(tempRoot, "test.db");
process.env.UPLOADS_DIR = path.join(tempRoot, "uploads");
process.env.OPENAI_API_KEY = "test-key";

const { config } = await import("../src/config.js");
const { db } = await import("../src/database.js");
const { initializeDatabase } = await import("../src/initDatabase.js");
const {
  backfillChunkEmbeddings,
  clearChunkEmbeddingCache,
  float32ArrayToBuffer,
} = await import("../src/services/chunkEmbeddingService.js");
const {
  retrieveKeywordChunks,
  retrieveRelevantChunks,
} = await import("../src/services/chunkRetrievalService.js");
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

let uniqueCounter = 0;

function nextUniqueTag(prefix) {
  uniqueCounter += 1;
  return `${prefix}${uniqueCounter}emb`;
}

function insertFakeDocument({ title, originalFilename, system = "Engine" }) {
  const vehicle = db.prepare("SELECT id FROM vehicles ORDER BY id ASC LIMIT 1").get();

  assert.ok(vehicle);

  return Number(
    db
      .prepare(`
        INSERT INTO documents (
          vehicle_id,
          title,
          original_filename,
          stored_filename,
          file_path,
          file_type,
          system,
          document_type,
          extracted_text,
          extraction_status,
          page_count
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        vehicle.id,
        title,
        originalFilename,
        originalFilename,
        `server/uploads/${originalFilename}`,
        "application/pdf",
        system,
        "Repair Manual",
        "",
        "completed",
        null
      ).lastInsertRowid
  );
}

function makeVector(seedIndexes) {
  const vector = new Float32Array(config.openAiEmbeddingDimensions);

  for (const [index, value] of seedIndexes) {
    vector[index] = value;
  }

  return vector;
}

function storeEmbeddingForChunk({ documentId, pageNumber, chunkIndex, vector }) {
  db.prepare(`
    UPDATE document_chunks
    SET embedding = ?, embedding_version = ?
    WHERE document_id = ? AND page_number = ? AND chunk_index = ?
  `).run(
    float32ArrayToBuffer(vector),
    config.openAiEmbeddingVersion,
    documentId,
    pageNumber,
    chunkIndex
  );

  clearChunkEmbeddingCache();
}

test("database migration adds Float32 embedding storage to document_chunks", () => {
  const columns = db.prepare("PRAGMA table_info(document_chunks)").all();
  const columnMap = new Map(columns.map((column) => [column.name, column.type]));

  assert.equal(columnMap.get("embedding"), "BLOB");
  assert.equal(columnMap.get("embedding_version"), "TEXT");
  assert.equal(config.openAiEmbeddingDimensions, 512);
  assert.equal(
    config.openAiEmbeddingVersion,
    `${config.openAiEmbeddingModel}@${config.openAiEmbeddingDimensions}`
  );
});

test("embedding backfill stores Float32 blobs and skips current-version chunks", async () => {
  const uniqueTag = nextUniqueTag("backfill");

  // The seeded sample document ships with one un-embedded chunk; start from a
  // clean chunk table so the global backfill count reflects only this test's chunks.
  db.exec("DELETE FROM document_chunks");

  const documentId = insertFakeDocument({
    title: `Embedding backfill ${uniqueTag}`,
    originalFilename: `${uniqueTag}.pdf`,
  });

  rebuildDocumentChunksFromPages(documentId, [
    {
      pageNumber: 1,
      text: `${uniqueTag} oil drain plug tightening specification 27 ft-lb.`,
    },
    {
      pageNumber: 2,
      text: `${uniqueTag} spark plug gap specification 0.044 inch.`,
    },
  ]);

  let embeddedTexts = [];
  const firstSummary = await backfillChunkEmbeddings({
    createEmbeddings: async (texts) => {
      embeddedTexts = embeddedTexts.concat(texts);
      return texts.map((text, index) =>
        makeVector([
          [index, 1],
          [20, text.includes("spark") ? 1 : 0],
        ])
      );
    },
    batchSize: 1,
  });

  assert.equal(firstSummary.embeddedChunks, 2);
  assert.ok(firstSummary.skippedCurrentVersion >= 0);
  assert.equal(embeddedTexts.length, 2);

  const rows = db
    .prepare(`
      SELECT embedding, embedding_version
      FROM document_chunks
      WHERE document_id = ?
      ORDER BY page_number ASC
    `)
    .all(documentId);

  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.embedding_version, config.openAiEmbeddingVersion);
    assert.equal(row.embedding.length, config.openAiEmbeddingDimensions * 4);
  }

  embeddedTexts = [];
  const secondSummary = await backfillChunkEmbeddings({
    createEmbeddings: async (texts) => {
      embeddedTexts = embeddedTexts.concat(texts);
      return texts.map(() => makeVector([[30, 1]]));
    },
    batchSize: 1,
  });

  assert.equal(secondSummary.embeddedChunks, 0);
  assert.ok(secondSummary.skippedCurrentVersion >= 2);
  assert.equal(embeddedTexts.length, 0);
});

test("hybrid retrieval fixes a wrong keyword-only top page without ties", async () => {
  const uniqueTag = nextUniqueTag("hybrid");
  const documentId = insertFakeDocument({
    title: `Hybrid retrieval ${uniqueTag}`,
    originalFilename: `${uniqueTag}.pdf`,
  });

  rebuildDocumentChunksFromPages(documentId, [
    {
      pageNumber: 1,
      text: `${uniqueTag} oil drain plug torque torque torque reminder says inspect the old washer only.`,
    },
    {
      pageNumber: 2,
      text: `${uniqueTag} drain plug tightening specification is 27 ft-lb with a new gasket.`,
    },
  ]);

  const decoyVector = makeVector([[8, 1]]);
  const correctVector = makeVector([[7, 1]]);
  const queryVector = makeVector([[7, 1]]);

  storeEmbeddingForChunk({
    documentId,
    pageNumber: 1,
    chunkIndex: 0,
    vector: decoyVector,
  });
  storeEmbeddingForChunk({
    documentId,
    pageNumber: 2,
    chunkIndex: 0,
    vector: correctVector,
  });

  const keywordResults = retrieveKeywordChunks(`${uniqueTag} oil drain plug torque`);
  const hybridResults = await retrieveRelevantChunks(`${uniqueTag} oil drain plug torque`, {
    createQueryEmbedding: async () => queryVector,
  });

  assert.equal(keywordResults[0].pageNumber, 1);
  assert.equal(hybridResults[0].pageNumber, 2);
  assert.ok(hybridResults[0].hybridScore > hybridResults[1].hybridScore);
  assert.notEqual(hybridResults[0].hybridScore, hybridResults[1].hybridScore);
});

test("hybrid retrieval ignores stale embedding versions", async () => {
  const uniqueTag = nextUniqueTag("stale");
  const documentId = insertFakeDocument({
    title: `Stale embedding ${uniqueTag}`,
    originalFilename: `${uniqueTag}.pdf`,
  });

  rebuildDocumentChunksFromPages(documentId, [
    {
      pageNumber: 4,
      text: `${uniqueTag} coolant bleeding page with useful repair wording.`,
    },
  ]);

  db.prepare(`
    UPDATE document_chunks
    SET embedding = ?, embedding_version = ?
    WHERE document_id = ? AND page_number = ? AND chunk_index = ?
  `).run(
    float32ArrayToBuffer(makeVector([[9, 1]])),
    "old-model@512",
    documentId,
    4,
    0
  );
  clearChunkEmbeddingCache();

  const hybridResults = await retrieveRelevantChunks(`${uniqueTag} coolant bleeding`, {
    createQueryEmbedding: async () => makeVector([[9, 1]]),
  });

  assert.equal(hybridResults.some((result) => result.documentId === documentId), false);
});
