import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import { createPlanRunStore } from "../src/services/agent/planRunStore.js";
import { MINI_CORPORA, createKeywordRetriever } from "../src/evals/fixtures/plannerMiniCorpora.js";
import { createScriptedModel, finalizeCall, searchCall, sourceIdFor } from "../src/evals/plannerScriptedModel.js";

// Planner eval Phase 5: the paid capture tool's command line. NO paid call is
// made here. The real agent runs inside a scratch database with a scripted model
// and invented text, and every guard that protects a paid session is exercised
// without one: a dry run that opens nothing, each refusal, the mandatory limits,
// and a capture that `eval:planner:replay` replays with no change.
const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-planner-capture-cli-"));
process.env.DATABASE_FILE = path.join(scratchRoot, "cli.db");
process.env.UPLOADS_DIR = path.join(scratchRoot, "uploads");
process.env.OPENAI_API_KEY = "";
process.env.NETWORK_MODE = "0";
fs.mkdirSync(process.env.UPLOADS_DIR, { recursive: true });

const { db } = await import("../src/database.js");
const { AGENT_INSTRUCTIONS, MAX_TOOL_CALLS_PER_TURN, runRepairPlannerAgent } = await import(
  "../src/services/agent/repairPlannerAgent.js"
);
const { extractRepairTasks } = await import("../src/services/agent/repairTools.js");
const { hashInstructions, parsePlannerCaptureText } = await import("../src/evals/plannerCapture.js");
const { replayPlannerRecords } = await import("../src/evals/plannerReplay.js");
const { SCENARIO_SET_VERSION } = await import("../src/evals/plannerScenarios.js");
const { DEFAULT_CAPTURE_DIR, buildCaptureFileName, parseArguments, runCli } = await import(
  "../src/scripts/capturePlanner.js"
);
const { runCli: runReplayCli } = await import("../src/scripts/replayPlannerCapture.js");

after(() => {
  if (typeof db.close === "function") {
    db.close();
  }
  fs.rmSync(scratchRoot, { recursive: true, force: true });
});

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, "..");
const S1_ID = "S1-oil-and-filter";
const S1_RIGHT = "Tighten the oil drain plug to 37 N·m (27 ft-lbf).";

const baseConfig = () => ({
  openAiApiKey: "test-key-not-real",
  openAiAnswerModel: "scripted-model",
  openAiMaxOutputTokens: 2048,
  openAiDailyCallLimit: 500,
  rerankEnabled: false,
  askRelevanceFloor: false,
  retrievalMaxChunksPerSource: 3,
  openAiEmbeddingVersion: "test-embed@8",
  databaseFile: path.join(scratchRoot, "snapshot.db"),
});

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

/** The injected world: a scripted model, a counting retriever, and a record of what the tool loaded. */
function world({ steps = oilChangeSteps(), config = baseConfig(), corpus = {}, ...overrides } = {}) {
  const model = createScriptedModel(steps);
  const keyword = createKeywordRetriever(MINI_CORPORA.S1);
  const seen = {
    retrievals: 0,
    runtimeLoaded: 0,
    inspected: 0,
    timingBeltChecks: 0,
    /** @type {string[]} */ workingCopies: [],
    cleanups: 0,
    /** @type {string[]} */ runtimeDatabaseFiles: [],
  };
  const corpusMd5 = corpus.dbSnapshotMd5 ?? "b".repeat(32);
  const out = [];
  const err = [];

  return {
    model,
    seen,
    out,
    err,
    io: {
      log: (line) => out.push(line),
      error: (line) => err.push(line),
      loadConfig: async () => config,
      loadRuntime: async (loadedConfig) => {
        seen.runtimeLoaded += 1;
        seen.runtimeDatabaseFiles.push(loadedConfig.databaseFile);
        return {
          runAgent: runRepairPlannerAgent,
          extractTasks: extractRepairTasks,
          createPlanRuns: () => createPlanRunStore(),
          streamTurn: model.streamTurn,
          retrieve: async (query, options) => {
            seen.retrievals += 1;
            return keyword(query, options);
          },
          maxTurns: 8,
          maxToolCallsPerTurn: MAX_TOOL_CALLS_PER_TURN,
          instructions: AGENT_INSTRUCTIONS,
        };
      },
      databaseExists: () => true,
      inspectCorpus: () => {
        seen.inspected += 1;
        return {
          documents: 12,
          chunks: 345,
          dbSnapshotMd5: "b".repeat(32),
          vehicleProfile: { engineCode: "ZETA-1", buildPlant: null },
          walBytes: 0,
          ...corpus,
        };
      },
      checkTimingBelt: () => {
        seen.timingBeltChecks += 1;
        return { stale: false, matches: [] };
      },
      readRevision: () => ({ revision: "abc1234", dirty: false }),
      now: () => new Date("2026-11-18T09:30:15.000Z"),
      sleep: async () => {},
      hashFile: async () => corpusMd5,
      listSidecars: () => [],
      prepareWorkingCopy: (file) => {
        seen.workingCopies.push(file);
        return {
          file: path.join(scratchRoot, "working-copy.db"),
          cleanup: () => {
            seen.cleanups += 1;
            return null;
          },
        };
      },
      ...overrides,
    },
  };
}

