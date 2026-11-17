// Builds the committed synthetic planner capture
// (server/test/fixtures/synthetic-planner-capture.jsonl).
//
// Every run here is a REAL planner run -- the real agent, the real verifier --
// driven by a scripted model over INVENTED text, then recorded by the one
// recorder (plannerCaseRunner.js) and wrapped by plannerCapture.js. Nothing in
// the fixture is hand-typed JSON, so it cannot drift into a shape the recorder
// would never produce.
//
// The agent is injected, never imported: loading it opens the database, and this
// module must be loadable by anything. plannerCaptureFixture.test.js passes the
// real one in, regenerates the file, and fails if it no longer matches the
// committed copy -- which is how a change to the recorder's record shape is
// forced into a deliberate version bump.
//
// It lives beside plannerScriptedRuns.js, not under test/: databaseIsolation.test.js
// treats every .js file under test/ as a suite, and this module (through
// plannerCapture.js) can reach the database module. The file name starts with
// "planner" so plannerFixtures.test.js's comparison pool leaves it out: it quotes
// the corpora's sentences, and a corpus must not be flagged for sharing a run
// with the file that replays it.

import {
  buildPlannerCaptureHeader,
  buildPlannerCaptureRecord,
  serializePlannerCapture,
} from "../plannerCapture.js";
import { recordPlannerRun, runPlannerCase } from "../plannerCaseRunner.js";
import { SCENARIO_SET_VERSION, getPlannerScenario } from "../plannerScenarios.js";
import {
  createScriptedModel,
  finalizeCall,
  providerHttpError,
  searchCall,
  sourceIdFor,
  toolCall,
} from "../plannerScriptedModel.js";
import { MINI_CORPORA, createKeywordRetriever } from "./plannerMiniCorpora.js";
import { scriptedRun } from "./plannerScriptedRuns.js";

export const SYNTHETIC_CAPTURED_AT = "2026-11-17T00:00:00.000Z";

/** Settings of a pretend run. Invented: a real capture reads them from config.js. */
export const SYNTHETIC_CONFIG = {
  answerModel: "synthetic-model",
  reasoningEffort: "low",
  maxOutputTokens: 4000,
  maxTurns: 8,
  maxToolCallsPerTurn: 8,
  maxSearchResults: 8,
  evidenceContextCharLimit: 1500,
  retrievalMode: "keyword",
  retrievalMaxChunksPerSource: 3,
  rerankEnabled: false,
  relevanceFloorEnabled: false,
  embeddingVersion: null,
};

// The sentences, exactly as the invented S1 corpus prints them.
const S1_RIGHT = "Tighten the oil drain plug to 37 N·m (27 ft-lbf).";
const S1_NOT_THE_QUOTE = "Tighten the oil drain plug to 41 N·m (30 ft-lbf).";
const S1_NOT_IN_SOURCE = "Always fit a new crush washer on the drain plug.";
const S1_CUT_BEFORE_UNIT = "Tighten the oil drain plug to 37";

// The one safety-critical run. None of S1, S2, S8 is, so without it the
// acknowledged and unacknowledged readiness would be identical in every line and
// the acknowledged half of the capture would never be exercised.
const BRAKE_SENTENCE = "Tighten the brake caliper bracket bolts to 32 N·m (24 ft-lbf).";
const BRAKE_CORPUS = [
  {
    documentId: 901,
    documentTitle: "Brake Service Notes - Synthetic Fixture",
    originalFilename: "brake-service-notes-synthetic-fixture.pdf",
    pageNumber: 2,
    chunkIndex: 0,
    chunkText: `Front brake pad replacement, fixture procedure. Clean the bracket. ${BRAKE_SENTENCE} Then refit the wheel.`,
    origin: "invented",
  },
];

const numericClaim = (text, source, input, quote = text) => ({
  taskId: 1,
  kind: "numeric_spec",
  claim: text,
  sourceId: sourceIdFor(input, source),
  evidenceQuote: quote,
});

const S1_SOURCE = /Oil and Oil Filter Replacement/;

/**
 * The runs of the fixture, in file order. Each is one real agent run.
 *
 * `repeat` is the run's number within its scenario, so (scenarioId, repeat)
 * names a run in a replay report.
 *
 * @param {{ runAgent: any, extractTasks: any, createPlanRuns: () => any }} agent
 */
