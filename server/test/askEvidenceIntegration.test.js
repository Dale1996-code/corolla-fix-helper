import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

// Isolate the database before importing anything that opens it.
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-fix-helper-evidence-"));
process.env.DATABASE_FILE = path.join(tempRoot, "evidence.db");
process.env.UPLOADS_DIR = path.join(tempRoot, "uploads");
// Pin the AI feature flags too. config.js calls dotenv.config() at import,
// so without this a developer's local server/.env leaks into the suite --
// setting ASK_EVIDENCE_CONTRACT=true there made these tests take the
// evidence path and attempt REAL API calls. Cases that want the contract
// enable it explicitly via the evidenceContract option.
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
const oilTorqueQuote = oilChunk.chunkText;

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
        evidenceQuote: oilTorqueQuote,
      },
    ],
  });

  assert.equal(result.status, "answered");
  // The fix for "every retrieved chunk becomes a citation": two chunks were
  // retrieved, only the one that actually backed a claim is cited.
  assert.equal(result.citations.length, 1);
  assert.equal(result.citations[0].documentTitle, "Oil and Oil Filter Replacement");
  assert.equal(result.evidence.documentSupported.length, 1);
  assert.match(result.evidence.documentSupported[0].evidenceId, /^ask_ev_v1_[a-f0-9]{24}$/);
  assert.equal(
    result.citations[0].evidenceId,
    result.evidence.documentSupported[0].evidenceId
  );
  assert.match(result.answer, /37 Nm/);
});

test("evidence identifiers are stable for the same source passage", async () => {
  const evidencePayload = {
    ...emptyPayload,
    documentSupported: [
      {
        claim: "The oil drain plug torque is 37 Nm.",
        sourceId: "S1",
        evidenceQuote: oilTorqueQuote,
      },
    ],
  };

  const first = await ask(evidencePayload);
  const second = await ask(evidencePayload);

  assert.equal(
    first.evidence.documentSupported[0].evidenceId,
    second.evidence.documentSupported[0].evidenceId
  );
});

test("duplicate copies of one backing chunk produce one citation", async () => {
  const result = await ask(
    {
      ...emptyPayload,
      documentSupported: [
        {
          claim: "The oil drain plug torque is 37 Nm.",
          sourceId: "S1",
          evidenceQuote: oilTorqueQuote,
        },
      ],
    },
    {
      retrieveChunks: async () => [
        { ...oilChunk, chunkId: 101 },
        { ...oilChunk, chunkId: 101 },
      ],
    }
  );

  assert.equal(result.status, "answered");
  assert.equal(result.citations.length, 1);
  assert.equal(result.evidence.documentSupported.length, 1);
  assert.equal(
    result.citations[0].evidenceId,
    result.evidence.documentSupported[0].evidenceId
  );
});

test("two distinct claims from one chunk keep one evidence citation per quote", async () => {
  const result = await ask(
    {
      ...emptyPayload,
      documentSupported: [
        {
          claim: "Install the oil drain plug with a new gasket.",
          sourceId: "S1",
          evidenceQuote: "Clean and install the oil drain plug with a new gasket.",
        },
        {
          claim: "The oil drain plug torque is 37 Nm.",
          sourceId: "S1",
          evidenceQuote: oilTorqueQuote,
        },
      ],
    },
    {
      retrieveChunks: async () => [oilChunk],
    }
  );

  assert.equal(result.status, "answered");
  assert.equal(result.evidence.documentSupported.length, 2);
  assert.notEqual(
    result.evidence.documentSupported[0].evidenceId,
    result.evidence.documentSupported[1].evidenceId
  );
  assert.deepEqual(
    result.citations.map((citation) => citation.snippet),
    [
      "Clean and install the oil drain plug with a new gasket.",
      oilTorqueQuote,
    ]
  );
});

