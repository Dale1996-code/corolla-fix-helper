import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createPlanRunStore } from "../src/services/agent/planRunStore.js";
import {
  buildRunSet,
  discoverComparisonFiles,
  findProvenanceMarkers,
  findSharedRuns,
} from "./fixtures/sourceDerivedMaterial.js";

// Planner eval Phase 5: the baseline report. It is built here from a capture
// of REAL agent runs (the real verifier, a scripted model, invented text), so the
// three situations the required block must tell apart are produced by the code
// under test rather than typed in by hand:
//
//   (a) a verified/ready plan that omits a confirmed essential fact    -> C
//   (b) a verified/ready plan that covers every one of them            -> B
//   (c) a verified plan in a scenario with no essential confirmed fact -> D
//
// NO paid call is made, and no key or real database is read.
const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-planner-baseline-report-"));
process.env.DATABASE_FILE = path.join(scratchRoot, "report.db");
process.env.UPLOADS_DIR = path.join(scratchRoot, "uploads");
process.env.OPENAI_API_KEY = "";
process.env.NETWORK_MODE = "0";
fs.mkdirSync(process.env.UPLOADS_DIR, { recursive: true });

const { db } = await import("../src/database.js");
const { AGENT_INSTRUCTIONS, runRepairPlannerAgent } = await import("../src/services/agent/repairPlannerAgent.js");
const { extractRepairTasks } = await import("../src/services/agent/repairTools.js");
const { hashInstructions, parsePlannerCaptureText } = await import("../src/evals/plannerCapture.js");
const { judgeRun } = await import("../src/evals/plannerJudge.js");
const { PLANNER_SCENARIOS, getPlannerScenario } = await import("../src/evals/plannerScenarios.js");
const { BASELINE_CORPORA, buildBaselineCaptureText, recordBaselineFixtureRuns } = await import(
  "../src/evals/fixtures/plannerBaselineFixture.js"
);
const { BaselineReportRefused, buildBaselineReport, buildPerRunJson, formatBaselineLogSection, formatBaselineReport } =
  await import("../src/evals/reportPlannerBaseline.js");
const { runCli: runReportCli } = await import("../src/scripts/reportPlannerBaseline.js");

after(() => {
  if (typeof db.close === "function") {
    db.close();
  }
  fs.rmSync(scratchRoot, { recursive: true, force: true });
});

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, "..");
const SCRIPT = path.join(serverRoot, "src", "scripts", "reportPlannerBaseline.js");
const INSTRUCTIONS_HASH = hashInstructions(AGENT_INSTRUCTIONS);

const RUNS = await recordBaselineFixtureRuns({
  runAgent: runRepairPlannerAgent,
  extractTasks: extractRepairTasks,
  createPlanRuns: () => createPlanRunStore(),
});

const ALL = RUNS.map((entry) => entry.key);
const captureText = (keys, options = {}) =>
  buildBaselineCaptureText({ runs: RUNS, keys, instructionsHash: INSTRUCTIONS_HASH, ...options });

function parse(keys, options) {
  const parsed = parsePlannerCaptureText(captureText(keys, options));

  assert.deepEqual(parsed.errors, [], "the fixture capture must be readable in full");
  return parsed;
}

// The fixture's runs were scripted against the Phase 2a answer key (one
// essential figure per scenario). Phase 4 Stage B added the owner's D11 facts,
// which those runs never state, so these tests judge against the Phase 2a key
// to keep testing the report's own rules; one test below uses the committed
// key to show what the D11 facts change.
const PHASE_2A_FACTS = ["s1-drain-plug-torque", "s2-new-plug-gap", "s2-used-plug-max-gap", "s8-no-timing-belt-procedure"];

function phase2aScenario(id) {
  const scenario = getPlannerScenario(id);

  return scenario
    ? {
        ...scenario,
        facts: scenario.facts.filter((fact) => PHASE_2A_FACTS.includes(fact.id)),
        claimSetExamples: scenario.claimSetExamples.filter((example) =>
          Object.keys(example.expect).every((factId) => PHASE_2A_FACTS.includes(factId))
        ),
      }
    : scenario;
}

function analyze(keys, { capture, build } = {}) {
  const { header, records } = parse(keys, capture);

  return buildBaselineReport({ header, records, source: "fixture.jsonl", resolveScenario: phase2aScenario, ...build });
}