const outputDir = () => fs.mkdtempSync(path.join(scratchRoot, "captures-"));
const realRunArgs = (dir, ...more) => [
  "--no-dry-run",
  "--yes",
  "--scenario",
  S1_ID,
  "--max-provider-requests",
  "50",
  "--output-dir",
  dir,
  ...more,
];

// ---- Arguments ---------------------------------------------------------------------------------

test("by default a run is a dry run, of one run, with nothing confirmed", () => {
  const options = parseArguments([]);

  assert.equal(options.dryRun, true);
  assert.equal(options.yes, false);
  assert.equal(options.maxRuns, 1, "--max-runs defaults to 1");
  assert.equal(options.repeats, 1);
  assert.equal(options.maxProviderRequests, null);
  assert.equal(options.allowDefaultDatabase, false);
  assert.deepEqual(options.scenarios, []);
  assert.deepEqual(options.errors, []);
  assert.deepEqual(options.unknown, []);
});

test("every option is read, and a number that is not a positive whole number is an error, not a default", () => {
  const options = parseArguments([
    "--no-dry-run",
    "--yes",
    "--scenario",
    "A",
    "--scenario",
    "B",
    "--max-runs",
    "6",
    "--repeats",
    "3",
    "--max-provider-requests",
    "120",
    "--allow-default-database",
    "--output-dir",
    "somewhere",
  ]);

  assert.equal(options.dryRun, false);
  assert.equal(options.yes, true);
  assert.deepEqual(options.scenarios, ["A", "B"]);
  assert.equal(options.maxRuns, 6);
  assert.equal(options.repeats, 3);
  assert.equal(options.maxProviderRequests, 120);
  assert.equal(options.allowDefaultDatabase, true);
  assert.equal(options.outputDir, "somewhere");

  for (const flag of ["--max-runs", "--repeats", "--max-provider-requests"]) {
    for (const bad of ["0", "-3", "2.5", "many", ""]) {
      assert.equal(parseArguments([flag, bad]).errors.length, 1, `${flag} ${JSON.stringify(bad)}`);
    }
  }
  assert.deepEqual(parseArguments(["--frobnicate"]).unknown, ["--frobnicate"]);
});

test("the default output folder is the gitignored captures folder, and a capture's name carries its time and revision", () => {
  assert.equal(path.normalize(DEFAULT_CAPTURE_DIR), path.join(serverRoot, "data", "captures"));
  assert.match(fs.readFileSync(path.join(serverRoot, "..", ".gitignore"), "utf8"), /^server\/data\/captures\/$/m);
  assert.equal(
    buildCaptureFileName({ capturedAt: "2026-11-18T09:30:15.123Z", revision: "abc1234" }),
    "planner-2026-11-18T09-30-15Z-abc1234.jsonl"
  );
  assert.match(buildCaptureFileName({ capturedAt: "2026-11-18T09:30:15.123Z", revision: null }), /-unknown\.jsonl$/);
});

// ---- The dry run ----------------------------------------------------------------------------------

