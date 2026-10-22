// Independent applicability oracle for the N5 P1 scope tagger.
//
// Written from the WRITTEN rules only: docs/n5-p0-p1-implementation-plan.md
// (Global Constraints, Tasks 6-8) with docs/n5-applicability-design.md
// (§2.3, §4, §6.1-§6.3, §10) for intent. The author never read
// applicabilityScope.js, chunkGeometry.js, or their tests, so a disagreement
// between this table and the implementation is a real finding, not an echo.
//
// How a row is judged (by the harness that consumes this table):
//   1. normalize each page's whitespace;
//   2. compute scopes for the whole document (computeDocumentScopes);
//   3. find the figure's character offset: the occurrence-th (1-based) exact
//      match of figure.text on figure.pageNumber;
//   4. take the scope at that offset (scopeAt);
//   5. classifyScope(scope, profile, { axes }).
//
// Rules for this table:
//   - The repository is public. Every string is a short SYNTHETIC manual-style
//     line written for this table. Never paste real manual text into it.
//   - `expected` is what the written rules produce. Where the rules leave two
//     readings open, the row takes the fail-closed one (unresolved or
//     other_variant over applies; not_stated over a header-derived applies)
//     and says so in `specAmbiguity`. Those rows are rulings the implementer
//     still owes; a row is never re-labelled just to make code pass.
//   - The most important rows are the ones whose wrong answer would show
//     another engine's figure as the owner's.
//
// Row shape:
//   id            unique kebab-case label
//   category      mixed_table | unknown_applicability | false_positive |
//                 plant_axis | extent
//   pages         the whole document, in page order
//   figure        { pageNumber, text, occurrence }
//   profile       the owner's ApplicabilityProfile
//   axes          the axes passed to classifyScope
//   expected      applies | other_variant | unresolved | not_stated
//   rationale     which rule decides it
//   specAmbiguity optional: what the written rules leave unclear here

/**
 * @typedef {object} ApplicabilityOracleRow
 * @property {string} id
 * @property {"mixed_table" | "unknown_applicability" | "false_positive" | "plant_axis" | "extent"} category
 * @property {Array<{ pageNumber: number, text: string }>} pages
 * @property {{ pageNumber: number, text: string, occurrence: number }} figure
 * @property {{ engineCode: string | null, buildPlant: string | null, transmissionCode: string | null, hasVsc: boolean | null, hasSmartKey: boolean | null }} profile
 * @property {Array<"engine" | "plant">} axes
 * @property {"applies" | "other_variant" | "unresolved" | "not_stated"} expected
 * @property {string} rationale
 * @property {string} [specAmbiguity]
 */

// Built from a char code so no editor or tool can silently turn it into a
// plain space.
const NBSP = String.fromCharCode(0xa0);

// The account header that tops every page of the owner's account. It is never
// a marker (Global Constraints).
const HEADER = "2009 Toyota Corolla L4-1.8L (2ZR-FE)";

/** @param {Partial<ApplicabilityOracleRow["profile"]>} [overrides] */
function profile(overrides = {}) {
  return {
    engineCode: "2ZR-FE",
    buildPlant: "NUMMI",
    transmissionCode: null,
    hasVsc: null,
    hasSmartKey: null,
    ...overrides,
  };
}

/** @param {...string} texts */
function doc(...texts) {
  return texts.map((text, index) => ({ pageNumber: index + 1, text }));
}

// ---------------------------------------------------------------------------
// Shared synthetic pages
// ---------------------------------------------------------------------------

// Row labels on both axes: plant row, then engine rows (S1 shape).
const ROW_LABEL_TABLE =
  "Vehicle > Suspension > Alignment > Specifications HINT: Front height. " +
  "for TMC Made 2ZR-FE 92 mm 2AZ-FE 96 mm except TMC Made 2ZR-FE 93 mm 2AZ-FE 97 mm";

// "(for X)" blocks with one different and one shared value (S2 shape).
const COMPRESSOR_BLOCKS =
  "Vehicle > Heating and Air Conditioning > Compressor > Installation HINT: Torque values. " +
  "COMPRESSOR (for 2AZ-FE) Compressor x Engine 25 N*m Bracket x Engine 21 N*m " +
  "COMPRESSOR (for 2ZR-FE) Compressor x Engine 27 N*m Bracket x Engine 21 N*m";

// The same value printed under both engines, owner block first.
const SAME_VALUE_BLOCKS =
  "COOLER PIPE (for 2ZR-FE) Pipe x Compressor 10 N*m " +
  "COOLER PIPE (for 2AZ-FE) Pipe x Compressor 10 N*m";

const FIGURE_BEFORE_MARKERS =
  "Drive belt deflection. New belt 8.0 mm (for 2AZ-FE) Used belt 9.5 mm (for 2ZR-FE) Used belt 10.5 mm";

const STEP_ENDS_INLINE =
  "(for 2AZ-FE) Water pump x Engine 11 N*m 6. INSTALL THERMOSTAT HOUSING Housing x Head 9.0 N*m";

const COLUMN_HEADER_TABLE =
  "Valve clearance (cold) Item 2ZR-FE 2AZ-FE Intake 0.19 mm 0.24 mm Exhaust 0.31 mm 0.40 mm";

const COLUMN_HEADER_SLASH =
  "Oil capacity Engine 2ZR-FE / 2AZ-FE Drain and refill with filter 3.9 L / 4.1 L";

const LEGEND_BOTH =
  "Engine Room Relay Block * 1: 2ZR-FE * 2: 2AZ-FE Terminal 3 - Body ground 11 to 14 V";

const DIAGRAM_THEN_LEGEND =
  "Engine Control <2AZ-FE , Except TMC Made> (IG) Terminal B1 - E1 4.5 to 5.5 V " +
  "* 1: with VSC * 2: 2ZR-FE Terminal B2 - E1 9 to 14 V";

const LEGEND_THEN_INLINE =
  "Sensor harness * 1: 2AZ-FE Connector A (for 2ZR-FE) Terminal 2 - 4 120 to 140 ohm";

const OTHER_KNOWN_ENGINE =
  "Oil pan drain plug (for 1NZ-FE) Plug x Pan 37 N*m (for 2ZR-FE) Plug x Pan 40 N*m";

const AND_LIST = "Spark plug tightening. For 2ZR-FE and 2AZ-FE: 25 N*m";

const TWO_ENGINE_DIAGRAM =
  "Ignition System <2AZ-FE / 2ZR-FE> (IG) Coil terminal +B - Body ground 9 to 14 V";

// Right engine, wrong plant (S6 shape): one fastener, two torques by plant.
const ENGINE_MOUNT =
  "Engine mount bracket. for TMC Made (for 2ZR-FE) Bracket bolt 52 N*m " +
  "Except TMC Made (for 2ZR-FE) Bracket bolt 58 N*m";

const NUMMI_TMMC_TABLE = "Rear height. NUMMI Made 2ZR-FE 61 mm TMMC Made 2ZR-FE 64 mm";

const DIAGRAM_2AZ_EXCEPT_TMC =
  "Engine Control <2AZ-FE , Except TMC Made> (IG) Terminal B1 - E1 4.5 to 5.5 V";

const DIAGRAM_2ZR_EXCEPT_TMC =
  "Engine Control <2ZR-FE , Except TMC Made> (IG) Terminal B1 - E1 4.6 to 5.4 V";

const NO_MARKERS =
  "Vehicle > Brakes > Disc Brake > Specifications HINT: Pad lining thickness. Standard 12.0 mm Minimum 1.0 mm";

const HEADER_ONLY =
  HEADER + " Vehicle > Engine > Cooling > Specifications HINT: Radiator cap opening pressure 93 to 123 kPa";

const LINK_ONLY =
  "Bolt 25 N*m See Procedure 2AZ-FE [ 2AZ-FE ENGINE CONTROL: ECM: REMOVAL+ ] Nut 9.0 N*m";

const UNKNOWN_CODE_INLINE = "Water pump installation (for 2ZA-FE) Pump x Block 11 N*m";

const DIAGRAM_2AZ_P1 = "Engine Control <2AZ-FE> (ECM) Terminal VC - E2 4.8 to 5.2 V";
const DIAGRAM_CONT_P2 = HEADER + " Engine Control Terminal THW - E2 0.2 to 1.0 V";

