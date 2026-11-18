import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

// Planner eval Phase 3 (docs/planner-eval-spec.md, section 10): the capture
// FORMAT. This file opens no database and calls no agent. The behavior that
// needs a real run (a recorded run re-derived and cross-checked, the committed
// fixture) is in plannerCaptureFixture.test.js.
//
// The scratch paths come first anyway: plannerCapture.js reaches repairTools.js,
// whose default retriever is a lazy import() of the code that opens the database.
// That import never runs here, but databaseIsolation.test.js follows it, so this
// suite isolates like every other one that can reach database.js.
const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-planner-capture-"));
process.env.DATABASE_FILE = path.join(scratchRoot, "capture.db");
process.env.UPLOADS_DIR = path.join(scratchRoot, "uploads");

const {
  PLANNER_CAPTURE_CONFIG_KEYS,
  PLANNER_CAPTURE_FORMAT,
  PLANNER_CAPTURE_VERSION,
  buildPlannerCaptureHeader,
  buildPlannerCaptureRecord,
  hashInstructions,
  parsePlannerCaptureText,
  serializePlannerCapture,
} = await import("../src/evals/plannerCapture.js");

after(() => {
  fs.rmSync(scratchRoot, { recursive: true, force: true });
});

const HASH = "a".repeat(64);

const config = () => ({
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
});

const header = (overrides = {}) =>
  buildPlannerCaptureHeader({
    capturedAt: "2026-11-17T00:00:00.000Z",
    revision: "synthetic",
    dirty: false,
    config: config(),
    instructionsHash: HASH,
    ...overrides,
  });

/** A run that never reached a plan: the provider failed on turn 1. */
const failedRun = () => ({
  scenarioId: "synthetic-failed",
  repeat: 1,
  request: { brief: "Replace the spark plugs.", skillLevel: "beginner", availableTools: "", availableParts: "", constraints: "" },
  tasks: [{ id: 1, title: "Replace the spark plugs", system: "engine", difficulty: "beginner", safetyCritical: false }],
  modelSawTasks: true,
  turns: [{ turn: 1, streamCompleted: false, frameCount: 0, calls: [] }],
  retrievals: [],
  finalizers: [],
  outcome: { status: "error", code: null, reason: null, evidenceStatus: null },
  providerErrors: [{ turn: 1, httpStatus: 500, kind: "http", code: null, reason: null, name: "ScriptedProviderError" }],
  outputs: null,
});

const toText = (lines) => `${lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n")}\n`;

// ---- Hash -----------------------------------------------------------------------

test("hashInstructions is sha256 of the text as UTF-8, as lowercase hex", () => {
  // The published SHA-256 test vector for "abc".
  assert.equal(hashInstructions("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(hashInstructions("abc"), hashInstructions("abc"));
  assert.notEqual(hashInstructions("abc"), hashInstructions("abd"));
  assert.throws(() => hashInstructions(undefined), /instruction text/);
});

// ---- Header ---------------------------------------------------------------------

test("the header names the format, its own version, and the code and settings that produced a run", () => {
  const built = header();

  assert.equal(built.type, "header");
  assert.equal(built.format, "corolla-fix-helper/planner-capture");
  assert.equal(built.format, PLANNER_CAPTURE_FORMAT);
  assert.equal(built.version, PLANNER_CAPTURE_VERSION);
  assert.equal(built.revision, "synthetic");
  assert.equal(built.dirty, false);
  assert.equal(built.instructionsHash, HASH);
  assert.deepEqual(Object.keys(built.config).sort(), [...PLANNER_CAPTURE_CONFIG_KEYS].sort());
  assert.equal(PLANNER_CAPTURE_CONFIG_KEYS.length, 12);

  // Not known until the paid tool exists: present and null, never missing.
  for (const key of ["scenarioSetVersion", "repeats", "vehicleProfile", "corpus", "limits"]) {
    assert.equal(built[key], null, key);
  }
});

test("a header cannot be built without the facts that make a capture comparable", () => {
  const cases = [
    [{ revision: "" }, /revision/],
    [{ revision: null }, /revision/],
    [{ dirty: "no" }, /dirty/],
    [{ dirty: undefined }, /dirty/],
    [{ instructionsHash: "abc" }, /instructionsHash/],
    [{ config: null }, /config/],
    [{ config: { ...config(), rerankEnabled: undefined } }, /rerankEnabled/],
    [{ capturedAt: 12 }, /capturedAt/],
  ];

  for (const [overrides, pattern] of cases) {
    assert.throws(() => header(overrides), pattern, JSON.stringify(overrides));
  }

  // A key left out of the config (as opposed to set to null) is refused by name.
  const partial = config();
  delete partial.rerankEnabled;
  assert.throws(() => header({ config: partial }), /rerankEnabled/);
});

// ---- Serialize and parse -------------------------------------------------------------

test("a built record wraps the recorder's run, and a failed run has nothing to re-derive", () => {
  const run = failedRun();
  const record = buildPlannerCaptureRecord(run);

  assert.deepEqual(Object.keys(record), ["type", "run", "captured"]);
  assert.equal(record.type, "planner_run");
  assert.deepEqual(record.run, run, "the run is carried verbatim");
  assert.deepEqual(record.captured, { decisive: null, finalizers: [], readinessAcknowledged: null });
});

test("a capture round-trips: serialize, then parse, gives back every line", () => {
  const first = buildPlannerCaptureRecord(failedRun());
  const second = buildPlannerCaptureRecord({ ...failedRun(), scenarioId: "synthetic-failed-2", repeat: 2 });
  const text = serializePlannerCapture({ header: header(), records: [first, second] });

  assert.ok(text.endsWith("\n"));
  assert.equal(text.trimEnd().split("\n").length, 3, "one header line and one line per record");

  const parsed = parsePlannerCaptureText(text);

  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.header, JSON.parse(JSON.stringify(header())));
  assert.deepEqual(
    parsed.records.map(({ line, ...rest }) => [line, rest]),
    [
      [2, JSON.parse(JSON.stringify(first))],
      [3, JSON.parse(JSON.stringify(second))],
    ]
  );
});

test("a header with no records is a readable, empty capture", () => {
  const parsed = parsePlannerCaptureText(serializePlannerCapture({ header: header(), records: [] }));

  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.records.length, 0);
});

