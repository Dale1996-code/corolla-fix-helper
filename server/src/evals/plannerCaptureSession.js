// The pure half of the paid Repair Planner capture tool (docs/planner-eval-spec.md,
// sections 10 and 12; Phase 5): the request limiter, the dry-run plan and its
// dollar estimate, and the loop that records runs one at a time.
//
// NOTHING HERE MAKES A PAID CALL. Every model, retriever, and agent is injected,
// so a test drives the whole session with a scripted model. scripts/capturePlanner.js
// is the only place the real ones are loaded, and only after its guards pass.
//
// Imports no config and no database. The dry run must be able to describe a
// session without opening anything (the agent's own module opens the database
// when it loads, so it is never imported here).
//
// THE TWO MANDATORY LIMITS (spec 12.3 limits 1 and 3, owner decision D9). The
// token limits and the usage tee are deliberately absent (D9, Risk R6); the plan
// says so, and a paid session is staged instead (a one-run pilot first).
//
//   --max-runs              exact: a plan larger than it is refused before any request.
//   --max-provider-requests exact: the limiter counts every model turn and every
//                           retrieval (a retrieval stands in for the embedding
//                           request it makes) and refuses the NEXT one once the
//                           limit is reached, so overshoot is at most the one
//                           request already in flight when it trips.
//
// WHY THE LIMITER ALSO WRAPS runAgent. The agent catches every tool error, so a
// refused retrieval only reaches the model as a tool error and the model may then
// finalize in the same turn: the run would "complete" on searches the tool refused.
// Any run during which the limiter refused a request is therefore recorded as a
// typed `request_limit_reached` failure, whatever the agent returned. The judge
// already classifies an unknown failure reason as Layer I (infrastructure), so
// no agent or judge code changes.

import { MAX_RATE_LIMIT_RETRIES } from "./answerCaseRunner.js";
import { PlannerCaptureMismatch, buildPlannerCaptureRecord } from "./plannerCapture.js";
import { RecorderOutOfSync, runPlannerCase } from "./plannerCaseRunner.js";
import { EVIDENCE_CONTEXT_CHAR_LIMIT, MAX_SEARCH_RESULTS } from "../services/agent/repairTools.js";

// ---- Bounds ------------------------------------------------------------------------

/**
 * The caps a planner run is held to. `maxTurns` is a default parameter inside
 * runRepairPlannerAgent and `maxToolCallsPerTurn` is exported from a module that
 * opens the database when it loads, so neither can be imported here. They are
 * copied, the session PASSES maxTurns to the agent so the cap it prints is the cap
 * it enforces, and plannerCaptureSession.test.js fails if the agent's own defaults
 * ever move.
 */
export const PLANNER_RUN_BOUNDS = Object.freeze({
  maxTurns: 8,
  maxToolCallsPerTurn: 8,
  maxSearchResults: MAX_SEARCH_RESULTS,
  evidenceContextCharLimit: EVIDENCE_CONTEXT_CHAR_LIMIT,
});

// ---- Dollars: an estimate, never a limit (spec 12.1, 12.2) ----------------------------

/** List prices, per million tokens. A secondary source: verify before relying on it. */
export const PRICE_TABLE = Object.freeze({
  asOf: "2026-11-05",
  source: "docs/planner-eval-spec.md section 12.1 (list prices from a secondary source)",
  usdPerMillion: Object.freeze({ input: 5, cachedInput: 0.5, output: 30 }),
});

/** What the Stage 5-E2 live runs consumed (spec 12.1): four runs, about $0.70. */
export const OBSERVED_USAGE = Object.freeze({
  runs: 4,
  responsesCalls: 28,
  inputTokens: 226463,
  cachedInputTokens: 138752,
  outputTokens: 6353,
});

/**
 * Input tokens one run would read if EVERY turn hit EVERY cap (spec 12.2: roughly
 * 0.7-0.9 million). Not realistic: observed runs average about 57,000.
 */
const CAP_BOUND_INPUT_TOKENS_PER_RUN = 900_000;

