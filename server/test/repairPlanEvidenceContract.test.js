import assert from "node:assert/strict";
import test from "node:test";

// Pure validation: no database, no network. Safe to import directly.
import {
  buildRepairPlanEvidence,
  buildRequirementGroups,
  deriveEvidenceStatus,
  describeRejections,
  normalizeRequirementName,
  validateFinalizerPayload,
  verifyClaims,
} from "../src/services/agent/repairPlanEvidenceContract.js";

// --- Fixtures --------------------------------------------------------------

const BRAKE_TEXT =
  "Front brake pad replacement: torque the caliper bolts to 25 ft-lb, " +
  "fit new brake pads, and bleed the system with a 10 mm wrench.";

const COOLANT_TEXT = "Coolant capacity is 6.1 quarts. Do not open a hot cooling system.";

function makeSource(id, text, overrides = {}) {
  return {
    id,
    documentId: 7,
    documentTitle: "Brake Service Guide",
    originalFilename: "brake-guide.pdf",
    pageNumber: 4,
    chunkIndex: 1,
    chunkText: text,
    evidenceText: text,
    snippet: text.slice(0, 40),
    ...overrides,
  };
}

const SOURCES = [makeSource("S1", BRAKE_TEXT), makeSource("S2", COOLANT_TEXT, { pageNumber: 9 })];

const TASKS = [
  { id: 1, title: "Replace front brake pads", system: "Brakes", difficulty: "beginner", compound: false, clauses: [] },
];

// The quote runs from the line's own label, so it names the task's part (brake
// pads) as well as the claim's (caliper bolts) -- a specification must share a
// part word with its task (1A-06).
function claim(overrides = {}) {
  return {
    taskId: 1,
    kind: "numeric_spec",
    claim: "torque the caliper bolts to 25 ft-lb",
    sourceId: "S1",
    evidenceQuote: "Front brake pad replacement: torque the caliper bolts to 25 ft-lb",
    ...overrides,
  };
}

function build(claims, options = {}) {
  return buildRepairPlanEvidence(
    { claims },
    {
      tasks: options.tasks || TASKS,
      sources: options.sources || SOURCES,
      availableTools: options.availableTools || [],
      availableParts: options.availableParts || [],
    }
  );
}

// --- Shape validation ------------------------------------------------------

test("a well-formed claim citing a real source passes", () => {
  const result = build([claim()]);

  assert.equal(result.valid, true);
  assert.equal(result.verifiedClaims.length, 1);
  assert.equal(result.rejectedCount, 0);
  assert.match(result.text, /25 ft-lb/);
});

test("structural problems are reported rather than thrown", () => {
  const sourceIds = new Set(["S1"]);

  const unknownField = validateFinalizerPayload({ claims: [claim({ extra: 1 })] }, { tasks: TASKS, sourceIds });
  assert.equal(unknownField.valid, false);
  assert.match(unknownField.errors.join(" "), /unknown field "extra"/);

  const unknownTask = validateFinalizerPayload({ claims: [claim({ taskId: 99 })] }, { tasks: TASKS, sourceIds });
  assert.match(unknownTask.errors.join(" "), /not a canonical task id/);

  const unknownKind = validateFinalizerPayload({ claims: [claim({ kind: "vibes" })] }, { tasks: TASKS, sourceIds });
  assert.match(unknownKind.errors.join(" "), /not a recognized kind/);

  const unknownSource = validateFinalizerPayload({ claims: [claim({ sourceId: "S9" })] }, { tasks: TASKS, sourceIds });
  assert.match(unknownSource.errors.join(" "), /not a retrieved source/);

  const missingItemName = validateFinalizerPayload(
    { claims: [claim({ kind: "required_tool" })] },
    { tasks: TASKS, sourceIds }
  );
  assert.match(missingItemName.errors.join(" "), /itemName is required/);

  const notAnObject = validateFinalizerPayload("nope", { tasks: TASKS, sourceIds });
  assert.equal(notAnObject.valid, false);
});

// --- Verification ----------------------------------------------------------

test("a fabricated quote is rejected", () => {
  const result = build([
    claim({
      claim: "torque the caliper bolts to 90 ft-lb",
      evidenceQuote: "torque the caliper bolts to 90 ft-lb",
    }),
  ]);

  assert.equal(result.verifiedClaims.length, 0);
  assert.equal(result.rejectedCount, 1);
  assert.equal(result.evidenceStatus, "not_found");
});

test("a paraphrase of a real quote is rejected", () => {
  // The quote is genuine; the sentence built from it is not. This is exactly
  // how an invented specification acquires a real-looking citation.
  const result = build([
    claim({
      claim: "torque the caliper bolts to roughly twenty-five foot-pounds",
      evidenceQuote: "torque the caliper bolts to 25 ft-lb",
    }),
  ]);

  assert.equal(result.verifiedClaims.length, 0);
  assert.equal(result.rejectedCount, 1);
});

test("a source containing 25 ft-lb cannot verify 54 Nm, and the number is not reprinted", () => {
  const result = build([
    claim({
      claim: "torque the caliper bolts to 54 Nm",
      // A quote that really is in the source, attached to a claim that is not.
      evidenceQuote: "torque the caliper bolts to 25 ft-lb",
    }),
  ]);

  assert.equal(result.verifiedClaims.length, 0);
  assert.doesNotMatch(result.text, /54/, "the unverified value must not reach the plan");

  const gapText = result.gaps.join(" ");
  assert.match(gapText, /unverified statement/i);
  assert.doesNotMatch(gapText, /54/, "the unverified value must not be reprinted in the gaps either");
});

test("a required_tool whose itemName is absent from its own claim is rejected", () => {
  const result = build([
    claim({
      kind: "required_tool",
      claim: "torque the caliper bolts to 25 ft-lb",
      itemName: "spring compressor",
    }),
  ]);

  assert.equal(result.verifiedClaims.length, 0);
  assert.equal(result.rejectedCount, 1);
});

test("a claim may cite a source that was retrieved for another task", () => {
  const tasks = [
    ...TASKS,
    { id: 2, title: "Check the coolant", system: "Cooling", difficulty: "beginner", compound: false, clauses: [] },
  ];

  // One chunk can legitimately support two tasks; source ids are run-wide.
  const result = build(
    [
      claim(),
      claim({ taskId: 2, kind: "vehicle_fact", claim: "Coolant capacity is 6.1 quarts", sourceId: "S2", evidenceQuote: "Coolant capacity is 6.1 quarts" }),
    ],
    { tasks }
  );

  assert.equal(result.valid, true);
  assert.equal(result.verifiedClaims.length, 2);
});

