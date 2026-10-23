import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// eval:replay (audit Stage 1b, 4B-11) over a SYNTHETIC capture. The fixture's
// passages are invented text -- a real capture quotes the manuals and must
// never be committed -- and its recorded verdicts were judged by the real
// verifier through buildCaptureRecord, so an untouched verifier must reproduce
// every one of them.

import { ACCEPTED, judgeReply, parseCaptureText } from "../src/evals/answerCapture.js";
import { formatReplayReport, replayRecords } from "../src/evals/answerReplay.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, "fixtures", "synthetic-answer-capture.jsonl");
const SCRIPT = path.join(here, "..", "src", "scripts", "replayCapture.js");
const fixtureText = fs.readFileSync(FIXTURE, "utf8");

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-replay-capture-"));

after(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function fixtureLines() {
  return fixtureText.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function toText(lines) {
  return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
}

function replay(text, options) {
  const parsed = parseCaptureText(text);
  assert.deepEqual(parsed.errors, []);
  return { parsed, result: replayRecords(parsed.records, options) };
}

test("the fixture is invented text, never a real capture", () => {
  // A real capture would carry the manuals' own markers. Replacing this file
  // with one would publish copyrighted manual text in a public repository.
  // (Records only: the header's format name is the app's own name.)
  for (const record of fixtureLines().slice(1)) {
    const marker = JSON.stringify(record).match(/ALLDATA|Toyota|Corolla|2ZR|2AZ/i);
    assert.equal(marker, null, `${record.caseId} carries a real-manual marker: ${marker?.[0]}`);

    for (const chunk of record.chunks) {
      assert.match(chunk.documentTitle, /^Synthetic /);
    }
  }
});

test("an unchanged verifier reports 0 changed verdicts", () => {
  const { parsed, result } = replay(fixtureText);

  assert.equal(parsed.header.revision, "synthetic");
  assert.equal(result.recordCount, 4);
  assert.equal(result.verdictTotal, 9);
  assert.deepEqual(result.verdictChanges, []);
  assert.deepEqual(result.statusChanges, []);
  assert.deepEqual(result.errors, []);

  const report = formatReplayReport({ header: parsed.header, result });
  assert.equal(report.split("\n").at(-1), "0 verdicts changed of 9");
});

test("the fixture exercises every kind of verdict it claims to", () => {
  const verdicts = fixtureLines()
    .slice(1)
    .flatMap((record) => [
      record.captured.status,
      ...record.captured.verdicts.map((entry) => entry.verdict),
    ]);

  for (const expected of [
    ACCEPTED,
    "numeric_anomaly",
    "unknown_source",
    "quote_too_short",
    "unsourced_specification",
    "invalid_reply",
  ]) {
    assert.ok(verdicts.includes(expected), `fixture should contain ${expected}`);
  }
});

test("a deliberately altered record reports exactly 1 changed verdict", () => {
  const lines = fixtureLines();
  const record = lines[1];
  // The manual (invented) prints 23 N*m; the altered reply claims 25.
  record.reply.documentSupported[0].claim = "The widget housing bolt torque is 25 N*m.";

  const { parsed, result } = replay(toText(lines));

  assert.equal(result.verdictChanges.length, 1);
  assert.deepEqual(
    {
      caseId: result.verdictChanges[0].caseId,
      turn: result.verdictChanges[0].turn,
      channel: result.verdictChanges[0].channel,
      itemIndex: result.verdictChanges[0].itemIndex,
      before: result.verdictChanges[0].before,
      after: result.verdictChanges[0].after,
    },
    {
      caseId: "synthetic-widget-torque",
      turn: "primary",
      channel: "documentSupported",
      itemIndex: 0,
      before: ACCEPTED,
      after: "numeric_anomaly",
    }
  );
  // The other claim still verifies, and the reply already had a gap, so the
  // answer stays partial: a status line is not a second verdict.
  assert.deepEqual(result.statusChanges, []);

  const report = formatReplayReport({ header: parsed.header, result });
  assert.match(report, /synthetic-widget-torque \(primary\) documentSupported\[0\]: accepted → numeric_anomaly/);
  assert.match(report, /claim: The widget housing bolt torque is 25 N\*m\./);
  assert.match(report, /source: S1, Synthetic Widget Manual \(invented text\), page 3/);
  assert.equal(report.split("\n").at(-1), "1 verdict changed of 9");
});

test("a changed verifier shows only the rows it changes, with the new reason", () => {
  // Stands in for a future check (N5 P3's wrong_variant): it rejects any
  // claim citing page 7 and leaves everything else to the real verifier.
  const stricter = (reply, chunks) => {
    const judged = judgeReply(reply, chunks);

    return {
      ...judged,
      verdicts: judged.verdicts.map((entry) => {
        const claim = judged.value?.documentSupported?.[entry.itemIndex];
        const cited = claim && chunks[Number(claim.sourceId.slice(1)) - 1];

        return entry.channel === "documentSupported" && entry.verdict === ACCEPTED && cited?.pageNumber === 7
          ? { ...entry, verdict: "wrong_variant" }
          : entry;
      }),
    };
  };

  const { result } = replay(fixtureText, { judge: stricter });

  assert.deepEqual(
    result.verdictChanges.map((change) => [change.caseId, change.turn, change.itemIndex, change.after]),
    [["synthetic-widget-torque", "followUp", 0, "wrong_variant"]]
  );
});

test("a capture that cannot be read in full is refused line by line", () => {
  const [header, ...records] = fixtureLines();

  const noHeader = parseCaptureText(toText(records));
  assert.equal(noHeader.records.length, 0);
  assert.match(noHeader.errors[0].message, /first line must be a corolla-fix-helper\/answer-capture header/);

  const future = parseCaptureText(toText([{ ...header, version: 2 }, ...records]));
  assert.match(future.errors[0].message, /version 2 is not supported/);

  const broken = structuredClone(records[1]);
  delete broken.captured.verdicts;
  const mixed = parseCaptureText(
    `${toText([header, records[0], broken])}not json\n${JSON.stringify({ type: "planner" })}\n`
  );
  assert.equal(mixed.records.length, 1);
  assert.deepEqual(
    mixed.errors.map((error) => [error.line, error.message]),
    [
      [3, "captured.verdicts is missing"],
      [4, "not valid JSON"],
      [5, 'unsupported record type "planner"'],
    ]
  );

  assert.match(parseCaptureText("\n\n").errors[0].message, /empty/);
});

test("npm run eval:replay runs offline with no key, no network, and no database", () => {
  // If the script ever imported config.js or database.js, the database folder
  // named here would be created; if it ever reached the network, the preload
  // makes that throw.
  const missingDataDir = path.join(tempRoot, "must-not-exist");
  const preload = path.join(tempRoot, "no-network.mjs");
  fs.writeFileSync(
    preload,
    'globalThis.fetch = () => { throw new Error("eval:replay must not use the network"); };\n'
  );

  /** @type {NodeJS.ProcessEnv} */
  const env = { ...process.env, DATABASE_FILE: path.join(missingDataDir, "corolla.db") };
  delete env.OPENAI_API_KEY;

  const run = spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, SCRIPT, FIXTURE], {
    env,
    encoding: "utf8",
  });

  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim().split(/\r?\n/).at(-1), "0 verdicts changed of 9");
  assert.equal(fs.existsSync(missingDataDir), false);
});