test("the dry run calls neither the model nor the retriever, loads no agent, and prints the estimate as an estimate", async () => {
  const { io, seen, model, out, err } = world();
  const dir = path.join(scratchRoot, "never-created");
  const result = await runCli(["--output-dir", dir], io);

  assert.equal(result.mode, "dry_run");
  assert.equal(result.exitCode, 0);
  assert.equal(seen.runtimeLoaded, 0, "the real agent (which opens the database when it loads) was never loaded");
  assert.equal(seen.retrievals, 0);
  assert.equal(model.turnsStarted, 0);
  assert.equal(seen.inspected, 0, "the database was not read");
  assert.deepEqual(seen.workingCopies, [], "no working copy of the snapshot was made");
  assert.equal(fs.existsSync(dir), false, "no capture folder or file was created");
  assert.deepEqual(err, []);

  const text = out.join("\n");

  assert.match(text, /DRY RUN/);
  assert.match(text, /ESTIMATE/);
  assert.match(text, /as of 2026-11-05/);
  assert.match(text, /UNVERIFIED/);
  assert.doesNotMatch(text, /\bPAID\b: this run/, "a dry run is not announced as a paid run");
});

test("--yes without --no-dry-run is still a dry run, and says why nothing was made", async () => {
  const { io, seen, out } = world();
  const result = await runCli(["--yes"], io);

  assert.equal(result.mode, "dry_run");
  assert.equal(seen.runtimeLoaded, 0);
  assert.match(out.join("\n"), /--yes has no effect without --no-dry-run/);
});

