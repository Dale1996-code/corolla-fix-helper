import assert from "node:assert/strict";
import test from "node:test";

// Pure contract logic: no database, no network. Safe to import directly.
import {
  ASK_REJECTION_CHANNELS,
  ASK_REJECTION_REASONS,
  checkClaimNumbers,
  checkClaimSubject,
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
    [{ documentSupported: [], gaps: [] }, "generalGuidance_not_an_array"],
    [{ documentSupported: [], generalGuidance: [] }, "gaps_not_an_array"],
    [payload({ unexpected: "field" }), "unexpected_payload_field"],
    [
      payload({
        documentSupported: [
          { claim: "x", sourceId: "S1", evidenceQuote: "q", chunkId: 999 },
        ],
      }),
      "claim_unexpected_field",
    ],
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

test("the validator rejects non-string guidance and gap entries", () => {
  assert.deepEqual(
    validateEvidencePayload(payload({ generalGuidance: ["ok", 42], gaps: [] })),
    { ok: false, reason: "generalGuidance_item_not_a_string" }
  );
  assert.deepEqual(
    validateEvidencePayload(payload({ generalGuidance: [], gaps: [{}, "real gap"] })),
    { ok: false, reason: "gaps_item_not_a_string" }
  );
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

test("the same number with an unrelated unit is not treated as grounded", () => {
  const result = checkClaimNumbers("Set tire pressure to 37 psi.", "Torque : 37 N·m");

  assert.equal(result.grounded, false);
  assert.ok(result.unsupported.some((entry) => entry.includes("37 psi")));
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
          evidenceQuote:
            "Clean and install the oil drain plug with a new gasket. Torque : 37 Nm (377 kgf-cm, 27 ft-lbf)",
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

test("a torque claim citing a different subject with the same value is rejected", () => {
  const result = verifyEvidence(
    payload({
      documentSupported: [
        {
          claim: "Torque the oil filter cap to 37 Nm.",
          sourceId: "S1",
          evidenceQuote:
            "Clean and install the oil drain plug with a new gasket. Torque : 37 Nm",
        },
      ],
    }),
    [chunk()]
  );

  assert.equal(result.documentSupported.length, 0);
  assert.equal(result.rejected[0].reason, "subject_mismatch");
  assert.doesNotMatch(result.gaps.join(" "), /37 Nm/);
});

test("the subject guard also covers asterisk-formatted torque units from PDF text", () => {
  const quote = "The oil drain plug torque is 37 N*m.";
  const result = verifyEvidence(
    payload({
      documentSupported: [
        {
          claim: "Torque the oil filter cap to 37 N*m.",
          sourceId: "S1",
          evidenceQuote: quote,
        },
      ],
    }),
    [chunk({ chunkText: quote })]
  );

  assert.equal(extractSpecNumbers("37 N*m").length, 1);
  assert.equal(result.documentSupported.length, 0);
  assert.equal(result.rejected[0].reason, "subject_mismatch");
});

test("a volume claim citing a different system with the same figure is rejected", () => {
  // The number is real and the quote is real -- but 4.2 liters of coolant does
  // not establish the engine oil capacity.
  const quote = "Coolant capacity: 4.2 liters";
  const result = verifyEvidence(
    payload({
      documentSupported: [
        {
          claim: "The engine oil capacity is 4.2 liters.",
          sourceId: "S1",
          evidenceQuote: quote,
        },
      ],
    }),
    [chunk({ chunkText: quote })]
  );

  assert.equal(result.documentSupported.length, 0);
  assert.equal(result.rejected[0].reason, "subject_mismatch");
  assert.doesNotMatch(result.gaps.join(" "), /4\.2 liters/);
});

test("a pressure claim citing the other axle with the same figure is rejected", () => {
  const quote = "Rear tire pressure: 220 kPa";
  const result = verifyEvidence(
    payload({
      documentSupported: [
        {
          claim: "The front tire pressure is 220 kPa.",
          sourceId: "S1",
          evidenceQuote: quote,
        },
      ],
    }),
    [chunk({ chunkText: quote })]
  );

  assert.equal(result.documentSupported.length, 0);
  assert.equal(result.rejected[0].reason, "subject_mismatch");
  assert.doesNotMatch(result.gaps.join(" "), /220 kPa/);
});

test("a length claim citing a different component with the same figure is rejected", () => {
  const quote = "Rear brake pad minimum thickness: 1.0 mm";
  const result = verifyEvidence(
    payload({
      documentSupported: [
        {
          claim: "The front brake pad thickness is 1.0 mm.",
          sourceId: "S1",
          evidenceQuote: quote,
        },
      ],
    }),
    [chunk({ chunkText: quote })]
  );

  assert.equal(result.documentSupported.length, 0);
  assert.equal(result.rejected[0].reason, "subject_mismatch");
});

test("the widened subject guard still accepts a matching non-torque subject", () => {
  // Fail-closed must not mean fail-always: the same component in claim and quote
  // passes, including the imperative "inflate ... to <value>" shape.
  const cases = [
    ["The engine oil capacity is 4.2 liters.", "Engine oil capacity (with filter): 4.2 liters"],
    ["Inflate the front tires to 220 kPa.", "Front tires: 220 kPa cold"],
  ];

  for (const [claim, quote] of cases) {
    const result = verifyEvidence(
      payload({ documentSupported: [{ claim, sourceId: "S1", evidenceQuote: quote }] }),
      [chunk({ chunkText: quote })]
    );

    assert.equal(result.rejected.length, 0, claim);
    assert.equal(result.documentSupported.length, 1, claim);
  }
});

test("a voltage claim citing a different circuit with the same reading is rejected", () => {
  // 13.5 V at the charging system and 13.5 V at the battery are not the same
  // measurement, and the numeric check alone cannot tell them apart.
  const quote = "Charging system output: 13.5 volts at idle";
  const result = verifyEvidence(
    payload({
      documentSupported: [
        {
          claim: "The battery voltage should read 13.5 volts.",
          sourceId: "S1",
          evidenceQuote: quote,
        },
      ],
    }),
    [chunk({ chunkText: quote })]
  );

  assert.equal(result.documentSupported.length, 0);
  assert.equal(result.rejected[0].reason, "subject_mismatch");
  assert.doesNotMatch(result.gaps.join(" "), /13\.5 volts/);
});

test("a resistance claim citing a different sensor with the same figure is rejected", () => {
  const quote = "Intake air temperature sensor resistance: 2.4 kilohms";
  const result = verifyEvidence(
    payload({
      documentSupported: [
        {
          claim: "The engine coolant temperature sensor resistance is 2.4 kilohms.",
          sourceId: "S1",
          evidenceQuote: quote,
        },
      ],
    }),
    [chunk({ chunkText: quote })]
  );

  assert.equal(result.documentSupported.length, 0);
  assert.equal(result.rejected[0].reason, "subject_mismatch");
});

test("an rpm claim citing a different system with the same figure is rejected", () => {
  const quote = "Maximum cooling fan speed: 700 rpm";
  const result = verifyEvidence(
    payload({
      documentSupported: [
        {
          claim: "The idle speed is 700 rpm.",
          sourceId: "S1",
          evidenceQuote: quote,
        },
      ],
    }),
    [chunk({ chunkText: quote })]
  );

  assert.equal(result.documentSupported.length, 0);
  assert.equal(result.rejected[0].reason, "subject_mismatch");
});

test("a temperature claim citing a different component with the same figure is rejected", () => {
  const quote = "Engine oil temperature warning threshold: 82°C";
  const result = verifyEvidence(
    payload({
      documentSupported: [
        {
          claim: "The thermostat opening temperature is 82°C.",
          sourceId: "S1",
          evidenceQuote: quote,
        },
      ],
    }),
    [chunk({ chunkText: quote })]
  );

  assert.equal(result.documentSupported.length, 0);
  assert.equal(result.rejected[0].reason, "subject_mismatch");
});

test("the guard covers the spaced unit spellings these manuals print too", () => {
  // "20 deg C", "180 degrees F", and "5 k ohms" are the same specifications as
  // "20°C" and "5 kilohms". A guard that silently covered only the unspaced
  // form would look complete while leaving the printed form ungated.
  const cases = [
    [
      "The thermostat opening temperature is 180 degrees F.",
      "Engine oil temperature warning threshold: 180 degrees F",
    ],
    [
      "The thermostat opening temperature is 82 deg C.",
      "Engine oil temperature warning threshold: 82 deg C",
    ],
    [
      "The engine coolant temperature sensor resistance is 5 k ohms.",
      "Intake air temperature sensor resistance: 5 k ohms",
    ],
  ];

  for (const [claim, quote] of cases) {
    const result = verifyEvidence(
      payload({ documentSupported: [{ claim, sourceId: "S1", evidenceQuote: quote }] }),
      [chunk({ chunkText: quote })]
    );

    assert.equal(result.documentSupported.length, 0, claim);
    assert.equal(result.rejected[0].reason, "subject_mismatch", claim);
  }
});

test("the electrical, speed, and temperature guards still accept a matching subject", () => {
  // Fail-closed must not mean fail-always: the same component in claim and quote
  // passes, exactly as it does for the four convertible families.
  const cases = [
    ["The battery voltage should read 12.6 volts.", "Battery voltage (engine off): 12.6 volts"],
    [
      "The engine coolant temperature sensor resistance is 2.4 kilohms.",
      "Engine coolant temperature sensor resistance: 2.4 kilohms",
    ],
    ["The idle speed is 700 rpm.", "Idle speed: 700 rpm"],
    ["The thermostat opening temperature is 82°C.", "Thermostat opening temperature: 82°C"],
  ];

  for (const [claim, quote] of cases) {
    const result = verifyEvidence(
      payload({ documentSupported: [{ claim, sourceId: "S1", evidenceQuote: quote }] }),
      [chunk({ chunkText: quote })]
    );

    assert.equal(result.rejected.length, 0, claim);
    assert.equal(result.documentSupported.length, 1, claim);
  }
});

test("a claim shape with no parsable subject keeps the numeric check only", () => {
  // The guard reads a named part out of a small set of sentence shapes. When it
  // cannot, it does not guess: the quote and numeric checks still stand alone.
  // Volts are guarded, but "produces ... volts" names no head noun, so this
  // passes even though the claim says alternator and the quote says charging
  // system -- a documented limit, not an endorsement.
  const quote = "Charging system output: 14.5 volts at idle";
  const result = verifyEvidence(
    payload({
      documentSupported: [
        {
          claim: "The alternator produces 14.5 volts at idle.",
          sourceId: "S1",
          evidenceQuote: quote,
        },
      ],
    }),
    [chunk({ chunkText: quote })]
  );

  assert.equal(result.rejected.length, 0);
  assert.equal(result.documentSupported.length, 1);
});

test("current in amps keeps only the numeric check, not the subject guard", () => {
  // Ordinary current wording ("draws 150 amps", "current draw") gives the
  // head-noun parser nothing to read, so amps were never meaningfully subject
  // guarded. The only way one got a subject was by borrowing an unrelated noun:
  // here "speed" would yield the subject "cooling fan current at high", which is
  // not a part name. Claiming that as coverage would overstate the guard.
  const quote = "Radiator fan motor draw: 15 amps";
  const wrongPart = verifyEvidence(
    payload({
      documentSupported: [
        {
          claim: "The cooling fan current at high speed is 15 amps.",
          sourceId: "S1",
          evidenceQuote: quote,
        },
      ],
    }),
    [chunk({ chunkText: quote })]
  );

  assert.equal(wrongPart.rejected.length, 0);
  assert.equal(wrongPart.documentSupported.length, 1);

  // The pre-existing numeric detector still recognizes amps: an invented value
  // is rejected exactly as before.
  const inventedValue = verifyEvidence(
    payload({
      documentSupported: [
        {
          claim: "The radiator fan motor draw is 25 amps.",
          sourceId: "S1",
          evidenceQuote: quote,
        },
      ],
    }),
    [chunk({ chunkText: quote })]
  );

  assert.equal(inventedValue.documentSupported.length, 0);
  assert.equal(inventedValue.rejected[0].reason, "numeric_anomaly");
});

test("a convertible-family claim keeps its own subject when it also names a temperature", () => {
  // The new head nouns must not steal the subject from the families that
  // already had one: "capacity" still decides this claim, not "temperature".
  const quote = "Engine oil capacity (with filter): 4.2 liters";
  const result = verifyEvidence(
    payload({
      documentSupported: [
        {
          claim: "The engine oil capacity is 4.2 liters at operating temperature.",
          sourceId: "S1",
          evidenceQuote: quote,
        },
      ],
    }),
    [chunk({ chunkText: quote })]
  );

  assert.equal(result.rejected.length, 0);
  assert.equal(result.documentSupported.length, 1);
});

test("a qualifier naming another guarded family no longer steals the subject", () => {
  // Regression: the four non-convertible head nouns were passed as one list, and
  // extractSpecSubject takes the LAST noun in the clause. So "at operating
  // temperature" hijacked a voltage claim, which then failed to match its own
  // quote and was rejected as subject_mismatch. Each detected unit family must
  // contribute only its own noun.
  const cases = [
    ["The battery voltage at operating temperature is 12.6 volts.", "Battery voltage: 12.6 volts"],
    ["The circuit resistance at operating temperature is 5 ohms.", "Circuit resistance: 5 ohms"],
    ["The idle speed at operating temperature is 700 rpm.", "Idle speed: 700 rpm"],
    ["The coolant temperature at idle speed is 82 degrees C.", "Coolant temperature: 82 degrees C"],
  ];

  for (const [claim, quote] of cases) {
    const result = verifyEvidence(
      payload({ documentSupported: [{ claim, sourceId: "S1", evidenceQuote: quote }] }),
      [chunk({ chunkText: quote })]
    );

    assert.equal(result.rejected.length, 0, claim);
    assert.equal(result.documentSupported.length, 1, claim);
  }
});

test("the qualifier shape still rejects a genuinely wrong component", () => {
  // Narrowing the noun list must not turn the guard fail-open: the same sentence
  // shape still has to catch a claim naming a part its quote does not name.
  const cases = [
    [
      "The battery voltage at operating temperature is 13.5 volts.",
      "Charging system output: 13.5 volts at idle",
    ],
    ["The idle speed at operating temperature is 700 rpm.", "Maximum cooling fan speed: 700 rpm"],
  ];

  for (const [claim, quote] of cases) {
    const result = verifyEvidence(
      payload({ documentSupported: [{ claim, sourceId: "S1", evidenceQuote: quote }] }),
      [chunk({ chunkText: quote })]
    );

    assert.equal(result.documentSupported.length, 0, claim);
    assert.equal(result.rejected[0].reason, "subject_mismatch", claim);
  }
});

// ---- N4: electrical unit symbols ----
//
// Manuals print electrical specifications as symbols more often than as words:
// "11 to 14 V", "500 mV", "12 Ω", "2.4 kΩ". Until symbols were detected, an
// invented value or a wrong component written that way passed as if the claim
// held no specification at all.

// Built from code points: the two ohm characters are indistinguishable on screen.
const OMEGA = String.fromCharCode(0x03a9); // Greek capital omega, the usual ohm symbol
const OHM_SIGN = String.fromCharCode(0x2126); // the dedicated ohm sign, a different code point
const NBSP = String.fromCharCode(0x00a0); // nonbreaking space

const verifySingleClaim = (claim, quote) =>
  verifyEvidence(payload({ documentSupported: [{ claim, sourceId: "S1", evidenceQuote: quote }] }), [
    chunk({ chunkText: quote }),
  ]);

test("V, mV, Ω, and kΩ are detected in the spacing forms extracted PDF text uses", () => {
  // A normal space, a nonbreaking space, or no space at all can sit between a
  // value and its symbol, and the ohm symbol arrives as either code point.
  const cases = [
    ["12.6 V", 12.6, "V"],
    ["12.6V", 12.6, "V"],
    [`12.6${NBSP}V`, 12.6, "V"],
    ["500 mV", 500, "mV"],
    ["500mV", 500, "mV"],
    [`12 ${OMEGA}`, 12, OMEGA],
    [`12${OMEGA}`, 12, OMEGA],
    [`12 ${OHM_SIGN}`, 12, OHM_SIGN],
    [`2.4 k${OMEGA}`, 2.4, `k${OMEGA}`],
    [`2.4k${OMEGA}`, 2.4, `k${OMEGA}`],
    [`2.4 k ${OMEGA}`, 2.4, `k ${OMEGA}`],
  ];

  for (const [text, value, unit] of cases) {
    const specs = extractSpecNumbers(`Standard: ${text}.`);

    assert.deepEqual(
      specs.map((spec) => ({ value: spec.value, unit: spec.unit })),
      [{ value, unit }],
      text
    );
  }
});

test("lowercase v, megavolts, and words starting with V are not read as a voltage", () => {
  // Symbols are matched case-sensitively on purpose. Reading every lowercase "v"
  // after a number as volts would gate ordinary prose, and "MV" is megavolts,
  // not millivolts. A bare lowercase "12 v" is deliberately not read as volts
  // either: that is a documented limit, not an oversight.
  for (const text of [
    "Connect the 2 vacuum hoses.",
    "Compare 2 vs 3 bolts.",
    "Check for 12 v at the fuse.",
    "The meter showed 500 MV.",
    "Replace the 2 V-belts.",
    "Inspect the 2 VVT sensors.",
  ]) {
    assert.deepEqual(extractSpecNumbers(text), [], text);
  }
});

test("a symbol value inside an identifier is not read as a specification", () => {
  // A connector or code name ending in digits and "V" is not a voltage, and a
  // decimal inside one must not restart as a partial value ("M1.5V" -> "5V"). A
  // value standing on its own, or wrapped in punctuation, still is.
  for (const [text, value, unit] of [
    ["Battery reads 12V.", 12, "V"],
    [`Resistance is 2${OMEGA}.`, 2, OMEGA],
    ["Battery reads (12V) at rest.", 12, "V"],
  ]) {
    assert.deepEqual(
      extractSpecNumbers(text).map((spec) => ({ value: spec.value, unit: spec.unit })),
      [{ value, unit }],
      text
    );
  }

  for (const text of [
    "Connector M12V is behind the dash.",
    "Code P012V is stored.",
    "Model M1.5V label.",
  ]) {
    assert.deepEqual(extractSpecNumbers(text), [], text);
  }

  const result = verifySingleClaim(
    "Unplug connector M12V before testing.",
    "Unplug the connector before testing."
  );

  assert.equal(result.rejected.length, 0);
  assert.equal(result.documentSupported.length, 1);
});

test("a hyphen before a symbol value keeps ranges and signed values checked", () => {
  // The identifier boundary deliberately does not refuse a preceding hyphen.
  // Hiding "16V" in "9-16V" or "9 V" in "-9 V" would leave nothing to check and
  // let a fabricated value pass. Only the unit-bearing endpoint is read, and the
  // sign is not kept -- both documented limits. "B-12V" still reads as "12 V"
  // for the same reason: an extra rejection, never a false verification.
  for (const [text, raw] of [
    ["Charging voltage: 9-16V.", "16V"],
    ["Charging voltage: 13.2-16.8V.", "16.8V"],
    ["Reference is -9 V.", "9 V"],
  ]) {
    assert.deepEqual(
      extractSpecNumbers(text).map((spec) => spec.raw),
      [raw],
      text
    );
  }

  for (const [claim, quote, unsupported] of [
    ["Charging voltage should be 9-16V.", "Charging voltage: 9-14V", "16V"],
    ["Charging voltage should be 13.2-16.8V.", "Charging voltage: 13.2-14.8V", "16.8V"],
    ["Reference should be -9 V.", "Reference: -5 V", "9 V"],
  ]) {
    assert.deepEqual(
      checkClaimNumbers(claim, quote),
      { grounded: false, unsupported: [unsupported] },
      claim
    );
  }
});

test("a matching electrical-symbol claim is verified, not merely invisible", () => {
  // These claims were also accepted before symbols were detected -- but only
  // because the verifier saw no specification to check. `checked` proves the
  // subject guard actually ran and passed.
  const cases = [
    ["The battery voltage is 12.6 V.", "Battery voltage (engine off): 12.6 V"],
    ["The battery voltage is 12.6V.", `Battery voltage (engine off): 12.6${NBSP}V`],
    ["The heated oxygen sensor voltage is 500 mV.", "Heated oxygen sensor voltage: 500 mV"],
    [`The fuel injector resistance is 12 ${OMEGA}.`, `Fuel injector resistance: 12 ${OMEGA}`],
    [`The fuel injector resistance is 12 ${OMEGA}.`, `Fuel injector resistance: 12 ${OHM_SIGN}`],
    [
      `The engine coolant temperature sensor resistance is 2 k${OMEGA}.`,
      `Engine coolant temperature sensor resistance: 2 k${OMEGA}`,
    ],
  ];

  for (const [claim, quote] of cases) {
    const result = verifySingleClaim(claim, quote);

    assert.equal(result.rejected.length, 0, claim);
    assert.equal(result.documentSupported.length, 1, claim);
    assert.equal(checkClaimSubject(claim, quote).checked, true, claim);
  }
});

test("a qualifier naming another guarded family does not steal a symbol claim's subject", () => {
  // PR #136's regression, re-proven through the symbol path: "V" contributes only
  // "voltage", so "at operating temperature" cannot hijack the parse and reject
  // the claim against its own quote.
  const claim = "The battery voltage at operating temperature is 12.6 V.";
  const quote = "Battery voltage: 12.6 V";
  const result = verifySingleClaim(claim, quote);

  assert.equal(result.rejected.length, 0);
  assert.equal(result.documentSupported.length, 1);
  assert.deepEqual(checkClaimSubject(claim, quote), {
    grounded: true,
    checked: true,
    subject: "battery",
  });
});

test("an invented electrical-symbol value is rejected and not reprinted", () => {
  const cases = [
    ["The battery voltage is 14.2 V.", "Battery voltage (engine off): 12.6 V", /14\.2/],
    [`The fuel injector resistance is 16 ${OMEGA}.`, `Fuel injector resistance: 12 ${OMEGA}`, /16/],
  ];

  for (const [claim, quote, invented] of cases) {
    const result = verifySingleClaim(claim, quote);

    assert.equal(result.documentSupported.length, 0, claim);
    assert.equal(result.rejected[0].reason, "numeric_anomaly", claim);
    assert.doesNotMatch(result.gaps.join(" "), invented, claim);
  }
});

test("an electrical-symbol claim citing a different component is rejected", () => {
  const cases = [
    ["The battery voltage is 13.5 V.", "Charging system output: 13.5 V at idle"],
    [`The fuel injector resistance is 12 ${OMEGA}.`, `Ignition coil primary resistance: 12 ${OMEGA}`],
    [
      `The engine coolant temperature sensor resistance is 2.4 k${OMEGA}.`,
      `Intake air temperature sensor resistance: 2.4 k${OMEGA}`,
    ],
  ];

  for (const [claim, quote] of cases) {
    const result = verifySingleClaim(claim, quote);

    assert.equal(result.documentSupported.length, 0, claim);
    assert.equal(result.rejected[0].reason, "subject_mismatch", claim);
  }
});

test("mV is not V, and kΩ is not Ω", () => {
  // Each pair differs by a factor of a thousand and neither is converted into
  // the other, so a claim naming the wrong symbol cannot borrow the figure.
  const cases = [
    ["The heated oxygen sensor voltage is 500 V.", "Heated oxygen sensor voltage: 500 mV"],
    [
      `The engine coolant temperature sensor resistance is 2 ${OMEGA}.`,
      `Engine coolant temperature sensor resistance: 2 k${OMEGA}`,
    ],
  ];

  for (const [claim, quote] of cases) {
    const result = verifySingleClaim(claim, quote);

    assert.equal(result.documentSupported.length, 0, claim);
    assert.equal(result.rejected[0].reason, "numeric_anomaly", claim);
  }
});

test("a spelled-out unit and its symbol still verify against each other", () => {
  // Detecting a symbol in the QUOTE must not break claims that were passing: a
  // quote printing "12.6 V" still supports "12.6 volts", and the reverse.
  const cases = [
    ["The battery voltage is 12.6 volts.", "Battery voltage (engine off): 12.6 V"],
    ["The battery voltage is 12.6 V.", "Battery voltage (engine off): 12.6 volts"],
    ["The heated oxygen sensor voltage is 500 millivolts.", "Heated oxygen sensor voltage: 500 mV"],
    ["The fuel injector resistance is 12 ohms.", `Fuel injector resistance: 12 ${OMEGA}`],
    [
      "The engine coolant temperature sensor resistance is 2.4 kilohms.",
      `Engine coolant temperature sensor resistance: 2.4 k${OMEGA}`,
    ],
    [
      `The engine coolant temperature sensor resistance is 2.4 k${OMEGA}.`,
      "Engine coolant temperature sensor resistance: 2.4 kOhm",
    ],
  ];

  for (const [claim, quote] of cases) {
    const result = verifySingleClaim(claim, quote);

    assert.equal(result.rejected.length, 0, claim);
    assert.equal(result.documentSupported.length, 1, claim);
  }
});

test("the ASCII ohm spellings were already covered and still are", () => {
  // "ohm", "kohm", and "kOhm" already matched the case-insensitive unit pattern
  // before symbols were added. This pins that; it does not extend it.
  for (const [text, value] of [
    ["5 ohm", 5],
    ["2.4 kohm", 2.4],
    ["2.4 kOhm", 2.4],
  ]) {
    assert.equal(extractSpecNumbers(text)[0]?.value, value, text);
  }

  const result = verifySingleClaim(
    "The engine coolant temperature sensor resistance is 2.4 kOhm.",
    "Intake air temperature sensor resistance: 2.4 kOhm"
  );

  assert.equal(result.documentSupported.length, 0);
  assert.equal(result.rejected[0].reason, "subject_mismatch");
});

// ---- N4: electrical values must equal the printed value ----
//
// Every other unit is compared within max(0.51 absolute, 2% relative). That
// slack exists for torque tables that print one figure in three units, and it
// is far too wide for electrical readings: it let 0.9 V pass against a printed
// 0.5 V, 12.4 V against a printed 12.6 V (a battery at 75% charge, not 100%),
// and 12 Ω against a printed 12.4 Ω. Volts, millivolts, ohms, kilohms, amps,
// and milliamps -- spelled out or as a symbol -- now need the printed number
// itself. "Exact" is NUMERIC equality: 12.40 and 12.4 are the same number.

test("an electrical value near, but not equal to, the printed value is not grounded", () => {
  const cases = [
    ["The sensor output is 0.9 V.", "Sensor output: 0.5 V"],
    ["The battery voltage is 12.4 V.", "Battery voltage (engine off): 12.6 V"],
    ["The battery voltage is 12.4 volts.", "Battery voltage (engine off): 12.6 volts"],
    ["The heated oxygen sensor voltage is 450 mV.", "Heated oxygen sensor voltage: 455 mV"],
    ["The heated oxygen sensor voltage is 450 millivolts.", "Heated oxygen sensor voltage: 455 millivolts"],
    [`The resistance is 12 ${OMEGA}.`, `Standard resistance: 12.5 ${OMEGA}`],
    ["The resistance is 12 ohms.", "Standard resistance: 12.5 ohms"],
    [`The sensor resistance is 2.3 k${OMEGA}.`, `Sensor resistance: 2.4 k${OMEGA}`],
    ["The sensor resistance is 2.3 kilohms.", "Sensor resistance: 2.4 kilohms"],
  ];

  for (const [claim, quote] of cases) {
    const result = checkClaimNumbers(claim, quote);

    assert.equal(result.grounded, false, `${claim} | ${quote}`);
    assert.equal(result.unsupported.length, 1, claim);
  }
});

test("a value inside a printed range is not grounded unless it is printed", () => {
  // The fuel injector table prints "11.6 to 12.4 Ω". A claim of 12 Ω is a
  // number the page never states, even though it falls inside the range.
  const quote = `Fuel injector resistance: 11.6 to 12.4 ${OMEGA} at 20°C (68°F)`;
  const rounded = verifySingleClaim(`The fuel injector resistance is 12 ${OMEGA}.`, quote);

  assert.equal(rounded.documentSupported.length, 0);
  assert.equal(rounded.rejected[0].reason, "numeric_anomaly");

  const printed = verifySingleClaim(`The fuel injector resistance is 12.4 ${OMEGA}.`, quote);

  assert.equal(printed.rejected.length, 0);
  assert.equal(printed.documentSupported.length, 1);
});

test("current in amps and milliamps must equal the printed value too", () => {
  const cases = [
    ["The radiator fan motor draw is 15.4 amps.", "Radiator fan motor draw: 15 amps"],
    ["The radiator fan motor draw is 15.4 amperes.", "Radiator fan motor draw: 15 amperes"],
    ["The parasitic draw limit is 49.5 milliamps.", "Parasitic draw limit: 50 milliamps"],
  ];

  for (const [claim, quote] of cases) {
    assert.equal(checkClaimNumbers(claim, quote).grounded, false, `${claim} | ${quote}`);
  }

  assert.equal(
    checkClaimNumbers("The radiator fan motor draw is 15 amps.", "Radiator fan motor draw: 15 amps").grounded,
    true
  );
});

test("exact means numeric equality, so formatting differences still match", () => {
  // A text comparison would reject every one of these.
  const cases = [
    [`The resistance is 12.40 ${OMEGA}.`, `Standard resistance: 12.4 ${OMEGA}`],
    [`The resistance is 12.400 ${OMEGA}.`, `Standard resistance: 12.4 ${OMEGA}`],
    [`The resistance is 12.4 ${OMEGA}.`, `Standard resistance: 12.40 ${OMEGA}`],
    [`The resistance is 12.4 ${OHM_SIGN}.`, `Standard resistance: 12.40 ${OMEGA}`],
    ["The resistance is 12.40 ohms.", `Standard resistance: 12.4 ${OMEGA}`],
    ["The battery voltage is 12 V.", "Battery voltage: 12.0 V"],
    ["The battery voltage is 12.60 volts.", "Battery voltage: 12.6 V"],
    ["The battery voltage is 12,6 V.", "Battery voltage: 12.6 V"],
    ["The heated oxygen sensor voltage is 500.0 mV.", "Heated oxygen sensor voltage: 500 mV"],
    [`The sensor resistance is 2.40 k${OMEGA}.`, "Sensor resistance: 2.4 kilohms"],
    ["The radiator fan motor draw is 15.0 amps.", "Radiator fan motor draw: 15 amps"],
  ];

  for (const [claim, quote] of cases) {
    const result = checkClaimNumbers(claim, quote);

    assert.equal(result.grounded, true, `${claim} | ${quote} | ${JSON.stringify(result)}`);
  }
});

test("a bare table number needs the exact value for an electrical claim", () => {
  // Some tables print the unit only in a column header, so the row holds a bare
  // number and the quote carries no unit-bearing specification at all. The
  // fallback that compares against those bare numbers is exact for electrical
  // claims as well.
  const resistanceRow = `Standard resistance (${OMEGA}): injector 12.5`;

  assert.equal(checkClaimNumbers(`The injector resistance is 12 ${OMEGA}.`, resistanceRow).grounded, false);
  assert.equal(checkClaimNumbers(`The injector resistance is 12.5 ${OMEGA}.`, resistanceRow).grounded, true);
  assert.equal(checkClaimNumbers(`The injector resistance is 12.50 ${OMEGA}.`, resistanceRow).grounded, true);

  const voltageRow = "Terminal voltage (V): 11 to 14";

  assert.equal(checkClaimNumbers("The terminal voltage is 13.6 V.", voltageRow).grounded, false);
  assert.equal(checkClaimNumbers("The terminal voltage is 14 V.", voltageRow).grounded, true);
});

test("every other unit keeps the existing tolerance", () => {
  // Pinned so the electrical rule cannot leak into the families it does not
  // cover. Each claim differs from its quote by an amount the shared
  // max(0.51, 2%) tolerance has always accepted.
  const cases = [
    ["Torque the drain plug to 37.5 Nm.", "Torque : 37 N·m"],
    ["The fuel pressure is 304 kPa.", "Fuel pressure: 300 kPa"],
    ["The engine oil capacity is 4.4 liters.", "Engine oil capacity: 4.2 liters"],
    ["The brake pad lining thickness is 1.2 mm.", "Brake pad lining thickness: 1.1 mm"],
    ["The thermostat opens at 83°C.", "Thermostat valve opening temperature: 84°C"],
    ["The idle speed is 710 rpm.", "Idle speed: 700 rpm"],
    ["The signal frequency is 50.5 Hz.", "Signal frequency: 50 Hz"],
  ];

  for (const [claim, quote] of cases) {
    assert.equal(checkClaimNumbers(claim, quote).grounded, true, `${claim} | ${quote}`);
  }

  // The bare-number fallback keeps its tolerance for these units as well.
  assert.equal(checkClaimNumbers("Torque to 37.4 Nm.", "Torque (N·m): 37").grounded, true);
});

// ---- N4: current symbols ----
//
// The manuals print current as "A" and "mA" -- heater-current thresholds, the
// throttle actuator, air-fuel ratio sensor current, and above all the fuse
// ratings on every wiring diagram ("10A", "30A HOT AT ALL TIMES"). Until these
// were detected, a claim of "0.5 A" passed with no numeric check at all. A fuse
// rating says nothing about any OTHER unit, though, so these symbols must leave
// torque, pressure, voltage, and every other check exactly as it was.

test("A and mA are detected as symbols in the forms extracted PDF text uses", () => {
  for (const [text, value, unit] of [
    ["0.3 A", 0.3, "A"],
    ["15A", 15, "A"],
    ["7.5A", 7.5, "A"],
    [`15${NBSP}A`, 15, "A"],
    ["(50 A)", 50, "A"],
    ["3.0 mA", 3, "mA"],
    ["3.6mA", 3.6, "mA"],
  ]) {
    const specs = extractSpecNumbers(`Standard: ${text} fuse.`);

    assert.deepEqual(
      specs.map((spec) => ({ value: spec.value, unit: spec.unit })),
      [{ value, unit }],
      text
    );
  }

  // Spelled "milliamperes" had slipped through: "milliamps" matched first and
  // then failed its word boundary.
  assert.deepEqual(
    extractSpecNumbers("Less than 1.0 milliamperes.").map((spec) => spec.value),
    [1]
  );
});

test("lowercase a, A/C and A/F, identifiers, and words starting with A are not read as current", () => {
  // Case-sensitive like the electrical symbols: a lowercase "a" would read the
  // refrigerant "HFC-134a" as 134 amps. A slash is refused after the symbol,
  // which the electrical symbols do not need, because "1 A/C" and "bank 1 A/F"
  // are part names here, never a current.
  for (const text of [
    "Charge with refrigerant HFC-134a.",
    "Inspect the bank 1 A/F sensor.",
    "Disconnect the 1 A/C pressure sensor.",
    "Connector M12A is behind the dash.",
    "Code P012A is stored.",
    "Remove the 2 ASSY bolts.",
  ]) {
    assert.deepEqual(extractSpecNumbers(text), [], text);
  }

  const result = verifySingleClaim(
    "Inspect the bank 1 A/F sensor.",
    "Inspect the air fuel ratio sensor. Standard voltage: 3.3 V"
  );

  assert.equal(result.rejected.length, 0);
  assert.equal(result.documentSupported.length, 1);
});

test("a current-symbol claim must equal a printed value", () => {
  const heater = "Heated oxygen sensor heater current less than 0.3 A (1 trip detection logic)";
  const afSensor = "Standard current: Less than 3.0 mA";
  const fuseBox = "HOT AT ALL TIMES 15A EFI 10A ECU-B";

  for (const [claim, quote] of [
    ["The heater current limit is 0.5 A.", heater],
    ["The heater current limit is 0.31 A.", heater],
    ["The sensor current must be less than 3.5 mA.", afSensor],
    ["The EFI fuse is rated 20 A.", fuseBox],
  ]) {
    assert.equal(checkClaimNumbers(claim, quote).grounded, false, `${claim} | ${quote}`);
  }

  for (const [claim, quote] of [
    ["The heater current limit is 0.3 A.", heater],
    ["The heater current limit is 0.30 A.", heater],
    ["The sensor current must be less than 3 mA.", afSensor],
    ["The EFI fuse is rated 15 A.", fuseBox],
    ["The EFI fuse is rated 15A.", fuseBox],
  ]) {
    assert.equal(checkClaimNumbers(claim, quote).grounded, true, `${claim} | ${quote}`);
  }
});

test("mA is not A", () => {
  // A factor of a thousand, never converted, exactly like mV and V.
  assert.equal(checkClaimNumbers("The draw is 300 mA.", "Standard current: 0.3 A").grounded, false);
  assert.equal(checkClaimNumbers("The draw is 0.3 A.", "Standard current: 300 mA").grounded, false);
});

test("a current symbol and its spelled-out unit verify against each other", () => {
  // The first quote is the charging-system check as printed. It also carries a
  // voltage, so before symbols were detected the spelled claim had no amp figure
  // to match and was rejected.
  const charging = "Standard current: 10 A or less Standard voltage: 13.2 to 14.8 V";

  for (const [claim, quote] of [
    ["The charging current should be 10 amps or less.", charging],
    ["The charging current should be 10 amperes or less.", charging],
    ["The radiator fan motor draw is 15 A.", "Radiator fan motor draw: 15 amps"],
    ["The sensor current is less than 3.0 milliamps.", "Standard current: Less than 3.0 mA"],
    ["The sensor current is less than 1.0 milliamperes.", "Standard current: Less than 1.0 mA"],
  ]) {
    assert.equal(checkClaimNumbers(claim, quote).grounded, true, `${claim} | ${quote}`);
  }

  assert.equal(checkClaimNumbers("The charging current is 10 milliamps.", charging).grounded, false);
});

test("a current claim cannot borrow a number printed in another unit", () => {
  // The quote's unit-bearing figure is a resistance, so "2" is not a current.
  assert.equal(
    checkClaimNumbers("The heater current is 2 A.", `Heater resistance: 2 ${OMEGA} at 20°C`).grounded,
    false
  );

  // A row whose unit sits only in a header still compares bare numbers, exactly.
  const ratingRow = "Fuse rating (A): EFI 15";

  assert.equal(checkClaimNumbers("The EFI fuse is 15 A.", ratingRow).grounded, true);
  assert.equal(checkClaimNumbers("The EFI fuse is 15.0 A.", ratingRow).grounded, true);
  assert.equal(checkClaimNumbers("The EFI fuse is 15.5 A.", ratingRow).grounded, false);
});

test("a current symbol in the quote leaves every other unit's check unchanged", () => {
  // Most wiring diagrams print a fuse rating and nothing else unit-bearing. Had
  // "10A" counted as the quote's specification, the header-table fallback would
  // have stopped for every torque, pressure, or voltage claim citing such a
  // page: measured on the real corpus, 667 chunks and 224,067 verdicts.
  const torqueRow = "Specified torque (N·m): mounting bolt 37. ECU-B 10A";
  const voltageRow = "Terminal voltage (V): 11 to 14. EFI 15A";

  assert.equal(checkClaimNumbers("The mounting bolt torque is 37 N·m.", torqueRow).grounded, true);
  assert.equal(checkClaimNumbers("The mounting bolt torque is 37.4 N·m.", torqueRow).grounded, true);
  assert.equal(checkClaimNumbers("The mounting bolt torque is 39 N·m.", torqueRow).grounded, false);
  assert.equal(checkClaimNumbers("The terminal voltage is 14 V.", voltageRow).grounded, true);
  assert.equal(checkClaimNumbers("The terminal voltage is 13.6 V.", voltageRow).grounded, false);

  // Nor can a current figure support another unit when the quote does print one.
  assert.equal(
    checkClaimNumbers("Torque the bracket bolt to 10 N·m.", "EFI 10A. Bracket bolt: 37 N·m").grounded,
    false
  );
});

test("an invented current value is rejected and not reprinted", () => {
  const result = verifySingleClaim("The EFI fuse is rated 20 A.", "HOT AT ALL TIMES 15A EFI");

  assert.equal(result.documentSupported.length, 0);
  assert.equal(result.rejected[0].reason, "numeric_anomaly");
  assert.doesNotMatch(result.gaps.join(" "), /20/);
});

test("unsourced guidance naming a current is removed, like any other specification", () => {
  const result = verifyEvidence(
    payload({ generalGuidance: ["Replace it with a 15A fuse of the same rating."] }),
    [chunk()]
  );

  assert.deepEqual(result.generalGuidance, []);
  assert.equal(result.rejected[0].reason, "unsourced_specification");
  assert.doesNotMatch(result.gaps.join(" "), /15/);
});

test("a current-symbol claim keeps only the numeric check, not the subject guard", () => {
  // As with spelled-out amps: current wording gives the head-noun parser no part
  // name to read, so no subject is claimed.
  assert.deepEqual(
    checkClaimSubject("The cooling fan current at high speed is 15 A.", "Radiator fan motor draw: 15 A"),
    { grounded: true, checked: false, subject: "" }
  );
});

// ---- Subject guard: word order and generic words (Experiment D, 2026-09-27) ----
//
// The first live answer eval after N4 found the subject guard rejecting CORRECT
// claims against their own verbatim quotes. Every part word was in the quote --
// just not as one unbroken run in the claim's order. The first and last pairs
// are real claim and quote text from that run, byte for byte; the two injector
// wordings were reproduced offline against the real table row.

test("a correct claim naming the part in a different word order is verified", () => {
  const cases = [
    // Live, 4 of 4 observations: the quote names the part after "of the".
    [
      "The thermostat valve opening temperature standard value is 80 to 84°C (176 to 183°F).",
      "Measure the valve opening temperature of the thermostat. Standard value: 80 to 84°C (176 to 183°F)",
    ],
    // The quote has "assembly" between the part and the qualifier.
    [
      `The fuel injector standard resistance is 11.6 to 12.4 ${OMEGA} at 20°C (68°F).`,
      `Fuel injector assembly Standard resistance 11.6 to 12.4 ${OMEGA} at 20°C (68°F)`,
    ],
    // The qualifier leads the part in the claim and trails it in the quote.
    [
      `The standard fuel injector resistance is 11.6 to 12.4 ${OMEGA} at 20°C (68°F).`,
      `Fuel injector assembly Standard resistance 11.6 to 12.4 ${OMEGA} at 20°C (68°F)`,
    ],
  ];

  for (const [claim, quote] of cases) {
    const result = verifySingleClaim(claim, quote);

    assert.deepEqual(result.rejected, [], claim);
    assert.equal(result.documentSupported.length, 1, claim);
  }
});

test("a correct claim adding the generic word 'system' is verified", () => {
  // Live, 3 of 11 fuel-pressure observations: the model echoed the question's
  // "fuel system pressure", and the quote says "fuel pressure". "System" names
  // no component, so its absence from the quote is not a different part.
  const result = verifySingleClaim(
    "The standard fuel system pressure is 304 to 343 kPa (3.1 to 3.5 kgf/cm2, 44.1 to 49.7 psi).",
    "Fuel pressure Standard fuel pressure 304 to 343 kPa (3.1 to 3.5 kgf*cm2, 44.1 to 49.7 psi)"
  );

  assert.deepEqual(result.rejected, []);
  assert.equal(result.documentSupported.length, 1);
});

test("a correct claim adding the procedure word 'installation' is verified", () => {
  // Live, 2 claims in the same run: the quote says "Install the water drain
  // cock", the claim says "water drain cock installation torque". The word
  // names the step, not the part.
  const result = verifySingleClaim(
    "The water drain cock installation torque is 20 Nm (204 kgf-cm, 15 ft-lbf).",
    "Install the water drain cock as shown in the illustration. Torque : 20 Nm (204 kgf-cm, 15 ft-lbf)"
  );

  assert.deepEqual(result.rejected, []);
  assert.equal(result.documentSupported.length, 1);
});

// The relaxations above must not become a general "all the words are in there
// somewhere" rule. Each case below is a WRONG part whose words all occur in the
// quote. Measured on 2026-09-27: set membership over the quote or a clause, and
// an ordered subsequence, each accept several of these; the current contiguous
// rule rejects every one, and must keep doing so.
test("the word-order relaxation still rejects a different part built from the quote's words", () => {
  const cases = [
    // Flattened table rows: the values are the only thing between two labels.
    ["The front brake pad thickness is 1.0 mm.", "Front brake disc thickness 25.0 mm Rear brake pad thickness 1.0 mm"],
    [
      "The rear engine mounting insulator bolt torque is 52 Nm.",
      "Front engine mounting insulator bolt 52 530 38 Rear engine mounting bracket bolt 87 887 64",
    ],
    [
      `The left front wheel speed sensor resistance is 1.2 k${OMEGA}.`,
      `Right front wheel speed sensor 1.2 k${OMEGA} Left rear wheel speed sensor 1.4 k${OMEGA}`,
    ],
    // One label naming two sides.
    ["The front brake pad thickness is 1.0 mm.", "Rear brake pad and front disc minimum thickness: 1.0 mm"],
    // The claim names a shorter part than the quote: "EGR valve" is not the
    // valve of the EGR cooler bypass, and "drive shaft nut" is not the drive
    // shaft bearing lock nut.
    [
      "The EGR valve opening temperature is 95°C.",
      "Measure the valve opening temperature of the EGR cooler bypass. Standard value: 95°C",
    ],
    ["The drive shaft nut torque is 216 Nm.", "Drive shaft bearing lock nut 216 N*m"],
    // "standard" may move, but it must still be there: a minimum is not a standard.
    ["The standard brake disc thickness is 10.0 mm.", "Brake disc minimum thickness: 10.0 mm"],
    // ...and it must be there in the SAME row. In a flattened table the brake
    // pad's "standard" is not the brake disc's; 10.0 mm is the disc minimum.
    [
      "The standard brake disc thickness is 10.0 mm.",
      "Brake pad standard thickness 12.0 mm Brake disc minimum thickness 10.0 mm",
    ],
    // "system" is optional, but the system it names is not.
    ["The cooling system pressure is 304 kPa.", "Fuel pressure: 304 kPa"],
    ["The system pressure is 304 kPa.", "Fuel pressure: 304 kPa"],
  ];

  for (const [claim, quote] of cases) {
    const subject = checkClaimSubject(claim, quote);

    assert.equal(subject.checked, true, `no subject was parsed: ${claim}`);
    assert.equal(subject.grounded, false, `${claim} was accepted against: ${quote}`);
  }
});

test("the letter A gets the same word-order reading as any other letter", () => {
  // The phrase readings were built from lowercased words, where a letter A is
  // indistinguishable from the article: it was dropped from every reading, and
  // "the bolt A of" stopped the search for the owned phrase as if it were "a".
  // So "Bolt B" could be read across "of" and "Bolt A" never could.
  const shapes = [
    [
      (letter) => `The water pump Bolt ${letter} torque is 26 N·m.`,
      (letter) => `Tighten the bolt ${letter} of the water pump. Torque: 26 N·m`,
    ],
    [
      (letter) => `The sensor ${letter} resistance is 2.4 k${OMEGA}.`,
      (letter) => `Resistance of sensor ${letter}: 2.4 k${OMEGA}`,
    ],
  ];

  for (const [claim, quote] of shapes) {
    for (const letter of ["A", "B"]) {
      const result = verifySingleClaim(claim(letter), quote(letter));

      assert.deepEqual(result.rejected, [], `${claim(letter)} <= ${quote(letter)}`);
      assert.equal(result.documentSupported.length, 1, claim(letter));
    }

    // Still the letter that was quoted, in either direction.
    for (const [claimed, quoted] of [["A", "B"], ["B", "A"]]) {
      const result = verifySingleClaim(claim(claimed), quote(quoted));

      assert.equal(result.documentSupported.length, 0, `${claim(claimed)} <= ${quote(quoted)}`);
      assert.equal(result.rejected[0].reason, "subject_mismatch");
    }
  }
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

test("an unsupported specification supplied in a gap is redacted before rendering", () => {
  const result = verifyEvidence(
    payload({ gaps: ["The oil filter cap torque is 54 Nm."] }),
    [chunk()]
  );

  assert.equal(result.rejected[0].reason, "unsourced_gap_specification");
  assert.doesNotMatch(result.gaps.join(" "), /54 Nm/);
  assert.match(result.gaps.join(" "), /\[unverified value\]/);
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

// ---- Rejection metadata ----
//
// The declared enums are what the response contract and the metrics sanitizer
// are built from. If verifyEvidence ever emits a reason or channel that is not
// declared, the sanitizer drops the entry and the telemetry silently loses a
// rejection — so drive every path and check the declarations cover them.

/** One payload that trips all six rejection paths at once. */
function everyRejection() {
  return verifyEvidence(
    payload({
      documentSupported: [
        // unknown_source
        { claim: "a", sourceId: "S9", evidenceQuote: "Torque : 37 Nm" },
        // quote_not_in_source
        { claim: "b", sourceId: "S1", evidenceQuote: "A sentence not on the page." },
        // numeric_anomaly
        {
          claim: "The oil drain plug torque is 54 Nm.",
          sourceId: "S1",
          evidenceQuote: "Torque : 37 Nm",
        },
        // subject_mismatch — a genuinely verbatim quote carrying the same
        // value, so it clears the source, quote, and numeric checks and can
        // only fail on the part name.
        {
          claim: "Torque the oil filter cap to 37 Nm.",
          sourceId: "S1",
          evidenceQuote: "the oil drain plug with a new gasket. Torque : 37 Nm",
        },
      ],
      // unsourced_specification
      generalGuidance: ["Tighten it to about 40 Nm."],
      // unsourced_gap_specification
      gaps: ["The manual does not give the 12 Nm sensor torque."],
    }),
    [chunk()]
  );
}

test("every rejection reason the verifier can emit is declared", () => {
  const emitted = new Set(everyRejection().rejected.map((entry) => entry.reason));

  assert.equal(emitted.size, ASK_REJECTION_REASONS.length, "not every path was exercised");

  for (const reason of emitted) {
    assert.ok(ASK_REJECTION_REASONS.includes(reason), `undeclared reason: ${reason}`);
  }
});

test("every rejection carries a declared channel and its index in that channel", () => {
  const rejected = everyRejection().rejected;

  for (const entry of rejected) {
    assert.ok(
      ASK_REJECTION_CHANNELS.includes(entry.channel),
      `undeclared channel: ${entry.channel}`
    );
    assert.ok(Number.isInteger(entry.itemIndex) && entry.itemIndex >= 0, "bad itemIndex");
  }

  const byReason = new Map(rejected.map((entry) => [entry.reason, entry]));

  // The index must point back into the model's ORIGINAL channel array, so a
  // reader can line a rejection up against the reply that produced it.
  assert.equal(byReason.get("unknown_source").channel, "documentSupported");
  assert.equal(byReason.get("unknown_source").itemIndex, 0);
  assert.equal(byReason.get("subject_mismatch").itemIndex, 3);
  assert.equal(byReason.get("unsourced_specification").channel, "generalGuidance");
  assert.equal(byReason.get("unsourced_specification").itemIndex, 0);
  assert.equal(byReason.get("unsourced_gap_specification").channel, "gaps");
  assert.equal(byReason.get("unsourced_gap_specification").itemIndex, 0);
});

test("a document-channel rejection reports the source label the model named", () => {
  const byReason = new Map(everyRejection().rejected.map((entry) => [entry.reason, entry]));

  // Including the label that did not resolve — that is the diagnostic value.
  assert.equal(byReason.get("unknown_source").sourceId, "S9");
  assert.equal(byReason.get("numeric_anomaly").sourceId, "S1");
  // Guidance and gaps are not sourced, so there is no label to report.
  assert.equal(byReason.get("unsourced_specification").sourceId, null);
  assert.equal(byReason.get("unsourced_gap_specification").sourceId, null);
});

test("the detailed rejection fields stay available for server-side diagnosis", () => {
  // These are what the metrics sanitizer must strip. Their continued presence
  // here is the reason the sanitizer exists, so assert they are still produced.
  const byReason = new Map(everyRejection().rejected.map((entry) => [entry.reason, entry]));

  assert.match(byReason.get("numeric_anomaly").claim, /54 Nm/);
  assert.ok(byReason.get("numeric_anomaly").unsupported.some((raw) => raw.includes("54")));
  assert.equal(byReason.get("subject_mismatch").subject, "oil filter cap");
});

// ---- Letter designators ----
//
// Manuals name parts by letter: "Bolt A", "Connector C", Speed Sensor "A". The
// subject parser ignores the article "a", and it used to drop the letter A along
// with it, so a claim about Bolt A was checked as a claim about "bolt" and a
// quote about Bolt B certified it. B through H were never dropped: only A was.

test("a claim about Bolt A is not certified by the quote for Bolt B", () => {
  // From a real V-ribbed belt page, where Bolt A is 19 N*m and Bolt B is 43 N*m.
  // Stating Bolt B's value for Bolt A passed as "bolt".
  const quote = "Torque: Bolt B: 43 N*m (438 kgf*cm, 32 ft*lbf)";
  const result = verifyEvidence(
    payload({
      documentSupported: [
        { claim: "The Bolt A torque is 43 N·m.", sourceId: "S1", evidenceQuote: quote },
      ],
    }),
    [chunk({ chunkText: quote })]
  );

  assert.equal(result.documentSupported.length, 0);
  assert.equal(result.rejected[0].reason, "subject_mismatch");
  assert.equal(result.rejected[0].subject, "bolt a");
});

test("a lettered part is not certified by a quote naming another letter", () => {
  const cases = [
    // The cooling specifications table: water pump Bolt A is 26 N*m, Bolt B 24.
    [
      "The water pump Bolt A torque is 24 N·m (245 kgf·cm, 18 ft·lbf).",
      "Water pump Bolt B torque 24 N·m (245 kgf·cm, 18 ft·lbf)",
    ],
    // The letter has to END the parsed subject to have been lost: "Connector A
    // terminal 1" against "Connector C terminal 1" was already rejected, because
    // the quote's "c" breaks the run.
    [
      `The Connector A resistance is 10 k${OMEGA} or higher.`,
      `Connector C resistance 10 k${OMEGA} or higher`,
    ],
    // Diagnostic trouble code names print the letter in quotation marks.
    [
      'The Vehicle Speed Sensor "A" voltage is 4.5 V.',
      'Vehicle Speed Sensor "B" voltage 4.5 V',
    ],
  ];

  for (const [claim, quote] of cases) {
    const result = verifyEvidence(
      payload({ documentSupported: [{ claim, sourceId: "S1", evidenceQuote: quote }] }),
      [chunk({ chunkText: quote })]
    );

    assert.equal(result.documentSupported.length, 0, claim);
    assert.equal(result.rejected[0].reason, "subject_mismatch", claim);
  }
});

test("a lettered part is still certified by a quote naming the same letter", () => {
  const cases = [
    ["The Bolt A torque is 19 N·m.", "Torque: Bolt A: 19 N*m (190 kgf*cm, 14 ft*lbf)"],
    ["The Bolt B torque is 43 N·m.", "Torque: Bolt B: 43 N*m (438 kgf*cm, 32 ft*lbf)"],
    [
      "The water pump Bolt A torque is 26 N·m (260 kgf·cm, 18 ft·lbf).",
      "Water pump Bolt A torque 26 N·m (260 kgf·cm, 18 ft·lbf)",
    ],
    [
      `The Connector A resistance is 10 k${OMEGA} or higher.`,
      `Connector A resistance 10 k${OMEGA} or higher`,
    ],
    // Quotation marks or brackets around the letter do not change which part it is.
    ['The Vehicle Speed Sensor "A" voltage is 4.5 V.', "Vehicle Speed Sensor (A) voltage 4.5 V"],
  ];

  for (const [claim, quote] of cases) {
    const result = verifyEvidence(
      payload({ documentSupported: [{ claim, sourceId: "S1", evidenceQuote: quote }] }),
      [chunk({ chunkText: quote })]
    );

    assert.equal(result.rejected.length, 0, claim);
    assert.equal(result.documentSupported.length, 1, claim);
  }
});

test("the article a is still never part of the subject", () => {
  // Only a capital A standing alone right after another word is read as a
  // letter. The article -- lowercase mid-sentence, capitalized at the start --
  // is ignored exactly as before, on both the claim and the quote side, so a
  // paraphrase that adds or drops it is not rejected over it.
  const cases = [
    ["Tighten a bolt to 24 N·m.", "Tighten the bolt. Torque : 24 N·m", "bolt"],
    ["A new drain plug torque is 37 Nm.", "Install a new drain plug. Torque : 37 Nm", "new drain plug"],
    [
      "Torque the oil drain plug using a new gasket to 37 Nm.",
      "Install the oil drain plug using new gasket. Torque : 37 Nm",
      "oil drain plug using new gasket",
    ],
    [
      "Torque the oil drain plug using new gasket to 37 Nm.",
      "Install the oil drain plug using a new gasket. Torque : 37 Nm",
      "oil drain plug using new gasket",
    ],
  ];

  for (const [claim, quote, subject] of cases) {
    const result = verifyEvidence(
      payload({ documentSupported: [{ claim, sourceId: "S1", evidenceQuote: quote }] }),
      [chunk({ chunkText: quote })]
    );

    assert.equal(checkClaimSubject(claim, quote).subject, subject, claim);
    assert.equal(result.rejected.length, 0, claim);
    assert.equal(result.documentSupported.length, 1, claim);
  }
});

test("the A of an acronym such as A/F is not read as a letter", () => {
  // "A/F" (air-fuel) and "A/C" split into pieces, and their A was dropped as the
  // article. It still is: only an A standing alone as a word is a letter, so
  // these subjects are unchanged.
  const quote = `A/F sensor heater resistance 1.8 ${OMEGA}`;
  const claim = `The A/F sensor heater resistance is 1.8 ${OMEGA}.`;

  assert.equal(checkClaimSubject(claim, quote).subject, "f sensor heater");
  assert.equal(checkClaimSubject(claim, quote).grounded, true);
});

test('"this" is ignored like the other determiners', () => {
  // "this" was on the ignore list but never matched it: the plural rule had
  // already shortened it to "thi", so "this bolt" demanded a word "thi".
  const claim = "Tighten this bolt to 24 N·m.";
  const quote = "Tighten the bolt. Torque : 24 N·m";
  const result = verifyEvidence(
    payload({ documentSupported: [{ claim, sourceId: "S1", evidenceQuote: quote }] }),
    [chunk({ chunkText: quote })]
  );

  assert.equal(checkClaimSubject(claim, quote).subject, "bolt");
  assert.equal(result.rejected.length, 0);
  assert.equal(result.documentSupported.length, 1);
});
