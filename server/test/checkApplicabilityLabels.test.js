import assert from "node:assert/strict";
import test from "node:test";

// Scoring for the blind applicability label check (N5 P1). Pure: the real
// labels and the manual text they point at stay in a gitignored folder.
import { locateFigure, scoreLabels } from "../src/scripts/checkApplicabilityLabels.js";

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