// --- Claim placement (1A-05) -----------------------------------------------
//
// A claim is a span of its quote, and its quote is a span of the source. Where
// the claim sits decides what it means: "apply grease to the pads" is the
// opposite instruction when the source says "Do not" right before it.

function verifyAgainst(text, overrides, taskTitle = "Replace front brake pads") {
  return verifyClaims([claim(overrides)], {
    sourcesById: new Map([["S1", makeSource("S1", text)]]),
    tasks: [{ id: 1, title: taskTitle, compound: false, clauses: [] }],
  });
}

const GREASE_TEXT = "Do not apply grease to the friction surface of the brake pads.";

test("a claim that leaves out a leading 'Do not' is rejected as a dropped negation", () => {
  const { accepted, rejected } = verifyAgainst(GREASE_TEXT, {
    kind: "safety_instruction",
    claim: "apply grease to the friction surface of the brake pads",
    evidenceQuote: "Do not apply grease to the friction surface of the brake pads",
  });

  assert.equal(accepted.length, 0);
  assert.equal(rejected[0].reason, "negation_dropped");
});

test("trimming the negation off the quote as well does not launder it", () => {
  // The quote really is in the source and the claim is all of it, but the
  // source says "Do not" right before both. The negation check reads the
  // source the model was shown, not the quote the model chose.
  for (const kind of ["safety_instruction", "procedure", "vehicle_fact", "numeric_spec"]) {
    const { accepted, rejected } = verifyAgainst(GREASE_TEXT, {
      kind,
      claim: "apply grease to the friction surface of the brake pads",
      evidenceQuote: "apply grease to the friction surface of the brake pads",
    });

    assert.equal(accepted.length, 0, kind);
    assert.equal(rejected[0].reason, "negation_dropped", kind);
  }
});

test("never, don't, and without in the three words before a claim all count as negation", () => {
  const cases = [
    ["Never reuse the drain plug gasket.", "reuse the drain plug gasket"],
    ["Don't open the radiator cap while the engine is hot.", "open the radiator cap while the engine is hot"],
    ["Install the bolt without applying thread locker.", "applying thread locker"],
  ];

  for (const [text, statement] of cases) {
    const { rejected } = verifyAgainst(text, { kind: "procedure", claim: statement, evidenceQuote: statement });
    assert.equal(rejected[0]?.reason, "negation_dropped", statement);
  }
});

test("a negation in an earlier sentence does not block the next one", () => {
  const { accepted } = verifyAgainst("Do not reuse the gasket. Replace the gasket with a new one.", {
    kind: "procedure",
    claim: "Replace the gasket with a new one",
    evidenceQuote: "Replace the gasket with a new one",
  });

  assert.equal(accepted.length, 1);
});

test("an un-negated occurrence is found even when a negated one comes first", () => {
  const { accepted } = verifyAgainst("Do not tighten the bolt yet. Tighten the bolt after the hose is connected.", {
    kind: "procedure",
    claim: "Tighten the bolt",
    evidenceQuote: "Tighten the bolt",
  });

  assert.equal(accepted.length, 1);
});

test("a specification must be a whole clause of its quote", () => {
  const text = "Caliper slide pin bolt torque: 34 N*m. Caliper bracket bolt torque: 107 N*m.";
  const quote = "Caliper slide pin bolt torque: 34 N*m. Caliper bracket bolt torque: 107 N*m";
  const task = "Tighten the caliper slide pin bolts";

  // Starting at "torque" drops the part the 107 belongs to; filed under the
  // slide-pin task it would read as the slide pins' torque (the source says 34).
  const cut = verifyAgainst(text, { claim: "torque: 107 N*m", evidenceQuote: quote }, task);
  assert.equal(cut.accepted.length, 0);
  assert.equal(cut.rejected[0].reason, "not_whole_clause");

  // The whole second sentence names its own part and may be shown.
  const whole = verifyAgainst(text, { claim: "Caliper bracket bolt torque: 107 N*m", evidenceQuote: quote }, task);
  assert.equal(whole.accepted.length, 1);
});

test("a safety instruction may not stop short of the end of its clause", () => {
  const text = "Do not open the radiator cap while the engine is hot; wait until it cools.";
  const quote = "Do not open the radiator cap while the engine is hot; wait until it cools";

  const short = verifyAgainst(text, { kind: "safety_instruction", claim: "Do not open the radiator cap", evidenceQuote: quote });
  assert.equal(short.rejected[0]?.reason, "not_whole_clause");

  const whole = verifyAgainst(text, {
    kind: "safety_instruction",
    claim: "Do not open the radiator cap while the engine is hot",
    evidenceQuote: quote,
  });
  assert.equal(whole.accepted.length, 1, "a clause ending at ';' is whole");
});

test("a whole sentence that ends with its own period is a whole clause though its quote goes on", () => {
  // Found by the live planner runs: a model quotes a few sentences and claims
  // one of them, period included. The clause ends at that period; the text
  // after it in the quote is the next sentence, not a part the claim cut off.
  // PDF extraction often leaves a space before the period, and list items run
  // "a. ... b. ...".
  const text = "CAUTION: Set the parking brake before raising the vehicle . a. Check the hoses. b. Check that the clamps are tight. c. Start the engine.";
  const quote = "CAUTION: Set the parking brake before raising the vehicle . a. Check the hoses. b. Check that the clamps are tight. c. Start the engine";

  for (const statement of [
    "Set the parking brake before raising the vehicle .",
    "Check that the clamps are tight.",
  ]) {
    const { accepted, rejected } = verifyAgainst(text, { kind: "safety_instruction", claim: statement, evidenceQuote: quote });
    assert.equal(accepted.length, 1, `${statement} -> ${rejected[0]?.reason}`);
  }

  // Without its period the same words still stop where the sentence does.
  const bare = verifyAgainst(text, { kind: "safety_instruction", claim: "Check that the clamps are tight", evidenceQuote: quote });
  assert.equal(bare.accepted.length, 1);

  // But a period does not make a cut clause whole: this claim starts mid-sentence.
  const cut = verifyAgainst(text, { kind: "safety_instruction", claim: "the clamps are tight.", evidenceQuote: quote });
  assert.equal(cut.rejected[0]?.reason, "not_whole_clause");

  // And the look-back stays inside the claim: bare punctuation cannot borrow
  // the period of the sentence before it.
  const borrowed = verifyAgainst("Wear gloves. (See the note.)", {
    kind: "safety_instruction",
    claim: "(",
    evidenceQuote: "Wear gloves. (See the note.)",
  });
  assert.equal(borrowed.accepted.length, 0);
});