test("a repo-relative path works through the root npm script", () => {
  // `npm run eval:replay` at the root runs `npm --prefix server ...`, so the
  // script starts in server/ while the owner typed a path from the root. npm
  // records where it was invoked in INIT_CWD; resolving from process.cwd()
  // instead read server/server/... and failed on every relative path.
  const serverDir = path.join(here, "..");
  const repoRoot = path.join(serverDir, "..");
  /** @type {NodeJS.ProcessEnv} */
  const env = { ...process.env, INIT_CWD: repoRoot };
  delete env.OPENAI_API_KEY;

  const run = spawnSync(
    process.execPath,
    [SCRIPT, path.join("server", "test", "fixtures", "synthetic-answer-capture.jsonl")],
    { cwd: serverDir, env, encoding: "utf8" }
  );

  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim().split(/\r?\n/).at(-1), "0 verdicts changed of 9");
});

test("eval:replay exits 1 on an unreadable capture and on a bad invocation", () => {
  const bad = path.join(tempRoot, "bad.jsonl");
  fs.writeFileSync(bad, '{"type":"ask"}\n');

  const unreadable = spawnSync(process.execPath, [SCRIPT, bad], { encoding: "utf8" });
  assert.equal(unreadable.status, 1);
  assert.match(unreadable.stdout, /line 1: the first line must be/);

  const noPath = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" });
  assert.equal(noPath.status, 1);
  assert.match(noPath.stderr, /Usage: npm run eval:replay/);
});
