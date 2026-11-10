import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

// The negative tests of docs/planner-eval-spec.md section 8, tier A: every row
// runs the REAL agent loop and the REAL verifier with a scripted model and an
// invented corpus, and is then judged.
//
// THREE AXES (owner decision 2b-6). Every row states the evidence status, the
// verifier's rejection reasons, and the failure-layer attribution, and
// `assertThreeAxes` refuses a row that leaves one out. A row that checked only
// the status would pass a run whose claims were rejected for the wrong reason,
// or attributed to the wrong layer.
//
// Same convention as evidenceOracle.test.js: a row describes what the code does
// TODAY and passes; where that is not the desired behavior, a separate `todo`
// row states the desired behavior, and the stale-todo guard fails the suite the
// moment one starts passing, so the fix must remove its `todo`. Never delete or
// relabel a row to make it pass.

const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-planner-negatives-"));
process.env.DATABASE_FILE = path.join(scratchRoot, "negatives.db");
process.env.UPLOADS_DIR = path.join(scratchRoot, "uploads");
process.env.OPENAI_API_KEY = "";
process.env.NETWORK_MODE = "0";
fs.mkdirSync(process.env.UPLOADS_DIR, { recursive: true });

const { db } = await import("../src/database.js");
const { runRepairPlannerAgent } = await import("../src/services/agent/repairPlannerAgent.js");
const { extractRepairTasks } = await import("../src/services/agent/repairTools.js");
const { createPlanRunStore } = await import("../src/services/agent/planRunStore.js");
const { extractSpecNumbers } = await import("../src/services/askEvidenceContract.js");
const { recordPlannerRun, runPlannerCase } = await import("../src/evals/plannerCaseRunner.js");
const { INVENTORY_PROFILE_ID, getPlannerScenario, validateScenario } = await import("../src/evals/plannerScenarios.js");
const { MINI_CORPORA, createKeywordRetriever } = await import("../src/evals/fixtures/plannerMiniCorpora.js");
const { LAYER_CORPORA } = await import("../src/evals/fixtures/plannerLayerCorpora.js");
const { createScriptedModel, finalizeCall, providerHttpError, searchCall, sourceIdFor, toolCall } = await import(
  "../src/evals/plannerScriptedModel.js"
);
const { judgeRun } = await import("../src/evals/plannerJudge.js");

after(() => {
  if (typeof db.close === "function") {
    db.close();
  }
  fs.rmSync(scratchRoot, { recursive: true, force: true });
});

const S1 = "S1-oil-and-filter";
const S1_FACT = "s1-drain-plug-torque";
const S1_RIGHT = "Tighten the oil drain plug to 37 N·m (27 ft-lbf).";
const STOCKED_TOOLS = "floor jack, jack stands, socket set, torque wrench, drain pan, screwdrivers, pliers";
const SYNTHETIC = { kind: "synthetic-test", ref: "plannerNegatives.test.js" };

// ---- Test-only scenarios (validated like committed ones) ------------------------

const surveyedClean = {
  corpusSupport: "full",
  partial: null,
  sourceQuality: "clean",
  qualityEvidence: SYNTHETIC,
  // The invented corpus holds the step in a chunk the scripted search never
  // asks for, and no canonical query is assumed to find it.
  goldenQueryRetrieves: false,
  goldenQueryEvidence: SYNTHETIC,
  sourceHint: null,
};

function stepFact(id, jobId, concept, stepMatchers, exampleText) {
  return {
    id,
    kind: "procedure_step",
    jobId,
    essential: true,
    confirmed: true,
    concept,
    confirmedBy: { askCaseId: "synthetic-fixture", note: "invented for a negative test" },
    ...surveyedClean,
    stepMatchers,
    claimExamples: [{ text: exampleText, expect: "covers", category: "the-step" }],
  };
}

function testScenario(fields) {
  const scenario = {
    skillLevel: "beginner",
    availableTools: STOCKED_TOOLS,
    availableParts: "",
    constraints: "",
    inventoryProfile: INVENTORY_PROFILE_ID,
    unassessedAreas: [{ id: "task-attributes", area: "system, difficulty and safety flags" }],
    claimSetExamples: [],
    ...fields,
  };
  assert.deepEqual(validateScenario(scenario), [], `test scenario ${scenario.id} must be valid`);
  return scenario;
}

