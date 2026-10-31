import assert from "node:assert/strict";
import test from "node:test";

// The two column primitives are read through the namespace so a test run
// against a tree that does not have them yet fails test by test, naming the
// missing export, instead of failing to load this whole file.
import * as contract from "../src/services/askEvidenceContract.js";
import { ASK_ORACLE, F4_TABLES } from "./fixtures/evidenceOracle.js";

const {
  ASK_REJECTION_REASONS,
  checkClaimNumbers,
  checkClaimQualifiers,
  checkClaimRow,
  checkClaimSubject,
  checkUnrecognizedFigures,
  quoteAppearsInChunk,
  quoteRows,
  verifyEvidence,
} = contract;

// F4: a figure belongs to the column its cell sits under. The behavior is
// pinned row by row in the evidence oracle (`F4-*` and `control-F4-*`); this
// file holds what a one-verdict row cannot: the two primitives, the exact
// `detail` of each new rejection, the design choices that reject a valid claim
// on purpose, and the limits that stay open. Every table is invented text
// (F4_TABLES); none of it is manual text.

const T = F4_TABLES;

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

const f4Rows = ASK_ORACLE.filter((row) => /F4/.test(row.id) || /^F4/.test(row.finding));

// ---- The oracle rows reach the stage they are about ----

test("F4 oracle rows exist and every one passes the gates before the column logic", () => {
  assert.ok(f4Rows.length >= 28, `expected the F4 rows, found ${f4Rows.length}`);

  // A red row is only evidence about the column logic if the quote, the figures,
  // the part name and the row check all pass first. A row that died at an
  // earlier gate would "reject" for the wrong reason and prove nothing.
  for (const row of f4Rows) {
    const where = `${row.id}`;

    assert.ok(quoteAppearsInChunk(row.quote, row.chunkText), `${where}: quote is not in its chunk`);
    assert.equal(checkClaimNumbers(row.claim, row.quote).grounded, true, `${where}: numeric gate`);
    assert.equal(checkUnrecognizedFigures(row.claim, row.quote).grounded, true, `${where}: unrecognized figure gate`);
    assert.equal(checkClaimSubject(row.claim, row.quote).grounded, true, `${where}: subject gate`);
    assert.equal(checkClaimRow(row.claim, row.quote).grounded, true, `${where}: S1 row gate`);
  }
});

// ---- columnHeaderRun ----

test("columnHeaderRun reads two alternatives of one group, in the order printed", () => {
  const front = contract.columnHeaderRun("Ride height (unloaded): Front Rear Sedan");
  assert.deepEqual(front.alternatives, [0, 1]);
  assert.equal(front.group[0][0], "front");

  // The same words the other way round are the same columns in the other order.
  assert.deepEqual(contract.columnHeaderRun("Ride height: Rear Front Sedan").alternatives, [1, 0]);

  // Spellings count as their alternative: "LH" is left, "RH" is right.
  const sides = contract.columnHeaderRun("Shock tower LH Shock tower RH Bracket");
  assert.deepEqual(sides.alternatives, [0, 1]);
  assert.equal(sides.group[0][0], "left");
});

test("columnHeaderRun takes the longest CLEAN suffix, so words repeated earlier in the sentence do not hide a real header", () => {
  // A measuring-points list prints Rear and "lower" before the header. A rule
  // that wanted each word exactly once in the whole sentence would find no header
  // here, and "lower" is not a column at all.
  const label =
    "Reference marks: A lower link pin offset B Rear subframe pin offset " +
    "Ride height (unloaded): Front Rear Sedan";
  const run = contract.columnHeaderRun(label);

  assert.ok(run, "the Front/Rear header is found");
  assert.equal(run.group[0][0], "front");
  assert.deepEqual(run.alternatives, [0, 1]);
});

test("columnHeaderRun reads nothing when a header word repeats INSIDE the header", () => {
  // A row name that begins with a header word ("Front axle bracket") would
  // otherwise be taken as the header's second word, and the nearest occurrences
  // read as the header: "Front Rear Front axle" as Rear, Front. That reverses
  // the columns, so every cell lands under the wrong one. Which occurrence is the
  // header cannot be told from the words, so no run is read and the older rules
  // judge the row.
  assert.equal(contract.columnHeaderRun("Ride height: Front Rear Front axle bracket"), null);
  assert.equal(contract.columnHeaderRun("Ride height: Rear Front Rear Sedan"), null);
  assert.equal(contract.columnHeaderRun("Ride height: Front Rear Rear axle bracket"), null);

  // The same word printed well BEFORE the header is a different cluster, not an
  // ambiguity (the measuring-points case above).
  assert.ok(contract.columnHeaderRun("Rear note one two three four five six Front Rear Sedan"));
});