test("run as a command, a dry run opens no database and needs no key", () => {
  const dbFile = path.join(scratchRoot, "child-dry-run", "never.db");
  const env = {
    ...process.env,
    DATABASE_FILE: dbFile,
    UPLOADS_DIR: path.join(scratchRoot, "child-dry-run", "uploads"),
    OPENAI_API_KEY: "",
    NETWORK_MODE: "0",
  };
  const stdout = execFileSync(process.execPath, [path.join(serverRoot, "src", "scripts", "capturePlanner.js")], {
    cwd: serverRoot,
    env,
    encoding: "utf8",
  });

  assert.match(stdout, /DRY RUN/);
  assert.match(stdout, /ESTIMATE/);
  assert.equal(fs.existsSync(dbFile), false, "the database file was not created");
  assert.equal(fs.existsSync(path.dirname(dbFile)), false, "nothing under the database folder was created either");
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

test("the capture script cannot reach config.js or database.js without a guard: they are only imported lazily", () => {
  const src = path.join(serverRoot, "src");
  const closure = staticImportClosure(path.join(src, "scripts", "capturePlanner.js"));

  assert.ok([...closure].some((file) => file.endsWith(path.join("evals", "plannerCaptureSession.js"))), "the walk reaches the session module");
  for (const forbidden of ["config.js", "database.js"]) {
    assert.equal(closure.has(path.join(src, forbidden)), false, `capturePlanner.js statically reaches ${forbidden}`);
  }
  assert.ok(
    staticImportClosure(path.join(src, "services", "agent", "repairPlannerAgent.js")).has(path.join(src, "database.js")) ||
      staticImportClosure(path.join(src, "services", "chunkRetrievalService.js")).has(path.join(src, "database.js")),
    "the check can fail: the real agent's own import graph does reach the database"
  );
});

test("both commands are wired through the root and the server package.json", () => {
  const root = JSON.parse(fs.readFileSync(path.join(serverRoot, "..", "package.json"), "utf8")).scripts;
  const server = JSON.parse(fs.readFileSync(path.join(serverRoot, "package.json"), "utf8")).scripts;

  assert.equal(server["eval:planner:capture"], "node src/scripts/capturePlanner.js");
  assert.equal(server["eval:planner:report"], "node src/scripts/reportPlannerBaseline.js");
  assert.equal(root["eval:planner:capture"], "npm --prefix server run eval:planner:capture --");
  assert.equal(root["eval:planner:report"], "npm --prefix server run eval:planner:report --");
});

// ---- A real run refuses unless every guard is met ----------------------------------------------------

test("a real run refuses without --yes, says PAID, and loads nothing", async () => {
  const { io, seen, out, err } = world();
  const dir = outputDir();
  const result = await runCli(["--no-dry-run", "--scenario", S1_ID, "--max-provider-requests", "50", "--output-dir", dir], io);

  assert.equal(result.mode, "refused");
  assert.equal(result.exitCode, 1);
  assert.match(out.join("\n"), /PAID/);
  assert.match(err.join("\n"), /--yes/);
  assert.equal(seen.runtimeLoaded, 0);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test("a real run refuses without a key", async () => {
  const { io, seen, err } = world({ config: { ...baseConfig(), openAiApiKey: "" } });
  const result = await runCli(realRunArgs(outputDir()), io);

  assert.equal(result.mode, "refused");
  assert.equal(result.exitCode, 1);
  assert.match(err.join("\n"), /OPENAI_API_KEY/);
  assert.equal(seen.runtimeLoaded, 0);
});

test("a real run refuses without --max-provider-requests: the limit is mandatory", async () => {
  const { io, seen, err } = world();
  const result = await runCli(
    ["--no-dry-run", "--yes", "--scenario", S1_ID, "--output-dir", outputDir()],
    io
  );

  assert.equal(result.mode, "refused");
  assert.match(err.join("\n"), /--max-provider-requests/);
  assert.equal(seen.runtimeLoaded, 0);
});

test("a real run refuses a plan larger than --max-runs, and with no --scenario the default plan is larger than 1", async () => {
  const { io, seen, err } = world();
  const result = await runCli(["--no-dry-run", "--yes", "--max-provider-requests", "50", "--output-dir", outputDir()], io);

  assert.equal(result.mode, "refused");
  assert.match(err.join("\n"), /--max-runs 1/);
  assert.equal(seen.runtimeLoaded, 0);
});

test("a real run refuses the default database unless --allow-default-database is passed, and names the path", async () => {
  const defaultFile = path.join(serverRoot, "data", "corolla-fix-helper.db");
  const config = { ...baseConfig(), databaseFile: defaultFile };
  const refused = world({ config });
  const result = await runCli(realRunArgs(outputDir()), refused.io);

  assert.equal(result.mode, "refused");
  assert.match(refused.err.join("\n"), /default database/i);
  assert.match(refused.err.join("\n"), /VACUUM INTO/);
  assert.equal(refused.seen.runtimeLoaded, 0);

  const allowed = world({ config });
  const ok = await runCli(realRunArgs(outputDir(), "--allow-default-database"), allowed.io);

  assert.equal(ok.mode, "captured", "the flag lets the same run through");
});

test("a real run prints which database it will use before it spends anything", async () => {
  const { io, out } = world();

  await runCli(realRunArgs(outputDir()), io);
  assert.match(out.join("\n"), new RegExp(`Database: .*snapshot\\.db`));
});

test("a real run refuses a database file that does not exist and one with a write-ahead log", async () => {
  const missing = world({ databaseExists: () => false });
  const first = await runCli(realRunArgs(outputDir()), missing.io);

  assert.equal(first.mode, "refused");
  assert.match(missing.err.join("\n"), /does not exist/);

  const wal = world({ corpus: { walBytes: 4096 } });
  const second = await runCli(realRunArgs(outputDir()), wal.io);

  assert.equal(second.mode, "refused");
  assert.match(wal.err.join("\n"), /write-ahead log/i);
  assert.equal(wal.seen.runtimeLoaded, 0);
});

test("an unknown scenario id is refused with the valid ones named, before anything runs", async () => {
  const { io, err, seen } = world();
  const result = await runCli(["--scenario", "S9-flux-capacitor"], io);

  assert.equal(result.exitCode, 1);
  assert.match(err.join("\n"), /S9-flux-capacitor/);
  assert.match(err.join("\n"), /S1-oil-and-filter/);
  assert.equal(seen.runtimeLoaded, 0);
});

test("S8 is only run while the corpus still has no timing belt; a stale precondition refuses the run", async () => {
  const stale = world({
    checkTimingBelt: () => ({ stale: true, matches: [{ ruleId: "timing_belt_phrase", documentTitle: "Title", pageNumber: 2, excerpt: "x" }] }),
  });
  const refused = await runCli(
    ["--no-dry-run", "--yes", "--scenario", "S8-timing-belt", "--max-provider-requests", "50", "--output-dir", outputDir()],
    stale.io
  );

  assert.equal(refused.mode, "refused");
  assert.match(stale.err.join("\n"), /timing belt/i);
  assert.equal(stale.seen.runtimeLoaded, 0);

  const fine = world({ steps: [[searchCall(1, "timing belt")], [finalizeCall([])]] });
  const ran = await runCli(
    ["--no-dry-run", "--yes", "--scenario", "S8-timing-belt", "--max-provider-requests", "50", "--output-dir", outputDir()],
    fine.io
  );

  assert.equal(ran.mode, "captured");
  assert.equal(fine.seen.timingBeltChecks, 1);
});

test("a run that does not include S8 never checks the timing-belt precondition", async () => {
  const { io, seen } = world();

  await runCli(realRunArgs(outputDir()), io);
  assert.equal(seen.timingBeltChecks, 0);
});

// ---- A real run, end to end, with a scripted model ------------------------------------------------------

test("an end-to-end run through the real agent writes a capture that replays with no change", async () => {
  const { io, seen, model, out } = world();
  const dir = outputDir();
  const result = await runCli(realRunArgs(dir), io);

  assert.equal(result.mode, "captured");
  assert.equal(result.exitCode, 0);
  assert.match(out.join("\n"), /PAID/);

  const files = fs.readdirSync(dir);

  assert.deepEqual(files, ["planner-2026-11-18T09-30-15Z-abc1234.jsonl"]);
  assert.equal(model.turnsStarted, 2);
  assert.equal(seen.retrievals, 1);

  const capturePath = path.join(dir, files[0]);
  const parsed = parsePlannerCaptureText(fs.readFileSync(capturePath, "utf8"));

  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.records.length, 1);
  assert.equal(parsed.records[0].run.outcome.status, "completed");

  const replay = replayPlannerRecords(parsed.records);

  assert.deepEqual(replay.errors, []);
  assert.ok(replay.verdictTotal >= 1, "the replay re-judged at least one claim");

  for (const kind of [
    "verdictChanges",
    "validityChanges",
    "decisiveChanges",
    "statusChanges",
    "readinessChanges",
    "draftNoteChanges",
    "textChanges",
  ]) {
    assert.deepEqual(replay[kind], [], `${kind}: the tool's own capture must replay as it was recorded`);
  }

  const replayed = [];
  const cli = await runReplayCli([capturePath], { log: (line) => replayed.push(line), error: (line) => replayed.push(line) });

  assert.deepEqual(cli.result.errors, []);
  const text = replayed.join("\n");

  assert.match(text, /^0 claim verdicts changed of \d+$/m);
  assert.match(text, /^0 evidence statuses changed of 1 run$/m);
  assert.match(text, /^0 readiness levels changed of 1 run$/m);
  assert.match(text, /^0 draft notes changed of 1 run$/m);
});

test("the header records the code, prompt, settings, scenarios, corpus and limits that produced the runs", async () => {
  const { io } = world();
  const dir = outputDir();

  await runCli(realRunArgs(dir), io);
  const { header } = parsePlannerCaptureText(fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]), "utf8"));

  assert.equal(header.revision, "abc1234");
  assert.equal(header.dirty, false);
  assert.equal(header.capturedAt, "2026-11-18T09:30:15.000Z");
  assert.equal(header.instructionsHash, hashInstructions(AGENT_INSTRUCTIONS));
  assert.equal(header.scenarioSetVersion, SCENARIO_SET_VERSION);
  assert.equal(header.repeats, 1);
  assert.deepEqual(header.vehicleProfile, { engineCode: "ZETA-1", buildPlant: null });
  assert.deepEqual(header.corpus, { documents: 12, chunks: 345, dbSnapshotMd5: "b".repeat(32) });
  assert.deepEqual(header.limits, {
    maxRuns: 1,
    maxProviderRequests: 50,
    maxInputTokensPerRun: null,
    maxInputTokensTotal: null,
  });
  assert.deepEqual(header.config, {
    answerModel: "scripted-model",
    reasoningEffort: null,
    maxOutputTokens: 2048,
    maxTurns: 8,
    maxToolCallsPerTurn: MAX_TOOL_CALLS_PER_TURN,
    maxSearchResults: 8,
    evidenceContextCharLimit: 1500,
    retrievalMode: "hybrid",
    retrievalMaxChunksPerSource: 3,
    rerankEnabled: false,
    relevanceFloorEnabled: false,
    embeddingVersion: "test-embed@8",
  });
});

