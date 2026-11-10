import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { MINI_CORPORA, createKeywordRetriever } from "../src/evals/fixtures/plannerMiniCorpora.js";
import { getPlannerScenario } from "../src/evals/plannerScenarios.js";
import { extractSpecNumbers } from "../src/services/askEvidenceContract.js";
import {
  buildRunSet,
  discoverComparisonFiles,
  findProvenanceMarkers,
  findSharedRuns,
  findSourceDerivedMaterial,
} from "./fixtures/sourceDerivedMaterial.js";

// The invented corpora the scripted planner runs retrieve from. They are the
// only manual-shaped text this evaluation commits, so they are held to two
// rules: they are invented (checked for source-derived material, below), and
// they contain exactly the traps their scenario needs (pinned, below).

const testDir = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(testDir, "..");

const corpusText = (chunk) => [chunk.chunkText, chunk.documentTitle, chunk.originalFilename];
const chunksOf = (key) => MINI_CORPORA[key];

// ---- Shape ----------------------------------------------------------------------

test("the corpora are exactly the four the scripted runs use", () => {
  assert.deepEqual(Object.keys(MINI_CORPORA), ["S1", "S2", "S8-premise-holds", "S8-premise-violated"]);
});

test("every chunk has the fields the planner's source registry reads, and says it is invented", () => {
  for (const [key, chunks] of Object.entries(MINI_CORPORA)) {
    const identities = new Set();

    for (const chunk of chunks) {
      const where = `${key} ${chunk.documentTitle} p${chunk.pageNumber}`;

      assert.ok(Number.isInteger(chunk.documentId), where);
      assert.ok(Number.isInteger(chunk.pageNumber) && chunk.pageNumber >= 1, where);
      assert.ok(Number.isInteger(chunk.chunkIndex) && chunk.chunkIndex >= 0, where);
      assert.match(chunk.documentTitle, /\S/, where);
      assert.match(chunk.originalFilename, /\.pdf$/, where);
      assert.match(chunk.chunkText, /\S/, where);
      assert.equal(chunk.origin, "invented", `${where}: every fixture chunk is declared invented`);
      assert.match(chunk.documentTitle, /Synthetic Fixture/, `${where}: a title that cannot be mistaken for a real document`);

      const identity = `${chunk.documentId}-${chunk.pageNumber}-${chunk.chunkIndex}`;
      assert.equal(identities.has(identity), false, `${where}: duplicate chunk identity`);
      identities.add(identity);
    }
  }
});

// ---- Not source-derived (owner condition: real source material only) -------------

// Every server .js file, so a passage already quoted anywhere is covered without
// editing a list. The planner-eval files are excluded: they are the files being
// checked, and a corpus must never vouch for itself.
const comparisonFiles = discoverComparisonFiles([path.join(serverRoot, "src"), path.join(serverRoot, "test")], {
  exclude: /\/(?:planner[A-Za-z]*|sourceDerivedMaterial)(?:\.test)?\.js$/,
});
const runSet = buildRunSet(comparisonFiles.map((file) => fs.readFileSync(file, "utf8")));

test("the check has real material to compare against", () => {
  assert.ok(comparisonFiles.length >= 50, `found ${comparisonFiles.length} files to compare against`);
  assert.ok(runSet.size > 5000, `only ${runSet.size} prose runs to compare against`);
  assert.ok(
    comparisonFiles.some((file) => file.endsWith("answerQualityCases.js")),
    "the Ask eval cases quote real passages (without naming the vendor) and must be compared"
  );
  assert.equal(
    comparisonFiles.some((file) => /planner(?:MiniCorpora|Scenarios)\.js$/.test(file)),
    false,
    "the files under check do not vouch for themselves"
  );
});

test("no fixture chunk carries the manual vendor's marker or a document-title date tag", () => {
  for (const [key, chunks] of Object.entries(MINI_CORPORA)) {
    for (const chunk of chunks) {
      for (const text of corpusText(chunk)) {
        assert.deepEqual(findProvenanceMarkers(text), [], `${key} ${chunk.documentTitle}: ${text.slice(0, 60)}`);
      }
    }
  }
});