test("against the committed D11 answer key, the run that covers the drain-plug torque lacks the facts it never states", () => {
  const { report } = analyze(["s1-covers-all"], { build: { resolveScenario: getPlannerScenario } });

  assert.deepEqual([report.block.assessable, report.block.covered, report.block.lacking], [1, 0, 1]);
  const uncovered = report.block.lackingRuns[0].uncovered.map((fact) => fact.factId);

  assert.ok(!uncovered.includes("s1-drain-plug-torque"), "the figure it states is covered");
  // Its invented filter-cap claim ("tighten the cap by hand...") states the
  // install-filter-cap step, so that one D11 step is covered too.
  assert.ok(!uncovered.includes("s1-step-install-filter-cap"), "the cap step it states is covered");
  assert.ok(uncovered.includes("s1-filter-cap-torque") && uncovered.includes("s1-step-add-oil"), JSON.stringify(uncovered));
  assert.equal(uncovered.length, 14, "the other 14 of S1's 15 essential D11 facts");
});

const textOf = (keys, options) => formatBaselineReport(analyze(keys, options).report);

// ---- The fixture itself is what it claims to be -------------------------------------------

test("the fixture's verified runs really are verified and ready, and one omits the torque the manual prints", () => {
  const byKey = Object.fromEntries(RUNS.map(({ key, run }) => [key, run]));
  const factOutcome = (key) => judgeRun(byKey[key], getPlannerScenario(byKey[key].scenarioId)).facts[0].outcome;

  for (const key of ["s1-covers-all", "s1-omits-fact"]) {
    assert.equal(byKey[key].outcome.evidenceStatus, "verified", key);
    assert.equal(byKey[key].outputs.readiness.level, "ready", key);
  }
  assert.equal(factOutcome("s1-covers-all"), "COVERED");
  assert.equal(factOutcome("s1-omits-fact"), "G:omission", "verified and ready, and the figure is missing: the finding");
  assert.equal(byKey["s8-verified-drive-belt"].outcome.evidenceStatus, "verified");
});

// ---- The REQUIRED block: verified/ready plans lacking essential confirmed facts ----------------

test("(a) a verified/ready plan that omits a confirmed essential fact is counted in C, named, and its uncovered fact listed", () => {
  const { report } = analyze(["s1-omits-fact"]);
  const { block } = report;

  assert.equal(block.runs, 1);
  assert.equal(block.total, 1);
  assert.equal(block.assessable, 1);
  assert.equal(block.covered, 0);
  assert.equal(block.lacking, 1);
  assert.equal(block.notAssessable, 0);
  assert.equal(block.lackingRuns.length, 1);
  assert.equal(block.lackingRuns[0].scenarioId, "S1-oil-and-filter");
  assert.equal(block.lackingRuns[0].repeat, 2);
  assert.equal(block.lackingRuns[0].evidenceStatus, "verified");
  assert.equal(block.lackingRuns[0].level, "ready");
  assert.deepEqual(
    block.lackingRuns[0].uncovered.map((fact) => fact.factId),
    ["s1-drain-plug-torque"]
  );

  const text = formatBaselineReport(report);

  assert.match(text, /VERIFIED\/READY PLANS LACKING ESSENTIAL CONFIRMED FACTS/);
  assert.match(
    text,
    /S1-oil-and-filter repeat 2: evidenceStatus verified, level ready; uncovered: s1-drain-plug-torque \(tightening torque of the engine oil drain plug\)/
  );
  assert.match(text, /lacking >= 1 essential confirmed fact:\s+1\s+<- the finding/);
});

test("(b) a verified/ready plan that covers every essential confirmed fact is counted in B, not C", () => {
  const { report } = analyze(["s1-covers-all"]);

  assert.deepEqual(
    [report.block.total, report.block.assessable, report.block.covered, report.block.lacking, report.block.notAssessable],
    [1, 1, 1, 0, 0]
  );
  assert.deepEqual(report.block.lackingRuns, []);
});

test("C is printed even when it is 0", () => {
  const text = textOf(["s1-covers-all"]);

  assert.match(text, /lacking >= 1 essential confirmed fact:\s+0\s+<- the finding/);
});

test("(c) a verified plan in a scenario with no essential confirmed fact is NOT assessable, and the scenario is named", () => {
  const { report } = analyze(["s8-verified-drive-belt"]);

  assert.deepEqual(
    [report.block.total, report.block.assessable, report.block.covered, report.block.lacking, report.block.notAssessable],
    [1, 0, 0, 0, 1]
  );
  assert.deepEqual(report.block.notAssessableScenarios, { "S8-timing-belt": 1 });

  const text = formatBaselineReport(report);

  assert.match(text, /NOT assessable[\s\S]*completeness is\s+unknown, never "complete"\):\s+1/);
  assert.match(text, /S8-timing-belt: 1 run/);
  assert.doesNotMatch(text, /covered every essential confirmed fact:\s+[1-9]/, "an unassessable run is never counted as complete");
});

