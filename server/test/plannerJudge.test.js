import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

// The Repair Planner judge (docs/planner-eval-spec.md, Phase 2b). It turns one
// recorded run into two ledgers -- one outcome per confirmed golden fact and one
// verdict per submitted claim -- plus metrics and hard invariants.
//
// The labels it must reproduce were written FIRST, in Phase 2a's scenario data
// (claimExamples and claimSetExamples). If one of these tests fails because a
// label looks wrong, the label is fixed in review; the judge is never bent to
// fit a label, and a label is never edited to fit the judge.

const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-planner-judge-"));
process.env.DATABASE_FILE = path.join(scratchRoot, "judge.db");
process.env.UPLOADS_DIR = path.join(scratchRoot, "uploads");
process.env.OPENAI_API_KEY = "";
process.env.NETWORK_MODE = "0";
fs.mkdirSync(process.env.UPLOADS_DIR, { recursive: true });

const { db } = await import("../src/database.js");
const { runRepairPlannerAgent } = await import("../src/services/agent/repairPlannerAgent.js");
const { extractRepairTasks } = await import("../src/services/agent/repairTools.js");
const { createPlanRunStore } = await import("../src/services/agent/planRunStore.js");
const { runPlannerCase } = await import("../src/evals/plannerCaseRunner.js");
const { PLANNER_SCENARIOS, getPlannerScenario, validateScenario } = await import("../src/evals/plannerScenarios.js");
const { MINI_CORPORA, createKeywordRetriever } = await import("../src/evals/fixtures/plannerMiniCorpora.js");
const { SCRIPTED_RUNS, scriptedRun } = await import("../src/evals/fixtures/plannerScriptedRuns.js");
const { LAYER_CORPORA } = await import("../src/evals/fixtures/plannerLayerCorpora.js");
const { createScriptedModel, finalizeCall, searchCall, sourceIdFor, providerHttpError, toolCall } = await import(
  "../src/evals/plannerScriptedModel.js"
);
const { buildRunSet, discoverComparisonFiles, findProvenanceMarkers, findSharedRuns } = await import(
  "./fixtures/sourceDerivedMaterial.js"
);
const judge = await import("../src/evals/plannerJudge.js");

after(() => {
  if (typeof db.close === "function") {
    db.close();
  }
  fs.rmSync(scratchRoot, { recursive: true, force: true });
});

const S1_RIGHT = "Tighten the oil drain plug to 37 N·m (27 ft-lbf).";
const S1_FACT = "s1-drain-plug-torque";

const factOf = (judgment, id) => {
  const entry = judgment.facts.find((fact) => fact.factId === id);
  assert.ok(entry, `the fact ledger has no entry for ${id}`);
  return entry;
};

/** Run one scripted model through the REAL agent and the real verifier. */
async function recordRun(scenario, { steps, corpus }) {
  const model = createScriptedModel(steps);
  const record = await runPlannerCase(scenario, {
    runAgent: runRepairPlannerAgent,
    extractTasks: extractRepairTasks,
    createPlanRuns: () => createPlanRunStore(),
    streamTurn: model.streamTurn,
    retrieve: createKeywordRetriever(corpus),
  });
  return { record, model };
}

/** The common script: search once for one task, then finalize these claims. */
function searchThenFinalize(query, claimsFor, { taskId = 1 } = {}) {
  return [[searchCall(taskId, query)], ({ input }) => [finalizeCall(claimsFor(input))]];
}

const numericClaim = (input, text, source, overrides = {}) => ({
  taskId: 1,
  kind: "numeric_spec",
  claim: text,
  sourceId: sourceIdFor(input, source),
  evidenceQuote: text,
  ...overrides,
});

/** A copy of a committed scenario with some fields replaced, for one test. */
function variantOf(id, edit) {
  const copy = structuredClone(getPlannerScenario(id));
  edit(copy);
  assert.deepEqual(validateScenario(copy), [], "a test variant must itself be a valid scenario");
  return copy;
}

const SURVEYED = (fact, { quality, probe }) => {
  fact.sourceQuality = quality;
  fact.qualityEvidence = { kind: "synthetic-test", ref: "plannerJudge.test.js" };
  fact.goldenQueryRetrieves = probe;
  fact.goldenQueryEvidence = { kind: "synthetic-test", ref: "plannerJudge.test.js" };
};

// ---- 1. The claim matcher reproduces every labelled example -------------------

for (const scenario of PLANNER_SCENARIOS) {
  for (const fact of scenario.facts) {
    for (const example of fact.claimExamples) {
      test(`matcher: ${fact.id} / ${example.category} -> ${example.expect}`, () => {
        assert.equal(judge.labelClaimForFact(example.text, fact), example.expect, example.text);
      });
    }
  }
}

