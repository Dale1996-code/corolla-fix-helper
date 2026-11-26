import assert from "node:assert/strict";
import test from "node:test";

// Read through the namespace so a tree that lacks something fails test by test,
// naming it, instead of failing to load this whole file.
import * as contract from "../src/services/askEvidenceContract.js";
import { ASK_ORACLE } from "./fixtures/evidenceOracle.js";

const {
  ASK_REJECTION_REASONS,
  checkClaimNumbers,
  checkClaimRow,
  checkClaimSubject,
  checkUnrecognizedFigures,
  quoteAppearsInChunk,
  verifyEvidence,
} = contract;

// R3: a figure with nothing before it that qualifies it, followed AT ONCE by a
// comparison to "the maximum / minimum / limit", is that limit. The behavior is
// pinned row by row in the evidence oracle (`R3-*` and `control-R3-*`); this
// file holds what a one-verdict row cannot: the exact `detail`, which older
// rejection wins, the four narrowings (a comparison that is not about THIS figure
// being the limit) with the edges of each, the limits and costs that stay open on
// purpose, and a time bound. Every text here is invented (a coupler, a slider, a
// sensor, a coil, a reservoir, a spring); none of it is manual text.
//
// There is no longer a test of which COMPONENT a comparison is about: an earlier
// version tied the comparison to the figure's part by word overlap (A2). The
// independent review showed it erred both ways, and the errors that went the
// unsafe way (a plain claim for a limit accepted) were its own, so it was removed.

function verify(claim, quote, chunkText) {
  const result = verifyEvidence(
    { documentSupported: [{ claim, sourceId: "S1", evidenceQuote: quote }], generalGuidance: [], gaps: [] },
    [
      {
        documentId: 1,
        documentTitle: "Oracle Manual",
        originalFilename: "oracle.pdf",
        pageNumber: 1,
        chunkIndex: 0,
        chunkText,
      },
    ]
  );

  return { accepted: result.documentSupported.length === 1, rejected: result.rejected[0] };
}

/** "accept", or "<reason>/<detail>". */
function outcome(claim, quote, chunkText) {
  const { accepted, rejected } = verify(claim, quote, chunkText);

  return accepted ? "accept" : `${rejected.reason}/${rejected.detail ?? ""}`;
}

const REJECT_DETAIL = "row_mismatch/qualifier_after_figure";
const mustReject = ASK_ORACLE.filter((row) => row.finding === "R3-qualifier-after-figure");
const controls = ASK_ORACLE.filter((row) => /^control-R3-/.test(row.id));

// ---- The oracle rows reach the stage they are about ----

test("R3 oracle rows exist and every one passes the earlier gates", () => {
  assert.ok(mustReject.length >= 35, `expected the R3 rows, found ${mustReject.length}`);
  assert.ok(controls.length >= 24, `expected the R3 controls, found ${controls.length}`);

  // A red row is only evidence about the new rule if the quote, the figures, the
  // part name and the row check all pass first. A row that died at an earlier
  // gate would "reject" for the wrong reason and prove nothing; a control that
  // died there would "pass" for the wrong reason.
  for (const row of [...mustReject, ...controls]) {
    assert.ok(quoteAppearsInChunk(row.quote, row.chunkText), `${row.id}: quote is not in its chunk`);
    assert.equal(checkClaimNumbers(row.claim, row.quote).grounded, true, `${row.id}: numeric gate`);
    assert.equal(checkUnrecognizedFigures(row.claim, row.quote).grounded, true, `${row.id}: unrecognized figure gate`);
    assert.equal(checkClaimSubject(row.claim, row.quote).grounded, true, `${row.id}: subject gate`);
    assert.equal(checkClaimRow(row.claim, row.quote).grounded, true, `${row.id}: S1 row gate`);
  }
});

test("every R3 must-reject row is refused as row_mismatch / qualifier_after_figure", () => {
  for (const row of mustReject) {
    assert.equal(outcome(row.claim, row.quote, row.chunkText), REJECT_DETAIL, row.id);
  }
});

test("every R3 control is still accepted", () => {
  for (const row of controls) {
    assert.equal(outcome(row.claim, row.quote, row.chunkText), "accept", row.id);
  }
});

// ---- The new rejection reuses the reason and adds only a server-side detail ----

test("qualifier_after_figure is a detail of row_mismatch, not a new rejection reason", () => {
  assert.ok(ASK_REJECTION_REASONS.includes("row_mismatch"));
  assert.ok(!ASK_REJECTION_REASONS.includes("qualifier_after_figure"));
});

// ---- An older rejection keeps its own detail ----