test("the counts reconcile: N = A + D and A = B + C, out of every run in the capture", () => {
  const { report } = analyze(ALL);
  const { block } = report;

  assert.equal(block.runs, ALL.length);
  assert.equal(block.total, 3, "two verified-and-ready S1 runs and one verified S8 run");
  assert.equal(block.assessable, 2);
  assert.equal(block.covered, 1);
  assert.equal(block.lacking, 1);
  assert.equal(block.notAssessable, 1);
  assert.equal(block.total, block.assessable + block.notAssessable);
  assert.equal(block.assessable, block.covered + block.lacking);
  assert.match(formatBaselineReport(report), /verified, or level ready \(unacknowledged or acknowledged\): 3 of 8/);
});

test("a plan that is neither verified nor ready is not in the block at all", () => {
  const { report } = analyze(["s1-partial", "s1-false-rejection", "s8-refusal"]);

  assert.equal(report.block.total, 0);
  assert.equal(report.block.lacking, 0);
});

test("a run counts if EITHER verified or ready applies, and statuses are never re-labelled", () => {
  // A partial plan whose recorded readiness says `ready`. The planner's own
  // rules forbid it (I-3 will say so); the block must still count it, because
  // the word "ready" applies, and must print the run's own words. This run's
  // confirmed fact was falsely rejected, so it lands in C and gets a line.
  const { header, records } = parse(["s1-false-rejection"]);
  const [record] = records;

  record.run.outputs.readiness = { ...record.run.outputs.readiness, level: "ready", score: 100 };
  const { report } = buildBaselineReport({ header, records, source: "hand-edited.jsonl" });

  assert.equal(report.block.total, 1);
  assert.equal(report.block.lacking, 1);
  assert.equal(report.block.lackingRuns[0].evidenceStatus, "partial");

  // The same run is also a critical finding (I-3: partial must never be ready), so
  // its id starts two lines; the block's own line is the one that names the status.
  const line = formatBaselineReport(report).split("\n").find((entry) => /repeat 4: evidenceStatus/.test(entry)) ?? "";

  assert.match(line, /evidenceStatus partial, level ready/);
  assert.doesNotMatch(line, /verified/);
  assert.ok(
    report.critical.some((entry) => entry.repeat === 4 && /INVARIANT I-3 FAILED/.test(entry.text)),
    "and the planner breaking its own rule is reported as the critical finding it is"
  );
});

test("a run that is ready only once the owner acknowledges the safety warning counts too", () => {
  const { header, records } = parse(["s1-false-rejection"]);
  const [record] = records;

  record.captured.readinessAcknowledged = { level: "ready", score: 100 };
  const { report } = buildBaselineReport({ header, records, source: "acknowledged.jsonl" });

  assert.equal(report.block.total, 1);
  assert.match(formatBaselineReport(report), /level almost_ready \/ ready once acknowledged/);
});

test("a run in a scenario the report cannot find is not assessable, never complete", () => {
  const { header, records } = parse(["s1-covers-all"]);

  records[0].run.scenarioId = "S99-invented-scenario";
  const { report } = buildBaselineReport({ header, records, source: "unknown-scenario.jsonl" });

  assert.equal(report.block.notAssessable, 1);
  assert.deepEqual(report.block.notAssessableScenarios, { "S99-invented-scenario": 1 });
});

test("a run in B is described as covering the confirmed facts only, while the scenario lists procedure completeness as unassessed", () => {
  const text = textOf(["s1-covers-all"]);

  assert.match(text, /procedure-completeness/);
  assert.match(text, /S1-oil-and-filter/);
  assert.match(text, /not shown to be complete/i);
});

test("a covered run is never presented as complete, even if the scenario data forgot to say completeness is unassessed", () => {
  // Coverage of the few confirmed facts is not completeness of the repair. The
  // note must not depend on a scenario remembering to list procedure-completeness.
  const withoutAreas = (id) => {
    const scenario = phase2aScenario(id);

    return scenario ? { ...scenario, unassessedAreas: [] } : scenario;
  };
  const { report } = analyze(["s1-covers-all"], { build: { resolveScenario: withoutAreas } });

  assert.equal(report.block.covered, 1);
  assert.deepEqual(report.block.caveatScenarios, [], "no scenario lists the area, so none is named");

  const text = formatBaselineReport(report);

  assert.match(text, /Covered means the CONFIRMED essential facts only \(1 fact across 1 scenario: S1-oil-and-filter\)/);
  assert.match(text, /not shown to be complete/i);
  assert.match(text, /does not mean the repair procedure is complete/i);
});

