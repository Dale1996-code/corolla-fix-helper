import assert from "node:assert/strict";
import test from "node:test";

// Pure payload parsing: no database, no network, no config. Safe to import directly.
import {
  createRedactedOpenAiHttpError,
  describeOpenAiFailure,
  parseCompleteOpenAiOutputText,
  parseOpenAiRefusal,
  readOpenAiResponse,
  readOpenAiUsage,
} from "../src/services/openAiResponsePayload.js";

const completed = (extra) => ({ status: "completed", ...extra });

function expectFailure(payload, kind) {
  const result = readOpenAiResponse(payload);

  assert.equal(result.ok, false, `expected a failure of kind ${kind}`);
  assert.equal(result.failure.kind, kind);
  // A failure must never leak text: that is the whole point of failing closed.
  assert.equal(result.text, "");
  return result.failure;
}

// ---- Success paths ----

test("completed response with valid flattened text", () => {
  const result = readOpenAiResponse(completed({ output_text: "  37 Nm  " }));

  assert.equal(result.ok, true);
  assert.equal(result.text, "37 Nm");
});

test("completed response with valid nested text", () => {
  const result = readOpenAiResponse(
    completed({
      output: [{ content: [{ type: "output_text", text: "37 Nm" }] }],
    })
  );

  assert.equal(result.ok, true);
  assert.equal(result.text, "37 Nm");
});

test("blank flattened text falls back to valid nested text", () => {
  // A blank output_text is treated as ABSENT, not as an empty answer, so a
  // payload that only populates the nested form still works.
  const result = readOpenAiResponse(
    completed({
      output_text: "   ",
      output: [{ content: [{ type: "output_text", text: "37 Nm" }] }],
    })
  );

  assert.equal(result.ok, true);
  assert.equal(result.text, "37 Nm");
});

test("multiple output items are flattened in order", () => {
  const result = readOpenAiResponse(
    completed({
      output: [
        { content: [{ type: "output_text", text: "line one" }] },
        { content: [{ type: "output_text", text: "line two" }] },
      ],
    })
  );

  assert.equal(result.ok, true);
  assert.equal(result.text, "line one\nline two");
});

test("non-text content types are skipped, not treated as malformed", () => {
  // reasoning/other parts are simply not answer text.
  const result = readOpenAiResponse(
    completed({
      output: [
        {
          content: [
            { type: "reasoning", text: "internal" },
            { type: "output_text", text: "37 Nm" },
          ],
        },
      ],
    })
  );

  assert.equal(result.ok, true);
  assert.equal(result.text, "37 Nm");
});

// ---- Non-success statuses: every one must fail closed ----

test("incomplete/truncated is classified and yields no text", () => {
  const failure = expectFailure(
    {
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output_text: "Loosen the caliper bolts and torque them to",
    },
    "truncated"
  );

  assert.equal(failure.reason, "max_output_tokens");
  assert.doesNotMatch(failure.message, /Loosen the caliper/);
});

test("incomplete content_filter is classified separately", () => {
  expectFailure(
    { status: "incomplete", incomplete_details: { reason: "content_filter" } },
    "content_filter"
  );
});

test("undocumented token-shaped incomplete reasons still classify as truncated", () => {
  // Defensive: the documented value is max_output_tokens, but any token/length
  // shaped reason means the same thing and must not degrade to a vaguer kind.
  for (const reason of ["max_tokens", "output_token_limit", "length"]) {
    const failure = expectFailure(
      { status: "incomplete", incomplete_details: { reason } },
      "truncated"
    );
    assert.equal(failure.reason, reason);
  }
});

test("incomplete with an unknown reason still fails closed", () => {
  const failure = expectFailure({ status: "incomplete" }, "incomplete");
  assert.equal(failure.reason, "unknown");
});

test("cancelled fails closed and discards any text", () => {
  expectFailure({ status: "cancelled", output_text: "partial answer" }, "cancelled");
});

test("queued fails closed", () => {
  expectFailure({ status: "queued" }, "queued");
});

test("in_progress fails closed and discards streaming text", () => {
  expectFailure({ status: "in_progress", output_text: "partial" }, "in_progress");
});

test("failed fails closed without exposing the provider message to the client", () => {
  const failure = expectFailure(
    {
      status: "failed",
      error: { message: "upstream exploded while processing your prompt", code: "server_error" },
    },
    "failed"
  );

  // The safe message must not carry provider internals...
  assert.doesNotMatch(failure.message, /upstream exploded/);
  assert.doesNotMatch(failure.message, /your prompt/);
  // ...but the detail is retained out-of-band for a developer.
  assert.match(failure.diagnostic, /upstream exploded/);
  assert.equal(failure.reason, "server_error");
});

test("a provider message is length-capped so it cannot become a content dump", () => {
  const failure = expectFailure(
    { status: "failed", error: { message: "x".repeat(5000) } },
    "failed"
  );

  assert.ok(failure.diagnostic.length <= 210, `diagnostic was ${failure.diagnostic.length}`);
});