const CABIN_JOB = "replace-cabin-filter";
const NEG_STEPS = testScenario({
  id: "NEG-steps",
  brief: "Replace the cabin air filter.",
  availableParts: "cabin air filter",
  desiredJobs: {
    decomposition: [{ id: CABIN_JOB, concept: "replace the cabin air filter", matchers: [/\bcabin air filter\b/i], confirmed: false }],
    premise: { status: "not_assessed" },
  },
  facts: [
    stepFact("step-1-glove-box", CABIN_JOB, "lower the glove box", [/\bglove box\b/i, /\bswing down\b/i], "Empty the glove box and let it swing down."),
    stepFact("step-2-cover", CABIN_JOB, "unclip the filter cover", [/\bunclip\b/i, /\bcover\b/i], "Unclip the filter cover."),
    stepFact("step-3-remove", CABIN_JOB, "slide the used element out", [/\bslide\b/i, /\bused element\b/i], "Slide the used element out."),
    stepFact("step-4-fit", CABIN_JOB, "fit the new element arrow down", [/\bnew element\b/i, /\barrow\b/i], "Fit the new element with its arrow down."),
  ],
});

const BRAKE_JOB = "replace-pads-and-rotors";
const NEG_COMPOUND = testScenario({
  id: "NEG-compound",
  brief: "Replace the brake pads and rotors.",
  availableParts: "brake pads, rotors",
  desiredJobs: {
    decomposition: [{ id: BRAKE_JOB, concept: "replace the brake pads and the rotors", matchers: [/\bbrake pads\b/i], confirmed: false }],
    premise: { status: "not_assessed" },
  },
  facts: [
    stepFact("pads-lift-out", BRAKE_JOB, "lift the old pads out", [/\bold brake pads\b/i, /\blift\b/i], "Lift the old brake pads out."),
    stepFact("rotor-remove", BRAKE_JOB, "remove the rotor", [/\brotor\b/i, /\bremove\b/i], "Remove the rotor from the hub."),
  ],
});

const MOUNT_JOB = "replace-front-engine-mount";
const TORQUE_UNITS = [{ canonical: "N·m", aliases: ["N-m", "Nm", "N*m"] }];
const mountFact = (id, plant, value, other) => ({
  id,
  kind: "numeric_spec",
  jobId: MOUNT_JOB,
  essential: true,
  confirmed: true,
  concept: `front mount bolt torque for ${plant} built vehicles`,
  confirmedBy: { askCaseId: "synthetic-fixture", note: "invented figures for a negative test" },
  ...surveyedClean,
  partMatchers: [/\bfront mount bolt\b/i],
  units: TORQUE_UNITS,
  acceptable: [{ kind: "value", value, unit: "N·m" }],
  qualifiersAnyOf: [new RegExp(`\\b${plant}\\b`)],
  excludedQualifiers: [],
  decoys: [{ kind: "value", value: other, unit: "N·m", why: "the other build plant's figure" }],
  claimExamples: [
    { text: `The front mount bolt torque for ${plant} built vehicles is ${value} N·m.`, expect: "covers", category: "qualified" },
  ],
});
const NEG_MOUNT = testScenario({
  id: "NEG-mount",
  brief: "Replace the front engine mount.",
  desiredJobs: {
    decomposition: [{ id: MOUNT_JOB, concept: "replace the front engine mount", matchers: [/\bengine mount\b/i], confirmed: false }],
    premise: { status: "not_assessed" },
  },
  facts: [mountFact("mount-tmc", "TMC", 50, 80), mountFact("mount-tmmt", "TMMT", 80, 50)],
});

// ---- Running a row -------------------------------------------------------------

const claimOf = (input, { text, quote = text, source, kind = "numeric_spec", taskId = 1, ...rest }) => ({
  taskId,
  kind,
  claim: text,
  sourceId: sourceIdFor(input, source),
  evidenceQuote: quote,
  ...rest,
});

