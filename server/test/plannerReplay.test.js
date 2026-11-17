import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildRepairPlanEvidence, verifyClaims } from "../src/services/agent/repairPlanEvidenceContract.js";

// Planner eval Phase 3: the offline replay (docs/planner-eval-spec.md, 10.1) over
// the committed SYNTHETIC capture. Its runs came from the real agent and the
// real verifier, recorded by the one recorder, so an untouched verifier must
// reproduce every recorded outcome. plannerCaptureFixture.test.js keeps the file
// honest (invented text, and exactly what the recorder produces today); this file
// is about what replay does with it.

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, "..");
const FIXTURE = path.join(here, "fixtures", "synthetic-planner-capture.jsonl");
const SCRIPT = path.join(serverRoot, "src", "scripts", "replayPlannerCapture.js");
const fixtureText = fs.readFileSync(FIXTURE, "utf8").replace(/\r\n/g, "\n");

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-replay-planner-"));

// Replay opens no database, and the spawned-CLI and import-graph tests below
// prove it. The scratch paths still come first, because the replay modules
// reach repairTools.js, whose default retriever is a lazy import() of the code
// that opens the database. That import never runs on this path, but
// databaseIsolation.test.js follows it, so this suite isolates like every other
// one that can reach database.js. (The spawned children get their own paths.)
process.env.DATABASE_FILE = path.join(tempRoot, "unused.db");
process.env.UPLOADS_DIR = path.join(tempRoot, "unused-uploads");

const { parsePlannerCaptureText } = await import("../src/evals/plannerCapture.js");
const { formatPlannerReplayReport, replayPlannerRecords } = await import("../src/evals/plannerReplay.js");