test("a rejection the verifier already made keeps its detail", () => {
  const chunk = "d. Check the coupler. Flange Gap 2.4 mm (0.0945 in.) If the gap is greater than the maximum, replace the coupler.";
  const quote = "Flange Gap 2.4 mm (0.0945 in.)";

  // The claim states a qualifier the figure's sentence does not print.
  assert.equal(
    outcome("The maximum flange gap is 2.4 mm (0.0945 in.).", quote, chunk),
    "row_mismatch/condition_not_in_row"
  );

  // A marked row, claimed without its marker.
  assert.equal(
    outcome(
      "Flange Gap is 2.4 mm (0.0945 in.).",
      "Minimum Flange Gap 2.4 mm (0.0945 in.)",
      "Minimum Flange Gap 2.4 mm (0.0945 in.) If the gap is less than the minimum, replace the coupler."
    ),
    "row_mismatch/condition_dropped"
  );

  // A neighbouring new-part row with a quote that names the part: the older rule
  // fires first, as it did before.
  assert.equal(
    outcome(
      "Flange Gap is 2.4 mm (0.0945 in.).",
      "Flange Gap 2.4 mm (0.0945 in.)",
      "Flange Gap 2.4 mm (0.0945 in.) If the gap is greater than the maximum, replace the coupler. Flange Gap, new coupler: 1.5 to 1.6 mm (0.0591 to 0.0630 in.)"
    ),
    "row_mismatch/unlabelled_row"
  );
});

// ---- No component tie: the comparison is applied to the figure whatever it names ----
//
// An earlier version asked whether the comparison was about the figure's own
// component (A2) and let the claim stand when it was not. The independent review
// showed that word-overlap tie erred both ways, and that its errors went the
// UNSAFE way: a plain claim for a limit stayed accepted whenever a synonym, an
// unlisted remedy word or the claim's own words made the two sentences look
// unrelated. A refused correct claim is the safe direction, so the tie is gone.

const FIGURE = "Flange Gap 2.4 mm (0.0945 in.)";
const FIGURE_CLAIM = "Flange Gap is 2.4 mm (0.0945 in.).";

/** The verdict on the plain claim when `sentence` follows the figure. */
function figureThen(sentence) {
  return outcome(FIGURE_CLAIM, FIGURE, `${FIGURE} ${sentence}`);
}

test("with no component tie, a plain claim for a limit is refused whatever the comparison names", () => {
  // Each was accepted while the tie existed (the review's F2, F3 and F8). In each
  // the figure is the limit; only the words around it hid that.
  const cases = [
    // 'clearance' was on the tie's list of measured quantities, so it was not a component
    ["The flange clearance is 2.4 mm.", "Flange clearance 2.4 mm", "Flange clearance 2.4 mm. If the clearance is greater than the maximum, replace the coupler."],
    // a remedy word the tie's action-word list did not know vetoed the rule
    ["The coupler flange gap is 2.4 mm.", "Coupler flange gap 2.4 mm", "Coupler flange gap 2.4 mm. If it is greater than the maximum, regrind."],
    ["The coupler flange gap is 2.4 mm.", "Coupler flange gap 2.4 mm", "Coupler flange gap 2.4 mm. If it is greater than the maximum, renew."],
    ["The coupler flange gap is 2.4 mm.", "Coupler flange gap 2.4 mm", "Coupler flange gap 2.4 mm. If it is greater than the maximum, shim it."],
    // the claim's own words (a part the page never names) decided the comparison was about something else
    ["The spacer width is 2.4 mm.", "2.4 mm", "2.4 mm (0.0945 in.) If the gap is greater than the maximum, replace the coupler."],
    ["The spacer width is 2.4 mm (0.0945 in.).", "2.4 mm (0.0945 in.)", "2.4 mm (0.0945 in.) If the latch tongue is shorter than the minimum, fit a replacement latch."],
    // a claim that names nothing, against a label that was cut off
    ["The value is 2.4 mm (0.0945 in.).", "2.4 mm (0.0945 in.)", "2.4 mm (0.0945 in.) If the latch tongue is shorter than the minimum, fit a replacement latch."],
  ];

  for (const [claim, quote, chunk] of cases) {
    assert.equal(outcome(claim, quote, chunk), REJECT_DETAIL, claim);
  }
});

// ---- Narrowing 1: the comparison prints its own limit ----
//
// "...greater than the maximum of 2.8 mm" names a limit that is NOT this figure.
// The limit is the next figure of the text (a unit-bearing one is a row of its
// own) or a number the reader does not take for a figure; either way what follows
// the limit word, past connecting words and an opening bracket, is that number.

