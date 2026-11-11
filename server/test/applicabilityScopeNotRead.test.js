import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

// N5 P2 stores each chunk's applicability scope but must change NOTHING anyone
// sees: Ask, the planner, and retrieval behave exactly as before until a later
// phase enforces scope on purpose. applicabilityNotEnforced.test.js checks the
// source text; this is the runtime half. It runs the real retrieval, the
// planner's search tool, and the Ask core (with only the model call faked)
// three times -- with the scopes the rebuild stored, with every chunk claiming
// another engine under an unknown tagger version, and with the columns empty --
// and requires identical output, including exactly what the model is shown.

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-fix-helper-scope-not-read-"));
process.env.DATABASE_FILE = path.join(tempRoot, "scope-not-read.db");
process.env.UPLOADS_DIR = path.join(tempRoot, "uploads");

const { db } = await import("../src/database.js");
const { initializeDatabase } = await import("../src/initDatabase.js");
const { config } = await import("../src/config.js");
const { rebuildDocumentChunksFromPages } = await import("../src/services/documentChunkService.js");
const { clearChunkEmbeddingCache, float32ArrayToBuffer, loadChunkEmbeddingCache } = await import(
  "../src/services/chunkEmbeddingService.js"
);
const { clearDocumentContentIdentityCache } = await import("../src/services/documentContentIdentity.js");
const { retrieveKeywordChunks, retrieveRelevantChunks } = await import(
  "../src/services/chunkRetrievalService.js"
);
const { searchRepairDocs } = await import("../src/services/agent/repairTools.js");
const { askQuestionUsingDocuments } = await import("../src/services/aiAnswerService.js");

initializeDatabase();

after(() => {
  if (typeof db.close === "function") {
    db.close();
  }

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function seedDocument(title) {
  const vehicleId = db.prepare("SELECT id FROM vehicles LIMIT 1").get()?.id;
  const info = db
    .prepare(
      `INSERT INTO documents (vehicle_id, title, original_filename, stored_filename, system, document_type)
       VALUES (?, ?, ?, ?, 'Engine', 'Repair Manual')`
    )
    .run(vehicleId, title, `${title}.pdf`, `${title}-stored.pdf`);
  return Number(info.lastInsertRowid);
}

function vector(seed) {
  return Array.from({ length: config.openAiEmbeddingDimensions }, (_, index) => ((seed * 31 + index * 7) % 13) / 13 - 0.4);
}

// Synthetic manual-style text (the repo is public; no real manual text).
const engineArticle = seedDocument("Oil Replacement 2AZ-FE");
rebuildDocumentChunksFromPages(engineArticle, [
  { pageNumber: 1, text: "Vehicle > Engine > Oil > Replacement (2AZ-FE) NOTICE: Oil drain plug torque 37 N*m" },
  { pageNumber: 2, text: "COMPRESSOR (for 2ZR-FE) Bolt 25 N*m. Replace the oil drain plug gasket." },
]);
const sharedProcedure = seedDocument("Oil Drain Plug");
rebuildDocumentChunksFromPages(sharedProcedure, [
  { pageNumber: 1, text: "Install the oil drain plug with a new gasket. Oil drain plug torque 37 N*m" },
]);
for (const { id } of db.prepare("SELECT id FROM document_chunks").all()) {
  db.prepare("UPDATE document_chunks SET embedding = ?, embedding_version = ? WHERE id = ?").run(
    float32ArrayToBuffer(vector(Number(id))),
    config.openAiEmbeddingVersion,
    id
  );
}

const QUESTION = "oil drain plug torque";
const createQueryEmbedding = async () => vector(5);
const retrieve = (question, options = {}) => retrieveRelevantChunks(question, { ...options, createQueryEmbedding });

async function observeEverything() {
  // A cache filled under one state must not hide a read under the next.
  clearChunkEmbeddingCache();
  clearDocumentContentIdentityCache();

  let shownToModel = null;
  const ask = await askQuestionUsingDocuments("What is the oil drain plug torque?", {
    isAiConfigured: true,
    evidenceContract: true,
    includeMetrics: false,
    retrieveChunks: retrieve,
    isSourceAvailable: () => true,
    generateEvidenceAnswer: async ({ chunks }) => {
      shownToModel = chunks;
      // An honest fake model: it cites the source (S1, S2, ... in the order it
      // was shown) that really prints its quote.
      const quote = "Oil drain plug torque 37 N*m";
      const sourceId = `S${chunks.findIndex((chunk) => String(chunk.chunkText).includes(quote)) + 1}`;
      return {
        documentSupported: [{ claim: "The oil drain plug torque is 37 N*m.", sourceId, evidenceQuote: quote }],
        generalGuidance: [],
        gaps: [],
      };
    },
  });

  return JSON.parse(
    JSON.stringify({
      keyword: retrieveKeywordChunks(QUESTION),
      hybrid: await retrieve(QUESTION),
      planner: await searchRepairDocs({ query: QUESTION, taskId: "task-1" }, { retrieve }),
      ask,
      shownToModel,
    })
  );
}

test("Ask, the planner, and retrieval ignore whatever the scope columns hold", async () => {
  // Preconditions: the rebuild stored real scopes, the semantic path runs, and
  // the Ask call goes all the way to a verified answer.
  const scoped = db
    .prepare("SELECT COUNT(*) AS c FROM document_chunks WHERE scope_at_start LIKE '%2AZ-FE%'")
    .get().c;
  assert.ok(scoped > 0, "precondition: some chunk is stored inside a 2AZ-FE scope");
  assert.ok(loadChunkEmbeddingCache().length > 0, "precondition: the semantic path has embeddings");

  const withStoredScopes = await observeEverything();
  assert.equal(withStoredScopes.ask.status, "answered", "precondition: Ask reaches a verified answer");
  assert.ok(withStoredScopes.keyword.length > 0 && withStoredScopes.hybrid.length > 0);
  assert.ok(withStoredScopes.planner.citations.length > 0 && withStoredScopes.shownToModel.length > 0);
  assert.deepEqual(await observeEverything(), withStoredScopes, "precondition: the observation is repeatable");

  db.prepare("UPDATE document_chunks SET scope_at_start = ?, scope_version = 'scope-v999'").run(
    JSON.stringify({
      engine: { value: "2AZ-FE", exclude: false, kind: "inline_for" },
      plant: { unresolved: true, kind: "legend" },
    })
  );
  assert.deepEqual(await observeEverything(), withStoredScopes, "every chunk claiming another engine changed something");

  db.prepare("UPDATE document_chunks SET scope_at_start = NULL, scope_version = NULL").run();
  assert.deepEqual(await observeEverything(), withStoredScopes, "empty scope columns changed something");
});