test("matcher: every label the scenario data uses is one the matcher can produce", () => {
  for (const scenario of PLANNER_SCENARIOS) {
    for (const fact of scenario.facts) {
      for (const example of fact.claimExamples) {
        assert.ok(judge.CLAIM_LABELS.includes(example.expect), example.expect);
      }
    }
  }
});

test("matcher: a matcher regex is never left holding state between calls", () => {
  const fact = getPlannerScenario("S1-oil-and-filter").facts[0];
  for (let i = 0; i < 3; i += 1) {
    assert.equal(judge.labelClaimForFact(S1_RIGHT, fact), "covers");
  }
});

test("matcher: a figure inside a word or code is not read as a figure", () => {
  const fact = getPlannerScenario("S2-spark-plugs").facts[0];
  // "14x1.25 mm" is a thread size: the 1.25 is part of the token, not a gap.
  assert.equal(
    judge.labelClaimForFact("Fit a 14x1.25 mm thread plug and set its electrode gap for a new plug to 1.0 to 1.1 mm.", fact),
    "covers"
  );
  // ...while the same figure on its own IS a figure, and a wrong one.
  assert.equal(
    judge.labelClaimForFact("Set the electrode gap for a new plug to 1.25 mm.", fact),
    "wrong_figure"
  );
});

test("matcher: a fabrication rule's decoys can never match its subject, so the matcher need not read them", () => {
  for (const scenario of PLANNER_SCENARIOS) {
    for (const fact of scenario.facts.filter((candidate) => candidate.kind === "absence")) {
      const decoyTexts = ["drive belt", "drive-belt", "serpentine belt", "v-ribbed belt", "accessory belt", "timing chain"];
      for (const text of decoyTexts) {
        assert.ok(fact.fabrication.decoys.some((decoy) => decoy.test(text)), `${text} is a declared decoy`);
        assert.equal(fact.fabrication.subject.test(text), false, `${text} must not match the subject`);
      }
    }
  }
});

test("matcher: a timing-belt claim is forbidden even when another clause negates something", () => {
  const fact = getPlannerScenario("S8-timing-belt").facts[0];
  assert.equal(
    judge.labelClaimForFact("Do not over-tighten anything; replace the timing belt every 90,000 miles.", fact),
    "forbidden"
  );
  assert.equal(judge.labelClaimForFact("The engine has no timing belt to replace.", fact), "not_forbidden");
});

// ---- 2. Claim sets reproduce every labelled set outcome -----------------------

for (const scenario of PLANNER_SCENARIOS) {
  for (const example of scenario.claimSetExamples) {
    test(`claim set: ${scenario.id} / ${example.id}`, () => {
      const result = judge.judgeClaimSet(example.claims, scenario);

      for (const [factId, expected] of Object.entries(example.expect)) {
        assert.deepEqual(result.facts[factId], expected, `${example.id} / ${factId}`);
      }
      assert.equal(result.criticalFindings, example.criticalFindings, "critical findings");
    });
  }
}

test("claim set: a contradiction stays in layer V and keeps the fact out of P1's numerator", () => {
  const scenario = getPlannerScenario("S1-oil-and-filter");
  const result = judge.judgeClaimSet([S1_RIGHT, "Tighten the oil drain plug to 45 N·m (33 ft-lbf)."], scenario);
  assert.equal(judge.layerOf(result.facts[S1_FACT].outcome), "V");
  assert.equal(result.facts[S1_FACT].inP1Numerator, false);
});

// ---- 3. The scoring gate --------------------------------------------------------

test("scoring gate: an unconfirmed fact is unscored -- never a pass, never a failure", async () => {
  const scenario = variantOf("S1-oil-and-filter", (copy) => {
    copy.facts[0].confirmed = false;
  });
  // The contradiction run: with the fact confirmed it is a critical finding.
  const run = scriptedRun("S1-contradiction");
  const real = await runPlannerCase(scenario, {
    runAgent: runRepairPlannerAgent,
    extractTasks: extractRepairTasks,
    createPlanRuns: () => createPlanRunStore(),
    streamTurn: run.model.streamTurn,
    retrieve: createKeywordRetriever(MINI_CORPORA[run.corpus]),
  });
  const judgment = judge.judgeRun(real, scenario);
  const entry = factOf(judgment, S1_FACT);

  assert.equal(entry.scoring, "unscored");
  assert.equal(entry.outcome, null, "an unscored fact has no outcome");
  assert.equal(judgment.metrics.P1, "unscored");
  assert.equal(judgment.metrics.P2, "unscored", "P2 depends on the confirmed fact's acceptable set");
  assert.deepEqual(judgment.critical, [], "an unconfirmed expectation can never create a critical finding");
  assert.deepEqual(judgment.unscored.facts, [S1_FACT]);
  assert.ok(judgment.claims.every((claim) => claim.classification.startsWith("unscored_")));
});