test("N1: a comparison that prints its own limit is not about this figure", () => {
  for (const sentence of [
    "If the gap is greater than the maximum of 2.8 mm (0.1102 in.), replace the coupler.",
    "If the gap is greater than the maximum 2.8 mm (0.1102 in.), replace the coupler.",
    "If the gap is greater than the maximum value of 2.8 mm, replace the coupler.",
    "If the gap exceeds the maximum specified value of 2.8 mm, replace the coupler.",
    "If the gap is greater than the maximum: 2.8 mm, replace the coupler.",
    "If the gap is greater than the maximum, 2.8 mm, replace the coupler.",
    "If the gap is greater than the limit (2.8 mm), replace the coupler.",
    "If the gap is greater than the limit [2.8 mm], replace the coupler.",
    "If the gap is less than the minimum of 2.0 mm, replace the coupler.",
    // a number the reader does not take for a figure sits in the same sentence
    "If the gap is greater than the maximum of 3, replace the coupler.",
    "If the gap is greater than the maximum of 3.5 mils, replace the coupler.",
  ]) {
    assert.equal(figureThen(sentence), "accept", sentence);
  }
});

test("N1: a printed limit that is this very figure excuses nothing", () => {
  for (const sentence of [
    "If the gap is greater than the maximum of 2.4 mm (0.0945 in.), replace the coupler.",
    "If the gap is greater than the maximum of 2.40 mm, replace the coupler.",
    // the figure's other unit
    "If the gap is greater than the maximum of 0.0945 in., replace the coupler.",
    // a number that is not read as a figure, equal to this one
    "If the gap is greater than the maximum of 2.4, replace the coupler.",
  ]) {
    assert.equal(figureThen(sentence), REJECT_DETAIL, sentence);
  }
});

test("N1: only a number straight after the limit word counts as the comparison's own limit", () => {
  for (const sentence of [
    // nothing numeric follows the limit word
    "If the gap is greater than the maximum, replace the coupler within 30 days.",
    // words that are not connectors sit between the limit word and the number
    "If the gap is greater than the maximum, replace the coupler and re-measure to 2.8 mm.",
    // the same with plain words only: no connector is among them
    "If the gap is greater than the maximum, replace the coupler and measure again at 2.8 mm.",
    "If the gap is greater than the maximum, the coupler is replaced.",
    // one comparison prints its limit, the other does not
    "If the gap is greater than the maximum of 3 or less than the minimum, replace the coupler.",
  ]) {
    assert.equal(figureThen(sentence), REJECT_DETAIL, sentence);
  }
});

test("N1: every connecting word between the limit word and its printed limit is read", () => {
  for (const connector of ["value", "of", "is", "at", "was", "being", "set", "specified", "stated", "listed", "shown", "equal", "equals", "="]) {
    const sentence = `If the gap is greater than the maximum ${connector} 2.8 mm, replace the coupler.`;
    assert.equal(figureThen(sentence), "accept", sentence);
  }
});

test("N1: a printed limit is compared as a number, with its sign and thousands separator", () => {
  // "-0.5" is not the figure 0.5.
  assert.equal(
    outcome(
      "The flange offset is 0.5 mm.",
      "Flange offset 0.5 mm",
      "Flange offset 0.5 mm. If the offset is less than the minimum of -0.5 mm, replace the coupler."
    ),
    "accept"
  );
  // The same for a limit the reader does not take for a figure.
  assert.equal(
    outcome(
      "The flange offset is 0.5 mm.",
      "Flange offset 0.5 mm",
      "Flange offset 0.5 mm. If the offset is less than the minimum of -0.5, replace the coupler."
    ),
    "accept"
  );
  // "1,500" is the figure 1500.
  assert.equal(
    outcome(
      "The line pressure is 1500 kPa.",
      "Line pressure 1500 kPa",
      "Line pressure 1500 kPa. If the pressure is greater than the maximum of 1,500 kPa, replace the line."
    ),
    REJECT_DETAIL
  );
  // One number of the printed limit equal to one of the figure's is enough to see it restated.
  assert.equal(
    figureThen("If the gap is greater than the maximum of 2.4 mm (0.1102 in.), replace the coupler."),
    REJECT_DETAIL
  );
});

test("N1: a sentence that ends at the limit word does not run into the next sentence's figure", () => {
  assert.equal(
    figureThen("If the gap is greater than the maximum. Shim thickness 0.5 mm (0.020 in.) is listed below."),
    REJECT_DETAIL
  );
});

test("the distance between a comparing word and its limit is counted in single spaces", () => {
  // The source may space words widely or break lines; the 40-character reach is
  // meant for words, not for the whitespace between them.
  assert.equal(
    figureThen(`If the gap is greater${" ".repeat(45)}than the maximum, replace the coupler.`),
    REJECT_DETAIL
  );
  assert.equal(figureThen("If the gap is greater\n\n\nthan\nthe\nmaximum, replace the coupler."), REJECT_DETAIL);
});

// ---- Narrowing 2: a limit word that names a gauge mark ----