after(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

// The fixture today: 8 runs, 11 claim verdicts.
const RUNS = 8;
const CLAIMS = 11;

const freshParse = (text = fixtureText) => {
  const parsed = parsePlannerCaptureText(text);
  assert.deepEqual(parsed.errors, []);
  return parsed;
};

const runOf = (parsed, scenarioId, repeat) => {
  const found = parsed.records.find((record) => record.run.scenarioId === scenarioId && record.run.repeat === repeat);
  assert.ok(found, `${scenarioId} #${repeat} is in the fixture`);
  return found;
};

const lastLines = (report, count = 4) => report.split("\n").slice(-count);
const ZERO_LINES = [
  `0 claim verdicts changed of ${CLAIMS}`,
  `0 evidence statuses changed of ${RUNS} runs`,
  `0 readiness levels changed of ${RUNS} runs`,
  `0 draft notes changed of ${RUNS} runs`,
];

/** Rejects, with a new reason, every accepted claim that cites the given page. */
const rejectingPage = (page, reason) => (claims, context) => {
  const real = verifyClaims(claims, context);
  const accepted = [];
  const rejected = [...real.rejected];

  for (const entry of real.accepted) {
    if (entry.source?.pageNumber === page) {
      const original = claims.find((claim) => claim.claim === entry.claim && claim.sourceId === entry.sourceId);
      rejected.push({ claim: original, reason });
    } else {
      accepted.push(entry);
    }
  }
  return { accepted, rejected };
};

/** Keeps every claim the verifier turned down. */
const acceptingEverything = (claims, context) => ({
  accepted: claims.map((claim) => ({ ...claim, source: context.sourcesById.get(claim.sourceId) })),
  rejected: [],
});

// ---- 1. Round trip --------------------------------------------------------------

test("an unchanged verifier reproduces every recorded outcome: four lines, all zero", () => {
  const parsed = freshParse();
  const result = replayPlannerRecords(parsed.records);

  assert.equal(parsed.header.revision, "synthetic");
  assert.equal(result.runCount, RUNS);
  assert.equal(result.verdictTotal, CLAIMS);
  for (const key of [
    "verdictChanges",
    "validityChanges",
    "decisiveChanges",
    "statusChanges",
    "readinessChanges",
    "draftNoteChanges",
    "textChanges",
    "errors",
  ]) {
    assert.deepEqual(result[key], [], key);
  }

  const report = formatPlannerReplayReport({ header: parsed.header, result });
  assert.deepEqual(lastLines(report), ZERO_LINES);
  assert.match(report, /^Replaying capture: 8 runs, captured 2026-11-17T00:00:00.000Z at revision synthetic\./);
});

// ---- 2. A changed verifier prints exactly the verdicts it changes -----------------

test("a stricter verifier prints exactly the verdicts it rejects, with the new reason", () => {
  const parsed = freshParse();
  const result = replayPlannerRecords(parsed.records, { verifyClaims: rejectingPage(4, "wrong_variant") });

  // Page 4 is the other variant's figure, cited only by the contradiction run.
  assert.deepEqual(
    result.verdictChanges.map((change) => [change.scenarioId, change.repeat, change.turn, change.callOrdinal, change.claimIndex, change.before, change.after]),
    [["S1-oil-and-filter", 2, 2, 0, 1, "accepted", "wrong_variant"]]
  );
  // Only the verdict seam moved, so nothing downstream of it did.
  assert.deepEqual(result.statusChanges, []);
  assert.deepEqual(result.draftNoteChanges, []);

  const report = formatPlannerReplayReport({ header: parsed.header, result });
  assert.match(report, /S1-oil-and-filter #2 turn 2 call 0 claim\[1\] \(task 1\): accepted → wrong_variant/);
  assert.match(report, /claim: Tighten the oil drain plug to 45 N·m \(33 ft-lbf\)\./);
  assert.match(report, /source: S\d+, Alternate Variant Zeta Service Notes - Synthetic Fixture, page 4/);
  assert.deepEqual(lastLines(report), [
    `1 claim verdict changed of ${CLAIMS}`,
    ZERO_LINES[1],
    ZERO_LINES[2],
    ZERO_LINES[3],
  ]);
});

test("a looser verifier prints exactly the verdicts it now accepts", () => {
  const result = replayPlannerRecords(freshParse().records, { verifyClaims: acceptingEverything });

  assert.deepEqual(
    result.verdictChanges.map((change) => [change.scenarioId, change.repeat, change.claimIndex, change.before, change.after]),
    [
      ["S1-oil-and-filter", 3, 1, "claim_not_in_quote", "accepted"],
      ["S1-oil-and-filter", 3, 2, "quote_not_in_source", "accepted"],
      ["S1-oil-and-filter", 3, 3, "unit_cut", "accepted"],
    ]
  );
});

test("the evidence, readiness, and draft seams move only their own line", () => {
  const only = (scenarioId, repeat) => [runOf(freshParse(), scenarioId, repeat)];
  const records = only("S1-oil-and-filter", 1);

  // A changed evidence contract: a different status, everything else as built.
  const status = replayPlannerRecords(records, {
    buildEvidence: (payload, context) => ({ ...buildRepairPlanEvidence(payload, context), evidenceStatus: "verified" }),
  });
  assert.deepEqual(status.verdictChanges, []);
  assert.deepEqual(
    status.statusChanges.map((change) => [change.before, change.after]),
    [["partial", "verified"]]
  );

  // A changed readiness check: both acknowledgment states are re-derived.
  const readiness = replayPlannerRecords(records, { readiness: () => ({ level: "ready", score: 99 }) });
  assert.deepEqual(readiness.verdictChanges, []);
  assert.deepEqual(readiness.statusChanges, []);
  assert.deepEqual(
    readiness.readinessChanges.map((change) => [change.state, change.before.level, change.after.level]),
    [
      ["unacknowledged", "almost_ready", "ready"],
      ["acknowledged", "almost_ready", "ready"],
    ]
  );

  // A changed checklist builder.
  const draft = replayPlannerRecords(records, { buildDraft: () => ({ notes: "different notes" }) });
  assert.deepEqual(draft.verdictChanges, []);
  assert.deepEqual(draft.statusChanges, []);
  assert.deepEqual(draft.readinessChanges, []);
  assert.equal(draft.draftNoteChanges.length, 1);

  const report = formatPlannerReplayReport({ header: null, result: readiness });
  assert.deepEqual(lastLines(report), [
    "0 claim verdicts changed of 1",
    "0 evidence statuses changed of 1 run",
    "1 readiness level changed of 1 run",
    "0 draft notes changed of 1 run",
  ]);
});

test("a deliberately altered record gets exactly one changed verdict from the REAL verifier", () => {
  const parsed = freshParse();
  const record = runOf(parsed, "S1-oil-and-filter", 1);
  // The recorded finalizer said 37 N·m. The altered claim is no longer a fragment of its quote.
  record.run.finalizers[0].arguments.claims[0].claim = "Tighten the oil drain plug to 38 N·m (27 ft-lbf).";

  const result = replayPlannerRecords([record]);

  assert.deepEqual(
    result.verdictChanges.map((change) => [change.claimIndex, change.before, change.after]),
    [[0, "accepted", "claim_not_in_quote"]]
  );
  // With its only claim gone the plan is no longer grounded: a status change is
  // counted on its own line, never as a second verdict.
  assert.deepEqual(
    result.statusChanges.map((change) => [change.before, change.after]),
    [["partial", "not_found"]]
  );

  const report = formatPlannerReplayReport({ header: parsed.header, result });
  assert.deepEqual(lastLines(report).slice(0, 2), ["1 claim verdict changed of 1", "1 evidence status changed of 1 run"]);
});

test("a finalizer the validator now refuses is reported, and its claims count as changed", () => {
  const record = runOf(freshParse(), "S1-oil-and-filter", 1);
  // An unknown field is a structural error: the finalizer is no longer valid.
  record.run.finalizers[0].arguments.extra = true;

  const result = replayPlannerRecords([record]);

  assert.deepEqual(
    result.validityChanges.map((change) => [change.before, change.after]),
    [["valid", "invalid"]]
  );
  assert.deepEqual(
    result.verdictChanges.map((change) => [change.claimIndex, change.before, change.after]),
    [[0, "accepted", null]]
  );
});

// ---- 3. Malformed lines ------------------------------------------------------------

test("a capture that cannot be read in full is reported line by line, and replay still covers the rest", () => {
  const lines = fixtureText.split("\n").filter(Boolean);
  const text = `${[...lines, "this is not json"].join("\n")}\n`;
  const parsed = parsePlannerCaptureText(text);

  assert.equal(parsed.records.length, RUNS);
  assert.deepEqual(parsed.errors, [{ line: lines.length + 1, message: "not valid JSON" }]);

  const report = formatPlannerReplayReport({
    header: parsed.header,
    parseErrors: parsed.errors,
    result: replayPlannerRecords(parsed.records),
  });
  assert.match(report, new RegExp(`1 line could not be replayed:\\n  line ${lines.length + 1}: not valid JSON`));
  assert.deepEqual(lastLines(report), ZERO_LINES);
});

test("a replay that throws on one run reports that run's line and keeps going", () => {
  const parsed = freshParse();
  const result = replayPlannerRecords(parsed.records, {
    readiness: () => {
      throw new Error("readiness exploded");
    },
  });

  assert.equal(result.errors.length, RUNS - 1, "every run that reaches readiness throws; the provider failure made no plan");
  assert.match(result.errors[0].message, /readiness exploded/);
  assert.equal(typeof result.errors[0].line, "number");
});

function runCli(args, { env = {}, cwd } = {}) {
  /** @type {NodeJS.ProcessEnv} */
  const merged = { ...process.env, ...env };
  delete merged.OPENAI_API_KEY;
  return spawnSync(process.execPath, [SCRIPT, ...args], { env: merged, cwd, encoding: "utf8" });
}

test("eval:planner:replay exits 1 on an unreadable capture and on a bad invocation, and 0 otherwise", () => {
  const good = runCli([FIXTURE]);
  assert.equal(good.status, 0, good.stderr);
  assert.deepEqual(lastLines(good.stdout.trim()), ZERO_LINES);

  const lines = fixtureText.split("\n").filter(Boolean);
  const broken = path.join(tempRoot, "broken.jsonl");
  fs.writeFileSync(broken, `${[...lines.slice(0, 3), "this is not json", ...lines.slice(3)].join("\n")}\n`);
  const unreadable = runCli([broken]);
  assert.equal(unreadable.status, 1);
  assert.match(unreadable.stdout, /1 line could not be replayed:\n {2}line 4: not valid JSON/);
  assert.deepEqual(lastLines(unreadable.stdout.trim()), ZERO_LINES, "the other runs were still replayed");

  const notAHeader = path.join(tempRoot, "no-header.jsonl");
  fs.writeFileSync(notAHeader, `${lines[1]}\n`);
  const refused = runCli([notAHeader]);
  assert.equal(refused.status, 1);
  assert.match(refused.stdout, /line 1: the first line must be a corolla-fix-helper\/planner-capture header/);

  const missing = runCli([path.join(tempRoot, "does-not-exist.jsonl")]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Cannot read the capture/);

  const noPath = runCli([]);
  assert.equal(noPath.status, 1);
  assert.match(noPath.stderr, /Usage: npm run eval:planner:replay/);

  const unknown = runCli(["--rederive-tasks", FIXTURE]);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Unknown option: --rederive-tasks/);
});

// ---- 4. Offline ----------------------------------------------------------------------

test("npm run eval:planner:replay runs offline with no key, no network, and no database", () => {
  // If the script ever imported database.js, the folder named here would be
  // created; if it ever reached the network, the preload makes that throw.
  const missingDataDir = path.join(tempRoot, "must-not-exist");
  const preload = path.join(tempRoot, "no-network.mjs");
  fs.writeFileSync(preload, 'globalThis.fetch = () => { throw new Error("replay must not use the network"); };\n');

  const run = spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, SCRIPT, FIXTURE], {
    env: (() => {
      /** @type {NodeJS.ProcessEnv} */
      const env = { ...process.env, DATABASE_FILE: path.join(missingDataDir, "corolla.db"), UPLOADS_DIR: path.join(missingDataDir, "up") };
      delete env.OPENAI_API_KEY;
      return env;
    })(),
    encoding: "utf8",
  });

  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(lastLines(run.stdout.trim()), ZERO_LINES);
  assert.equal(fs.existsSync(missingDataDir), false);
});

