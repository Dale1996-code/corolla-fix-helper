import assert from "node:assert/strict";
import test from "node:test";

// The primitive is read through the namespace so a run against a tree that
// does not have it yet fails test by test, naming the missing export.
import * as contract from "../src/services/askEvidenceContract.js";

const { checkClaimNumbers, unitColumnCells, verifyEvidence } = contract;

// N4-U: a torque table prints its units once, as a header run ("N*m kgf*cm
// ft.*lbf"), then each row as that many bare numbers. A bare number is printed
// in the unit of the column it sits under, and in no other. The evidence
// oracle's N4-U rows pin the verdicts; this file holds the primitive, the
// shapes it deliberately does not read, and a generated-table property. Every
// table here is invented text.

const HEADER = "Part tightened N*m kgf*cm ft.*lbf";

function verify(claim, quote, chunkText = `${quote} Replace the gasket.`) {
  const result = verifyEvidence(
    { documentSupported: [{ claim, sourceId: "S1", evidenceQuote: quote }], generalGuidance: [], gaps: [] },
    [{ documentId: 1, documentTitle: "Invented", originalFilename: "x.pdf", pageNumber: 1, chunkIndex: 0, chunkText }]
  );

  return result.documentSupported.length ? "accept" : result.rejected[0]?.reason;
}

const cellsOf = (text) => unitColumnCells(text).map(({ unit, raw }) => `${raw} ${unit}`);

// ---- The primitive ----

test("each bare number of a row is placed under the header unit at its position", () => {
  assert.deepEqual(cellsOf(`${HEADER} Oil pan drain plug 37 377 27`), ["37 N*m", "377 kgf*cm", "27 ft.*lbf"]);
});

test("every row under one header is read, each as its own row", () => {
  assert.deepEqual(cellsOf(`${HEADER} Oil pan drain plug 37 377 27 Oil filter cap 25 255 18`), [
    "37 N*m",
    "377 kgf*cm",
    "27 ft.*lbf",
    "25 N*m",
    "255 kgf*cm",
    "18 ft.*lbf",
  ]);
});

test("a header with each unit in brackets reads like a bare one", () => {
  assert.deepEqual(cellsOf("Part tightened (N*m) (kgf*cm) (ft.*lbf) Drain plug 37 377 27"), [
    "37 N*m",
    "377 kgf*cm",
    "27 ft.*lbf",
  ]);
});

test("a decimal cell and a footnote mark after the last cell do not move a column", () => {
  assert.deepEqual(cellsOf(`${HEADER} Bracket bolt 7.8 80 69 *1`), ["7.8 N*m", "80 kgf*cm", "69 ft.*lbf"]);
});

test("shapes that are not read: no cell is placed, so the fallback behaves as before", () => {
  for (const [what, text] of [
    ["fewer numbers than units", `${HEADER} Oil pan drain plug 37 27`],
    ["more numbers than units", `${HEADER} Oil pan drain plug 37 377 27 30`],
    ["a label ending in a number", `${HEADER} Bolt No. 2 37 377 27`],
    ["two rows run together with no label between them", `${HEADER} 37 377 27 25 255 18`],
    ["a single-unit header", "Tightening torque (N*m): drain plug 37 filter cap 25"],
    ["one unit printed twice", "Torque N*m N*m Front bolt 37 40"],
    ["units not side by side", "Torque in N*m, or in ft.*lbf if preferred: bolt 37 27"],
    ["a range as a cell", `${HEADER} Drain plug 37 - 43 377 27`],
    ["a range as the last cell", `${HEADER} Drain plug 37 377 27 to 30`],
    ["a tolerance as a cell", `${HEADER} Drain plug 37 +/- 4 377 27`],
    // Numbers inside names are not cells, here a tire size and its load index.
    ["pieces of a name", "Tire size Front kPa (kgf/cm2, psi) P185/65R15 88S 185/65R15 90H"],
  ]) {
    assert.deepEqual(unitColumnCells(text), [], what);
  }
});