test("N2: 'the minimum line', 'the maximum mark' and 'the limit level' are gauge marks, not limits", () => {
  const claim = "The coolant capacity is 6.0 L.";
  const quote = "Coolant capacity 6.0 L";

  for (const sentence of [
    "If the coolant level is lower than the minimum line, add coolant.",
    "Do not fill above the maximum mark on the dipstick.",
    "If the level is below the minimum level, add coolant.",
    "If the level is below the minimum marks, add coolant.",
    "If the coolant is below the minimum lines, add coolant.",
    "If the level is below the minimum levels, add coolant.",
    "If the coolant is above the limit line, drain some.",
    "If the coolant is below the MINIMUM LINE, add coolant.",
  ]) {
    assert.equal(outcome(claim, quote, `${quote}. ${sentence}`), "accept", sentence);
  }

  for (const sentence of [
    "If the coolant level is lower than the minimum, add coolant.",
    // a longer word is not the gauge word
    "If the coolant is below the minimum linear amount, add coolant.",
    "If the coolant is below the minimum marking, add coolant.",
    // another, plain limit word in the same comparison
    "If the coolant is below the minimum line or the minimum, add coolant.",
    "If the level is lower than the minimum line or greater than the maximum, add or drain coolant.",
  ]) {
    assert.equal(outcome(claim, quote, `${quote}. ${sentence}`), REJECT_DETAIL, sentence);
  }
});

// ---- Narrowing 3: a negated comparison ----

test("N3: a negated comparison says the figure is within the limit", () => {
  const claim = "The flange gap is 2.4 mm.";
  const quote = "Flange gap 2.4 mm";

  for (const sentence of [
    "If the gap is not greater than the maximum, the coupler may be reused.",
    "The coupler may be reused if the gap does not exceed the maximum.",
    "The gap must not be greater than the maximum.",
    "If the gap is no greater than the maximum, reuse the coupler.",
    "If the gap never exceeds the maximum, reuse the coupler.",
    "The gap cannot exceed the maximum.",
    "If the gap isn't greater than the maximum, reuse the coupler.",
    `If the gap isn${String.fromCharCode(0x2019)}t greater than the maximum, reuse the coupler.`,
    "The gap does not go above the maximum.",
    "If the gap is NOT greater than the maximum, reuse the coupler.",
    // each auxiliary that may stand between the negation and the comparing word
    "The gap has not been more than the maximum.",
    "If the gap is not ever greater than the maximum, reuse the coupler.",
    "The gap does not get above the maximum.",
    "The gap is not yet greater than the maximum.",
  ]) {
    assert.equal(outcome(claim, quote, `${quote}. ${sentence}`), "accept", sentence);
  }
});

test("N3: a negation that does not belong to the comparison excuses nothing", () => {
  const claim = "The flange gap is 2.4 mm.";
  const quote = "Flange gap 2.4 mm";

  for (const sentence of [
    // 'not' negates the remedy, which comes first
    "Do not reuse the coupler if the gap is greater than the maximum.",
    "Do not reuse if greater than the maximum.",
    // one word between the negation and the comparison, but not an auxiliary
    "Do not use above the maximum.",
    // a word that merely ENDS in a negation is not one
    "If the gap is a knot above the maximum, replace the coupler.",
    // 'not' comes after the comparison
    "If the gap is greater than the maximum, do not reuse the coupler.",
    // 'No.' is a part designation, not a negation
    "If the No. 1 gap is greater than the maximum, replace the coupler.",
    // words that are not auxiliaries sit between the negation and the comparison
    "If the gap is not acceptable and is greater than the maximum, replace the coupler.",
    // a second comparison that is not negated
    "If the gap is not greater than the maximum, or is less than the minimum, replace the coupler.",
  ]) {
    assert.equal(outcome(claim, quote, `${quote}. ${sentence}`), REJECT_DETAIL, sentence);
  }
});

// ---- Narrowing 4: words that read like 'standard' ----

test("N4: 'specified', 'nominal', 'reference' and 'typical' declare the figure ordinary, as 'standard' does", () => {
  for (const word of ["Specified", "Nominal", "Reference", "Typical", "NOMINAL"]) {
    assert.equal(
      outcome(
        FIGURE_CLAIM,
        `${word} ${FIGURE}`,
        `${word} ${FIGURE} If the gap is greater than the maximum, replace the coupler.`
      ),
      "accept",
      word
    );
  }
});