test("scoring gate: a truthy non-boolean `confirmed` is still unscored", () => {
  const scenario = getPlannerScenario("S1-oil-and-filter");
  const fact = { ...scenario.facts[0], confirmed: "yes" };
  const result = judge.judgeClaimSet([S1_RIGHT], { ...scenario, facts: [fact] });
  assert.equal(result.facts[S1_FACT], undefined, "an unscored fact gets no claim-set outcome");
});

// ---- 4. The eight scripted runs, judged ----------------------------------------

/** What the judge must say about each Phase 2a run. Outcomes, not wording. */
const SCRIPTED_EXPECTATIONS = {
  "S1-correct-only": { facts: { [S1_FACT]: "COVERED" }, P1: { covered: 1, total: 1 }, P2: 0, P3: 0 },
  "S1-contradiction": {
    facts: { [S1_FACT]: "V:false_acceptance" },
    kind: { [S1_FACT]: "contradicted" },
    P1: { covered: 0, total: 1 },
    P2: 1,
    P3: 0,
  },
  "S2-correct": {
    // The used-plug maximum is printed in the same chunk and no claim states it:
    // an omission, but of a non-essential fact, so it costs P1 nothing.
    facts: { "s2-new-plug-gap": "COVERED", "s2-used-plug-max-gap": "G:omission" },
    P1: { covered: 1, total: 1 },
    P2: 0,
    P3: 0,
  },
  "S2-trap": {
    facts: { "s2-new-plug-gap": "V:false_acceptance", "s2-used-plug-max-gap": "G:omission" },
    kind: { "s2-new-plug-gap": "contradicted" },
    P1: { covered: 0, total: 1 },
    P2: 1,
    P3: 0,
  },
  "S2-both-facts": {
    facts: { "s2-new-plug-gap": "COVERED", "s2-used-plug-max-gap": "COVERED" },
    P1: { covered: 1, total: 1 },
    P2: 0,
    P3: 0,
  },
  "S8-refusal": { facts: { "s8-no-timing-belt-procedure": "CORRECTLY_ABSENT" }, P1: "unscored", P2: 0, P3: 0 },
  "S8-fabrication": {
    facts: { "s8-no-timing-belt-procedure": "V:false_acceptance" },
    kind: { "s8-no-timing-belt-procedure": "fabrication" },
    P1: "unscored",
    P2: 0,
    P3: 1,
  },
  // The planner accepts a drive-belt claim for the timing-belt task (its task
  // check shares only the word "belt"); the judge must not call it fabrication.
  "S8-drive-belt-decoy": { facts: { "s8-no-timing-belt-procedure": "CORRECTLY_ABSENT" }, P1: "unscored", P2: 0, P3: 0 },
};

test("every scripted run has a judge expectation, and no expectation names a missing run", () => {
  assert.deepEqual(Object.keys(SCRIPTED_EXPECTATIONS).sort(), Object.keys(SCRIPTED_RUNS).sort());
});

for (const [runId, expected] of Object.entries(SCRIPTED_EXPECTATIONS)) {
  test(`scripted run ${runId}: fact outcomes, metrics, and invariants`, async () => {
    const run = scriptedRun(runId);
    const scenario = getPlannerScenario(run.scenarioId);
    const record = await runPlannerCase(scenario, {
      runAgent: runRepairPlannerAgent,
      extractTasks: extractRepairTasks,
      createPlanRuns: () => createPlanRunStore(),
      streamTurn: run.model.streamTurn,
      retrieve: createKeywordRetriever(MINI_CORPORA[run.corpus]),
    });
    const judgment = judge.judgeRun(record, scenario);

    for (const [factId, outcome] of Object.entries(expected.facts)) {
      assert.equal(factOf(judgment, factId).outcome, outcome, factId);
    }
    for (const [factId, kind] of Object.entries(expected.kind ?? {})) {
      assert.equal(factOf(judgment, factId).kind, kind, `${factId} kind`);
    }
    assert.deepEqual(judgment.metrics.P1, expected.P1, "P1");
    assert.equal(judgment.metrics.P2, expected.P2, "P2");
    assert.equal(judgment.metrics.P3, expected.P3, "P3");

    // Critical findings print whenever P2 or P3 is above zero.
    assert.equal(judgment.critical.length > 0, expected.P2 + expected.P3 > 0, JSON.stringify(judgment.critical));

    for (const id of ["I-1", "I-2", "I-3", "I-4", "I-7"]) {
      assert.equal(judgment.invariants[id].status, "pass", `${id}: ${JSON.stringify(judgment.invariants[id])}`);
    }
    // Two ledgers: every submitted claim has exactly one verdict.
    const submitted = record.finalizers.at(-1).arguments.claims.length;
    assert.equal(judgment.claims.length, submitted);
  });
}

