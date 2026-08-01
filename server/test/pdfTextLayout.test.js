import assert from "node:assert/strict";
import test from "node:test";

// Pure geometry: no PDF, no database, no network. Synthetic pdf.js text items
// make the reading-order property directly assertable.
import { buildPageTextFromItems } from "../src/services/pdfTextLayout.js";

/** A pdf.js-shaped text item. transform is [a, b, c, d, x, y]. */
const item = (text, x, y, width = text.length * 5, height = 10) => ({
  str: text,
  transform: [1, 0, 0, height, x, y],
  width,
  height,
});

// ---- The F3 defect: two-column reading order ----

test("column 1 is emitted in full before column 2 begins", () => {
  // The property that "group by y-band, sort by x" gets wrong: it produces
  // L1 R1 L2 R2 interleaving instead of L1 L2 ... R1 R2.
  const items = [
    item("Left line one", 50, 700, 120),
    item("Right line one", 320, 700, 120),
    item("Left line two", 50, 680, 120),
    item("Right line two", 320, 680, 120),
    item("Left line three", 50, 660, 120),
    item("Right line three", 320, 660, 120),
  ];

  const { text, columnCount } = buildPageTextFromItems(items);

  assert.equal(columnCount, 2);
  assert.equal(
    text,
    "Left line one Left line two Left line three Right line one Right line two Right line three"
  );
});

test("a torque value stays with its own column's label", () => {
  // The real hazard: interleaving can put a value next to an unrelated label.
  const items = [
    item("Oil pan drain plug", 50, 700, 120),
    item("Cylinder head bolt", 320, 700, 120),
    item("37 Nm", 50, 680, 40),
    item("49 Nm", 320, 680, 40),
  ];

  const { text } = buildPageTextFromItems(items);

  assert.match(text, /Oil pan drain plug 37 Nm/);
  assert.match(text, /Cylinder head bolt 49 Nm/);
  assert.ok(
    !/Oil pan drain plug Cylinder head bolt/.test(text),
    "columns must not interleave"
  );
});

test("layoutText preserves line breaks and separates columns", () => {
  const items = [
    item("Left one", 50, 700),
    item("Left two", 50, 680),
    item("Right one", 320, 700),
    item("Right two", 320, 680),
  ];

  const { layoutText } = buildPageTextFromItems(items);

  assert.equal(layoutText, "Left one\nLeft two\n\nRight one\nRight two");
});

test("the normalized text and the layout text carry the same order", () => {
  const items = [
    item("Alpha", 50, 700),
    item("Beta", 50, 680),
    item("Gamma", 320, 700),
  ];

  const { text, layoutText } = buildPageTextFromItems(items);

  assert.equal(text, layoutText.replace(/\s+/g, " ").trim());
});

// ---- Single-column and ordering basics ----

test("a single-column page is ordered top to bottom, left to right", () => {
  const items = [
    item("second line", 50, 680),
    item("first", 50, 700),
    item("line", 100, 700),
    item("third line", 50, 660),
  ];

  const { text, columnCount } = buildPageTextFromItems(items);

  assert.equal(columnCount, 1);
  assert.equal(text, "first line second line third line");
});

test("items on the same visual line are joined even with slight y jitter", () => {
  const items = [item("Torque", 50, 700.0), item(":", 100, 699.6), item("37 Nm", 110, 700.3)];

  const { layoutText } = buildPageTextFromItems(items);

  assert.equal(layoutText, "Torque : 37 Nm");
});

// ---- Conservatism: a wrong split is worse than no split ----

test("a table with internal gaps is NOT split into columns", () => {
  // A spanning header crosses the gap, which is how a table differs from a real
  // two-column layout.
  const items = [
    item("TORQUE SPECIFICATIONS TABLE", 50, 720, 400),
    item("Fastener", 50, 700, 80),
    item("Nm", 320, 700, 30),
    item("Oil pan drain plug", 50, 680, 120),
    item("37", 320, 680, 20),
  ];

  const { columnCount, text } = buildPageTextFromItems(items);

  assert.equal(columnCount, 1, "a spanning row means this is a table, not columns");
  assert.match(text, /Oil pan drain plug 37/);
});

test("a narrow gap is not treated as a gutter", () => {
  const items = [
    item("Left", 50, 700, 40),
    item("Right", 100, 700, 40),
    item("Left2", 50, 680, 40),
    item("Right2", 100, 680, 40),
  ];

  assert.equal(buildPageTextFromItems(items).columnCount, 1);
});

test("a short side note is not promoted to a column", () => {
  // One stray item on the right does not make the page two-column.
  const items = [
    item("Body line one", 50, 700, 200),
    item("Body line two", 50, 680, 200),
    item("Body line three", 50, 660, 200),
    item("Body line four", 50, 640, 200),
    item("note", 400, 700, 30),
  ];

  assert.equal(buildPageTextFromItems(items).columnCount, 1);
});

// ---- Input handling ----

test("empty and malformed input is handled safely", () => {
  for (const input of [[], null, undefined, "text", [{}, { str: "" }, { str: "  " }]]) {
    const result = buildPageTextFromItems(/** @type {any} */ (input));
    assert.equal(result.text, "");
    assert.equal(result.layoutText, "");
  }
});

test("items without a transform fall back to x/y fields", () => {
  const result = buildPageTextFromItems([
    { str: "alpha", x: 50, y: 700, width: 30, height: 10 },
    { str: "beta", x: 50, y: 680, width: 30, height: 10 },
  ]);

  assert.equal(result.text, "alpha beta");
});

test("items with non-finite coordinates are dropped rather than crashing", () => {
  const result = buildPageTextFromItems([
    { str: "good", transform: [1, 0, 0, 10, 50, 700], width: 30, height: 10 },
    { str: "bad", transform: [1, 0, 0, 10, NaN, 700], width: 30, height: 10 },
  ]);

  assert.equal(result.text, "good");
});
