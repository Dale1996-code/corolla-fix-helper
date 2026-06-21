import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

// Isolate the database/uploads to a scratch dir BEFORE importing anything that
// pulls in database.js (chunkRetrievalService -> database.js opens
// config.databaseFile at import time). A blank key proves the "rerank on but no
// key" path falls back to fusion order without ever calling a model.
const tempRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "corolla-fix-helper-rerank-retrieval-")
);
process.env.DATABASE_FILE = path.join(tempRoot, "rerank.db");
process.env.UPLOADS_DIR = path.join(tempRoot, "uploads");
process.env.OPENAI_API_KEY = "";

const { config } = await import("../src/config.js");
const { db } = await import("../src/database.js");
const { initializeDatabase } = await import("../src/initDatabase.js");
const {
  clearChunkEmbeddingCache,
  float32ArrayToBuffer,
} = await import("../src/services/chunkEmbeddingService.js");
const { retrieveRelevantChunks } = await import(
  "../src/services/chunkRetrievalService.js"
);
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

const zeroQueryEmbedding = async () =>
  new Float32Array(config.openAiEmbeddingDimensions);

let uniqueCounter = 0;

function nextTag() {
  uniqueCounter += 1;
  return `reranktag${uniqueCounter}`;
}

function insertDocument(title, originalFilename) {
  const vehicle = db.prepare("SELECT id FROM vehicles ORDER BY id ASC LIMIT 1").get();

  return Number(
    db
      .prepare(`
        INSERT INTO documents (
          vehicle_id, title, original_filename, stored_filename, file_path,
          file_type, system, document_type, extracted_text, extraction_status, page_count
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
        "Engine",
        "Repair Manual",
        "",
        "completed",
        null
      ).lastInsertRowid
  );
}

// Seed `pageCount` chunks that all match `tag` (so they all become candidates
// via keyword scoring) with zero embeddings (semantic score 0). Fusion then
// orders them by page ascending, which makes the reranker's effect observable.
function seedMatchingChunks(tag, pageCount) {
  const documentId = insertDocument(`Rerank corpus ${tag}`, `${tag}.pdf`);
  const pages = [];

  for (let page = 1; page <= pageCount; page += 1) {
    pages.push({ pageNumber: page, text: `${tag} specification detail for page ${page}.` });
  }

  rebuildDocumentChunksFromPages(documentId, pages);

  for (let page = 1; page <= pageCount; page += 1) {
    db.prepare(`
      UPDATE document_chunks
      SET embedding = ?, embedding_version = ?
      WHERE document_id = ? AND page_number = ? AND chunk_index = 0
    `).run(
      float32ArrayToBuffer(new Float32Array(config.openAiEmbeddingDimensions)),
      config.openAiEmbeddingVersion,
      documentId,
      page
    );
  }

  clearChunkEmbeddingCache();
  return documentId;
}

test("reranking disabled leaves the fusion order untouched and never calls the reranker", async () => {
  const tag = nextTag();
  seedMatchingChunks(tag, 5);

  let rerankCalls = 0;
  const baseline = await retrieveRelevantChunks(tag, {
    limit: 3,
    mode: "hybrid",
    createQueryEmbedding: zeroQueryEmbedding,
    rerankEnabled: false,
    rerank: async (question, pool) => {
      rerankCalls += 1;
      return pool;
    },
  });

  assert.equal(rerankCalls, 0);
  assert.equal(baseline.length, 3);
  // Fusion orders the equal-keyword chunks by page ascending.
  assert.deepEqual(
    baseline.map((chunk) => chunk.pageNumber),
    [1, 2, 3]
  );
});

test("reranking bounds the candidate pool by config before reordering", async () => {
  const tag = nextTag();
  seedMatchingChunks(tag, 12);

  let seenPoolSize = 0;
  const result = await retrieveRelevantChunks(tag, {
    limit: 3,
    mode: "hybrid",
    createQueryEmbedding: zeroQueryEmbedding,
    rerankEnabled: true,
    rerankCandidateLimit: 5,
    rerank: async (question, pool) => {
      seenPoolSize = pool.length;
      return pool;
    },
  });

  assert.equal(seenPoolSize, 5);
  assert.equal(result.length, 3);
});

test("reranking reorders the pool and still respects the requested limit", async () => {
  const tag = nextTag();
  seedMatchingChunks(tag, 6);

  const reranked = await retrieveRelevantChunks(tag, {
    limit: 2,
    mode: "hybrid",
    createQueryEmbedding: zeroQueryEmbedding,
    rerankEnabled: true,
    rerankCandidateLimit: 6,
    // Reverse the fusion order: the last fused candidate should win.
    rerank: async (question, pool) => [...pool].reverse(),
  });

  assert.equal(reranked.length, 2);
  // Fusion top was page 1; after reversing the 6-chunk pool the top is page 6.
  assert.equal(reranked[0].pageNumber, 6);
  assert.equal(reranked[1].pageNumber, 5);
});

test("reranking enabled with no API key falls back to the fusion order", async () => {
  const tag = nextTag();
  seedMatchingChunks(tag, 4);

  // No `rerank` injected -> the real rerankChunks runs. With OPENAI_API_KEY
  // blank it must return the pool unchanged, so the result equals fusion order.
  const result = await retrieveRelevantChunks(tag, {
    limit: 3,
    mode: "hybrid",
    createQueryEmbedding: zeroQueryEmbedding,
    rerankEnabled: true,
  });

  assert.equal(result.length, 3);
  assert.deepEqual(
    result.map((chunk) => chunk.pageNumber),
    [1, 2, 3]
  );
});