test("a tripped request limit ends the session, is reported loudly, and exits 1 (the run is Layer I, never a product failure)", async () => {
  const { io, out, model, seen } = world();
  const dir = outputDir();
  const result = await runCli(
    ["--no-dry-run", "--yes", "--scenario", S1_ID, "--max-provider-requests", "2", "--output-dir", dir],
    io
  );

  assert.equal(result.mode, "captured");
  assert.equal(result.exitCode, 1);
  assert.equal(result.summary.limitReached, true);
  assert.equal(model.turnsStarted, 1, "the model was not asked a second time");
  assert.equal(seen.retrievals, 1);
  assert.match(out.join("\n"), /REQUEST LIMIT REACHED/);

  const parsed = parsePlannerCaptureText(fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]), "utf8"));

  assert.equal(parsed.records[0].run.outcome.reason, "request_limit_reached");
});

test("a capture is never written over an existing file", async () => {
  const dir = outputDir();

  fs.writeFileSync(path.join(dir, "planner-2026-11-18T09-30-15Z-abc1234.jsonl"), "keep me\n");
  const { io, err, seen } = world();
  const result = await runCli(realRunArgs(dir), io);

  assert.equal(result.mode, "refused");
  assert.match(err.join("\n"), /already exists/);
  assert.equal(seen.runtimeLoaded, 0, "no paid call was made before the file name was checked");
  assert.equal(fs.readFileSync(path.join(dir, "planner-2026-11-18T09-30-15Z-abc1234.jsonl"), "utf8"), "keep me\n");
});

