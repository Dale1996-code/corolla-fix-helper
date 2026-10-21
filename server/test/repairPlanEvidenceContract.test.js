import assert from "node:assert/strict";
import test from "node:test";

// Pure validation: no database, no network. Safe to import directly.
import {
  buildRepairPlanEvidence,
  buildRequirementGroups,
  deriveEvidenceStatus,
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
