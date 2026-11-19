import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

// Planner eval Phase 4, Tier B: the read-only corpus survey, run over INVENTED
// libraries built in a temp folder. The survey only ever opens its database
// with { readOnly: true }, so a write it attempted would throw; the tests below
// also prove the file is byte-identical afterwards and that a database missing
// the migrations table is not migrated.
//
// Every invented chunk and title carries the made-up word QUILLWORT, so a test
// can prove no manual text reaches the console: the survey prints aggregates
// only, and the per-chunk detail goes to the gitignored JSON and CSV.

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-planner-survey-"));
const templateFile = path.join(tempRoot, "template.db");

process.env.DATABASE_FILE = templateFile;
process.env.UPLOADS_DIR = path.join(tempRoot, "unused-uploads");

const { db } = await import("../src/database.js");
const { initializeDatabase } = await import("../src/initDatabase.js");
const { retrieveKeywordChunks } = await import("../src/services/chunkRetrievalService.js");
const { getDocumentContentGroupKey } = await import("../src/services/documentContentIdentity.js");
const { EVIDENCE_CONTEXT_CHAR_LIMIT, searchRepairDocs, createSourceRegistry } = await import(
  "../src/services/agent/repairTools.js"
);
const survey = await import("../src/scripts/surveyPlannerCorpus.js");
const SCRIPT = path.join(serverRoot, "src", "scripts", "surveyPlannerCorpus.js");

const SENTINEL = "QUILLWORT";
const S1_BRIEF = "Change the engine oil and replace the oil filter.";

