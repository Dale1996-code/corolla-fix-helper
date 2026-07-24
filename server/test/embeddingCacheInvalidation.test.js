import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const tempRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "corolla-fix-helper-cache-invalidation-")
);

process.env.DATABASE_FILE = path.join(tempRoot, "test.db");
process.env.UPLOADS_DIR = path.join(tempRoot, "uploads");
process.env.OPENAI_API_KEY = "test-key";

const { config } = await import("../src/config.js");
const { db } = await import("../src/database.js");
const { initializeDatabase } = await import("../src/initDatabase.js");
const { clearChunkEmbeddingCache, float32ArrayToBuffer } = await import(
  "../src/services/chunkEmbeddingService.js"
);
const { retrieveRelevantChunks } = await import(
  "../src/services/chunkRetrievalService.js"
);
const { rebuildDocumentChunksFromPages } = await import(
  "../src/services/documentChunkService.js"
);
const { deleteDocument, updateDocumentMetadata, getDocumentFileLocation } =
  await import("../src/services/documentService.js");

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
  return `${prefix}${uniqueCounter}inval`;
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

test("deleting a document evicts its chunks from a warm embedding cache", async () => {
  const uniqueTag = nextUniqueTag("delete");
  const documentId = insertFakeDocument({
    title: `Cache delete ${uniqueTag}`,
    originalFilename: `${uniqueTag}.pdf`,
  });

  rebuildDocumentChunksFromPages(documentId, [
    {
      pageNumber: 1,
      text: `${uniqueTag} brake caliper bleeding torque specification useful wording.`,
    },
  ]);

  const chunkVector = makeVector([[5, 1]]);
  storeEmbeddingForChunk({ documentId, pageNumber: 1, chunkIndex: 0, vector: chunkVector });

  // Warm the cache: this retrieval loads and caches the chunk embeddings.
  const warmResults = await retrieveRelevantChunks(`${uniqueTag} brake caliper bleeding`, {
    createQueryEmbedding: async () => makeVector([[5, 1]]),
  });
  assert.equal(
    warmResults.some((result) => result.documentId === documentId),
    true,
    "chunk should be retrievable before deletion"
  );

  // Delete through the service the delete route uses.
  const record = getDocumentFileLocation(documentId);
  await deleteDocument(record);

  const afterDelete = await retrieveRelevantChunks(`${uniqueTag} brake caliper bleeding`, {
    createQueryEmbedding: async () => makeVector([[5, 1]]),
  });

  assert.equal(
    afterDelete.some((result) => result.documentId === documentId),
    false,
    "deleted document's chunks must not be retrievable from the warm cache"
  );
});

test("updating document metadata refreshes the warm embedding cache", async () => {
  const uniqueTag = nextUniqueTag("update");
  const documentId = insertFakeDocument({
    title: `Original title ${uniqueTag}`,
    originalFilename: `${uniqueTag}.pdf`,
    system: "Engine",
  });

  rebuildDocumentChunksFromPages(documentId, [
    {
      pageNumber: 1,
      text: `${uniqueTag} coolant thermostat replacement specification useful wording.`,
    },
  ]);

  const chunkVector = makeVector([[6, 1]]);
  storeEmbeddingForChunk({ documentId, pageNumber: 1, chunkIndex: 0, vector: chunkVector });

  // Warm the cache with the original title/system.
  await retrieveRelevantChunks(`${uniqueTag} coolant thermostat`, {
    createQueryEmbedding: async () => makeVector([[6, 1]]),
  });

  updateDocumentMetadata(documentId, {
    title: `Updated title ${uniqueTag}`,
    system: "Cooling",
    subsystem: "",
    documentType: "Repair Manual",
    source: "",
    notes: "",
    isFavorite: false,
    isBookmarked: false,
  });

  const afterUpdate = await retrieveRelevantChunks(`${uniqueTag} coolant thermostat`, {
    createQueryEmbedding: async () => makeVector([[6, 1]]),
  });

  const hit = afterUpdate.find((result) => result.documentId === documentId);
  assert.ok(hit, "updated document should still be retrievable");
  assert.equal(
    hit.documentTitle,
    `Updated title ${uniqueTag}`,
    "retrieval must reflect the updated title, not the stale cached one"
  );
});
