import assert from "node:assert/strict";
import test from "node:test";

// Scoring for the blind applicability label check (N5 P1). Pure: the real
// labels and the manual text they point at stay in a gitignored folder.
import {
  candidateFigures,
  contextKey,
  dedupeByContext,
  locateFigure,
  scoreLabels,
} from "../src/scripts/checkApplicabilityLabels.js";

test("copies of one context collapse to a single row, so counts are distinct contexts", () => {
  const row = (id, before, figure, after) => ({ id, contextBefore: before, figure, contextAfter: after });
  const rows = [
    row("735:1", "x ".repeat(100) + "Front vehicle height at  curb, 2AZ-FE ", "96 mm", " (3.78 in.) rear wheel x"),
    row("740:1", "y ".repeat(100) + "Front vehicle  height at curb, 2AZ-FE ", "96 mm", " (3.78 in.)  rear wheel y"),
    row("109:2", "z Front Height 2ZR-FE ", "92 mm", " (3.62 in.) rear"),
  ];

  assert.equal(contextKey(rows[0]), contextKey(rows[1]), "whitespace and distant text do not split a context");
  assert.deepEqual(dedupeByContext(rows).map((kept) => kept.id), ["735:1", "109:2"]);
});

test("the account header's engine size is never sampled as a figure", () => {
  const page =
    "ALLDATA DIY article export 2009 Toyota Corolla L4-1.8L (2ZR-FE) Vehicle > Engine > Specs HINT: bolt 25 N*m, oil 4.2 L";

  assert.deepEqual(
    candidateFigures(page).map((match) => match[0]),
    ["25 N*m", "4.2 L"]
  );
  assert.equal(candidateFigures(page)[0].index, page.indexOf("25 N*m"), "offsets point into the real page");
});

test("a 2AZ-FE figure the tagger calls 'applies' is the failure that matters", () => {
  const score = scoreLabels([
    { expected: "2AZ-FE", verdict: "applies" },
    { expected: "2ZR-FE", verdict: "applies" },
    { expected: "2ZR-FE", verdict: "other_variant" },
    { expected: "both", verdict: "applies" },
    { expected: "unclear", verdict: "applies" },
  ]);

  assert.equal(score.total, 5);
  assert.equal(score.unclear, 1);
  assert.equal(score.scored, 4);
  assert.equal(score.falseApplies, 1);
  assert.equal(score.ownerRows, 3);
  assert.equal(score.falseOther, 1);
  assert.equal(score.falseOtherRate, 1 / 3);
  assert.equal(score.matrix["2AZ-FE"].applies, 1);
  assert.equal(score.matrix["2ZR-FE"].other_variant, 1);
});

test("'none' rows never count against the tagger, whatever it says", () => {
  const score = scoreLabels([
    { expected: "none", verdict: "not_stated" },
    { expected: "none", verdict: "unresolved" },
  ]);

  assert.equal(score.falseApplies, 0);
  assert.equal(score.falseOther, 0);
  assert.equal(score.matrix.none.unresolved, 1);
});

test("an empty label set scores zero", () => {
  const score = scoreLabels([]);

  assert.deepEqual(
    { total: score.total, falseApplies: score.falseApplies, falseOtherRate: score.falseOtherRate },
    { total: 0, falseApplies: 0, falseOtherRate: 0 }
  );
});

test("a figure is found from the chunk's start, counting occurrences", () => {
  const page = "25 N*m before the chunk. CHUNK STARTS here: 25 N*m first, then 25 N*m second";
  const chunkStart = page.indexOf("CHUNK");

  assert.equal(locateFigure(page, chunkStart, "25 N*m", 1), page.indexOf("25 N*m first"));
  assert.equal(locateFigure(page, chunkStart, "25 N*m", 2), page.indexOf("25 N*m second"));
  assert.equal(locateFigure(page, chunkStart, "25 N*m", 3), -1);
  assert.equal(locateFigure(page, chunkStart, "99 mm", 1), -1);
});
