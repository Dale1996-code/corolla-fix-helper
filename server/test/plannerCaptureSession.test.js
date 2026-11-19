import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import { createPlanRunStore } from "../src/services/agent/planRunStore.js";
import { MINI_CORPORA, createKeywordRetriever } from "../src/evals/fixtures/plannerMiniCorpora.js";
import {
  createScriptedModel,
  finalizeCall,
  providerHttpError,
  searchCall,
  sourceIdFor,
} from "../src/evals/plannerScriptedModel.js";

// Planner eval Phase 5: the pure half of the paid capture tool -- the request
// limiter, the dry-run plan and its dollar estimate, and the session loop that
// records runs one at a time. NO paid call is made here: every model is a
// scripted stand-in, every retriever reads invented text, and the real agent
// runs inside a scratch database (databaseIsolation.test.js enforces the order).
const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-planner-capture-session-"));
process.env.DATABASE_FILE = path.join(scratchRoot, "session.db");
process.env.UPLOADS_DIR = path.join(scratchRoot, "uploads");
process.env.OPENAI_API_KEY = "";
process.env.NETWORK_MODE = "0";
fs.mkdirSync(process.env.UPLOADS_DIR, { recursive: true });

const { db } = await import("../src/database.js");
const { MAX_TOOL_CALLS_PER_TURN, runRepairPlannerAgent } = await import("../src/services/agent/repairPlannerAgent.js");
const { MAX_SEARCH_RESULTS, EVIDENCE_CONTEXT_CHAR_LIMIT, extractRepairTasks } = await import(
  "../src/services/agent/repairTools.js"
);
const { PlannerCaptureMismatch, buildPlannerCaptureHeader, parsePlannerCaptureText } = await import(
  "../src/evals/plannerCapture.js"
);
const { judgeRun } = await import("../src/evals/plannerJudge.js");
const { getPlannerScenario } = await import("../src/evals/plannerScenarios.js");
const {
  PLANNER_RUN_BOUNDS,
  PRICE_TABLE,
  REQUEST_LIMIT_REASON,
  RequestLimitReached,
  buildCapturePlan,
  createRequestLimiter,
  estimateSpend,
  formatCapturePlan,
  runCaptureSession,
} = await import("../src/evals/plannerCaptureSession.js");

after(() => {
  if (typeof db.close === "function") {
    db.close();
  }
  fs.rmSync(scratchRoot, { recursive: true, force: true });
});

const S1 = getPlannerScenario("S1-oil-and-filter");
const S2 = getPlannerScenario("S2-spark-plugs");
const S1_RIGHT = "Tighten the oil drain plug to 37 N·m (27 ft-lbf).";

const HEADER_CONFIG = {
  answerModel: "scripted",
  reasoningEffort: null,
  maxOutputTokens: 2048,
  maxTurns: 8,
  maxToolCallsPerTurn: 8,
  maxSearchResults: 8,
  evidenceContextCharLimit: 1500,
  retrievalMode: "hybrid",
  retrievalMaxChunksPerSource: 3,
  rerankEnabled: false,
  relevanceFloorEnabled: false,
  embeddingVersion: null,
};

const header = () =>
  buildPlannerCaptureHeader({
    revision: "test",
    dirty: false,
    config: HEADER_CONFIG,
    instructionsHash: "a".repeat(64),
  });

/** Search once for task 1, then finalize the right drain-plug torque. */
const oilChangeSteps = () => [
  [searchCall(1, "oil drain plug torque")],
  ({ input }) => [
    finalizeCall([
      {
        taskId: 1,
        kind: "numeric_spec",
        claim: S1_RIGHT,
        sourceId: sourceIdFor(input, /Oil and Oil Filter Replacement/),
        evidenceQuote: S1_RIGHT,
      },
    ]),
  ],
];

/** A model and a retriever that count what actually reaches them. */
function countedStubs(steps, corpus = MINI_CORPORA.S1) {
  const model = createScriptedModel(steps);
  const keyword = createKeywordRetriever(corpus);
  const counts = { retrievals: 0 };

  return {
    model,
    counts,
    streamTurn: model.streamTurn,
    retrieve: async (query, options) => {
      counts.retrievals += 1;
      return keyword(query, options);
    },
  };
}