/** @param {{ input: number, cachedInput: number, output: number }} usage */
function dollars({ input, cachedInput, output }) {
  const price = PRICE_TABLE.usdPerMillion;

  return ((input - cachedInput) * price.input + cachedInput * price.cachedInput + output * price.output) / 1_000_000;
}

/**
 * @param {{ runs: number, maxOutputTokens?: number }} options
 */
export function estimateSpend({ runs, maxOutputTokens = 2048 }) {
  const perRunUsd =
    dollars({
      input: OBSERVED_USAGE.inputTokens,
      cachedInput: OBSERVED_USAGE.cachedInputTokens,
      output: OBSERVED_USAGE.outputTokens,
    }) / OBSERVED_USAGE.runs;
  const worstCasePerRunUsd = dollars({
    input: CAP_BOUND_INPUT_TOKENS_PER_RUN,
    cachedInput: 0,
    output: PLANNER_RUN_BOUNDS.maxTurns * maxOutputTokens,
  });

  return {
    label: "ESTIMATE",
    runs,
    perRunUsd,
    typicalUsd: runs * perRunUsd,
    worstCasePerRunUsd,
    worstCaseUsd: runs * worstCasePerRunUsd,
    priceAsOf: PRICE_TABLE.asOf,
  };
}

// ---- The request limiter ---------------------------------------------------------------

export const REQUEST_LIMIT_CODE = "eval_request_limit";
export const REQUEST_LIMIT_REASON = "request_limit_reached";

/** Thrown in place of a request the limiter will not send. Typed so the agent reads it as a stream failure. */
export class RequestLimitReached extends Error {
  /**
   * @param {number} limit
   * @param {string} kind  "model turn" or "retrieval"
   */
  constructor(limit, kind) {
    super(`The capture's --max-provider-requests limit (${limit}) was reached, so this ${kind} was not sent.`);
    this.name = "RequestLimitReached";
    this.code = REQUEST_LIMIT_CODE;
    this.reason = REQUEST_LIMIT_REASON;
  }
}

/**
 * Counts every model turn and every retrieval through ONE budget, and refuses
 * the next once the budget is spent. The check is made BEFORE the wrapped call,
 * so a refused request never reaches the model or the retriever.
 *
 * @param {{ maxProviderRequests: number }} options
 */
export function createRequestLimiter({ maxProviderRequests }) {
  if (!Number.isInteger(maxProviderRequests) || maxProviderRequests < 1) {
    throw new TypeError(
      `--max-provider-requests must be a positive whole number, not ${JSON.stringify(maxProviderRequests)}`
    );
  }
  const max = maxProviderRequests;
  let used = 0;
  let refused = 0;

  /** @param {string} kind */
  const admit = (kind) => {
    if (used >= max) {
      refused += 1;
      throw new RequestLimitReached(max, kind);
    }
    used += 1;
  };

  return {
    state: () => ({ max, used, refused, tripped: refused > 0 }),

    /** @param {(params: any) => AsyncIterable<any>} streamTurn */
    wrapStreamTurn: (streamTurn) =>
      async function* (/** @type {any} */ params) {
        admit("model turn");
        yield* streamTurn(params);
      },

    /** @param {(query: string, options?: any) => Promise<any>} retrieve */
    wrapRetrieve: (retrieve) => async (/** @type {string} */ query, /** @type {any} */ options) => {
      admit("retrieval");
      return retrieve(query, options);
    },
  };
}

// ---- The dry-run plan --------------------------------------------------------------------

/**
 * What a session WOULD do, and every limit that bounds it. Calls nothing.
 *
 * @param {{
 *   scenarios: Array<{ id: string }>, repeats: number, maxRuns: number,
 *   maxProviderRequests: number | null, aiDailyCallLimit: number, maxOutputTokens: number,
 *   rerankEnabled: boolean, database: { file: string, isDefault: boolean },
 * }} input
 */
