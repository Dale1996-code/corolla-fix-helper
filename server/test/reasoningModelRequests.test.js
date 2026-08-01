import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, afterEach } from "node:test";

// Model-aware request shaping, pinned at the REAL call sites.
//
// gpt-5.6-luna and gpt-5.5-* reject `temperature` outright -- the API returns
// 400 "Unsupported parameter: 'temperature' is not supported with this model",
// which fails the entire request. Unit tests on buildModelTuning prove the rule;
// these prove the services actually apply it to the outgoing body.
//
// The model is configured via env BEFORE config.js is imported, which is the
// only way to drive a specific model through the real request builders.
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-fix-helper-reasoning-"));
process.env.DATABASE_FILE = path.join(tempRoot, "reasoning.db");
process.env.UPLOADS_DIR = path.join(tempRoot, "uploads");
process.env.ASK_EVIDENCE_CONTRACT = "false";
process.env.OPENAI_API_KEY = "test-key";
process.env.OPENAI_ANSWER_MODEL = "gpt-5.6-luna";
process.env.OPENAI_VISION_MODEL = "gpt-5.6-luna";
process.env.OPENAI_REASONING_EFFORT = "low";

const { db } = await import("../src/database.js");
const {
  generateAnswerTextFromOpenAi,
  generateEvidenceAnswerFromOpenAi,
  rewriteQuestionFromOpenAi,
} = await import("../src/services/aiAnswerService.js");
const { generateChunkRankingFromOpenAi } = await import(
  "../src/services/chunkRerankService.js"
);

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

/** Capture the outgoing request body; return a completed Responses payload. */
function captureFetch(outputText = "ok") {
  const bodies = [];
  globalThis.fetch = /** @type {any} */ (
    async (url, options) => {
      bodies.push(JSON.parse(options.body));
      return {
        ok: true,
        json: async () => ({ status: "completed", output_text: outputText }),
      };
    }
  );
  return bodies;
}

const chunk = {
  documentId: 7,
  documentTitle: "Engine Manual",
  originalFilename: "engine-manual.pdf",
  pageNumber: 3,
  chunkIndex: 0,
  chunkText: "Oil drain plug torque is 27 ft-lb.",
};

function assertReasoningShape(body, label) {
  assert.equal(body.model, "gpt-5.6-luna", `${label}: model`);
  assert.ok(!("temperature" in body), `${label}: must NOT send temperature`);
  assert.deepEqual(body.reasoning, { effort: "low" }, `${label}: reasoning effort`);
}

test("the answer request omits temperature and sets reasoning.effort", async () => {
  const bodies = captureFetch();

  await generateAnswerTextFromOpenAi({ question: "torque?", chunks: [chunk] });

  assertReasoningShape(bodies[0], "answer");
});

test("the vision answer request also omits temperature", async () => {
  const bodies = captureFetch();

  await generateAnswerTextFromOpenAi({
    question: "what is this?",
    chunks: [chunk],
    image: "data:image/png;base64,QUJD",
  });

  assertReasoningShape(bodies[0], "vision");
  assert.ok(Array.isArray(bodies[0].input), "vision still uses structured input");
});

test("the question-rewrite request omits temperature", async () => {
  const bodies = captureFetch("What is the rear caliper torque?");

  await rewriteQuestionFromOpenAi({
    question: "what about the rear?",
    history: [{ role: "user", content: "front caliper torque" }],
  });

  assertReasoningShape(bodies[0], "rewrite");
});

test("the rerank request omits temperature", async () => {
  const bodies = captureFetch("[1]");

  await generateChunkRankingFromOpenAi({ question: "torque?", candidates: [chunk] });

  assert.ok(!("temperature" in bodies[0]), "rerank must NOT send temperature");
  assert.deepEqual(bodies[0].reasoning, { effort: "low" });
});

test("the evidence-contract request keeps structured output AND omits temperature", async () => {
  // The two must coexist: dropping temperature must not disturb text.format.
  const bodies = captureFetch(
    JSON.stringify({ documentSupported: [], generalGuidance: [], gaps: [] })
  );

  await generateEvidenceAnswerFromOpenAi({ question: "torque?", chunks: [chunk] });

  assertReasoningShape(bodies[0], "evidence");
  assert.equal(bodies[0].text.format.type, "json_schema");
  assert.equal(bodies[0].text.format.name, "grounded_repair_answer");
});

test("max_output_tokens is still sent on every path", async () => {
  // Reasoning tokens are billed against this budget, so it must never be lost.
  const bodies = captureFetch();

  await generateAnswerTextFromOpenAi({ question: "torque?", chunks: [chunk] });

  assert.equal(typeof bodies[0].max_output_tokens, "number");
  assert.ok(bodies[0].max_output_tokens > 0);
});