test("N4: such a word counts only in the figure's own sentence, and only as that word", () => {
  const comparison = "If the gap is greater than the maximum, replace the coupler.";

  // An earlier sentence may be about anything.
  assert.equal(
    outcome(FIGURE_CLAIM, FIGURE, `Typical wear is shown below. ${FIGURE} ${comparison}`),
    REJECT_DETAIL
  );
  // A longer word is not the word.
  assert.equal(
    outcome(FIGURE_CLAIM, `Typically ${FIGURE}`, `Typically ${FIGURE} ${comparison}`),
    REJECT_DETAIL
  );
  // After the figure, in the comparison itself, it qualifies the maximum, not the figure.
  assert.equal(
    outcome(FIGURE_CLAIM, FIGURE, `${FIGURE} If the gap is greater than the specified maximum, replace the coupler.`),
    REJECT_DETAIL
  );
});

// ---- What the rule reads, and where it stops ----

test("the comparison must be the sentence right after the figure", () => {
  const quote = "Flange Gap 2.4 mm (0.0945 in.)";

  // Another figure between them: the comparison belongs to that figure.
  assert.equal(
    outcome(
      "Flange Gap is 2.4 mm (0.0945 in.).",
      quote,
      "Flange Gap 2.4 mm (0.0945 in.) Shim thickness 0.5 mm (0.020 in.) If the thickness is greater than the maximum, replace the shim."
    ),
    "accept"
  );
});

test("LIMIT (miss): a comparison one sentence further on is not looked past", () => {
  // The figure may well be the maximum here; the rule does not read that far.
  assert.equal(
    outcome(
      "Flange Gap is 2.4 mm (0.0945 in.).",
      "Flange Gap 2.4 mm (0.0945 in.)",
      "Flange Gap 2.4 mm (0.0945 in.) Tighten the clamp evenly. If the gap is greater than the maximum, replace the coupler."
    ),
    "accept"
  );
});

test("a range, a declared standard, or any printed qualifier is left alone", () => {
  const sentence = "If the gap is greater than the maximum, replace the coupler.";
  for (const [claim, quote, row] of [
    ["Flange Gap is 1.5 to 1.6 mm (0.0591 to 0.0630 in.).", "Flange Gap 1.5 to 1.6 mm (0.0591 to 0.0630 in.)", "Flange Gap 1.5 to 1.6 mm (0.0591 to 0.0630 in.)"],
    ["Flange Gap is 2.4 mm (0.0945 in.).", "Standard Flange Gap 2.4 mm (0.0945 in.)", "Standard Flange Gap 2.4 mm (0.0945 in.)"],
    ["Flange Gap is 2.4 mm (0.0945 in.) or less.", "Flange Gap 2.4 mm (0.0945 in.) or less", "Flange Gap 2.4 mm (0.0945 in.) or less"],
  ]) {
    // The "or less" claim is judged by the older rules (the threshold is printed
    // and stated); the point here is that nothing NEW rejects any of them.
    assert.notEqual(outcome(claim, quote, `${row} ${sentence}`), REJECT_DETAIL, claim);
  }
});

test("both comparison directions and several wordings are read", () => {
  for (const sentence of [
    "If the gap is greater than the maximum, replace it.",
    "If the gap is larger than the maximum, replace it.",
    "If the gap is more than the limit, replace it.",
    "If the gap exceeds the maximum, replace it.",
    "When the gap is beyond the limit, replace it.",
    "If the gap is less than the minimum, replace it.",
    "If the gap is smaller than the minimum, replace it.",
    "If the gap is below the minimum, replace it.",
    "If the gap is shorter than the limit, replace it.",
    "If the gap is above the maximum, replace it.",
    "If the gap is over the maximum, replace it.",
    "If the gap is longer than the limit, replace it.",
    "If the gap is higher than the maximum, replace it.",
    "If the gap is lower than the minimum, replace it.",
    "If the gap is under the minimum, replace it.",
    "When exceeding the maximum, the gap needs the coupler replaced.",
    "If the gap is GREATER THAN THE MAXIMUM, replace it.",
  ]) {
    const chunk = `Flange Gap 2.4 mm (0.0945 in.) ${sentence}`;
    assert.equal(outcome("Flange Gap is 2.4 mm (0.0945 in.).", "Flange Gap 2.4 mm (0.0945 in.)", chunk), REJECT_DETAIL, sentence);
  }

  for (const sentence of [
    "If the gap is too large, replace it.",
    "If the gap is greater than 3.0 mm (0.118 in.), replace it.",
    "The maximum gap is set at the factory.",
  ]) {
    const chunk = `Flange Gap 2.4 mm (0.0945 in.) ${sentence}`;
    assert.equal(outcome("Flange Gap is 2.4 mm (0.0945 in.).", "Flange Gap 2.4 mm (0.0945 in.)", chunk), "accept", sentence);
  }
});

test("the comparison is found only in the first sentence after the figure, and only near its start", () => {
  const far = `Flange Gap 2.4 mm (0.0945 in.) ${"Inspect the coupler flange carefully before any measurement is taken at all today and ".repeat(2)}and the gap is greater than the maximum, replace it.`;
  assert.equal(outcome("Flange Gap is 2.4 mm (0.0945 in.).", "Flange Gap 2.4 mm (0.0945 in.)", far), "accept");
});