test("no fixture chunk shares a verbatim eight-word run with a file that quotes the manuals", () => {
  for (const [key, chunks] of Object.entries(MINI_CORPORA)) {
    for (const chunk of chunks) {
      for (const text of corpusText(chunk)) {
        assert.deepEqual(
          findSharedRuns(text, runSet),
          [],
          `${key} ${chunk.documentTitle} shares a run with a source-bearing file`
        );
      }
    }
  }
});

test("the check discriminates: provenance and copied runs are caught, vehicle metadata is not", () => {
  const quoted = "alpha bravo charlie delta echo foxtrot golf hotel india juliet";
  const runs = buildRunSet([quoted]);

  assert.deepEqual(findProvenanceMarkers("Oil change [12 2007 ] ALLDATA diy").length, 2);
  assert.equal(findProvenanceMarkers("see the [3 2009] tag").length, 1, "a bracketed month and year");
  assert.deepEqual(findProvenanceMarkers("2009 Toyota Corolla LE 1.8L, 2ZR-FE engine, plant TMMT"), []);
  assert.deepEqual(findProvenanceMarkers("A brief that names the Corolla and the 2AZ-FE"), []);

  assert.equal(findSharedRuns("one two alpha bravo charlie delta echo foxtrot golf hotel three", runs).length, 1);
  assert.deepEqual(findSharedRuns("alpha bravo charlie delta echo foxtrot golf", runs), [], "seven shared words are not eight");

  // Vehicle metadata passes even next to a copied run being caught.
  const verdict = findSourceDerivedMaterial("Toyota Corolla 2ZR-FE: alpha bravo charlie delta echo foxtrot golf hotel", runs);
  assert.deepEqual(verdict.provenance, []);
  assert.equal(verdict.sharedRuns.length, 1);
});

test("figures alone are not prose, but prose around the same figures is", () => {
  const row = "Electrode gap 1.0 to 1.1 mm (0.0394 to 0.0433 in) for a new plug";
  const runs = buildRunSet([row]);

  // The same printed figures in a different sentence share no PROSE run.
  assert.deepEqual(findSharedRuns("The result 1.0 to 1.1 mm (0.0394 to 0.0433 in) was recorded", runs), []);

  // Eight tokens of which six are words are prose, figures or not.
  const sentence = buildRunSet(["tighten the oil drain plug to 37 N·m then refill"]);
  assert.equal(findSharedRuns("Please tighten the oil drain plug to 37 N·m today", sentence).length >= 1, true);
});

test("vehicle metadata is legitimate outside corpus text: a scenario brief is not scanned", () => {
  const scenario = getPlannerScenario("S8-timing-belt");

  // The scenarios and the premise basis may name the vehicle and its engine; the
  // check is only ever pointed at corpus text.
  assert.match(JSON.stringify(scenario.desiredJobs.premise), /refuse-timing-belt-interval/);
  assert.deepEqual(findProvenanceMarkers("2009 Toyota Corolla LE 1.8L (2ZR-FE) repair brief"), []);
});

// ---- Each corpus holds the traps its scenario needs -----------------------------

const figureStrings = (text) => extractSpecNumbers(text).map((figure) => figure.raw);

test("S1 holds the right torque and another variant's wrong one, in separate chunks", () => {
  const [right, other, variant] = chunksOf("S1");

  assert.ok(figureStrings(right.chunkText).some((raw) => /^37\s*N/.test(raw)));
  assert.ok(figureStrings(right.chunkText).some((raw) => /^27\s*ft/.test(raw)));
  assert.ok(figureStrings(variant.chunkText).some((raw) => /^45\s*N/.test(raw)));
  assert.match(variant.chunkText, /oil drain plug/i, "the wrong figure names the same part, so the verifier can accept it");
  assert.doesNotMatch(other.chunkText, /\d/, "the filter-cap chunk carries no figure");
  assert.doesNotMatch(right.chunkText, /45/);
});

