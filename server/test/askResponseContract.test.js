import assert from "node:assert/strict";
import test from "node:test";

// Pure shape logic: no database, no network, no config. Safe to import directly.
import {
  ASK_REJECTION_REASONS,
  ASK_RESPONSE_SCHEMA,
  ASK_RESPONSE_STATUSES,
  validateAskResponse,
} from "../src/services/askResponseContract.js";

const source = (overrides = {}) => ({
  documentId: 7,
  documentTitle: "Oil and Oil Filter Replacement",
  originalFilename: "oil.pdf",
  pageNumber: 1,
  chunkIndex: 0,
  snippet: "Torque : 37 Nm (377 kgf-cm, 27 ft-lbf)",
  documentAvailable: true,
  ...overrides,
});

const response = (overrides = {}) => ({
  question: "What is the oil drain plug torque?",
  standaloneQuestion: "What is the oil drain plug torque?",
  status: "answered",
  answer: "The oil drain plug torque is 37 Nm.",
  citations: [source()],
  ...overrides,
});

const rejection = (overrides = {}) => ({
  channel: "documentSupported",
  itemIndex: 0,
  reason: "numeric_anomaly",
  sourceId: "S1",
  unsupportedSpecCount: 1,
  ...overrides,
});

// ---- Base shape ----

test("a well-formed response validates", () => {
  const result = validateAskResponse(response());

  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
});

test("every declared status is accepted and nothing else is", () => {
  for (const status of ASK_RESPONSE_STATUSES) {
    assert.equal(validateAskResponse(response({ status })).ok, true, status);
  }

  // "error" is a CLIENT-side status SearchPage.jsx assigns when it refuses a
  // payload. The server never sends it, and accepting it here would let the
  // contract bless a shape the server has no path to produce.
  for (const status of ["error", "verified", "", null, undefined]) {
    assert.equal(validateAskResponse(response({ status })).ok, false, String(status));
  }
});

test("the required base fields are actually required", () => {
  for (const field of ASK_RESPONSE_SCHEMA.required) {
    const payload = response();
    delete payload[field];

    const result = validateAskResponse(payload);
    assert.equal(result.ok, false, `${field} was not required`);
    assert.ok(
      result.errors.some((error) => error.startsWith(`${field}:`)),
      `no error named ${field}`
    );
  }
});

test("an unexpected top-level field is reported rather than passed over", () => {
  // Drift detection. A field nobody reviewed is a field nobody checked for
  // document text.
  const result = validateAskResponse(response({ debugPrompt: "..." }));

  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("debugPrompt: unexpected_field"));
});

test("a citation missing its location or text is rejected", () => {
  /** @type {Array<[any, string]>} */
  const cases = [
    [source({ documentId: 0 }), "citations[0].documentId"],
    [source({ documentId: "7" }), "citations[0].documentId"],
    [source({ pageNumber: 0 }), "citations[0].pageNumber"],
    [source({ chunkIndex: -1 }), "citations[0].chunkIndex"],
    [source({ snippet: "   " }), "citations[0].snippet"],
    [source({ documentAvailable: "yes" }), "citations[0].documentAvailable"],
    [source({ evidenceId: "ask_ev_v1_nothex" }), "citations[0].evidenceId"],
  ];

  for (const [citation, expected] of cases) {
    const result = validateAskResponse(response({ citations: [citation] }));
    assert.equal(result.ok, false, expected);
    assert.ok(
      result.errors.some((error) => error.startsWith(expected)),
      `${expected} not reported, got ${result.errors.join("; ")}`
    );
  }
});

test("a citation with neither a title nor a filename cannot be attributed", () => {
  const result = validateAskResponse(
    response({ citations: [source({ documentTitle: "", originalFilename: "" })] })
  );

  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("citations[0]: missing_document_name"));
});

// ---- Rejection metrics ----

test("a sanitized rejection entry validates", () => {
  const result = validateAskResponse(
    response({ metrics: { rejectedCount: 1, rejected: [rejection()] } })
  );

  assert.deepEqual(result.errors, []);
});

test("an empty rejection list is valid", () => {
  const result = validateAskResponse(
    response({ metrics: { rejectedCount: 0, rejected: [] } })
  );

  assert.equal(result.ok, true);
});

test("every reason the verifier can emit is accepted", () => {
  for (const reason of ASK_REJECTION_REASONS) {
    const result = validateAskResponse(
      response({ metrics: { rejected: [rejection({ reason })] } })
    );
    assert.equal(result.ok, true, reason);
  }
});

