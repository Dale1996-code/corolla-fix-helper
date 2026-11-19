// Runs for the baseline report's tests (docs/planner-eval-spec.md, section 11 and
// Phase 5): the three situations the REQUIRED block ("verified/ready plans that
// lack essential confirmed facts") has to tell apart, plus the other outcomes a
// report has to tabulate.
//
// Like plannerSyntheticCapture.js, every run here is a REAL planner run -- the real
// agent and the real verifier -- driven by a scripted model over INVENTED text,
// recorded by the one recorder (plannerCaseRunner.js). Nothing is hand-typed JSON, so
// a fixture cannot drift into a shape the recorder would never produce.
//
// The agent is injected, never imported: loading it opens the database. The file
// name starts with "planner" so plannerFixtures.test.js's comparison pool leaves it
// out: it quotes its own corpora's sentences, and a corpus must not be flagged for
// sharing a run with the file that replays it.
//
// Reaching `verified` takes what spec Appendix A probe A1 describes: one accepted
// technical claim per task, and a grounded "no tools" and "no parts" statement.
// That is the finding the whole evaluation exists to make visible -- a plan can
// carry every one of those and still omit a figure the manual prints.

import { buildPlannerCaptureHeader, buildPlannerCaptureRecord, serializePlannerCapture } from "../plannerCapture.js";
import { runPlannerCase } from "../plannerCaseRunner.js";
import { SCENARIO_SET_VERSION, getPlannerScenario } from "../plannerScenarios.js";
import { createScriptedModel, finalizeCall, providerHttpError, searchCall, sourceIdFor } from "../plannerScriptedModel.js";
import { MINI_CORPORA, createKeywordRetriever } from "./plannerMiniCorpora.js";
import { SYNTHETIC_CONFIG } from "./plannerSyntheticCapture.js";
import { scriptedRun } from "./plannerScriptedRuns.js";

export const BASELINE_FIXTURE_CAPTURED_AT = "2026-11-18T00:00:00.000Z";

const chunk = (documentId, documentTitle, pageNumber, chunkText) => ({
  documentId,
  documentTitle,
  originalFilename: `${documentTitle.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}.pdf`,
  pageNumber,
  chunkIndex: 0,
  chunkText,
  origin: "invented",
});

/** The invented corpora, each with the one extra chunk that lets a plan state "no tools, no parts". */
export const BASELINE_CORPORA = {
  S1: [
    ...MINI_CORPORA.S1,
    chunk(
      104,
      "Oil Change Overview - Synthetic Fixture",
      1,
      "Oil change overview, fixture text. This job requires no tools. This job requires no parts other than the oil and the filter."
    ),
  ],
  S8: [
    ...MINI_CORPORA["S8-premise-holds"],
    chunk(
      304,
      "Belt Service Overview - Synthetic Fixture",
      1,
      "Belt service overview, fixture text. This job requires no tools. This job requires no parts other than the belt."
    ),
  ],
};

// The sentences, exactly as the corpora print them.
const S1_TORQUE = "Tighten the oil drain plug to 37 N·m (27 ft-lbf).";
const S1_TORQUE_RESTATED = "The oil drain plug torque is 37 N·m.";
const S1_DRAIN = "Warm the engine, then drain the oil into a pan.";
const S1_CAP = "Oil filter cap: tighten the cap by hand, then a further quarter turn.";
const S1_NO_TOOLS = "This job requires no tools.";
const S1_NO_PARTS = "This job requires no parts other than the oil and the filter.";
const S8_DRIVE = "Replace the drive belt when cracks appear.";
const S8_NO_PARTS = "This job requires no parts other than the belt.";

const claim = (taskId, kind, text, input, source) => ({
  taskId,
  kind,
  claim: text,
  sourceId: sourceIdFor(input, source),
  evidenceQuote: text,
});

const S1_MAIN = /Oil and Oil Filter Replacement/;
const S1_HOUSING = /Oil Filter Housing Notes/;
const S1_OVERVIEW = /Oil Change Overview/;

/** Search both tasks, then finalize whatever `claims(input)` builds. */
const searchBoth = (claims) => [
  [searchCall(1, "oil drain plug torque"), searchCall(2, "oil filter cap")],
  ({ input }) => [finalizeCall(claims(input))],
];