test("the comparison is read up to the 24th word after the figure, exactly", () => {
  // The words before the comparing phrase repeat the figure's own component so
  // that the part-name tie holds; only the position of the phrase changes. The
  // full stop and the space after it must not count as a word.
  const endingAtWord = (position) =>
    `Flange Gap 2.4 mm (0.0945 in.). ${"gap ".repeat(position - 4)}greater than the maximum`;
  const quote = "Flange Gap 2.4 mm (0.0945 in.)";
  const claim = "Flange Gap is 2.4 mm (0.0945 in.).";

  assert.equal(outcome(claim, quote, endingAtWord(24)), REJECT_DETAIL);
  assert.equal(outcome(claim, quote, endingAtWord(25)), "accept");
});

// ---- Limits that stay open on purpose ----

test("LIMIT: a correctly qualified claim on the same evidence is still rejected", () => {
  // Recovering this answer needs the qualifier inside the quote's own sentence.
  // Trusting the comparison instead was measured to accept wrong claims, so the
  // older rejection stands. This pins the behavior so a later change is deliberate.
  const chunk = "d. Check the coupler. Flange Gap 2.4 mm (0.0945 in.) If the gap is greater than the maximum, replace the coupler.";
  assert.equal(
    outcome("The maximum flange gap is 2.4 mm (0.0945 in.).", "Flange Gap 2.4 mm (0.0945 in.)", chunk),
    "row_mismatch/condition_not_in_row"
  );
  assert.equal(
    outcome(
      "The maximum flange gap is 2.4 mm (0.0945 in.).",
      "Flange Gap 2.4 mm (0.0945 in.) If the gap is greater than the maximum, replace the coupler.",
      chunk
    ),
    "row_mismatch/condition_not_in_row"
  );
});

test("LIMIT: a quote that joins text from two chunks is still refused", () => {
  const chunk = "Flange Gap 2.4 mm (0.0945 in.) If the gap is greater than the maximum, replace the coupler.";
  assert.equal(
    outcome(
      "The maximum flange gap is 2.4 mm (0.0945 in.).",
      "Maximum Flange Gap for Used Coupler: Flange Gap 2.4 mm (0.0945 in.)",
      chunk
    ),
    "quote_not_in_source/"
  );
});

test("LIMIT: a comparison in the next chunk is not visible", () => {
  // The chunk ends at the figure; whatever follows is in another chunk.
  assert.equal(
    outcome("Flange Gap is 2.4 mm (0.0945 in.).", "Flange Gap 2.4 mm (0.0945 in.)", "d. Check the coupler. Flange Gap 2.4 mm (0.0945 in.)"),
    "accept"
  );
});

// ---- Costs and misses found by the independent review ----
//
// Each test below pins what the rule does TODAY in a layout where that is not
// what a person would want, so a later change is a decision and not an accident.
// Two groups: (1) a plain claim that means the limit and is still ACCEPTED (a
// miss, the older behaviour); (2) a correct claim that is REFUSED (a cost, the
// safe direction). Every text is invented.

test("LIMIT (miss): other wordings of the same comparison are not read", () => {
  const quote = "Flange Gap 2.4 mm (0.0945 in.)";
  const claim = "Flange Gap is 2.4 mm (0.0945 in.).";

  for (const sentence of [
    "If the gap exceeds max, replace it.",
    "If the gap exceeded the maximum, replace it.",
    "If the gap is greater than the limits, replace it.",
    "If the gap reaches the limit, replace it.",
    "If the gap is out of the limit, replace it.",
    "Replace the coupler when the maximum is reached.",
  ]) {
    assert.equal(outcome(claim, quote, `Flange Gap 2.4 mm (0.0945 in.) ${sentence}`), "accept", sentence);
  }
});

test("LIMIT (miss): words that trail the figure in its own sentence hide the comparison after them", () => {
  const quote = "Flange Gap 2.4 mm (0.0945 in.)";

  for (const trailing of [" at the rim", " (see illustration)", " each side", " approx"]) {
    assert.equal(
      outcome(
        "Flange Gap is 2.4 mm (0.0945 in.).",
        quote,
        `Flange Gap 2.4 mm (0.0945 in.)${trailing}. If the gap is greater than the maximum, replace the coupler.`
      ),
      "accept",
      trailing
    );
  }
});

