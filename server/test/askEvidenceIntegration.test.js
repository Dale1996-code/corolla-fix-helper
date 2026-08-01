import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

// Isolate the database before importing anything that opens it.
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-fix-helper-evidence-"));
process.env.DATABASE_FILE = path.join(tempRoot, "evidence.db");
process.env.UPLOADS_DIR = path.join(tempRoot, "uploads");

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

const otherChunk = {
  ...oilChunk,
  documentId: 12,
  documentTitle: "Transmission Overhaul",
  originalFilename: "trans.pdf",
  pageNumber: 88,
  chunkIndex: 1,
  chunkText: "Tighten the transaxle case bolts to 37 Nm.",
};

function ask(evidencePayload, options = {}) {
  return askQuestionUsingDocuments("What is the oil drain plug torque?", {
    isAiConfigured: true,
    evidenceContract: true,
    retrieveChunks: async () => [oilChunk, otherChunk],
    generateEvidenceAnswer: async () => evidencePayload,
    ...options,
  });
}

const emptyPayload = { documentSupported: [], generalGuidance: [], gaps: [] };

test("a verified claim yields answered and cites ONLY the backing chunk", async () => {
  const result = await ask({
    ...emptyPayload,
    documentSupported: [
      {
        claim: "The oil drain plug torque is 37 Nm.",
        sourceId: "S1",
        evidenceQuote: "Torque : 37 Nm (377 kgf-cm, 27 ft-lbf)",
      },
    ],
  });

  assert.equal(result.status, "answered");
  // The fix for "every retrieved chunk becomes a citation": two chunks were
  // retrieved, only the one that actually backed a claim is cited.
  assert.equal(result.citations.length, 1);
  assert.equal(result.citations[0].documentTitle, "Oil and Oil Filter Replacement");
  assert.equal(result.evidence.documentSupported.length, 1);
  assert.match(result.answer, /37 Nm/);
});

test("a claim with a fabricated quote is not shown and the status is not_found", async () => {
  const result = await ask({
    ...emptyPayload,
    documentSupported: [
      {
        claim: "The oil drain plug torque is 54 Nm.",
        sourceId: "S1",
        evidenceQuote: "Torque the drain plug to fifty-four newton metres",
      },
    ],
  });

  assert.equal(result.status, "not_found");
  assert.equal(result.answer, NOT_FOUND_MESSAGE);
  assert.deepEqual(result.citations, []);
  assert.equal(result.evidence.documentSupported.length, 0);
  assert.match(result.evidence.gaps.join(" "), /Unverified/);
});

test("a real quote carrying an invented number is rejected as an anomaly", async () => {
  const result = await ask({
    ...emptyPayload,
    documentSupported: [
      {
        claim: "Torque the drain plug to 54 Nm.",
        sourceId: "S1",
        evidenceQuote: "Clean and install the oil drain plug with a new gasket.",
      },
    ],
  });

  assert.equal(result.status, "not_found");
  assert.match(result.evidence.gaps.join(" "), /Unverified specification/);
  // The invented value must not reappear anywhere the owner can read it,
  // including inside the gap that explains its removal.
  assert.doesNotMatch(result.evidence.gaps.join(" "), /54/);
  assert.doesNotMatch(result.answer, /54/);
});

test("a partially verified answer is reported as partial, not answered", async () => {
  const result = await ask({
    ...emptyPayload,
    documentSupported: [
      {
        claim: "The oil drain plug torque is 37 Nm.",
        sourceId: "S1",
        evidenceQuote: "Torque : 37 Nm",
      },
      {
        claim: "The filter torque is 25 Nm.",
        sourceId: "S1",
        evidenceQuote: "Torque the filter cap to 25 Nm",
      },
    ],
  });

  assert.equal(result.status, "partial");
  assert.equal(result.evidence.documentSupported.length, 1);
  assert.equal(result.evidence.gaps.length, 1);
});

test("an ungrounded spec in general guidance never renders", async () => {
  const result = await ask({
    ...emptyPayload,
    documentSupported: [
      {
        claim: "The oil drain plug torque is 37 Nm.",
        sourceId: "S1",
        evidenceQuote: "Torque : 37 Nm",
      },
    ],
    generalGuidance: ["Most filters torque to about 18 Nm."],
  });

  assert.ok(!result.answer.includes("18 Nm"), "an unsourced spec must not render");
  assert.deepEqual(result.evidence.generalGuidance, []);
  assert.match(result.evidence.gaps.join(" "), /Removed unsourced specification/);
});

test("safe general guidance is kept and clearly labeled", async () => {
  const result = await ask({
    ...emptyPayload,
    documentSupported: [
      {
        claim: "The oil drain plug torque is 37 Nm.",
        sourceId: "S1",
        evidenceQuote: "Torque : 37 Nm",
      },
    ],
    generalGuidance: ["Let the engine cool before draining the oil."],
  });

  assert.deepEqual(result.evidence.generalGuidance, [
    "Let the engine cool before draining the oil.",
  ]);
  assert.match(result.answer, /General guidance — not from your documents/);
});

test("the flag OFF path is unchanged and emits no evidence field", async () => {
  const result = await askQuestionUsingDocuments("What is the oil drain plug torque?", {
    isAiConfigured: true,
    // evidenceContract defaults to config (false)
    retrieveChunks: async () => [oilChunk, otherChunk],
    generateAnswerText: async () => "The oil drain plug torque is 37 Nm.",
    generateEvidenceAnswer: async () => {
      throw new Error("the evidence path must not run with the flag off");
    },
  });

  assert.equal(result.status, "answered");
  assert.ok(!("evidence" in result), "no evidence field with the flag off");
  // Legacy behavior: every retrieved chunk is cited.
  assert.equal(result.citations.length, 2);
});

test("retrievedContext still appears on an evidence-path not_found", async () => {
  const result = await ask(emptyPayload);

  assert.equal(result.status, "not_found");
  assert.deepEqual(result.citations, []);
  assert.equal(result.retrievedContext.length, 2);
});
