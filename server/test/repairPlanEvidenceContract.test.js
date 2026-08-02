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

function claim(overrides = {}) {
  return {
    taskId: 1,
    kind: "numeric_spec",
    claim: "torque the caliper bolts to 25 ft-lb",
    sourceId: "S1",
    evidenceQuote: "torque the caliper bolts to 25 ft-lb",
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

test("inventory satisfies a requirement only on a complete phrase match", () => {
  const accepted = [
    { kind: "required_tool", itemName: "torque wrench" },
    { kind: "required_tool", itemName: "10 mm wrench" },
  ];

  const partial = buildRequirementGroups({
    accepted,
    // "wrench" alone must not satisfy "torque wrench" -- no fuzzy matching.
    availableTools: ["wrench"],
    availableParts: [],
  });

  assert.equal(partial.tools.status, "unmet");
  assert.equal(partial.tools.missing.length, 2);

  const full = buildRequirementGroups({
    accepted,
    availableTools: ["a good torque wrench", "10 mm wrench"],
    availableParts: [],
  });

  assert.equal(full.tools.status, "satisfied");
  assert.deepEqual(full.tools.missing, []);
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
