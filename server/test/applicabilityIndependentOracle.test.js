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

// Rows whose expectation predates a rule the final review made stricter. The
// fixture itself is left exactly as its independent author wrote it; each
// override names the rule and moves only from one rejection to another
// (other_variant -> unresolved), never toward `applies`.
const RULE_CHANGES = {
  "mixed-21": {
    expected: "unresolved",
    why: "Final review I2 (design §6.1): two engines named with no figure between them are a header row.",
  },
  "unknown-20": {
    expected: "unresolved",
    why: "Final review C2: a legend naming both engines inside a 2AZ-FE diagram means the next page cannot inherit 2AZ-FE.",
  },
  "extent-18": {
    expected: "unresolved",
    why: "Final review C2: a 2AZ-FE article page that opens a 2ZR-FE block hands the next page unresolved.",
  },
};

test("rule-change overrides only ever move between rejections", () => {
  for (const [id, override] of Object.entries(RULE_CHANGES)) {
    const row = INDEPENDENT_APPLICABILITY_ORACLE.find((entry) => entry.id === id);
    assert.ok(row, `${id} is not in the oracle`);
    assert.notEqual(row.expected, "applies", `${id}: an override may not tighten away from applies`);
    assert.notEqual(override.expected, "applies", `${id}: an override may never expect applies`);
    assert.notEqual(override.expected, "not_stated", `${id}: an override may never loosen to not_stated`);
  }
});

for (const row of INDEPENDENT_APPLICABILITY_ORACLE) {
  const expected = RULE_CHANGES[row.id]?.expected ?? row.expected;
  test(`oracle ${row.id} [${row.category}] -> ${expected}`, () => {
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
    assert.equal(verdict, expected, RULE_CHANGES[row.id]?.why ?? row.rationale);
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