function runtimeFor(stubs, extra = {}) {
  return {
    runAgent: runRepairPlannerAgent,
    extractTasks: extractRepairTasks,
    createPlanRuns: () => createPlanRunStore(),
    streamTurn: stubs.streamTurn,
    retrieve: stubs.retrieve,
    maxTurns: PLANNER_RUN_BOUNDS.maxTurns,
    ...extra,
  };
}

async function capture({ scenarios = [S1], repeats = 1, maxRuns = scenarios.length * repeats, stubs, limit = 1000, ...rest }) {
  const lines = [];
  const rejected = [];
  const sleeps = [];
  const logs = [];
  const limiter = createRequestLimiter({ maxProviderRequests: limit });
  const summary = await runCaptureSession({
    scenarios,
    repeats,
    maxRuns,
    limiter,
    runtime: runtimeFor(stubs),
    header: header(),
    writeLine: (line) => lines.push(line),
    writeRejected: (line) => rejected.push(line),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    log: (line) => logs.push(line),
    delayMs: 2000,
    ...rest,
  });
  const parsed = parsePlannerCaptureText(lines.join("\n"));

  return { summary, limiter, lines, rejected, sleeps, logs, parsed };
}

// ---- The request limiter (limit 3: mandatory) -------------------------------------

test("the limiter admits exactly N requests, counting model turns and retrievals together, then refuses and says so", async () => {
  const limiter = createRequestLimiter({ maxProviderRequests: 3 });
  const seen = [];
  const model = limiter.wrapStreamTurn(async function* () {
    seen.push("model");
    yield { type: "function_call", callId: "c", name: "x", arguments: {} };
  });
  const retrieve = limiter.wrapRetrieve(async () => {
    seen.push("retrieve");
    return [];
  });

  for await (const _event of model({})) void _event; // 1
  await retrieve("q"); // 2
  await retrieve("q"); // 3
  assert.deepEqual(limiter.state(), { max: 3, used: 3, refused: 0, tripped: false });

  await assert.rejects(retrieve("q"), RequestLimitReached);
  await assert.rejects(async () => {
    for await (const _event of model({})) void _event;
  }, RequestLimitReached);

  assert.deepEqual(seen, ["model", "retrieve", "retrieve"], "nothing reached the wrapped functions after the limit");
  assert.deepEqual(limiter.state(), { max: 3, used: 3, refused: 2, tripped: true });
});

test("a limit that is not a positive whole number is refused, so a typo cannot disable the guard", () => {
  for (const bad of [0, -1, 1.5, Number.NaN, undefined, null, "5"]) {
    assert.throws(() => createRequestLimiter({ maxProviderRequests: /** @type {any} */ (bad) }), TypeError, String(bad));
  }
});

test("once the limit is reached the stubbed model and retriever receive no further call, and the run is Layer I", async () => {
  const stubs = countedStubs(oilChangeSteps());
  // Turn 1 (request 1) and its search (request 2) fit. Turn 2 would be the third.
  const result = await capture({ stubs, limit: 2 });

  assert.equal(stubs.model.turnsStarted, 1, "the model was asked once; the second turn was refused before reaching it");
  assert.equal(stubs.counts.retrievals, 1);
  assert.deepEqual(result.limiter.state(), { max: 2, used: 2, refused: 1, tripped: true });

  assert.deepEqual(result.parsed.errors, []);
  assert.equal(result.parsed.records.length, 1);
  const [{ run, session }] = result.parsed.records;

  assert.equal(run.outcome.status, "error");
  assert.equal(run.outcome.reason, REQUEST_LIMIT_REASON);
  assert.equal(session.limitReached, true);
  assert.equal(judgeRun(run, S1).run.layer, "I:infrastructure", "a tripped limit is never a product failure");
});