test("columnHeaderRun is bounded: header words far apart, or far from the values, are not a header", () => {
  const filler = (count) => Array.from({ length: count }, (_, index) => `w${index}`).join(" ");

  // MAX_GAP = 4 words between the two header words.
  assert.ok(contract.columnHeaderRun(`Front ${filler(4)} Rear Sedan`), "gap of 4 is a header");
  assert.equal(contract.columnHeaderRun(`Front ${filler(5)} Rear Sedan`), null, "gap of 5 is not");

  // MAX_TAIL = 8 words between the last header word and the first value.
  assert.ok(contract.columnHeaderRun(`Front Rear ${filler(8)}`), "tail of 8 is a header");
  assert.equal(contract.columnHeaderRun(`Front Rear ${filler(9)}`), null, "tail of 9 is not");
});

test("columnHeaderRun refuses what is not clearly one column header", () => {
  // Two groups both have two alternatives: which one are the columns?
  assert.equal(contract.columnHeaderRun("Inner Outer Front Rear Sedan"), null);

  // One alternative is a name ("front brake pad"), not a header.
  assert.equal(contract.columnHeaderRun("Front brake pad thickness"), null);
  assert.equal(contract.columnHeaderRun("Brake pad thickness"), null);

  // "with" is ordinary English, so with/without is never a column header.
  assert.equal(contract.columnHeaderRun("Oil change with filter without filter"), null);
});

// ---- quoteRowCells ----

function cellsOf(text) {
  const [row] = quoteRows(text);
  return contract.quoteRowCells(text, row).map(([start, end]) => text.slice(start, end));
}