test("scripted run S1-contradiction: both claims are accepted, and only the wrong one is a false acceptance", async () => {
  const run = scriptedRun("S1-contradiction");
  const scenario = getPlannerScenario(run.scenarioId);
  const record = await runPlannerCase(scenario, {
    runAgent: runRepairPlannerAgent,
    extractTasks: extractRepairTasks,
    createPlanRuns: () => createPlanRunStore(),
    streamTurn: run.model.streamTurn,
    retrieve: createKeywordRetriever(MINI_CORPORA[run.corpus]),
  });
  const judgment = judge.judgeRun(record, scenario);

  assert.deepEqual(
    judgment.claims.map((claim) => [claim.verdict, claim.classification]),
    [
      ["accepted", "covered"],
      ["accepted", "false_acceptance"],
    ]
  );
  assert.deepEqual(judgment.metrics.U4, { falseAcceptances: 1, falseRejections: 0 });
  // U1 is never shown without U4 (7.4 rule 1): they travel together.
  assert.deepEqual(Object.keys(judgment.metrics.U1).sort(), ["falseAcceptances", "falseRejections", "rate", "rejected", "submitted"]);
});

// ---- 5. One fixture per failure layer, each the single classification --------

/**
 * Each row produces exactly one non-OK outcome for the S1 drain-plug fact,
 * through the real agent. Together they cover every layer the acceptance
 * criteria list: L0, S, R, V (false rejection), V (false acceptance),
 * G (omission), G (query), G (no_search), G (run_failure), and I.
 */
const LAYER_ROWS = [
  {
    id: "L0",
    outcome: "L0:job_not_derived",
    // The brief asks only for the filter, so no task is the oil change the
    // (here confirmed) desired job describes.
    scenario: () =>
      variantOf("S1-oil-and-filter", (copy) => {
        copy.brief = "Replace the oil filter.";
        copy.desiredJobs.decomposition.forEach((job) => {
          job.confirmed = true;
        });
      }),
    corpus: MINI_CORPORA.S1,
    steps: searchThenFinalize("oil filter", () => []),
  },
  {
    id: "S:cap_truncated",
    outcome: "S:cap_truncated",
    scenario: () => getPlannerScenario("S1-oil-and-filter"),
    corpus: LAYER_CORPORA["cap-truncated"],
    steps: searchThenFinalize("oil drain plug", () => []),
  },
  {
    id: "S:source_unusable",
    outcome: "S:source_unusable",
    scenario: () => variantOf("S1-oil-and-filter", (copy) => SURVEYED(copy.facts[0], { quality: "garbled", probe: true })),
    corpus: LAYER_CORPORA.garbled,
    steps: searchThenFinalize("oil drain plug", () => []),
  },
  {
    id: "R:retrieval_miss",
    outcome: "R:retrieval_miss",
    scenario: () => variantOf("S1-oil-and-filter", (copy) => SURVEYED(copy.facts[0], { quality: "clean", probe: false })),
    corpus: LAYER_CORPORA.unrelated,
    steps: searchThenFinalize("wiper blade", () => []),
  },
  {
    id: "G:query_formulation",
    outcome: "G:query_formulation",
    scenario: () => variantOf("S1-oil-and-filter", (copy) => SURVEYED(copy.facts[0], { quality: "clean", probe: true })),
    corpus: LAYER_CORPORA.unrelated,
    steps: searchThenFinalize("wiper blade", () => []),
  },
  {
    id: "V:false_rejection",
    outcome: "V:false_rejection",
    reasons: ["quote_not_in_source"],
    scenario: () => getPlannerScenario("S1-oil-and-filter"),
    corpus: MINI_CORPORA.S1,
    // The right claim, with a quote that misprints the chunk's wording.
    steps: searchThenFinalize("oil drain plug torque", (input) => [
      numericClaim(input, S1_RIGHT, /Oil and Oil Filter Replacement/, {
        evidenceQuote: "Tighten the engine oil drain plug to 37 N·m (27 ft-lbf).",
      }),
    ]),
  },
  {
    id: "V:false_acceptance",
    outcome: "V:false_acceptance",
    scenario: () => getPlannerScenario("S1-oil-and-filter"),
    corpus: MINI_CORPORA.S1,
    steps: searchThenFinalize("oil drain plug torque", (input) => [
      numericClaim(input, "Tighten the oil drain plug to 45 N·m (33 ft-lbf).", /Variant Zeta/),
    ]),
  },
  {
    id: "G:omission",
    outcome: "G:omission",
    scenario: () => getPlannerScenario("S1-oil-and-filter"),
    corpus: MINI_CORPORA.S1,
    steps: searchThenFinalize("oil drain plug torque", () => []),
  },
  {
    id: "G:no_search",
    outcome: "G:no_search",
    scenario: () => getPlannerScenario("S1-oil-and-filter"),
    corpus: MINI_CORPORA.S1,
    // Only task 2 (the filter) is searched; the drain plug belongs to task 1.
    steps: [[searchCall(2, "oil filter")], [finalizeCall([])]],
  },
  {
    id: "G:run_failure",
    outcome: "G:run_failure",
    scenario: () => getPlannerScenario("S1-oil-and-filter"),
    corpus: MINI_CORPORA.S1,
    // Three structurally invalid finalizers exhaust the corrections.
    steps: [[toolCall("finalize_repair_plan", {})], [toolCall("finalize_repair_plan", {})], [toolCall("finalize_repair_plan", {})]],
  },
  {
    id: "I",
    outcome: "I:infrastructure",
    scenario: () => getPlannerScenario("S1-oil-and-filter"),
    corpus: MINI_CORPORA.S1,
    steps: [{ fail: providerHttpError(429) }],
  },
];

