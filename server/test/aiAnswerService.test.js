import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, afterEach } from "node:test";

// Isolate the database/uploads to a scratch dir BEFORE importing the service.
// aiAnswerService -> chunkRetrievalService -> database.js opens
// config.databaseFile at import time; without this override it would open the
// shared on-disk dev DB and race other parallel test processes on the WAL
// pragma ("database is locked").
const tempRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "corolla-fix-helper-ai-answer-")
);
process.env.DATABASE_FILE = path.join(tempRoot, "ai-answer.db");
process.env.UPLOADS_DIR = path.join(tempRoot, "uploads");
// Pin the AI feature flags too. config.js calls dotenv.config() at import,
// so without this a developer's local server/.env leaks into the suite --
// setting ASK_EVIDENCE_CONTRACT=true there made these tests take the
// evidence path and attempt REAL API calls. Cases that want the contract
// enable it explicitly via the evidenceContract option.
process.env.ASK_EVIDENCE_CONTRACT = "false";


// Distinct answer/vision models let the model-selection assertions tell the two
// requests apart (when OPENAI_VISION_MODEL is unset they would be identical).
process.env.OPENAI_API_KEY = "test-key";
process.env.OPENAI_ANSWER_MODEL = "answer-model-test";
process.env.OPENAI_VISION_MODEL = "vision-model-test";

const { db } = await import("../src/database.js");
const {
  askQuestionUsingDocuments,
  buildAskMetrics,
  buildRejectedMetrics,
  generateAnswerTextFromOpenAi,
  NOT_FOUND_MESSAGE,
  rewriteQuestionFromOpenAi,
} = await import("../src/services/aiAnswerService.js");

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