after(() => {
  db.close();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

initializeDatabase();
const vehicleId = db.prepare("SELECT id FROM vehicles ORDER BY id LIMIT 1").get().id;

const filler = (words) => Array.from({ length: words }, (_, index) => `filler${index % 10}`).join(" ");

// Long enough that the figure starts beyond the 1,500-character evidence cap.
const LONG_PREFIX = `${SENTINEL} bulletin. ${filler(220)}`;
// Raw length > 1,500, but whitespace runs collapse it below the cap.
const SPACED_PREFIX = `${SENTINEL}${"      ".repeat(260)}spaced sheet.`;

// Worded apart from the planner fixtures on purpose: the R5 scan compares those
// fixtures with every server file, so a shared eight-word run here would fail it.
const SPARK_TEXT =
  `${SENTINEL} ignition card. Fresh plug: electrode gap 1.0 to 1.1 mm (0.0394 to 0.0433 in.). ` +
  "Worn plug limit, electrode gap 1.3 mm (0.0512 in.).";

const DOCUMENTS = [
  {
    key: "short",
    title: `${SENTINEL} lubrication service sheet`,
    text: `${SENTINEL} sheet. Remove the oil drain plug and gasket. Install the oil drain plug with a new gasket. Torque: 37 N*m (377 kgf*cm, 27 ft.*lbf)`,
    page: 1,
  },
  {
    key: "long",
    title: `${SENTINEL} long lubrication bulletin`,
    text: `${LONG_PREFIX} Install the oil drain plug. Torque: 37 N*m (377 kgf*cm, 27 ft.*lbf)`,
    page: 2,
  },
  {
    key: "spaced",
    title: `${SENTINEL} spaced lubrication sheet`,
    text: `${SPACED_PREFIX} Install the oil drain plug. Torque: 37 N*m (27 ft.*lbf)`,
    page: 3,
  },
  // Two documents holding the same text: one logical source for diversity.
  { key: "sparkA", title: `${SENTINEL} ignition data A`, text: SPARK_TEXT, page: 1 },
  { key: "sparkB", title: `${SENTINEL} ignition data B`, text: SPARK_TEXT, page: 1 },
  {
    key: "beltOk",
    title: `${SENTINEL} accessory drive notes`,
    text: `${SENTINEL} notes. Replace the V-ribbed drive belt when cracks appear. Inspect the belt tension.`,
    page: 4,
  },
];

const insertDocument = db.prepare(`
  INSERT INTO documents
    (vehicle_id, title, original_filename, stored_filename, system, document_type, extraction_status, extracted_text)
  VALUES (?, ?, ?, ?, 'Engine', 'Repair Manual', ?, ?)
`);
const insertChunk = db.prepare(`
  INSERT INTO document_chunks (document_id, page_number, chunk_index, chunk_text)
  VALUES (?, ?, 0, ?)
`);
const ids = {};

for (const document of DOCUMENTS) {
  const id = Number(
    insertDocument.run(
      vehicleId,
      document.title,
      `${document.key}.pdf`,
      `${document.key}-stored.pdf`,
      document.key === "spaced" ? "completed_with_ocr" : "completed",
      document.text
    ).lastInsertRowid
  );
  ids[document.key] = id;
  insertChunk.run(id, document.page, document.text);
}

/** A VACUUM INTO copy of the template, optionally changed by `mutate`. */
function makeLibrary(name, mutate) {
  const databaseFile = path.join(tempRoot, `${name}.db`);
  db.exec(`VACUUM INTO '${databaseFile.replace(/'/g, "''")}'`);

  if (mutate) {
    const writable = new DatabaseSync(databaseFile);
    mutate(writable);
    writable.close();
  }
  return databaseFile;
}

const goodLibrary = makeLibrary("good");
const beltLibrary = makeLibrary("belt", (writable) => {
  const id = Number(
    writable
      .prepare(
        `INSERT INTO documents (vehicle_id, title, original_filename, stored_filename, system, document_type, extraction_status, extracted_text)
         VALUES (?, ?, 'belt.pdf', 'belt.pdf', 'Engine', 'Repair Manual', 'completed', ?)`
      )
      .run(vehicleId, `${SENTINEL} other engine`, `${SENTINEL} Timing belt replacement interval.`).lastInsertRowid
  );
  writable
    .prepare("INSERT INTO document_chunks (document_id, page_number, chunk_index, chunk_text) VALUES (?, 1, 0, ?)")
    .run(id, `${SENTINEL} Remove the timing belt cover and renew the timing belt.`);
});

const sha256 = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

function openReadOnly(file) {
  return new DatabaseSync(file, { readOnly: true });
}

function buildSurvey(file, options = {}) {
  const readOnly = openReadOnly(file);
  try {
    return survey.buildPlannerCorpusSurvey(readOnly, { maxChunksPerSource: 3, ...options });
  } finally {
    readOnly.close();
  }
}

/** Run the CLI with console captured and `fetch` made to fail loudly. */
async function runCliCaptured(argv, overrides) {
  const lines = [];
  const errors = [];
  const originalLog = console.log;
  const originalError = console.error;
  const originalFetch = globalThis.fetch;
  const originalExitCode = process.exitCode;
  let fetchCalls = 0;

  console.log = (...parts) => lines.push(parts.join(" "));
  console.error = (...parts) => errors.push(parts.join(" "));
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("network is disabled in this test");
  };

  try {
    await survey.runCli(argv, overrides);
    return { stdout: lines.join("\n"), stderr: errors.join("\n"), exitCode: process.exitCode, fetchCalls };
  } finally {
    console.log = originalLog;
    console.error = originalError;
    globalThis.fetch = originalFetch;
    process.exitCode = originalExitCode;
  }
}

const factOf = (report, factId) => report.facts.find((entry) => entry.factId === factId);
const candidateFor = (fact, key) => fact.candidates.find((entry) => entry.documentId === ids[key]);

// ---- read-only ----------------------------------------------------------------

test("the survey leaves the database byte-identical and creates no journal files", async () => {
  const before = sha256(goodLibrary);
  const siblingsBefore = fs.readdirSync(tempRoot).sort();
  const outputDir = path.join(tempRoot, "out-readonly");
  const result = await runCliCaptured(["--output-dir", outputDir], { databaseFile: goodLibrary });

  assert.equal(result.exitCode, undefined, result.stderr);
  assert.equal(sha256(goodLibrary), before);
  assert.deepEqual(
    fs.readdirSync(tempRoot).filter((name) => name !== "out-readonly").sort(),
    siblingsBefore,
    "no -wal, -shm, or other file appeared beside the database"
  );
  assert.equal(result.fetchCalls, 0, "the survey makes no network call");
});

test("a database without the migrations table is not migrated", async () => {
  const legacy = makeLibrary("legacy", (writable) => writable.exec("DROP TABLE schema_migrations"));
  const before = sha256(legacy);
  const result = await runCliCaptured(["--output-dir", path.join(tempRoot, "out-legacy")], { databaseFile: legacy });

  assert.equal(result.exitCode, undefined, result.stderr);
  assert.equal(sha256(legacy), before);
  const check = openReadOnly(legacy);
  const table = check.prepare("SELECT name FROM sqlite_master WHERE name = 'schema_migrations'").get();
  check.close();
  assert.equal(table, undefined, "the survey created no migrations table");
});

test("a missing database is an error and is never created", async () => {
  const missing = path.join(tempRoot, "does-not-exist.db");
  const result = await runCliCaptured([], { databaseFile: missing });

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /not found/i);
  assert.equal(fs.existsSync(missing), false);
});