test("a refused retrieval ends the run as Layer I even if the agent goes on to finalize without it", async () => {
  // Turn 1 asks for a search and finalizes in the same turn. The search is
  // refused (limit 1 is spent on the model turn); the agent turns that into a
  // tool error and the empty finalizer then completes the run as `not_found`.
  const stubs = countedStubs([[searchCall(1, "oil drain plug torque"), finalizeCall([])]]);
  const result = await capture({ stubs, limit: 1 });

  assert.equal(stubs.counts.retrievals, 0, "the retriever was never reached");
  const [{ run }] = result.parsed.records;

  assert.equal(run.outcome.status, "error", "the agent's own 'completed' is not kept: its plan was built on a refused search");
  assert.equal(run.outcome.reason, REQUEST_LIMIT_REASON);
  assert.equal(run.outputs, null);
  assert.equal(judgeRun(run, S1).run.layer, "I:infrastructure");
});

test("after the limit trips no further run is started, and the summary counts what was left", async () => {
  const stubs = countedStubs(oilChangeSteps());
  const result = await capture({ scenarios: [S1, S2], stubs, limit: 1 });

  assert.equal(result.parsed.records.length, 1, "only the run that hit the limit is written");
  assert.equal(result.summary.planned, 2);
  assert.equal(result.summary.recorded, 1);
  assert.equal(result.summary.notStarted, 1);
  assert.equal(result.summary.limitReached, true);
  assert.equal(stubs.model.turnsStarted, 1);
});

// ---- --max-runs (limit 1: mandatory) --------------------------------------------------

test("the session refuses a plan larger than --max-runs before any request is made", async () => {
  const stubs = countedStubs(oilChangeSteps());

  await assert.rejects(capture({ scenarios: [S1, S2], repeats: 2, maxRuns: 3, stubs }), /4 runs.*--max-runs 3/s);
  assert.equal(stubs.model.turnsStarted, 0);
  assert.equal(stubs.counts.retrievals, 0);
});

test("runs go repeat by repeat, so a session cut short still holds every scenario once", async () => {
  const stubs = countedStubs([
    ...oilChangeSteps(),
    ...oilChangeSteps(),
    ...oilChangeSteps(),
    ...oilChangeSteps(),
  ]);
  const result = await capture({ scenarios: [S1, S2], repeats: 2, stubs });

  assert.deepEqual(
    result.parsed.records.map(({ run }) => `${run.scenarioId}#${run.repeat}`),
    ["S1-oil-and-filter#1", "S2-spark-plugs#1", "S1-oil-and-filter#2", "S2-spark-plugs#2"]
  );
});

// ---- Delay, and the bounded 429 retry ----------------------------------------------------

test("a delay separates runs: none before the first, one between each pair", async () => {
  const stubs = countedStubs([...oilChangeSteps(), ...oilChangeSteps(), ...oilChangeSteps()]);
  const result = await capture({ scenarios: [S1], repeats: 3, stubs });

  assert.deepEqual(result.sleeps, [2000, 2000]);
});

test("a rate-limited run is retried after a backoff, and the record kept is the attempt that worked", async () => {
  const stubs = countedStubs([{ fail: providerHttpError(429) }, ...oilChangeSteps()]);
  const result = await capture({ stubs });

  assert.deepEqual(result.sleeps, [5000], "one backoff, no case delay (a single run)");
  const [{ run, session }] = result.parsed.records;

  assert.equal(run.outcome.status, "completed");
  assert.equal(session.attempts, 2);
  assert.equal(session.providerRequests, 4, "the failed attempt's request counts: it was sent (1 + search turn + retrieval + finalize turn)");
  assert.equal(result.summary.rateLimitedRuns, 1);
});

test("a rate limit that never clears stops after the bounded retries and is infrastructure, not a product failure", async () => {
  const stubs = countedStubs(Array.from({ length: 10 }, () => ({ fail: providerHttpError(429) })));
  const result = await capture({ stubs, maxRetries: 4 });

  assert.deepEqual(result.sleeps, [5000, 10000, 15000, 20000]);
  const [{ run, session }] = result.parsed.records;

  assert.equal(session.attempts, 5);
  assert.equal(run.providerErrors.at(-1).httpStatus, 429);
  assert.equal(judgeRun(run, S1).run.layer, "I:infrastructure");
  assert.equal(stubs.model.turnsStarted, 5);
});

