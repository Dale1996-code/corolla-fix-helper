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
// rejection wins, the part-name tie (A2) in all its edge cases, the limits that
// stay open on purpose, and a time bound. Every text here is invented (a
// coupler, a slider, a spring); none of it is manual text.

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
  assert.ok(mustReject.length >= 28, `expected the R3 rows, found ${mustReject.length}`);
  assert.ok(controls.length >= 25, `expected the R3 controls, found ${controls.length}`);

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
      "Flange Gap 2.4 mm (0.0945 in.) If the gap is greater than the maximum, replace the coupler. Flange Gap for New Coupler: Flange Gap 1.5 to 1.6 mm (0.0591 to 0.0630 in.)"
    ),
    "row_mismatch/unlabelled_row"
  );
});

// ---- A2: the comparison must be about the figure's own component ----
//
// The tie compares COMPONENT words (a pad, a rotor, a gap, a coupler), not the
// measured quantity (thickness, diameter, ...). Two sentences about different
// components both speak of "thickness"; that must not tie them.

test("A2: a comparison that names a different component is not applied", () => {
  const cases = [
    ["Spacer width is 2.0 mm (0.079 in.).", "Spacer width 2.0 mm (0.079 in.)", "Spacer width 2.0 mm (0.079 in.) If the gap is greater than the maximum, replace the coupler."],
    ["Pad thickness is 10.0 mm (0.394 in.).", "Pad thickness 10.0 mm (0.394 in.)", "Pad thickness 10.0 mm (0.394 in.) If the rotor thickness is less than the minimum, replace the rotor."],
    // The comparison names the figure's component only in the object of "replace".
    ["Hinge play is 0.4 mm (0.016 in.).", "Hinge play 0.4 mm (0.016 in.)", "Hinge play 0.4 mm (0.016 in.) If the wear is greater than the maximum, replace the latch."],
  ];

  for (const [claim, quote, chunk] of cases) {
    assert.equal(outcome(claim, quote, chunk), "accept", claim);
  }
});

test("A2: one shared component word is enough to tie them", () => {
  // Two components named on each side; one is common ("coupler").
  assert.equal(
    outcome(
      "Coupler flange gap is 2.4 mm (0.0945 in.).",
      "Coupler flange gap 2.4 mm (0.0945 in.)",
      "Coupler flange gap 2.4 mm (0.0945 in.) If the coupler wear is greater than the maximum, replace the spacer."
    ),
    REJECT_DETAIL
  );
});

test("A2: plural and singular component words tie", () => {
  assert.equal(
    outcome(
      "Slider pad wear is 0.8 mm (0.031 in.).",
      "Slider pad wear 0.8 mm (0.031 in.)",
      "Slider pad wear 0.8 mm (0.031 in.) If the pads are worn past the limit, replace the pads."
    ),
    // "worn past the limit" is not a comparison word; nothing to act on.
    "accept"
  );
  assert.equal(
    outcome(
      "Slider pad wear is 0.8 mm (0.031 in.).",
      "Slider pad wear 0.8 mm (0.031 in.)",
      "Slider pad wear 0.8 mm (0.031 in.) If the wear of the pads is greater than the limit, replace the pads."
    ),
    REJECT_DETAIL
  );
});

test("A2: a component missing on both sides is not a reason to accept", () => {
  // The label was cut off by a page break and the claim names nothing: there is
  // no evidence the comparison is about anything else, and the figure is
  // refused (the demonstrated label-less case).
  const chunk = "2.4 mm (0.0945 in.) If the exposed length is less than the minimum, replace the latch assembly.";
  assert.equal(outcome("The value is 2.4 mm (0.0945 in.).", "2.4 mm (0.0945 in.)", chunk), REJECT_DETAIL);
  assert.equal(outcome("The exposed length is 2.4 mm (0.0945 in.).", "2.4 mm (0.0945 in.)", chunk), REJECT_DETAIL);
});

