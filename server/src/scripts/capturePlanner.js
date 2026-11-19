// npm run eval:planner:capture -- [--scenario <id>]... [--repeats N] [--max-runs N]
//                                 [--max-provider-requests N] [--no-dry-run --yes]
//                                 [--allow-default-database] [--output-dir DIR]
//
// PAID when --no-dry-run --yes is given (docs/planner-eval-spec.md, section 12).
// The default is a DRY RUN that calls nothing: it prints the plan, every limit,
// and an ESTIMATE of the dollars, and opens no database and loads no agent.
//
// A real run writes one line per Repair Planner run, as it is made, to
//
//   server/data/captures/planner-<timestamp>-<revision>.jsonl
//
// Each run spends real money at the model provider, so run it only with the
// owner's approval in the session, naming the scenarios, repeats, --max-runs,
// and --max-provider-requests. A real run REFUSES, and says why, unless:
//
//   --no-dry-run and --yes are both given, and OPENAI_API_KEY is set;
//   --max-provider-requests is given (it is mandatory: the tool counts every
//     model turn and retrieval and refuses the next one once it is reached);
//   the plan (scenarios x repeats) fits --max-runs, which defaults to 1;
//   the database is not the default server/data one (run against a VACUUM INTO
//     snapshot via DATABASE_FILE, so the corpus cannot change mid-baseline) and
//     has no write-ahead log;
//   when S8 is in the plan, the corpus still has no timing belt (the premise of
//     that scenario, checked before the paid run, not after).
//
// Token limits and the usage tee are NOT built (owner decision D9, Risk R6); the
// first paid session is a one-run pilot instead, and dollars are read from the
// OpenAI dashboard. A capture QUOTES REAL MANUAL TEXT: server/data/captures/ is
// gitignored and the repository is public, so never commit one.
//
// Judge a verifier change against a capture for free:
//   npm run eval:planner:replay -- <capture.jsonl>
// Turn a capture into the baseline report:
//   npm run eval:planner:report -- <capture.jsonl>
//
// The real agent is imported lazily, after every guard has passed: loading it
// opens the database.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkTimingBeltRefusalPrecondition } from "../evals/negativeCorpusPreconditions.js";
import { buildPlannerCaptureHeader, hashInstructions } from "../evals/plannerCapture.js";
import {
  PLANNER_RUN_BOUNDS,
  buildCapturePlan,
  createRequestLimiter,
  formatCapturePlan,
  runCaptureSession,
} from "../evals/plannerCaptureSession.js";
import { PLANNER_SCENARIOS, SCENARIO_SET_VERSION, getPlannerScenario } from "../evals/plannerScenarios.js";
import { buildModelTuning } from "../services/openAiModelCapabilities.js";
import { resolveInvocationPath } from "./replayCapture.js";

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Not beside config.databaseFile: a capture taken against a snapshot in a temp folder would be lost with it. */
export const DEFAULT_CAPTURE_DIR = path.join(SERVER_DIR, "data", "captures");
export const DEFAULT_DATABASE_FILE = path.join(SERVER_DIR, "data", "corolla-fix-helper.db");

const S8_ID = "S8-timing-belt";
const USAGE =
  "Usage: npm run eval:planner:capture -- [--scenario <id>]... [--repeats N] [--max-runs N] " +
  "[--max-provider-requests N] [--no-dry-run --yes] [--allow-default-database] [--output-dir DIR]";

/** `planner-2026-11-18T09-30-15Z-abc1234.jsonl`: sortable, and safe in a Windows path. */
export function buildCaptureFileName({ capturedAt, revision }) {
  const stamp = `${capturedAt.slice(0, 19).replace(/:/g, "-")}Z`;
  return `planner-${stamp}-${revision || "unknown"}.jsonl`;
}