test("a statement of another kind may be any un-negated part of its quote", () => {
  const { accepted } = verifyAgainst("Remove the two caliper bolts and lift the caliper off the bracket.", {
    kind: "procedure",
    claim: "lift the caliper off the bracket",
    evidenceQuote: "Remove the two caliper bolts and lift the caliper off the bracket",
  });

  assert.equal(accepted.length, 1);
});

test("a claim may not cut a range or drop a sign, even with a trimmed quote", () => {
  const text = "Alternator output: 13.2 to 14.8 V. Regulated output 13.2-14.8 V. Freeze protection down to -37 °C.";
  const cases = [
    "14.8 V", // upper bound of "13.2 to 14.8 V"
    "Alternator output: 13.2", // lower bound, range end dropped
    "37 °C", // "-37 °C" with the minus sign dropped
  ];

  for (const statement of cases) {
    const { accepted, rejected } = verifyAgainst(text, { kind: "vehicle_fact", claim: statement, evidenceQuote: statement });
    assert.equal(accepted.length, 0, statement);
    assert.equal(rejected[0].reason, "range_cut", statement);
  }

  const dashed = verifyAgainst("Regulated output 13.2-14.8 V.", { kind: "vehicle_fact", claim: "14.8 V", evidenceQuote: "14.8 V" });
  assert.equal(dashed.rejected[0]?.reason, "range_cut", "a dashed range is a range too");

  const whole = verifyAgainst(text, {
    kind: "vehicle_fact",
    claim: "Alternator output: 13.2 to 14.8 V",
    evidenceQuote: "Alternator output: 13.2 to 14.8 V",
  });
  assert.equal(whole.accepted.length, 1, "the whole range verifies");
});

// --- A figure keeps its unit ---------------------------------------------------
//
// Found by the planner eval (Phase 2b): a drain-plug claim that stopped at its
// bare figure was ACCEPTED from a line printing the figure with its unit. Only
// a numeric_spec or a safety_instruction must be a whole clause, and that is
// measured against the quote -- so trimming the quote at the same place let any
// kind through, and a bare 37 is "printed in its quote". At the car, "37" with
// no unit is a figure the owner has to guess the meaning of.
//
// The sentences here are invented, and worded unlike the planner-eval fixtures
// on purpose: those fixtures may not share an eight-word run with any other
// server file (test/fixtures/sourceDerivedMaterial.js).

const DRAIN_PLUG_TEXT = "Oil pan drain plug: torque to 37 N*m (27 ft-lbf). Wipe the pan clean afterward.";
const DRAIN_PLUG_LINE = "Oil pan drain plug: torque to 37 N*m (27 ft-lbf)";
const DRAIN_PLUG_CUT = "Oil pan drain plug: torque to 37";
const OIL_TASK = "Change the engine oil";

test("a claim may not cut a figure off its unit, whatever kind and however its quote is trimmed", () => {
  for (const kind of ["procedure", "vehicle_fact", "numeric_spec", "safety_instruction"]) {
    for (const statement of [
      DRAIN_PLUG_CUT, // the unit dropped
      "Oil pan drain plug: torque to 37 N*m (27", // the conversion's unit dropped
    ]) {
      const { accepted, rejected } = verifyAgainst(
        DRAIN_PLUG_TEXT,
        { kind, claim: statement, evidenceQuote: statement },
        OIL_TASK
      );
      assert.equal(accepted.length, 0, `${kind}: ${statement}`);
      assert.equal(rejected[0]?.reason, "unit_cut", `${kind}: ${statement}`);
    }
  }

  // The case the eval found: a procedure claim cut short inside a whole quote.
  const procedure = verifyAgainst(
    DRAIN_PLUG_TEXT,
    { kind: "procedure", claim: DRAIN_PLUG_CUT, evidenceQuote: DRAIN_PLUG_LINE },
    OIL_TASK
  );
  assert.equal(procedure.rejected[0]?.reason, "unit_cut");

  // A specification whose quote goes on still reports the older reason first.
  const spec = verifyAgainst(
    DRAIN_PLUG_TEXT,
    { kind: "numeric_spec", claim: DRAIN_PLUG_CUT, evidenceQuote: DRAIN_PLUG_LINE },
    OIL_TASK
  );
  assert.equal(spec.rejected[0]?.reason, "not_whole_clause");

  // Keeping the unit verifies, with or without the conversion after it.
  for (const statement of ["Oil pan drain plug: torque to 37 N*m", DRAIN_PLUG_LINE]) {
    const { accepted, rejected } = verifyAgainst(
      DRAIN_PLUG_TEXT,
      { kind: "procedure", claim: statement, evidenceQuote: DRAIN_PLUG_LINE },
      OIL_TASK
    );
    assert.equal(accepted.length, 1, `${statement} -> ${rejected[0]?.reason}`);
  }
});

test("every unit the specification reader knows counts, glued or spaced, symbol or word", () => {
  const cases = [
    ["Tighten the drain plug to 37N*m.", "Tighten the drain plug to 37"], // glued symbol
    ["Turn the bolt an additional 90°.", "Turn the bolt an additional 90"], // turn angle
    ["Fill the radiator with a 50% coolant mix.", "Fill the radiator with a 50"], // percent
    ["Battery voltage is 12.6 V at rest.", "Battery voltage is 12.6"], // electrical symbol
    ["The fuse is rated 10 A for the horn.", "The fuse is rated 10"], // current symbol
    ["Engine oil capacity with filter is 4.2 L.", "Engine oil capacity with filter is 4.2"], // litre symbol
    ["Tighten the drain plug to 37 N*m (377 kgf*cm).", "Tighten the drain plug to 37 N*m (377 kgf"], // cut inside a unit
    ["Use SAE 5W-30 engine oil.", "Use SAE 5"], // a viscosity grade
  ];

  for (const [text, statement] of cases) {
    const { accepted, rejected } = verifyAgainst(text, { kind: "procedure", claim: statement, evidenceQuote: statement });
    assert.equal(accepted.length, 0, statement);
    assert.equal(rejected[0]?.reason, "unit_cut", statement);
  }
});