/**
 * Every file reachable from `entry` through STATIC imports. A dynamic
 * `import()` is skipped on purpose: repairTools.js loads its default retriever
 * that way, and that import never runs on the replay path.
 */
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

test("the replay path never imports config.js or database.js", () => {
  const src = path.join(serverRoot, "src");
  const forbidden = new Set([path.join(src, "config.js"), path.join(src, "database.js")]);

  for (const entry of [
    path.join(src, "evals", "plannerReplay.js"),
    path.join(src, "evals", "plannerCapture.js"),
    SCRIPT,
  ]) {
    const closure = staticImportClosure(entry);

    assert.ok(closure.size > 5, `${path.basename(entry)}: the walk found its imports`);
    assert.ok(
      [...closure].some((file) => file.endsWith(path.join("evals", "plannerJudge.js"))),
      `${path.basename(entry)}: the walk reaches the judge it re-uses`
    );
    for (const file of closure) {
      assert.equal(forbidden.has(file), false, `${path.basename(entry)} reaches ${path.relative(serverRoot, file)}`);
    }
  }

  // The check can fail: the real agent does reach both.
  const agent = staticImportClosure(path.join(src, "services", "agent", "repairPlannerAgent.js"));
  assert.ok(agent.has(path.join(src, "config.js")), "the agent imports config.js, so the walk would notice it");
});

test("a repo-relative path works through the root npm script", () => {
  // `npm run eval:planner:replay` at the root runs `npm --prefix server ...`, so
  // the script starts in server/ while the owner typed a path from the root. npm
  // records where it was invoked in INIT_CWD; resolving from process.cwd()
  // instead would read server/server/... and fail on every relative path.
  const repoRoot = path.join(serverRoot, "..");
  const run = runCli([path.join("server", "test", "fixtures", "synthetic-planner-capture.jsonl")], {
    env: { INIT_CWD: repoRoot },
    cwd: serverRoot,
  });

  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(lastLines(run.stdout.trim()), ZERO_LINES);
});