test("a row is read only under its own header: a second header starts a new table", () => {
  const text = `${HEADER} Drain plug 37 377 27 Item mm in. Pad thickness 12.0 0.472`;
  const cells = cellsOf(text);

  assert.deepEqual(cells.slice(0, 3), ["37 N*m", "377 kgf*cm", "27 ft.*lbf"]);
  assert.ok(!cells.includes("12.0 ft.*lbf") && !cells.includes("0.472 N*m"), cells.join(", "));
});

// ---- Verdicts the oracle rows do not show ----

test("the numeric check itself refuses a number in another column's unit", () => {
  const quote = `${HEADER} Oil pan drain plug 37 377 27`;

  assert.equal(checkClaimNumbers("The torque is 37 N*m.", quote).grounded, true);
  assert.equal(checkClaimNumbers("The torque is 37 ft-lbf.", quote).grounded, false);
  assert.equal(checkClaimNumbers("The torque is 377 N*m.", quote).grounded, false);
  assert.equal(checkClaimNumbers("The torque is 27 lb-ft.", quote).grounded, true);
});

test("a quote with no header run, or a single header unit, is judged exactly as before", () => {
  assert.equal(verify("The drain plug torque is 37 N*m.", "Tightening torque (N*m): drain plug 37"), "accept");
  const inline = "Drain plug torque: 37 N*m (377 kgf*cm, 27 ft.*lbf)";

  assert.equal(verify("The drain plug torque is 37 N*m.", inline), "accept");
  assert.equal(verify("The drain plug torque is 27 N*m.", inline), "numeric_anomaly");
});

test("a row that is not read keeps the old verdict, right and wrong (the pinned limit)", () => {
  const quote = `${HEADER} Oil pan drain plug 37 27`;

  // Accepted before and after: which unit each number is under cannot be read.
  assert.equal(verify("The oil pan drain plug torque is 37 N*m.", quote), "accept");
  assert.equal(verify("The oil pan drain plug torque is 37 ft-lbf.", quote), "accept");
});

test("a wrong-column figure is redacted from its gap like any other unverified figure", () => {
  const quote = `${HEADER} Oil pan drain plug 37 377 27`;
  const result = verifyEvidence(
    {
      documentSupported: [{ claim: "The oil pan drain plug torque is 377 N*m.", sourceId: "S1", evidenceQuote: quote }],
      generalGuidance: [],
      gaps: [],
    },
    [{ documentId: 1, documentTitle: "Invented", originalFilename: "x.pdf", pageNumber: 1, chunkIndex: 0, chunkText: quote }]
  );

  assert.equal(result.rejected[0].reason, "numeric_anomaly");
  assert.ok(result.gaps.every((gap) => !gap.includes("377")), result.gaps.join(" | "));
});

// ---- A quote cut off its last number's own unit ----
//
// Small torques print their last cell in in*lbf under the ft*lbf header. A
// quote that stops before that unit used to read "35" as the ft*lbf cell.

const SMALL_ROW_CHUNK = `${HEADER} Trim bracket x Panel 4.0 41 35 in.*lbf Drain plug 37 377 27`;
const SMALL_ROW_CUT = `${HEADER} Trim bracket x Panel 4.0 41 35`;

test("a number the chunk prints with the unit the quote cut off is printed in that unit", () => {
  assert.equal(verify("The trim bracket torque is 35 ft-lbf.", SMALL_ROW_CUT, SMALL_ROW_CHUNK), "numeric_anomaly");
  // The cells before it keep their columns.
  assert.equal(verify("The trim bracket torque is 4.0 N*m.", SMALL_ROW_CUT, SMALL_ROW_CHUNK), "accept");
  assert.equal(verify("The trim bracket torque is 41 kgf*cm.", SMALL_ROW_CUT, SMALL_ROW_CHUNK), "accept");
});