test("a claim ending on a number with no unit after it is not a cut", () => {
  const cases = [
    // Nothing unit-like follows the figure.
    ["Install the clip in hole 2 and press it home.", "Install the clip in hole 2"],
    // "in" before a word is the preposition, never inches.
    ["Insert locking tab 2 in the bracket slot.", "Insert locking tab 2"],
    // Leaving off the period of "in." keeps the unit: the claim still reads inches.
    ["Measure the bore at 0.906 in.", "Measure the bore at 0.906 in"],
  ];

  for (const [text, statement] of cases) {
    const { accepted, rejected } = verifyAgainst(text, { kind: "procedure", claim: statement, evidenceQuote: statement });
    assert.equal(accepted.length, 1, `${statement} -> ${rejected[0]?.reason}`);
  }
});

test("a unit cut becomes a gap that says why", () => {
  const { rejected } = verifyAgainst(
    DRAIN_PLUG_TEXT,
    { kind: "procedure", claim: DRAIN_PLUG_CUT, evidenceQuote: DRAIN_PLUG_CUT },
    OIL_TASK
  );
  const [gap] = describeRejections(rejected);

  assert.match(gap, /unit/);
  assert.doesNotMatch(gap, /could not be verified/, "the reason has its own text, not the fallback");
});

// A range or tolerance prints its unit once, after the high end, so a claim that
// stops on the high end cuts the unit off BOTH figures. Before this test a
// mutation making cutsUnit skip range spans passed the whole server suite.
test("a claim may not cut the unit off a range or a tolerance", () => {
  const cases = [
    ["Charging voltage should read 13.2 to 14.8 V at idle.", "Charging voltage should read 13.2 to 14.8"],
    ["Charging voltage should read 13.2-14.8 V at idle.", "Charging voltage should read 13.2-14.8"],
    ["Hold coolant between 80 and 84 °C during the check.", "Hold coolant between 80 and 84"],
    ["Set the spark plug gap to 1.0 – 1.1 mm before fitting.", "Set the spark plug gap to 1.0 – 1.1"],
    // A "±" tolerance is not a range to the specification reader: the value
    // after "±" is a spec of its own ("0.1 mm"), so this is a separate path from
    // the four rows above, and a mutation skipping range spans would not see it.
    ["Set the crank sensor air gap to 0.8 ± 0.1 mm at fitting.", "Set the crank sensor air gap to 0.8 ± 0.1"],
  ];

  for (const [text, statement] of cases) {
    const { accepted, rejected } = verifyAgainst(text, { kind: "procedure", claim: statement, evidenceQuote: statement });
    assert.equal(accepted.length, 0, statement);
    assert.equal(rejected[0]?.reason, "unit_cut", statement);
  }
});

test("the middle-dot spelling N·m is a unit like N*m", () => {
  const text = "Wheel hub nut: tighten to 216 N·m (2,200 kgf·cm).";

  for (const statement of ["Wheel hub nut: tighten to 216", "Wheel hub nut: tighten to 216 N·m (2,200"]) {
    const { accepted, rejected } = verifyAgainst(text, { kind: "procedure", claim: statement, evidenceQuote: statement });
    assert.equal(accepted.length, 0, statement);
    assert.equal(rejected[0]?.reason, "unit_cut", statement);
  }

  const whole = verifyAgainst(text, {
    kind: "procedure",
    claim: "Wheel hub nut: tighten to 216 N·m",
    evidenceQuote: "Wheel hub nut: tighten to 216 N·m",
  });
  assert.equal(whole.accepted.length, 1, whole.rejected[0]?.reason);
});

// Units the Ask specification reader does not know, so they have no span in
// specNumberSpans and a bare figure in front of them verified. Widening Ask's
// UNIT_PATTERN would change D1 matching for every Ask answer, so the planner
// reads these for unit_cut only.
test("a claim may not cut off a unit that only the planner reads (time, mass, volume, vacuum, power)", () => {
  const cases = [
    ["Let the starter rest for 30 seconds between attempts.", "Let the starter rest for 30"],
    ["Let the starter rest for 30 sec. between attempts.", "Let the starter rest for 30"],
    ["Allow the sealant to cure for 15 minutes first.", "Allow the sealant to cure for 15"],
    ["Allow the sealant to cure for 15 min. first.", "Allow the sealant to cure for 15"],
    ["Leave the vehicle parked for 2 hours before draining.", "Leave the vehicle parked for 2"],
    ["Pack the bearing with 5 g of wheel grease.", "Pack the bearing with 5"],
    ["Pack the bearing with 5g of wheel grease.", "Pack the bearing with 5"],
    ["The spare wheel weighs about 12 kg in total.", "The spare wheel weighs about 12"],
    ["Add 150 cc of compressor oil to the circuit.", "Add 150"],
    ["Manifold vacuum reads 450 mmHg at idle.", "Manifold vacuum reads 450"],
    ["Manifold vacuum reads 18 inHg at idle.", "Manifold vacuum reads 18"],
    ["Each headlight bulb draws 55 W when lit.", "Each headlight bulb draws 55"],
    ["Each headlight bulb draws 55 watts when lit.", "Each headlight bulb draws 55"],
    // A unit printed in brackets right after its figure.
    ["Tighten the strut mount nut to 39 (N*m) by hand wrench.", "Tighten the strut mount nut to 39"],
  ];

  for (const [text, statement] of cases) {
    for (const kind of ["procedure", "vehicle_fact"]) {
      const { accepted, rejected } = verifyAgainst(text, { kind, claim: statement, evidenceQuote: statement });
      assert.equal(accepted.length, 0, `${kind}: ${statement}`);
      assert.equal(rejected[0]?.reason, "unit_cut", `${kind}: ${statement}`);
    }
  }
});