test("an undeclared reason or channel is rejected", () => {
  /** @type {Array<[any, string]>} */
  const cases = [
    [{ reason: "vibes" }, "metrics.rejected[0].reason: unknown_reason"],
    [{ channel: "somethingNew" }, "metrics.rejected[0].channel: unknown_channel"],
  ];

  for (const [override, expected] of cases) {
    const result = validateAskResponse(
      response({ metrics: { rejected: [rejection(override)] } })
    );
    assert.equal(result.ok, false);
    assert.ok(result.errors.includes(expected), result.errors.join("; "));
  }
});

test("the verifier's internal detail fields are refused inside metrics", () => {
  // This is the safety property the whole sanitizer exists for. `claim`,
  // `unsupported`, and `subject` carry document text and the very specification
  // values verification rejected; the contract must name them as unexpected
  // rather than let them ride along behind a debug flag.
  for (const field of ["claim", "unsupported", "subject"]) {
    const result = validateAskResponse(
      response({ metrics: { rejected: [rejection({ [field]: "37 Nm on the drain plug" })] } })
    );

    assert.equal(result.ok, false, field);
    assert.ok(
      result.errors.includes(`metrics.rejected[0].${field}: unexpected_field`),
      `${field} was allowed through`
    );
  }
});

test("a source label the model invented is refused", () => {
  const result = validateAskResponse(
    response({
      metrics: { rejected: [rejection({ sourceId: "S1 (oil manual page 4, 37 Nm)" })] },
    })
  );

  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("metrics.rejected[0].sourceId: malformed"));
});

test("a null source label is valid, because guidance and gaps are not sourced", () => {
  const result = validateAskResponse(
    response({
      metrics: {
        rejected: [
          rejection({ channel: "gaps", reason: "unsourced_gap_specification", sourceId: null }),
        ],
      },
    })
  );

  assert.equal(result.ok, true, result.errors.join("; "));
});

test("metrics fields other than rejected are left alone", () => {
  // buildAskMetrics grows new measurements over time. Pinning the whole object
  // would reject a new timing the moment it is added, for no safety gain — every
  // other field is a number.
  const result = validateAskResponse(
    response({ metrics: { retrievalMs: 5, someNewTiming: 3, rejected: [] } })
  );

  assert.equal(result.ok, true);
});

// ---- Errors are log-safe ----

test("no error message ever contains a field value", () => {
  // The route logs these strings verbatim. If a value could reach an error, the
  // tripwire would leak the document text it exists to protect.
  const secret = "Torque the oil drain plug to 54 Nm";
  const result = validateAskResponse({
    question: secret,
    standaloneQuestion: "",
    status: secret,
    answer: 42,
    citations: [source({ snippet: "", documentTitle: secret, originalFilename: "" })],
    evidence: { documentSupported: [{ claim: secret }], generalGuidance: [1], gaps: [] },
    metrics: { rejected: [{ channel: secret, itemIndex: "x", reason: secret, claim: secret }] },
    smuggled: secret,
  });

  assert.equal(result.ok, false);
  assert.ok(result.errors.length > 5, "expected many errors");

  for (const error of result.errors) {
    assert.ok(!error.includes("54"), `error leaked a value: ${error}`);
    assert.ok(!error.includes("drain plug"), `error leaked a value: ${error}`);
  }
});

// ---- Evidence ----

test("evidence must carry all three channels", () => {
  const result = validateAskResponse(
    response({ evidence: { documentSupported: [], generalGuidance: [] } })
  );

  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("evidence.gaps: not_an_array"));
});

test("an evidence claim must name a real location and a non-empty quote", () => {
  const result = validateAskResponse(
    response({
      evidence: {
        documentSupported: [
          { claim: "", evidenceQuote: "", documentId: 0, pageNumber: 0, chunkIndex: -1 },
        ],
        generalGuidance: [],
        gaps: [],
      },
    })
  );

  assert.equal(result.ok, false);
  for (const field of ["claim", "evidenceQuote", "documentId", "pageNumber", "chunkIndex"]) {
    assert.ok(
      result.errors.some((error) =>
        error.startsWith(`evidence.documentSupported[0].${field}`)
      ),
      `${field} not checked`
    );
  }
});

test("evidence and retrievedContext are optional", () => {
  const payload = response();

  assert.equal(validateAskResponse(payload).ok, true);
  assert.equal(
    validateAskResponse({ ...payload, retrievedContext: [source()] }).ok,
    true
  );
});

test("a non-object payload is rejected without throwing", () => {
  for (const value of [null, undefined, "ok", 5, []]) {
    const result = validateAskResponse(value);
    assert.equal(result.ok, false, String(value));
    assert.deepEqual(result.errors, ["response: not_an_object"]);
  }
});