test("quoteRowCells keeps a figure and its alternate-unit rendering in one cell", () => {
  const cells = cellsOf("Sedan 310 mm (12.2 in.) 295 mm (11.6 in.)");

  assert.equal(cells.length, 2);
  assert.match(cells[0], /^310 mm \(12\.2 in/);
  assert.match(cells[1], /^295 mm \(11\.6 in/);

  // Toyota prints a torque in three units in one parenthesis.
  assert.equal(cellsOf("Front Rear Sedan 120 N*m (89 ft.*lbf, 1,224 kgf*cm) 90 N*m (66 ft.*lbf, 918 kgf*cm)").length, 2);
});

test("quoteRowCells keeps a range in one cell and counts adjacent same-unit values as two", () => {
  assert.equal(cellsOf("Sensor Alpha 0.6 to 1.2 V 3.4 to 4.8 V").length, 2);
  assert.equal(cellsOf("Front Rear 230 kPa 220 kPa").length, 2);
  assert.equal(cellsOf("Front Rear Sedan 310 mm (12.2 in.) 295 mm (11.6 in.) 290 mm (11.4 in.)").length, 3);
});

test("quoteRowCells joins values linked by 'or', 'and' or 'at' into one cell", () => {
  // "10 mm or 12 mm" is one cell's alternatives, and "12 mm at 20 °C" is a value
  // with its measurement condition; neither is a second column.
  assert.equal(cellsOf("Front Rear Sedan 10 mm or 12 mm 9 mm").length, 2);
  assert.equal(cellsOf("Front Rear Sedan 25 mm and 30 mm 9 mm").length, 2);
  assert.equal(cellsOf("Front Rear Sedan 12 mm at 20 °C 9 mm at 20 °C").length, 2);
});

test("quoteRowCells keeps a value and its tolerance in one cell", () => {
  // "+/-", a dash, a tilde and a slash join values into one cell. Reading "1.5° +/-
  // 0.3°" as two cells would make a tolerance look like a row under two columns.
  assert.equal(cellsOf("Front Rear Sedan 1.5° +/- 0.3° 2° +/- 0.5°").length, 2);
  assert.equal(cellsOf("Front Rear Sedan 10 N*m / 12 N*m 9 N*m").length, 2);
  assert.equal(cellsOf("Front Rear Sedan 5 mm ~ 7 mm 9 mm").length, 2);
  assert.equal(cellsOf("Difference between left and right camber: 1.5° +/- 0.3°").length, 1);
});

test("quoteRowCells reads bare numbers only under a unit header", () => {
  assert.equal(cellsOf("Hub nut torque (N*m): Front Rear Sedan 120 90").length, 2);
});

// ---- Exact detail of each new rejection ----

const detailOf = (claim, quote, chunk) => checkClaimQualifiers(claim, quote, chunk).detail;

test("a claim naming the other column is rejected as wrong_column", () => {
  assert.equal(detailOf("For the sedan, the rear ride height is 310 mm.", T.rideFull, T.ride), "wrong_column");
  assert.equal(detailOf("For the sedan, the front ride height is 295 mm.", T.rideFull, T.ride), "wrong_column");
  assert.equal(detailOf("For the sedan, the rear ride height is 310 mm.", T.rideCut, T.ride), "wrong_column");
  assert.equal(detailOf("For the sedan, the rear ride height is 310 mm.", T.rideHeaderCut, T.ride), "wrong_column");
});

test("a claim naming no column of a clean column row is rejected as column_unstated, header quoted or not", () => {
  const claim = "The ride height is 310 mm.";

  assert.equal(detailOf(claim, T.rideFull, T.ride), "column_unstated");
  assert.equal(detailOf(claim, T.rideStripped, T.ride), "column_unstated");
  assert.equal(detailOf(claim, T.rideValuesOnly, T.ride), "column_unstated");
  // Equal figures in both columns do not make an unqualified claim safe.
  assert.equal(detailOf("The tire pressure is 230 kPa.", T.tireFull, T.tire), "column_unstated");
});

test("figures under different columns, or in an unalignable row, are column_unresolved", () => {
  // Correct, but no one column states both figures.
  assert.equal(
    detailOf("For the sedan, the ride height is 310 mm at the front and 295 mm at the rear.", T.rideFull, T.ride),
    "column_unresolved"
  );

  // A third cell under two headers: nothing can be placed.
  assert.equal(
    detailOf("For the sedan, the rear ride height is 310 mm.", T.rideFootQuote, T.rideFoot),
    "column_unresolved"
  );
});

test("an unalignable row that names no column is judged by the older rules, not the new ones", () => {
  // The header is in the quote and the claim states nothing: the F1v3 rule that
  // already existed rejects it. The new rules must not claim this case.
  assert.equal(detailOf("For the sedan, the ride height is 310 mm.", T.rideFootQuote, T.rideFoot), "condition_dropped");
});

test("a header run beside a single value is prose, not a table: restating its words names no column", () => {
  // "right and left" / "front and rear" are ordinary words here and one value
  // follows. A row needs at least two cells before a header run can be
  // 'unaligned'; below that the row is judged by the older rules, so a claim
  // quoting the manual's own sentence is not rejected for naming both words.
  assert.equal(
    detailOf("The height difference between the right and left strut caps is 2.0 mm or less.", T.rackQuote, T.rack),
    ""
  );
  assert.equal(
    detailOf("The difference between the front and rear wheel speed is 2 km/h or less.", T.speedQuote, T.speed),
    ""
  );
});

test("a right claim is judged grounded, with the figure's column printed in its quote", () => {
  for (const [claim, quote, chunk] of [
    ["For the sedan, the front ride height is 310 mm.", T.rideFull, T.ride],
    ["For the sedan, the rear ride height is 295 mm.", T.rideFull, T.ride],
    ["For the sedan, the front ride height is 310 mm.", T.rideCut, T.ride],
    ["For the sedan, the rear ride height is 295 mm.", T.rideHeaderCut, T.ride],
    ["For the sedan, the front ride height is 310 mm (12.2 in.).", T.rideFull, T.ride],
  ]) {
    const result = checkClaimQualifiers(claim, quote, chunk);

    assert.equal(result.grounded, true, `${claim} | ${quote}: ${result.detail}`);
  }
});

test("a claim that is true but whose quote does not print its column keeps the existing rejection", () => {
  // The column is attributable from the chunk, yet a condition must be printed
  // with its figure: this is the existing rule, and F4 must not relax it.
  assert.equal(
    detailOf("For the sedan, the front ride height is 310 mm.", T.rideStripped, T.ride),
    "condition_not_in_row"
  );
  assert.equal(
    detailOf("For the sedan, the front ride height is 310 mm.", T.rideHeaderCut, T.ride),
    "condition_not_in_row"
  );
});

// ---- Design choices that reject a valid claim on purpose ----

test("DESIGN: one claim spanning two columns is rejected, and the same facts split verify", () => {
  const both = verify(
    "For the sedan, the ride height is 310 mm at the front and 295 mm at the rear.",
    T.rideFull,
    T.ride
  );

  // This claim is TRUE. The verifier places each figure by its cell and has no
  // way to bind "front" to 310 inside one sentence, so it takes the safe
  // direction: the claim must be split, as the evidence prompt already asks.
  assert.equal(both.accepted, false);
  assert.equal(both.rejected.reason, "row_mismatch");
  assert.equal(both.rejected.detail, "column_unresolved");

  assert.equal(verify("For the sedan, the front ride height is 310 mm.", T.rideFull, T.ride).accepted, true);
  assert.equal(verify("For the sedan, the rear ride height is 295 mm.", T.rideFull, T.ride).accepted, true);
});

test("DESIGN: a figure naming its column through the alternate unit is the same cell", () => {
  assert.equal(
    verify("For the sedan, the front ride height is 310 mm (12.2 in.).", T.rideFull, T.ride).accepted,
    true
  );
  assert.equal(
    verify("For the sedan, the rear ride height is 310 mm (12.2 in.).", T.rideFull, T.ride).accepted,
    false
  );
});

// ---- Limits that stay open (each pinned so a change must be deliberate) ----

test("KNOWN LIMIT: two identical rows in one chunk give no reading, so the older rules decide", () => {
  const twin = `${T.rideFull}. ${T.rideFull}`;
  const claim = "For the sedan, the rear ride height is 310 mm.";

  // The quote matches two chunk rows, so the row it belongs to is not unique and
  // no column is attributed. The older rules then accept the wrong-column claim,
  // exactly as they did before F4. Repeating a whole row in one chunk is not
  // known to occur; if this is ever fixed, flip the assertion.
  assert.equal(verify(claim, T.rideFull, twin).accepted, true);
});

test("KNOWN LIMIT: a cut quote on a label that carries a foreign condition word is rejected", () => {
  // The label sentence of this table runs back through "lower link pin". The
  // chunk's own full row therefore reads as a sibling labelled "lower" and a cut
  // quote of it is rejected (unlabelled_row), although the claim is right. Making
  // a cut quote's own row stop counting as a sibling cured that, but also hid a
  // condition the quote dropped ("Minimum", "without", a trailing "or less"), and
  // no narrower rule could be shown safe, so a correct claim is lost here instead
  // of an incorrect one being let in. If this is ever fixed, flip the assertion.
  const right = "For the sedan, the front ride height is 310 mm.";

  assert.equal(verify(right, T.rideCut, T.ridePrelude).accepted, false);
  assert.equal(verify(right, T.rideCut, T.ridePrelude).rejected.detail, "unlabelled_row");
  // The same cut on a label without the foreign word verifies: only the foreign
  // word is the problem.
  assert.equal(verify(right, T.rideCut, T.ride).accepted, true);
});

test("a cut quote that drops a printed condition is rejected, whatever the column", () => {
  const cases = [
    ["Brake service. Minimum disc thickness Front Rear 23.0 mm (0.906 in.) 9.0 mm (0.354 in.)", "disc thickness Front Rear 23.0 mm (0.906 in.)", "The disc thickness at the front is 23.0 mm."],
    ["Disc service. Disc runout Front Rear 0.05 mm (0.0020 in.) 0.07 mm (0.0028 in.) or less", "Disc runout Front Rear 0.05 mm (0.0020 in.)", "The front disc runout is 0.05 mm."],
  ];

  for (const [chunk, quote, claim] of cases) {
    assert.equal(verify(claim, quote, chunk).accepted, false, claim);
  }
});

test("a quote tied to no single chunk row still reads as a column table when it prints a column row's cells", () => {
  const stated = (claim, quote, chunk) => verify(claim, quote, chunk).rejected?.detail;

  // Starting at the second cell, at a first cell two rows share, or inside a cell:
  // no one row's values start with the quote, yet the cells are a column row's.
  assert.equal(stated("The ride height is 295 mm.", "295 mm (11.6 in.)", T.ride), "column_unstated");
  assert.equal(stated("The ride height is 310 mm.", "310 mm (12.2 in.)", T.rideSame), "column_unstated");
  assert.equal(stated("The ride height is 12.2 in.", "12.2 in.", T.ride), "column_unstated");

  // Naming a column does not rescue it: the quote still must print the word.
  assert.equal(stated("The rear ride height is 295 mm.", "295 mm (11.6 in.)", T.ride), "condition_not_in_row");

  // A figure not printed inside the column row is not affected.
  assert.equal(verify("The winter package adds 10 mm.", "Add 10 mm for the winter package", T.ride).accepted, true);
});

test("a quote tied to no single row is read as a column table only for an ALIGNED column row", () => {
  // Three cells under two headers: not aligned, so the row is not read. A
  // label-less quote of its second cell matches no row's values, and the older
  // rules decide (a claim naming no column is judged as before). The unaligned
  // rule only rejects a claim that NAMES a column of such a header.
  const stated = (claim, quote, chunk) => verify(claim, quote, chunk).rejected?.detail;

  assert.equal(verify("The ride height is 295 mm.", "295 mm (11.6 in.)", T.rideFoot).accepted, true);
  assert.equal(stated("The ride height is 295 mm.", "295 mm (11.6 in.)", T.ride), "column_unstated");
  // A figure that is only digits inside a longer number is not that column row's.
  assert.equal(verify("The value is 10 mm.", "10 mm", T.rideSpacer).accepted, true);
});

test("KNOWN LIMIT: a row that relies on a header above it keeps no reading even for a label-less quote of its own cells", () => {
  // The wagon row prints no header of its own; its cells equal no cell of the
  // sedan row, so nothing ties them to the column table. Reading a header for the
  // rows that rely on it is the first follow-up.
  assert.equal(verify("For the wagon, the ride height is 320 mm.", "320 mm (12.6 in.)", T.ride).accepted, true);
});

test("KNOWN LIMIT: a row name that repeats a header word leaves the header unread, so the older rules decide", () => {
  const chunk =
    "Ride height (unloaded): Front Rear Front axle bracket 310 mm (12.2 in.) 295 mm (11.6 in.)";

  // The true header is Front, Rear and 310 mm is under Front. The header is
  // ambiguous (see columnHeaderRun), so no column is read: the right claim is no
  // longer rejected as the wrong column, and the older rules accept the wrong one
  // exactly as they did before F4. If this is ever fixed, flip the second assertion.
  assert.equal(
    verify("The front ride height for the axle bracket is 310 mm.", chunk, chunk).accepted,
    true
  );
  assert.equal(
    verify("The rear ride height for the axle bracket is 310 mm.", chunk, chunk).accepted,
    true
  );
});

test("KNOWN LIMIT: a column row with a blank cell prints one value, so it is not read as a table", () => {
  // One value under a two-column header (the other cell is blank in the PDF).
  // Below two cells the row is not read, so the older rules decide, and they
  // accept a wrong-column claim here exactly as they did before F4: the verifier
  // cannot tell which column the lone value is under. If this is ever fixed,
  // flip the assertion.
  const blank = "Ride height (unloaded): Front Rear Sedan 295 mm (11.6 in.)";

  assert.equal(
    verify("For the sedan, the front ride height is 295 mm.", blank, blank).accepted,
    true
  );
});

test("KNOWN LIMIT: the header is read from a row's own label, so a row that relies on a header above it is not attributed", () => {
  // Wagon is the second row. Its own label prints no header, so the verifier
  // cannot place its cells under Front/Rear: a wrong-column claim is still
  // rejected (the column is not printed in the wagon sentence), the right-column
  // claim is rejected too, and a claim naming no column is ACCEPTED. The
  // verifier is therefore NOT fail-closed for the rows after a table's first.
  const rejects = (claim) => verify(claim, T.rideTwoRow, T.ride).accepted === false;

  assert.ok(rejects("For the wagon, the rear ride height is 320 mm."), "wrong column: rejected");
  assert.ok(rejects("For the wagon, the front ride height is 320 mm."), "right column: rejected (a loss)");
  assert.equal(
    verify("For the wagon, the ride height is 320 mm.", T.rideTwoRow, T.ride).accepted,
    true,
    "no column: accepted (the false accept left open)"
  );
});

// ---- Nothing else moved ----

test("F4 adds no rejection reason: the new rejections are details of row_mismatch", () => {
  assert.deepEqual(
    [...ASK_REJECTION_REASONS],
    [
      "unknown_source",
      "quote_not_in_source",
      "quote_too_short",
      "numeric_anomaly",
      "unrecognized_figure",
      "subject_mismatch",
      "row_mismatch",
      "unsourced_specification",
      "unsourced_gap_specification",
    ]
  );
});