test("a planner-only unit counts only as a whole word after its figure", () => {
  const cases = [
    // A letter that starts a word is not a unit: "5 gaskets", "2 hoses", "3 wires".
    ["Replace the 5 gaskets on the cover.", "Replace the 5"],
    ["Disconnect the 2 hoses from the pump.", "Disconnect the 2"],
    ["Unplug connector 3 wires first.", "Unplug connector 3"],
    // "min" or "W" glued into another word.
    ["Use hole 4 minimum for the clip.", "Use hole 4"],
    ["Remove bolt 6 Wx from the bracket.", "Remove bolt 6"],
    // "W/" is "with", and "10W-" is a viscosity grade's start, not watts.
    ["Fit bracket 1 W/ pulley kit attached.", "Fit bracket 1"],
    // A lowercase "w" is not watts.
    ["Turn knob 2 w the arrow up.", "Turn knob 2"],
    // A one-letter bracket is a label, not amps or litres.
    ["Probe terminal 2 (A) against ground.", "Probe terminal 2"],
    ["Loosen bolt 3 (L) before bolt 4.", "Loosen bolt 3"],
  ];

  // Other checks (the subject guard) may still reject these; unit_cut must not.
  for (const [text, statement] of cases) {
    const { rejected } = verifyAgainst(text, { kind: "procedure", claim: statement, evidenceQuote: statement });
    assert.notEqual(rejected[0]?.reason, "unit_cut", statement);
  }

  // The unit kept verifies.
  const kept = verifyAgainst("Allow the sealant to cure for 15 minutes first.", {
    kind: "procedure",
    claim: "Allow the sealant to cure for 15 minutes",
    evidenceQuote: "Allow the sealant to cure for 15 minutes",
  });
  assert.equal(kept.accepted.length, 1, kept.rejected[0]?.reason);
});

// A unit printed apart from its figure: once in the table's header, or in the
// next cell. No specification span covers the figure, so unit_cut cannot see a
// cut; the claim must instead print a unit its figure's sentence prints apart
// (unit_not_stated). These were todo rows from PR #184, held by the stale-todo
// guard from PR #186 until a fix landed; the guard went with them. The first row's todo
// expected "Tightening torque (N*m): drain plug 37" to be rejected too, but that
// claim keeps the header unit, so the owner sees it: it now verifies, and the
// claim that drops the header is the one rejected.
const HEADER_UNIT_TEXT = "Tightening torque (N*m): drain plug 37, filter cap 25.";
const NEXT_CELL_TEXT = "Drain plug | 37 | N*m";
const PIPE_TABLE_TEXT = "Torque specifications (N·m) | Oil drain plug | 37 | Oil filter cap | 25";

test("a claim must keep a unit printed in its figure's header or next cell", () => {
  for (const [text, statement] of [
    [HEADER_UNIT_TEXT, "drain plug 37"],
    [HEADER_UNIT_TEXT, "filter cap 25"],
    [NEXT_CELL_TEXT, "Drain plug | 37"],
    [PIPE_TABLE_TEXT, "Oil drain plug | 37"],
    [PIPE_TABLE_TEXT, "Oil drain plug | 37 | Oil filter cap"],
  ]) {
    for (const kind of ["procedure", "vehicle_fact", "numeric_spec"]) {
      const { accepted, rejected } = verifyAgainst(text, { kind, claim: statement, evidenceQuote: statement }, OIL_TASK);
      assert.equal(accepted.length, 0, `${kind}: ${statement}`);
      assert.equal(rejected[0]?.reason, "unit_not_stated", `${kind}: ${statement}`);
    }
  }
});

test("a claim that keeps the header or next-cell unit verifies", () => {
  for (const [text, statement] of [
    [HEADER_UNIT_TEXT, "Tightening torque (N*m): drain plug 37"],
    [NEXT_CELL_TEXT, "Drain plug | 37 | N*m"],
    [PIPE_TABLE_TEXT, "Torque specifications (N·m) | Oil drain plug | 37"],
  ]) {
    const { accepted, rejected } = verifyAgainst(text, { kind: "procedure", claim: statement, evidenceQuote: statement }, OIL_TASK);
    assert.equal(accepted.length, 1, `${statement}: ${rejected[0]?.reason}`);
  }
});

test("references, counts, and other sentences' numbers need no header unit", () => {
  for (const [text, statement] of [
    ["Probe terminal 2 and read the sender (V): 12", "Probe terminal 2 and read the sender"],
    ["Remove the 4 cover bolts, then torque (N*m): cover bolt 37", "Remove the 4 cover bolts"],
    ["Torque (N*m): cover bolt 37. Fit cover bolts 4 in total.", "Fit cover bolts 4 in total"],
    ["Seat the bracket bolt (10) by hand, then torque (N*m): bracket bolt 10", "Seat the bracket bolt (10) by hand"],
  ]) {
    const { accepted, rejected } = verifyAgainst(text, { kind: "procedure", claim: statement, evidenceQuote: statement }, OIL_TASK);
    assert.equal(accepted.length, 1, `${statement}: ${rejected[0]?.reason}`);
  }
});

// --- Subject guard (1A-06 / 1B-01) ------------------------------------------
//
// Planner claims are verbatim fragments, so "is the claim's part in its quote?"
// (Ask's subject guard) is always yes. What can be wrong is the TASK: a value
// copied from the drain-plug line and filed under "Replace the oil filter".

const DRAIN_TEXT = "Oil pan drain plug 37 N*m. Oil filter cap 25 N*m.";

test("a bare value never verifies, whatever kind it is filed under", () => {
  for (const kind of ["numeric_spec", "vehicle_fact", "procedure"]) {
    const { accepted, rejected } = verifyAgainst(
      DRAIN_TEXT,
      { kind, claim: "37 N*m", evidenceQuote: "37 N*m" },
      "Replace the oil filter"
    );

    assert.equal(accepted.length, 0, kind);
    assert.equal(rejected[0].reason, "subject_missing", kind);
  }
});

test("'torque' alone names no part, because every fastener has one", () => {
  const { rejected } = verifyAgainst(
    "Caliper bracket bolt. Torque: 107 N*m.",
    { claim: "Torque: 107 N*m", evidenceQuote: "Caliper bracket bolt. Torque: 107 N*m" },
    "Tighten the caliper bracket bolts"
  );

  assert.equal(rejected[0]?.reason, "subject_missing");
});