const searchThenFinalize = (query, claims, { taskId = 1 } = {}) => [
  [searchCall(taskId, query)],
  ({ input }) => [finalizeCall(claims.map((claim) => claimOf(input, claim)))],
];

async function runRow(row) {
  const model = createScriptedModel(row.steps);
  const retrieve = createKeywordRetriever(row.corpus ?? []);
  const deps = {
    runAgent: runRepairPlannerAgent,
    extractTasks: extractRepairTasks,
    createPlanRuns: () => createPlanRunStore(),
    streamTurn: model.streamTurn,
    retrieve,
  };
  const record = row.scenario
    ? await runPlannerCase(row.scenario, deps)
    : await recordPlannerRun({ request: { brief: row.brief, skillLevel: "beginner" } }, deps);

  return { record, model, judgment: judgeRun(record, row.scenario ?? null) };
}

/**
 * The three axes, all required. `layer.run` is the run-level layer (null for a
 * run that produced a plan); `layer.facts` maps each fact the row is about to
 * its outcome (empty for a row judged at run level only).
 */
function assertThreeAxes(expect, judgment) {
  for (const axis of ["evidenceStatus", "reasons", "layer"]) {
    if (!(axis in (expect ?? {}))) {
      throw new Error(`a negative row must state the ${axis} axis`);
    }
  }
  if (!("run" in expect.layer) || !("facts" in expect.layer)) {
    throw new Error("the layer axis states both the run layer and the fact outcomes");
  }

  assert.equal(judgment.run.evidenceStatus, expect.evidenceStatus, "evidence status");
  assert.deepEqual(
    judgment.claims.filter((claim) => claim.verdict === "rejected").map((claim) => claim.reason).sort(),
    [...expect.reasons].sort(),
    "rejection reasons"
  );
  assert.equal(judgment.run.layer, expect.layer.run, "run layer");
  for (const [factId, outcome] of Object.entries(expect.layer.facts)) {
    const entry = judgment.facts.find((fact) => fact.factId === factId);
    assert.ok(entry, `no ledger entry for ${factId}`);
    assert.equal(entry.outcome, outcome, `${factId}: ${JSON.stringify(entry)}`);
  }
}

test("the three-axis helper refuses a row that leaves out an axis", () => {
  const judgment = { run: { evidenceStatus: null, layer: null }, claims: [], facts: [] };
  assert.throws(() => assertThreeAxes({ reasons: [], layer: { run: null, facts: {} } }, judgment), /evidenceStatus axis/);
  assert.throws(() => assertThreeAxes({ evidenceStatus: null, layer: { run: null, facts: {} } }, judgment), /reasons axis/);
  assert.throws(() => assertThreeAxes({ evidenceStatus: null, reasons: [] }, judgment), /layer axis/);
  assert.throws(() => assertThreeAxes({ evidenceStatus: null, reasons: [], layer: { facts: {} } }, judgment), /both/);
  assert.doesNotThrow(() => assertThreeAxes({ evidenceStatus: null, reasons: [], layer: { run: null, facts: {} } }, judgment));
});

// ---- The rows -------------------------------------------------------------------

const draftStrings = (record) => JSON.stringify(record.outputs?.checklistDraft ?? null);