const ARTICLE_2AZ_P1 =
  HEADER +
  " Vehicle > Engine > Engine Mechanical > Timing Chain > Specifications (2AZ-FE) HINT: Chain tensioner nut 10 N*m";
const ARTICLE_2AZ_P2 = HEADER + " Chain cover bolt A 24 N*m Chain cover bolt B 11 N*m";

// 400 filler words with no digits, no codes, and no step headings.
const FILLER_400 = Array.from({ length: 50 }, () => "check the harness and connector for any damage").join(" ");

/** @type {ApplicabilityOracleRow[]} */
const ROWS = [
  // =========================================================================
  // mixed_table
  // =========================================================================
  {
    id: "mixed-01",
    category: "mixed_table",
    pages: doc(ROW_LABEL_TABLE),
    figure: { pageNumber: 1, text: "92 mm", occurrence: 1 },
    profile: profile(),
    axes: ["engine"],
    expected: "applies",
    rationale:
      "The bare 2ZR-FE before 92 mm is a row_label; it lasts until the next row_label on the engine axis (2AZ-FE), so 92 mm is scoped 2ZR-FE. Plant is not classified on the default axes.",
  },
  {
    id: "mixed-02",
    category: "mixed_table",
    pages: doc(ROW_LABEL_TABLE),
    figure: { pageNumber: 1, text: "96 mm", occurrence: 1 },
    profile: profile(),
    axes: ["engine"],
    expected: "other_variant",
    rationale:
      "96 mm sits in the 2AZ-FE row_label segment, which runs until the next engine row_label after the plant change; 2AZ-FE differs from the owner's 2ZR-FE.",
  },
  {
    id: "mixed-03",
    category: "mixed_table",
    pages: doc(ROW_LABEL_TABLE),
    figure: { pageNumber: 1, text: "93 mm", occurrence: 1 },
    profile: profile(),
    axes: ["engine"],
    expected: "applies",
    rationale:
      "The second 2ZR-FE row_label closes the 2AZ-FE row (same axis), so 93 mm is scoped 2ZR-FE.",
  },
  {
    id: "mixed-04",
    category: "mixed_table",
    pages: doc(ROW_LABEL_TABLE),
    figure: { pageNumber: 1, text: "97 mm", occurrence: 1 },
    profile: profile(),
    axes: ["engine"],
    expected: "other_variant",
    rationale:
      "97 mm follows the last marker on the page (2AZ-FE row_label); a row_label lasts to page end when nothing closes it.",
  },
  {
    id: "mixed-05",
    category: "mixed_table",
    pages: doc(COMPRESSOR_BLOCKS),
    figure: { pageNumber: 1, text: "25 N*m", occurrence: 1 },
    profile: profile(),
    axes: ["engine"],
    expected: "other_variant",
    rationale:
      "25 N*m lies between (for 2AZ-FE) and (for 2ZR-FE); the inline_for 2AZ-FE scope is still open there.",
  },
  {
    id: "mixed-06",
    category: "mixed_table",
    pages: doc(COMPRESSOR_BLOCKS),
    figure: { pageNumber: 1, text: "21 N*m", occurrence: 1 },
    profile: profile(),
    axes: ["engine"],
    expected: "other_variant",
    rationale:
      "The first 21 N*m is printed in the 2AZ-FE block. The owner block prints the same number, but the cited figure's own segment decides (design §6.2: identical values cited from the other block are refused).",
  },
  {
    id: "mixed-07",
    category: "mixed_table",
    pages: doc(COMPRESSOR_BLOCKS),
    figure: { pageNumber: 1, text: "21 N*m", occurrence: 2 },
    profile: profile(),
    axes: ["engine"],
    expected: "applies",
    rationale: "The second 21 N*m follows (for 2ZR-FE), which closed the 2AZ-FE inline scope.",
  },
  {
    id: "mixed-08",
    category: "mixed_table",
    pages: doc(COMPRESSOR_BLOCKS),
    figure: { pageNumber: 1, text: "27 N*m", occurrence: 1 },
    profile: profile(),
    axes: ["engine"],
    expected: "applies",
    rationale: "27 N*m is inside the (for 2ZR-FE) inline scope, which lasts to page end.",
  },
  {
    id: "mixed-09",
    category: "mixed_table",
    pages: doc(SAME_VALUE_BLOCKS),
    figure: { pageNumber: 1, text: "10 N*m", occurrence: 1 },
    profile: profile(),
    axes: ["engine"],
    expected: "applies",
    rationale: "The first 10 N*m is in the (for 2ZR-FE) block, which comes first on this page.",
  },
  {
    id: "mixed-10",
    category: "mixed_table",
    pages: doc(SAME_VALUE_BLOCKS),
    figure: { pageNumber: 1, text: "10 N*m", occurrence: 2 },
    profile: profile(),
    axes: ["engine"],
    expected: "other_variant",
    rationale:
      "The second 10 N*m is in the (for 2AZ-FE) block. Same number as the owner block, but its own segment is 2AZ-FE, so it is refused (fail-closed, design §6.2).",
  },
  {
    id: "mixed-11",
    category: "mixed_table",
    pages: doc(FIGURE_BEFORE_MARKERS),
    figure: { pageNumber: 1, text: "8.0 mm", occurrence: 1 },
    profile: profile(),
    axes: ["engine"],
    expected: "not_stated",
    rationale:
      "8.0 mm precedes every marker on the page; a scope starts at its marker, and nothing is carried in, so the engine axis is null.",
  },
  {
    id: "mixed-12",
    category: "mixed_table",
    pages: doc(STEP_ENDS_INLINE),
    figure: { pageNumber: 1, text: "11 N*m", occurrence: 1 },
    profile: profile(),
    axes: ["engine"],
    expected: "other_variant",
    rationale: "11 N*m is inside (for 2AZ-FE) and before the numbered step that ends it.",
  },
  {
    id: "mixed-13",
    category: "mixed_table",
    pages: doc(STEP_ENDS_INLINE),
    figure: { pageNumber: 1, text: "9.0 N*m", occurrence: 1 },
    profile: profile(),
    axes: ["engine"],
    expected: "not_stated",
    rationale:
      "\"6. INSTALL\" matches the numbered-step boundary, which ends the inline_for scope; with no article or diagram scope the engine axis is null.",
  },
  {
    id: "mixed-14",
    category: "mixed_table",
    pages: doc(COLUMN_HEADER_TABLE),
    figure: { pageNumber: 1, text: "0.19 mm", occurrence: 1 },
    profile: profile(),
    axes: ["engine"],
    expected: "unresolved",
    rationale:
      "\"2ZR-FE 2AZ-FE\" are two different tokens one space apart, so both are column_header markers and the rest of the page is unresolved. Column position is not read, even for the owner's column.",
  },
  {
    id: "mixed-15",
    category: "mixed_table",
    pages: doc(COLUMN_HEADER_SLASH),
    figure: { pageNumber: 1, text: "3.9 L", occurrence: 1 },
    profile: profile(),
    axes: ["engine"],
    expected: "unresolved",
    rationale:
      "\" / \" is three characters with no digit, so \"2ZR-FE / 2AZ-FE\" is a column header; unresolved from the marker to page end.",
  },
  {
    id: "mixed-16",
    category: "mixed_table",
    pages: doc(LEGEND_BOTH),
    figure: { pageNumber: 1, text: "11 to 14 V", occurrence: 1 },
    profile: profile(),
    axes: ["engine"],
    expected: "unresolved",
    rationale: "Both codes are preceded by \"* n:\", so they are legend markers; unresolved from the marker to page end.",
  },
  {
    id: "mixed-17",
    category: "mixed_table",
    pages: doc(DIAGRAM_THEN_LEGEND),
    figure: { pageNumber: 1, text: "4.5 to 5.5 V", occurrence: 1 },
    profile: profile(),
    axes: ["engine"],
    expected: "other_variant",
    rationale:
      "The figure precedes the legend, so only the diagram_title <2AZ-FE , ...> scopes it. A later legend does not reach backwards.",
  },
  {
    id: "mixed-18",
    category: "mixed_table",
    pages: doc(DIAGRAM_THEN_LEGEND),
    figure: { pageNumber: 1, text: "9 to 14 V", occurrence: 1 },
    profile: profile(),
    axes: ["engine"],
    expected: "unresolved",
    rationale:
      "\"* 2: 2ZR-FE\" is a legend even though it names the owner's engine; unresolved outranks the diagram scope and lasts to page end.",
  },
  {
    id: "mixed-19",
    category: "mixed_table",
    pages: doc(LEGEND_THEN_INLINE),
    figure: { pageNumber: 1, text: "120 to 140 ohm", occurrence: 1 },
    profile: profile(),
    axes: ["engine"],
    expected: "unresolved",
    rationale:
      "Precedence puts unresolved above inline_for, and the legend's unresolved region runs to page end, so a later (for 2ZR-FE) cannot make the figure apply.",
  },
  {
    id: "mixed-20",
    category: "mixed_table",
    pages: doc(OTHER_KNOWN_ENGINE),
    figure: { pageNumber: 1, text: "37 N*m", occurrence: 1 },
    profile: profile(),
    axes: ["engine"],
    expected: "other_variant",
    rationale: "1NZ-FE is in KNOWN_ENGINE_CODES, so (for 1NZ-FE) is an ordinary inline_for scope for a different engine.",
  },
  {
    id: "mixed-21",
    category: "mixed_table",
    pages: doc(AND_LIST),
    figure: { pageNumber: 1, text: "25 N*m", occurrence: 1 },
    profile: profile(),
    axes: ["engine"],
    expected: "other_variant",
    rationale:
      "\" and \" is five characters, so this is not a column header: both codes are row_labels and the later 2AZ-FE closes the 2ZR-FE row before the figure.",
    specAmbiguity:
      "The rules have no shape for a shared list (\"2ZR-FE and 2AZ-FE\"); last-named-wins refuses a value that the text says applies to both. Fail-closed, but the owner may want such lists treated as unresolved or as applies.",
  },
  {
    id: "mixed-22",
    category: "mixed_table",
    pages: doc(TWO_ENGINE_DIAGRAM),
    figure: { pageNumber: 1, text: "9 to 14 V", occurrence: 1 },
    profile: profile(),
    axes: ["engine"],
    expected: "unresolved",
    rationale:
      "Two different codes three characters apart with no digit is the column-header shape that design §6.1 makes unresolved.",
    specAmbiguity:
      "Task 6's first-match order checks diagram_title before column_header, which makes both tokens diagram_title; the later one (2ZR-FE) then closes the earlier and the figure would apply. Swap the order inside the <...> and it becomes other_variant, so the verdict depends on print order. The fail-closed reading (unresolved) is used here.",
  },
  {
    id: "mixed-23",
    category: "mixed_table",
    pages: doc(ENGINE_MOUNT),
    figure: { pageNumber: 1, text: "52 N*m", occurrence: 1 },
    profile: profile(),
    axes: ["engine"],
    expected: "applies",
    rationale:
      "On the default axes the plant row is ignored (decision #9); the engine axis is (for 2ZR-FE), so the TMC-only torque applies on the engine axis alone.",
  },

  // =========================================================================
  // unknown_applicability
  // =========================================================================
  {
    id: "unknown-01",
    category: "unknown_applicability",
    pages: doc(NO_MARKERS),
    figure: { pageNumber: 1, text: "1.0 mm", occurrence: 1 },
    profile: profile(),
    axes: ["engine"],
    expected: "not_stated",
    rationale: "No engine token anywhere in the document; the engine axis is null, which classifies as not_stated.",
  },
  {
    id: "unknown-02",
    category: "unknown_applicability",
    pages: doc(HEADER_ONLY),
    figure: { pageNumber: 1, text: "93 to 123 kPa", occurrence: 1 },
    profile: profile(),
    axes: ["engine"],
    expected: "not_stated",
    rationale: "The only 2ZR-FE is the account header, which is blanked and is never a marker.",
  },
  {
    id: "unknown-03",
    category: "unknown_applicability",
    pages: doc("2009 Toyota Corolla\n  L4-1.8L  (  2ZR-FE )\nThermostat valve opening temperature 80 to 84 C"),
    figure: { pageNumber: 1, text: "80 to 84 C", occurrence: 1 },
    profile: profile(),
    axes: ["engine"],
    expected: "not_stated",
    rationale:
      "Line breaks, double spaces and spaces inside the parentheses are all covered by the header pattern's \\s; the header is blanked (Review Focus 2).",
  },
  {
    id: "unknown-04",
    category: "unknown_applicability",
    pages: doc("2009 Toyota Corolla" + NBSP + "L4-1.8L" + NBSP + "(2ZR-FE) Fan relay coil resistance 62 to 107 ohm"),
    figure: { pageNumber: 1, text: "62 to 107 ohm", occurrence: 1 },
    profile: profile(),
    axes: ["engine"],
    expected: "not_stated",
    rationale: "A nonbreaking space is whitespace to \\s, so the header is still blanked (Review Focus 2).",
  },
  {
    id: "unknown-05",
    category: "unknown_applicability",
    pages: doc("2009 Toyota Corolla L4 1.8L (2ZR-FE) Starter brush length minimum 8.5 mm"),
    figure: { pageNumber: 1, text: "8.5 mm", occurrence: 1 },
    profile: profile(),
    axes: ["engine"],
    expected: "not_stated",
    rationale: "L4[-\\s]?1\\.8L accepts a space in place of the hyphen, so this is still the header and is blanked.",
  },
  {
    id: "unknown-06",
    category: "unknown_applicability",
    pages: doc(
      "2009 Toyota Corolla L4-1.8L (2ZR- FE) Vehicle > Engine > Lubrication > Specifications HINT: Oil pressure at idle 29 kPa or more",
    ),
    figure: { pageNumber: 1, text: "29 kPa", occurrence: 1 },
    profile: profile(),
    axes: ["engine"],
    expected: "not_stated",
    rationale:
      "This is the account header with an OCR space inside the code; the header is never evidence (design §6.3), and Global Constraints say it is matched \"with any whitespace\".",
    specAmbiguity:
      "The pinned header regex needs a literal \"2ZR-FE\", so \"(2ZR- FE)\" escapes blanking while the engine-token regex still reads it as 2ZR-FE, a row_label that would make every later figure apply. Is \"with any whitespace\" meant to cover whitespace inside the code? The fail-closed reading (blank it; not_stated) is used.",
  },
  {
    id: "unknown-07",
    category: "unknown_applicability",
    pages: doc(NO_MARKERS),
    figure: { pageNumber: 1, text: "1.0 mm", occurrence: 1 },
    profile: profile({ engineCode: null }),
    axes: ["engine"],
    expected: "not_stated",
    rationale: "A null owner engine only matters for a scoped axis; an unscoped axis is not_stated whatever the profile says.",
  },
  {
    id: "unknown-08",
    category: "unknown_applicability",
    pages: doc(COMPRESSOR_BLOCKS),
    figure: { pageNumber: 1, text: "27 N*m", occurrence: 1 },
    profile: profile({ engineCode: null }),
    axes: ["engine"],
    expected: "unresolved",
    rationale: "Scoped 2ZR-FE but the owner's engine is unknown; unknown is never compatible (Review Focus 3).",
  },
  {
    id: "unknown-09",
    category: "unknown_applicability",
    pages: doc(COMPRESSOR_BLOCKS),
    figure: { pageNumber: 1, text: "25 N*m", occurrence: 1 },
    profile: profile({ engineCode: null }),
    axes: ["engine"],
    expected: "unresolved",
    rationale:
      "The Task 8 table checks \"scoped, owner value null\" before comparing values, so even a 2AZ-FE scope is unresolved, not other_variant, when the owner engine is unknown.",
  },
  {
    id: "unknown-10",
    category: "unknown_applicability",
    pages: doc(ARTICLE_2AZ_P1, ARTICLE_2AZ_P2),
    figure: { pageNumber: 2, text: "24 N*m", occurrence: 1 },
    profile: profile({ engineCode: null }),
    axes: ["engine"],
    expected: "unresolved",
    rationale: "Page 2 inherits the article_title 2AZ-FE scope; with a null owner engine any scoped axis is unresolved.",
  },
  {
    id: "unknown-11",
    category: "unknown_applicability",
    pages: doc(LEGEND_BOTH),
    figure: { pageNumber: 1, text: "11 to 14 V", occurrence: 1 },
    profile: profile({ engineCode: null }),
    axes: ["engine"],
    expected: "unresolved",
    rationale: "A legend region is unresolved regardless of the profile.",
  },
  {
    id: "unknown-12",
    category: "unknown_applicability",
    pages: doc(HEADER_ONLY),
    figure: { pageNumber: 1, text: "93 to 123 kPa", occurrence: 1 },
    profile: profile({ engineCode: null }),
    axes: ["engine"],
    expected: "not_stated",
    rationale: "The header is blanked, so nothing is scoped; a null owner engine does not turn not_stated into unresolved.",
  },
  {
    id: "unknown-13",
    category: "unknown_applicability",
    pages: doc(COLUMN_HEADER_TABLE),
    figure: { pageNumber: 1, text: "0.40 mm", occurrence: 1 },
    profile: profile({ engineCode: null }),
    axes: ["engine"],
    expected: "unresolved",
    rationale: "Column-header region: unresolved whatever the owner value.",
  },
  {
    id: "unknown-14",
    category: "unknown_applicability",
    pages: doc(LINK_ONLY),
    figure: { pageNumber: 1, text: "9.0 N*m", occurrence: 1 },
    profile: profile({ engineCode: null }),
    axes: ["engine"],
    expected: "not_stated",
    rationale: "Link markers never open a segment, so the axis stays null and a null owner value is never consulted.",
  },
  {
    id: "unknown-15",
    category: "unknown_applicability",
    pages: doc(ROW_LABEL_TABLE),
    figure: { pageNumber: 1, text: "92 mm", occurrence: 1 },
    profile: profile({ engineCode: null, buildPlant: null }),
    axes: ["engine", "plant"],
    expected: "unresolved",
    rationale:
      "Both axes are scoped (2ZR-FE row, for TMC Made row) and both owner values are null, so each axis is unresolved and no axis is other_variant.",
  },
  {
    id: "unknown-16",
    category: "unknown_applicability",
    pages: doc(DIAGRAM_2AZ_P1, DIAGRAM_CONT_P2),
    figure: { pageNumber: 2, text: "0.2 to 1.0 V", occurrence: 1 },
    profile: profile({ engineCode: null }),
    axes: ["engine"],
    expected: "unresolved",
    rationale: "The diagram_title 2AZ-FE scope carries onto page 2; with a null owner engine it is unresolved.",
  },
  {
    id: "unknown-17",
    category: "unknown_applicability",
    pages: doc(UNKNOWN_CODE_INLINE),
    figure: { pageNumber: 1, text: "11 N*m", occurrence: 1 },
    profile: profile(),
    axes: ["engine"],
    expected: "unresolved",
    rationale: "\"2ZA-FE\" matches the token regex but is not a known code, so it is unknown_code: unresolved to page end (Review Focus 1).",
  },
  {
    id: "unknown-18",
    category: "unknown_applicability",
    pages: doc(UNKNOWN_CODE_INLINE, HEADER + " Pulley x Pump 21 N*m"),
    figure: { pageNumber: 2, text: "21 N*m", occurrence: 1 },
    profile: profile(),
    axes: ["engine"],
    expected: "not_stated",
    rationale: "unknown_code does not cross to the next page, and nothing else is carried, so page 2 is unscoped.",
  },
  {
    id: "unknown-19",
    category: "unknown_applicability",
    pages: doc(LEGEND_BOTH, HEADER + " Ground point resistance below 1 ohm"),
    figure: { pageNumber: 2, text: "1 ohm", occurrence: 1 },
    profile: profile(),
    axes: ["engine"],
    expected: "not_stated",
    rationale: "A legend's unresolved region stops at page end; carryOut keeps only article and diagram parts.",
  },
  {
    id: "unknown-20",
    category: "unknown_applicability",
    pages: doc(
      "Engine Control <2AZ-FE , Except TMC Made> (IG) * 1: 2ZR-FE * 2: 2AZ-FE Terminal B1 - E1 4.5 to 5.5 V",
      HEADER + " Engine Control Terminal VC - E2 4.8 to 5.2 V",
    ),
    figure: { pageNumber: 2, text: "4.8 to 5.2 V", occurrence: 1 },
    profile: profile(),
    axes: ["engine"],
    expected: "other_variant",
    rationale:
      "The legend's unresolved region ends with page 1, but the diagram_title 2AZ-FE scope crosses pages, so page 2 is scoped 2AZ-FE.",
  },
  {
    id: "unknown-21",
    category: "unknown_applicability",
    pages: doc("Pulley bolt (for 2ZA-FE) Bolt 41 N*m (for 2ZR-FE) Bolt 39 N*m"),
    figure: { pageNumber: 1, text: "39 N*m", occurrence: 1 },
    profile: profile(),
    axes: ["engine"],
    expected: "unresolved",
    rationale:
      "The unknown_code region runs to page end and unresolved outranks inline_for, so the later (for 2ZR-FE) cannot make the figure apply.",
  },
  {
    id: "unknown-22",
    category: "unknown_applicability",
    pages: doc("Cylinder head bolt (for 1GR-FE) First pass 36 N*m"),
    figure: { pageNumber: 1, text: "36 N*m", occurrence: 1 },
    profile: profile(),
    axes: ["engine"],
    expected: "unresolved",
    rationale: "A well-formed code that is not in KNOWN_ENGINE_CODES is unknown_code, never other_variant or applies.",
  },
  {
    id: "unknown-23",
    category: "unknown_applicability",
    pages: doc("Idler pulley (for 2ZR-FE) Pulley bolt 39 N*m (for 2A2-FE) Pulley bolt 43 N*m"),
    figure: { pageNumber: 1, text: "43 N*m", occurrence: 1 },
    profile: profile(),
    axes: ["engine"],
    expected: "unresolved",
    rationale:
      "\"2A2-FE\" is an OCR misreading of an engine code; Review Focus 1 and design §10 say a misread code must never become an owner applies.",
    specAmbiguity:
      "The pinned token regex ([1-9][A-Z]{2}) cannot see \"2A2-FE\", so no marker is found, the (for 2ZR-FE) scope stays open, and the other block's 43 N*m would apply. Review Focus 1 forbids that outcome, but no written rule detects it. Unresolved is used here; the rule (e.g. treat any unmatched \"(for ...-FE)\" group as unknown_code) is the implementer's call.",
  },
  {
    id: "unknown-24",
    category: "unknown_applicability",
    pages: doc(
      "Engine Control <2ZR-FE , Except TMC Made> (IG) Terminal VC - E2 4.8 to 5.2 V",
      HEADER + " Engine Control <2ZA-FE , Except TMC Made> (IG) Terminal B1 - E1 4.6 to 5.4 V",
      HEADER + " Engine Control Terminal THW - E2 0.2 to 1.0 V",
    ),
    figure: { pageNumber: 3, text: "0.2 to 1.0 V", occurrence: 1 },
    profile: profile(),
    axes: ["engine"],
    expected: "unresolved",
    rationale:
      "Page 2 opens a new diagram whose code is misread; whatever page 3 belongs to, it is not established as 2ZR-FE.",
    specAmbiguity:
      "\"A token not in KNOWN_ENGINE_CODES is kind unknown_code\", so the <2ZA-FE ...> title is not a diagram_title and does not close page 1's <2ZR-FE> scope. That scope then carries to page 3 and the figure would apply, although page 3 continues the misread (other-engine) diagram. Should an unknown code inside <...> still end the previous diagram, and should its unresolved state carry? The fail-closed reading (unresolved) is used.",
  },
  {
    id: "unknown-25",
    category: "unknown_applicability",
    pages: doc("Idler pulley (for 2ZR-FE) Pulley bolt 39 N*m (for 2AZ- FE) Pulley bolt 43 N*m"),
    figure: { pageNumber: 1, text: "43 N*m", occurrence: 1 },
    profile: profile(),
    axes: ["engine"],
    expected: "other_variant",
    rationale:
      "\"2AZ- FE\" fits the token regex (optional space around the hyphen) and normalizes to 2AZ-FE, so (for 2AZ- FE) is inline_for 2AZ-FE and closes the owner block (Review Focus 1).",
  },
  {
    id: "unknown-26",
    category: "unknown_applicability",
    pages: doc("Front height 2ZRFE 92 mm"),
    figure: { pageNumber: 1, text: "92 mm", occurrence: 1 },
    profile: profile(),
    axes: ["engine"],
    expected: "applies",
    rationale: "\"2ZRFE\" fits the token regex (hyphen optional) and normalizes to the known 2ZR-FE; it is a row_label (Review Focus 1).",
  },

  // =========================================================================
  // false_positive
  // =========================================================================
  {
    id: "fp-01",
    category: "false_positive",
    pages: doc("Shift cable (for 2AZ-FE) Lever in 2ND-GEAR position Cable end play 12 mm"),
    figure: { pageNumber: 1, text: "12 mm", occurrence: 1 },
    profile: profile(),
    axes: ["engine"],
    expected: "other_variant",
    rationale:
      "\"2ND-GEAR\" fails the token regex (\"GE\" is not followed by a word boundary), so it neither closes the 2AZ-FE inline scope nor opens an unresolved one.",
  },
  {
    id: "fp-02",
    category: "false_positive",
    pages: doc("Transfer indicator 4WD-FOUR lamp check Supply voltage 9 to 14 V"),
    figure: { pageNumber: 1, text: "9 to 14 V", occurrence: 1 },
    profile: profile(),
    axes: ["engine"],
    expected: "not_stated",
    rationale: "\"4WD-FOUR\" has no engine suffix, so there is no marker and no unknown_code; the axis is null.",
  },
  {
    id: "fp-03",
    category: "false_positive",
    pages: doc("Line pressure (for 2ZR-FE) Range D 1ST-GEAR stall 1,100 to 1,300 kPa"),
    figure: { pageNumber: 1, text: "1,100 to 1,300 kPa", occurrence: 1 },
    profile: profile(),
    axes: ["engine"],
    expected: "applies",
    rationale: "\"1ST-GEAR\" is not a token, so it does not turn the owner's inline_for scope into unknown_code.",
  },
  {
    id: "fp-04",
    category: "false_positive",
    pages: doc("Spark plug (for 2AZ-FE) Plug 90919-01253 Electrode gap 1.0 to 1.1 mm"),
    figure: { pageNumber: 1, text: "1.0 to 1.1 mm", occurrence: 1 },
    profile: profile(),
    axes: ["engine"],
    expected: "other_variant",
    rationale: "A part number has no letters, so it is no marker and the 2AZ-FE inline scope continues over the figure.",
  },
  {
    id: "fp-05",
    category: "false_positive",
    pages: doc("DTC P0301 Cylinder 1 Misfire Detected Compression pressure minimum 1,000 kPa"),
    figure: { pageNumber: 1, text: "1,000 kPa", occurrence: 1 },
    profile: profile(),
    axes: ["engine"],
    expected: "not_stated",
    rationale: "A DTC code does not fit the engine token shape; no marker.",
  },
  {
    id: "fp-06",
    category: "false_positive",
    pages: doc("Vehicle height by engine 1.8L 92 mm 2.4L 96 mm"),
    figure: { pageNumber: 1, text: "96 mm", occurrence: 1 },
    profile: profile(),
    axes: ["engine"],
    expected: "not_stated",
    rationale: "\"1.8L\" and \"2.4L\" are not engine aliases in v1 (design §10), so neither row is scoped.",
  },
  {
    id: "fp-07",
    category: "false_positive",
    pages: doc("Transaxle fluid capacity U341E 6.9 L C59 2.4 L"),
    figure: { pageNumber: 1, text: "6.9 L", occurrence: 1 },
    profile: profile(),
    axes: ["engine"],
    expected: "not_stated",
    rationale: "Transmission codes are not engine tokens (U341E has no word boundary before its digit; C59 has no suffix).",
  },
  {
    id: "fp-08",
    category: "false_positive",
    pages: doc("Drain plug (for 2AZ-FE) Automatic transaxle U341E Plug 49 N*m"),
    figure: { pageNumber: 1, text: "49 N*m", occurrence: 1 },
    profile: profile(),
    axes: ["engine"],
    expected: "other_variant",
    rationale: "U341E is not a marker, so it neither closes nor overrides the 2AZ-FE inline scope.",
  },
  {
    id: "fp-09",
    category: "false_positive",
    pages: doc(LINK_ONLY),
    figure: { pageNumber: 1, text: "9.0 N*m", occurrence: 1 },
    profile: profile(),
    axes: ["engine"],
    expected: "not_stated",
    rationale:
      "\"2AZ-FE [\" and the code inside \"[ ... ]\" are link markers, which never open a segment; the figure beside a cross-reference is unscoped.",
  },
  {
    id: "fp-10",
    category: "false_positive",
    pages: doc(
      "Idler pulley (for 2AZ-FE) Pulley bolt 41 N*m See Procedure 2ZR-FE [ 2ZR-FE ENGINE MECHANICAL: DRIVE BELT: INSTALLATION+ ] Tensioner bolt 22 N*m",
    ),
    figure: { pageNumber: 1, text: "22 N*m", occurrence: 1 },
    profile: profile(),
    axes: ["engine"],
    expected: "other_variant",
    rationale:
      "A link to the owner's procedure is not a marker that closes the inline scope (only inline_for/row_label/diagram_title/article_title do), so the figure stays 2AZ-FE.",
  },
  {
    id: "fp-11",
    category: "false_positive",
    pages: doc(
      "Idler pulley (for 2ZR-FE) Pulley bolt 39 N*m See Procedure 2AZ-FE [ 2AZ-FE ENGINE MECHANICAL: DRIVE BELT+ ] Tensioner bolt 21 N*m",
    ),
    figure: { pageNumber: 1, text: "21 N*m", occurrence: 1 },
    profile: profile(),
    axes: ["engine"],
    expected: "applies",
    rationale: "A link naming 2AZ-FE does not end the owner's inline scope (S4: link scope applies to the link only).",
  },
  {
    id: "fp-12",
    category: "false_positive",
    pages: doc("(for 2AZ-FE) Crankshaft pulley bolt 190 N*m " + HEADER + " Timing chain cover bolt 11 N*m"),
    figure: { pageNumber: 1, text: "11 N*m", occurrence: 1 },
    profile: profile(),
    axes: ["engine"],
    expected: "other_variant",
    rationale:
      "The account header is blanked, so its 2ZR-FE is not a row_label that would close the 2AZ-FE block and make the next figure apply.",
  },
  {
    id: "fp-13",
    category: "false_positive",
    pages: doc(DIAGRAM_2AZ_P1, HEADER + " Engine Control Terminal IGT1 - E1 0.1 to 4.5 V"),
    figure: { pageNumber: 2, text: "0.1 to 4.5 V", occurrence: 1 },
    profile: profile(),
    axes: ["engine"],
    expected: "other_variant",
    rationale:
      "Page 2 opens with the account header; blanked, it cannot outrank the carried-in 2AZ-FE diagram scope as a row_label would.",
  },
  {
    id: "fp-14",
    category: "false_positive",
    pages: doc("Brake actuator with VSC Actuator x Bracket 19 N*m"),
    figure: { pageNumber: 1, text: "19 N*m", occurrence: 1 },
    profile: profile(),
    axes: ["engine"],
    expected: "not_stated",
    rationale: "VSC text is not an engine token, and the VSC axis is not classified in P1.",
  },
  {
    id: "fp-15",
    category: "false_positive",
    pages: doc("(for 2AZ-FE) Clip label 2ZR-FEX Bracket MX2ZR-FE Bolt 8.0 N*m"),
    figure: { pageNumber: 1, text: "8.0 N*m", occurrence: 1 },
    profile: profile(),
    axes: ["engine"],
    expected: "other_variant",
    rationale:
      "Codes glued inside longer words fail the token regex's word boundaries, so they cannot close the 2AZ-FE block and make the figure apply.",
  },
  {
    id: "fp-16",
    category: "false_positive",
    pages: doc("Parts made by TMC Bracket bolt 30 N*m"),
    figure: { pageNumber: 1, text: "30 N*m", occurrence: 1 },
    profile: profile(),
    axes: ["engine", "plant"],
    expected: "not_stated",
    rationale: "\"TMC\" without a following \"Made\" is not a plant token, so neither axis is scoped.",
  },
  {
    id: "fp-17",
    category: "false_positive",
    pages: doc("(for 2ZR-FE) * 1: with VSC * 2: without VSC Actuator bolt 17 N*m"),
    figure: { pageNumber: 1, text: "17 N*m", occurrence: 1 },
    profile: profile(),
    axes: ["engine"],
    expected: "applies",
    rationale:
      "A \"* n:\" footnote key is only a legend when it precedes an engine token; these key VSC options, so the owner's inline scope is untouched.",
  },

  // =========================================================================
  // plant_axis
  // =========================================================================
  {
    id: "plant-01",
    category: "plant_axis",
    pages: doc(ENGINE_MOUNT),
    figure: { pageNumber: 1, text: "52 N*m", occurrence: 1 },
    profile: profile(),
    axes: ["engine", "plant"],
    expected: "other_variant",
    rationale:
      "Right engine, wrong plant (S6): engine applies, but \"for TMC Made\" is plant TMC (exclude: false) and the owner is NUMMI, so the plant axis is other_variant, which wins.",
  },
  {
    id: "plant-02",
    category: "plant_axis",
    pages: doc(ENGINE_MOUNT),
    figure: { pageNumber: 1, text: "58 N*m", occurrence: 1 },
    profile: profile(),
    axes: ["engine", "plant"],
    expected: "applies",
    rationale: "\"Except TMC Made\" is TMC with exclude: true; owner NUMMI differs, so the plant axis applies, as does the engine.",
  },
  {
    id: "plant-03",
    category: "plant_axis",
    pages: doc(ENGINE_MOUNT),
    figure: { pageNumber: 1, text: "58 N*m", occurrence: 1 },
    profile: profile({ buildPlant: "TMC" }),
    axes: ["engine", "plant"],
    expected: "other_variant",
    rationale: "exclude: true and the owner value equals it (TMC), so the plant axis is other_variant.",
  },
  {
    id: "plant-04",
    category: "plant_axis",
    pages: doc(ENGINE_MOUNT),
    figure: { pageNumber: 1, text: "58 N*m", occurrence: 1 },
    profile: profile({ buildPlant: null }),
    axes: ["engine", "plant"],
    expected: "unresolved",
    rationale:
      "A scoped plant with a null owner plant is unresolved, even under exclude: true; the engine applies, and unresolved outranks applies when combining.",
  },
  {
    id: "plant-05",
    category: "plant_axis",
    pages: doc(ENGINE_MOUNT),
    figure: { pageNumber: 1, text: "52 N*m", occurrence: 1 },
    profile: profile({ buildPlant: "TMC" }),
    axes: ["engine", "plant"],
    expected: "applies",
    rationale: "\"for TMC Made\" (exclude: false) equals the owner's TMC, and the engine is 2ZR-FE.",
  },
  {
    id: "plant-06",
    category: "plant_axis",
    pages: doc(ENGINE_MOUNT),
    figure: { pageNumber: 1, text: "58 N*m", occurrence: 1 },
    profile: profile({ buildPlant: "TMMC" }),
    axes: ["engine", "plant"],
    expected: "applies",
    rationale: "\"Except TMC Made\" covers any plant other than TMC, including TMMC (design §6.1).",
  },
  {
    id: "plant-07",
    category: "plant_axis",
    pages: doc(ROW_LABEL_TABLE),
    figure: { pageNumber: 1, text: "92 mm", occurrence: 1 },
    profile: profile(),
    axes: ["engine", "plant"],
    expected: "other_variant",
    rationale:
      "The engine row is 2ZR-FE but the open plant row is \"for TMC Made\"; owner NUMMI differs, so the figure is refused.",
  },
  {
    id: "plant-08",
    category: "plant_axis",
    pages: doc(ROW_LABEL_TABLE),
    figure: { pageNumber: 1, text: "97 mm", occurrence: 1 },
    profile: profile({ buildPlant: null }),
    axes: ["engine", "plant"],
    expected: "other_variant",
    rationale: "Engine 2AZ-FE is other_variant and plant is unresolved (null owner); any other_variant wins the combination.",
  },
  {
    id: "plant-09",
    category: "plant_axis",
    pages: doc(NUMMI_TMMC_TABLE),
    figure: { pageNumber: 1, text: "61 mm", occurrence: 1 },
    profile: profile(),
    axes: ["engine", "plant"],
    expected: "applies",
    rationale: "\"NUMMI Made\" row_label equals the owner's NUMMI and the engine row is 2ZR-FE.",
  },
  {
    id: "plant-10",
    category: "plant_axis",
    pages: doc(NUMMI_TMMC_TABLE),
    figure: { pageNumber: 1, text: "64 mm", occurrence: 1 },
    profile: profile(),
    axes: ["engine", "plant"],
    expected: "other_variant",
    rationale: "\"TMMC Made\" closes the NUMMI row (same axis) and differs from the owner's NUMMI.",
  },
  {
    id: "plant-11",
    category: "plant_axis",
    pages: doc(NUMMI_TMMC_TABLE),
    figure: { pageNumber: 1, text: "64 mm", occurrence: 1 },
    profile: profile({ buildPlant: "TMMC" }),
    axes: ["engine", "plant"],
    expected: "applies",
    rationale: "Owner TMMC equals the TMMC row.",
  },
  {
    id: "plant-12",
    category: "plant_axis",
    pages: doc("Rear height. TMMT made 2ZR-FE 66 mm"),
    figure: { pageNumber: 1, text: "66 mm", occurrence: 1 },
    profile: profile(),
    axes: ["engine", "plant"],
    expected: "other_variant",
    rationale: "The plant regex is case-insensitive, so \"TMMT made\" is plant TMMT; TMMT is never an owner plant, so it differs from NUMMI.",
  },
  {
    id: "plant-13",
    category: "plant_axis",
    pages: doc(DIAGRAM_2AZ_EXCEPT_TMC),
    figure: { pageNumber: 1, text: "4.5 to 5.5 V", occurrence: 1 },
    profile: profile(),
    axes: ["engine", "plant"],
    expected: "other_variant",
    rationale: "Diagram title gives engine 2AZ-FE (other_variant) and plant except-TMC (applies for NUMMI); other_variant wins.",
  },
  {
    id: "plant-14",
    category: "plant_axis",
    pages: doc(DIAGRAM_2ZR_EXCEPT_TMC),
    figure: { pageNumber: 1, text: "4.6 to 5.4 V", occurrence: 1 },
    profile: profile({ buildPlant: "TMC" }),
    axes: ["engine", "plant"],
    expected: "other_variant",
    rationale: "Owner engine matches, but the diagram excludes TMC and the owner is TMC.",
  },
  {
    id: "plant-15",
    category: "plant_axis",
    pages: doc(DIAGRAM_2ZR_EXCEPT_TMC),
    figure: { pageNumber: 1, text: "4.6 to 5.4 V", occurrence: 1 },
    profile: profile(),
    axes: ["engine", "plant"],
    expected: "applies",
    rationale: "Engine 2ZR-FE equals the owner, and NUMMI is not the excluded TMC.",
  },
  {
    id: "plant-16",
    category: "plant_axis",
    pages: doc(DIAGRAM_2ZR_EXCEPT_TMC),
    figure: { pageNumber: 1, text: "4.6 to 5.4 V", occurrence: 1 },
    profile: profile({ buildPlant: null }),
    axes: ["engine", "plant"],
    expected: "unresolved",
    rationale: "The plant axis is scoped and the owner plant is unknown; unknown is never compatible.",
  },
  {
    id: "plant-17",
    category: "plant_axis",
    pages: doc("Front height. for TMC Made 2AZ-FE 95 mm 2ZR-FE 91 mm"),
    figure: { pageNumber: 1, text: "91 mm", occurrence: 1 },
    profile: profile(),
    axes: ["engine", "plant"],
    expected: "other_variant",
    rationale:
      "Engine markers do not close a plant row (extent is per axis), so 91 mm is still \"for TMC Made\"; owner NUMMI differs.",
  },
  {
    id: "plant-18",
    category: "plant_axis",
    pages: doc(
      "for TMC Made (for 2ZR-FE) Bracket bolt 52 N*m 4. INSTALL MOUNT INSULATOR (for 2ZR-FE) Insulator nut 47 N*m",
    ),
    figure: { pageNumber: 1, text: "47 N*m", occurrence: 1 },
    profile: profile(),
    axes: ["engine", "plant"],
    expected: "applies",
    rationale:
      "\"4. INSTALL\" is a numbered-step boundary, which ends the plant row_label too; after it the plant axis is null and the new (for 2ZR-FE) applies.",
  },
  {
    id: "plant-19",
    category: "plant_axis",
    pages: doc(
      "Starting System <2ZR-FE , for TMC Made> (ST) Terminal 50 - Body ground 8 V or more",
      HEADER + " Starting System Terminal 30 - Body ground 11 to 14 V",
    ),
    figure: { pageNumber: 2, text: "11 to 14 V", occurrence: 1 },
    profile: profile(),
    axes: ["engine", "plant"],
    expected: "other_variant",
    rationale:
      "\"for TMC Made\" inside <...> is a plant diagram_title, which crosses pages; page 2 is still TMC-only and the owner is NUMMI.",
  },
  {
    id: "plant-20",
    category: "plant_axis",
    pages: doc("Mount bolt (Except TMC Made) Bolt 64 N*m"),
    figure: { pageNumber: 1, text: "64 N*m", occurrence: 1 },
    profile: profile({ buildPlant: "TMMC" }),
    axes: ["engine", "plant"],
    expected: "applies",
    rationale:
      "A plant token inside parentheses is inline_for; exclude TMC with owner TMMC applies, and the engine axis is not_stated, so the combination is applies.",
  },
  {
    id: "plant-21",
    category: "plant_axis",
    pages: doc("Mount bolt (Except TMC Made) Bolt 64 N*m"),
    figure: { pageNumber: 1, text: "64 N*m", occurrence: 1 },
    profile: profile({ buildPlant: null }),
    axes: ["engine", "plant"],
    expected: "unresolved",
    rationale: "Plant scoped, owner plant null: unresolved; engine not_stated does not soften it.",
  },
  {
    id: "plant-22",
    category: "plant_axis",
    pages: doc("Vehicle > Engine > Engine Mount TMC_Made (2ZR-FE) HINT: Mount bolt 53 N*m"),
    figure: { pageNumber: 1, text: "53 N*m", occurrence: 1 },
    profile: profile(),
    axes: ["engine", "plant"],
    expected: "other_variant",
    rationale:
      "Task 6 says the underscore form TMC_Made counts in titles; this is an article title, so the plant is TMC (row_label) and owner NUMMI differs.",
    specAmbiguity:
      "\"In filenames and titles the underscore form TMC_Made counts too\" does not say whether page text titles qualify, or which kind such a plant token is. If it is not detected, the plant axis is not_stated and the TMC-only figure would apply. The fail-closed reading (detected) is used.",
  },

  // =========================================================================
  // extent
  // =========================================================================
  {
    id: "extent-01",
    category: "extent",
    pages: doc(ARTICLE_2AZ_P1, ARTICLE_2AZ_P2),
    figure: { pageNumber: 2, text: "24 N*m", occurrence: 1 },
    profile: profile(),
    axes: ["engine"],
    expected: "other_variant",
    rationale:
      "\"(2AZ-FE)\" inside the Vehicle > article span is an article_title, which crosses pages; page 2 has no marker of its own (S3: the header names the owner's engine, the title does not).",
  },
  {
    id: "extent-02",
    category: "extent",
    pages: doc(
      HEADER + " CAMSHAFT (for 2AZ-FE) Bearing cap bolt 16 N*m",
      HEADER + " Bearing cap bolt second pass 23 N*m",
    ),
    figure: { pageNumber: 2, text: "23 N*m", occurrence: 1 },
    profile: profile(),
    axes: ["engine"],
    expected: "not_stated",
    rationale: "inline_for does not cross to the next page, and carryOut keeps only article and diagram scope.",
    specAmbiguity:
      "Not unclear, but a residual risk worth a ruling: a 2AZ-FE block that continues over a page break reaches page 2 as not_stated, which design §6.2 accepts with a note rather than refusing.",
  },
  {
    id: "extent-03",
    category: "extent",
    pages: doc(
      "Charging System <2AZ-FE , Except TMC Made> (B) Terminal B - Body ground 13.2 to 14.8 V",
      HEADER + " Charging System Alternator connector check continued",
      HEADER + " Charging System Terminal IG - Body ground 11 to 14 V",
    ),
    figure: { pageNumber: 3, text: "11 to 14 V", occurrence: 1 },
    profile: profile(),
    axes: ["engine"],
    expected: "other_variant",
    rationale: "A diagram_title lasts until the next diagram_title or article span and crosses pages, so it reaches page 3 through a marker-free page 2.",
  },
  {
    id: "extent-04",
    category: "extent",
    pages: doc(
      HEADER +
        " Vehicle > Engine > Engine Control > Diagrams (2ZR-FE) HINT: Wiring sheet Engine Control <2AZ-FE> (ECM) " +
        "(for 2ZR-FE) Terminal VC - E2 4.7 to 5.3 V 3. CHECK HARNESS Terminal VG - E2 0.5 to 3.0 V",
    ),
    figure: { pageNumber: 1, text: "4.7 to 5.3 V", occurrence: 1 },
    profile: profile(),
    axes: ["engine"],
    expected: "applies",
    rationale:
      "Article 2ZR-FE, diagram 2AZ-FE and inline 2ZR-FE are all open at the figure; inline_for outranks diagram_title outranks article_title.",
  },
  {
    id: "extent-05",
    category: "extent",
    pages: doc(
      HEADER +
        " Vehicle > Engine > Engine Control > Diagrams (2ZR-FE) HINT: Wiring sheet Engine Control <2AZ-FE> (ECM) " +
        "(for 2ZR-FE) Terminal VC - E2 4.7 to 5.3 V 3. CHECK HARNESS Terminal VG - E2 0.5 to 3.0 V",
    ),
    figure: { pageNumber: 1, text: "0.5 to 3.0 V", occurrence: 1 },
    profile: profile(),
    axes: ["engine"],
    expected: "other_variant",
    rationale:
      "\"3. CHECK\" ends the inline scope but not the diagram or article; of those two, diagram_title (2AZ-FE) outranks article_title (2ZR-FE).",
  },
  {
    id: "extent-06",
    category: "extent",
    pages: doc(
      "Vehicle > Engine > Engine Control > Diagrams (2AZ-FE) HINT: Wiring sheet Engine Control <2ZR-FE> (ECM) Terminal THW - E2 0.2 to 1.0 V",
    ),
    figure: { pageNumber: 1, text: "0.2 to 1.0 V", occurrence: 1 },
    profile: profile(),
    axes: ["engine"],
    expected: "applies",
    rationale: "diagram_title 2ZR-FE outranks article_title 2AZ-FE at the same offset.",
  },
  {
    id: "extent-07",
    category: "extent",
    pages: doc("(for 2ZR-FE) Oil filter cap 25 N*m 2AZ-FE Oil filter union 30 N*m"),
    figure: { pageNumber: 1, text: "30 N*m", occurrence: 1 },
    profile: profile(),
    axes: ["engine"],
    expected: "other_variant",
    rationale: "A later row_label on the same axis closes the earlier inline_for; 30 N*m is in the 2AZ-FE row.",
  },
  {
    id: "extent-08",
    category: "extent",
    pages: doc("(for 2AZ-FE) Mount bolt 30 N*m (for TMC Made) Mount nut 32 N*m"),
    figure: { pageNumber: 1, text: "32 N*m", occurrence: 1 },
    profile: profile(),
    axes: ["engine"],
    expected: "other_variant",
    rationale: "A plant marker is on the other axis, so it does not close the engine inline scope; 32 N*m is still 2AZ-FE.",
  },
  {
    id: "extent-09",
    category: "extent",
    pages: doc(
      "Vehicle > Engine > Engine Mechanical > Cylinder Head > Installation (2AZ-FE) HINT: Torque in sequence. " +
        "(for 2ZR-FE) Camshaft housing bolt 27 N*m 9. INSTALL CYLINDER HEAD COVER Cover bolt 10 N*m",
    ),
    figure: { pageNumber: 1, text: "10 N*m", occurrence: 1 },
    profile: profile(),
    axes: ["engine"],
    expected: "other_variant",
    rationale:
      "Past the numbered step the inline 2ZR-FE scope is gone and the article 2AZ-FE scope shows through again; it must not fall to null or stay 2ZR-FE.",
  },
  {
    id: "extent-10",
    category: "extent",
    pages: doc("(for 2AZ-FE) Pump bolt 30 N*m 7. Install the pulley Pulley bolt 11 N*m"),
    figure: { pageNumber: 1, text: "11 N*m", occurrence: 1 },
    profile: profile(),
    axes: ["engine"],
    expected: "other_variant",
    rationale:
      "\"7. Install\" is not a step boundary (the pattern needs two capitals after the number), so the 2AZ-FE inline scope continues.",
  },
  {
    id: "extent-11",
    category: "extent",
    pages: doc("Engine Control <2AZ-FE> (ECM) 2. CHECK SENSOR Terminal PIM - E2 3.3 to 3.9 V"),
    figure: { pageNumber: 1, text: "3.3 to 3.9 V", occurrence: 1 },
    profile: profile(),
    axes: ["engine"],
    expected: "other_variant",
    rationale: "A numbered step ends only inline_for/row_label scopes; the diagram_title scope survives it.",
  },
  {
    id: "extent-12",
    category: "extent",
    pages: doc(
      ARTICLE_2AZ_P1,
      HEADER + " Vehicle > Brakes > Disc Brake > Specifications HINT: Rotor minimum thickness 25.0 mm",
    ),
    figure: { pageNumber: 2, text: "25.0 mm", occurrence: 1 },
    profile: profile(),
    axes: ["engine"],
    expected: "not_stated",
    rationale: "An article_title lasts until \"the next article span\"; page 2 opens a new article span with no engine, so nothing is in scope.",
    specAmbiguity:
      "The extent table ends article (and diagram) scope at the next article SPAN, but Task 7 implements one sweep over sorted MARKERS, and a span without an engine code yields no marker. A marker-only sweep would carry 2AZ-FE into the brake article (other_variant). The rule text is followed here.",
  },
  {
    id: "extent-13",
    category: "extent",
    pages: doc(
      DIAGRAM_2AZ_P1,
      HEADER + " Vehicle > Body > Lighting > Specifications HINT: Headlamp bulb rating 55 W",
    ),
    figure: { pageNumber: 2, text: "55 W", occurrence: 1 },
    profile: profile(),
    axes: ["engine"],
    expected: "not_stated",
    rationale: "A diagram_title lasts until the next diagram_title or article span; page 2's article span ends it.",
    specAmbiguity: "Same question as extent-12, for a carried diagram scope: a span without an engine code is not a marker.",
  },
  {
    id: "extent-14",
    category: "extent",
    pages: doc(
      DIAGRAM_2AZ_P1,
      HEADER + " Vehicle > Engine > Cooling > Specifications (2ZR-FE) HINT: Fan motor current 7.5 to 9.5 A",
    ),
    figure: { pageNumber: 2, text: "7.5 to 9.5 A", occurrence: 1 },
    profile: profile(),
    axes: ["engine"],
    expected: "applies",
    rationale: "The page 2 article span ends the carried 2AZ-FE diagram, and its own (2ZR-FE) article_title applies.",
  },
  {
    id: "extent-15",
    category: "extent",
    pages: doc(
      HEADER + " Vehicle > Engine > Engine Mechanical > Drive Belt > Inspection (for 2AZ-FE) HINT: Deflection 9.5 mm",
      HEADER + " Tension with new belt 650 to 750 N",
    ),
    figure: { pageNumber: 2, text: "650 to 750 N", occurrence: 1 },
    profile: profile(),
    axes: ["engine"],
    expected: "other_variant",
    rationale:
      "The token is inside the article span and inside parentheses; article_title is checked first, so the scope crosses to page 2.",
    specAmbiguity:
      "article_title requires the token to be \"parenthesized, (2AZ-FE)\". Does \"(for 2AZ-FE)\" inside the title line count? If it is inline_for instead, page 2 is not_stated. The fail-closed reading (article_title) is used.",
  },
  {
    id: "extent-16",
    category: "extent",
    pages: doc(
      HEADER + " Vehicle > Engine > 2AZ-FE Engine Mechanical > Oil Pump > Specifications HINT: Relief valve spring free length 48 mm",
      HEADER + " Rotor tip clearance 0.16 mm",
    ),
    figure: { pageNumber: 2, text: "0.16 mm", occurrence: 1 },
    profile: profile(),
    axes: ["engine"],
    expected: "not_stated",
    rationale:
      "An unparenthesized code in the title line is not an article_title (Task 6 requires parentheses); it is a row_label, which does not cross pages.",
    specAmbiguity:
      "Design §6.1 says an engine anywhere in the path/title line is article scope; the plan pins parentheses. The binding plan is followed, which lets page 2 of a 2AZ-FE-only article through as not_stated.",
  },
  {
    id: "extent-17",
    category: "extent",
    pages: doc(
      "Wiring <Engine Control System Sheet With Cruise Control And Immobiliser Option Package 2AZ-FE Variant> Terminal VTA - E2 0.3 to 1.0 V",
      HEADER + " Terminal VTA - E2 fully open 3.2 to 4.9 V",
    ),
    figure: { pageNumber: 2, text: "3.2 to 4.9 V", occurrence: 1 },
    profile: profile(),
    axes: ["engine"],
    expected: "not_stated",
    rationale:
      "The <...> group is over 80 characters, so the code is not a diagram_title; it falls through to row_label, which stops at page end.",
  },
  {
    id: "extent-18",
    category: "extent",
    pages: doc(
      HEADER +
        " Vehicle > Engine > Engine Mechanical > Water Pump > Installation (2AZ-FE) HINT: Torque table. (for 2ZR-FE) Pump bolt 11 N*m",
      HEADER + " Pump pulley bolt 21 N*m",
    ),
    figure: { pageNumber: 2, text: "21 N*m", occurrence: 1 },
    profile: profile(),
    axes: ["engine"],
    expected: "other_variant",
    rationale:
      "The page 1 inline 2ZR-FE scope stops at page end; only the article 2AZ-FE scope is carried, so page 2 is other_variant, not applies.",
  },
  {
    id: "extent-19",
    category: "extent",
    pages: doc(DIAGRAM_2AZ_P1, HEADER + " Engine Control <Except TMC Made> (ECM) Terminal THW - E2 0.2 to 1.0 V"),
    figure: { pageNumber: 2, text: "0.2 to 1.0 V", occurrence: 1 },
    profile: profile(),
    axes: ["engine"],
    expected: "other_variant",
    rationale: "A plant-only diagram title opens a plant scope; scopes are per axis, so the carried engine diagram 2AZ-FE stays.",
    specAmbiguity:
      "The diagram_title extent says \"the next diagram_title\" without \"on the same axis\" (the inline rule says it explicitly). If any diagram title ends the engine scope, this figure is not_stated. The fail-closed per-axis reading is used.",
  },
  {
    id: "extent-20",
    category: "extent",
    pages: doc(
      HEADER + " Vehicle > Engine > Lubrication > Oil Pump > Installation (2ZR-FE) HINT: Pump bolt 9.0 N*m",
      HEADER + " Oil strainer (for 2AZ-FE) Strainer nut 12 N*m 5. INSTALL OIL PAN Pan bolt 10 N*m",
    ),
    figure: { pageNumber: 2, text: "12 N*m", occurrence: 1 },
    profile: profile(),
    axes: ["engine"],
    expected: "other_variant",
    rationale: "An inline_for on page 2 outranks the carried-in 2ZR-FE article scope.",
  },
  {
    id: "extent-21",
    category: "extent",
    pages: doc(
      HEADER + " Vehicle > Engine > Lubrication > Oil Pump > Installation (2ZR-FE) HINT: Pump bolt 9.0 N*m",
      HEADER + " Oil strainer (for 2AZ-FE) Strainer nut 12 N*m 5. INSTALL OIL PAN Pan bolt 10 N*m",
    ),
    figure: { pageNumber: 2, text: "10 N*m", occurrence: 1 },
    profile: profile(),
    axes: ["engine"],
    expected: "applies",
    rationale: "After \"5. INSTALL\" ends the inline scope, the carried-in article 2ZR-FE scope is in effect again.",
  },
  {
    id: "extent-22",
    category: "extent",
    pages: doc("Sensor check (for 2AZ-FE) " + FILLER_400 + " Sensor bolt 7.5 N*m"),
    figure: { pageNumber: 1, text: "7.5 N*m", occurrence: 1 },
    profile: profile(),
    axes: ["engine"],
    expected: "other_variant",
    rationale:
      "An inline scope lasts to page end however many chunk windows it spans; the figure about 400 words later is still 2AZ-FE.",
  },
];

/** @type {ReadonlyArray<ApplicabilityOracleRow>} */
export const INDEPENDENT_APPLICABILITY_ORACLE = Object.freeze(ROWS);