test("a spec must share a part word with the task it is filed under", () => {
  const text = "Coolant drain cock 13 N*m. Oil pan drain plug 37 N*m.";

  const other = verifyAgainst(
    text,
    { claim: "Coolant drain cock 13 N*m", evidenceQuote: "Coolant drain cock 13 N*m" },
    "Replace the oil filter"
  );
  assert.equal(other.rejected[0]?.reason, "subject_missing");

  const own = verifyAgainst(
    text,
    { claim: "Oil pan drain plug 37 N*m", evidenceQuote: "Oil pan drain plug 37 N*m" },
    "Replace the oil drain plug gasket"
  );
  assert.equal(own.accepted.length, 1);
});

test("the task's part may be named by the quote rather than the claim, in any plural", () => {
  const { accepted } = verifyAgainst(
    "Brake pads: minimum thickness 1.0 mm.",
    { claim: "minimum thickness 1.0 mm", evidenceQuote: "Brake pads: minimum thickness 1.0 mm" },
    "Inspect the brake pad"
  );

  assert.equal(accepted.length, 1);
});

test("repair verbs and position words are not the part a task is about", () => {
  // "Replace" and "front" are in both, but the hub nut is not the brake pads.
  const { rejected } = verifyAgainst(
    "Front axle hub nut: replace and torque to 216 N*m.",
    { claim: "Front axle hub nut: replace and torque to 216 N*m", evidenceQuote: "Front axle hub nut: replace and torque to 216 N*m" },
    "Replace front brake pads"
  );

  assert.equal(rejected[0]?.reason, "subject_missing");
});

test("a compound task's spec must match the clause it says it supports", () => {
  const text = "Brake pad minimum thickness 1.0 mm.";
  const tasks = [
    {
      id: 1,
      title: "Replace the brake pads and check the steering rack",
      compound: true,
      clauses: ["Replace the brake pads", "check the steering rack"],
    },
  ];
  const verifyFor = (clauseIndex) =>
    verifyClaims(
      [claim({ clauseIndex, claim: "Brake pad minimum thickness 1.0 mm", evidenceQuote: "Brake pad minimum thickness 1.0 mm" })],
      { sourcesById: new Map([["S1", makeSource("S1", text)]]), tasks }
    );

  assert.equal(verifyFor(0).accepted.length, 1);
  assert.equal(verifyFor(1).rejected[0]?.reason, "subject_missing", "brake pads do not ground the steering clause");
});

test("a spec whose task is unknown is rejected rather than guessed", () => {
  const { rejected } = verifyClaims(
    [claim({ claim: "Oil pan drain plug 37 N*m", evidenceQuote: "Oil pan drain plug 37 N*m" })],
    { sourcesById: new Map([["S1", makeSource("S1", DRAIN_TEXT)]]) }
  );

  assert.equal(rejected[0]?.reason, "subject_missing");
});

test("statements without a value need no subject", () => {
  const { accepted } = verifyAgainst(
    "Do not open the radiator cap while the engine is hot.",
    {
      kind: "safety_instruction",
      claim: "Do not open the radiator cap while the engine is hot",
      evidenceQuote: "Do not open the radiator cap while the engine is hot",
    },
    "Replace front brake pads"
  );

  assert.equal(accepted.length, 1, "the task guard applies to specifications, not to every safety line");
});

// --- Status derivation -----------------------------------------------------

test("an empty claims array can only ever be not_found", () => {
  const result = build([]);

  assert.equal(result.valid, true);
  assert.equal(result.evidenceStatus, "not_found");
  assert.equal(result.citations.length, 0);
});

test("cherry-picking cannot reach verified: one rejection keeps the run partial", () => {
  const result = build([
    claim(),
    claim({ claim: "torque the caliper bolts to 90 ft-lb", evidenceQuote: "torque the caliper bolts to 90 ft-lb" }),
  ]);

  // One good claim survives, but the dropped one is an admission that something
  // requested could not be grounded. It must not be silently discarded into a
  // clean "verified".
  assert.equal(result.verifiedClaims.length, 1);
  assert.notEqual(result.evidenceStatus, "verified");
  assert.ok(result.gaps.length >= 1);
});

test("a multi-task plan with evidence for only one task is partial", () => {
  const tasks = [
    ...TASKS,
    { id: 2, title: "Check the coolant", system: "Cooling", difficulty: "beginner", compound: false, clauses: [] },
  ];

  const result = build([claim()], { tasks });

  assert.equal(result.evidenceStatus, "partial");
  assert.match(result.gaps.join(" "), /No verified evidence was found for task 2/);
});

test("verified requires every task covered and both requirement groups resolved", () => {
  const result = build(
    [
      claim(),
      claim({ kind: "required_tool", claim: "bleed the system with a 10 mm wrench", itemName: "10 mm wrench", evidenceQuote: "bleed the system with a 10 mm wrench" }),
      claim({ kind: "required_part", claim: "fit new brake pads", itemName: "brake pads", evidenceQuote: "fit new brake pads" }),
    ],
    { availableTools: ["10 mm wrench", "socket set"], availableParts: ["brake pads"] }
  );

  assert.equal(result.evidenceStatus, "verified");
  assert.equal(result.requirements.tools.status, "satisfied");
  assert.equal(result.requirements.parts.status, "satisfied");
  assert.deepEqual(result.gaps, []);
});

test("a compound task needs evidence for every clause", () => {
  const tasks = [
    {
      id: 1,
      title: "Remove the caliper and bracket",
      system: "Brakes",
      difficulty: "beginner",
      compound: true,
      clauses: ["Remove the caliper", "bracket"],
    },
  ];

  const oneClause = build([claim({ clauseIndex: 0 })], { tasks });
  assert.equal(oneClause.evidenceStatus, "partial", "one clause covered is not the whole task");
  assert.match(oneClause.gaps.join(" "), /only partly covered/);

  // And a compound task's claims must say which clause they support at all.
  const missingIndex = validateFinalizerPayload(
    { claims: [claim()] },
    { tasks, sourceIds: new Set(["S1"]) }
  );
  assert.equal(missingIndex.valid, false);
  assert.match(missingIndex.errors.join(" "), /clauseIndex must be an integer/);
});

// --- Requirement groups ----------------------------------------------------

test("an empty requirement list is unknown, not none_required", () => {
  const groups = buildRequirementGroups({ accepted: [], availableTools: [], availableParts: [] });

  assert.equal(groups.tools.status, "unknown");
  assert.equal(groups.parts.status, "unknown");
});