export function buildCapturePlan({
  scenarios,
  repeats,
  maxRuns,
  maxProviderRequests,
  aiDailyCallLimit,
  maxOutputTokens,
  rerankEnabled,
  database,
}) {
  const bounds = PLANNER_RUN_BOUNDS;
  const runs = scenarios.length * repeats;
  const caps = { ...bounds, maxOutputTokens };
  const perRun = {
    model: bounds.maxTurns,
    retrievals: bounds.maxTurns * bounds.maxToolCallsPerTurn,
    worstCase: bounds.maxTurns + bounds.maxTurns * bounds.maxToolCallsPerTurn,
  };

  return {
    scenarios: scenarios.map((scenario) => scenario.id),
    repeats,
    runs,
    maxRuns,
    withinMaxRuns: runs <= maxRuns,
    overMaxRunsBy: Math.max(0, runs - maxRuns),
    requests: { perRun, worstCaseTotal: runs * perRun.worstCase },
    maxProviderRequests,
    aiDailyCallLimit,
    rerankEnabled,
    database,
    caps,
    estimate: estimateSpend({ runs, maxOutputTokens }),
    limits: [
      { id: 1, name: "--max-runs", value: maxRuns, status: "set", note: "exact: a plan larger than this is refused before any request" },
      {
        id: 2,
        name: "Fixed agent caps",
        value: caps,
        status: "fixed",
        note: "exact for counts and output; input tokens are bounded only indirectly (spec 12.2)",
      },
      {
        id: 3,
        name: "--max-provider-requests",
        value: maxProviderRequests,
        status: maxProviderRequests === null ? "not set" : "set",
        note: "exact: counts every model turn and retrieval, refuses the next once reached; REQUIRED for a real run",
      },
      {
        id: 4,
        name: "Token limits and the usage tee",
        value: null,
        status: "absent",
        note: "deferred (owner decision D9, Risk R6): not built, so spend is read from the OpenAI dashboard and the pilot is staged",
      },
      {
        id: 5,
        name: "AI_DAILY_CALL_LIMIT",
        value: aiDailyCallLimit,
        status: aiDailyCallLimit > 0 ? "set" : "disabled",
        note: "per process, in memory: the capture counts only its own requests",
      },
      {
        id: 6,
        name: "OpenAI project budget",
        value: null,
        status: "UNVERIFIED",
        note: "the only real dollar bound (spec D10b); confirm its value and that it stops requests, not just warns",
      },
    ],
  };
}

const usd = (value) => `$${value.toFixed(2)}`;

/**
 * The dry run's text.
 *
 * @param {ReturnType<typeof buildCapturePlan>} plan
 */
export function formatCapturePlan(plan) {
  const { requests, estimate, limits, database } = plan;
  const lines = [];
  const add = (line = "") => lines.push(line);

  add("Repair Planner capture: DRY RUN. Nothing was called: no model request, no retrieval, no database opened.");
  add("");
  add(`Scenarios (${plan.scenarios.length}): ${plan.scenarios.join(", ") || "(none)"}`);
  add(`Repeats: ${plan.repeats}   Runs: ${plan.runs}   (--max-runs ${plan.maxRuns})`);

  if (!plan.withinMaxRuns) {
    add(`  This plan is ${plan.overMaxRunsBy} run(s) over --max-runs: a real run would be refused. Raise --max-runs or narrow --scenario.`);
  }
  add("");
  add("Worst case (every run uses every cap)");
  add(
    `  ${requests.perRun.worstCase} provider requests per run: ${requests.perRun.model} model turns + up to ${requests.perRun.retrievals} retrievals`
  );
  add(`  ${requests.worstCaseTotal} for ${plan.runs} run(s), beside AI_DAILY_CALL_LIMIT ${plan.aiDailyCallLimit > 0 ? plan.aiDailyCallLimit : "0 (disabled)"}`);

  if (plan.aiDailyCallLimit > 0 && requests.worstCaseTotal > plan.aiDailyCallLimit) {
    add(`  WARNING: the worst case could trip AI_DAILY_CALL_LIMIT mid-session.`);
  }
  if (plan.rerankEnabled) {
    add("  RERANK_ENABLED is on: each retrieval can add a reranker request that these counts do not include.");
  }
  add("");
  add("Limits (spec 12.3)");

  for (const limit of limits) {
    const caps = plan.caps;
    const value =
      limit.id === 2
        ? `${caps.maxTurns} turns, ${caps.maxToolCallsPerTurn} tool calls/turn, ${caps.maxSearchResults} chunks/search, ${caps.evidenceContextCharLimit} chars/chunk, max_output_tokens ${caps.maxOutputTokens}`
        : limit.value === null
          ? "-"
          : limit.id === 5 && limit.status === "disabled"
            ? "0 (disabled)"
            : String(limit.value);

    add(`  ${limit.id}. ${limit.name}: ${value}  [${limit.status}]`);
    add(`       ${limit.note}`);
  }
  add("");
  add(`Estimated spend: ${usd(estimate.typicalUsd)} for ${plan.runs} run(s)  [${estimate.label}, not a limit]`);
  add(`  Price table as of ${estimate.priceAsOf}, verify: ${PRICE_TABLE.source}.`);
  add(
    `  Basis: the four Stage 5-E2 live runs (about ${usd(estimate.perRunUsd)} each). The caps alone would allow up to about ${usd(estimate.worstCasePerRunUsd)} a run (${usd(estimate.worstCaseUsd)} here) if every turn hit every cap uncached: not realistic, but the only bound the tool itself can promise.`
  );
  add("  Token usage is not recorded (the usage tee is not built), so no spend is measured: read dollars from the OpenAI dashboard.");
  add("");
  add(`Database: ${database.file}`);

  if (database.isDefault) {
    add("  This is the default database: a real run refuses it unless --allow-default-database is passed. Run against a VACUUM INTO snapshot via DATABASE_FILE.");
  }
  add("");
  add("To make PAID calls, all of these are required: --no-dry-run --yes, OPENAI_API_KEY, --max-provider-requests N,");
  add("--scenario <id> (so the plan fits --max-runs), and the owner's approval in the session that names them.");

  return lines.join("\n");
}