/** @param {string[]} [argv] */
export function parseArguments(argv = []) {
  const options = {
    dryRun: true,
    yes: false,
    maxRuns: 1,
    repeats: 1,
    scenarios: /** @type {string[]} */ ([]),
    maxProviderRequests: /** @type {number | null} */ (null),
    allowDefaultDatabase: false,
    outputDir: /** @type {string | undefined} */ (undefined),
    help: false,
    unknown: /** @type {string[]} */ ([]),
    errors: /** @type {string[]} */ ([]),
  };

  /** @param {string} flag @param {string | undefined} raw */
  const positiveInteger = (flag, raw) => {
    const text = String(raw ?? "").trim();

    if (!/^[1-9]\d*$/.test(text)) {
      options.errors.push(`${flag} needs a positive whole number, not ${JSON.stringify(raw ?? "")}.`);
      return null;
    }
    return Number(text);
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--dry-run") {
      options.dryRun = true;
    } else if (argument === "--no-dry-run") {
      options.dryRun = false;
    } else if (argument === "--yes") {
      options.yes = true;
    } else if (argument === "--allow-default-database") {
      options.allowDefaultDatabase = true;
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else if (argument === "--scenario") {
      const id = String(argv[index + 1] ?? "").trim();

      if (id) {
        options.scenarios.push(id);
      } else {
        options.errors.push("--scenario needs a scenario id.");
      }
      index += 1;
    } else if (argument === "--output-dir") {
      options.outputDir = String(argv[index + 1] ?? "");
      index += 1;
    } else if (argument === "--max-runs") {
      options.maxRuns = positiveInteger(argument, argv[(index += 1)]) ?? options.maxRuns;
    } else if (argument === "--repeats") {
      options.repeats = positiveInteger(argument, argv[(index += 1)]) ?? options.repeats;
    } else if (argument === "--max-provider-requests") {
      options.maxProviderRequests = positiveInteger(argument, argv[(index += 1)]);
    } else {
      options.unknown.push(argument);
    }
  }

  return options;
}

// ---- The real world (replaced by tests) ---------------------------------------------------------------

/** Not exported for tests: it records the source revision, and git may be missing. */
function readGitRevision() {
  const repoRoot = path.resolve(SERVER_DIR, "..");

  try {
    const revision = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });

    return { revision: revision || null, dirty: status.trim().length > 0 };
  } catch {
    return { revision: null, dirty: null };
  }
}

async function defaultLoadConfig() {
  return (await import("../config.js")).config;
}

/** Loads the REAL agent. Importing it opens the database, so this runs only after every guard. */
async function defaultLoadRuntime() {
  const { AGENT_INSTRUCTIONS, MAX_TOOL_CALLS_PER_TURN, runRepairPlannerAgent } = await import(
    "../services/agent/repairPlannerAgent.js"
  );
  const { extractRepairTasks } = await import("../services/agent/repairTools.js");
  const { createPlanRunStore } = await import("../services/agent/planRunStore.js");
  const { streamResponsesTurn } = await import("../services/agent/openAiResponsesClient.js");
  const { retrieveRelevantChunks } = await import("../services/chunkRetrievalService.js");

  return {
    runAgent: runRepairPlannerAgent,
    extractTasks: extractRepairTasks,
    createPlanRuns: () => createPlanRunStore(),
    streamTurn: streamResponsesTurn,
    retrieve: retrieveRelevantChunks,
    maxTurns: PLANNER_RUN_BOUNDS.maxTurns,
    maxToolCallsPerTurn: MAX_TOOL_CALLS_PER_TURN,
    instructions: AGENT_INSTRUCTIONS,
  };
}