test("a grounded no_required_tools claim satisfies that group", () => {
  const groups = buildRequirementGroups({
    accepted: [{ kind: "no_required_tools" }],
    availableTools: [],
    availableParts: [],
  });

  assert.equal(groups.tools.status, "none_required");
  assert.equal(groups.parts.status, "unknown", "silence about parts is still not evidence");
});

// Rewritten for 1A-07 (audit 3A-06). The old version pinned a raw substring
// test as correct: its only positive was "a good torque wrench", and nothing
// checked a negated entry, a longer name containing the item, or a number
// containing another. Readiness points ride on this match, so an owner told
// "no torque wrench" counts as owning one is told they are ready for a job they
// cannot finish.

function toolsOwned(required, availableTools) {
  return buildRequirementGroups({
    accepted: required.map((itemName) => ({ kind: "required_tool", itemName })),
    availableTools,
    availableParts: [],
  }).tools;
}

test("inventory owns an item only as whole words naming that item", () => {
  // A longer name that merely CONTAINS the item is a different thing.
  assert.deepEqual(toolsOwned(["jack"], ["jack stands"]).missing, ["jack"]);
  assert.deepEqual(toolsOwned(["10 mm wrench"], ["110 mm wrench"]).missing, ["10 mm wrench"]);
  assert.deepEqual(toolsOwned(["torque wrench"], ["wrench"]).missing, ["torque wrench"], "no fuzzy matching");

  // Words in front describe the item; the item is still what the entry ends with.
  assert.equal(toolsOwned(["torque wrench"], ["a good torque wrench"]).status, "satisfied");
  assert.equal(toolsOwned(["jack"], ["3-ton floor jack"]).status, "satisfied");
  assert.equal(toolsOwned(["jack", "jack stands"], ["jack and jack stands"]).status, "satisfied");
  assert.equal(toolsOwned(["torque wrench"], ["torque wrench (1/2 in drive)"]).status, "satisfied");
});

test("a negated inventory entry counts as absent", () => {
  for (const entry of ["no torque wrench", "don't have a torque wrench", "need a torque wrench", "without torque wrench"]) {
    assert.deepEqual(toolsOwned(["torque wrench"], [entry]).missing, ["torque wrench"], entry);
  }

  // The negation reaches only what follows it.
  assert.deepEqual(toolsOwned(["jack", "jack stands"], ["jack but no jack stands"]).missing, ["jack stands"]);
  // "No. 2" is a size, not a negation.
  assert.equal(toolsOwned(["phillips screwdriver"], ["No. 2 Phillips screwdriver"]).status, "satisfied");
});

test("inventory and requirement names go through one normalizer", () => {
  // Owner text arrives through parseInventory (lowercased, trimmed) and names
  // from the model through normalizeRequirementName; punctuation one side
  // keeps must not decide the match.
  assert.equal(toolsOwned(["10-mm wrench"], ["10 MM Wrench!"]).status, "satisfied");
  assert.equal(toolsOwned(["torque wrench"], ["Torque-wrench & sockets"]).status, "satisfied");
  assert.equal(toolsOwned(["socket set"], ["Socket Set & torque wrench"]).status, "satisfied");
});

test("an itemName must be a real name: at least two words or four letters", () => {
  const text = "A torque wrench is required.";
  const verifyItem = (itemName) =>
    verifyAgainst(text, {
      kind: "required_tool",
      claim: "A torque wrench is required",
      evidenceQuote: "A torque wrench is required",
      itemName,
    });

  // "a" and "is" are whole words of the claim, and still name no tool.
  for (const itemName of ["e", "a", "is"]) {
    assert.equal(verifyItem(itemName).rejected[0]?.reason, "item_name_too_short", itemName);
  }

  assert.equal(verifyItem("torque wrench").accepted.length, 1);
  assert.equal(verifyItem("wrench").accepted.length, 1, "a single four-letter word is enough");
});

test("an itemName must appear in its claim as whole words", () => {
  const verifyItem = (text, itemName) =>
    verifyAgainst(text, { kind: "required_tool", claim: text.replace(/\.$/, ""), evidenceQuote: text.replace(/\.$/, ""), itemName });

  assert.equal(verifyItem("Use a 110 mm wrench.", "10 mm wrench").rejected[0]?.reason, "item_not_in_claim");
  assert.equal(verifyItem("Use a ratcheting wrench.", "ratchet").rejected[0]?.reason, "item_not_in_claim");
  assert.equal(verifyItem("Use a 10 mm wrench.", "10 mm wrench").accepted.length, 1);
});

test("unsupported required tools produce no satisfied group", () => {
  // The claim is rejected, so the requirement never enters the group at all --
  // it cannot quietly become a satisfied row.
  const result = build([
    claim({ kind: "required_tool", claim: "use a spring compressor", evidenceQuote: "use a spring compressor", itemName: "spring compressor" }),
  ]);

  assert.equal(result.requirements.tools.status, "unknown");
  assert.equal(result.verifiedClaims.length, 0);
});

// --- Rendering -------------------------------------------------------------

test("server-authored organizational guidance needs no citation", () => {
  const result = build([claim()]);

  assert.match(result.text, /Work on level ground/);
  assert.match(result.text, /Before you start/);
});

test("only sources that support shown claims become citations", () => {
  const result = build([claim()]);

  assert.equal(result.citations.length, 1);
  assert.equal(result.citations[0].sourceId, "S1");
  assert.ok(
    !result.citations.some((citation) => citation.sourceId === "S2"),
    "a retrieved but uncited source is not evidence for anything"
  );
});

test("a task with no accepted claim says so in the plan", () => {
  const tasks = [
    ...TASKS,
    { id: 2, title: "Check the coolant", system: "Cooling", difficulty: "beginner", compound: false, clauses: [] },
  ];

  const result = build([claim()], { tasks });

  assert.match(result.text, /No statement from your documents could be verified/);
});

// --- Helper units ----------------------------------------------------------

test("requirement names normalize punctuation and spacing", () => {
  assert.equal(normalizeRequirementName("  10mm  Wrench!! "), "10mm wrench");
  assert.equal(normalizeRequirementName(null), "");
  assert.equal(normalizeRequirementName("10-mm Wrench (metric)"), "10 mm wrench", "hyphens and asides fold away");
  assert.equal(normalizeRequirementName("Don't have jack & stands"), "do not have jack and stands");
});