test("an absent status fails closed", () => {
  const failure = expectFailure({ output_text: "37 Nm" }, "unknown_status");
  assert.equal(failure.reason, "absent");
});

test("an unrecognized status fails closed", () => {
  expectFailure({ status: "something_new", output_text: "37 Nm" }, "unknown_status");
});

// ---- Malformed and empty output ----

test("completed response with no usable text fails closed", () => {
  expectFailure(completed({ output_text: "   " }), "empty_output");
  expectFailure(completed({}), "empty_output");
  expectFailure(completed({ output: [] }), "empty_output");
  expectFailure(completed({ output: [{ content: [] }] }), "empty_output");
});

test("object-valued output_text is rejected, not coerced", () => {
  // String({}) would render "[object Object]" as if it were an answer.
  expectFailure(completed({ output_text: { value: "37 Nm" } }), "malformed_output");
});

test("array-valued output_text is rejected, not coerced", () => {
  expectFailure(completed({ output_text: ["37 Nm"] }), "malformed_output");
});

test("a nested output_text part with non-string text is rejected", () => {
  for (const text of [{ value: "37" }, ["37"], 37, null]) {
    expectFailure(
      completed({ output: [{ content: [{ type: "output_text", text }] }] }),
      "malformed_output"
    );
  }
});

test("malformed mixed content fails closed rather than returning the valid half", () => {
  // A part CLAIMING to be output_text but carrying a non-string means we do not
  // understand the payload. Returning only the readable half would silently drop
  // content -- the same hazard as truncation -- so it fails closed.
  expectFailure(
    completed({
      output: [
        { content: [{ type: "output_text", text: "Torque the bolts to" }] },
        { content: [{ type: "output_text", text: { value: "37 Nm" } }] },
      ],
    }),
    "malformed_output"
  );
});

// ---- Refusal ----

test("a refusal is detected even though it carries no output_text", () => {
  const payload = completed({
    output: [{ content: [{ type: "refusal", refusal: "I can't help with that." }] }],
  });

  assert.equal(parseOpenAiRefusal(payload), "I can't help with that.");
  const failure = expectFailure(payload, "refusal");
  assert.match(failure.diagnostic, /can't help/);
});

test("a refusal on an unfinished response is still reported by status", () => {
  // Status is checked before content, so an unfinished response never reaches
  // refusal handling and is reported as unfinished.
  expectFailure(
    {
      status: "incomplete",
      incomplete_details: { reason: "content_filter" },
      output: [{ content: [{ type: "refusal", refusal: "no" }] }],
    },
    "content_filter"
  );
});

// ---- Usage metadata ----

test("usage is read when present and absent usage is handled safely", () => {
  const withUsage = readOpenAiResponse(
    completed({ output_text: "ok", usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 } })
  );
  assert.deepEqual(withUsage.usage, { inputTokens: 10, outputTokens: 20, totalTokens: 30 });

  // Absent usage must not throw and must not block a valid answer.
  const withoutUsage = readOpenAiResponse(completed({ output_text: "ok" }));
  assert.equal(withoutUsage.ok, true);
  assert.equal(withoutUsage.usage, null);

  assert.equal(readOpenAiUsage({}), null);
  assert.equal(readOpenAiUsage({ usage: null }), null);
  assert.equal(readOpenAiUsage({ usage: "nope" }), null);
  assert.equal(readOpenAiUsage({ usage: [] }), null);
  assert.deepEqual(readOpenAiUsage({ usage: {} }), {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  });
});

test("usage still rides along on a failure", () => {
  const failure = expectFailure(
    {
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      usage: { output_tokens: 512 },
    },
    "truncated"
  );

  assert.equal(failure.usage.outputTokens, 512);
});

// ---- Junk input ----

test("junk payloads fail closed instead of throwing", () => {
  for (const payload of [null, undefined, {}, 42, "text", []]) {
    const result = readOpenAiResponse(/** @type {any} */ (payload));
    assert.equal(result.ok, false);
    assert.equal(result.text, "");
  }
});

// ---- Thin wrappers ----

test("describeOpenAiFailure returns null only for a usable completed response", () => {
  assert.equal(describeOpenAiFailure(completed({ output_text: "ok" })), null);
  assert.equal(describeOpenAiFailure(completed({ output_text: "" })).kind, "empty_output");
});

test("parseCompleteOpenAiOutputText returns text when the reply finished", () => {
  assert.equal(parseCompleteOpenAiOutputText(completed({ output_text: "37 Nm" })), "37 Nm");
});

test("parseCompleteOpenAiOutputText throws a SAFE message with .failure attached", () => {
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
      // ask.js returns error.message to the client verbatim, so the partial
      // answer must not be smuggled out inside it.
      assert.doesNotMatch(error.message, /Torque the bolts/);
      return true;
    }
  );
});