test("an evidence citation snippet is the verified quote, not an unused chunk prefix", async () => {
  const usedQuote = oilTorqueQuote;
  const unrelatedPrefix = "Unrelated maintenance note. ".repeat(12);
  const result = await ask(
    {
      ...emptyPayload,
      documentSupported: [
        {
          claim: "The oil drain plug torque is 37 Nm.",
          sourceId: "S1",
          evidenceQuote: usedQuote,
        },
      ],
    },
    {
      retrieveChunks: async () => [
        {
          ...oilChunk,
          chunkText: unrelatedPrefix + usedQuote,
        },
      ],
    }
  );

  assert.equal(result.status, "answered");
  assert.equal(result.citations.length, 1);
  assert.equal(result.citations[0].snippet, usedQuote);
});

test("a long evidence citation carries the full verified quote behind its preview", async () => {
  const longQuote =
    "Inspect the drain plug threads, sealing surface, surrounding oil pan area, and gasket seating position before installation; clean away residue and confirm that no damaged material remains before continuing with the repair procedure.";
  const result = await ask(
    {
      ...emptyPayload,
      documentSupported: [
        {
          claim: "Inspect and clean the drain plug area before continuing.",
          sourceId: "S1",
          evidenceQuote: longQuote,
        },
      ],
    },
    {
      retrieveChunks: async () => [
        {
          ...oilChunk,
          chunkText: longQuote,
        },
      ],
    }
  );

  assert.equal(result.status, "answered");
  assert.equal(result.citations[0].evidenceQuote, longQuote);
  assert.match(result.citations[0].snippet, /\.\.\.$/);
});

test("a text passage with no valid document id cannot become a document-backed answer", async () => {
  let modelCalls = 0;
  const result = await ask(
    {
      ...emptyPayload,
      documentSupported: [
        {
          claim: "The oil drain plug torque is 37 Nm.",
          sourceId: "S1",
          evidenceQuote: oilTorqueQuote,
        },
      ],
    },
    {
      retrieveChunks: async () => [
        {
          ...oilChunk,
          documentId: undefined,
        },
      ],
      generateEvidenceAnswer: async () => {
        modelCalls += 1;
        return emptyPayload;
      },
    }
  );

  assert.equal(result.status, "not_found");
  assert.deepEqual(result.citations, []);
  assert.equal(modelCalls, 0);
});

test("boolean source identifiers cannot become document-backed citations", async () => {
  let modelCalls = 0;
  const result = await ask(emptyPayload, {
    retrieveChunks: async () => [
      {
        ...oilChunk,
        documentId: true,
        pageNumber: true,
        chunkIndex: false,
      },
    ],
    generateEvidenceAnswer: async () => {
      modelCalls += 1;
      return emptyPayload;
    },
  });

  assert.equal(result.status, "not_found");
  assert.deepEqual(result.citations, []);
  assert.equal(modelCalls, 0);
});

test("invalid retrieval rows are removed before the model receives source labels", async () => {
  let chunksGivenToModel = [];
  const evidencePayload = {
    ...emptyPayload,
    documentSupported: [
      {
        claim: "The oil drain plug torque is 37 Nm.",
        sourceId: "S1",
        evidenceQuote: oilTorqueQuote,
      },
    ],
  };

  const result = await ask(evidencePayload, {
    retrieveChunks: async () => [
      oilChunk,
      {
        ...otherChunk,
        documentId: undefined,
      },
    ],
    generateEvidenceAnswer: async ({ chunks }) => {
      chunksGivenToModel = chunks;
      return evidencePayload;
    },
  });

  assert.equal(result.status, "answered");
  assert.equal(chunksGivenToModel.length, 1);
  assert.equal(chunksGivenToModel[0].documentTitle, "Oil and Oil Filter Replacement");
  assert.equal(result.citations.length, 1);
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
        evidenceQuote: oilTorqueQuote,
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
        evidenceQuote: oilTorqueQuote,
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
        evidenceQuote: oilTorqueQuote,
      },
    ],
    generalGuidance: ["Let the engine cool before draining the oil."],
  });

  assert.deepEqual(result.evidence.generalGuidance, [
    "Let the engine cool before draining the oil.",
  ]);
  assert.match(result.answer, /General guidance — not from your documents/);
});

test("the flag OFF service path remains available and emits no evidence field", async () => {
  const result = await askQuestionUsingDocuments("What is the oil drain plug torque?", {
    isAiConfigured: true,
    // This test process pins the compatibility flag false above.
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