for (const row of LAYER_ROWS) {
  test(`layer fixture ${row.id}: the drain-plug fact gets exactly that one outcome`, async () => {
    const scenario = row.scenario();
    const { record } = await recordRun(scenario, { steps: row.steps, corpus: row.corpus });
    const judgment = judge.judgeRun(record, scenario);
    const entry = factOf(judgment, S1_FACT);

    assert.equal(entry.outcome, row.outcome, JSON.stringify(entry));
    if (row.reasons) {
      assert.deepEqual(entry.reasons, row.reasons);
    }
    assert.equal(judgment.invariants["I-7"].status, "pass", JSON.stringify(judgment.invariants["I-7"]));
  });
}

test("layer fixtures cover every layer the acceptance criteria require", () => {
  const layers = new Set(LAYER_ROWS.map((row) => row.outcome));
  for (const required of [
    "L0:job_not_derived",
    "R:retrieval_miss",
    "V:false_rejection",
    "V:false_acceptance",
    "G:omission",
    "G:query_formulation",
    "G:no_search",
    "G:run_failure",
    "I:infrastructure",
  ]) {
    assert.ok(layers.has(required), required);
  }
  assert.ok([...layers].some((outcome) => outcome.startsWith("S:")), "an S outcome");
});

test("unknown stays unknown: a missed fact with no survey is UNDETERMINED, naming what is missing", async () => {
  const scenario = getPlannerScenario("S1-oil-and-filter");
  const { record } = await recordRun(scenario, {
    steps: searchThenFinalize("wiper blade", () => []),
    corpus: LAYER_CORPORA.unrelated,
  });
  const entry = factOf(judge.judgeRun(record, scenario), S1_FACT);

  assert.equal(entry.outcome, "UNDETERMINED");
  assert.deepEqual(entry.missing, ["sourceQuality", "goldenQueryRetrieves"]);
  assert.equal(judge.layerOf(entry.outcome), "UNDETERMINED", "an attribution status, not a layer");
});

test("unknown stays unknown: with only one survey field known, the other is still named", async () => {
  const scenario = variantOf("S1-oil-and-filter", (copy) => {
    copy.facts[0].sourceQuality = "clean";
    copy.facts[0].qualityEvidence = { kind: "synthetic-test", ref: "plannerJudge.test.js" };
  });
  const { record } = await recordRun(scenario, {
    steps: searchThenFinalize("wiper blade", () => []),
    corpus: LAYER_CORPORA.unrelated,
  });
  const entry = factOf(judge.judgeRun(record, scenario), S1_FACT);
  assert.equal(entry.outcome, "UNDETERMINED");
  assert.deepEqual(entry.missing, ["goldenQueryRetrieves"]);
});

test("desired jobs unconfirmed: a job no task derives is UNDETERMINED, never an L0 failure", async () => {
  const scenario = variantOf("S1-oil-and-filter", (copy) => {
    copy.brief = "Replace the oil filter.";
  });
  const { record } = await recordRun(scenario, {
    steps: searchThenFinalize("oil filter", () => []),
    corpus: MINI_CORPORA.S1,
  });
  const judgment = judge.judgeRun(record, scenario);

  assert.equal(factOf(judgment, S1_FACT).outcome, "UNDETERMINED");
  assert.deepEqual(factOf(judgment, S1_FACT).missing, ["desiredJobs"]);
  assert.equal(judgment.l0.scoring, "unscored");
  assert.deepEqual(judgment.l0.defects, [], "no L0 defect is scored from an unconfirmed job");
  // What happened is still reported.
  assert.deepEqual(
    judgment.l0.jobs.map((job) => [job.id, job.taskIds]),
    [
      ["change-engine-oil", []],
      ["replace-oil-filter", [1]],
    ]
  );
});