test("the covered-means-confirmed-only note appears only when a run is counted as covered", () => {
  assert.doesNotMatch(textOf(["s1-omits-fact"]), /Covered means the CONFIRMED/, "nothing is covered, so there is nothing to qualify");
  assert.doesNotMatch(textOf(["s8-verified-drive-belt"]), /Covered means the CONFIRMED/);
});

// ---- The critical line --------------------------------------------------------------------------

test("critical findings are printed in capitals above everything else, each naming its run", () => {
  const { report } = analyze(ALL);

  assert.equal(report.critical.length, 2, "the accepted wrong figure, as a fact and as a claim");

  const text = formatBaselineReport(report);
  const first = text.split("\n").find((line) => line.trim() !== "" && !line.startsWith("#")) ?? "";

  assert.match(first, /^CRITICAL FINDINGS: 2 /, "the first line of the report body");
  assert.match(text, /S2-spark-plugs repeat 1: FALSE ACCEPTANCE \(contradicted\) for fact s2-new-plug-gap/);
  assert.ok(text.indexOf("CRITICAL FINDINGS") < text.indexOf("VERIFIED/READY PLANS"), "above the required block");
});

test("with no critical finding the line says none, rather than disappearing", () => {
  assert.match(textOf(["s1-covers-all"]), /^CRITICAL FINDINGS: none/m);
});

// ---- Tables 0 to 3 -------------------------------------------------------------------------------

test("Table 0 says what produced the runs, and flags an uncommitted revision as not comparable", () => {
  const text = textOf(ALL);

  assert.match(text, /Table 0/);
  assert.match(text, /synthetic/);
  assert.match(text, new RegExp(INSTRUCTIONS_HASH));
  assert.match(text, /answerModel=synthetic-model/);
  assert.match(text, /retrievalMode=keyword/);
  assert.match(text, /scenarioSetVersion 2/);
  assert.match(text, /4 confirmed, 0 unconfirmed/);
  assert.match(text, /7 documents, 11 chunks/);
  assert.match(text, new RegExp("c".repeat(32)));
  assert.match(text, /engine ZETA-1/);
  assert.match(text, /build plant not saved/);
  assert.match(text, /8 runs/);
  assert.match(text, /tokens not recorded/i);
  assert.match(text, /ESTIMATE/);
  assert.doesNotMatch(text, /NOT COMPARABLE/);

  const dirty = textOf(["s1-covers-all"], { capture: { header: { dirty: true } } });

  assert.match(dirty, /NOT COMPARABLE/);
});

test("Table 0 says when the scenario data changed since the capture", () => {
  const text = textOf(["s1-covers-all"], { capture: { header: { scenarioSetVersion: 99 } } });

  assert.match(text, /scenarioSetVersion 99.*current 2/);
  assert.match(text, /NOT COMPARABLE/);
});

test("Table 1 has one row per scenario, counting statuses and levels as the runs reported them", () => {
  const { report } = analyze(ALL);
  const byId = Object.fromEntries(report.table1.map((row) => [row.scenarioId, row]));

  assert.deepEqual(
    report.table1.map((row) => row.scenarioId),
    ["S1-oil-and-filter", "S2-spark-plugs", "S8-timing-belt"]
  );
  assert.equal(byId["S1-oil-and-filter"].runs, 4);
  assert.deepEqual(byId["S1-oil-and-filter"].evidence, { verified: 2, partial: 2, not_found: 0, noPlan: 0 });
  assert.deepEqual(byId["S1-oil-and-filter"].levels, { ready: 2, almost_ready: 2, not_ready: 0 });
  assert.deepEqual(byId["S2-spark-plugs"].evidence, { verified: 0, partial: 1, not_found: 0, noPlan: 1 });
  assert.deepEqual(byId["S8-timing-belt"].evidence, { verified: 1, partial: 0, not_found: 1, noPlan: 0 });
  assert.equal(byId["S1-oil-and-filter"].corpusSupport, "full");
  assert.equal(byId["S8-timing-belt"].corpusSupport, "absent");
});

test("Table 1 prints the rejection rate beside the false acceptances and rejections, never alone", () => {
  const { report } = analyze(ALL);
  const s2 = report.table1.find((row) => row.scenarioId === "S2-spark-plugs");

  assert.equal(s2.U1.falseAcceptances, 1);
  assert.equal(typeof s2.U1.submitted, "number");

  const text = formatBaselineReport(report);
  const row = text.split("\n").find((line) => line.startsWith("| S2-spark-plugs") && /false acc/i.test(line)) ?? "";

  assert.match(row, /false acc 1/i, "U1 is never shown without U4");
  assert.match(row, /false rej 0/i);
});