// ---- The snapshot is only read (the 6-pilot finding) ------------------------------------------------

const sha256OfFile = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

/** A real VACUUM INTO snapshot in its own folder, with invented text: rollback-journal mode, no sidecar. */
function makeRealSnapshot(name) {
  const folder = fs.mkdtempSync(path.join(scratchRoot, `${name}-`));
  const source = path.join(folder, "source.db");
  const snapshot = path.join(folder, "snapshot.db");
  const database = new DatabaseSync(source);

  database.exec(`
    CREATE TABLE documents (id INTEGER PRIMARY KEY, title TEXT);
    CREATE TABLE document_chunks (id INTEGER PRIMARY KEY, document_id INTEGER, chunk_text TEXT);
    CREATE TABLE vehicles (id INTEGER PRIMARY KEY, engine_code TEXT, build_plant TEXT);
    INSERT INTO documents (title) VALUES ('Invented note');
    INSERT INTO document_chunks (document_id, chunk_text) VALUES (1, 'Invented text.');
    INSERT INTO vehicles (engine_code, build_plant) VALUES (NULL, NULL);
  `);
  database.exec(`VACUUM INTO '${snapshot.replace(/'/g, "''")}'`);
  database.close();
  fs.rmSync(source);
  return snapshot;
}

/** Real snapshot checks: the tool's own copy, hash, and sidecar listing, and the real read-only corpus inspection. */
const realSnapshotIo = { hashFile: undefined, listSidecars: undefined, prepareWorkingCopy: undefined, inspectCorpus: undefined, databaseExists: undefined };