test("a retry never goes past the request limit: the limiter counts every attempt", async () => {
  const stubs = countedStubs(Array.from({ length: 10 }, () => ({ fail: providerHttpError(429) })));
  const result = await capture({ stubs, maxRetries: 4, limit: 2 });

  assert.equal(stubs.model.turnsStarted, 2, "two attempts used the whole budget");
  assert.equal(result.limiter.state().tripped, true);
});

// ---- A line that cannot be trusted is not written ---------------------------------------------

test("a record that disagrees with its own re-derivation is kept aside, not written into the capture", async () => {
  const stubs = countedStubs(oilChangeSteps());
  const result = await capture({
    stubs,
    buildRecord: () => {
      throw new PlannerCaptureMismatch("the plan text differs from what the record re-derives", ["the plan text differs"]);
    },
  });

  assert.equal(result.parsed.records.length, 0, "no line in the capture");
  assert.equal(result.summary.rejected, 1);
  assert.equal(result.rejected.length, 1, "the paid run's record is not lost");
  const kept = JSON.parse(result.rejected[0]);

  assert.equal(kept.scenarioId, "S1-oil-and-filter");
  assert.deepEqual(kept.problems, ["the plan text differs"]);
  assert.equal(kept.record.scenarioId, "S1-oil-and-filter");
});

test("the capture starts with the header and then one line per run", async () => {
  const stubs = countedStubs([...oilChangeSteps(), ...oilChangeSteps()]);
  const result = await capture({ scenarios: [S1], repeats: 2, stubs });

  assert.equal(JSON.parse(result.lines[0]).type, "header");
  assert.equal(result.lines.length, 3);
  assert.deepEqual(result.parsed.errors, []);
  assert.equal(result.summary.recorded, 2);
});

// ---- The caps the tool prints are the caps the agent enforces ----------------------------------

test("the caps printed in a dry run equal the agent's real caps", async () => {
  assert.equal(PLANNER_RUN_BOUNDS.maxToolCallsPerTurn, MAX_TOOL_CALLS_PER_TURN);
  assert.equal(PLANNER_RUN_BOUNDS.maxSearchResults, MAX_SEARCH_RESULTS);
  assert.equal(PLANNER_RUN_BOUNDS.evidenceContextCharLimit, EVIDENCE_CONTEXT_CHAR_LIMIT);

  // maxTurns is a default parameter inside the agent, not an export: prove it by
  // running the agent with a model that never stops asking for a search.
  const model = createScriptedModel(Array.from({ length: 20 }, () => [searchCall(1, "oil")]));
  await runRepairPlannerAgent(
    { brief: S1.brief, skillLevel: "beginner", availableTools: "", availableParts: "", constraints: "" },
    {
      isAiConfigured: true,
      streamTurn: model.streamTurn,
      retrieve: createKeywordRetriever(MINI_CORPORA.S1),
      planRuns: createPlanRunStore(),
    }
  );
  assert.equal(model.turnsStarted, PLANNER_RUN_BOUNDS.maxTurns, "the agent's default turn cap moved: update PLANNER_RUN_BOUNDS and the spec");
});

// ---- The dry-run plan (limit 5/6 and the estimate) ------------------------------------------------

const planFor = (overrides = {}) =>
  buildCapturePlan({
    scenarios: [S1, S2],
    repeats: 3,
    maxRuns: 6,
    maxProviderRequests: null,
    aiDailyCallLimit: 500,
    maxOutputTokens: 2048,
    rerankEnabled: false,
    database: { file: "C:/data/snapshot.db", isDefault: false },
    ...overrides,
  });

test("the plan counts runs as scenarios times repeats and the worst case per run as 8 model turns plus 64 retrievals", () => {
  const plan = planFor();

  assert.equal(plan.runs, 6);
  assert.deepEqual(plan.requests.perRun, { model: 8, retrievals: 64, worstCase: 72 });
  assert.equal(plan.requests.worstCaseTotal, 432);
  assert.equal(plan.withinMaxRuns, true);
});