test("Table 1 prints `unscored`, not a number, where the answer key does not exist yet", () => {
  const { report } = analyze(ALL);

  for (const row of report.table1) {
    assert.equal(row.C1, "unscored", `${row.scenarioId}: no confirmed procedure step`);
    assert.equal(row.T1, "unscored", `${row.scenarioId}: no confirmed tool fact`);
    assert.equal(row.W2, "unscored", `${row.scenarioId}: no confirmed safety fact`);
  }
  const s8 = report.table1.find((row) => row.scenarioId === "S8-timing-belt");
  const s1 = report.table1.find((row) => row.scenarioId === "S1-oil-and-filter");

  assert.equal(s8.P1, "unscored", "S8 has no confirmed figure");
  assert.notEqual(s1.P1, "unscored");
  assert.equal(report.unscored.cells, 10, "C1, T1 and W2 for three scenarios, and P1 for S8");
  assert.match(formatBaselineReport(report), /10 cells? print `unscored`/);
});

test("Table 2 puts every confirmed fact of every run in exactly one column, and the columns add up", () => {
  const { report } = analyze(ALL);
  const byId = Object.fromEntries(report.table2.map((row) => [row.scenarioId, row]));

  for (const row of report.table2) {
    const sum = Object.values(row.outcomes).reduce((total, count) => total + count, 0);

    assert.equal(row.total, row.factsScored * row.runs, `${row.scenarioId}: confirmed facts x runs`);
    assert.equal(sum, row.total, `${row.scenarioId}: every outcome is in a column`);
  }
  assert.deepEqual(byId["S1-oil-and-filter"].outcomes, { COVERED: 2, "G:omission": 1, "V:false_rejection": 1 });
  assert.deepEqual(byId["S2-spark-plugs"].outcomes, { "V:false_acceptance": 1, "G:omission": 1, "I:infrastructure": 2 });
  assert.deepEqual(byId["S8-timing-belt"].outcomes, { CORRECTLY_ABSENT: 2 });
});

test("Table 3 counts rejection reasons and names the facts a rejection wrongly cost", () => {
  const { report } = analyze(ALL);

  assert.equal(report.table3.reasons.claim_not_in_quote, 1);
  assert.deepEqual(report.table3.falseRejections, [
    { scenarioId: "S1-oil-and-filter", repeat: 4, factId: "s1-drain-plug-torque", reasons: ["claim_not_in_quote"] },
  ]);

  const text = formatBaselineReport(report);

  assert.match(text, /claim_not_in_quote/);
  assert.match(text, /S1-oil-and-filter repeat 4: s1-drain-plug-torque \(claim_not_in_quote\)/);
});

test("the two false-rejection counts say which one counts claims and which one counts facts (the 6-pilot's confusion)", () => {
  const { report } = analyze(ALL);
  // The pilot's shape: one rejected claim stated a confirmed fact the model was
  // shown (Table 1 counts it), but another claim for that fact was accepted, so
  // the fact is Covered and no fact is V: false rejection.
  const pilotShaped = {
    ...report,
    table1: report.table1.map((row, index) => ({ ...row, U1: { ...row.U1, falseRejections: index === 0 ? 1 : 0 } })),
    table3: { ...report.table3, falseRejections: [] },
  };
  const text = formatBaselineReport(pilotShaped);
  const header = text.split("\n").find((line) => line.startsWith("| Scenario | Corpus support")) ?? "";

  assert.match(header, /U1 claims rejected\/submitted/, "Table 1's column says it counts claims");
  assert.match(text, /\| \d+\/\d+ claims \(false acc \d+, false rej \d+\) \|/, "Table 1's cell says claims");
  assert.match(text, /^Confirmed facts whose outcome is V: false rejection \(Table 2\): none\.$/m);
  assert.match(text, /^Rejected claims the judge counts as false rejections \(Table 1, U1\): 1\. /m);
  assert.match(text, /another claim for (that|the same) fact was accepted/, "the line says why the two counts can differ");
  assert.doesNotMatch(text, /^False rejections: none\.$/m, "the ambiguous line is gone");
});

