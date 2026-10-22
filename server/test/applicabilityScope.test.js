import assert from "node:assert/strict";
import test from "node:test";

// Pure classification logic: no database, no network, no API key. Every string
// here is SYNTHETIC manual-style text -- the repository is public, so no real
// manual text may appear in a test.
import {
  APPLICABILITY_SCOPE_VERSION,
  EMPTY_SCOPE,
  KNOWN_ENGINE_CODES,
  PLANT_VALUES,
  blankAccountHeader,
  classifyScope,
  computeDocumentScopes,
  findScopeMarkers,
  resolveSegments,
  scopeAt,
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

// ---- segments: what scope is in effect at a character offset ----

/** Scope in effect at the `occurrence`-th match of `needle` in `text`. */
function scopeOf(text, needle, { occurrence = 1, carryIn } = {}) {
  let at = -1;
  for (let seen = 0; seen < occurrence; seen += 1) {
    at = text.indexOf(needle, at + 1);
    assert.ok(at !== -1, `"${needle}" #${occurrence} not found`);
  }
  return scopeAt(resolveSegments(text, { carryIn }).segments, at);
}

test("a (for X) block lasts until the next one on the same axis", () => {
  const text = "COMPRESSOR (for 2AZ-FE) Bolt 25 N*m COMPRESSOR (for 2ZR-FE) Bolt 26 N*m";

  assert.equal(scopeOf(text, "25 N*m").engine.value, "2AZ-FE");
  assert.equal(scopeOf(text, "26 N*m").engine.value, "2ZR-FE");
  assert.equal(scopeOf(text, "COMPRESSOR").engine, null, "text before the first marker is unscoped");
});

test("a numbered step ends an inline scope", () => {
  const text = "5. REMOVE ECM (for 2AZ-FE) torque 9 N*m 6. INSTALL BRACKET torque 12 N*m";

  assert.equal(scopeOf(text, "9 N*m").engine.value, "2AZ-FE");
  assert.equal(scopeOf(text, "12 N*m").engine, null);
});

test("row labels scope the figures that follow them", () => {
  const text = "except TMC Made 2ZR-FE 92 mm 80 mm 2AZ-FE 96 mm 81 mm";

  assert.equal(scopeOf(text, "92 mm").engine.value, "2ZR-FE");
  assert.equal(scopeOf(text, "96 mm").engine.value, "2AZ-FE");
  assert.deepEqual(scopeOf(text, "96 mm").plant, { value: "TMC", exclude: true, kind: "row_label" });
});

test("a legend or a column header leaves the rest of the page unresolved", () => {
  assert.deepEqual(scopeOf("Wire color * 2: 2AZ-FE * 3: 2ZR-FE output 5 V", "5 V").engine, {
    unresolved: true,
    kind: "legend",
  });
  assert.equal(scopeOf("Item 2ZR-FE 2AZ-FE Height 92 96", "92").engine.unresolved, true);
  assert.equal(scopeOf("Sensor (for 2ZA-FE) 12 V", "12 V").engine.unresolved, true);
});

test("unresolved beats an inline scope; inline beats a diagram title", () => {
  const diagram = "Engine Control <2AZ-FE , Except TMC Made> (for 2ZR-FE) 5 V 7. CHECK harness 8 V";
  assert.equal(scopeOf(diagram, "5 V").engine.value, "2ZR-FE", "inline beats the diagram");
  assert.equal(scopeOf(diagram, "8 V").engine.value, "2AZ-FE", "after the step, the diagram is back");

  const legend = "(for 2ZR-FE) * 2: 2AZ-FE wire 5 V";
  assert.equal(scopeOf(legend, "5 V").engine.unresolved, true);
});

test("a link never scopes the text around it", () => {
  const text = "INSPECT DRIVE BELT See Procedure 2AZ-FE [ 2AZ-FE ENGINE MECHANICAL: DRIVE BELT+ ] tension 7 mm";

  assert.equal(scopeOf(text, "7 mm").engine, null);
});

test("an article line resets scope even when its title names no engine", () => {
  const text = "(for 2AZ-FE) torque 9 N*m Vehicle > Brakes > Pad Replacement HINT: torque 30 N*m";

  assert.equal(scopeOf(text, "9 N*m").engine.value, "2AZ-FE");
  assert.equal(scopeOf(text, "30 N*m").engine, null);
});

test("a carried-in scope is only ever an article or a diagram scope", () => {
  const carried = { engine: { value: "2AZ-FE", exclude: false, kind: "article_title" }, plant: null };
  assert.equal(scopeOf("Bolt 40 N*m", "40 N*m", { carryIn: carried }).engine.value, "2AZ-FE");

  const notCarried = { engine: { value: "2AZ-FE", exclude: false, kind: "inline_for" }, plant: null };
  assert.equal(scopeOf("Bolt 40 N*m", "40 N*m", { carryIn: notCarried }).engine, null);
});

test("scopeAt on empty text is the empty scope", () => {
  assert.deepEqual(scopeAt(resolveSegments("").segments, 0), EMPTY_SCOPE);
});

// ---- documents: entry scope of every stored chunk ----

test("an article title scopes later pages; an inline block does not", () => {
  const withArticle = computeDocumentScopes([
    { pageNumber: 1, text: "Vehicle > Engine > Torque Specifications (2AZ-FE) NOTICE: (for 2ZR-FE) 30 N*m" },
    { pageNumber: 2, text: "Bolt 40 N*m" },
  ]);
  assert.deepEqual(withArticle[1].chunks[0].entryScope.engine, {
    value: "2AZ-FE",
    exclude: false,
    kind: "article_title",
  });

  const inlineOnly = computeDocumentScopes([
    { pageNumber: 1, text: "(for 2AZ-FE) Bolt 30 N*m" },
    { pageNumber: 2, text: "Bolt 40 N*m" },
  ]);
  assert.equal(inlineOnly[1].chunks[0].entryScope.engine, null);
});

test("an unresolved region does not reach the next page", () => {
  const pages = computeDocumentScopes([
    { pageNumber: 1, text: "Wire color * 2: 2AZ-FE output 5 V" },
    { pageNumber: 2, text: "Sensor output 5 V" },
  ]);

  assert.equal(pages[1].chunks[0].entryScope.engine, null);
});

test("a later chunk of a page inherits the scope it starts inside", () => {
  const words = Array.from({ length: 450 }, (_, index) => `w${index + 1}`);
  words.splice(9, 1, "(for", "2AZ-FE)");
  const [page] = computeDocumentScopes([{ pageNumber: 1, text: words.join(" ") }]);

  assert.equal(page.chunks.length, 3);
  assert.equal(page.chunks[0].entryScope.engine, null, "chunk 0 starts before the marker");
  assert.equal(page.chunks[2].entryScope.engine.value, "2AZ-FE");
  assert.equal(page.chunks[2].ownMarkers.length, 0, "chunk 2 names no engine itself");
  assert.equal(page.chunks[0].ownMarkers[0].value, "2AZ-FE");
});

test("a page holding only the account header is unscoped everywhere", () => {
  const [page] = computeDocumentScopes([
    {
      pageNumber: 1,
      text: "ALLDATA DIY article export 2009 Toyota Corolla L4-1.8L (2ZR-FE) Vehicle > Brakes > Front Pad Replacement HINT: torque 107 N*m",
    },
  ]);

  for (const chunk of page.chunks) {
    assert.deepEqual(chunk.entryScope, EMPTY_SCOPE);
  }
  assert.deepEqual(scopeAt(page.segments, page.text.indexOf("107")), EMPTY_SCOPE);
});

test("empty documents and empty pages are handled", () => {
  assert.deepEqual(computeDocumentScopes([]), []);
  const [page] = computeDocumentScopes([{ pageNumber: 4, text: "" }]);
  assert.equal(page.pageNumber, 4);
  assert.deepEqual(page.chunks, []);
});

test("pages are processed in page order whatever order they arrive in", () => {
  const pages = computeDocumentScopes([
    { pageNumber: 2, text: "Bolt 40 N*m" },
    { pageNumber: 1, text: "Vehicle > Engine > Specs (2AZ-FE) NOTICE: x" },
  ]);

  assert.deepEqual(pages.map((page) => page.pageNumber), [1, 2]);
  assert.equal(pages[1].chunks[0].entryScope.engine.value, "2AZ-FE");
});

// ---- classifyScope: a scope against the owner's vehicle profile ----

const OWNER = {
  engineCode: "2ZR-FE",
  buildPlant: "NUMMI",
  transmissionCode: null,
  hasVsc: null,
  hasSmartKey: null,
};
const ENGINE_2AZ = { value: "2AZ-FE", exclude: false, kind: "row_label" };
const ENGINE_2ZR = { value: "2ZR-FE", exclude: false, kind: "inline_for" };
const EXCEPT_TMC = { value: "TMC", exclude: true, kind: "diagram_title" };
const UNRESOLVED = { unresolved: true, kind: "legend" };
const BOTH_AXES = { axes: ["engine", "plant"] };

for (const [label, scope, profile, options, expected] of [
  ["another engine", { engine: ENGINE_2AZ, plant: null }, OWNER, undefined, "other_variant"],
  ["the owner's engine", { engine: ENGINE_2ZR, plant: null }, OWNER, undefined, "applies"],
  ["no variant named", EMPTY_SCOPE, OWNER, undefined, "not_stated"],
  ["an unresolved region", { engine: UNRESOLVED, plant: null }, OWNER, undefined, "unresolved"],
  [
    "the owner's engine code left blank (Review Focus 3)",
    { engine: ENGINE_2ZR, plant: null },
    { ...OWNER, engineCode: null },
    undefined,
    "unresolved",
  ],
  ["'Except TMC' for a NUMMI car", { engine: null, plant: EXCEPT_TMC }, OWNER, BOTH_AXES, "applies"],
  [
    "'Except TMC' for a TMC car",
    { engine: null, plant: EXCEPT_TMC },
    { ...OWNER, buildPlant: "TMC" },
    BOTH_AXES,
    "other_variant",
  ],
  [
    "'for TMMT made' for a NUMMI car",
    { engine: null, plant: { value: "TMMT", exclude: false, kind: "row_label" } },
    OWNER,
    BOTH_AXES,
    "other_variant",
  ],
  [
    "a plant scope with the owner's plant unknown",
    { engine: ENGINE_2ZR, plant: EXCEPT_TMC },
    { ...OWNER, buildPlant: null },
    BOTH_AXES,
    "unresolved",
  ],
  ["a plant scope while only the engine axis is checked", { engine: null, plant: EXCEPT_TMC }, OWNER, undefined, "not_stated"],
  [
    "another engine beats an unresolved plant",
    { engine: ENGINE_2AZ, plant: { unresolved: true, kind: "unknown_code" } },
    OWNER,
    BOTH_AXES,
    "other_variant",
  ],
]) {
  test(`classifyScope: ${label} -> ${expected}`, () => {
    assert.equal(classifyScope(scope, profile, options).verdict, expected);
  });
}

test("classifyScope reports a verdict per checked axis", () => {
  const result = classifyScope({ engine: ENGINE_2ZR, plant: EXCEPT_TMC }, OWNER, BOTH_AXES);

  assert.deepEqual(result, { verdict: "applies", byAxis: { engine: "applies", plant: "applies" } });
  assert.deepEqual(classifyScope(EMPTY_SCOPE, OWNER).byAxis, { engine: "not_stated" });
});

// ---- independent-oracle findings (fail-closed rulings) ----

test("a diagram title naming two engines is unresolved, in either print order", () => {
  for (const title of ["<2AZ-FE / 2ZR-FE>", "<2ZR-FE / 2AZ-FE>", "<2ZR-FE and 2AZ-FE , Except TMC Made>"]) {
    const text = `Ignition System ${title} (IG) Coil terminal 9 to 14 V`;
    assert.equal(scopeOf(text, "9 to 14 V").engine.unresolved, true, title);
  }
});

test("an OCR misread with a digit inside the code is unknown, so it closes the open block", () => {
  assert.deepEqual(shape("(for 2A2-FE) bolt"), [engine("unknown_code", "2A2-FE")]);
  const text = "Idler pulley (for 2ZR-FE) Pulley bolt 39 N*m (for 2A2-FE) Pulley bolt 43 N*m";
  assert.equal(scopeOf(text, "39 N*m").engine.value, "2ZR-FE");
  assert.equal(scopeOf(text, "43 N*m").engine.unresolved, true);
});

test("an unknown code in a diagram title ends the previous diagram and carries as unresolved", () => {
  const pages = computeDocumentScopes([
    { pageNumber: 1, text: "Engine Control <2ZR-FE , Except TMC Made> (IG) VC - E2 4.8 to 5.2 V" },
    { pageNumber: 2, text: "Engine Control <2ZA-FE , Except TMC Made> (IG) B1 - E1 4.6 to 5.4 V" },
    { pageNumber: 3, text: "Engine Control Terminal THW - E2 0.2 to 1.0 V" },
  ]);

  assert.equal(pages[2].chunks[0].entryScope.engine.unresolved, true);
  const next = computeDocumentScopes([
    { pageNumber: 1, text: "Engine Control <2ZA-FE> (IG) 5 V" },
    { pageNumber: 2, text: "Engine Control <2ZR-FE> (IG) 5 V" },
  ]);
  assert.equal(
    next[1].chunks[0].entryScope.engine.unresolved,
    true,
    "page 2 starts inside page 1's misread diagram, before its own title"
  );
  assert.equal(scopeAt(next[1].segments, next[1].text.indexOf("5 V")).engine.value, "2ZR-FE");
});

test("(for X) inside an article title scopes the whole article", () => {
  const pages = computeDocumentScopes([
    { pageNumber: 1, text: "Vehicle > Engine > Drive Belt > Inspection (for 2AZ-FE) HINT: Deflection 9.5 mm" },
    { pageNumber: 2, text: "Tension with new belt 650 to 750 N" },
  ]);

  assert.deepEqual(shape("Vehicle > Engine > Drive Belt > Inspection (for 2AZ-FE) HINT: x"), [
    engine("article_title", "2AZ-FE"),
  ]);
  assert.equal(pages[1].chunks[0].entryScope.engine.value, "2AZ-FE");
});

// ---- blind-label finding: table footnotes ----

test("a table footnote ends the row scope above it; legends and titles are unaffected", () => {
  const table =
    "except TMC Made 2ZR-FE 92 mm 80 mm* 2AZ-FE 96 mm 81 mm* * for vehicle height for Mexico, add 15 mm";

  assert.equal(scopeOf(table, "96 mm").engine.value, "2AZ-FE");
  assert.equal(scopeOf(table, "15 mm").engine, null, "the footnote applies to the whole table");
  assert.equal(scopeOf(table, "81 mm").engine.value, "2AZ-FE", "a value's own asterisk is not a footnote");

  assert.equal(scopeOf("* 2: 2AZ-FE wire 5 V", "5 V").engine.unresolved, true, "a legend is still a legend");
  assert.equal(
    scopeOf("Engine Control (2AZ-FE) 12 10 * oo Plat wt * ig Fa 3 L", "3 L").engine.value,
    "2AZ-FE",
    "OCR noise after an asterisk is not a footnote"
  );
  const diagram = "Engine Control <2AZ-FE> (IG) * check harness first 5 V";
  assert.equal(scopeOf(diagram, "5 V").engine.value, "2AZ-FE", "a footnote never ends a title scope");
});