test("LIMIT (cost): correct claims the rule refuses in layouts it cannot tell apart", () => {
  // Every case is a CORRECT claim that is refused -- the safe direction. The first
  // three are what removing the component tie costs: the comparison is about
  // another part, and the rule no longer asks. The rest were never helped by it.
  const cases = [
    ["Spacer width 2.0 mm. If the gap is greater than the maximum, replace the coupler.", "Spacer width 2.0 mm", "The spacer width is 2.0 mm."],
    ["Pad thickness 10.0 mm. If the rotor thickness is less than the minimum, replace the rotor.", "Pad thickness 10.0 mm", "The pad thickness is 10.0 mm."],
    ["Hinge play 0.4 mm. If the wear is greater than the maximum, replace the latch.", "Hinge play 0.4 mm", "The hinge play is 0.4 mm."],
    // a different quantity of the same component
    ["Disc thickness 25.0 mm. If the runout is greater than the maximum, replace the disc.", "Disc thickness 25.0 mm", "The disc thickness is 25.0 mm."],
    ["Coupler bolt torque 30 N*m. If the bolt stretch is greater than the maximum, replace the bolt.", "Coupler bolt torque 30 N*m", "The coupler bolt torque is 30 N*m."],
    // the same measurement of two components
    ["Hub runout 0.05 mm. If the rotor runout is greater than the maximum, replace the rotor.", "Hub runout 0.05 mm", "The hub runout is 0.05 mm."],
    // a shared modifier word
    ["Oil pump clearance 0.1 mm. If the oil pressure is lower than the minimum, check the oil filter.", "Oil pump clearance 0.1 mm", "The oil pump clearance is 0.1 mm."],
    // the limit is printed elsewhere, but not straight after the limit word
    ["Tire pressure 230 kPa. Do not inflate the tire above the limit shown on the sidewall.", "Tire pressure 230 kPa", "The tire pressure is 230 kPa."],
    // a range spelled with a spaced hyphen, or with its unit repeated, is read as separate single figures
    ["Flange gap 1.5 - 1.6 mm. If the gap is greater than the maximum, replace the coupler.", "Flange gap 1.5 - 1.6 mm", "The flange gap is 1.5 - 1.6 mm."],
    ["Flange gap 1.5 mm to 1.6 mm. If the gap is greater than the maximum, replace the coupler.", "Flange gap 1.5 mm to 1.6 mm", "The flange gap is 1.5 mm to 1.6 mm."],
  ];

  for (const [chunk, quote, claim] of cases) {
    assert.equal(outcome(claim, quote, chunk), REJECT_DETAIL, chunk);
  }
});

// ---- The rules merged after R3 was written ----
//
// R3 was written before the unit rules (#185 `unit_missing`, #187 units printed in a
// header or the next cell, #188 a cut quote's header read in the chunk). R3 runs last
// and only ever adds a rejection, so a claim those rules refuse must keep their reason,
// and a figure they now read must still be judged by R3. A slider, invented.

const SLIDER_COMPARISON = "Renew the slider when its thickness is less than the minimum.";

test("a dropped unit keeps the unit rule's reason on an R3 layout", () => {
  assert.equal(
    outcome("The slider thickness is 2.4.", "Slider Thickness 2.4 mm (0.0945 in.)", `Slider Thickness 2.4 mm (0.0945 in.) ${SLIDER_COMPARISON}`),
    "unrecognized_figure/unit_missing"
  );
  assert.equal(
    outcome("The slider thickness is 2.4.", "Thickness (mm): slider 2.4", `Thickness (mm): slider 2.4. ${SLIDER_COMPARISON}`),
    "unrecognized_figure/unit_missing"
  );
  assert.equal(
    outcome(
      "The minimum slider thickness is 2.4.",
      "Minimum Slider Thickness 2.4 mm (0.0945 in.)",
      `Minimum Slider Thickness 2.4 mm (0.0945 in.) ${SLIDER_COMPARISON}`
    ),
    "unrecognized_figure/unit_missing"
  );
});

test("a figure whose unit sits in a header is still read as an unmarked limit", () => {
  assert.equal(
    outcome("The slider thickness is 2.4 mm.", "Thickness (mm): slider 2.4", `Thickness (mm): slider 2.4. ${SLIDER_COMPARISON}`),
    REJECT_DETAIL
  );
});

test("a labelled limit followed by its comparison stays verifiable, and a dropped label keeps condition_dropped", () => {
  const labelled = `Minimum Slider Thickness 2.4 mm (0.0945 in.) ${SLIDER_COMPARISON}`;

  // The false-rejection guard: manuals print "Minimum X: figure. If X is less than the
  // minimum, ..." constantly, and the qualified claim must not be refused.
  assert.equal(
    outcome("The minimum slider thickness is 2.4 mm (0.0945 in.).", "Minimum Slider Thickness 2.4 mm (0.0945 in.)", labelled),
    "accept"
  );
  // The dropped qualifier is still the older rule's to refuse, with its own detail.
  assert.equal(
    outcome("The slider thickness is 2.4 mm (0.0945 in.).", "Minimum Slider Thickness 2.4 mm (0.0945 in.)", labelled),
    "row_mismatch/condition_dropped"
  );
  // A printed "standard".
  assert.equal(
    outcome(
      "The standard slider thickness is 2.4 mm (0.0945 in.).",
      "Standard Slider Thickness 2.4 mm (0.0945 in.)",
      `Standard Slider Thickness 2.4 mm (0.0945 in.) ${SLIDER_COMPARISON}`
    ),
    "accept"
  );
});

