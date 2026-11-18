import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import { createPlanRunStore } from "../src/services/agent/planRunStore.js";
import {
  buildRunSet,
  discoverComparisonFiles,
  findProvenanceMarkers,
  findSharedRuns,
} from "./fixtures/sourceDerivedMaterial.js";

// Planner eval Phase 3: the committed SYNTHETIC capture, and the two promises
// made about it.
//
//   1. It is invented text. A real capture quotes the manuals and must never be
//      committed to this public repository, so the fixture is scanned for the
//      manual's provenance markers and for long verbatim runs, the way the
//      planner corpora are (plannerFixtures.test.js).
//   2. It is exactly what the recorder produces today. The fixture is
//      regenerated from real agent runs and compared byte for byte, so a change
//      to the recorder's record shape fails here until it is a deliberate
//      version bump with a regenerated file, instead of silently changing what
//      every future capture contains.
//
// Regenerate with:  REGENERATE_PLANNER_FIXTURE=1 node --test test/plannerCaptureFixture.test.js
//
// The real agent opens the database when it loads, so the scratch paths come
// first (databaseIsolation.test.js enforces this order for every suite).
// plannerCapture.js is loaded the same way for a second reason: that guard
// follows even the lazy import() inside repairTools.js, which the capture code
// reaches but never runs.
const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-planner-fixture-"));
process.env.DATABASE_FILE = path.join(scratchRoot, "fixture.db");
process.env.UPLOADS_DIR = path.join(scratchRoot, "uploads");
process.env.OPENAI_API_KEY = "";
process.env.NETWORK_MODE = "0";
fs.mkdirSync(process.env.UPLOADS_DIR, { recursive: true });

const { db } = await import("../src/database.js");
const { AGENT_INSTRUCTIONS, runRepairPlannerAgent } = await import("../src/services/agent/repairPlannerAgent.js");
const { extractRepairTasks } = await import("../src/services/agent/repairTools.js");
const { PlannerCaptureMismatch, buildPlannerCaptureRecord, hashInstructions, parsePlannerCaptureText } = await import(
  "../src/evals/plannerCapture.js"
);
const { buildSyntheticPlannerCaptureText, recordSyntheticRuns } = await import(
  "../src/evals/fixtures/plannerSyntheticCapture.js"
);

after(() => {
  if (typeof db.close === "function") {
    db.close();
  }
  fs.rmSync(scratchRoot, { recursive: true, force: true });
});

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, "..");
const FIXTURE = path.join(here, "fixtures", "synthetic-planner-capture.jsonl");

const agent = () => ({
  runAgent: runRepairPlannerAgent,
  extractTasks: extractRepairTasks,
  createPlanRuns: () => createPlanRunStore(),
});

const regenerate = async () =>
  buildSyntheticPlannerCaptureText({ ...agent(), instructionsHash: hashInstructions(AGENT_INSTRUCTIONS) });

// Written before any test runs, so the tests below read the regenerated file.
if (process.env.REGENERATE_PLANNER_FIXTURE === "1") {
  fs.writeFileSync(FIXTURE, await regenerate());
}

// A Windows checkout with core.autocrlf turns the committed LF into CRLF; the
// bytes that matter are the lines, so compare those.
const fixtureText = () => fs.readFileSync(FIXTURE, "utf8").replace(/\r\n/g, "\n");
const fixture = () => {
  const parsed = parsePlannerCaptureText(fixtureText());
  assert.deepEqual(parsed.errors, [], "the committed fixture must be readable in full");
  return parsed;
};

// ---- The recorder's shape is pinned --------------------------------------------

test("the committed capture is exactly what real agent runs produce now", async () => {
  assert.equal(
    fixtureText(),
    await regenerate(),
    "The recorder, the verifier, or the capture format changed, so the committed fixture no longer matches. " +
      "If the capture's SHAPE changed, bump PLANNER_CAPTURE_VERSION first. Then regenerate with " +
      "REGENERATE_PLANNER_FIXTURE=1 node --test test/plannerCaptureFixture.test.js and review the diff."
  );
});

test("its header says which prompt, code, and settings produced it", () => {
  const { header } = fixture();

  assert.equal(header.revision, "synthetic");
  assert.equal(header.dirty, false);
  assert.equal(header.capturedAt, "2026-11-17T00:00:00.000Z");
  assert.equal(
    header.instructionsHash,
    hashInstructions(AGENT_INSTRUCTIONS),
    "the header hashes the very text the agent sends, so a prompt edit shows up here too"
  );
});

test("the fixture holds each situation a replay has to handle", () => {
  const { records } = fixture();
  const verdicts = records.flatMap((record) =>
    record.captured.finalizers.flatMap((finalizer) => finalizer.verdicts.map((entry) => entry.verdict))
  );

  for (const expected of ["accepted", "claim_not_in_quote", "quote_not_in_source", "unit_cut"]) {
    assert.ok(verdicts.includes(expected), `a claim should be ${expected}`);
  }
  assert.ok(
    records.some((record) => record.captured.finalizers.some((finalizer) => !finalizer.valid)),
    "a finalizer the validator refused"
  );
  assert.ok(
    records.some((record) => record.captured.decisive === null && record.run.outcome.status !== "completed"),
    "a run that never reached a plan"
  );
  assert.ok(
    records.some((record) => record.captured.decisive !== null && record.captured.finalizers.length > 1),
    "a plan reached after a correction"
  );

  const statuses = new Set(records.map((record) => record.run.outcome.evidenceStatus));
  assert.ok(statuses.has("partial") && statuses.has("not_found"), `evidence statuses seen: ${[...statuses]}`);

  assert.ok(
    records.some(
      (record) =>
        record.run.outputs &&
        record.captured.readinessAcknowledged.level !== record.run.outputs.readiness.level
    ),
    "a run whose readiness changes once the owner acknowledges the safety warning"
  );
});