test("deriveEvidenceStatus never returns verified without technical claims", () => {
  const status = deriveEvidenceStatus({
    coverage: [],
    accepted: [{ kind: "no_required_tools" }],
    requirements: { tools: { status: "none_required" }, parts: { status: "none_required" } },
  });

  assert.equal(status, "not_found");
});

test("verifyClaims reports why each rejection happened", () => {
  const sourcesById = new Map(SOURCES.map((source) => [source.id, source]));
  const { rejected } = verifyClaims(
    [claim({ evidenceQuote: "not in the document at all" })],
    { sourcesById }
  );

  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason, "quote_not_in_source");
});

test("a rejected statement's electrical-symbol value is redacted, not reprinted", () => {
  // The planner shares Ask's redaction, so a value written as a symbol ("14.2 V")
  // is hidden from the owner exactly as "54 Nm" is above. This pins that shared
  // redaction only: the planner still has no subject guard.
  const batteryText = "Charging check: the battery should read 12.6 V with the engine off.";
  const result = build(
    [
      claim({
        claim: "the battery should read 14.2 V",
        sourceId: "S1",
        evidenceQuote: "the battery should read 12.6 V",
      }),
    ],
    { sources: [makeSource("S1", batteryText)] }
  );

  assert.equal(result.verifiedClaims.length, 0);

  const gapText = result.gaps.join(" ");
  assert.match(gapText, /\[unverified value\]/);
  assert.doesNotMatch(gapText, /14\.2/, "the rejected value must not be reprinted in the gaps");
  assert.doesNotMatch(result.text, /14\.2/, "the rejected value must not reach the plan");
});

test("the planner rejects a near-miss electrical value before any tolerance applies", () => {
  // The planner shares Ask's number check, which no longer gives electrical
  // values any tolerance. But the planner first requires a claim's text to sit
  // inside its own quote, so a claim cannot carry a number that differs from the
  // quote's into that check: 12.4 V against a printed 12.6 V is a paraphrase
  // here, under either rule. What the planner needs from the change is the other
  // direction -- that an exact restatement, as printed, still verifies.
  const batteryText = "Charging check: the battery should read 12.6 V with the engine off.";
  const sourcesById = new Map([["S1", makeSource("S1", batteryText)]]);
  const tasks = [{ id: 1, title: "Check the battery", compound: false, clauses: [] }];
  const { accepted, rejected } = verifyClaims(
    [
      claim({ claim: "the battery should read 12.4 V", evidenceQuote: "the battery should read 12.6 V" }),
      claim({ claim: "the battery should read 12.6 V", evidenceQuote: "the battery should read 12.6 V" }),
    ],
    { sourcesById, tasks }
  );

  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].claim.claim, "the battery should read 12.4 V");
  assert.equal(rejected[0].reason, "claim_not_in_quote");
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].claim, "the battery should read 12.6 V");
});

test("a current-symbol value verifies when restated and is redacted when rejected", () => {
  // The planner shares Ask's detector and redaction, so "15A" is now a checked
  // value: a restatement as printed still verifies, and a rejected statement
  // does not reprint its figure to the owner.
  const fuseText = "Inspection: the EFI fuse is 15A and must show continuity.";
  const result = build(
    [
      claim({ claim: "the EFI fuse is 15A", sourceId: "S1", evidenceQuote: "the EFI fuse is 15A" }),
      claim({ claim: "the EFI fuse is 25A", sourceId: "S1", evidenceQuote: "the EFI fuse is 25A" }),
    ],
    {
      sources: [makeSource("S1", fuseText)],
      tasks: [{ id: 1, title: "Check the EFI fuse", compound: false, clauses: [] }],
    }
  );

  assert.deepEqual(
    result.verifiedClaims.map((verified) => verified.claim),
    ["the EFI fuse is 15A"]
  );

  const gapText = result.gaps.join(" ");
  assert.match(gapText, /\[unverified value\]/);
  assert.doesNotMatch(gapText, /25/, "the rejected value must not be reprinted in the gaps");
});

// --- Multi-word part names (roadmap N9: drive belt filed under timing belt) ---
//
// Invented text. A shared head word ("belt") is not enough when the task names
// it with a modifier ("timing") and the evidence names a different one.

const BELT_TEXT = "Fit a new drive belt at 45,000 miles. Timing belt tension 12 mm.";

test("a drive-belt spec is not grounded for a timing-belt task", () => {
  const { accepted, rejected } = verifyAgainst(
    BELT_TEXT,
    { claim: "Fit a new drive belt at 45,000 miles", evidenceQuote: "Fit a new drive belt at 45,000 miles" },
    "Replace the timing belt"
  );

  assert.equal(accepted.length, 0);
  assert.equal(rejected[0]?.reason, "subject_missing");
});

test("controls: matching multi-word part names still verify, and a one-word part behaves as before", () => {
  for (const [statement, task] of [
    ["Timing belt tension 12 mm", "Replace the timing belt"],
    ["Fit a new drive belt at 45,000 miles", "Replace the drive belt"],
    ["Fit a new drive belt at 45,000 miles", "Replace the belt"],
    ["Timing belt tension 12 mm", "Inspect the timing-belt"],
  ]) {
    const { accepted, rejected } = verifyAgainst(BELT_TEXT, { claim: statement, evidenceQuote: statement }, task);
    assert.equal(accepted.length, 1, `${statement} / ${task}: ${rejected[0]?.reason}`);
  }
});

test("control: a word the evidence prints bare still counts for a task that gives it a modifier", () => {
  // "engine oil" in the task, "Oil pan drain plug" in the evidence: no other
  // kind of oil is named, so the shared word stands.
  const statement = "Oil pan drain plug 37 N*m";
  const { accepted, rejected } = verifyAgainst(DRAIN_TEXT, { claim: statement, evidenceQuote: statement }, "Change the engine oil");
  assert.equal(accepted.length, 1, rejected[0]?.reason);
});

test("a spec naming another kind of the task's part is not grounded by the shared head word", () => {
  const text = "Transmission oil drain plug 39 N*m.";
  const statement = "Transmission oil drain plug 39 N*m";
  const { rejected } = verifyAgainst(text, { claim: statement, evidenceQuote: statement }, "Change the engine oil");
  assert.equal(rejected[0]?.reason, "subject_missing");
});