test("a plan over --max-runs says by how much", () => {
  const plan = planFor({ maxRuns: 1 });

  assert.equal(plan.withinMaxRuns, false);
  assert.equal(plan.overMaxRunsBy, 5);
});

test("every limit is listed with its value, the token limits as absent and the provider budget as UNVERIFIED", () => {
  const limits = planFor({ maxProviderRequests: 40 }).limits;

  assert.deepEqual(
    limits.map((limit) => limit.id),
    [1, 2, 3, 4, 5, 6]
  );
  const byId = Object.fromEntries(limits.map((limit) => [limit.id, limit]));

  assert.equal(byId[1].value, 6, "--max-runs");
  assert.equal(byId[3].value, 40, "--max-provider-requests");
  assert.equal(byId[4].status, "absent", "the token limits are deferred (D9), and the tool says so");
  assert.equal(byId[5].value, 500, "AI_DAILY_CALL_LIMIT");
  assert.equal(byId[6].status, "UNVERIFIED", "the OpenAI project budget cannot be checked from the repository");
});

test("an unset --max-provider-requests is shown as not set, and a real run needs it", () => {
  const limit = planFor().limits.find((entry) => entry.id === 3);

  assert.equal(limit.value, null);
  assert.equal(limit.status, "not set");
});

test("the dry-run text labels the dollars an ESTIMATE, dates the price table, and lists limit 6 as unverified", () => {
  const text = formatCapturePlan(planFor({ maxProviderRequests: 80 }));

  assert.match(text, /DRY RUN/);
  assert.match(text, /nothing was called/i);
  assert.match(text, /ESTIMATE/);
  assert.match(text, new RegExp(`as of ${PRICE_TABLE.asOf}`));
  assert.match(text, /verify/i);
  assert.match(text, /UNVERIFIED/);
  assert.match(text, /OpenAI project budget/i);
  assert.match(text, /not built|absent/i, "the token limits and usage tee are named as absent");
  assert.match(text, /AI_DAILY_CALL_LIMIT/);
  assert.match(text, /72 provider requests per run/);
  assert.match(text, /432/);
  assert.match(text, /S1-oil-and-filter/);
  assert.match(text, /S2-spark-plugs/);
});

test("the text warns when the worst case could trip the daily call limit mid-session", () => {
  const text = formatCapturePlan(planFor({ scenarios: [S1, S2], repeats: 4, maxRuns: 8, aiDailyCallLimit: 500 }));

  assert.match(text, /could trip AI_DAILY_CALL_LIMIT/i);
  assert.doesNotMatch(formatCapturePlan(planFor()), /could trip/i, "432 requests fit under 500");
});

test("a disabled daily limit and a default database are both stated, not hidden", () => {
  const text = formatCapturePlan(
    planFor({ aiDailyCallLimit: 0, database: { file: "C:/repo/server/data/corolla-fix-helper.db", isDefault: true } })
  );

  assert.match(text, /AI_DAILY_CALL_LIMIT[^\n]*disabled/i);
  assert.match(text, /default database/i);
  assert.match(text, /refused/i);
});

test("the estimate is derived from the Stage 5-E2 usage and the dated price table", () => {
  assert.equal(PRICE_TABLE.asOf, "2026-11-05");
  assert.deepEqual(PRICE_TABLE.usdPerMillion, { input: 5, cachedInput: 0.5, output: 30 });

  const four = estimateSpend({ runs: 4, maxOutputTokens: 2048 });

  // Spec 12.1: four live runs, about $0.70 in total.
  assert.ok(Math.abs(four.typicalUsd - 0.7) < 0.02, `four runs estimated at ${four.typicalUsd}`);
  assert.ok(four.worstCaseUsd > 4 * 4 && four.worstCaseUsd < 4 * 6, "the caps alone imply roughly $4-5 per run (spec 12.2)");
  assert.equal(four.label, "ESTIMATE");
});