test("with no database named, the CLI refuses rather than guessing the live one", async () => {
  const saved = process.env.DATABASE_FILE;
  delete process.env.DATABASE_FILE;

  try {
    const result = await runCliCaptured([], {});
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /DATABASE_FILE/);
  } finally {
    process.env.DATABASE_FILE = saved;
  }
});

test("the survey's import graph reaches neither config.js nor database.js", () => {
  const src = path.join(serverRoot, "src");
  const forbidden = new Set([path.join(src, "config.js"), path.join(src, "database.js")]);
  const closure = staticImportClosure(SCRIPT);

  assert.ok(closure.size > 3, "the walk found the survey's imports");
  for (const file of closure) {
    assert.equal(forbidden.has(file), false, `the survey reaches ${path.relative(serverRoot, file)}`);
  }
  // The check can fail: the retrieval service does reach database.js.
  assert.ok(staticImportClosure(path.join(src, "services", "chunkRetrievalService.js")).has(path.join(src, "database.js")));
});

// ---- the 1,500-character rule ------------------------------------------------

test("the evidence window is the planner's own: 1,500 characters of whitespace-collapsed text", async () => {
  assert.equal(survey.EVIDENCE_WINDOW_CHARS, EVIDENCE_CONTEXT_CHAR_LIMIT);
  assert.equal(EVIDENCE_CONTEXT_CHAR_LIMIT, 1500);

  for (const text of [DOCUMENTS[1].text, DOCUMENTS[2].text, `  short  text \n\n `, ""]) {
    const sources = createSourceRegistry();
    await searchRepairDocs(
      { query: "anything", taskId: 1 },
      { retrieve: async () => [{ chunkId: 1, documentId: 1, pageNumber: 1, chunkIndex: 0, chunkText: text }], sources }
    );
    const shown = sources.list()[0]?.evidenceText ?? "";
    assert.equal(survey.evidenceWindow(text), shown, "the survey caps text exactly as the planner's search tool does");
  }
});

test("a figure inside the window is visible; one beyond it is in the chunk but not shown", () => {
  const report = buildSurvey(goodLibrary);
  const fact = factOf(report, "s1-drain-plug-torque");

  assert.ok(fact, "the S1 drain-plug fact was surveyed");
  const short = candidateFor(fact, "short");
  const long = candidateFor(fact, "long");
  const spaced = candidateFor(fact, "spaced");

  assert.equal(short.inChunk, true);
  assert.equal(short.inEvidenceWindow, true);
  assert.equal(long.inChunk, true);
  assert.equal(long.inEvidenceWindow, false, "the figure starts past character 1,500");
  assert.ok(long.chunkLength > 1500);
  assert.ok(spaced.rawChunkLength > 1500, "the raw text is long");
  assert.equal(spaced.inEvidenceWindow, true, "but collapsed whitespace brings the figure inside the window");

  assert.equal(fact.summary.candidateChunks, 3);
  assert.equal(fact.summary.visibleInEvidenceWindow, 2);
  assert.equal(fact.summary.beyondEvidenceWindowOnly, 1);
});

