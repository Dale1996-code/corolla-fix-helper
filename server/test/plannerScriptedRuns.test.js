import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import { MINI_CORPORA, createKeywordRetriever } from "../src/evals/fixtures/plannerMiniCorpora.js";
import { SCRIPTED_RUNS, scriptedRun } from "../src/evals/fixtures/plannerScriptedRuns.js";
import { runPlannerCase } from "../src/evals/plannerCaseRunner.js";
import { getPlannerScenario } from "../src/evals/plannerScenarios.js";
import { createPlanRunStore } from "../src/services/agent/planRunStore.js";

// The whole runs that make each trap real. Phase 2a only checks that the REAL
// agent, with the REAL verifier, does what each fixture claims it does:
// accepts the claims it says it accepts, and ends with the status it says. The
// scripts are not judged here -- classifying them is Phase 2b -- and a fixture
// that stopped producing its situation would be reported, never worked around
// by weakening a check.

const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-planner-scripted-"));
process.env.DATABASE_FILE = path.join(scratchRoot, "scripted.db");
process.env.UPLOADS_DIR = path.join(scratchRoot, "uploads");
process.env.OPENAI_API_KEY = "";
process.env.NETWORK_MODE = "0";
fs.mkdirSync(process.env.UPLOADS_DIR, { recursive: true });

const { db } = await import("../src/database.js");
const { runRepairPlannerAgent } = await import("../src/services/agent/repairPlannerAgent.js");
const { extractRepairTasks } = await import("../src/services/agent/repairTools.js");

after(() => {
  if (typeof db.close === "function") {
    db.close();
  }
  fs.rmSync(scratchRoot, { recursive: true, force: true });
});

async function record(runId) {
  const run = scriptedRun(runId);
  const scenario = getPlannerScenario(run.scenarioId);

  return runPlannerCase(scenario, {
    runAgent: runRepairPlannerAgent,
    extractTasks: extractRepairTasks,
    createPlanRuns: () => createPlanRunStore(),
    streamTurn: run.model.streamTurn,
    retrieve: createKeywordRetriever(MINI_CORPORA[run.corpus]),
  });
}

const accepted = (outcome) => outcome.outputs.evidence.verifiedClaims.map((claim) => claim.claim);

test("the fixtures are exactly the eight the judge will need", () => {
  assert.deepEqual(Object.keys(SCRIPTED_RUNS), [
    "S1-correct-only",
    "S1-contradiction",
    "S2-correct",
    "S2-trap",
    "S2-both-facts",
    "S8-refusal",
    "S8-fabrication",
    "S8-drive-belt-decoy",
  ]);
});

for (const runId of Object.keys(SCRIPTED_RUNS)) {
  test(`${runId}: the real agent accepts and rejects what the fixture says it does`, async () => {
    const run = scriptedRun(runId);
    const result = await record(runId);

    assert.equal(result.outcome.status, "completed", JSON.stringify(result.outcome));
    assert.equal(result.outcome.evidenceStatus, run.expect.evidenceStatus);
    assert.deepEqual(accepted(result), run.expect.accepted);

    const submitted = result.finalizers.flatMap((finalizer) => finalizer.arguments.claims);
    assert.equal(submitted.length - accepted(result).length, run.expect.rejected, "rejected claim count");
  });
}

test("a fixture run is repeatable: the same script gives the same record", async () => {
  assert.deepEqual(await record("S2-trap"), await record("S2-trap"));
});

// ---- Each scripted claim is one of the scenario's labelled examples ---------------

for (const [runId, definition] of Object.entries(SCRIPTED_RUNS)) {
  test(`${runId}: every scripted claim carries the label the scenario data gives it`, () => {
    const scenario = getPlannerScenario(definition.scenarioId);

    for (const claim of definition.claims) {
      for (const [factId, label] of Object.entries(claim.labelFor)) {
        const fact = scenario.facts.find((candidate) => candidate.id === factId);
        const example = fact?.claimExamples.find((candidate) => candidate.text === claim.text);

        assert.ok(example, `${runId}: "${claim.text}" is not a labelled example of ${factId}`);
        assert.equal(example.expect, label, `${runId}: "${claim.text}" for ${factId}`);
      }
    }
  });
}