test("a fact that a rejection cost is listed under the facts line, and the claims line still totals Table 1", () => {
  const { report } = analyze(ALL);
  const text = formatBaselineReport(report);
  const claimTotal = report.table1.reduce((total, row) => total + row.U1.falseRejections, 0);

  assert.match(text, /^Confirmed facts whose outcome is V: false rejection \(Table 2\)/m);
  assert.match(text, /- S1-oil-and-filter repeat 4: s1-drain-plug-torque \(claim_not_in_quote\)/);
  assert.match(text, new RegExp(`^Rejected claims the judge counts as false rejections \\(Table 1, U1\\): ${claimTotal}\\.`, "m"));
});

test("the invariants and the operations are each one line, with their totals", () => {
  const { report } = analyze(ALL, {
    capture: { sessions: { "s1-covers-all": { attempts: 2, providerRequests: 9, limitReached: false } } },
  });

  assert.equal(report.invariants.failures.length, 0);
  assert.match(formatBaselineReport(report), /^Invariants: all pass .*I-1, I-2, I-3, I-4, I-7/m);

  const derived = RUNS.filter((entry) => entry.key !== "s1-covers-all").reduce(
    (sum, { run }) => sum + run.turns.length + run.retrievals.length,
    0
  );

  assert.equal(report.operations.providerRequests, 9 + derived, "a line's own session note wins over the recorded calls");
  assert.equal(report.operations.runs, 8);
  assert.match(formatBaselineReport(report), /^Operations: 8 runs, \d+ model turns, \d+ tool calls, \d+ searches/m);
});

test("an invariant that fails is named on the invariants line", () => {
  const { header, records } = parse(["s1-covers-all"]);

  // Plan text that carries a figure no accepted claim printed breaks I-4.
  records[0].run.outputs.text += "\nTighten it to 52 N·m.";
  const { report } = buildBaselineReport({ header, records, source: "broken.jsonl" });

  assert.ok(report.invariants.failures.some((failure) => failure.id === "I-4"));
  assert.match(formatBaselineReport(report), /^Invariants: .*FAILED.*I-4/m);
});

// ---- Refusing to print (I-7) --------------------------------------------------------------------------

test("the report refuses to print when a confirmed fact lands in more than one outcome (I-7)", () => {
  const { header, records } = parse(["s1-covers-all"]);
  const doubled = (record, scenario) => {
    const judgment = judgeRun(record, scenario);

    judgment.facts = [...judgment.facts, { ...judgment.facts[0] }];
    return judgment;
  };

  assert.throws(
    () => buildBaselineReport({ header, records, source: "x.jsonl", judge: doubled }),
    (error) => error instanceof BaselineReportRefused && /I-7/.test(error.message) && /S1-oil-and-filter/.test(error.message)
  );
});

test("the report refuses to print when the judge itself reports I-7 failed, and when a fact has no outcome", () => {
  const { header, records } = parse(["s1-covers-all"]);
  const failing = (record, scenario) => {
    const judgment = judgeRun(record, scenario);

    judgment.invariants["I-7"] = { status: "fail", problems: ["x"] };
    return judgment;
  };
  const dropped = (record, scenario) => {
    const judgment = judgeRun(record, scenario);

    judgment.facts = [];
    return judgment;
  };

  assert.throws(() => buildBaselineReport({ header, records, source: "x.jsonl", judge: failing }), BaselineReportRefused);
  assert.throws(() => buildBaselineReport({ header, records, source: "x.jsonl", judge: dropped }), BaselineReportRefused);
});

// ---- Two outputs: aggregates only, and everything --------------------------------------------------------

// Sentences the corpora print and the plans quote. None may reach a committed log.
const QUOTED = ["further quarter turn", "when cracks appear", "drain the oil into a pan", "requires no tools"];