test("the agent is handed a verified copy in a new folder, so a runtime that writes to its database leaves the snapshot byte-identical", async () => {
  const snapshot = makeRealSnapshot("writes");
  const before = sha256OfFile(snapshot);
  const workingDir = fs.mkdtempSync(path.join(scratchRoot, "working-"));
  const config = { ...baseConfig(), databaseFile: snapshot };
  const base = world({ config });
  let opened = null;
  let closed = 0;
  const { io, out, err } = world({
    config,
    ...realSnapshotIo,
    // What database.js does on import, done here on purpose: open writable, set WAL, write a row.
    loadRuntime: async (loadedConfig) => {
      opened = loadedConfig.databaseFile;
      const database = new DatabaseSync(opened);

      database.exec("PRAGMA journal_mode = WAL;");
      database.exec("INSERT INTO documents (title) VALUES ('written by the run')");
      const runtime = await base.io.loadRuntime(loadedConfig);

      return { ...runtime, close: () => ((closed += 1), database.close()) };
    },
  });
  const result = await runCli(realRunArgs(outputDir(), "--working-dir", workingDir), io);

  assert.equal(result.mode, "captured", err.join("\n"));
  assert.equal(result.exitCode, 0, err.join("\n"));
  assert.notEqual(opened, null);
  assert.notEqual(path.dirname(path.resolve(opened)), path.dirname(path.resolve(snapshot)), "the copy is never beside the snapshot");
  assert.ok(path.resolve(opened).startsWith(path.resolve(workingDir)), "the copy is under --working-dir");
  assert.equal(sha256OfFile(snapshot), before, "the snapshot's bytes did not change");
  assert.deepEqual(fs.readdirSync(path.dirname(snapshot)), ["snapshot.db"], "no -wal or -shm appeared beside the snapshot");
  assert.equal(closed, 1, "the runtime's database was closed");
  assert.deepEqual(fs.readdirSync(workingDir), [], "the copy and its folder were deleted");
  assert.equal(result.snapshotCheck.unchanged, true);
  assert.match(out.join("\n"), /Working copy: .*MD5 matches the snapshot/);
  assert.match(out.join("\n"), /Snapshot unchanged: .* still has MD5 [0-9a-f]{32}/);
});

test("a working copy whose MD5 differs from the snapshot's is refused before the agent loads, and is deleted", async () => {
  const { io, err, seen } = world({ hashFile: async (file) => (file.endsWith("working-copy.db") ? "c".repeat(32) : "b".repeat(32)) });
  const result = await runCli(realRunArgs(outputDir()), io);

  assert.equal(result.mode, "refused");
  assert.equal(result.exitCode, 1);
  assert.equal(seen.runtimeLoaded, 0, "nothing was spent");
  assert.equal(seen.cleanups, 1);
  assert.match(err.join("\n"), /Refused: The working copy .* is not the snapshot/);
});

test("the runtime always gets the copy's path, never the snapshot's", async () => {
  const { io, seen } = world();
  const result = await runCli(realRunArgs(outputDir()), io);

  assert.equal(result.exitCode, 0);
  assert.deepEqual(seen.workingCopies, [baseConfig().databaseFile], "the copy was made from the snapshot");
  assert.deepEqual(seen.runtimeDatabaseFiles, [path.join(scratchRoot, "working-copy.db")]);
});

test("a snapshot that changes during the session is reported loudly and the command exits 1", async () => {
  let hashes = 0;
  const { io, err } = world({ hashFile: async () => ((hashes += 1) === 1 ? "b".repeat(32) : "d".repeat(32)) });
  const result = await runCli(realRunArgs(outputDir()), io);

  assert.equal(result.mode, "captured", "the runs themselves were recorded");
  assert.equal(result.exitCode, 1);
  assert.equal(result.snapshotCheck.unchanged, false);
  assert.match(err.join("\n"), /SNAPSHOT CHANGED: .* now has MD5 d{32} \(Table 0 records b{32}\)/);
});

test("a sidecar file that appears beside the snapshot counts as a change", async () => {
  let listings = 0;
  const { io, err } = world({ listSidecars: () => ((listings += 1) === 1 ? [] : ["-wal"]) });
  const result = await runCli(realRunArgs(outputDir()), io);

  assert.equal(result.exitCode, 1);
  assert.match(err.join("\n"), /SNAPSHOT CHANGED: .*a new -wal file beside it/);
});

test("the copy is deleted and the snapshot re-checked even when loading the agent throws", async () => {
  let hashes = 0;
  const { io, seen } = world({
    hashFile: async () => ((hashes += 1), "b".repeat(32)),
    loadRuntime: async () => {
      throw new Error("agent failed to load");
    },
  });

  await assert.rejects(runCli(realRunArgs(outputDir()), io), /agent failed to load/);
  assert.equal(seen.cleanups, 1);
  assert.equal(hashes, 2, "the copy was checked before, and the snapshot after");
});

test("--working-dir is read, and needs a folder", () => {
  assert.equal(parseArguments(["--working-dir", "D:/scratch"]).workingDir, "D:/scratch");
  assert.equal(parseArguments([]).workingDir, undefined);
  assert.match(parseArguments(["--working-dir"]).errors.join(" "), /--working-dir needs a folder/);
});