/** md5 of the file's bytes, streamed: the snapshot can be hundreds of megabytes. */
async function md5OfFile(file) {
  const hash = createHash("md5");

  for await (const chunk of fs.createReadStream(file)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

/** Read-only: counts, the saved Variant details, and whether a write-ahead log means the file is not a snapshot. */
async function defaultInspectCorpus(file) {
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(file, { readOnly: true });
  const count = (table) => Number(/** @type {any} */ (database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).n);
  /** @type {{ engineCode: string | null, buildPlant: string | null }} */
  let vehicleProfile = { engineCode: null, buildPlant: null };

  try {
    const documents = count("documents");
    const chunks = count("document_chunks");

    try {
      const row = /** @type {any} */ (database.prepare("SELECT engine_code, build_plant FROM vehicles ORDER BY id LIMIT 1").get());

      vehicleProfile = {
        engineCode: typeof row?.engine_code === "string" ? row.engine_code : null,
        buildPlant: typeof row?.build_plant === "string" ? row.build_plant : null,
      };
    } catch {
      // A database from before migration 006 has no such columns: unknown, not an error.
    }

    let walBytes = 0;

    try {
      walBytes = fs.statSync(`${file}-wal`).size;
    } catch {
      walBytes = 0;
    }

    return { documents, chunks, vehicleProfile, walBytes, dbSnapshotMd5: await md5OfFile(file) };
  } finally {
    database.close();
  }
}

async function defaultCheckTimingBelt(file) {
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(file, { readOnly: true });

  try {
    return checkTimingBeltRefusalPrecondition(database);
  } finally {
    database.close();
  }
}

// ---- The command ------------------------------------------------------------------------------------------

const samePath = (a, b) => path.relative(path.resolve(a), path.resolve(b)) === "";

/**
 * @typedef {{
 *   log?: (line: string) => void, error?: (line: string) => void,
 *   loadConfig?: () => Promise<any>, loadRuntime?: (config: any) => Promise<any>,
 *   databaseExists?: (file: string) => boolean,
 *   inspectCorpus?: (file: string) => any, checkTimingBelt?: (file: string) => any,
 *   readRevision?: () => { revision: string | null, dirty: boolean | null },
 *   now?: () => Date, sleep?: (ms: number) => Promise<void>, delayMs?: number,
 * }} CliIo
 */

/**
 * @param {string[]} [argv]
 * @param {CliIo} [io]
 * @returns {Promise<{ mode: string, exitCode: number, [key: string]: any }>}
 */
export async function runCli(argv = process.argv.slice(2), io = {}) {
  const {
    log = console.log,
    error = console.error,
    loadConfig = defaultLoadConfig,
    loadRuntime = defaultLoadRuntime,
    databaseExists = fs.existsSync,
    inspectCorpus = defaultInspectCorpus,
    checkTimingBelt = defaultCheckTimingBelt,
    readRevision = readGitRevision,
    now = () => new Date(),
    sleep,
    delayMs = Number(process.env.EVAL_CASE_DELAY_MS || 2000),
  } = io;
  const options = parseArguments(argv);

  if (options.help) {
    log(USAGE);
    return { mode: "help", exitCode: 0 };
  }

  const usageProblems = [
    ...options.errors,
    ...options.unknown.map((argument) => `Unknown option: ${argument}`),
  ];
  const unknownScenarios = options.scenarios.filter((id) => !getPlannerScenario(id));

  if (unknownScenarios.length > 0) {
    usageProblems.push(
      `No planner scenario has the id: ${unknownScenarios.join(", ")}. Valid ids: ${PLANNER_SCENARIOS.map((scenario) => scenario.id).join(", ")}.`
    );
  }
  if (usageProblems.length > 0) {
    usageProblems.forEach((problem) => error(problem));
    error(USAGE);
    return { mode: "usage_error", exitCode: 1 };
  }

  const scenarios = options.scenarios.length > 0 ? options.scenarios.map((id) => getPlannerScenario(id)) : PLANNER_SCENARIOS;
  const config = await loadConfig();
  const database = {
    file: config.databaseFile,
    isDefault: samePath(config.databaseFile, DEFAULT_DATABASE_FILE),
  };
  const plan = buildCapturePlan({
    scenarios,
    repeats: options.repeats,
    maxRuns: options.maxRuns,
    maxProviderRequests: options.maxProviderRequests,
    aiDailyCallLimit: config.openAiDailyCallLimit,
    maxOutputTokens: config.openAiMaxOutputTokens,
    rerankEnabled: config.rerankEnabled,
    database,
  });

  // ---- The default: a dry run. Nothing below this block runs. ----
  if (options.dryRun) {
    log(formatCapturePlan(plan));

    if (options.yes) {
      log("\nNote: --yes has no effect without --no-dry-run. This was a dry run.");
    }
    return { mode: "dry_run", exitCode: 0, plan };
  }

  // ---- A real run ----
  log(
    "PAID: this run makes real model calls with the key in OPENAI_API_KEY and spends real money. " +
      "Run it only with the owner's approval in this session, naming the scenarios, repeats, and limits."
  );
  log(`Database: ${database.file}`);

  /** @type {string[]} */ const refusals = [];

  if (!options.yes) {
    refusals.push("A real run needs --yes as well as --no-dry-run.");
  }
  if (!config.openAiApiKey) {
    refusals.push("A real run needs OPENAI_API_KEY: it records real, paid model replies.");
  }
  if (options.maxProviderRequests === null) {
    refusals.push(
      `A real run needs --max-provider-requests N (mandatory). The worst case is ${plan.requests.perRun.worstCase} per run, ${plan.requests.worstCaseTotal} for this plan.`
    );
  }
  if (!plan.withinMaxRuns) {
    refusals.push(
      `The plan is ${plan.runs} runs (${scenarios.length} scenarios x ${options.repeats} repeats), over --max-runs ${options.maxRuns}. ` +
        "Name the scenarios with --scenario, or raise --max-runs deliberately."
    );
  }
  if (database.isDefault && !options.allowDefaultDatabase) {
    refusals.push(
      `${database.file} is the default database. Take a VACUUM INTO snapshot, point DATABASE_FILE at it so the corpus cannot change mid-baseline, ` +
        "or pass --allow-default-database."
    );
  }
  if (!databaseExists(database.file)) {
    refusals.push(`The database file ${database.file} does not exist, so a run would have nothing to retrieve from.`);
  }

  /** @type {any} */ let corpus = null;

  if (refusals.length === 0) {
    corpus = await inspectCorpus(database.file);

    if (corpus.walBytes > 0) {
      refusals.push(
        `${database.file} has a write-ahead log, so it is not a clean snapshot and its fingerprint would not describe it. Use VACUUM INTO.`
      );
    }
    if (scenarios.some((scenario) => scenario.id === S8_ID)) {
      const precondition = await checkTimingBelt(database.file);

      if (precondition.stale) {
        const first = precondition.matches[0];

        refusals.push(
          `The corpus now mentions a timing belt (${precondition.matches.length} match(es), for example "${first?.documentTitle}" p.${first?.pageNumber}): ` +
            `the premise of ${S8_ID} no longer holds. Re-verify it before running that scenario.`
        );
      }
    }
  }

  const capturedAt = now().toISOString();
  const { revision, dirty } = readRevision();
  const outputDir = options.outputDir ? resolveInvocationPath(options.outputDir) : DEFAULT_CAPTURE_DIR;
  const capturePath = path.join(outputDir, buildCaptureFileName({ capturedAt, revision }));

  if (refusals.length === 0 && fs.existsSync(capturePath)) {
    refusals.push(`${capturePath} already exists. A capture is never written over another.`);
  }

  if (refusals.length > 0) {
    refusals.forEach((reason) => error(`Refused: ${reason}`));
    return { mode: "refused", exitCode: 1, reasons: refusals };
  }

  // Every guard has passed. Only now is the real agent (and the database it opens) loaded.
  const runtime = await loadRuntime(config);
  const header = buildPlannerCaptureHeader({
    capturedAt,
    // An unreadable revision or an unknown dirty state is recorded as such: a
    // capture that cannot name its code is NOT COMPARABLE, never silently clean.
    revision: revision || "unknown",
    dirty: dirty ?? true,
    config: {
      answerModel: config.openAiAnswerModel,
      reasoningEffort: buildModelTuning(config.openAiAnswerModel).reasoning?.effort ?? null,
      maxOutputTokens: config.openAiMaxOutputTokens,
      maxTurns: PLANNER_RUN_BOUNDS.maxTurns,
      maxToolCallsPerTurn: runtime.maxToolCallsPerTurn,
      maxSearchResults: PLANNER_RUN_BOUNDS.maxSearchResults,
      evidenceContextCharLimit: PLANNER_RUN_BOUNDS.evidenceContextCharLimit,
      retrievalMode: "hybrid",
      retrievalMaxChunksPerSource: config.retrievalMaxChunksPerSource,
      rerankEnabled: config.rerankEnabled,
      relevanceFloorEnabled: config.askRelevanceFloor,
      embeddingVersion: config.openAiEmbeddingVersion ?? null,
    },
    instructionsHash: hashInstructions(runtime.instructions),
    scenarioSetVersion: SCENARIO_SET_VERSION,
    repeats: options.repeats,
    vehicleProfile: corpus.vehicleProfile,
    corpus: { documents: corpus.documents, chunks: corpus.chunks, dbSnapshotMd5: corpus.dbSnapshotMd5 },
    limits: {
      maxRuns: options.maxRuns,
      maxProviderRequests: options.maxProviderRequests,
      maxInputTokensPerRun: null,
      maxInputTokensTotal: null,
    },
  });

  fs.mkdirSync(outputDir, { recursive: true });
  // "wx": an existing file is an error, never overwritten.
  fs.writeFileSync(capturePath, "", { flag: "wx" });
  const rejectedPath = capturePath.replace(/\.jsonl$/, ".rejected.jsonl");

  log(
    `Capturing ${plan.runs} run(s): ${scenarios.map((scenario) => scenario.id).join(", ")}, ${options.repeats} repeat(s), ` +
      `at most ${options.maxProviderRequests} provider request(s).`
  );
  log("Not built, on purpose (owner decision D9): token limits and the usage tee. Read dollars from the OpenAI dashboard.");
  log(`Writing ${capturePath}\n`);

  const limiter = createRequestLimiter({ maxProviderRequests: /** @type {number} */ (options.maxProviderRequests) });
  const summary = await runCaptureSession({
    scenarios,
    repeats: options.repeats,
    maxRuns: options.maxRuns,
    limiter,
    runtime,
    header,
    // Appended line by line, so a run that dies halfway keeps what it paid for.
    writeLine: (line) => fs.appendFileSync(capturePath, `${line}\n`, "utf8"),
    writeRejected: (line) => fs.appendFileSync(rejectedPath, `${line}\n`, "utf8"),
    log,
    delayMs,
    ...(sleep ? { sleep } : {}),
  });

  log("");
  log(
    `${summary.recorded} of ${summary.planned} run(s) recorded in ${capturePath}; ` +
      `${summary.providerRequests} provider request(s) sent, ${summary.refusedRequests} refused by the limit.`
  );

  if (summary.limitReached) {
    log(
      `REQUEST LIMIT REACHED: --max-provider-requests ${options.maxProviderRequests} was spent. ` +
        `${summary.notStarted} run(s) were not started, and the run that hit it is recorded as infrastructure (Layer I), not a product failure.`
    );
  }
  if (summary.rejected) {
    log(
      `${summary.rejected} run(s) were NOT written to the capture because the recorder or the re-derivation disagreed with the run. ` +
        `That is a tool bug, not a model problem. The raw records are in ${rejectedPath}.`
    );
  }
  if (summary.rateLimitedRuns) {
    log(`${summary.rateLimitedRuns} run(s) met a 429 rate limit (retried, bounded).`);
  }

  log("\nThe capture quotes real manual text. Keep it out of git and out of committed docs.");
  log(`Replay it for free:  npm run eval:planner:replay -- "${capturePath}"`);
  log(`Report on it:        npm run eval:planner:report -- "${capturePath}"`);

  const exitCode = summary.limitReached || summary.rejected > 0 || summary.recorded === 0 ? 1 : 0;

  return { mode: "captured", exitCode, summary, capturePath };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runCli();

  process.exitCode = result.exitCode;
}