// ---- Fail closed ---------------------------------------------------------------------

test("the first line must be a matching header, or nothing is read", () => {
  const record = buildPlannerCaptureRecord(failedRun());

  const noHeader = parsePlannerCaptureText(toText([record]));
  assert.equal(noHeader.records.length, 0);
  assert.equal(noHeader.header, null);
  assert.match(noHeader.errors[0].message, /first line must be a corolla-fix-helper\/planner-capture header/);
  assert.equal(noHeader.errors[0].line, 1);

  // Ask's captures share the .jsonl extension; one must never be read as a planner capture.
  const askCapture = parsePlannerCaptureText(
    toText([{ type: "header", format: "corolla-fix-helper/answer-capture", version: 1 }, record])
  );
  assert.equal(askCapture.records.length, 0);
  assert.match(askCapture.errors[0].message, /planner-capture header/);

  const future = parsePlannerCaptureText(toText([{ ...header(), version: 2 }, record]));
  assert.equal(future.records.length, 0);
  assert.match(future.errors[0].message, /version 2 is not supported/);

  assert.match(parsePlannerCaptureText("\n \n").errors[0].message, /empty/);
  assert.equal(parsePlannerCaptureText("not json\n").errors[0].line, 1);
});

test("a header missing what makes a capture comparable is refused, naming the field", () => {
  for (const [field, pattern] of [
    ["revision", /revision/],
    ["dirty", /dirty/],
    ["config", /config/],
    ["instructionsHash", /instructionsHash/],
    ["capturedAt", /capturedAt/],
  ]) {
    const broken = { ...header() };
    delete broken[field];
    const parsed = parsePlannerCaptureText(toText([broken]));

    assert.equal(parsed.header, null, field);
    assert.equal(parsed.errors[0].line, 1, field);
    assert.match(parsed.errors[0].message, pattern, field);
  }

  const noRerank = header();
  delete noRerank.config.rerankEnabled;
  assert.match(parsePlannerCaptureText(toText([noRerank])).errors[0].message, /rerankEnabled/);
});

test("every unreadable record is reported with its line number and never skipped", () => {
  const good = buildPlannerCaptureRecord(failedRun());
  const noRun = { type: "planner_run", captured: good.captured };
  const noCaptured = { type: "planner_run", run: good.run };
  const badRetrieval = structuredClone(good);
  badRetrieval.run.retrievals = [{ turn: 1, results: [{ documentId: 1 }] }];
  const badFinalizer = structuredClone(good);
  badFinalizer.captured.finalizers = [{ turn: 1, valid: "yes" }];
  const badVerdict = structuredClone(good);
  badVerdict.captured.finalizers = [
    { turn: 1, callOrdinal: 0, valid: true, errors: [], verdicts: [{ claimIndex: -1, verdict: "accepted" }] },
  ];
  const badReadiness = structuredClone(good);
  badReadiness.captured.readinessAcknowledged = { level: 3 };

  const text = [
    JSON.stringify(header()), // 1
    "", // 2 (blank lines are skipped but still counted)
    JSON.stringify(good), // 3 readable
    "this is not json", // 4
    JSON.stringify({ type: "mystery" }), // 5
    JSON.stringify(header()), // 6 a second header
    JSON.stringify(noRun), // 7
    JSON.stringify(noCaptured), // 8
    JSON.stringify(badRetrieval), // 9
    JSON.stringify(badFinalizer), // 10
    JSON.stringify(badVerdict), // 11
    JSON.stringify(badReadiness), // 12
    JSON.stringify(good), // 13 readable again
  ].join("\n");

  const parsed = parsePlannerCaptureText(text);

  assert.deepEqual(
    parsed.records.map((record) => record.line),
    [3, 13],
    "the readable records are kept, with their own line numbers"
  );
  assert.deepEqual(
    parsed.errors.map((error) => error.line),
    [4, 5, 6, 7, 8, 9, 10, 11, 12],
    "every unreadable line is reported, in order"
  );

  const byLine = Object.fromEntries(parsed.errors.map((error) => [error.line, error.message]));
  assert.equal(byLine[4], "not valid JSON");
  assert.equal(byLine[5], 'unsupported record type "mystery"');
  assert.match(byLine[6], /more than one header/);
  assert.match(byLine[7], /run is missing/);
  assert.match(byLine[8], /captured is missing/);
  assert.match(byLine[9], /chunkText/);
  assert.match(byLine[10], /captured\.finalizers/);
  assert.match(byLine[11], /captured\.finalizers/);
  assert.match(byLine[12], /readinessAcknowledged/);
});