test("LIMIT (miss): N3 and N1 excuse comparisons that still make the figure the limit", () => {
  // Found by the 2026-11-26 independent review. These are MISLEADING claims that
  // stay accepted, pinned so a decision on N1 and N3 changes a named test.
  const claim = "The slider thickness is 2.4 mm (0.0945 in.).";
  const quote = "Slider Thickness 2.4 mm (0.0945 in.)";

  // N3: a negated comparison changes whether the part passes, not what the
  // printed figure is. The only figure next to "the minimum" is that minimum.
  for (const sentence of [
    "The thickness must not be less than the minimum after grinding.",
    "Make sure the thickness is not less than the minimum.",
  ]) {
    assert.equal(outcome(claim, quote, `${quote} ${sentence}`), "accept", sentence);
  }

  // N1: a temperature or a count after the limit word is read as the comparison's
  // own limit, though it is not a thickness at all.
  assert.equal(
    outcome(claim, quote, `${quote} If the thickness is less than the minimum, 2 shims must be added.`),
    "accept"
  );
  assert.equal(
    outcome(
      "The coil resistance is 1.5 Ω.",
      "Coil resistance 1.5 Ω",
      "Coil resistance 1.5 Ω. If the resistance is greater than the maximum at 20°C, replace the coil."
    ),
    "accept"
  );
});

test("LIMIT (cost): a fill warning after a capacity is read as a limit comparison", () => {
  // A CORRECT claim refused (the safe direction): the limit is the reservoir's
  // mark, not the capacity. N2 excuses only "limit/maximum" followed at once by
  // mark/line/level. Found by the 2026-11-26 review; no real row has this shape.
  for (const sentence of [
    "Do not fill above the upper limit of the reservoir.",
    "Do not fill above the maximum fill line.",
  ]) {
    assert.equal(
      outcome("The reservoir capacity is 0.5 L.", "Reservoir capacity 0.5 L", `Reservoir capacity 0.5 L. ${sentence}`),
      REJECT_DETAIL,
      sentence
    );
  }
});

test("a figure printed with a ± tolerance is a value to hold, not a limit", () => {
  // "7.0 ± 1.0 mm" spans 6.0 to 8.0 mm, so it cannot be the maximum the next
  // sentence names; refusing it would refuse a correct claim (review, 2026-11-26).
  for (const value of ["7.0 ± 1.0 mm", "7.0±1.0 mm", "7.0 +/- 1.0 mm"]) {
    assert.equal(
      outcome(
        `The slider deflection is ${value}.`,
        `Slider deflection ${value}`,
        `Slider deflection ${value}. If the deflection is greater than the maximum, adjust the slider.`
      ),
      "accept",
      value
    );
  }
});

test("LIMIT (miss): a position word in the figure's own sentence exempts an unmarked limit", () => {
  // The rule skips a figure whose own sentence prints ANY condition word, so a
  // front/rear, left/right, intake, hot/cold or inner label hides the comparison
  // after it and the plain claim still presents the limit as the ordinary value
  // ("No. 1" happens to be refused). Pinned as a known miss, not required
  // behaviour; see the iteration log's 2026-11-26 entry.
  for (const position of ["Front", "Rear", "Left", "Right", "Intake", "Cold", "Inner"]) {
    assert.equal(
      outcome(
        `The ${position.toLowerCase()} slider thickness is 2.4 mm (0.0945 in.).`,
        `${position} Slider Thickness 2.4 mm (0.0945 in.)`,
        `${position} Slider Thickness 2.4 mm (0.0945 in.) ${SLIDER_COMPARISON}`
      ),
      "accept",
      position
    );
  }
});

// ---- Bounded work ----

test("pathological text stays fast", () => {
  const filler = "greater than the maximum ".repeat(4000);
  const chunk = `Flange Gap 2.4 mm (0.0945 in.) ${filler}`;
  const started = Date.now();
  outcome("Flange Gap is 2.4 mm (0.0945 in.).", "Flange Gap 2.4 mm (0.0945 in.)", chunk);
  outcome("Flange Gap is 2.4 mm (0.0945 in.).", "Flange Gap 2.4 mm (0.0945 in.)", `${"2.4 mm (0.0945 in.) ".repeat(800)}If the gap is greater than the maximum, replace it.`);
  assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
});
