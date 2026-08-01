import assert from "node:assert/strict";
import test from "node:test";

// Pure capability rules: no network, no database.
import {
  buildModelTuning,
  DEFAULT_REASONING_EFFORT,
  isReasoningModel,
  supportsTemperature,
} from "../src/services/openAiModelCapabilities.js";

// Every expectation below was confirmed by a live probe against the API before
// being written down -- see the module header for the observed responses.

test("classic models keep temperature: 0", () => {
  for (const model of ["gpt-4.1", "gpt-4.1-2025-04-14", "gpt-4o", "gpt-4o-mini"]) {
    assert.equal(supportsTemperature(model), true, model);
    assert.deepEqual(buildModelTuning(model), { temperature: 0 }, model);
  }
});

test("reasoning models get reasoning.effort and NEVER temperature", () => {
  // gpt-5.6-luna returns 400 "Unsupported parameter: 'temperature' is not
  // supported with this model", so sending it fails the entire request.
  for (const model of ["gpt-5.6-luna", "gpt-5.5-2026-04-23", "gpt-5", "o3", "o4-mini"]) {
    assert.equal(supportsTemperature(model), false, model);

    const tuning = buildModelTuning(model);
    assert.ok(!("temperature" in tuning), `${model} must not receive temperature`);
    assert.deepEqual(tuning.reasoning, { effort: DEFAULT_REASONING_EFFORT }, model);
  }
});

test("the default reasoning effort is one the API accepts", () => {
  // Probed supported values: none, low, medium, high, xhigh, max.
  // 'minimal' is rejected with 400 unsupported_value.
  assert.ok(
    ["none", "low", "medium", "high", "xhigh", "max"].includes(DEFAULT_REASONING_EFFORT),
    `'${DEFAULT_REASONING_EFFORT}' is not an accepted effort value`
  );
  assert.notEqual(DEFAULT_REASONING_EFFORT, "minimal");
});

test("the reasoning effort can be overridden per call site", () => {
  assert.deepEqual(buildModelTuning("gpt-5.6-luna", { reasoningEffort: "medium" }), {
    reasoning: { effort: "medium" },
  });
});

test("an overridden effort is ignored for a classic model", () => {
  assert.deepEqual(buildModelTuning("gpt-4.1", { reasoningEffort: "high" }), { temperature: 0 });
});

test("an absent or malformed model yields no tuning rather than throwing", () => {
  for (const model of ["", null, undefined]) {
    assert.deepEqual(buildModelTuning(/** @type {any} */ (model)), {});
  }
});

test("model families are matched case-insensitively", () => {
  assert.equal(isReasoningModel("GPT-5.6-Luna"), true);
  assert.equal(isReasoningModel("GPT-4.1"), false);
});

test("a gpt-4 model is not mistaken for a reasoning model", () => {
  // Guards the prefix rule: "gpt-5" must not match inside another token.
  assert.equal(isReasoningModel("gpt-4.1-2025-04-14"), false);
  assert.equal(isReasoningModel("text-embedding-3-small"), false);
});
