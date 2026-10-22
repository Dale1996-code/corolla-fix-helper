import assert from "node:assert/strict";
import test from "node:test";

// Pure classification logic: no database, no network, no API key. Every string
// here is SYNTHETIC manual-style text -- the repository is public, so no real
// manual text may appear in a test.
import {
  APPLICABILITY_SCOPE_VERSION,
  KNOWN_ENGINE_CODES,
  PLANT_VALUES,
  blankAccountHeader,
  findScopeMarkers,
} from "../src/services/applicabilityScope.js";

/** The marker fields a test cares about, in order. */
function shape(text) {
  return findScopeMarkers(text).map(({ axis, kind, value, exclude }) => ({
    axis,
    kind,
    value,
    exclude,
  }));
}

const engine = (kind, value) => ({ axis: "engine", kind, value, exclude: false });
const plant = (kind, value, exclude = false) => ({ axis: "plant", kind, value, exclude });

// ---- constants ----

test("the scope version and the known values are pinned", () => {
  assert.equal(APPLICABILITY_SCOPE_VERSION, "scope-v1");
  assert.deepEqual(KNOWN_ENGINE_CODES, [
    "2ZR-FE",
    "2AZ-FE",
    "1NZ-FE",
    "1NR-FE",
    "1AR-FE",
    "2AR-FE",
    "1UR-FE",
    "3UR-FE",
  ]);
  assert.deepEqual(PLANT_VALUES, ["TMC", "NUMMI", "TMMC", "TMMT"]);
});

// ---- the account header is never a marker ----

test("the account header is blanked to spaces, keeping every offset", () => {
  const text = "Corolla  L4-1.8L ( 2ZR-FE ) x";
  const blanked = blankAccountHeader(text);

  assert.equal(blanked.length, text.length);
  assert.ok(!blanked.includes("2ZR"));
  assert.ok(blanked.endsWith(" x"));
});

test("the account header is blanked across a nonbreaking space", () => {
  const nbsp = String.fromCharCode(0xa0);
  const text = `2009 Toyota Corolla${nbsp}L4-1.8L (2ZR-FE) Vehicle`;

  assert.ok(!blankAccountHeader(text).includes("2ZR"));
});

test("an article title names its engine; the header beside it names nothing", () => {
  assert.deepEqual(
    shape(
      "2009 Toyota Corolla L4-1.8L (2ZR-FE) Vehicle > Locations > Position Of Parts (2AZ-FE) Locations: The relay box"
    ),
    [engine("article_title", "2AZ-FE")]
  );
});

// ---- marker kinds ----

test("(for X) blocks are inline markers, in order", () => {
  assert.deepEqual(
    shape("COMPRESSOR (for 2AZ-FE) Bolt x Engine 25 N*m COMPRESSOR (for 2ZR-FE) Bolt x Engine 25 N*m"),
    [engine("inline_for", "2AZ-FE"), engine("inline_for", "2ZR-FE")]
  );
});

test("a diagram title carries both an engine and an excluded plant", () => {
  assert.deepEqual(shape("Engine Control <2AZ-FE , Except TMC Made> (IG)"), [
    engine("diagram_title", "2AZ-FE"),
    plant("diagram_title", "TMC", true),
  ]);
});

test("a cross-reference link names an engine without scoping the text around it", () => {
  assert.deepEqual(shape("See Procedure 2ZR-FE [ 2ZR-FE ENGINE MECHANICAL: DRIVE BELT+ ]"), [
    engine("link", "2ZR-FE"),
    engine("link", "2ZR-FE"),
  ]);
});

test("legend keys are legend markers", () => {
  assert.deepEqual(shape("* 2: 2AZ-FE * 3: 2ZR-FE"), [
    engine("legend", "2AZ-FE"),
    engine("legend", "2ZR-FE"),
  ]);
});

test("two engine codes side by side are column headers", () => {
  assert.deepEqual(shape("Item 2ZR-FE 2AZ-FE Height 92 96"), [
    engine("column_header", "2ZR-FE"),
    engine("column_header", "2AZ-FE"),
  ]);
});

test("bare engine and plant names in a table are row labels", () => {
  assert.deepEqual(shape("for TMC Made 2ZR-FE 92 mm except TMC Made 2ZR-FE 92 mm 2AZ-FE 96 mm"), [
    plant("row_label", "TMC"),
    engine("row_label", "2ZR-FE"),
    plant("row_label", "TMC", true),
    engine("row_label", "2ZR-FE"),
    engine("row_label", "2AZ-FE"),
  ]);
});

test("plants: lowercase 'made', TMMT, and a parenthesized plant", () => {
  assert.deepEqual(shape("for TMMT made 81 N*m for TMC made 52 N*m"), [
    plant("row_label", "TMMT"),
    plant("row_label", "TMC"),
  ]);
  assert.deepEqual(shape("Cruise Control (2AZ-FE) (Except TMC Made) wiring"), [
    engine("row_label", "2AZ-FE"),
    plant("inline_for", "TMC", true),
  ]);
  assert.deepEqual(shape("Engine mount (NUMMI Made) 81 N*m"), [plant("inline_for", "NUMMI")]);
});

test("an article title can scope a plant as well as an engine", () => {
  assert.deepEqual(shape("Vehicle > Cruise Control (2AZ-FE) (Except TMC Made) NOTICE: check"), [
    engine("article_title", "2AZ-FE"),
    plant("article_title", "TMC", true),
  ]);
});

test("filename-style underscores still read as a plant", () => {
  assert.deepEqual(shape("ABS_(w_o_VSC)_(TMC_Made)"), [plant("inline_for", "TMC")]);
});

// ---- Review Focus 1: OCR-mangled codes ----

test("an OCR-split engine code is still recognized", () => {
  assert.deepEqual(shape("ECM (for 2AZ- FE) removal"), [engine("inline_for", "2AZ-FE")]);
  assert.deepEqual(shape("2ZRFE 37 N*m"), [engine("row_label", "2ZR-FE")]);
});

test("an engine code nobody has seen in this corpus is unknown, not another engine", () => {
  assert.deepEqual(shape("Sensor (for 2ZA-FE) 12 V"), [engine("unknown_code", "2ZA-FE")]);
});

// ---- false positives ----

test("gear names, part numbers, trouble codes and engine sizes are not markers", () => {
  assert.deepEqual(shape("2ND-GEAR 4WD-FOUR 1ST-GEAR"), []);
  assert.deepEqual(shape("Part 90919-01253 DTC P0301 transaxle U341E or C59 engine 1.8L and 2.4L"), []);
  assert.deepEqual(shape("w/ VSC and w/o VSC"), []);
});