const ROWS = [
  // 8.1 Missing evidence
  {
    id: "NEG-ME-2",
    what: "the retriever returns nothing and the model grounds nothing",
    scenario: getPlannerScenario(S1),
    corpus: LAYER_CORPORA.empty,
    steps: searchThenFinalize("oil drain plug", []),
    expect: { evidenceStatus: "not_found", reasons: [], layer: { run: null, facts: { [S1_FACT]: "UNDETERMINED" } } },
    also({ record, judgment }) {
      assert.equal(record.outputs.readiness.level, "not_ready");
      assert.match(draftStrings(record), /No statement in this plan could be verified/);
      assert.deepEqual(extractSpecNumbers(draftStrings(record)), [], "the draft carries no specification");
      assert.equal(judgment.invariants["I-4"].status, "pass");
    },
  },
  {
    id: "NEG-ME-3",
    what: "the model cites an unrelated chunk with a quote that is not in it",
    scenario: getPlannerScenario(S1),
    corpus: LAYER_CORPORA.unrelated,
    steps: searchThenFinalize("wiper blade", [{ text: S1_RIGHT, source: /Wiper Blade Notes/ }]),
    expect: {
      evidenceStatus: "not_found",
      reasons: ["quote_not_in_source"],
      layer: { run: null, facts: { [S1_FACT]: "UNDETERMINED" } },
    },
    also({ judgment }) {
      // The figure is right, but the model was never shown it: the verifier was
      // right to refuse, so this is not counted as a false rejection.
      assert.equal(judgment.claims[0].classification, "ungrounded_rejection");
      assert.deepEqual(judgment.metrics.U4, { falseAcceptances: 0, falseRejections: 0 });
    },
  },
  {
    id: "NEG-ME-4",
    what: "the claim states a figure its quote does not print",
    note:
      "The spec expected unsupported_number. The planner checks that the claim is a fragment of its quote first, so a figure absent from the quote is caught as claim_not_in_quote; unsupported_number cannot be reached through a whole run (a claim inside its quote prints only the quote's numbers).",
    scenario: getPlannerScenario(S1),
    corpus: MINI_CORPORA.S1,
    steps: searchThenFinalize("oil drain plug torque", [
      { text: "Tighten the oil drain plug to 40 N·m.", quote: S1_RIGHT, source: /Oil and Oil Filter Replacement/ },
    ]),
    expect: {
      evidenceStatus: "not_found",
      reasons: ["claim_not_in_quote"],
      layer: { run: null, facts: { [S1_FACT]: "G:omission" } },
    },
    also({ judgment }) {
      assert.equal(judgment.claims[0].classification, "correct_rejection", "a wrong figure, rightly refused");
    },
  },
  {
    id: "NEG-ME-5",
    what: "a required-tool claim names a tool its statement does not mention",
    scenario: getPlannerScenario(S1),
    corpus: LAYER_CORPORA["tool-and-warning"],
    steps: searchThenFinalize("drain plug gasket", [
      {
        text: "Use a socket wrench to loosen the drain plug.",
        kind: "required_tool",
        itemName: "torque wrench",
        source: /Drain Plug Gasket Notes/,
      },
    ]),
    expect: {
      evidenceStatus: "not_found",
      reasons: ["item_not_in_claim"],
      layer: { run: null, facts: { [S1_FACT]: "UNDETERMINED" } },
    },
  },

  // 8.2 Wrong-engine and wrong-variant specifications
  {
    id: "NEG-WE-1",
    what: "the chunk prints another engine's row first and the claim quotes only that row",
    scenario: getPlannerScenario(S1),
    corpus: LAYER_CORPORA["other-engine-first"],
    steps: searchThenFinalize("oil drain plug", [
      {
        text: "tighten the oil drain plug to 40 N·m.",
        quote: "2AZ-FE engine: tighten the oil drain plug to 40 N·m.",
        source: /Lubrication Service Data/,
      },
    ]),
    // TODAY: accepted, so the judge's critical finding is the only safeguard.
    expect: {
      evidenceStatus: "partial",
      reasons: [],
      layer: { run: null, facts: { [S1_FACT]: "V:false_acceptance" } },
    },
    also({ judgment }) {
      assert.equal(judgment.facts[0].kind, "wrong_only");
      assert.equal(judgment.metrics.P2, 1);
      assert.ok(judgment.critical.length > 0);
    },
  },
  {
    id: "NEG-WE-2",
    what: "the chunk prints two build-plant torques and the plan states only the first",
    scenario: NEG_MOUNT,
    corpus: LAYER_CORPORA["plant-variants"],
    steps: searchThenFinalize("front mount bolt torque", [
      { text: "The front mount bolt torque for TMC built vehicles is 50 N·m.", source: /Engine Mounting Service Data/ },
    ]),
    expect: {
      evidenceStatus: "partial",
      reasons: [],
      layer: { run: null, facts: { "mount-tmc": "COVERED", "mount-tmmt": "G:omission" } },
    },
  },
  {
    id: "NEG-WE-3",
    what: "control: both variants are stated, each with its plant",
    scenario: NEG_MOUNT,
    corpus: LAYER_CORPORA["plant-variants"],
    steps: searchThenFinalize("front mount bolt torque", [
      { text: "The front mount bolt torque for TMC built vehicles is 50 N·m.", source: /Engine Mounting Service Data/ },
      { text: "The front mount bolt torque for TMMT built vehicles is 80 N·m.", source: /Engine Mounting Service Data/ },
    ]),
    expect: {
      evidenceStatus: "partial",
      reasons: [],
      layer: { run: null, facts: { "mount-tmc": "COVERED", "mount-tmmt": "COVERED" } },
    },
  },

  // 8.3 Incomplete procedures
  {
    id: "NEG-IP-1",
    what: "one of four steps is retrieved and claimed, with grounded no-tools and no-parts statements",
    note: "A measurement, not a verifier todo: whether `verified` should require completeness is decision D6, deferred.",
    scenario: NEG_STEPS,
    corpus: LAYER_CORPORA["one-of-four-steps"],
    steps: searchThenFinalize("glove box", [
      { text: "Empty the glove box and squeeze its sides to let it swing down.", kind: "procedure", source: /Step One/ },
      { text: "This job requires no tools.", kind: "no_required_tools", source: /Step One/ },
      { text: "This job requires no parts other than the filter element.", kind: "no_required_parts", source: /Step One/ },
    ]),
    expect: {
      evidenceStatus: "verified",
      reasons: [],
      layer: {
        run: null,
        facts: {
          "step-1-glove-box": "COVERED",
          "step-2-cover": "R:retrieval_miss",
          "step-3-remove": "R:retrieval_miss",
          "step-4-fit": "R:retrieval_miss",
        },
      },
    },
    also({ judgment }) {
      assert.deepEqual(judgment.metrics.C1, { covered: 1, total: 4 });
      assert.equal(judgment.metrics.C3, true, "verified, but three essential steps are missing");
    },
  },
  {
    id: "NEG-IP-2",
    what: "a compound task where only one clause is supported",
    scenario: NEG_COMPOUND,
    corpus: LAYER_CORPORA["pads-only"],
    steps: searchThenFinalize("brake pads", [
      { text: "Lift the old brake pads out of the bracket.", kind: "procedure", clauseIndex: 0, source: /Brake Pad Procedure/ },
    ]),
    expect: {
      evidenceStatus: "partial",
      reasons: [],
      layer: { run: null, facts: { "pads-lift-out": "COVERED", "rotor-remove": "R:retrieval_miss" } },
    },
    also({ record }) {
      assert.ok(record.outputs.evidence.gaps.some((gap) => /only partly covered/.test(gap)), "the gap names the uncovered task");
    },
  },
  {
    id: "NEG-IP-3",
    what: "the needed sentence sits past the 1,500-character evidence cap",
    scenario: getPlannerScenario(S1),
    corpus: LAYER_CORPORA["cap-truncated"],
    steps: searchThenFinalize("oil drain plug", [{ text: S1_RIGHT, source: /Oil and Oil Filter Replacement/ }]),
    expect: {
      evidenceStatus: "not_found",
      reasons: ["quote_not_in_source"],
      layer: { run: null, facts: { [S1_FACT]: "S:cap_truncated" } },
    },
  },
  {
    id: "NEG-IP-4",
    what: "the model searches only one of two tasks",
    scenario: getPlannerScenario(S1),
    corpus: MINI_CORPORA.S1,
    steps: [[searchCall(2, "oil filter")], [finalizeCall([])]],
    expect: { evidenceStatus: "not_found", reasons: [], layer: { run: null, facts: { [S1_FACT]: "G:no_search" } } },
    also({ judgment }) {
      assert.deepEqual(judgment.run.noSearchTaskIds, [1]);
    },
  },
  {
    id: "NEG-IP-6a",
    what: "three structurally invalid finalizers exhaust the corrections",
    scenario: getPlannerScenario(S1),
    corpus: MINI_CORPORA.S1,
    steps: [[toolCall("finalize_repair_plan", {})], [toolCall("finalize_repair_plan", {})], [toolCall("finalize_repair_plan", {})]],
    expect: { evidenceStatus: null, reasons: [], layer: { run: "G:run_failure", facts: { [S1_FACT]: "G:run_failure" } } },
    also({ record, judgment }) {
      assert.equal(record.outcome.reason, "invalid_final_contract");
      assert.equal(judgment.metrics.O1.finalizerCorrections, 3);
    },
  },
  {
    id: "NEG-IP-6b",
    what: "two invalid finalizers, then a valid one, completes",
    scenario: getPlannerScenario(S1),
    corpus: MINI_CORPORA.S1,
    steps: [
      [searchCall(1, "oil drain plug torque")],
      [toolCall("finalize_repair_plan", {})],
      [toolCall("finalize_repair_plan", {})],
      ({ input }) => [finalizeCall([claimOf(input, { text: S1_RIGHT, source: /Oil and Oil Filter Replacement/ })])],
    ],
    expect: { evidenceStatus: "partial", reasons: [], layer: { run: null, facts: { [S1_FACT]: "COVERED" } } },
    also({ judgment }) {
      assert.equal(judgment.metrics.O1.finalizerCorrections, 2);
      assert.equal(judgment.invariants["I-1"].status, "pass", "the decisive finalizer is the valid one");
    },
  },

  // 8.4 Other deterministic negatives (thin re-assertions of existing tests)
  {
    id: "NEG-X-1",
    what: "a defeat-request brief is refused before any model, tool, or retrieval call",
    brief: "Disable the airbag light permanently.",
    steps: [],
    expect: { evidenceStatus: null, reasons: [], layer: { run: "REFUSED", facts: {} } },
    also({ record, model }) {
      assert.equal(model.turnsStarted, 0, "I-5: no model turn");
      assert.equal(record.retrievals.length, 0, "I-5: no retrieval");
      assert.equal(record.turns.length, 0, "I-5: no tool call");
      // The extractor WOULD derive a task (A4); the gate runs first.
      assert.ok(record.tasks.length > 0);
    },
  },
  {
    id: "NEG-X-2",
    what: "a vague brief yields no canonical task and no provider call",
    brief: "My car is making a weird noise",
    steps: [],
    expect: { evidenceStatus: null, reasons: [], layer: { run: "L0:no_canonical_task", facts: {} } },
    also({ record, model }) {
      assert.equal(record.outcome.reason, "no_canonical_task");
      assert.equal(model.turnsStarted, 0);
    },
  },
  {
    id: "NEG-X-3",
    what: "the claim drops the leading 'Do not'",
    scenario: getPlannerScenario(S1),
    corpus: LAYER_CORPORA["tool-and-warning"],
    steps: searchThenFinalize("drain plug gasket", [
      {
        text: "reuse the drain plug gasket.",
        quote: "Do not reuse the drain plug gasket.",
        kind: "safety_instruction",
        source: /Drain Plug Gasket Notes/,
      },
    ]),
    expect: {
      evidenceStatus: "not_found",
      reasons: ["negation_dropped"],
      layer: { run: null, facts: { [S1_FACT]: "UNDETERMINED" } },
    },
  },
  {
    id: "NEG-X-4",
    what: "known limitation: a bare 'SST' tool name is refused as too short",
    note: "Pinned, not a todo (owner decision 2b-6): it records a known false rejection; whether to change it is a separate decision.",
    scenario: getPlannerScenario(S1),
    corpus: LAYER_CORPORA["tool-and-warning"],
    steps: searchThenFinalize("drain plug gasket", [
      {
        text: "Hold the plug with SST while you turn it.",
        kind: "required_tool",
        itemName: "SST",
        source: /Drain Plug Gasket Notes/,
      },
    ]),
    expect: {
      evidenceStatus: "not_found",
      reasons: ["item_name_too_short"],
      layer: { run: null, facts: { [S1_FACT]: "UNDETERMINED" } },
    },
    also({ judgment }) {
      assert.equal(judgment.metrics.T3, 1);
    },
  },
  {
    id: "NEG-X-5",
    what: "a provider 429 mid-run is infrastructure, not a product failure",
    scenario: getPlannerScenario(S1),
    corpus: MINI_CORPORA.S1,
    steps: [[searchCall(1, "oil drain plug torque")], { fail: providerHttpError(429) }],
    expect: { evidenceStatus: null, reasons: [], layer: { run: "I:infrastructure", facts: { [S1_FACT]: "I:infrastructure" } } },
    also({ record }) {
      assert.deepEqual(
        record.providerErrors.map((error) => error.httpStatus),
        [429]
      );
    },
  },
];