// ---- The session ---------------------------------------------------------------------------

/** What a run becomes when the limiter refused any request during it. */
const LIMIT_RESULT = Object.freeze({
  status: "error",
  code: REQUEST_LIMIT_CODE,
  reason: REQUEST_LIMIT_REASON,
  text: "",
  artifacts: {},
});

/** A rate limit is infrastructure: it is retried, and never a product signal. */
function wasRateLimited(record) {
  return (
    record.outcome?.status !== "completed" &&
    (record.providerErrors ?? []).some((/** @type {any} */ error) => error.httpStatus === 429)
  );
}

/**
 * Record each planned run, write each line as it is made (so a run that dies
 * keeps what it paid for), and stop when the request limit trips.
 *
 * @param {{
 *   scenarios: any[], repeats: number, maxRuns: number,
 *   limiter: ReturnType<typeof createRequestLimiter>,
 *   runtime: { runAgent: any, extractTasks: any, streamTurn: any, retrieve: any, createPlanRuns: any, maxTurns?: number },
 *   header: any, writeLine: (line: string) => void, writeRejected?: (line: string) => void,
 *   sleep?: (ms: number) => Promise<void>, log?: (line: string) => void, delayMs?: number,
 *   maxRetries?: number, buildRecord?: typeof buildPlannerCaptureRecord,
 * }} options
 */
