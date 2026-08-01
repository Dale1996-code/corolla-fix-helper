import assert from "node:assert/strict";
import test from "node:test";

// Pure contract logic: no database, no network. Safe to import directly.
import {
  checkClaimNumbers,
  deriveEvidenceStatus,
  extractSpecNumbers,
  quoteAppearsInChunk,
  renderEvidenceAnswer,
  validateEvidencePayload,
  verifyEvidence,
} from "../src/services/askEvidenceContract.js";

const chunk = (overrides = {}) => ({
  documentId: 7,
  documentTitle: "Oil and Oil Filter Replacement",
  originalFilename: "oil.pdf",
  pageNumber: 1,
  chunkIndex: 0,
  chunkText:
    "Clean and install the oil drain plug with a new gasket. Torque : 37 Nm (377 kgf-cm, 27 ft-lbf)",
  ...overrides,
});

const payload = (overrides = {}) => ({
  documentSupported: [],
  generalGuidance: [],
  gaps: [],
  ...overrides,
});

// ---- Validator ----

test("the validator accepts a well-formed payload", () => {
  const result = validateEvidencePayload(
    payload({
      documentSupported: [{ claim: "Torque is 37 Nm.", sourceId: "S1", evidenceQuote: "37 Nm" }],
      generalGuidance: ["Let the engine cool first."],
      gaps: ["No filter part number."],
    })
  );

  assert.equal(result.ok, true);
  assert.equal(result.value.documentSupported.length, 1);
});

test("the validator rejects malformed payloads instead of coercing them", () => {
  const cases = [
    [null, "not_an_object"],
    ["text", "not_an_object"],
    [[], "not_an_object"],
    [{}, "documentSupported_not_an_array"],
    [payload({ documentSupported: ["nope"] }), "claim_not_an_object"],
    [payload({ documentSupported: [{ claim: "x", sourceId: "S1" }] }), "claim_missing_fields"],
    [
      payload({ documentSupported: [{ claim: "", sourceId: "S1", evidenceQuote: "q" }] }),
      "claim_missing_fields",
    ],
  ];

  for (const [input, reason] of cases) {
    const result = validateEvidencePayload(/** @type {any} */ (input));
    assert.equal(result.ok, false, `expected rejection for ${JSON.stringify(input)}`);
    assert.equal(result.reason, reason);
  }
});

test("the validator drops non-string guidance and gap entries", () => {
  const result = validateEvidencePayload(
    payload({ generalGuidance: ["ok", 42, null, "  "], gaps: [{}, "real gap"] })
  );

  assert.deepEqual(result.value.generalGuidance, ["ok"]);
  assert.deepEqual(result.value.gaps, ["real gap"]);
});

// ---- Quote verification ----

test("a verbatim quote is accepted despite whitespace and case differences", () => {
  assert.equal(quoteAppearsInChunk("torque :  37   nm", chunk().chunkText), true);
});

test("a paraphrased quote is rejected", () => {
  assert.equal(quoteAppearsInChunk("The torque value is 37 newton meters", chunk().chunkText), false);
});

test("an empty quote is rejected", () => {
  assert.equal(quoteAppearsInChunk("", chunk().chunkText), false);
  assert.equal(quoteAppearsInChunk("37 Nm", ""), false);
});

// ---- Numeric anomaly detector: scope ----

test("unit-bearing specifications are detected", () => {
  const specs = extractSpecNumbers(
    "Torque to 37 Nm or 27 ft-lbf, gap 0.8 mm, 4.2 liters, 13.5 volts, 200 kPa, 5W-30 oil"
  );
  const raws = specs.map((spec) => spec.raw.toLowerCase());

  assert.ok(raws.some((raw) => raw.includes("37")));
  assert.ok(raws.some((raw) => raw.includes("27")));
  assert.ok(raws.some((raw) => raw.includes("0.8")));
  assert.ok(raws.some((raw) => raw.includes("4.2")));
  assert.ok(raws.some((raw) => raw.includes("13.5")));
  assert.ok(raws.some((raw) => raw.includes("200")));
  assert.ok(raws.some((raw) => raw.includes("5w")));
});

test("structural and harmless numbers are NOT treated as specifications", () => {
  // A blanket ban on digits would mangle ordinary procedure prose. Only
  // unit-bearing spec claims are gated.
  for (const text of [
    "Step 3: remove the two bolts.",
    "Remove the 4 fasteners holding the cover.",
    "See page 14, section 2.",
    "Repeat for cylinders 1 and 4.",
    "There are 6 clips in total.",
  ]) {
    assert.deepEqual(extractSpecNumbers(text), [], `should not gate: ${text}`);
  }
});

test("a numbered step list passes the detector untouched", () => {
  const result = checkClaimNumbers("Step 1: loosen the two bolts. Step 2: remove the cover.", "");
  assert.equal(result.grounded, true);
});

// ---- Numeric anomaly detector: grounding ----

test("a spec present in the evidence is grounded", () => {
  const result = checkClaimNumbers("Torque the drain plug to 37 Nm.", chunk().chunkText);
  assert.equal(result.grounded, true);
});

test("a unit-variant conversion is treated as grounded, not an anomaly", () => {
  // The manual prints 37 N·m; the answer states the ft-lbf figure. Flagging that
  // as an anomaly would punish a correct conversion.
  const result = checkClaimNumbers("Torque the drain plug to 27 ft-lb.", "Torque : 37 N·m");
  assert.equal(result.grounded, true, JSON.stringify(result));
});

