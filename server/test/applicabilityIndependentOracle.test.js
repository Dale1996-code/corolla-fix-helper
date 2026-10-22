import assert from "node:assert/strict";
import test from "node:test";

// Independent verification of the N5 applicability tagger. The 110 rows in
// fixtures/applicabilityIndependentOracle.js were written from the written
// rules alone (the plan's Tasks 6-8 and the design doc), by an author who never
// saw the tagger's code, and cover mixed-engine spec tables, unknown
// applicability, false-positive engine matches, the plant axis, and scope
// extent. All text is synthetic.
//
// The first run disagreed on four rows, all in the unsafe direction and all
// flagged by the author as places the rules were ambiguous; each was ruled
// fail-closed and fixed in the tagger (see applicabilityScope.test.js,
// "independent-oracle findings"). A row may be corrected only when it
// contradicts the written rules, never to make the tagger pass.
import { INDEPENDENT_APPLICABILITY_ORACLE } from "./fixtures/applicabilityIndependentOracle.js";
import {
  classifyScope,
  computeDocumentScopes,
  scopeAt,
} from "../src/services/applicabilityScope.js";

for (const row of INDEPENDENT_APPLICABILITY_ORACLE) {
  test(`oracle ${row.id} [${row.category}] -> ${row.expected}`, () => {
    const page = computeDocumentScopes(row.pages).find(
      (entry) => entry.pageNumber === row.figure.pageNumber
    );
    assert.ok(page, `page ${row.figure.pageNumber} missing`);

    let at = -1;
    for (let seen = 0; seen < row.figure.occurrence; seen += 1) {
      at = page.text.indexOf(row.figure.text, at + 1);
    }
    assert.ok(at !== -1, `figure "${row.figure.text}" #${row.figure.occurrence} not found`);

    const verdict = classifyScope(scopeAt(page.segments, at), row.profile, { axes: row.axes }).verdict;
    assert.equal(verdict, row.expected, row.rationale);
  });
}

test("the oracle still covers every required category", () => {
  const count = (category) =>
    INDEPENDENT_APPLICABILITY_ORACLE.filter((row) => row.category === category).length;

  assert.ok(count("mixed_table") >= 12);
  assert.ok(count("unknown_applicability") >= 10);
  assert.ok(count("false_positive") >= 12);
  assert.ok(count("plant_axis") >= 5);
  assert.ok(count("extent") >= 6);
});