// ---- Not source-derived (the repository is public) -------------------------------

// Every server .js file, so a passage already quoted anywhere is covered without
// editing a list. The planner-eval files are excluded: they are the files being
// checked, and a fixture must never vouch for itself.
const comparisonFiles = discoverComparisonFiles([path.join(serverRoot, "src"), path.join(serverRoot, "test")], {
  exclude: /\/(?:planner[A-Za-z]*|sourceDerivedMaterial)(?:\.test)?\.js$/,
});
const runSet = buildRunSet(comparisonFiles.map((file) => fs.readFileSync(file, "utf8")));

/**
 * The strings in which a real manual passage would arrive: what retrieval
 * returned, and what the model quoted from it. The plan text, checklist, and
 * handoff notes are the app's own template prose and legitimately repeat the
 * repository's source, so they are not read as manual text.
 */
function manualShapedStrings(record) {
  const strings = [];

  for (const retrieval of record.run.retrievals) {
    for (const chunk of retrieval.results ?? []) {
      strings.push(chunk.chunkText, chunk.documentTitle, chunk.originalFilename);
    }
  }
  for (const finalizer of record.run.finalizers) {
    const claims = Array.isArray(finalizer.arguments?.claims) ? finalizer.arguments.claims : [];
    for (const claim of claims) {
      strings.push(claim.claim, claim.evidenceQuote);
    }
  }
  return strings.filter((value) => typeof value === "string");
}

function scanCapture(text, pool) {
  const parsed = parsePlannerCaptureText(text);
  const findings = { provenance: findProvenanceMarkers(text), sharedRuns: [], notInvented: [] };

  for (const record of parsed.records) {
    for (const string of manualShapedStrings(record)) {
      findings.sharedRuns.push(...findSharedRuns(string, pool));
    }
    for (const retrieval of record.run.retrievals) {
      for (const chunk of retrieval.results ?? []) {
        if (chunk.origin !== "invented" || !/Synthetic Fixture/.test(chunk.documentTitle ?? "")) {
          findings.notInvented.push(`${chunk.documentTitle} p${chunk.pageNumber}`);
        }
      }
    }
  }
  return findings;
}

test("the check has real material to compare against", () => {
  assert.ok(comparisonFiles.length >= 50, `found ${comparisonFiles.length} files to compare against`);
  assert.ok(runSet.size > 5000, `only ${runSet.size} prose runs to compare against`);
  assert.equal(
    comparisonFiles.some((file) => /planner(?:Capture|Replay|SyntheticCapture)[A-Za-z.]*\.js$/.test(file)),
    false,
    "the files under check do not vouch for themselves"
  );
});

test("the committed capture carries no vendor marker and shares no verbatim run with a file that quotes the manuals", () => {
  const findings = scanCapture(fixtureText(), runSet);

  assert.deepEqual(findings.provenance, [], "the vendor's name or a document-title date tag");
  assert.deepEqual(findings.sharedRuns, [], "an eight-word prose run shared with a source-bearing file");
  assert.deepEqual(findings.notInvented, [], "every retrieved chunk is declared invented and titled as a fixture");
});

test("the scan discriminates: a planted passage, a vendor marker, and a real-looking chunk are all caught", () => {
  const passage = "alpha bravo charlie delta echo foxtrot golf hotel india juliet";
  const pool = buildRunSet([passage]);
  const parsed = fixture();
  const planted = structuredClone(parsed.records[0]);
  planted.run.retrievals[0].results[0].chunkText = `Before ${passage} after`;
  planted.run.retrievals[0].results[0].origin = "manual";
  planted.run.retrievals[0].results[0].documentTitle = "Engine Repair [05 2009] ALLDATA";

  const text = `${JSON.stringify(parsed.header)}\n${JSON.stringify(planted)}\n`;
  const findings = scanCapture(text, pool);

  assert.equal(findings.sharedRuns.length >= 1, true, "the planted passage");
  assert.equal(findings.provenance.length, 2, "the vendor name and the date tag");
  assert.equal(findings.notInvented.length, 1, "the chunk that does not declare itself invented");
  assert.deepEqual(scanCapture(fixtureText(), pool), { provenance: [], sharedRuns: [], notInvented: [] });
});

// ---- A capture bug fails the capture ------------------------------------------------

test("a run that disagrees with its own re-derivation is refused, not written", async () => {
  const [first] = await recordSyntheticRuns(agent());

  assert.doesNotThrow(() => buildPlannerCaptureRecord(first), "an untouched run is written");

  const tampered = structuredClone(first);
  tampered.outputs.text = `${tampered.outputs.text}\nan extra line the verifier never wrote`;
  assert.throws(
    () => buildPlannerCaptureRecord(tampered),
    (error) => error instanceof PlannerCaptureMismatch && error.problems.some((problem) => /plan text/.test(problem))
  );

  // A recorder that lost the retrieval would leave claims citing nothing: the
  // re-derived plan could no longer be the plan the run produced.
  const lostRetrieval = structuredClone(first);
  lostRetrieval.retrievals = lostRetrieval.retrievals.map((retrieval) => ({ ...retrieval, results: [] }));
  assert.throws(() => buildPlannerCaptureRecord(lostRetrieval), PlannerCaptureMismatch);
});