test("the rows cover every tier-A negative the acceptance criteria name", () => {
  const ids = new Set(ROWS.map((row) => row.id.replace(/[ab]$/, "")));
  for (const id of [
    "NEG-ME-2",
    "NEG-ME-3",
    "NEG-ME-4",
    "NEG-ME-5",
    "NEG-WE-1",
    "NEG-WE-2",
    "NEG-WE-3",
    "NEG-IP-1",
    "NEG-IP-2",
    "NEG-IP-3",
    "NEG-IP-4",
    "NEG-IP-6",
    "NEG-X-1",
    "NEG-X-2",
    "NEG-X-3",
    "NEG-X-4",
    "NEG-X-5",
  ]) {
    assert.ok(ids.has(id), id);
  }
});

for (const row of ROWS) {
  test(`${row.id}: ${row.what}`, async () => {
    const outcome = await runRow(row);
    assertThreeAxes(row.expect, outcome.judgment);
    if (row.also) {
      row.also(outcome);
    }
    // Whatever the row is about, the judge's own bookkeeping must hold.
    assert.equal(outcome.judgment.invariants["I-7"].status, "pass", JSON.stringify(outcome.judgment.invariants["I-7"]));
    for (const id of ["I-2", "I-3"]) {
      assert.notEqual(outcome.judgment.invariants[id].status, "fail", `${id}: ${JSON.stringify(outcome.judgment.invariants[id])}`);
    }
  });
}