test("L0: S8 deriving a timing-belt task from a timing-belt brief is correct decomposition", async () => {
  const run = scriptedRun("S8-refusal");
  const scenario = variantOf("S8-timing-belt", (copy) => {
    copy.desiredJobs.decomposition[0].confirmed = true;
  });
  const record = await runPlannerCase(scenario, {
    runAgent: runRepairPlannerAgent,
    extractTasks: extractRepairTasks,
    createPlanRuns: () => createPlanRunStore(),
    streamTurn: run.model.streamTurn,
    retrieve: createKeywordRetriever(MINI_CORPORA[run.corpus]),
  });
  const judgment = judge.judgeRun(record, scenario);

  assert.equal(judgment.l0.scoring, "scored");
  assert.deepEqual(judgment.l0.defects, [], "the false premise is not a decomposition defect");
  assert.deepEqual(judgment.l0.phantomTaskIds, []);
});

test("L0: a confirmed job set reports a phantom task the brief did not ask for", () => {
  const scenario = variantOf("S2-spark-plugs", (copy) => {
    copy.desiredJobs.decomposition[0].confirmed = true;
  });
  const tasks = extractRepairTasks({ brief: "Replace the spark plugs. The engine also shakes at idle." }).tasks;
  const l0 = judge.evaluateTaskDerivation(tasks, scenario);

  assert.ok(tasks.length >= 1);
  if (tasks.length > 1) {
    assert.ok(l0.phantomTaskIds.length > 0);
    assert.ok(l0.defects.some((defect) => defect.startsWith("phantom_task")));
  } else {
    assert.deepEqual(l0.phantomTaskIds, []);
  }
});

test("corpusSupport partial is never COVERED: the best outcome is PARTIALLY_COVERED, tagged S:partial_source", async () => {
  const scenario = variantOf("S1-oil-and-filter", (copy) => {
    copy.facts[0].corpusSupport = "partial";
    copy.facts[0].partial = { partialKind: "qualifier_missing", supported: "the newton-metre figure" };
  });
  const run = scriptedRun("S1-correct-only");
  const record = await runPlannerCase(scenario, {
    runAgent: runRepairPlannerAgent,
    extractTasks: extractRepairTasks,
    createPlanRuns: () => createPlanRunStore(),
    streamTurn: run.model.streamTurn,
    retrieve: createKeywordRetriever(MINI_CORPORA[run.corpus]),
  });
  const judgment = judge.judgeRun(record, scenario);
  const entry = factOf(judgment, S1_FACT);

  assert.equal(entry.outcome, "PARTIALLY_COVERED");
  assert.deepEqual(entry.tags, ["S:partial_source"]);
  assert.deepEqual(judgment.metrics.P1, { covered: 0, total: 1 }, "it stays in the denominator only");
});

// ---- 6. I-7: the fact ledger reconciles ----------------------------------------

/**
 * A record built by hand, not by the agent: one search for task 1 returning the
 * given chunks, one finalizer with the given claims, a completed outcome. Its
 * outputs are the evidence contract's own, so I-1 holds on it too.
 */
function handBuiltRecord(scenario, chunks, claimsFor) {
  const tasks = extractRepairTasks({ brief: scenario.brief }).tasks;
  const sources = chunks.map((entry, index) => ({ ...entry, id: `S${index + 1}` }));
  const input = [
    {
      type: "function_call_output",
      output: JSON.stringify({
        context: sources.map((source) => `[${source.id}] ${source.documentTitle} (page ${source.pageNumber}): x`).join("\n\n"),
      }),
    },
  ];
  const claims = claimsFor(input);
  const rebuilt = judge.rebuildEvidence({ claims }, { tasks, chunks, request: scenario });

  return {
    scenarioId: scenario.id,
    repeat: 1,
    request: {
      brief: scenario.brief,
      skillLevel: scenario.skillLevel,
      availableTools: scenario.availableTools,
      availableParts: scenario.availableParts,
      constraints: scenario.constraints,
    },
    tasks,
    modelSawTasks: true,
    turns: [
      {
        turn: 1,
        streamCompleted: true,
        frameCount: 1,
        calls: [{ ordinal: 0, callId: "c1", name: "search_repair_docs", frameName: "search_repair_docs", arguments: { taskId: 1, query: "q" }, disposition: "retrieved", taskId: 1, retrievalCount: 1 }],
      },
      {
        turn: 2,
        streamCompleted: true,
        frameCount: 1,
        calls: [{ ordinal: 0, callId: "c2", name: "finalize_repair_plan", frameName: "finalize_repair_plan", arguments: { claims }, disposition: "executed", taskId: null, retrievalCount: 0 }],
      },
    ],
    retrievals: [{ turn: 1, callOrdinal: 0, callId: "c1", taskId: 1, query: "q", limit: 4, mode: null, results: structuredClone(chunks), error: null }],
    finalizers: [{ turn: 2, callOrdinal: 0, callId: "c2", arguments: { claims } }],
    outcome: { status: "completed", code: null, reason: null, evidenceStatus: rebuilt.evidenceStatus },
    providerErrors: [],
    outputs: {
      text: rebuilt.text,
      checklistDraft: null,
      checklist: null,
      handoffNotes: null,
      readiness: { score: 0, level: "not_ready" },
      requirements: rebuilt.requirements,
      citations: rebuilt.citations,
      evidence: { verifiedClaims: rebuilt.verifiedClaims, gaps: rebuilt.gaps },
      hasPlanRunId: false,
      hasChecklistDraftId: false,
    },
  };
}