test("each candidate names its document, page, chunk index, extraction status, and content group", () => {
  const report = buildSurvey(goodLibrary);
  const spaced = candidateFor(factOf(report, "s1-drain-plug-torque"), "spaced");

  assert.equal(spaced.pageNumber, 3);
  assert.equal(spaced.chunkIndex, 0);
  assert.equal(spaced.extractionStatus, "completed_with_ocr");
  assert.equal(spaced.contentGroupKey, getDocumentContentGroupKey(ids.spaced));
  assert.equal(spaced.storedFilename, "spaced-stored.pdf");

  const gap = factOf(report, "s2-new-plug-gap");
  const a = candidateFor(gap, "sparkA");
  const b = candidateFor(gap, "sparkB");
  assert.equal(a.contentGroupKey, b.contentGroupKey, "identical text is one content group");
  assert.equal(a.contentGroupKey, getDocumentContentGroupKey(ids.sparkA));
  assert.equal(gap.summary.distinctContentGroups, 1);
  assert.equal(gap.summary.distinctDocuments, 2);
  assert.deepEqual(a.decoysInChunk, ["1.3 mm", "0.0512 in"], "the used-plug decoy sits in the same chunk");
});

test("the chunk-length distribution counts whitespace-collapsed lengths against 1,500", () => {
  const report = buildSurvey(goodLibrary);
  const lengths = DOCUMENTS.map((document) => survey.evidenceLength(document.text));
  const over = lengths.filter((length) => length > 1500).length;

  assert.equal(report.chunkLengths.totalChunks, DOCUMENTS.length);
  assert.equal(report.chunkLengths.overEvidenceWindow, over);
  assert.equal(over, 1, "only the long bulletin is over; the spaced sheet collapses under");
  assert.equal(report.chunkLengths.max, Math.max(...lengths));
});

// ---- keyword golden-query probes ------------------------------------------------

test("keyword ranking matches the production keyword retriever, diversity included", () => {
  const readOnly = openReadOnly(goodLibrary);

  try {
    const corpus = survey.loadCorpus(readOnly);
    for (const query of [S1_BRIEF, "oil drain plug torque", "spark plug electrode gap", "drive belt"]) {
      const expected = retrieveKeywordChunks(query, { limit: 8, maxChunksPerSource: 3 }).map((chunk) => chunk.chunkId);
      const actual = survey.rankKeywordChunks(corpus, query, { limit: 8, maxChunksPerSource: 3 }).map((chunk) => chunk.chunkId);
      assert.deepEqual(actual, expected, query);
    }
  } finally {
    readOnly.close();
  }
});

test("a canonical query that reaches a visible copy of the fact settles goldenQueryRetrieves", () => {
  const report = buildSurvey(goodLibrary);
  const fact = factOf(report, "s1-drain-plug-torque");
  const canonical = fact.probes.find((probe) => probe.query === "oil drain plug torque");

  assert.ok(canonical.firstVisibleRank >= 1 && canonical.firstVisibleRank <= 8);
  assert.ok(fact.probes.some((probe) => probe.isBrief && probe.query === S1_BRIEF), "the brief is probed too");
  assert.equal(fact.suggested.goldenQueryRetrieves, true);
  assert.equal(fact.suggested.corpusSupport, "full");
});

test("goldenQueryRetrieves is left unknown when no chunk shows the fact inside the window", () => {
  const onlyLong = makeLibrary("only-long", (writable) => {
    writable.exec(`DELETE FROM document_chunks WHERE document_id IN (${ids.short}, ${ids.spaced})`);
  });
  const fact = factOf(buildSurvey(onlyLong), "s1-drain-plug-torque");

  assert.equal(fact.summary.visibleInEvidenceWindow, 0);
  assert.equal(fact.suggested.goldenQueryRetrieves, null);
  assert.match(fact.suggested.reason, /window/);
});

// ---- the S8 precondition --------------------------------------------------------

test("S8: a library with drive belts only keeps the timing-belt precondition", async () => {
  const report = buildSurvey(goodLibrary);

  assert.equal(report.s8Precondition.holds, true);
  assert.equal(report.s8Precondition.matchingChunks, 0);
  assert.ok(report.s8Precondition.chunksMentioningBelt >= 1, "a belt chunk was scanned and correctly ignored");

  const result = await runCliCaptured(["--output-dir", path.join(tempRoot, "out-s8-ok")], { databaseFile: goodLibrary });
  assert.match(result.stdout, /S8 precondition: HOLDS/);
});