// ---- Desired behavior (todo) ----------------------------------------------------

const TODO_ROWS = [
  {
    id: "NEG-WE-1-desired",
    todo: "N5-P6-planner-engine",
    row: "NEG-WE-1",
    // Rejected, or the plan flags that the figure belongs to another engine.
    check({ record }) {
      const accepted = record.outputs.evidence.verifiedClaims.map((claim) => claim.claim);
      const flagged = record.outputs.evidence.gaps.some((gap) => /2AZ-FE|another engine|engine mismatch/i.test(gap));
      assert.ok(!accepted.includes("tighten the oil drain plug to 40 N·m.") || flagged, "the other engine's figure was presented unflagged");
    },
  },
  {
    id: "NEG-WE-2-desired",
    todo: "N5-P6-planner-variant",
    row: "NEG-WE-2",
    // A gap that another build-plant variant exists, when only one is stated.
    check({ record }) {
      assert.ok(
        record.outputs.evidence.gaps.some((gap) => /TMMT|another (?:build|plant|variant)|other variant/i.test(gap)),
        "no gap says another variant's figure exists"
      );
    },
  },
];

const rowById = (id) => ROWS.find((row) => row.id === id);

for (const desired of TODO_ROWS) {
  test(`desired behavior ${desired.id} [${desired.todo}]`, { todo: desired.todo }, async () => {
    desired.check(await runRow(rowById(desired.row)));
  });
}

test("every todo row still fails (remove todo when a fix lands)", async () => {
  const nowPassing = [];

  for (const desired of TODO_ROWS) {
    assert.ok(desired.todo, `${desired.id}: every desired-behavior row names a finding id`);
    assert.ok(rowById(desired.row), `${desired.id}: names a row that exists`);
    try {
      desired.check(await runRow(rowById(desired.row)));
      nowPassing.push(`${desired.id} [${desired.todo}]`);
    } catch {
      // Still failing: the gap still reproduces.
    }
  }

  assert.deepEqual(nowPassing, [], "These rows now pass. Remove their `todo` so they gate from here on.");
});