test("I-7: a hand-built record with every kind of outcome reconciles to one outcome per confirmed fact", () => {
  const scenario = getPlannerScenario("S2-spark-plugs");
  // New-plug range accepted (COVERED); used-plug maximum printed but not claimed
  // (G:omission). Two confirmed facts, two outcomes.
  const record = handBuiltRecord(scenario, MINI_CORPORA.S2.slice(0, 1), (input) => [
    numericClaim(input, "Spark plug electrode gap for a new plug: 1.0 to 1.1 mm (0.0394 to 0.0433 in).", /Ignition Service Data/),
  ]);
  const judgment = judge.judgeRun(record, scenario);

  assert.deepEqual(
    judgment.facts.map((fact) => [fact.factId, fact.outcome]),
    [
      ["s2-new-plug-gap", "COVERED"],
      ["s2-used-plug-max-gap", "G:omission"],
    ]
  );
  assert.deepEqual(judge.reconcileFactLedger(judgment, scenario), []);
  assert.equal(judgment.invariants["I-1"].status, "pass", JSON.stringify(judgment.invariants["I-1"]));
});

test("I-7: a ledger that drops, duplicates, or invents an entry does not reconcile", () => {
  const scenario = getPlannerScenario("S2-spark-plugs");
  const record = handBuiltRecord(scenario, MINI_CORPORA.S2.slice(0, 1), () => []);
  const judgment = judge.judgeRun(record, scenario);

  const dropped = { ...judgment, facts: judgment.facts.slice(1) };
  assert.ok(judge.reconcileFactLedger(dropped, scenario).some((problem) => /no outcome/.test(problem)));

  const duplicated = { ...judgment, facts: [...judgment.facts, judgment.facts[0]] };
  assert.ok(judge.reconcileFactLedger(duplicated, scenario).some((problem) => /more than one/.test(problem)));

  const invented = { ...judgment, facts: [...judgment.facts, { factId: "no-such-fact", scoring: "scored", outcome: "COVERED" }] };
  assert.ok(judge.reconcileFactLedger(invented, scenario).some((problem) => /not a fact of/.test(problem)));

  const unknownOutcome = { ...judgment, facts: [{ ...judgment.facts[0], outcome: "MAYBE" }, judgment.facts[1]] };
  assert.ok(judge.reconcileFactLedger(unknownOutcome, scenario).some((problem) => /not a known outcome/.test(problem)));

  const scoredUnconfirmed = {
    ...judgment,
    facts: judgment.facts.map((fact) => ({ ...fact, scoring: "unscored", outcome: "COVERED" })),
  };
  assert.ok(judge.reconcileFactLedger(scoredUnconfirmed, scenario).some((problem) => /unscored but has an outcome|scored as unscored/.test(problem)));
});

// ---- 7. Hard invariants catch what they exist to catch -------------------------

test("I-1: a record whose outputs disagree with re-verification fails I-1", () => {
  const scenario = getPlannerScenario("S1-oil-and-filter");
  const record = handBuiltRecord(scenario, MINI_CORPORA.S1, (input) => [
    numericClaim(input, S1_RIGHT, /Oil and Oil Filter Replacement/),
  ]);
  record.outputs.evidence.verifiedClaims = [];
  assert.equal(judge.judgeRun(record, scenario).invariants["I-1"].status, "fail");
});

test("I-4: a figure in the plan text that no accepted quote prints fails I-4", () => {
  const scenario = getPlannerScenario("S1-oil-and-filter");
  const record = handBuiltRecord(scenario, MINI_CORPORA.S1, (input) => [
    numericClaim(input, S1_RIGHT, /Oil and Oil Filter Replacement/),
  ]);
  assert.equal(judge.judgeRun(record, scenario).invariants["I-4"].status, "pass");

  record.outputs.text = `${record.outputs.text}\nAlso tighten the filter cap to 25 N·m.`;
  const invariant = judge.judgeRun(record, scenario).invariants["I-4"];
  assert.equal(invariant.status, "fail");
  assert.ok(invariant.problems.some((problem) => /25/.test(problem)), JSON.stringify(invariant));
});

test("I-4: a figure the owner typed into the request is allowed", () => {
  const scenario = variantOf("S1-oil-and-filter", (copy) => {
    copy.constraints = "My torque wrench only goes to 25 N·m.";
  });
  const record = handBuiltRecord(scenario, MINI_CORPORA.S1, () => []);
  record.outputs.text = `${record.outputs.text}\nYour note: torque wrench limit 25 N·m.`;
  assert.equal(judge.judgeRun(record, scenario).invariants["I-4"].status, "pass");
});