test("kgf-cm and in-lbf conversions are also recognized", () => {
  assert.equal(checkClaimNumbers("377 kgf-cm", "Torque : 37 N·m").grounded, true);
  assert.equal(checkClaimNumbers("327 in-lbf", "Torque : 37 N·m").grounded, true);
});

test("an invented spec is flagged even when the quote is real", () => {
  const result = checkClaimNumbers("Torque the drain plug to 54 Nm.", chunk().chunkText);

  assert.equal(result.grounded, false);
  assert.ok(result.unsupported.some((entry) => entry.includes("54")));
});

test("a viscosity grade must literally appear", () => {
  assert.equal(checkClaimNumbers("Use 5W-30 oil.", "Standard oil grade 5W-30").grounded, true);
  assert.equal(checkClaimNumbers("Use 0W-20 oil.", "Standard oil grade 5W-30").grounded, false);
});

// ---- Full verification ----

test("a verified claim survives and cites the mapped chunk", () => {
  const result = verifyEvidence(
    payload({
      documentSupported: [
        {
          claim: "The oil drain plug torque is 37 Nm.",
          sourceId: "S1",
          evidenceQuote: "Torque : 37 Nm (377 kgf-cm, 27 ft-lbf)",
        },
      ],
    }),
    [chunk()]
  );

  assert.equal(result.documentSupported.length, 1);
  assert.equal(result.documentSupported[0].pageNumber, 1);
  assert.equal(result.gaps.length, 0);
  assert.equal(result.rejected.length, 0);
});

test("a claim whose quote is not in the cited chunk becomes a gap", () => {
  const result = verifyEvidence(
    payload({
      documentSupported: [
        {
          claim: "The oil drain plug torque is 37 Nm.",
          sourceId: "S1",
          evidenceQuote: "Torque the drain plug to thirty-seven newton metres",
        },
      ],
    }),
    [chunk()]
  );

  assert.equal(result.documentSupported.length, 0);
  assert.equal(result.rejected[0].reason, "quote_not_in_source");
  assert.match(result.gaps[0], /Unverified/);
});

test("a claim naming an unknown source becomes a gap", () => {
  const result = verifyEvidence(
    payload({
      documentSupported: [{ claim: "x", sourceId: "S9", evidenceQuote: "Torque : 37 Nm" }],
    }),
    [chunk()]
  );

  assert.equal(result.documentSupported.length, 0);
  assert.equal(result.rejected[0].reason, "unknown_source");
});

test("a real quote with an invented number is rejected as a numeric anomaly", () => {
  // The dangerous case: the quote IS in the document, but the claim states a
  // value the quote does not contain.
  const result = verifyEvidence(
    payload({
      documentSupported: [
        {
          claim: "Torque the drain plug to 54 Nm.",
          sourceId: "S1",
          evidenceQuote: "Clean and install the oil drain plug with a new gasket.",
        },
      ],
    }),
    [chunk()]
  );

  assert.equal(result.documentSupported.length, 0);
  assert.equal(result.rejected[0].reason, "numeric_anomaly");
  // The failing value must NOT be reprinted: putting it in a gap would render
  // the ungrounded number again, just under a different heading.
  assert.doesNotMatch(result.gaps[0], /54/);
  assert.match(result.gaps[0], /\[unverified value\]/);
  // The detail is retained server-side for diagnosis.
  assert.ok(result.rejected[0].unsupported.some((entry) => entry.includes("54")));
});

test("an ungrounded torque value in general guidance surfaces as a gap, not text", () => {
  // The rule applies across ALL channels: an honest label does not license an
  // unsupported specification.
  const result = verifyEvidence(
    payload({ generalGuidance: ["Most drain plugs torque to around 30 Nm."] }),
    [chunk()]
  );

  assert.deepEqual(result.generalGuidance, []);
  assert.equal(result.rejected[0].reason, "unsourced_specification");
  assert.match(result.gaps[0], /Removed unsourced specification/);
  assert.doesNotMatch(result.gaps[0], /30 Nm/);
  assert.match(result.gaps[0], /\[unverified value\]/);
});

test("non-numeric general guidance is kept", () => {
  const result = verifyEvidence(
    payload({ generalGuidance: ["Let the engine cool before draining the oil."] }),
    [chunk()]
  );

  assert.equal(result.generalGuidance.length, 1);
  assert.equal(result.rejected.length, 0);
});

test("general guidance with only structural numbers is kept", () => {
  const result = verifyEvidence(
    payload({ generalGuidance: ["Work through the 4 bolts in a criss-cross pattern."] }),
    [chunk()]
  );

  assert.equal(result.generalGuidance.length, 1);
});

// ---- Derived status ----

test("status is derived from what actually verified", () => {
  assert.equal(deriveEvidenceStatus({ documentSupported: [], gaps: [] }), "not_found");
  assert.equal(deriveEvidenceStatus({ documentSupported: [], gaps: ["x"] }), "not_found");
  assert.equal(deriveEvidenceStatus({ documentSupported: [{}], gaps: [] }), "answered");
  assert.equal(deriveEvidenceStatus({ documentSupported: [{}], gaps: ["x"] }), "partial");
});

// ---- Rendering ----

test("the rendered answer keeps the two channels visibly distinct", () => {
  const text = renderEvidenceAnswer({
    documentSupported: [
      { claim: "Torque is 37 Nm.", documentTitle: "Oil Manual", pageNumber: 1 },
    ],
    generalGuidance: ["Let the engine cool."],
    gaps: ["No filter part number."],
  });

  assert.match(text, /Torque is 37 Nm\. \[Oil Manual, page 1\]/);
  assert.match(text, /General guidance — not from your documents/);
  assert.match(text, /Not covered by your documents/);
});
