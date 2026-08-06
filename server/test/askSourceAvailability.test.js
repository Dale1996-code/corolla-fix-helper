import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

// Isolate the database/uploads before importing anything that opens them.
const tempRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "corolla-fix-helper-source-availability-")
);
process.env.DATABASE_FILE = path.join(tempRoot, "source-availability.db");
process.env.UPLOADS_DIR = path.join(tempRoot, "uploads");
// Cases that want the evidence contract turn it on explicitly, so a developer's
// local .env cannot push the default path into a real API call.
process.env.ASK_EVIDENCE_CONTRACT = "false";

const { db } = await import("../src/database.js");
const { askQuestionUsingDocuments, NOT_FOUND_MESSAGE } = await import(
  "../src/services/aiAnswerService.js"
);

after(() => {
  if (typeof db.close === "function") {
    db.close();
  }

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

// A source card can only offer "open this document" if the server says the
// stored PDF is really there. These tests pin that flag onto every channel the
// UI renders as a source: citations, evidence citations, and retrieved context.

const oilChunk = {
  documentId: 7,
  documentTitle: "Oil and Oil Filter Replacement",
  originalFilename: "oil.pdf",
  pageNumber: 1,
  chunkIndex: 0,
  chunkText:
    "Clean and install the oil drain plug with a new gasket. Torque : 37 Nm (377 kgf-cm, 27 ft-lbf)",
  retrievalMode: "hybrid",
  semanticScore: 0.9,
  totalQueryTerms: 4,
  chunkMatchedTerms: 4,
};

function ask(options = {}) {
  return askQuestionUsingDocuments("What is the oil drain plug torque?", {
    isAiConfigured: true,
    retrieveChunks: async () => [oilChunk],
    generateAnswerText: async () => "The oil drain plug torque is 37 Nm. [Oil, page 1]",
    ...options,
  });
}

test("citations report an available source document", async () => {
  const result = await ask({ isSourceAvailable: () => true });

  assert.equal(result.status, "answered");
  assert.equal(result.citations.length, 1);
  assert.equal(result.citations[0].documentAvailable, true);
});

test("citations report a source whose stored PDF is gone", async () => {
  const result = await ask({ isSourceAvailable: () => false });

  assert.equal(result.status, "answered");
  assert.equal(result.citations.length, 1);
  // The citation is still shown -- retrieval really did find this passage --
  // but the client now knows not to offer an open action for it.
  assert.equal(result.citations[0].documentAvailable, false);
});

test("retrieved context on a not-found answer carries the same verdict", async () => {
  const result = await ask({
    generateAnswerText: async () => NOT_FOUND_MESSAGE,
    isSourceAvailable: () => false,
  });

  assert.equal(result.status, "not_found");
  assert.deepEqual(result.citations, []);
  assert.equal(result.retrievedContext.length, 1);
  assert.equal(result.retrievedContext[0].documentAvailable, false);
});

test("evidence-contract citations carry the verdict too", async () => {
  const result = await ask({
    evidenceContract: true,
    generateEvidenceAnswer: async () => ({
      documentSupported: [
        {
          claim: "The oil drain plug torque is 37 Nm.",
          sourceId: "S1",
          evidenceQuote: oilChunk.chunkText,
        },
      ],
      generalGuidance: [],
      gaps: [],
    }),
    isSourceAvailable: () => true,
  });

  assert.equal(result.status, "answered");
  assert.equal(result.citations.length, 1);
  assert.equal(result.citations[0].documentAvailable, true);
});

test("the availability lookup runs once per document, not once per passage", async () => {
  const lookups = [];
  const result = await ask({
    retrieveChunks: async () => [
      oilChunk,
      { ...oilChunk, pageNumber: 2, chunkIndex: 1, chunkText: "Refill with 4.2 liters of oil." },
      { ...oilChunk, documentId: 12, documentTitle: "Transmission", originalFilename: "t.pdf" },
    ],
    isSourceAvailable: (documentId) => {
      lookups.push(documentId);
      return true;
    },
  });

  assert.equal(result.citations.length, 3);
  // Three passages, two documents: the database/filesystem check is memoized.
  assert.deepEqual(lookups, [7, 12]);
});