after(() => {
  if (typeof db.close === "function") {
    db.close();
  }

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function stubFetch(outputText = "The oil drain plug torque is 27 ft-lb.") {
  const calls = [];
  // Cast through any: this stub only needs the ok/json shape the service reads.
  globalThis.fetch = /** @type {any} */ (
    async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      // status: "completed" is required by the fail-closed parser -- a real
      // Responses API payload always carries it, and a double that omits it is
      // simply unrealistic. The parser is not relaxed to accommodate mocks.
      return {
        ok: true,
        json: async () => ({ status: "completed", output_text: outputText }),
      };
    }
  );
  return calls;
}

const sampleChunk = {
  documentId: 7,
  documentTitle: "Engine Manual",
  originalFilename: "engine-manual.pdf",
  pageNumber: 3,
  chunkIndex: 0,
  chunkText: "Oil drain plug torque is 27 ft-lb.",
};

function strongChunk(overrides = {}) {
  return {
    ...sampleChunk,
    retrievalMode: "hybrid",
    semanticScore: 0.9,
    totalQueryTerms: 4,
    chunkMatchedTerms: 4,
    ...overrides,
  };
}

const dataUri = "data:image/png;base64,QUJD";

test("no-image answer sends plain-string Responses input and uses the answer model", async () => {
  const calls = stubFetch();

  await generateAnswerTextFromOpenAi({
    question: "What is the oil drain plug torque?",
    chunks: [sampleChunk],
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.model, "answer-model-test");
  assert.equal(typeof calls[0].body.input, "string");
  assert.ok(calls[0].body.input.includes("Oil drain plug torque is 27 ft-lb."));
});

test("answer prompt asks for beginner-safe document-grounded structure", async () => {
  const calls = stubFetch();

  await generateAnswerTextFromOpenAi({
    question: "What should I check for a P0301 cylinder 1 misfire?",
    chunks: [sampleChunk],
  });

  const prompt = calls[0].body.input;

  assert.ok(prompt.includes("Write for a beginner DIY mechanic"));
  assert.ok(
    prompt.includes(
      "Clearly separate document-supported facts from general safety reminders"
    )
  );
  assert.ok(
    prompt.includes(
      "If a safety reminder is not stated in the chunks, label it as general safety guidance"
    )
  );
});

test("image answer sends structured Responses input and uses the vision model", async () => {
  const calls = stubFetch();

  await generateAnswerTextFromOpenAi({
    question: "What is the oil drain plug torque?",
    chunks: [sampleChunk],
    image: dataUri,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.model, "vision-model-test");
  assert.ok(Array.isArray(calls[0].body.input));

  const message = calls[0].body.input[0];
  assert.equal(message.role, "user");

  const textPart = message.content.find((part) => part.type === "input_text");
  const imagePart = message.content.find((part) => part.type === "input_image");
  assert.ok(textPart && typeof textPart.text === "string");
  assert.equal(imagePart.image_url, dataUri);
});

test("askQuestionUsingDocuments forwards the image data URI to answer generation", async () => {
  let seenImage = "unset";

  await askQuestionUsingDocuments("What is the oil drain plug torque?", {
    isAiConfigured: true,
    image: dataUri,
    retrieveChunks: async () => [strongChunk()],
    generateAnswerText: async ({ image }) => {
      seenImage = image;
      return "The oil drain plug torque is 27 ft-lb.";
    },
  });

  assert.equal(seenImage, dataUri);
});

test("an unsupported answer still returns the not-found message", async () => {
  let modelCalls = 0;

  const result = await askQuestionUsingDocuments("water pump torque", {
    isAiConfigured: true,
    retrieveChunks: async () => [strongChunk()],
    generateAnswerText: async () => {
      modelCalls += 1;
      return NOT_FOUND_MESSAGE;
    },
  });

  assert.equal(modelCalls, 1);
  assert.equal(result.status, "not_found");
  assert.equal(result.answer, NOT_FOUND_MESSAGE);
  assert.deepEqual(result.citations, []);
});

test("an attached image does not bypass the not-found gate when no chunks match", async () => {
  let modelCalls = 0;

  const result = await askQuestionUsingDocuments("anything the documents never mention", {
    isAiConfigured: true,
    image: dataUri,
    retrieveChunks: async () => [],
    generateAnswerText: async () => {
      modelCalls += 1;
      return "An invented answer derived from the photo.";
    },
  });

  assert.equal(modelCalls, 0);
  assert.equal(result.status, "not_found");
  assert.equal(result.answer, NOT_FOUND_MESSAGE);
});

test("buildAskMetrics reports sizes and timings without leaking document text", () => {
  const chunks = [
    {
      documentId: 7,
      documentTitle: "Secret Engine Manual Title",
      originalFilename: "confidential-engine-manual.pdf",
      pageNumber: 3,
      chunkIndex: 0,
      chunkText: "Oil drain plug torque is 27 ft-lb per the shop manual.",
      semanticScore: 0.83,
      retrievalMode: "hybrid",
    },
  ];

  const metrics = buildAskMetrics({
    chunks,
    citations: [{ snippet: "Oil drain plug torque is 27 ft-lb per the shop manual." }],
    retrievalMs: 12.6,
    rewriteMs: 0,
    answerMs: 40.2,
    totalMs: 55.9,
  });

  assert.equal(metrics.chunkCount, 1);
  assert.equal(metrics.citationCount, 1);
  assert.equal(metrics.contextChars, chunks[0].chunkText.length);
  assert.equal(metrics.approxContextTokens, Math.ceil(chunks[0].chunkText.length / 4));
  assert.equal(typeof metrics.retrievalMs, "number");
  assert.equal(typeof metrics.answerMs, "number");
  assert.equal(typeof metrics.totalMs, "number");
  assert.equal(metrics.retrievalMode, "hybrid");
  assert.equal(metrics.topSemanticScore, 0.83);
  assert.deepEqual(metrics.chunkRefs, [{ documentId: 7, pageNumber: 3, chunkIndex: 0 }]);

  // The whole point: metrics must be safe to log. No chunk text, document title,
  // filename, or citation snippet may appear anywhere in the serialized object.
  const serialized = JSON.stringify(metrics);
  assert.ok(!serialized.includes("Oil drain plug torque"), "leaked chunk text");
  assert.ok(!serialized.includes("Secret Engine Manual Title"), "leaked document title");
  assert.ok(!serialized.includes("confidential-engine-manual.pdf"), "leaked filename");
});

test("askQuestionUsingDocuments attaches metrics when includeMetrics is on", async () => {
  const result = await askQuestionUsingDocuments("What is the oil drain plug torque?", {
    isAiConfigured: true,
    includeMetrics: true,
    retrieveChunks: async () => [strongChunk(), strongChunk({ chunkIndex: 1 })],
    generateAnswerText: async () => "The oil drain plug torque is 27 ft-lb.",
  });

  assert.equal(result.status, "answered");
  assert.ok(result.metrics, "expected metrics on the result");
  assert.equal(result.metrics.chunkCount, 2);
  assert.equal(result.metrics.citationCount, 2);
  assert.equal(typeof result.metrics.retrievalMs, "number");
  assert.equal(typeof result.metrics.answerMs, "number");
  assert.equal(typeof result.metrics.totalMs, "number");
});

test("askQuestionUsingDocuments omits metrics by default (response shape unchanged)", async () => {
  const result = await askQuestionUsingDocuments("What is the oil drain plug torque?", {
    isAiConfigured: true,
    retrieveChunks: async () => [strongChunk()],
    generateAnswerText: async () => "The oil drain plug torque is 27 ft-lb.",
  });

  assert.equal(result.status, "answered");
  assert.ok(!("metrics" in result), "metrics must be absent unless the dev flag is on");
});

test("an attached image cannot turn an unsupported answer into a claim", async () => {
  const result = await askQuestionUsingDocuments("water pump torque", {
    isAiConfigured: true,
    image: dataUri,
    retrieveChunks: async () => [strongChunk()],
    generateAnswerText: async () => NOT_FOUND_MESSAGE,
  });

  assert.equal(result.status, "not_found");
  assert.equal(result.answer, NOT_FOUND_MESSAGE);
  assert.deepEqual(result.citations, []);
});

// ---- Determinism: every model call pins temperature: 0 ----

test("the answer request pins temperature: 0", async () => {
  const calls = stubFetch();

  await generateAnswerTextFromOpenAi({
    question: "What is the oil drain plug torque?",
    chunks: [sampleChunk],
  });

  assert.equal(calls[0].body.temperature, 0);
});

test("the vision answer request also pins temperature: 0", async () => {
  const calls = stubFetch();

  await generateAnswerTextFromOpenAi({
    question: "What is this part?",
    chunks: [sampleChunk],
    image: dataUri,
  });

  assert.equal(calls[0].body.model, "vision-model-test");
  assert.equal(calls[0].body.temperature, 0);
});

test("the question-rewrite request pins temperature: 0", async () => {
  const calls = stubFetch("What is the rear brake caliper torque?");

  await rewriteQuestionFromOpenAi({
    question: "what about the rear?",
    history: [{ role: "user", content: "front brake caliper torque" }],
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.temperature, 0);
});

// ---- Truncation: a half-finished reply must never be presented as complete ----

function stubTruncatedFetch(reason = "max_output_tokens") {
  globalThis.fetch = /** @type {any} */ (
    async () => ({
      ok: true,
      json: async () => ({
        status: "incomplete",
        incomplete_details: { reason },
        output_text: "Loosen the caliper bolts and torque them to",
        usage: { input_tokens: 1200, output_tokens: 512, total_tokens: 1712 },
      }),
    })
  );
}

test("a truncated answer throws instead of returning half a procedure", async () => {
  stubTruncatedFetch();

  await assert.rejects(
    () =>
      generateAnswerTextFromOpenAi({
        question: "How do I replace the front brake pads?",
        chunks: [sampleChunk],
      }),
    (thrown) => {
      const error = /** @type {any} */ (thrown);
      assert.match(error.message, /cut off/i);
      assert.equal(error.failure.kind, "truncated");
      assert.equal(error.failure.reason, "max_output_tokens");
      // usage is read off the payload, not guessed
      assert.equal(error.failure.usage.outputTokens, 512);
      // the partial text must not leak into the message
      assert.doesNotMatch(error.message, /Loosen the caliper/);
      return true;
    }
  );
});

test("a content-filtered answer throws with its own reason", async () => {
  stubTruncatedFetch("content_filter");

  await assert.rejects(
    () =>
      generateAnswerTextFromOpenAi({
        question: "How do I replace the front brake pads?",
        chunks: [sampleChunk],
      }),
    (thrown) => {
      const error = /** @type {any} */ (thrown);
      assert.equal(error.failure.kind, "content_filter");
      return true;
    }
  );
});

test("a truncated rewrite falls back to the user's own question instead of throwing", async () => {
  stubTruncatedFetch();

  const rewritten = await rewriteQuestionFromOpenAi({
    question: "what about the rear?",
    history: [{ role: "user", content: "front brake caliper torque" }],
  });

  // Fail SOFT here: this call is not wrapped by a caller, and a mangled search
  // query is worse than simply retrieving on what the user actually typed.
  assert.equal(rewritten, "what about the rear?");
});

test("a payload with no status field fails closed rather than being assumed complete", async () => {
  // Fail-closed contract: we only render text the provider confirmed finished.
  // An absent status cannot confirm that, so it is not shown.
  globalThis.fetch = /** @type {any} */ (
    async () => ({ ok: true, json: async () => ({ output_text: "27 ft-lb" }) })
  );

  await assert.rejects(
    () =>
      generateAnswerTextFromOpenAi({
        question: "What is the oil drain plug torque?",
        chunks: [sampleChunk],
      }),
    (thrown) => {
      const error = /** @type {any} */ (thrown);
      assert.equal(error.failure.kind, "unknown_status");
      assert.equal(error.failure.reason, "absent");
      return true;
    }
  );
});

test("a completed response with no usable text fails closed instead of answering blank", async () => {
  // Previously an empty payload produced "" which isNotFoundAnswer() would have
  // turned into an ordinary not_found -- an infrastructure failure disguised as
  // an honest "not in documents".
  globalThis.fetch = /** @type {any} */ (
    async () => ({ ok: true, json: async () => ({ status: "completed", output_text: "   " }) })
  );

  await assert.rejects(
    () =>
      generateAnswerTextFromOpenAi({
        question: "What is the oil drain plug torque?",
        chunks: [sampleChunk],
      }),
    (thrown) => {
      const error = /** @type {any} */ (thrown);
      assert.equal(error.failure.kind, "empty_output");
      return true;
    }
  );
});

// ---- retrievedContext: recover evidence discarded by the not_found exits ----

test("not_found surfaces the retrieved passages without changing citations", async () => {
  const result = await askQuestionUsingDocuments("water pump torque", {
    isAiConfigured: true,
    retrieveChunks: async () => [strongChunk()],
    generateAnswerText: async () => NOT_FOUND_MESSAGE,
  });

  // Unchanged contract: citations stays exactly as it was.
  assert.equal(result.status, "not_found");
  assert.deepEqual(result.citations, []);

  // Added contract: the evidence that was already in hand is no longer thrown away.
  assert.equal(result.retrievedContext.length, 1);
  assert.equal(result.retrievedContext[0].documentTitle, "Engine Manual");
  assert.equal(result.retrievedContext[0].pageNumber, 3);
  assert.match(result.retrievedContext[0].snippet, /Oil drain plug torque/);
});

test("the relevance gate also surfaces retrieved context (it exits before citations exist)", async () => {
  const result = await askQuestionUsingDocuments("something unrelated entirely", {
    isAiConfigured: true,
    // Weak chunk: no semantic evidence and too few matched terms, so the gate
    // short-circuits before buildCitationsFromChunks is ever reached.
    retrieveChunks: async () => [
      strongChunk({ semanticScore: 0.01, chunkMatchedTerms: 0, totalQueryTerms: 4 }),
    ],
    generateAnswerText: async () => {
      throw new Error("the model must not be called when the relevance gate trips");
    },
  });

  assert.equal(result.status, "not_found");
  assert.deepEqual(result.citations, []);
  assert.equal(result.retrievedContext.length, 1);
});

test("an answered response is unchanged and carries no retrievedContext", async () => {
  const result = await askQuestionUsingDocuments("What is the oil drain plug torque?", {
    isAiConfigured: true,
    retrieveChunks: async () => [strongChunk()],
    generateAnswerText: async () => "The oil drain plug torque is 27 ft-lb.",
  });

  assert.equal(result.status, "answered");
  assert.equal(result.citations.length, 1);
  assert.ok(
    !("retrievedContext" in result),
    "an answered response already cites its sources, so the field is omitted"
  );
});

test("not_found with nothing retrieved carries no retrievedContext", async () => {
  const result = await askQuestionUsingDocuments("nothing matches this", {
    isAiConfigured: true,
    retrieveChunks: async () => [],
    generateAnswerText: async () => NOT_FOUND_MESSAGE,
  });

  assert.equal(result.status, "not_found");
  assert.deepEqual(result.citations, []);
  assert.ok(!("retrievedContext" in result), "no chunks retrieved means nothing to show");
});

test("the ai-not-configured response is unchanged", async () => {
  const result = await askQuestionUsingDocuments("anything", { isAiConfigured: false });

  assert.equal(result.status, "ai_not_configured");
  assert.deepEqual(result.citations, []);
  assert.ok(!("retrievedContext" in result));
});

// ---- The dead `history` parameter stays deleted ----

test("the answer call receives no history, but still receives citations", async () => {
  let seenKeys = [];

  await askQuestionUsingDocuments("What is the oil drain plug torque?", {
    isAiConfigured: true,
    history: [{ role: "user", content: "we were talking about the front brakes" }],
    retrieveChunks: async () => [strongChunk()],
    rewriteQuestion: async () => "What is the oil drain plug torque?",
    generateAnswerText: async (params) => {
      seenKeys = Object.keys(params);
      return "The oil drain plug torque is 27 ft-lb.";
    },
  });

  // history was a genuinely dead parameter: nothing read it. Conversation
  // context reaches the model only via the rewrite call.
  assert.ok(!seenKeys.includes("history"), `history must not be passed, got: ${seenKeys}`);

  // citations is NOT dead -- it is part of this injection seam's contract and
  // several injected test doubles read it. Deleting it would be a contract change.
  assert.ok(seenKeys.includes("citations"), `citations must still be passed, got: ${seenKeys}`);
});

// ---- Rejection telemetry (issue #107) ----
//
// Before this, verifyEvidence built a `rejected` array and askQuestionUsingDocuments
// dropped it, so production could not tell a FALSE rejection ("the manual says
// this and we threw it out") from an honest miss ("the manual says nothing").
// Both surfaced as not_found. These tests pin the two properties that make the
// new channel usable: it explains every rejection, and it exposes none of the
// rejected content.

/** A chunk whose text supports one real torque figure and no other. */
const evidenceChunk = () =>
  strongChunk({
    chunkText:
      "Clean and install the oil drain plug with a new gasket. Torque : 37 Nm (377 kgf-cm, 27 ft-lbf)",
  });

test("buildRejectedMetrics keeps the safe metadata and drops the rejected content", () => {
  const sanitized = buildRejectedMetrics([
    {
      channel: "documentSupported",
      itemIndex: 0,
      sourceId: "S1",
      claim: "Torque the oil drain plug to 54 Nm.",
      reason: "numeric_anomaly",
      unsupported: ["54 Nm"],
    },
    {
      channel: "documentSupported",
      itemIndex: 1,
      sourceId: "S2",
      claim: "Torque the oil filter cap to 37 Nm.",
      reason: "subject_mismatch",
      subject: "oil filter cap",
    },
    {
      channel: "gaps",
      itemIndex: 0,
      sourceId: null,
      claim: "No 12 Nm sensor torque is given.",
      reason: "unsourced_gap_specification",
      unsupported: ["12 Nm"],
    },
  ]);

  assert.deepEqual(sanitized, [
    {
      channel: "documentSupported",
      itemIndex: 0,
      reason: "numeric_anomaly",
      sourceId: "S1",
      unsupportedSpecCount: 1,
    },
    {
      channel: "documentSupported",
      itemIndex: 1,
      reason: "subject_mismatch",
      sourceId: "S2",
      unsupportedSpecCount: 0,
    },
    {
      channel: "gaps",
      itemIndex: 0,
      reason: "unsourced_gap_specification",
      sourceId: null,
      unsupportedSpecCount: 1,
    },
  ]);

  // The point of the sanitizer. An unverified torque figure is exactly what the
  // verifier just refused to put on screen; a debug flag must not put it back.
  const serialized = JSON.stringify(sanitized);
  assert.ok(!serialized.includes("54 Nm"), "leaked the unsupported value");
  assert.ok(!serialized.includes("12 Nm"), "leaked the unsupported gap value");
  assert.ok(!serialized.includes("oil drain plug"), "leaked claim text");
  assert.ok(!serialized.includes("oil filter cap"), "leaked the parsed subject");
});

test("buildRejectedMetrics refuses a source label the model invented", () => {
  // sourceId is chosen by the MODEL and its shape is never validated upstream,
  // so on the unknown_source path it can be arbitrary text. Anything that is not
  // a plain S-label must not be echoed into a field advertised as log-safe.
  const sanitized = buildRejectedMetrics([
    {
      channel: "documentSupported",
      itemIndex: 0,
      sourceId: "S1 (the oil manual, page 4, drain plug 37 Nm)",
      claim: "x",
      reason: "unknown_source",
    },
  ]);

  assert.equal(sanitized.length, 1);
  assert.equal(sanitized[0].sourceId, null);
  assert.ok(!JSON.stringify(sanitized).includes("37 Nm"));
});

test("buildRejectedMetrics drops an entry whose channel or reason is undeclared", () => {
  const sanitized = buildRejectedMetrics([
    { channel: "somethingNew", itemIndex: 0, reason: "numeric_anomaly", claim: "x" },
    { channel: "gaps", itemIndex: 0, reason: "brand_new_reason", claim: "x" },
    { channel: "gaps", itemIndex: -1, reason: "numeric_anomaly", claim: "x" },
    null,
  ]);

  assert.deepEqual(sanitized, []);
});

test("metrics report a verifier rejection when metrics are enabled", async () => {
  const result = await askQuestionUsingDocuments("What is the oil drain plug torque?", {
    isAiConfigured: true,
    includeMetrics: true,
    evidenceContract: true,
    retrieveChunks: async () => [evidenceChunk()],
    generateEvidenceAnswer: async () => ({
      documentSupported: [
        {
          // A real, verbatim quote carrying an invented value: the shape that
          // looks grounded and is not.
          claim: "The oil drain plug torque is 54 Nm.",
          sourceId: "S1",
          evidenceQuote: "Torque : 37 Nm",
        },
      ],
      generalGuidance: [],
      gaps: [],
    }),
  });

  assert.equal(result.status, "not_found");
  assert.equal(result.citations.length, 0);
  assert.equal(result.metrics.rejectedCount, 1);
  assert.deepEqual(result.metrics.rejected, [
    {
      channel: "documentSupported",
      itemIndex: 0,
      reason: "numeric_anomaly",
      sourceId: "S1",
      unsupportedSpecCount: 1,
    },
  ]);

  // Nowhere in the response, under any heading: not the answer, not the gap
  // text, not the metrics.
  assert.ok(!JSON.stringify(result).includes("54 Nm"), "the rejected value leaked");
});

test("a partial answer still reports the claim that was rejected", async () => {
  // The mixed case. One claim verifies and renders; the other is torn out. A
  // status of `partial` must not hide the second half of that story.
  const result = await askQuestionUsingDocuments("What is the oil drain plug torque?", {
    isAiConfigured: true,
    includeMetrics: true,
    evidenceContract: true,
    retrieveChunks: async () => [evidenceChunk()],
    generateEvidenceAnswer: async () => ({
      documentSupported: [
        {
          claim: "The oil drain plug torque is 37 Nm.",
          sourceId: "S1",
          evidenceQuote: "the oil drain plug with a new gasket. Torque : 37 Nm",
        },
        {
          claim: "The oil drain plug torque is 54 Nm.",
          sourceId: "S1",
          evidenceQuote: "Torque : 37 Nm",
        },
      ],
      generalGuidance: [],
      gaps: [],
    }),
  });

  assert.equal(result.status, "partial");
  assert.equal(result.citations.length, 1);
  assert.equal(result.metrics.rejectedCount, 1);
  assert.equal(result.metrics.rejected[0].reason, "numeric_anomaly");
  assert.ok(!JSON.stringify(result).includes("54 Nm"));
});

test("metrics report an empty rejection list when nothing was rejected", async () => {
  // [] is a fact worth stating. A caller must not have to distinguish "no
  // rejections" from "this build does not report them".
  const result = await askQuestionUsingDocuments("What is the oil drain plug torque?", {
    isAiConfigured: true,
    includeMetrics: true,
    evidenceContract: true,
    retrieveChunks: async () => [evidenceChunk()],
    generateEvidenceAnswer: async () => ({
      documentSupported: [
        {
          claim: "The oil drain plug torque is 37 Nm.",
          sourceId: "S1",
          evidenceQuote: "the oil drain plug with a new gasket. Torque : 37 Nm",
        },
      ],
      generalGuidance: [],
      gaps: [],
    }),
  });

  assert.equal(result.status, "answered");
  assert.deepEqual(result.metrics.rejected, []);
  assert.equal(result.metrics.rejectedCount, 0);
});

test("no metrics at all reach the caller when the debug flag is off", async () => {
  const result = await askQuestionUsingDocuments("What is the oil drain plug torque?", {
    isAiConfigured: true,
    includeMetrics: false,
    evidenceContract: true,
    retrieveChunks: async () => [evidenceChunk()],
    generateEvidenceAnswer: async () => ({
      documentSupported: [
        {
          claim: "The oil drain plug torque is 54 Nm.",
          sourceId: "S1",
          evidenceQuote: "Torque : 37 Nm",
        },
      ],
      generalGuidance: [],
      gaps: [],
    }),
  });

  assert.equal(result.status, "not_found");
  assert.equal(result.metrics, undefined);
  assert.ok(!("rejected" in result), "rejections must not appear outside metrics");
});