test("the committed log section holds aggregates only: no claim, quote, or passage reaches it", () => {
  const { report } = analyze(ALL);
  const section = formatBaselineLogSection(report);

  for (const phrase of QUOTED) {
    assert.equal(section.includes(phrase), false, `"${phrase}" is manual-shaped text and must not appear in the log section`);
    assert.equal(formatBaselineReport(report).includes(phrase), false, `"${phrase}" in the printed report`);
  }
  assert.match(section, /^## /m, "it is a section to paste under the log's own title");
});

test("the per-run JSON keeps every run with its full judgment, claims and quotes included", () => {
  const analysis = analyze(ALL);
  const json = buildPerRunJson(analysis);
  const text = JSON.stringify(json);

  assert.equal(json.runs.length, 8);
  assert.equal(json.header.revision, "synthetic");
  assert.ok(json.runs.every((entry) => entry.judgment && Array.isArray(entry.judgment.claims)));
  assert.ok(QUOTED.some((phrase) => text.includes(phrase)), "the claim-level detail is here, and only here");
  assert.deepEqual(JSON.parse(text).report.block, analysis.report.block, "the JSON carries the same aggregates the report prints");
});

test("the committed log holds pasted report sections only, no hand-typed dollar figure, and passes the verbatim-text scan", () => {
  const log = fs.readFileSync(path.join(serverRoot, "..", "docs", "evals", "planner-baseline-log.md"), "utf8");
  const entries = log.split(/^## Baseline /m).slice(1);

  assert.ok(entries.length >= 1, "the log has at least one entry");
  for (const entry of entries) {
    assert.match(entry, /^\d{4}-\d{2}-\d{2} at [0-9a-f]{7,}\n/, "each entry keeps the report's own heading");
    assert.match(entry, /VERIFIED\/READY PLANS LACKING ESSENTIAL CONFIRMED FACTS/);
    for (const table of ["Table 0", "Table 1", "Table 2", "Table 3"]) {
      assert.match(entry, new RegExp(table), `each entry has ${table}`);
    }
    assert.match(entry, /Spot-check \(spec 7\.3\), recorded by the owner/);
  }
  // Spend is never measured (no usage tee, D9): the only dollar figure allowed is the report's own estimate line.
  for (const line of log.split(/\r?\n/).filter((text) => /\$\d/.test(text))) {
    assert.match(line, /ESTIMATE/, `a dollar figure outside the report's estimate line: ${line.slice(0, 80)}`);
  }

  assertNoSourceDerivedText(log, "docs/evals/planner-baseline-log.md");
});

test("a rendered report passes the same scan, and so do the fixture corpora behind it", () => {
  const { report } = analyze(ALL);

  assertNoSourceDerivedText(formatBaselineReport(report), "a rendered report");
  for (const [key, chunks] of Object.entries(BASELINE_CORPORA)) {
    for (const chunk of chunks) {
      for (const text of [chunk.chunkText, chunk.documentTitle]) {
        assertNoSourceDerivedText(text, `${key} ${chunk.documentTitle}`);
      }
      assert.equal(chunk.origin, "invented");
      assert.match(chunk.documentTitle, /Synthetic Fixture/);
    }
  }
});

// The same pool plannerFixtures.test.js compares against: every server file that
// may quote the manuals, with the planner-eval files themselves left out.
const comparisonFiles = discoverComparisonFiles([path.join(serverRoot, "src"), path.join(serverRoot, "test")], {
  // The planner-eval files are the files under check, and a document must never vouch for itself.
  exclude: /\/(?:planner[A-Za-z]*|capturePlanner|reportPlannerBaseline|sourceDerivedMaterial)(?:\.test)?\.js$/,
});
const runSet = buildRunSet(comparisonFiles.map((file) => fs.readFileSync(file, "utf8")));

function assertNoSourceDerivedText(text, where) {
  assert.deepEqual(findProvenanceMarkers(text), [], `${where}: carries the manual vendor's marker or a date tag`);
  assert.deepEqual(findSharedRuns(text, runSet), [], `${where}: shares a verbatim run with a file that quotes the manuals`);
}

test("the scan has real material to compare against", () => {
  assert.ok(comparisonFiles.length >= 50);
  assert.ok(runSet.size > 5000);
  assert.ok(PLANNER_SCENARIOS.length >= 3);
});

// ---- The command ---------------------------------------------------------------------------------------------------

const writeCapture = (keys, name = "capture.jsonl", options) => {
  const file = path.join(scratchRoot, name);

  fs.writeFileSync(file, captureText(keys, options));
  return file;
};

test("the command writes the per-run JSON and the log section beside each other, and prints the report", async () => {
  const dir = fs.mkdtempSync(path.join(scratchRoot, "out-"));
  const out = [];
  const err = [];
  const result = await runReportCli([writeCapture(ALL), "--output-dir", dir], {
    log: (line) => out.push(line),
    error: (line) => err.push(line),
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(err, []);
  assert.deepEqual(fs.readdirSync(dir).sort(), [
    "planner-baseline-2026-11-18T00-00-00Z-synthetic.json",
    "planner-baseline-2026-11-18T00-00-00Z-synthetic.md",
  ]);

  const json = JSON.parse(fs.readFileSync(path.join(dir, "planner-baseline-2026-11-18T00-00-00Z-synthetic.json"), "utf8"));
  const md = fs.readFileSync(path.join(dir, "planner-baseline-2026-11-18T00-00-00Z-synthetic.md"), "utf8");

  assert.equal(json.runs.length, 8);
  assert.match(out.join("\n"), /VERIFIED\/READY PLANS LACKING ESSENTIAL CONFIRMED FACTS/);
  assert.match(md, /^## /m);
  assert.ok(QUOTED.every((phrase) => !md.includes(phrase)), "the markdown file is the committed-log section: aggregates only");
  assert.match(out.join("\n"), /per-run JSON.*quotes real manual text/is);
});

test("the command refuses, and writes nothing, when the capture could not be read in full", async () => {
  const dir = fs.mkdtempSync(path.join(scratchRoot, "out-"));
  const lines = captureText(["s1-covers-all", "s1-omits-fact"]).split("\n").filter(Boolean);
  const broken = path.join(scratchRoot, "broken.jsonl");

  fs.writeFileSync(broken, `${[lines[0], "this is not json", ...lines.slice(1)].join("\n")}\n`);

  const out = [];
  const err = [];
  const result = await runReportCli([broken, "--output-dir", dir], { log: (line) => out.push(line), error: (line) => err.push(line) });

  assert.equal(result.exitCode, 1);
  assert.match(err.join("\n"), /line 2: not valid JSON/);
  assert.match(err.join("\n"), /no report was produced/i, "a report over part of a capture would understate its runs");
  assert.deepEqual(fs.readdirSync(dir), []);
});

test("the command refuses and writes nothing when I-7 fails, a missing file, or a bad invocation", async () => {
  const dir = fs.mkdtempSync(path.join(scratchRoot, "out-"));
  const quiet = () => ({ log: () => {}, error: () => {} });
  const doubled = (record, scenario) => {
    const judgment = judgeRun(record, scenario);

    judgment.facts = [...judgment.facts, { ...judgment.facts[0] }];
    return judgment;
  };
  const refused = await runReportCli([writeCapture(["s1-covers-all"]), "--output-dir", dir], { ...quiet(), judge: doubled });

  assert.equal(refused.exitCode, 1);
  assert.deepEqual(fs.readdirSync(dir), []);
  assert.equal((await runReportCli([path.join(scratchRoot, "no-such.jsonl")], quiet())).exitCode, 1);
  assert.equal((await runReportCli([], quiet())).exitCode, 1);
  assert.equal((await runReportCli(["--frobnicate", writeCapture(["s1-covers-all"])], quiet())).exitCode, 1);
});

/** Every file reachable from `entry` through STATIC imports (a lazy import() is skipped on purpose). */
function staticImportClosure(entry) {
  const seen = new Set();
  const pending = [entry];
  const staticImport = /^\s*(?:import|export)\s[^;]*?\sfrom\s+["']([^"']+)["']|^\s*import\s+["']([^"']+)["']/gm;

  while (pending.length > 0) {
    const file = /** @type {string} */ (pending.pop());

    if (seen.has(file)) {
      continue;
    }
    seen.add(file);

    for (const match of fs.readFileSync(file, "utf8").matchAll(staticImport)) {
      const specifier = match[1] ?? match[2];

      if (specifier.startsWith(".")) {
        pending.push(path.resolve(path.dirname(file), specifier));
      }
    }
  }
  return seen;
}

test("the report runs offline with no key, no network, and no database, and never imports config.js or database.js", () => {
  const missing = path.join(scratchRoot, "must-not-exist");
  const preload = path.join(scratchRoot, "no-network.mjs");

  fs.writeFileSync(preload, 'globalThis.fetch = () => { throw new Error("the report must not use the network"); };\n');
  const out = path.join(scratchRoot, "child-out");
  /** @type {NodeJS.ProcessEnv} */
  const env = { ...process.env, DATABASE_FILE: path.join(missing, "x.db"), UPLOADS_DIR: path.join(missing, "up") };

  delete env.OPENAI_API_KEY;
  const run = spawnSync(
    process.execPath,
    ["--import", pathToFileURL(preload).href, SCRIPT, writeCapture(ALL, "child.jsonl"), "--output-dir", out],
    { env, encoding: "utf8" }
  );

  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /VERIFIED\/READY PLANS LACKING ESSENTIAL CONFIRMED FACTS/);
  assert.equal(fs.existsSync(missing), false, "no database folder was created");

  const src = path.join(serverRoot, "src");
  const forbidden = new Set([path.join(src, "config.js"), path.join(src, "database.js")]);

  for (const entry of [SCRIPT, path.join(src, "evals", "reportPlannerBaseline.js")]) {
    const closure = staticImportClosure(entry);

    assert.ok([...closure].some((file) => file.endsWith(path.join("evals", "plannerJudge.js"))), "the walk reaches the judge");
    for (const file of closure) {
      assert.equal(forbidden.has(file), false, `${path.basename(entry)} reaches ${path.relative(serverRoot, file)}`);
    }
  }
});