export async function recordSyntheticRuns({ runAgent, extractTasks, createPlanRuns }) {
  const deps = (model, corpus) => ({
    runAgent,
    extractTasks,
    createPlanRuns,
    streamTurn: model.streamTurn,
    retrieve: createKeywordRetriever(corpus),
  });

  /** One of the scripted runs from plannerScriptedRuns.js, as that file defines it. */
  const fromScript = (runId, repeat) => {
    const run = scriptedRun(runId);
    return runPlannerCase(getPlannerScenario(run.scenarioId), deps(run.model, MINI_CORPORA[run.corpus]), { repeat });
  };

  const s1 = getPlannerScenario("S1-oil-and-filter");
  const s2 = getPlannerScenario("S2-spark-plugs");

  const runs = [];

  // 1 and 2: the control, and the owner's example of a correct and an incorrect
  // figure for one fact, both accepted.
  runs.push(await fromScript("S1-correct-only", 1));
  runs.push(await fromScript("S1-contradiction", 2));

  // 3: one claim kept and three rejected, for three different reasons.
  const rejections = createScriptedModel([
    [searchCall(1, "oil drain plug torque")],
    ({ input }) => [
      finalizeCall([
        numericClaim(S1_RIGHT, S1_SOURCE, input),
        numericClaim(S1_NOT_THE_QUOTE, S1_SOURCE, input, S1_RIGHT),
        { ...numericClaim(S1_NOT_IN_SOURCE, S1_SOURCE, input), kind: "procedure" },
        { ...numericClaim(S1_CUT_BEFORE_UNIT, S1_SOURCE, input), kind: "procedure" },
      ]),
    ],
  ]);
  runs.push(await runPlannerCase(s1, deps(rejections, MINI_CORPORA.S1), { repeat: 3 }));

  // 4: a finalizer the validator refuses (an unknown field), then a valid one.
  const corrected = createScriptedModel([
    [searchCall(1, "oil drain plug torque")],
    ({ input }) => [toolCall("finalize_repair_plan", { claims: [numericClaim(S1_RIGHT, S1_SOURCE, input)], extra: true })],
    ({ input }) => [finalizeCall([numericClaim(S1_RIGHT, S1_SOURCE, input)])],
  ]);
  runs.push(await runPlannerCase(s1, deps(corrected, MINI_CORPORA.S1), { repeat: 4 }));

  // 5 and 6: S2's orphaned-value trap, and a provider failure before any plan.
  runs.push(await fromScript("S2-trap", 1));
  runs.push(
    await runPlannerCase(s2, deps(createScriptedModel([{ fail: providerHttpError(500) }]), MINI_CORPORA.S2), { repeat: 2 })
  );

  // 7: a correct refusal. No claims, so the evidence is not_found.
  runs.push(await fromScript("S8-refusal", 1));

  // 8: safety-critical work, so readiness differs once the owner acknowledges it.
  const brake = createScriptedModel([
    [searchCall(1, "brake caliper bracket bolt torque")],
    ({ input }) => [finalizeCall([numericClaim(BRAKE_SENTENCE, /Brake Service Notes/, input)])],
  ]);
  runs.push(
    await recordPlannerRun(
      {
        scenarioId: "synthetic-brake-pads",
        repeat: 1,
        request: {
          brief: "Replace the front brake pads.",
          skillLevel: "beginner",
          availableTools: "",
          availableParts: "",
          constraints: "",
        },
      },
      deps(brake, BRAKE_CORPUS)
    )
  );

  return runs;
}

/**
 * The whole capture file's text.
 *
 * @param {{ runAgent: any, extractTasks: any, createPlanRuns: () => any, instructionsHash: string }} options
 */
export async function buildSyntheticPlannerCaptureText({ instructionsHash, ...agent }) {
  const runs = await recordSyntheticRuns(agent);

  return serializePlannerCapture({
    header: buildPlannerCaptureHeader({
      capturedAt: SYNTHETIC_CAPTURED_AT,
      revision: "synthetic",
      dirty: false,
      config: SYNTHETIC_CONFIG,
      instructionsHash,
      scenarioSetVersion: SCENARIO_SET_VERSION,
    }),
    records: runs.map((run) => buildPlannerCaptureRecord(run)),
  });
}