test("A2: a claim that names a different component than the label-less comparison is accepted", () => {
  // The chunk opens on a bare figure and the comparison names the latch. A claim
  // that says the figure belongs to a spacer shares nothing with it, so the
  // comparison is not assumed to describe the spacer.
  const chunk = "2.4 mm (0.0945 in.) If the exposed length is less than the minimum, replace the latch assembly.";
  assert.equal(outcome("The spacer width is 2.4 mm (0.0945 in.).", "2.4 mm (0.0945 in.)", chunk), "accept");
});

test("A2: an abbreviated component ties by its first three letters or more", () => {
  const chunk = "Elec 1.3 mm (0.0512 in.) If the electrode gap exceeds the limit, replace the plug.";
  assert.equal(outcome("Elec is 1.3 mm (0.0512 in.).", "Elec 1.3 mm (0.0512 in.)", chunk), REJECT_DETAIL);

  // Two letters is not enough to call it the same word.
  const short = "El 1.3 mm (0.0512 in.) If the electrode gap exceeds the limit, replace the plug.";
  assert.equal(outcome("El is 1.3 mm (0.0512 in.).", "El 1.3 mm (0.0512 in.)", short), "accept");
});

test("A2: an abbreviated measured quantity is not a component", () => {
  // "Dia." is the quantity, not a part: it names no component, so nothing says
  // the comparison is about another one and the figure is refused.
  assert.equal(
    outcome(
      "Dia. is 14.0 mm (0.551 in.).",
      "Dia. 14.0 mm (0.551 in.)",
      "Dia. 14.0 mm (0.551 in.) If the diameter is less than the minimum, replace the rotor."
    ),
    REJECT_DETAIL
  );
});

test("A2: the component may be named in a heading inside the label, or only by the claim", () => {
  // Heading in the figure's own label sentence.
  assert.equal(
    outcome(
      "Coupler flange gap is 2.4 mm (0.0945 in.).",
      "Coupler flange: Gap 2.4 mm (0.0945 in.)",
      "Coupler flange: Gap 2.4 mm (0.0945 in.) If the gap is greater than the maximum, replace the coupler."
    ),
    REJECT_DETAIL
  );

  // Only the claim names the component (the label is the bare quantity).
  assert.equal(
    outcome(
      "The coupler gap is 2.4 mm (0.0945 in.).",
      "Gap 2.4 mm (0.0945 in.)",
      "Gap 2.4 mm (0.0945 in.) If the gap is greater than the maximum, replace the coupler."
    ),
    REJECT_DETAIL
  );
});

test("A2: a heading in an EARLIER sentence is not read to find the component", () => {
  // "Check the spacer." names a component, but a previous sentence is not
  // assumed to describe the figure. With no component in the label or the claim,
  // the figure is refused; a claim that names its own component decides.
  const chunk = "Check the spacer. 2.0 mm (0.079 in.) If the gap is greater than the maximum, replace the coupler.";
  const quote = "2.0 mm (0.079 in.)";
  assert.equal(outcome("The value is 2.0 mm (0.079 in.).", quote, chunk), REJECT_DETAIL);
  assert.equal(outcome("The spacer width is 2.0 mm (0.079 in.).", quote, chunk), "accept");
  assert.equal(outcome("The coupler gap is 2.0 mm (0.079 in.).", quote, chunk), REJECT_DETAIL);
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

  // Another sentence between them: not looked past (documented limit).
  assert.equal(
    outcome(
      "Flange Gap is 2.4 mm (0.0945 in.).",
      quote,
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
    "Replace the coupler when the maximum is reached.",
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

// ---- Bounded work ----

test("pathological text stays fast", () => {
  const filler = "greater than the maximum ".repeat(4000);
  const chunk = `Flange Gap 2.4 mm (0.0945 in.) ${filler}`;
  const started = Date.now();
  outcome("Flange Gap is 2.4 mm (0.0945 in.).", "Flange Gap 2.4 mm (0.0945 in.)", chunk);
  outcome("Flange Gap is 2.4 mm (0.0945 in.).", "Flange Gap 2.4 mm (0.0945 in.)", `${"2.4 mm (0.0945 in.) ".repeat(800)}If the gap is greater than the maximum, replace it.`);
  assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
});