test("S8: a timing-belt chunk breaks the precondition and the survey says so", async () => {
  const report = buildSurvey(beltLibrary);

  assert.equal(report.s8Precondition.holds, false);
  assert.equal(report.s8Precondition.matchingChunks, 1);
  assert.deepEqual(report.s8Precondition.byRule, { timing_belt_phrase: 1 });

  const result = await runCliCaptured(["--output-dir", path.join(tempRoot, "out-s8-bad")], { databaseFile: beltLibrary });
  assert.match(result.stdout, /S8 precondition: BROKEN/);
  assert.equal(result.exitCode, undefined, "a broken precondition is a finding, not a crash");
});

// ---- output -------------------------------------------------------------------

test("the console prints aggregates only; detail goes to JSON and CSV", async () => {
  const outputDir = path.join(tempRoot, "out-aggregate");
  const result = await runCliCaptured(["--output-dir", outputDir], { databaseFile: goodLibrary });

  assert.equal(result.exitCode, undefined, result.stderr);
  assert.ok(result.stdout.includes("s1-drain-plug-torque"));
  assert.equal(result.stdout.includes(SENTINEL), false, "no title or chunk text reaches the console");
  assert.equal(result.stdout.includes("stored.pdf"), false, "nor a stored file name");

  const json = JSON.parse(fs.readFileSync(path.join(outputDir, "planner-corpus-survey.json"), "utf8"));
  const csv = fs.readFileSync(path.join(outputDir, "planner-corpus-survey.csv"), "utf8");
  assert.equal(json.readOnly, true);
  assert.equal(json.retrievalMode, "keyword");
  assert.ok(csv.split("\n")[0].includes("contentGroupKey"));
  assert.ok(csv.includes(`${SENTINEL} lubrication service sheet`), "the CSV names the document for the owner");
});

test("an extra probe file surveys draft candidates without committing them", async () => {
  const probeFile = path.join(tempRoot, "probes.json");
  fs.writeFileSync(
    probeFile,
    JSON.stringify({
      probes: [
        {
          scenarioId: "S1-oil-and-filter",
          id: "draft-gasket",
          concept: "fit a new drain plug gasket",
          queries: ["drain plug gasket"],
          allOf: ["\\bnew gasket\\b", "\\bdrain plug\\b"],
        },
        {
          scenarioId: "S1-oil-and-filter",
          id: "draft-torque-kgf",
          concept: "drain plug torque in kgf-cm",
          queries: ["drain plug torque"],
          allOf: ["\\bdrain plug\\b"],
          figures: [{ kind: "value", value: 377, units: ["kgf*cm", "kgf-cm"] }],
        },
      ],
    })
  );

  const readOnly = openReadOnly(goodLibrary);
  const probes = survey.loadProbeFile(probeFile);
  const report = survey.buildPlannerCorpusSurvey(readOnly, { maxChunksPerSource: 3, extraProbes: probes });
  readOnly.close();

  const gasket = factOf(report, "draft-gasket");
  assert.equal(gasket.source, "probe-file");
  assert.deepEqual(gasket.candidates.map((entry) => entry.documentId), [ids.short]);
  assert.equal(factOf(report, "draft-torque-kgf").summary.candidateChunks, 2, "the spaced sheet prints no kgf figure");

  fs.writeFileSync(probeFile, JSON.stringify({ probes: [{ id: "x" }] }));
  assert.throws(() => survey.loadProbeFile(probeFile), /scenarioId/);
});

test("parseArguments reads the output folder, probe file, and per-source cap", () => {
  assert.deepEqual(survey.parseArguments(["--output-dir", "out", "--probes", "p.json", "--max-per-source", "0"]), {
    outputDir: "out",
    probesFile: "p.json",
    maxChunksPerSource: 0,
  });
  assert.equal(survey.parseArguments([]).maxChunksPerSource, 3);
});

/**
 * Every file reachable from `entry` through STATIC imports (the same walk as
 * plannerReplay.test.js).
 */
function staticImportClosure(entry) {
  const seen = new Set();
  const pending = [entry];
  const staticImport = /^\s*(?:import|export)\s[^;]*?\sfrom\s+["']([^"']+)["']|^\s*import\s+["']([^"']+)["']/gm;

  while (pending.length > 0) {
    const file = pending.pop();

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