test("no failure message leaks provider or model text", () => {
  const payloads = [
    { status: "failed", error: { message: "secret prompt echo" } },
    { status: "cancelled", output_text: "secret partial answer" },
    { status: "in_progress", output_text: "secret partial answer" },
    completed({ output: [{ content: [{ type: "refusal", refusal: "secret refusal text" }] }] }),
  ];

  for (const payload of payloads) {
    const failure = describeOpenAiFailure(payload);
    assert.doesNotMatch(failure.message, /secret/);
  }
});

// ---- Nested output-message status and structure ----

test("top-level completed + nested incomplete message fails closed", () => {
  // The response object finished; the MESSAGE inside it did not. Its text is
  // partial, so a top-level "completed" must not license rendering it.
  const failure = expectFailure(
    completed({
      output: [
        {
          status: "incomplete",
          content: [{ type: "output_text", text: "Torque the caliper bolts to" }],
        },
      ],
    }),
    "incomplete"
  );

  assert.equal(failure.reason, "output_message_incomplete");
});

test("top-level completed + nested cancelled message fails closed", () => {
  const failure = expectFailure(
    completed({
      output: [{ status: "cancelled", content: [{ type: "output_text", text: "partial" }] }],
    }),
    "incomplete"
  );

  assert.equal(failure.reason, "output_message_cancelled");
});

test("a nonblank flattened output_text cannot bypass a bad nested message", () => {
  // The regression this guards: reading output_text first and returning early
  // meant nested validation never ran.
  expectFailure(
    completed({
      output_text: "The oil drain plug torque is 37 Nm.",
      output: [{ status: "incomplete", content: [{ type: "output_text", text: "The oil" }] }],
    }),
    "incomplete"
  );
});

test("valid flattened text with malformed nested output fails closed", () => {
  expectFailure(
    completed({
      output_text: "37 Nm",
      output: [{ content: [{ type: "output_text", text: { value: "37 Nm" } }] }],
    }),
    "malformed_output"
  );
});

test("flattened and nested text that disagree fail closed", () => {
  // We cannot tell which representation reflects what the model produced, so we
  // do not pick the convenient one.
  const failure = expectFailure(
    completed({
      output_text: "The torque is 37 Nm.",
      output: [{ content: [{ type: "output_text", text: "The torque is 54 Nm." }] }],
    }),
    "malformed_output"
  );

  assert.equal(failure.reason, "flattened_nested_mismatch");
});

test("flattened and nested text that agree are accepted", () => {
  // Whitespace-insensitive: the flattening uses its own separators.
  const result = readOpenAiResponse(
    completed({
      output_text: "line one\n\nline two",
      output: [
        { status: "completed", content: [{ type: "output_text", text: "line one" }] },
        { status: "completed", content: [{ type: "output_text", text: "line two" }] },
      ],
    })
  );

  assert.equal(result.ok, true);
  assert.equal(result.text, "line one\n\nline two");
});

test("multiple completed output messages are preserved", () => {
  const result = readOpenAiResponse(
    completed({
      output: [
        { status: "completed", content: [{ type: "output_text", text: "step one" }] },
        { status: "completed", content: [{ type: "output_text", text: "step two" }] },
      ],
    })
  );

  assert.equal(result.ok, true);
  assert.equal(result.text, "step one\nstep two");
});

test("mixed completed and incomplete messages fail closed rather than returning the good one", () => {
  expectFailure(
    completed({
      output: [
        { status: "completed", content: [{ type: "output_text", text: "step one" }] },
        { status: "incomplete", content: [{ type: "output_text", text: "step tw" }] },
      ],
    }),
    "incomplete"
  );
});

test("output messages with no status are still accepted when the response completed", () => {
  // Not every payload stamps a per-message status; absence there is normal and
  // must not break valid responses.
  const result = readOpenAiResponse(
    completed({ output: [{ content: [{ type: "output_text", text: "37 Nm" }] }] })
  );

  assert.equal(result.ok, true);
});

// ---- Redacted HTTP errors ----

test("createRedactedOpenAiHttpError never puts the provider body in the message", () => {
  const error = /** @type {any} */ (
    createRedactedOpenAiHttpError(400, "echoed-private-prompt and document text")
  );

  assert.doesNotMatch(error.message, /echoed-private-prompt/);
  assert.doesNotMatch(error.message, /document text/);
  assert.equal(error.failure.kind, "http_error");
  assert.equal(error.failure.reason, "http_400");
  assert.equal(error.failure.httpStatus, 400);
  // Retained out-of-band, bounded.
  assert.match(error.failure.diagnostic, /echoed-private-prompt/);
});

test("a redacted HTTP error diagnostic is length-capped", () => {
  const error = /** @type {any} */ (createRedactedOpenAiHttpError(500, "y".repeat(9000)));

  assert.ok(error.failure.diagnostic.length <= 210);
});