test("a claim-set example in the scenario data has a scripted run wherever the agent can reach it", () => {
  // The sets the real verifier can produce are scripted; the rest (a lone range
  // endpoint, a bare duplicate) cannot get past it and stay labelled data.
  const scripted = new Set(Object.values(SCRIPTED_RUNS).map((run) => run.claims.map((claim) => claim.text).join("|")));

  for (const id of ["s1-contradiction", "s2-trap", "s2-both-facts-ok", "s8-fabrication"]) {
    const set = ["S1-oil-and-filter", "S2-spark-plugs", "S8-timing-belt"]
      .flatMap((scenarioId) => getPlannerScenario(scenarioId).claimSetExamples)
      .find((example) => example.id === id);

    // Order-insensitive: compare the claims as a set of texts.
    const wanted = [...set.claims].sort().join("|");
    const found = [...scripted].some((claims) => claims.split("|").sort().join("|") === wanted);
    assert.ok(found, `no scripted run reproduces claim set ${id}`);
  }
});

// ---- The situations the fixtures exist to produce ----------------------------------

test("S1-contradiction: the real verifier accepts a correct and an incorrect figure for one part", async () => {
  const result = await record("S1-contradiction");

  assert.deepEqual(accepted(result), [
    "Tighten the oil drain plug to 37 N·m (27 ft-lbf).",
    "Tighten the oil drain plug to 45 N·m (33 ft-lbf).",
  ]);
  assert.equal(result.retrievals[0].results.length, 3, "the variant's chunk was retrieved beside the right one");
});

test("S2-trap: an unqualified 1.3 mm from the orphaned page is accepted beside the correct range", async () => {
  const result = await record("S2-trap");

  assert.ok(accepted(result).includes("Spark plug electrode gap 1.3 mm (0.0512 in)."));
  assert.ok(accepted(result).includes("Spark plug electrode gap for a new plug: 1.0 to 1.1 mm (0.0394 to 0.0433 in)."));
});

test("S2-both-facts: the qualified used-plug maximum is accepted beside the new-plug range", async () => {
  const result = await record("S2-both-facts");

  assert.deepEqual(accepted(result), [
    "Spark plug electrode gap for a new plug: 1.0 to 1.1 mm (0.0394 to 0.0433 in).",
    "Maximum spark plug electrode gap for a used plug: 1.3 mm (0.0512 in).",
  ]);
});

test("S8-fabrication: a timing-belt claim is accepted only because the premise was broken on purpose", async () => {
  const result = await record("S8-fabrication");

  assert.deepEqual(accepted(result), ["Where a timing belt is fitted, renew the timing belt every 90,000 miles."]);
  assert.equal(scriptedRun("S8-fabrication").corpus, "S8-premise-violated");
});

test("S8-drive-belt-decoy: a drive-belt claim is accepted for the timing-belt task (an observation, not a requirement)", async () => {
  // The planner's task check needs only a shared word, and "belt" is one. This
  // run exists so the Phase 2b matcher can be shown NOT to call it a timing-belt
  // fabrication. If the verifier ever starts rejecting it, this fixture stops
  // producing its situation and must be reported, not bent.
  const result = await record("S8-drive-belt-decoy");

  assert.deepEqual(accepted(result), ["Replace the drive belt every 60,000 miles in severe service."]);
  assert.equal(scriptedRun("S8-drive-belt-decoy").corpus, "S8-premise-holds");
});

test("S8-refusal: a correct refusal accepts nothing and ends not_found", async () => {
  const result = await record("S8-refusal");

  assert.deepEqual(accepted(result), []);
  assert.equal(result.outcome.evidenceStatus, "not_found");
  assert.equal(result.finalizers[0].arguments.claims.length, 0);
});

test("scriptedRun hands each caller a fresh model, so two runs never share a script position", () => {
  const first = scriptedRun("S2-correct");
  const second = scriptedRun("S2-correct");

  assert.notEqual(first.model, second.model);
  assert.equal(first.model.turnsStarted, 0);
  assert.throws(() => scriptedRun("no-such-run"), /no scripted run/);
});