export async function runCaptureSession({
  scenarios,
  repeats,
  maxRuns,
  limiter,
  runtime,
  header,
  writeLine,
  writeRejected = () => {},
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = () => {},
  delayMs = 0,
  maxRetries = MAX_RATE_LIMIT_RETRIES,
  buildRecord = buildPlannerCaptureRecord,
}) {
  const planned = scenarios.length * repeats;

  if (planned > maxRuns) {
    throw new RangeError(
      `This session would make ${planned} runs (${scenarios.length} scenarios x ${repeats} repeats), more than --max-runs ${maxRuns}. Nothing was run.`
    );
  }

  // Repeat by repeat, so a session cut short still holds each scenario once.
  const plan = [];

  for (let repeat = 1; repeat <= repeats; repeat += 1) {
    for (const scenario of scenarios) {
      plan.push({ scenario, repeat });
    }
  }

  const summary = {
    planned,
    recorded: 0,
    rejected: 0,
    failedRuns: 0,
    rateLimitedRuns: 0,
    notStarted: 0,
    limitReached: false,
    providerRequests: 0,
    refusedRequests: 0,
  };

  /** @param {any} request @param {any} options */
  const runAgent = async (request, options) => {
    const refusedBefore = limiter.state().refused;
    const result = await runtime.runAgent(request, options);

    return limiter.state().refused > refusedBefore ? LIMIT_RESULT : result;
  };

  const deps = {
    runAgent,
    extractTasks: runtime.extractTasks,
    streamTurn: limiter.wrapStreamTurn(runtime.streamTurn),
    retrieve: limiter.wrapRetrieve(runtime.retrieve),
    createPlanRuns: runtime.createPlanRuns,
    agentOptions: runtime.maxTurns === undefined ? {} : { maxTurns: runtime.maxTurns },
  };

  writeLine(JSON.stringify(header));

  for (const [index, { scenario, repeat }] of plan.entries()) {
    if (limiter.state().tripped) {
      summary.notStarted = plan.length - index;
      break;
    }
    if (index > 0) {
      await sleep(delayMs);
    }

    const label = `${scenario.id} #${repeat}`;
    const usedAtStart = limiter.state().used;
    const refusedAtStart = limiter.state().refused;
    let attempts = 0;
    let sawRateLimit = false;
    /** @type {any} */ let record = null;
    /** @type {any} */ let outOfSync = null;
    /** @type {any} */ let failure = null;

    for (;;) {
      attempts += 1;

      try {
        record = await runPlannerCase(scenario, deps, { repeat });
      } catch (error) {
        if (error instanceof RecorderOutOfSync) {
          outOfSync = error;
          record = error.record;
        } else {
          failure = error;
        }
        break;
      }

      if (wasRateLimited(record)) {
        sawRateLimit = true;

        if (!limiter.state().tripped && attempts <= maxRetries) {
          const backoffMs = 5000 * attempts;

          log(`  ${label}: rate limited, retrying in ${backoffMs / 1000}s (attempt ${attempts + 1} of ${maxRetries + 1})`);
          await sleep(backoffMs);
          continue;
        }
      }
      break;
    }

    if (sawRateLimit) {
      summary.rateLimitedRuns += 1;
    }

    if (failure) {
      summary.failedRuns += 1;
      log(`  ${label}: the run itself threw ${failure?.name ?? "an error"}; nothing was recorded for it.`);
      continue;
    }

    /** @type {any} */ let line = null;
    /** @type {string[]} */ let problems = [];

    if (outOfSync) {
      problems = outOfSync.problems?.length ? outOfSync.problems : [outOfSync.message];
    } else {
      try {
        line = buildRecord(record);
      } catch (error) {
        if (!(error instanceof PlannerCaptureMismatch)) {
          throw error;
        }
        problems = error.problems?.length ? error.problems : [error.message];
      }
    }

    if (!line) {
      // The recorder or the re-derivation disagreed with the run. Attribution
      // would be a guess, so no line goes into the capture; the paid record is
      // kept beside it so the spend is not lost.
      summary.rejected += 1;
      writeRejected(JSON.stringify({ scenarioId: scenario.id, repeat, problems, record }));
      log(`  ${label}: NOT WRITTEN (${problems[0]}); the raw record is kept in the .rejected.jsonl file.`);
      continue;
    }

    const session = {
      attempts,
      providerRequests: limiter.state().used - usedAtStart,
      limitReached: limiter.state().refused > refusedAtStart,
    };

    writeLine(JSON.stringify({ ...line, session }));
    summary.recorded += 1;

    if (record.outcome.status !== "completed") {
      summary.failedRuns += 1;
    }
    log(
      `  ${label}: ${record.outcome.status}${record.outcome.reason ? ` (${record.outcome.reason})` : ""}` +
        `${record.outcome.evidenceStatus ? `, ${record.outcome.evidenceStatus}` : ""}` +
        `, ${session.providerRequests} provider request(s)${attempts > 1 ? `, ${attempts} attempts` : ""}`
    );
  }

  const state = limiter.state();

  summary.providerRequests = state.used;
  summary.refusedRequests = state.refused;
  summary.limitReached = state.tripped;
  return summary;
}