test("the cut-off unit is not a header unit, so the claim in it is still refused (safe, pinned)", () => {
  // The quote prints no in*lbf anywhere: the bare fallback has nothing to read
  // it from, as before. Quoting the unit verifies it.
  assert.equal(verify("The trim bracket torque is 35 in-lbf.", SMALL_ROW_CUT, SMALL_ROW_CHUNK), "numeric_anomaly");
  assert.equal(verify("The trim bracket torque is 35 in-lbf.", `${SMALL_ROW_CUT} in.*lbf`, SMALL_ROW_CHUNK), "accept");
});

test("what follows a quote is a cut-off unit only when it reads as one", () => {
  const quote = `${HEADER} Oil pan drain plug 37 377 27`;

  // A word, the next row, or a fuse rating after the last number changes nothing.
  for (const after of [" Replace the gasket.", " Oil filter cap 25 255 18", " A Fuse 10"]) {
    assert.equal(verify("The oil pan drain plug torque is 27 ft-lbf.", quote, `${quote}${after}`), "accept", after);
  }
});

test("a quote the chunk prints twice is read only if both placements cut the same unit (pinned)", () => {
  const quote = `${HEADER} Bolt 4.0 41 35`;
  const chunk = `${quote} in.*lbf. ${quote} Clip.`;

  // One placement prints no unit after 35, so nothing is known: as before.
  assert.equal(verify("The bolt torque is 35 ft-lbf.", quote, chunk), "accept");
  assert.equal(verify("The bolt torque is 35 ft-lbf.", quote, `${quote} in.*lbf. ${quote} in.*lbf.`), "numeric_anomaly");
  // Two placements cutting two different units: nothing is known either.
  assert.equal(verify("The bolt torque is 35 ft-lbf.", quote, `${quote} in.*lbf. ${quote} N*m.`), "accept");
});

test("the planner's shared numeric check reads no chunk, so it is unchanged by the cut-off rule", () => {
  assert.equal(checkClaimNumbers("The torque is 35 ft-lbf.", SMALL_ROW_CUT).grounded, true);
});

// ---- Generated tables ----
//
// For every invented table of K units and R rows, with values drawn from a
// small pool so that numbers repeat across rows and columns, the numeric check
// must ground "value V in unit U" exactly when some cell under U prints V. The
// row and subject checks run after it and are not part of this property.

const UNIT_POOL = [
  ["N*m", "N*m"],
  ["kgf*cm", "kgf*cm"],
  ["ft.*lbf", "ft-lbf"],
  ["in.*lbf", "in-lbf"],
];

function seededRandom(seed) {
  let state = seed >>> 0;

  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

test("generated tables: a figure is grounded exactly when its own column prints it", () => {
  const random = seededRandom(20261128);
  const pick = (list) => list[Math.floor(random() * list.length)];
  const values = [5, 8, 12, 18, 25, 27, 37, 55, 80, 120];
  let checked = 0;

  for (let table = 0; table < 300; table += 1) {
    const k = 2 + Math.floor(random() * 3);
    const units = [...UNIT_POOL].sort(() => random() - 0.5).slice(0, k);
    const rows = Array.from({ length: 1 + Math.floor(random() * 3) }, () =>
      Array.from({ length: k }, () => pick(values))
    );
    const text = `Part tightened ${units.map(([header]) => header).join(" ")} ${rows
      .map((cells, index) => `Bolt ${"ABC"[index]} ${cells.join(" ")}`)
      .join(" ")}`;

    for (const [column, [, claimUnit]] of units.entries()) {
      for (const value of values) {
        const printedUnder = rows.some((cells) => cells[column] === value);
        const grounded = checkClaimNumbers(`The torque is ${value} ${claimUnit}.`, text).grounded;

        assert.equal(grounded, printedUnder, `${value} ${claimUnit} against "${text}"`);
        checked += 1;
      }
    }
  }

  assert.ok(checked > 2000, `checked ${checked}`);
});