const SITUATIONS = {
  // B: every task covered, no figure missing: the drain-plug torque is stated.
  "s1-covers-all": {
    scenario: "S1-oil-and-filter",
    corpus: "S1",
    steps: () =>
      searchBoth((input) => [
        claim(1, "numeric_spec", S1_TORQUE, input, S1_MAIN),
        claim(2, "procedure", S1_CAP, input, S1_HOUSING),
        claim(1, "no_required_tools", S1_NO_TOOLS, input, S1_OVERVIEW),
        claim(1, "no_required_parts", S1_NO_PARTS, input, S1_OVERVIEW),
      ]),
  },
  // C: the SAME status and readiness, but the torque the manual prints is not in the plan.
  "s1-omits-fact": {
    scenario: "S1-oil-and-filter",
    corpus: "S1",
    steps: () =>
      searchBoth((input) => [
        claim(1, "procedure", S1_DRAIN, input, S1_MAIN),
        claim(2, "procedure", S1_CAP, input, S1_HOUSING),
        claim(1, "no_required_tools", S1_NO_TOOLS, input, S1_OVERVIEW),
        claim(1, "no_required_parts", S1_NO_PARTS, input, S1_OVERVIEW),
      ]),
  },
  // A correct figure the verifier turns down: the claim restates the sentence
  // instead of quoting it, so it is not a fragment of its quote (a false rejection).
  "s1-false-rejection": {
    scenario: "S1-oil-and-filter",
    corpus: "S1",
    steps: () =>
      searchBoth((input) => [
        claim(1, "procedure", S1_DRAIN, input, S1_MAIN),
        { ...claim(1, "numeric_spec", S1_TORQUE_RESTATED, input, S1_MAIN), evidenceQuote: S1_TORQUE },
        claim(2, "procedure", S1_CAP, input, S1_HOUSING),
      ]),
  },
  // Neither verified nor ready: one task has nothing, and tools/parts are unresolved.
  "s1-partial": {
    scenario: "S1-oil-and-filter",
    corpus: "S1",
    steps: () => searchBoth((input) => [claim(1, "numeric_spec", S1_TORQUE, input, S1_MAIN)]),
  },
  // D: a verified plan in a scenario with no essential confirmed fact. The planner
  // accepts a drive-belt claim for the timing-belt task (spec 16.1), which is
  // exactly why "verified" cannot be read as "complete" there.
  "s8-verified-drive-belt": {
    scenario: "S8-timing-belt",
    corpus: "S8",
    steps: () => [
      [searchCall(1, "replace timing belt")],
      ({ input }) => [
        finalizeCall([
          claim(1, "procedure", S8_DRIVE, input, /Drive Belt Replacement/),
          claim(1, "no_required_tools", S1_NO_TOOLS, input, /Belt Service Overview/),
          claim(1, "no_required_parts", S8_NO_PARTS, input, /Belt Service Overview/),
        ]),
      ],
    ],
  },
};

/**
 * The runs, in file order. Each is one real agent run, keyed by what it shows.
 *
 * @param {{ runAgent: any, extractTasks: any, createPlanRuns: () => any }} agent
 * @returns {Promise<Array<{ key: string, run: any }>>}
 */
export async function recordBaselineFixtureRuns({ runAgent, extractTasks, createPlanRuns }) {
  const deps = (model, corpus) => ({
    runAgent,
    extractTasks,
    createPlanRuns,
    streamTurn: model.streamTurn,
    retrieve: createKeywordRetriever(corpus),
  });

  /** @param {string} key @param {number} repeat */
  const fromSituation = async (key, repeat) => {
    const situation = SITUATIONS[key];

    return {
      key,
      run: await runPlannerCase(
        getPlannerScenario(situation.scenario),
        deps(createScriptedModel(situation.steps()), BASELINE_CORPORA[situation.corpus]),
        { repeat }
      ),
    };
  };
  /** @param {string} key @param {string} runId @param {number} repeat */
  const fromScript = async (key, runId, repeat) => {
    const script = scriptedRun(runId);

    return {
      key,
      run: await runPlannerCase(getPlannerScenario(script.scenarioId), deps(script.model, MINI_CORPORA[script.corpus]), {
        repeat,
      }),
    };
  };

  return [
    await fromSituation("s1-covers-all", 1),
    await fromSituation("s1-omits-fact", 2),
    await fromSituation("s1-partial", 3),
    await fromSituation("s1-false-rejection", 4),
    await fromScript("s2-trap", "S2-trap", 1),
    {
      key: "s2-provider-failure",
      run: await runPlannerCase(
        getPlannerScenario("S2-spark-plugs"),
        deps(createScriptedModel([{ fail: providerHttpError(500) }]), MINI_CORPORA.S2),
        { repeat: 2 }
      ),
    },
    await fromSituation("s8-verified-drive-belt", 1),
    await fromScript("s8-refusal", "S8-refusal", 2),
  ];
}

/**
 * A whole capture's text from recorded runs, optionally only some of them.
 *
 * @param {{
 *   runs: Array<{ key: string, run: any }>, keys?: string[], instructionsHash: string,
 *   header?: Record<string, any>, sessions?: Record<string, any>,
 * }} options
 */
export function buildBaselineCaptureText({ runs, keys, instructionsHash, header = {}, sessions = {} }) {
  const chosen = keys ? keys.map((key) => /** @type {any} */ (runs.find((entry) => entry.key === key))) : runs;
  const lines = chosen.map(({ key, run }) => ({ ...buildPlannerCaptureRecord(run), ...(sessions[key] ? { session: sessions[key] } : {}) }));

  return serializePlannerCapture({
    header: buildPlannerCaptureHeader({
      capturedAt: BASELINE_FIXTURE_CAPTURED_AT,
      revision: "synthetic",
      dirty: false,
      config: SYNTHETIC_CONFIG,
      instructionsHash,
      scenarioSetVersion: SCENARIO_SET_VERSION,
      repeats: 3,
      vehicleProfile: { engineCode: "ZETA-1", buildPlant: null },
      corpus: { documents: 7, chunks: 11, dbSnapshotMd5: "c".repeat(32) },
      limits: { maxRuns: 7, maxProviderRequests: 100, maxInputTokensPerRun: null, maxInputTokensTotal: null },
      ...header,
    }),
    records: lines,
  });
}
