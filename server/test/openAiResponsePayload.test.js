import assert from "node:assert/strict";
import test from "node:test";

// Pure payload parsing: no database, no network, no config. Safe to import directly.
import {
  describeOpenAiFailure,
  parseCompleteOpenAiOutputText,
  parseOpenAiOutputText,
  parseOpenAiRefusal,
  readOpenAiUsage,
} from "../src/services/openAiResponsePayload.js";

test("parseOpenAiOutputText prefers the flattened output_text", () => {
  assert.equal(parseOpenAiOutputText({ output_text: "  37 Nm  " }), "37 Nm");
});

test("parseOpenAiOutputText falls back to walking output[].content[]", () => {
  const payload = {
    output: [
      {
        content: [
          { type: "output_text", text: "line one" },
          { type: "something_else", text: "ignored" },
        ],
      },
      { content: [{ type: "output_text", text: "line two" }] },
    ],
  };

  assert.equal(parseOpenAiOutputText(payload), "line one\n\nline two");
});

test("parseOpenAiOutputText returns empty string for junk payloads", () => {
  for (const payload of [null, undefined, {}, { output: "nope" }, 42]) {
    assert.equal(parseOpenAiOutputText(payload), "");
  }
});

test("describeOpenAiFailure returns null for a completed response", () => {
  assert.equal(describeOpenAiFailure({ status: "completed", output_text: "ok" }), null);
});

test("a payload with no status field is treated as complete", () => {
  // The whole existing test suite stubs bare { output_text } payloads. If this
  // regressed, every previously-passing AI test would start throwing.
  assert.equal(describeOpenAiFailure({ output_text: "ok" }), null);
});

test("describeOpenAiFailure classifies max_output_tokens as truncated", () => {
  const failure = describeOpenAiFailure({
    status: "incomplete",
    incomplete_details: { reason: "max_output_tokens" },
    output_text: "half a procedure",
  });

  assert.equal(failure.kind, "truncated");
  assert.equal(failure.reason, "max_output_tokens");
});

test("describeOpenAiFailure classifies content_filter separately", () => {
  const failure = describeOpenAiFailure({
    status: "incomplete",
    incomplete_details: { reason: "content_filter" },
  });

  assert.equal(failure.kind, "content_filter");
});

test("an incomplete response with an unknown reason still fails closed", () => {
  const failure = describeOpenAiFailure({ status: "incomplete" });

  assert.equal(failure.kind, "incomplete");
  assert.equal(failure.reason, "unknown");
});

test("describeOpenAiFailure surfaces a failed response's error message", () => {
  const failure = describeOpenAiFailure({
    status: "failed",
    error: { message: "upstream exploded" },
  });

  assert.equal(failure.kind, "failed");
  assert.match(failure.message, /upstream exploded/);
});

test("a refusal is detected even though it carries no output_text", () => {
  const payload = {
    status: "completed",
    output: [{ content: [{ type: "refusal", refusal: "I can't help with that." }] }],
  };

  assert.equal(parseOpenAiRefusal(payload), "I can't help with that.");
  assert.equal(describeOpenAiFailure(payload).kind, "refusal");
});

test("readOpenAiUsage coerces token counts and tolerates a missing usage block", () => {
  assert.deepEqual(
    readOpenAiUsage({ usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 } }),
    { inputTokens: 10, outputTokens: 20, totalTokens: 30 }
  );
  assert.equal(readOpenAiUsage({}), null);
  assert.deepEqual(readOpenAiUsage({ usage: {} }), {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  });
});

test("parseCompleteOpenAiOutputText returns text when the reply finished", () => {
  assert.equal(
    parseCompleteOpenAiOutputText({ status: "completed", output_text: "37 Nm" }),
    "37 Nm"
  );
});

test("parseCompleteOpenAiOutputText throws with .failure attached when truncated", () => {
  assert.throws(
    () =>
      parseCompleteOpenAiOutputText({
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output_text: "Torque the bolts to",
        usage: { output_tokens: 512 },
      }),
    (thrown) => {
      const error = /** @type {any} */ (thrown);
      assert.equal(error.failure.kind, "truncated");
      assert.equal(error.failure.usage.outputTokens, 512);
      // The partial answer must not be smuggled out inside the error message.
      assert.doesNotMatch(error.message, /Torque the bolts/);
      return true;
    }
  );
});
