import assert from "node:assert/strict";
import test from "node:test";

// Each test file runs in its own process, so setting env before importing the
// config module is deterministic. dotenv.config() never overrides values that
// are already present on process.env, so these stay put even if a real .env
// exists. An empty OPENAI_VISION_MODEL exercises the "not provided" default.
process.env.OPENAI_ANSWER_MODEL = "answer-model-under-test";
process.env.OPENAI_VISION_MODEL = "";

const { config } = await import("../src/config.js");

test("openAiVisionModel defaults to the answer model when OPENAI_VISION_MODEL is unset", () => {
  assert.equal(config.openAiAnswerModel, "answer-model-under-test");
  assert.equal(config.openAiVisionModel, "answer-model-under-test");
});