test("S2 holds the full table, and the split label with its bare unqualified value", () => {
  const [table, labelPage, valuePage] = chunksOf("S2");

  assert.ok(figureStrings(table.chunkText).includes("1.0 mm") && figureStrings(table.chunkText).includes("1.1 mm"));
  assert.match(table.chunkText, /maximum[^.]*used plug: 1\.3 mm/i, "the table qualifies the 1.3 mm figure");

  // The real hazard: a label ends one page, its value opens the next, and the
  // value there is printed with no qualifier above the new-plug range.
  assert.equal(labelPage.pageNumber + 1, valuePage.pageNumber);
  assert.equal(labelPage.documentId, valuePage.documentId);
  assert.match(labelPage.chunkText, /used spark plug:\s*$/i, "the label is cut at the page end");
  assert.match(valuePage.chunkText, /^Spark plug electrode gap 1\.3 mm/, "the value is bare, with no used/maximum");
  assert.match(valuePage.chunkText, /new spark plug: 1\.0 to 1\.1 mm/);
});

test("S8 premise-holds has a chain and a drive belt but no timing belt anywhere", () => {
  const subject = getPlannerScenario("S8-timing-belt").facts[0].fabrication.subject;
  const chunks = chunksOf("S8-premise-holds");

  assert.ok(chunks.length >= 2);
  assert.equal(chunks.filter((chunk) => subject.test(chunk.chunkText)).length, 0, "the premise (no timing belt) holds");
  assert.ok(chunks.some((chunk) => /timing chain/i.test(chunk.chunkText)));
  assert.ok(
    chunks.some((chunk) => /drive belt/i.test(chunk.chunkText) && /\d[\d,]*\s*miles/.test(chunk.chunkText)),
    "real drive-belt replacement text with a mileage sits beside the question, as in the manuals"
  );
});

test("S8 premise-violated differs by exactly one chunk, which breaks the premise on purpose", () => {
  const subject = getPlannerScenario("S8-timing-belt").facts[0].fabrication.subject;
  const holds = chunksOf("S8-premise-holds");
  const violated = chunksOf("S8-premise-violated");
  const extra = violated.filter((chunk) => !holds.some((kept) => kept.documentId === chunk.documentId));

  assert.equal(violated.length, holds.length + 1);
  assert.equal(extra.length, 1);
  assert.match(extra[0].purpose, /premise/i, "the chunk says why it exists");
  assert.ok(subject.test(extra[0].chunkText));
});

// ---- The keyword retriever -----------------------------------------------------

test("the keyword retriever ranks by overlap and breaks ties by corpus order", async () => {
  const retrieve = createKeywordRetriever([
    { documentId: 1, pageNumber: 1, chunkIndex: 0, documentTitle: "A", chunkText: "alpha beta" },
    { documentId: 2, pageNumber: 1, chunkIndex: 0, documentTitle: "B", chunkText: "alpha beta gamma" },
    { documentId: 3, pageNumber: 1, chunkIndex: 0, documentTitle: "C", chunkText: "alpha" },
  ]);

  const results = await retrieve("alpha beta gamma", { limit: 8 });

  assert.deepEqual(results.map((chunk) => chunk.documentId), [2, 1, 3]);
});

test("the keyword retriever honors the limit, returns nothing for no overlap, and is repeatable", async () => {
  const retrieve = createKeywordRetriever(chunksOf("S2"));

  assert.equal((await retrieve("spark plug electrode gap", { limit: 1 })).length, 1);
  assert.deepEqual(await retrieve("zzzz qqqq"), []);
  assert.deepEqual(await retrieve("spark plug electrode gap"), await retrieve("spark plug electrode gap"));
});

test("the keyword retriever hands back copies, so a consumer cannot corrupt the corpus", async () => {
  const chunks = chunksOf("S1");
  const retrieve = createKeywordRetriever(chunks);
  const before = chunks[0].chunkText;

  const [first] = await retrieve("oil drain plug torque");
  first.chunkText = "corrupted";
  first.extra = true;

  assert.equal(chunks[0].chunkText, before);
  assert.equal("extra" in chunks[0], false);
});

test("the keyword retriever tolerates missing options", async () => {
  const retrieve = createKeywordRetriever(chunksOf("S1"));

  assert.ok((await retrieve("oil drain plug")).length >= 1);
  assert.ok((await retrieve("oil drain plug", undefined)).length >= 1);
});