test("I-2 and I-3: a not_found plan rated ready, or a safety-critical task rated ready, fails", () => {
  const scenario = getPlannerScenario("S1-oil-and-filter");
  const record = handBuiltRecord(scenario, MINI_CORPORA.S1, () => []);
  assert.equal(record.outcome.evidenceStatus, "not_found");

  record.outputs.readiness = { score: 100, level: "ready" };
  assert.equal(judge.judgeRun(record, scenario).invariants["I-3"].status, "fail");

  record.tasks = record.tasks.map((task) => ({ ...task, safetyCritical: true }));
  assert.equal(judge.judgeRun(record, scenario).invariants["I-2"].status, "fail");
});

test("the judge vehicle label matches the one the agent prints in its handoff notes", async () => {
  const run = scriptedRun("S1-correct-only");
  const scenario = getPlannerScenario(run.scenarioId);
  const record = await runPlannerCase(scenario, {
    runAgent: runRepairPlannerAgent,
    extractTasks: extractRepairTasks,
    createPlanRuns: () => createPlanRunStore(),
    streamTurn: run.model.streamTurn,
    retrieve: createKeywordRetriever(MINI_CORPORA[run.corpus]),
  });
  assert.ok(JSON.stringify(record.outputs.handoffNotes).includes(judge.DEFAULT_VEHICLE_LABEL));
});

// ---- 8. Metrics that need no answer key still report ---------------------------

test("metrics: status, readiness, operations, and rejection reasons report even when nothing is scored", async () => {
  const scenario = variantOf("S1-oil-and-filter", (copy) => {
    copy.facts[0].confirmed = false;
  });
  const { record } = await recordRun(scenario, {
    steps: searchThenFinalize("oil drain plug torque", (input) => [
      numericClaim(input, S1_RIGHT, /Oil and Oil Filter Replacement/, { evidenceQuote: "not in the chunk at all" }),
    ]),
    corpus: MINI_CORPORA.S1,
  });
  const judgment = judge.judgeRun(record, scenario);

  assert.equal(judgment.run.evidenceStatus, "not_found");
  assert.deepEqual(judgment.metrics.U2, { quote_not_in_source: 1 });
  assert.equal(judgment.metrics.R1.level, record.outputs.readiness.level);
  assert.equal(judgment.metrics.O1.modelTurns, 2);
  assert.equal(judgment.metrics.O1.searches, 1);
  assert.equal(judgment.metrics.O1.finalizerCorrections, 0);
  assert.equal(judgment.metrics.C1, "unscored", "no procedure fact is confirmed for S1");
  assert.equal(judgment.metrics.C3, false, "a not_found plan is never 'verified but thin'");
});

test("metrics: Q1 counts citations on a confirmed hinted source", async () => {
  const run = scriptedRun("S2-trap");
  const scenario = getPlannerScenario(run.scenarioId);
  const record = await runPlannerCase(scenario, {
    runAgent: runRepairPlannerAgent,
    extractTasks: extractRepairTasks,
    createPlanRuns: () => createPlanRunStore(),
    streamTurn: run.model.streamTurn,
    retrieve: createKeywordRetriever(MINI_CORPORA[run.corpus]),
  });
  const { Q1 } = judge.judgeRun(record, scenario).metrics;
  // Two citations: the service-data page 1 (hinted) and the inspection page 6 (hinted).
  assert.deepEqual(Q1, { onHintedSource: 2, citations: 2 });
});

// ---- 9. The new fixture text is invented ---------------------------------------

test("no layer-fixture chunk carries the manual vendor's marker or shares a verbatim run with a quoting file", () => {
  const serverRoot = path.resolve(import.meta.dirname, "..");
  // Same pool as plannerFixtures.test.js: every server .js except the
  // planner-eval files, which must never vouch for themselves.
  const files = discoverComparisonFiles([path.join(serverRoot, "src"), path.join(serverRoot, "test")], {
    exclude: /\/(?:planner[A-Za-z]*|sourceDerivedMaterial)(?:\.test)?\.js$/,
  });
  assert.ok(files.length >= 50, `found ${files.length} files to compare against`);
  const runSet = buildRunSet(files.map((file) => fs.readFileSync(file, "utf8")));

  for (const [key, chunks] of Object.entries(LAYER_CORPORA)) {
    for (const entry of chunks) {
      for (const text of [entry.chunkText, entry.documentTitle, entry.originalFilename]) {
        assert.deepEqual(findProvenanceMarkers(text), [], `${key}: provenance marker`);
        assert.deepEqual(findSharedRuns(text, runSet), [], `${key}: shares a run with a source-bearing file`);
      }
      assert.match(entry.documentTitle, /Synthetic Fixture/);
      assert.equal(entry.origin, "invented");
    }
  }
});
