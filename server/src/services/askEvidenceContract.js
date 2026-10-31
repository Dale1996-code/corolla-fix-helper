import { createHash } from "node:crypto";

// Ask evidence contract (Milestone 2), controlled by config.askEvidenceContract.
//
// The problem this exists for: without it, the model returns one undifferentiated
// prose blob, every retrieved chunk becomes a citation, and nothing checks that
// the prose is actually supported by those citations. A confident sentence
// containing an invented torque value renders exactly like a sourced one.
//
// The contract instead asks for ATOMIC CLAIMS, each carrying a verbatim
// evidenceQuote and a prompt-local source id (S1, S2, ...). The server then:
//   1. validates the shape (hand-written; no new dependency),
//   2. maps each source id back to the chunk it was built from,
//   3. verifies the quote really is a substring of that chunk,
//   4. runs a numeric ANOMALY DETECTOR over every channel,
//   5. derives answered / partial / not_found itself.
//
// Prompt-local ids, never database row ids: chunk ids are recreated on
// re-extraction (documentChunkService rebuilds them), so a row id in a model
// reply would be meaningless the moment a document is re-extracted.
//
// This module imports only Node's built-in crypto helper. The identifier it
// creates is server-owned; the model never supplies it.

/** Max claims/guidance/gaps we will accept, so a runaway reply stays bounded. */
const MAX_ITEMS = 40;
const MAX_TEXT_LENGTH = 2000;

/**
 * JSON schema sent as `text.format`. Kept deliberately small: more structure
 * means more ways for the model to fail the schema and cost a retry.
 */
export const EVIDENCE_RESPONSE_SCHEMA = {
  type: "json_schema",
  name: "grounded_repair_answer",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["documentSupported", "generalGuidance", "gaps"],
    properties: {
      documentSupported: {
        type: "array",
        description:
          "Claims taken from the provided sources. Each needs a verbatim quote.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["claim", "sourceId", "evidenceQuote"],
          properties: {
            claim: { type: "string" },
            sourceId: { type: "string", description: "One of the S1..Sn labels." },
            evidenceQuote: {
              type: "string",
              description: "Text copied EXACTLY from that source, supporting the claim.",
            },
          },
        },
      },
      generalGuidance: {
        type: "array",
        description: "General mechanical knowledge NOT taken from the sources.",
        items: { type: "string" },
      },
      gaps: {
        type: "array",
        description: "What the sources do not answer.",
        items: { type: "string" },
      },
    },
  },
};

/** Stable prompt-local label for the nth retrieved chunk. */
export function sourceLabel(index) {
  return `S${index + 1}`;
}

/**
 * Build the source block. Labels are positional and prompt-local; the mapping
 * back to real chunks never leaves the server.
 */
export function buildEvidenceContext(chunks) {
  return chunks
    .map(
      (chunk, index) =>
        `[${sourceLabel(index)}] ${chunk.documentTitle} (${chunk.originalFilename}) page ${
          chunk.pageNumber
        }: ${chunk.chunkText}`
    )
    .join("\n\n");
}

export function buildEvidencePromptLines({ question, originalQuestion, hasImage }) {
  const lines = [
    "You answer Toyota Corolla repair questions from the provided sources only.",
    "Return JSON matching the schema. Do not write prose outside the schema.",
    "",
    "documentSupported: one entry per ATOMIC claim you take from the sources.",
    "  - claim: one short, self-contained statement. Split multi-part facts apart.",
    "  - sourceId: the S-label of the source it came from.",
    "  - evidenceQuote: text copied EXACTLY, character for character, from that",
    "    source. It must contain the specific value or instruction the claim makes.",
    "    For a specification, include the named part and its value in the quote;",
    "    a value by itself is not enough to prove which part it belongs to.",
    "    Never paraphrase a quote. Never combine text from two sources into one quote.",
    "  - Row scope: quote ONLY the one table row or sentence that prints the figure",
    "    you claim -- not the table around it, and not the rows before or after it.",
    "    A long quote lets one row's figure sit beside another row's part name.",
    "  - Subject: begin the claim with a subject made of the words that SAME row or",
    "    sentence prints: its part or row label, then what is measured (for example",
    "    'ROW LABEL capacity'). Never use words from a heading or from another row.",
    "    A bare 'the capacity is ...' or 'the torque is ...' names nothing, so the",
    "    server cannot check it. If the row prints no part name, use its own label",
    "    as the subject, even if that reads stiffly.",
    "  - Conditions: if a condition that changes the figure (engine speed, with or",
    "    without a filter, front or rear, new or used) is printed in a different row",
    "    or sentence of the SAME source, give that condition its own claim with its",
    "    own quote and put it first. The figure claim may point back to it in words",
    "    only ('for that check'); never repeat the condition's number or unit there,",
    "    because the figure's own quote does not print it. Never state a figure as if",
    "    it always held when the source prints it only under a condition.",
    "  - Words and figures: use only what the claim's own quote prints. Every number",
    "    in the claim must be printed there, and so must every qualifier you state --",
    "    a load, speed, temperature, filter, or any other condition. Never add one",
    "    from a heading or from memory.",
    "  - Missing qualifier: if a figure holds only under a qualifier (new or used,",
    "    minimum or maximum, with or without, an engine speed or load) and neither",
    "    the figure's own quote nor a condition claim from the SAME source prints it,",
    "    leave out the WHOLE figure claim. Do not drop the qualifier and state the",
    "    figure alone, and do not join text from two sources into one quote, even two",
    "    pages of one document. Instead add a gap saying which figure the sources do",
    "    not tie to its condition, without the number.",
    "generalGuidance: general mechanical advice NOT found in the sources. Never put",
    "  a torque figure, capacity, pressure, clearance, or other specification here.",
    "gaps: what the sources do not cover, so the owner knows what to look up.",
    "",
    "If the sources do not support an answer, return empty documentSupported and",
    "explain the gap. Never invent a specification, step, tool, or warning.",
  ];

  if (hasImage) {
    lines.push(
      "",
      "An image is attached. You may describe it in generalGuidance to acknowledge",
      "what the owner is showing, but it is NEVER a source for a specification,",
      "procedure, or torque value -- those must come from the sources and be quoted."
    );
  }

  lines.push(
    "",
    `Original user question: ${originalQuestion || question}`,
    `Question: ${question}`
  );

  return lines;
}

// ---------------------------------------------------------------------------
// Hand-written validator. No runtime schema dependency: the repo deliberately
// avoids heavy dependencies, and this is one small fixed shape.
// ---------------------------------------------------------------------------

function readString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function readStringArray(value) {
  return value
    .map(readString)
    .filter(Boolean)
    .slice(0, MAX_ITEMS)
    .map((text) => text.slice(0, MAX_TEXT_LENGTH));
}

/**
 * Validate the parsed model reply.
 *
 * @param {any} payload
 * Claims past MAX_ITEMS are not checked, but they are counted: dropping them
 * silently let an answer whose last claims were never examined still read as
 * fully `answered` (1A-14). verifyEvidence turns the count into a gap.
 *
 * @returns {{ ok: boolean, reason?: string, value?: {
 *   documentSupported: Array<{claim: string, sourceId: string, evidenceQuote: string}>,
 *   generalGuidance: string[],
 *   gaps: string[],
 *   droppedClaimCount?: number,
 * } }}
 */
export function validateEvidencePayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, reason: "not_an_object" };
  }

  const payloadFields = new Set(["documentSupported", "generalGuidance", "gaps"]);

  if (Object.keys(payload).some((field) => !payloadFields.has(field))) {
    return { ok: false, reason: "unexpected_payload_field" };
  }

  if (!Array.isArray(payload.documentSupported)) {
    return { ok: false, reason: "documentSupported_not_an_array" };
  }

  if (!Array.isArray(payload.generalGuidance)) {
    return { ok: false, reason: "generalGuidance_not_an_array" };
  }

  if (!Array.isArray(payload.gaps)) {
    return { ok: false, reason: "gaps_not_an_array" };
  }

  if (payload.generalGuidance.some((item) => typeof item !== "string")) {
    return { ok: false, reason: "generalGuidance_item_not_a_string" };
  }

  if (payload.gaps.some((item) => typeof item !== "string")) {
    return { ok: false, reason: "gaps_item_not_a_string" };
  }

  const documentSupported = [];
  const claimFields = new Set(["claim", "sourceId", "evidenceQuote"]);

  for (const raw of payload.documentSupported.slice(0, MAX_ITEMS)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { ok: false, reason: "claim_not_an_object" };
    }

    if (Object.keys(raw).some((field) => !claimFields.has(field))) {
      return { ok: false, reason: "claim_unexpected_field" };
    }

    const claim = readString(raw.claim);
    const sourceId = readString(raw.sourceId);
    const evidenceQuote = readString(raw.evidenceQuote);

    if (!claim || !sourceId || !evidenceQuote) {
      return { ok: false, reason: "claim_missing_fields" };
    }

    documentSupported.push({
      claim: claim.slice(0, MAX_TEXT_LENGTH),
      sourceId,
      evidenceQuote: evidenceQuote.slice(0, MAX_TEXT_LENGTH),
    });
  }

  return {
    ok: true,
    value: {
      documentSupported,
      generalGuidance: readStringArray(payload.generalGuidance),
      gaps: readStringArray(payload.gaps),
      droppedClaimCount: Math.max(0, payload.documentSupported.length - MAX_ITEMS),
    },
  };
}

// ---------------------------------------------------------------------------
// Evidence verification
// ---------------------------------------------------------------------------

/** Normalize for substring comparison: whitespace, quotes, and case only. */
function normalizeForMatch(text) {
  return collapseForMatch(text).toLowerCase();
}

// normalizeForMatch without the lowercasing, for the one reader that needs the
// text as written: the subject parser tells a letter designator ("Bolt A") from
// the article "a" by its capital.
function collapseForMatch(text) {
  return String(text || "")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

const LETTER = /\p{L}/u;
const DIGIT = /\d/;
const DECIMAL_MARK = /[.,]/;

/** Does a quote placed at `at` start on a token boundary of the chunk? */
function startsOnBoundary(haystack, at, needle) {
  const previous = haystack[at - 1] || "";
  const beforePrevious = haystack[at - 2] || "";
  const startsNumber =
    DIGIT.test(needle[0]) || (DECIMAL_MARK.test(needle[0]) && DIGIT.test(needle[1] || ""));

  if (LETTER.test(needle[0]) && LETTER.test(previous)) {
    return false;
  }

  return !(
    startsNumber &&
    (DIGIT.test(previous) || (DECIMAL_MARK.test(previous) && DIGIT.test(beforePrevious)))
  );
}

/** Does a quote ending just before `end` end on a token boundary of the chunk? */
function endsOnBoundary(haystack, end, needle) {
  const last = needle[needle.length - 1];
  const beforeLast = needle[needle.length - 2] || "";
  const next = haystack[end] || "";
  const afterNext = haystack[end + 1] || "";

  if (LETTER.test(last) && LETTER.test(next)) {
    return false;
  }

  if (DIGIT.test(last) && (DIGIT.test(next) || (DECIMAL_MARK.test(next) && DIGIT.test(afterNext)))) {
    return false;
  }

  return !(DECIMAL_MARK.test(last) && DIGIT.test(beforeLast) && DIGIT.test(next));
}

/**
 * Is the quote genuinely present in the source chunk?
 *
 * Whitespace- and case-insensitive, because PDF extraction produces erratic
 * spacing, but otherwise strict: no paraphrase passes. This is checkable
 * server-side with no model cooperation, which is what makes it worth more than
 * a chunk id (a chunk id proves retrieval, not support).
 *
 * The quote must also start and end on token boundaries: never inside a word,
 * and never inside a number. A raw substring let "Wheel lug nut torque 10" be
 * "quoted" from "torque 103 N*m" and "5 N*m" from "25 N*m" (1A-03). Every
 * occurrence is tried, so a cut match earlier in the chunk cannot hide a whole
 * one later. Shared with the Repair Planner, which uses it for both of its
 * containment checks (quote in source, claim in quote).
 */
export function quoteAppearsInChunk(quote, chunkText) {
  const needle = normalizeForMatch(quote);
  const haystack = normalizeForMatch(chunkText);

  if (!needle || !haystack) {
    return false;
  }

  for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + 1)) {
    if (
      startsOnBoundary(haystack, at, needle) &&
      endsOnBoundary(haystack, at + needle.length, needle)
    ) {
      return true;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Numeric anomaly detector
// ---------------------------------------------------------------------------
//
// Named honestly: presence-matching cannot prove a number belongs to the right
// fastener or procedure stage. It can only prove the number is NOT in the cited
// evidence, which is the dangerous direction.
//
// Scoped, NOT a blanket ban on digits. Only unit-bearing technical
// specifications are gated. Step numbers, counts of bolts, page references, and
// ordinals pass untouched -- gating those would mangle ordinary procedure prose
// and push the model toward vaguer, less useful text.

// A unit this pattern does not know is a specification the verifier cannot
// check, so a spelling missing here once meant a figure passed unexamined: "50
// ft-lbs" against a printed 103 N*m, "5.5 L" or "5.5 qts" against 4.2 liters
// (3B-01). The torque spellings cover the manuals' own "ft.*lbf" and "in.*lbf"
// (two separators) and the owner's "ft-lbs", "ft lbs", and "lb-ft". US and
// Imperial quarts, pints, and gallons are different sizes, so "Imp." stays part
// of the unit; a bare "qt" is the US quart. "lmp." -- a lowercase L for the
// capital I, with its period -- is the same Imperial unit as the text layer of
// one oil-capacity page spells it (F3, 2026-10-28). Unread, it left that page's
// Imperial figure unchecked and every claim stating it rejected; it is never a
// US quart. A bare "L" is matched apart from this case-insensitive pattern --
// see VOLUME_SYMBOL_REGEX.
//
// "kgf/cm2", "kgf/cm²", and "kgf*cm2" are a PRESSURE (kilogram-force per square
// centimetre), tried before the "kgf*cm" torque spelling they start with. The
// trailing "2" once defeated the unit's word boundary, so the ASCII forms were
// not detected at all, and "kgf/cm²" was read as kgf*cm and filed with torque
// (1A-13). A "kgf/cm" with no "2" can only be a pressure misprinted.
//
// Also detected since 1A-04: inches ("0.906 in." -- the abbreviation needs its
// period or closing punctuation, so the preposition in "2 in the bracket" is
// never a length), miles and kilometres, a turn angle ("an additional 90°", a
// degree sign with no C or F after it), percentages, kilovolts, and milliohms
// and megohms. Each of these let a wrong figure pass unchecked.
const UNIT_PATTERN =
  "n\\s*[·.*\\-]?\\s*m|nm|newton[-\\s]*met(?:er|re)s?|" +
  "ft\\.?\\s*[-·.*]?\\s*lb[fs]?|lb[fs]?\\s*[-·.*]?\\s*ft|foot[-\\s]*pounds?|" +
  "in\\.?\\s*[-·.*]?\\s*lb[fs]?|lb[fs]?\\s*[-·.*]\\s*in|inch[-\\s]*pounds?|" +
  "kgf?\\s*[-·.*\\/]?\\s*cm[2²]|kgf\\s*\\/\\s*cm|" +
  "kgf\\s*[-·.*]?\\s*cm(?![2²])|kgf\\s*[-·.*]?\\s*m|kg\\s*[-·.*]?\\s*cm(?![2²])|" +
  "kpa|mpa|psi|bar|" +
  "millimet(?:er|re)s?|mm|centimet(?:er|re)s?|cm|micron?s?|" +
  "inch(?:es)?|in\\.|in(?=[)\\],;:]|$)|" +
  "lit(?:er|re)s?|ml|millilit(?:er|re)s?|" +
  "(?:imp(?:\\.|erial)?|lmp\\.)\\s*(?:qts?|quarts?|pints?|gal(?:lons?)?)|" +
  "(?:US\\s*)?(?:qts?|quarts?|pints?|gal(?:lons?)?)|fl\\s*oz|" +
  "miles?|kilomet(?:er|re)s?|km\\s*\\/\\s*h|kph|mph|km|" +
  "ohms?|kilohms?|k\\s*ohms?|milliohms?|meg(?:a)?ohms?|Ω(?=[A-Za-z0-9_])|" +
  "volts?|millivolts?|kilovolts?|amps?|amperes?|milliamp(?:ere)?s?|" +
  "°\\s*[cf]|deg(?:rees)?\\s*[cf]\\b|(?:°\\s*|deg(?:rees)?\\s*)?(?:celsius|fahrenheit)|" +
  "°|deg(?:rees)?|%|percent|" +
  "rpm|hz|kilohertz|khz";

// One number as these manuals print it, read as a whole token. A comma followed
// by groups of exactly three digits is a thousands separator ("1,500 kPa",
// "1,050 kgf*cm", "100,000 miles"); a comma followed by one or two digits and
// nothing more is a decimal mark ("12,6 V"). Reading every comma as a decimal
// point made "1,500" the number 1.5, so a wrong 1,000 kPa looked close to it and
// a correct "1500" was rejected against it. Order matters: the grouped form is
// tried first, and a grouped or comma-decimal number may not run on into
// another digit.
const NUMBER_PATTERN = String.raw`(?:\d{1,3}(?:,\d{3})+(?:\.\d+)?(?!\d)|\d+,\d{1,2}(?!\d|,\d)|\d+(?:\.\d+)?)`;

// Refuses a start inside a number, so a scan that failed on "1,5000" cannot
// pick up the "5000" behind the comma, or the "5" of "1.5".
const NOT_INSIDE_NUMBER = String.raw`(?<!\d|\d[.,])`;

/** The value of one NUMBER_PATTERN token. */
function parseNumber(text) {
  const raw = String(text);

  return Number(
    /^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(raw) ? raw.replace(/,/g, "") : raw.replace(",", ".")
  );
}

// A minus sign belongs to the value only when it stands in front of it -- at the
// start, or after a space, bracket, or colon. Between two digits ("9-16V") it
// separates a range, and after a letter ("B-12V") it joins an identifier. A
// dropped sign let "-5 V" pass against a printed "5 V".
const signGroup = (name) => String.raw`(?:(?<=^|[\s(\[:])(?<${name}>[-−]))?`;

// What may stand between a range's two ends: "9-16V" (a bare hyphen, so a dash
// used as punctuation, "bolt 1 - 37 N*m", is not read as a range), an en dash,
// em dash, or tilde with or without spaces, or the word "to".
const RANGE_SEPARATOR = String.raw`(?:-|\s*[–—~]\s*|\s+(?:to|TO|To)\s+)`;

// The low end of a range may not continue an identifier ("M10-1.25 mm").
const RANGE_LOW_GUARD = String.raw`(?<![A-Za-z0-9_]|\d[.,])`;

/**
 * One specification regex: a value and its unit, optionally preceded by the
 * low end of a range that unit also applies to. Until both ends were read, only
 * the number touching the unit was checked: a wrong lower bound ("5 to 14 V"
 * against "10.5 to 14 V") passed, and a correct one ("80 °C" from "80 to 84
 * °C") was rejected because the printed 80 was never read as a temperature.
 * Because one match spans the whole range, redaction removes both ends at once.
 */
function buildSpecRegex(valueGuard, unitPattern, unitGuard, flags) {
  return new RegExp(
    String.raw`(?:${RANGE_LOW_GUARD}${signGroup("lowSign")}(?<low>${NUMBER_PATTERN})${RANGE_SEPARATOR}` +
      String.raw`|\b[Bb]etween\s+${signGroup("betweenSign")}(?<betweenLow>${NUMBER_PATTERN})\s+and\s+)?` +
      String.raw`${valueGuard}${signGroup("sign")}(?<value>${NUMBER_PATTERN})(?<gap>\s*)(?<unit>${unitPattern})${unitGuard}`,
    flags
  );
}

/**
 * number + unit, e.g. "37 Nm", "27 ft-lbf", "0.8 mm", "13.5 volts". The unit
 * may not run on into a letter, digit, or underscore. That is what a word
 * boundary did for units ending in a letter, but a boundary can never follow a
 * unit ending in "²", "." or "°", so those need this lookahead instead. The "Ω"
 * alternative keeps its old reach: only when a word character follows it, which
 * ELECTRICAL_SYMBOL_REGEX refuses, so the two never claim the same text.
 */
const SPEC_NUMBER_REGEX = buildSpecRegex(
  NOT_INSIDE_NUMBER,
  `(?:${UNIT_PATTERN})`,
  "(?![A-Za-z0-9_])",
  "gi"
);

// Electrical symbols, matched CASE-SENSITIVELY and apart from UNIT_PATTERN. That
// pattern's "i" flag suits spelled-out units, but it would read every lowercase
// "v" after a number as volts and make "MV" (megavolts) look like "mV"
// (millivolts). The trailing lookahead stands in for a word boundary, which can
// never follow "Ω" because Ω is not a word character -- the reason UNIT_PATTERN's
// own "Ω" alternative only ever matches when a letter, digit, or underscore
// follows -- exactly what this lookahead refuses -- so the two patterns never
// claim the same text. The lookahead also keeps "2 V-belts" and
// "2 VVT sensors" from reading as voltages. The leading lookbehind refuses a
// value preceded by a letter, digit, or underscore, so an identifier such as
// "M12V" or "P012V" is not read as "12 V"; it also refuses to restart just after
// a decimal separator, so "M1.5V" does not yield a partial "5V". A preceding
// hyphen is deliberately NOT refused: in "9-16V" or "-9 V" it separates a range
// or signs a value, and hiding that value would let a wrong claim pass with
// nothing to check (buildSpecRegex reads both). The cost is that "B-12V" still
// reads as "12 V" -- an extra rejection, never a false verification. The
// optional whitespace covers a normal space, a nonbreaking space, or none, and
// the ohm symbol arrives as either U+03A9 (Greek capital omega) or U+2126 (the
// ohm sign), which look identical on the page.
const OHM_SYMBOLS = String.fromCharCode(0x03a9, 0x2126);
const SYMBOL_VALUE_GUARD = String.raw`(?<![A-Za-z0-9_]|\d[.,])`;
const ELECTRICAL_SYMBOL_REGEX = buildSpecRegex(
  SYMBOL_VALUE_GUARD,
  String.raw`mV|kV|V|k\s*[${OHM_SYMBOLS}]|M\s*[${OHM_SYMBOLS}]|m\s*[${OHM_SYMBOLS}]|[${OHM_SYMBOLS}]`,
  "(?![A-Za-z0-9_-])",
  "g"
);

// Current symbols, "A" and "mA", with the same case-sensitive guards plus one
// more: a following slash is refused, because "1 A/C" and "bank 1 A/F" name
// parts in these manuals, never a current. Kept out of ELECTRICAL_SYMBOL_REGEX
// so that pattern, and the subject nouns ELECTRICAL_UNITS hands out, stay
// exactly as they were. A step number before a flowchart branch label ("GO TO
// STEP 10 A") still reads as a current: in a claim that is an extra rejection,
// and in a quote it can only ever meet a current claim (see printedSpecFor).
const CURRENT_SYMBOL_REGEX = buildSpecRegex(SYMBOL_VALUE_GUARD, "mA|A", "(?![A-Za-z0-9_/-])", "g");

// An engine designation names an engine, not a capacity: "L4 1.8L 2ZR-FE",
// "L4-1.8L (2ZR-FE)", "(2.4L: TOP OF ENGINE)". Every glued one-decimal litre
// figure in the corpus is one of the two engines (3,370 "1.8L" and 162 "2.4L",
// and no capacity written that way), and the model copies the vehicle
// descriptor into its claims. Read as litres, it rejected those claims and
// redacted the descriptor out of the model's gaps. Only the glued form standing
// next to an engine name is a designation: after a cylinder layout, before an
// engine code, or opening a bracketed variant label. "4.7 L of oil" and a bare
// "4.2L" are still volumes.
const GLUED_DISPLACEMENT = String.raw`\d\.\dL(?![A-Za-z0-9_])`;
const ENGINE_DESIGNATION_SOURCE =
  String.raw`(?:(?<=\b[LIV]\d[-\s])|(?<=\()|(?=${GLUED_DISPLACEMENT}\s*\(?\d[A-Z]{2,3}-[A-Z]{2,3}))` +
  GLUED_DISPLACEMENT;
const ENGINE_DESIGNATION_REGEX = new RegExp(ENGINE_DESIGNATION_SOURCE, "g");

// The litre symbol, "4.2 L", matched case-sensitively like the electrical
// symbols: a lowercase "l" after a number is too easily a typo for "1", and a
// following letter, hyphen, or slash is refused so "2 L-shaped brackets" and
// "LH" stay words. An engine designation is never read as a volume.
const VOLUME_SYMBOL_REGEX = buildSpecRegex(
  `${SYMBOL_VALUE_GUARD}(?!${ENGINE_DESIGNATION_SOURCE})`,
  "L",
  "(?![A-Za-z0-9_/-])",
  "g"
);

/** Every unit-bearing specification pattern; they never claim the same text. */
const SPEC_REGEXES = [
  SPEC_NUMBER_REGEX,
  ELECTRICAL_SYMBOL_REGEX,
  CURRENT_SYMBOL_REGEX,
  VOLUME_SYMBOL_REGEX,
];

// The electrical units known in both printed forms. `symbol` is compared
// case-sensitively for the reason above; `spelled` keeps exactly the
// case-insensitive spellings the subject guard already recognized.
const ELECTRICAL_UNITS = [
  { name: "millivolt", noun: "voltage", symbol: /^mV$/, spelled: /^millivolts?$/i },
  { name: "volt", noun: "voltage", symbol: /^V$/, spelled: /^volts?$/i },
  { name: "kilovolt", noun: "voltage", symbol: /^kV$/, spelled: /^kilovolts?$/i },
  {
    name: "kilohm",
    noun: "resistance",
    symbol: new RegExp(String.raw`^k\s*[${OHM_SYMBOLS}]$`),
    spelled: /^(kilohms?|k\s*ohms?)$/i,
  },
  {
    name: "megohm",
    noun: "resistance",
    symbol: new RegExp(String.raw`^M\s*[${OHM_SYMBOLS}]$`),
    spelled: /^meg(a)?ohms?$/i,
  },
  {
    name: "milliohm",
    noun: "resistance",
    symbol: new RegExp(String.raw`^m\s*[${OHM_SYMBOLS}]$`),
    spelled: /^milliohms?$/i,
  },
  {
    name: "ohm",
    noun: "resistance",
    symbol: new RegExp(`^[${OHM_SYMBOLS}]$`),
    spelled: /^ohms?$/i,
  },
];

/** The electrical unit a detected unit string names, spelled out or as a symbol. */
function findElectricalUnit(unit) {
  const cleaned = String(unit || "").trim();
  const found = ELECTRICAL_UNITS.find(
    ({ symbol, spelled }) => symbol.test(cleaned) || spelled.test(cleaned)
  );

  return found || null;
}

/** Viscosity grades: 5W-30, 0W20. A grade is a spec even without a unit. */
const VISCOSITY_REGEX = /\b\d+\s*w\s*[-–]?\s*\d+\b/gi;

/** A signed NUMBER_PATTERN token's value. */
function signedValue(sign, text) {
  const value = parseNumber(text);

  return sign ? -value : value;
}

/**
 * The specifications one buildSpecRegex match states: its value, and the low
 * end of its range when it has one, in the same unit.
 *
 * `raw` is the one value with its unit. For a range's low end that is put
 * together ("80 °C" out of "80 to 84 °C"), so it is not always text the page
 * prints; `printed` is: the whole match, verbatim, range and all.
 */
function specsFromMatch(match) {
  const { groups } = match;
  const unit = groups.unit.trim();
  const printed = match[0].trim();
  const specs = [];
  const lowText = groups.low ?? groups.betweenLow;

  if (lowText !== undefined) {
    const lowSign = groups.low !== undefined ? groups.lowSign : groups.betweenSign;

    specs.push({
      value: signedValue(lowSign, lowText),
      raw: `${lowSign || ""}${lowText}${groups.gap}${groups.unit}`.trim(),
      unit,
      printed,
      index: match.index,
    });
  }

  specs.push({
    value: signedValue(groups.sign, groups.value),
    raw: `${groups.sign || ""}${groups.value}${groups.gap}${groups.unit}`.trim(),
    unit,
    printed,
    index: match.index + (lowText === undefined ? 0 : 1),
  });

  return specs.filter((spec) => Number.isFinite(spec.value));
}

/** Every specification in the text, in order, each with its verbatim `printed` text. */
function readSpecs(text) {
  const source = String(text || "");
  const found = [];

  for (const regex of SPEC_REGEXES) {
    for (const match of source.matchAll(regex)) {
      found.push(...specsFromMatch(match));
    }
  }

  for (const match of source.matchAll(VISCOSITY_REGEX)) {
    const raw = match[0].trim();

    found.push({ value: NaN, raw, unit: "viscosity", printed: raw, index: match.index });
  }

  return found.sort((left, right) => left.index - right.index);
}

/**
 * Numeric specifications asserted by a piece of text, in the order they appear.
 *
 * @param {string} text
 * @returns {Array<{ value: number, raw: string, unit: string }>}
 */
export function extractSpecNumbers(text) {
  return readSpecs(text).map(({ value, raw, unit }) => ({ value, raw, unit }));
}

// The measurement units, grouped by family. Nothing converts between them
// (owner decision D1, 2026-10-19): a claimed number must be printed in its quote
// IN THE SAME UNIT. Toyota tables print a specification in every unit they
// support -- "37 N*m (377 kgf*cm, 27 ft.*lbf)" -- so the model never needs to
// convert, and a converted or rounded figure is not in the manual and must not
// be called verified. This table used to carry conversion factors, and every
// non-electrical comparison a max(0.51, 2%) tolerance sized for them. In
// millimetres and litres that slack accepted 0.5 mm of disc runout against a
// printed 0.05 mm and 4.7 L of engine oil against 4.2 L (1A-01).
//
// Each entry is ONE unit, and its pattern lists that unit's spellings, so "37 Nm"
// still supports "37 N·m". The family only decides which head nouns the subject
// guard reads (SPEC_SUBJECT_NOUNS).
const MEASUREMENT_UNITS = [
  { id: "N·m", family: "torque", match: /^(n\s*[·.*-]?\s*m|nm|newton\s*met(er|re)s?)$/i },
  {
    id: "ft·lbf",
    family: "torque",
    match: /^(ft\.?\s*[-·.*]?\s*lb[fs]?|lb[fs]?\s*[-·.*]?\s*ft|foot[-\s]*pounds?)$/i,
  },
  {
    id: "in·lbf",
    family: "torque",
    match: /^(in\.?\s*[-·.*]?\s*lb[fs]?|lb[fs]?\s*[-·.*]\s*in|inch[-\s]*pounds?)$/i,
  },
  { id: "kgf·cm", family: "torque", match: /^(kgf\s*[-·.*]?\s*cm|kg\s*[-·.*]?\s*cm)$/i },
  { id: "kgf·m", family: "torque", match: /^(kgf\s*[-·.*/]?\s*m)$/i },
  { id: "kPa", family: "pressure", match: /^kpa$/i },
  { id: "MPa", family: "pressure", match: /^mpa$/i },
  { id: "psi", family: "pressure", match: /^psi$/i },
  { id: "bar", family: "pressure", match: /^bar$/i },
  { id: "kgf/cm²", family: "pressure", match: /^(kgf?\s*[-·.*/]?\s*cm[2²]|kgf\s*\/\s*cm)$/i },
  // "L" is the symbol VOLUME_SYMBOL_REGEX detects, compared case-sensitively.
  // The lowercase "l" this pattern used to list was never detected (3B-13).
  { id: "L", family: "volume", match: /^lit(er|re)s?$/i, symbol: "L" },
  { id: "mL", family: "volume", match: /^(millilit(er|re)s?|ml)$/i },
  { id: "qt", family: "volume", match: /^(US\s*)?(qts?|quarts?)$/i },
  { id: "pt", family: "volume", match: /^(US\s*)?pints?$/i },
  { id: "gal", family: "volume", match: /^(US\s*)?(gal|gallons?)$/i },
  // "lmp." is the Imperial spelling UNIT_PATTERN explains, so it names the same unit.
  { id: "imp qt", family: "volume", match: /^(imp(\.|erial)?|lmp\.)\s*(qts?|quarts?)$/i },
  { id: "imp pt", family: "volume", match: /^(imp(\.|erial)?|lmp\.)\s*pints?$/i },
  { id: "imp gal", family: "volume", match: /^(imp(\.|erial)?|lmp\.)\s*(gal|gallons?)$/i },
  { id: "fl oz", family: "volume", match: /^fl\s*oz$/i },
  { id: "mm", family: "length", match: /^(millimet(er|re)s?|mm)$/i },
  { id: "cm", family: "length", match: /^(centimet(er|re)s?|cm)$/i },
  { id: "in", family: "length", match: /^(in\.?|inch(es)?)$/i },
  { id: "µm", family: "length", match: /^(microns?)$/i },
];

/**
 * The measurement unit (torque, pressure, volume, length) a detected unit string
 * names, or null for the units outside those families (volts, ohms, rpm,
 * temperature), which compare by sameLiteralUnit instead.
 */
function findMeasurementUnit(unit) {
  const cleaned = String(unit || "").trim();

  return (
    MEASUREMENT_UNITS.find(({ match, symbol }) => match.test(cleaned) || symbol === cleaned) ||
    null
  );
}

// Electrical readings were the first family held to the printed value (N4): the
// shared tolerance let 0.9 V pass against a printed 0.5 V and 12 Ω against a
// printed 12.4 Ω. Every unit is now held to that rule. The comparison is between
// PARSED numbers, never strings, so 12.40, 12.400, and 12.4 are the same value
// -- only a different number fails.
//
// Current lives here rather than in ELECTRICAL_UNITS because that table also
// gives the subject guard its head nouns, and current deliberately has none.
// Like ELECTRICAL_UNITS, it knows each unit in both printed forms: `symbol` is
// compared case-sensitively, `spelled` as UNIT_PATTERN detects it.
const CURRENT_UNITS = [
  { name: "milliamp", symbol: /^mA$/, spelled: /^milliamp(?:ere)?s?$/i },
  { name: "amp", symbol: /^A$/, spelled: /^amp(?:ere)?s?$/i },
];

/** The current unit a detected unit string names, spelled out or as a symbol. */
function findCurrentUnit(unit) {
  const cleaned = String(unit || "").trim();
  const found = CURRENT_UNITS.find(
    ({ symbol, spelled }) => symbol.test(cleaned) || spelled.test(cleaned)
  );

  return found || null;
}

/** Is this detected unit string the bare litre symbol "L"? */
function isVolumeSymbol(unit) {
  return String(unit || "").trim() === "L";
}

/** Is this detected unit string "A" or "mA"? */
function isCurrentSymbol(unit) {
  const cleaned = String(unit || "").trim();

  return CURRENT_UNITS.some(({ symbol }) => symbol.test(cleaned));
}

// Spellings of one unit outside the measurement and electrical tables, so "90
// degrees" matches "90°", "82 deg C" matches "82 °C", and "30,000 mile" matches
// "30,000 miles". A unit not listed compares by its normalized text, as before.
const UNIT_ALIASES = [
  { id: "°C", match: /^(°\s*c|deg(rees)?\s*c|(°\s*|deg(rees)?\s*)?celsius)$/i },
  { id: "°F", match: /^(°\s*f|deg(rees)?\s*f|(°\s*|deg(rees)?\s*)?fahrenheit)$/i },
  { id: "°", match: /^(°|deg(rees)?)$/i },
  { id: "%", match: /^(%|percent)$/i },
  { id: "mi", match: /^miles?$/i },
  { id: "km", match: /^(km|kilomet(er|re)s?)$/i },
  { id: "km/h", match: /^(km\s*\/\s*h|kph)$/i },
  { id: "kHz", match: /^(khz|kilohertz)$/i },
];

/** The id of a unit outside the measurement and electrical tables. */
function unitAlias(unit) {
  const cleaned = String(unit || "").trim();
  const found = UNIT_ALIASES.find(({ match }) => match.test(cleaned));

  return found ? found.id : normalizeForMatch(cleaned);
}

/**
 * Do two units outside the measurement families name the same unit?
 *
 * An electrical or current unit is compared by the unit it names, so a quote
 * printing "12.6 V" supports a claim saying "12.6 volts" and "5 ohms" supports
 * "5 ohm". Nothing here converts: mV and V stay different units, as do kΩ and Ω,
 * and mA and A. Everything else compares by its UNIT_ALIASES id.
 */
function sameLiteralUnit(left, right) {
  if (findCurrentUnit(left) || findCurrentUnit(right)) {
    const leftUnit = findCurrentUnit(left);
    const rightUnit = findCurrentUnit(right);

    return Boolean(leftUnit && rightUnit && leftUnit.name === rightUnit.name);
  }

  if (findElectricalUnit(left) || findElectricalUnit(right)) {
    const leftUnit = findElectricalUnit(left);
    const rightUnit = findElectricalUnit(right);

    return Boolean(leftUnit && rightUnit && leftUnit.name === rightUnit.name);
  }

  return unitAlias(left) === unitAlias(right);
}

/** Do two detected unit strings name the same unit, however each is spelled? */
function sameUnit(left, right) {
  const leftMeasurement = findMeasurementUnit(left);
  const rightMeasurement = findMeasurementUnit(right);

  if (leftMeasurement || rightMeasurement) {
    return Boolean(
      leftMeasurement && rightMeasurement && leftMeasurement.id === rightMeasurement.id
    );
  }

  return sameLiteralUnit(left, right);
}

/**
 * Where the evidence prints the claimed spec -- the same number, in the same
 * unit -- as the evidence's own verbatim text, or null when it does not.
 *
 * Returning the text rather than a yes/no is what lets the answer show the
 * manual's figure beside the claim (owner decision D1) from the very comparison
 * that verified it, so the figure shown can never be one this check did not use.
 */
function printedSpecFor(spec, evidenceNumbers, evidenceSpecs, headerUnits) {
  const [first] = evidenceMatchesFor(spec, evidenceNumbers, evidenceSpecs, headerUnits);

  return first ? first.printed : null;
}

/**
 * Every place the evidence prints the claimed spec, in order, as its verbatim
 * text and position. printedSpecFor shows the first; the row check needs them
 * all, because a figure printed in two rows of a table may be the right figure
 * in either one (see checkClaimRow).
 *
 * @returns {Array<{ printed: string, index: number }>}
 */
function evidenceMatchesFor(spec, evidenceNumbers, evidenceSpecs, headerUnits) {
  if (!Number.isFinite(spec.value)) {
    return [];
  }

  // A current symbol in the evidence counts only for a current claim. Most
  // wiring diagrams print a fuse rating ("10A") and no other unit, and letting
  // it count as the quote's specification would switch off the bare-number
  // fallback below for every torque, pressure, or voltage claim citing one --
  // measured on the real corpus, 667 chunks. It could never support such a
  // claim anyway. Only the symbols are set aside: a spelled-out "amps" in the
  // evidence counted before "A" was detected and still does, so no claim that
  // is not a current is compared any differently.
  //
  // A bare litre symbol in the evidence counts only for a volume claim, for the
  // same reason. These manuals write capacities as "liters"; a bare "L" after a
  // number is a gear position ("2 L"), Toyota's wire-colour code for blue, or a
  // connector pin label far more often than a volume, and it must not switch
  // off the fallback for a torque or voltage claim citing such a page.
  const isVolumeClaim = findMeasurementUnit(spec.unit)?.family === "volume";
  const comparableSpecs = evidenceSpecs.filter(
    (evidenceSpec) =>
      (!isCurrentSymbol(evidenceSpec.unit) || Boolean(findCurrentUnit(spec.unit))) &&
      (!isVolumeSymbol(evidenceSpec.unit) || isVolumeClaim)
  );

  // Prefer unit-aware comparison whenever the evidence names any technical
  // units. A matching numeral alone is not enough: "37 psi" must never be
  // grounded by an unrelated "37 N·m" torque passage, nor "27 ft-lbf" by the
  // "37 N·m" it might have been converted from.
  const matches = comparableSpecs.filter(
    (evidenceSpec) => evidenceSpec.value === spec.value && sameUnit(evidenceSpec.unit, spec.unit)
  );

  if (matches.length) {
    return matches.map(({ printed, index }) => ({ printed, index }));
  }

  if (comparableSpecs.length) {
    return [];
  }

  // Some extracted manual tables put units in a header and only numbers in the
  // row: "Torque (N*m): mounting bolt 37". Preserve that fallback only when the
  // quote contains no other explicit unit-bearing specification to contradict
  // the claim's unit, only when it really carries such a header IN THE CLAIM'S
  // UNIT, and, like every other comparison, only for the printed number itself.
  // Without the header requirement any number at all would do: "from 1 to 10",
  // a step sequence, verified "tighten the bolts to 10 N*m" (1A-03).
  // The printed figure is then the bare number: the page prints its unit only
  // in the header.
  if (!headerUnits.some((unit) => sameUnit(unit, spec.unit))) {
    return [];
  }

  return evidenceNumbers
    .filter((candidate) => candidate.value === spec.value)
    .map(({ raw, index }) => ({ printed: raw, index }));
}

// A unit standing alone in a quote, attached to no number: the column header of
// a flattened table. Spelled units may stand bare ("N*m kgf*cm ft.*lbf"); a
// one-letter symbol ("V", "A", "L") is a header only in brackets, "(V)", because
// bare it is too often a word or a part's letter.
const SPELLED_HEADER_UNIT_REGEX = new RegExp(
  `(?<![\\d.,]\\s*)(?<![A-Za-z0-9_])(?:${UNIT_PATTERN})(?![A-Za-z0-9_])`,
  "gi"
);
const SYMBOL_HEADER_UNIT_REGEX = new RegExp(
  String.raw`[(\[]\s*(mV|kV|V|mA|A|L|[kMm]?\s*[${OHM_SYMBOLS}])\s*[)\]]`,
  "g"
);

/** The header units a quote carries. */
function headerUnitsIn(text) {
  const source = String(text || "");

  return [
    ...[...source.matchAll(SPELLED_HEADER_UNIT_REGEX)].map((match) => match[0]),
    ...[...source.matchAll(SYMBOL_HEADER_UNIT_REGEX)].map((match) => match[1]),
  ];
}

/** All numbers appearing anywhere in the evidence text, unit or not, signed. */
function allNumbersIn(text) {
  return signedNumbers(text).filter((number) => Number.isFinite(number.value));
}

/**
 * A viscosity grade as it is compared: no case, no spaces, and no separator,
 * hyphen or en dash alike, so "5W-30", "5W–30", "5W30", and "5 W-30" are one
 * grade. VISCOSITY_REGEX reads only digits, a W, and digits, so what is left
 * ("5w30") still names exactly one grade.
 */
function collapseGrade(text) {
  return normalizeForMatch(text).replace(/[\s\-–]/g, "");
}

/**
 * Match one claim's numeric specifications against its evidence: the claimed
 * figures the evidence does not print, and, for those it does, the evidence's
 * own text for each (deduplicated, in claim order -- both ends of a claimed
 * range usually match one printed range).
 *
 * @returns {{ unsupported: string[], printedFigures: string[] }}
 */
function matchClaimNumbers(claimText, evidenceText) {
  const specs = extractSpecNumbers(claimText);

  if (!specs.length) {
    return { unsupported: [], printedFigures: [] };
  }

  const evidenceNumbers = allNumbersIn(evidenceText);
  const evidenceSpecs = readSpecs(evidenceText);
  const headerUnits = headerUnitsIn(evidenceText);
  const unsupported = [];
  const printedFigures = [];

  for (const spec of specs) {
    let printed;

    if (spec.unit === "viscosity") {
      // The claimed grade must equal one grade the quote prints, whole. Never
      // a substring: "0W-30" sits inside "10W-30", a different oil.
      const grade = collapseGrade(spec.raw);
      const evidenceGrade = evidenceSpecs.find(
        (evidenceSpec) =>
          evidenceSpec.unit === "viscosity" && collapseGrade(evidenceSpec.raw) === grade
      );

      if (!evidenceGrade) {
        unsupported.push(spec.raw);
        continue;
      }

      printed = evidenceGrade.printed;
    } else {
      printed = printedSpecFor(spec, evidenceNumbers, evidenceSpecs, headerUnits);

      if (printed === null) {
        unsupported.push(spec.raw);
        continue;
      }
    }

    if (printed && !printedFigures.includes(printed)) {
      printedFigures.push(printed);
    }
  }

  return { unsupported, printedFigures };
}

/**
 * Check one claim's numeric specifications against its evidence.
 *
 * @returns {{ grounded: boolean, unsupported: string[] }}
 */
export function checkClaimNumbers(claimText, evidenceText) {
  const { unsupported } = matchClaimNumbers(claimText, evidenceText);

  return { grounded: unsupported.length === 0, unsupported };
}

// ---------------------------------------------------------------------------
// The vocabulary boundary
// ---------------------------------------------------------------------------
//
// The specification detector can only check the units it knows. Every unit it
// did not know used to mean "no specification here", so the claim passed with
// its number unexamined -- the mechanism behind "50 ft-lbs" and "5.5 qts"
// (3B-01). Adding spellings closes known holes but can never close the next
// one, so the boundary itself fails closed (owner decision D1): a number in a
// claim that no specification pattern read must be printed in the quote, or the
// claim is unverified.
//
// Counts and step numbers fall under this rule too ("remove the 4 bolts" needs
// a 4 in its quote), which is deliberate: the code cannot tell a count from a
// figure in a unit it does not know. Only shapes that are names, never
// quantities, are exempt.

// A minus sign, as signGroup reads it, then one number.
const SIGNED_NUMBER_REGEX = new RegExp(
  `${NOT_INSIDE_NUMBER}${signGroup("sign")}(?<value>${NUMBER_PATTERN})`,
  "g"
);

// Whitespace-delimited tokens that name something rather than measure it. A
// letter before the first digit: codes, connectors, and pins (P0420, B9-1,
// M12V, A51, No.1, HFC-134a). Digits then capitals: engine and drive codes
// (2ZR-FE, 1ZZ-FE, 4WD). Ordinals. Toyota part and service-tool numbers
// (90919-01253, 09843-18040). Model years, alone or as a span (2009-2013).
const IDENTIFIER_TOKEN_PATTERNS = [
  /^[A-Za-z][^\s]*\d/,
  /^\d+[A-Z]+(?:[-/][A-Z0-9]+)*$/,
  /^\d+(?:st|nd|rd|th)$/i,
  /^\d{5}-[0-9A-Z]{5}(?:-[0-9A-Z]{2})?$/,
  /^(?:19[89]\d|20[0-3]\d)(?:[-–](?:19[89]\d|20[0-3]\d))?$/,
];

/** Every signed number in the text, with where it sits. */
function signedNumbers(text) {
  return [...String(text || "").matchAll(SIGNED_NUMBER_REGEX)].map((match) => ({
    value: signedValue(match.groups.sign, match.groups.value),
    raw: match[0],
    index: match.index,
  }));
}

/**
 * [start, end) spans of every unit-bearing specification and viscosity grade,
 * and of every engine designation, which is a name like an engine code.
 */
function specificationSpans(text) {
  const source = String(text || "");

  return [...SPEC_REGEXES, VISCOSITY_REGEX, ENGINE_DESIGNATION_REGEX].flatMap((regex) =>
    [...source.matchAll(regex)].map((match) => [match.index, match.index + match[0].length])
  );
}

/** The whitespace-delimited token around a position, without wrapping punctuation. */
function tokenAt(text, index) {
  let start = index;
  let end = index;

  while (start > 0 && !/\s/.test(text[start - 1])) start -= 1;
  while (end < text.length && !/\s/.test(text[end])) end += 1;

  return text.slice(start, end).replace(/^[("'[{]+|[)"'\]},.;:!?]+$/g, "");
}

/**
 * Numbers in a claim that no specification pattern read and no identifier
 * shape explains, and that its evidence does not print.
 *
 * @returns {{ grounded: boolean, unsupported: Array<{ raw: string, index: number }> }}
 */
export function checkUnrecognizedFigures(claimText, evidenceText) {
  const claim = String(claimText || "");
  const spans = specificationSpans(claim);
  const printed = signedNumbers(evidenceText).map((number) => number.value);
  const unsupported = signedNumbers(claim)
    .filter(({ index }) => !spans.some(([start, end]) => index >= start && index < end))
    .filter(({ index }) => !IDENTIFIER_TOKEN_PATTERNS.some((pattern) => pattern.test(tokenAt(claim, index))))
    .filter(({ value }) => !printed.includes(value))
    .map(({ raw, index }) => ({ raw, index }));

  return { grounded: unsupported.length === 0, unsupported };
}

/**
 * A rejected claim as its gap may show it. A gap explains what could NOT be
 * verified, so it must not reprint a figure that failed: every specification is
 * redacted, and so is every unreadable figure its quote does not print.
 * `trustedQuote` is "" when the quote itself failed (an unknown source, or a
 * quote not in the source), so no figure is spared by it. Without this, a claim
 * rejected for its quote reprinted "999999 drain cycles" in full.
 */
function gapClaimText(claim, trustedQuote) {
  return redactFigures(claim, checkUnrecognizedFigures(claim, trustedQuote).unsupported);
}

/** The claim as a gap may show it: no specification, and none of these figures. */
function redactFigures(text, figures) {
  const source = String(text || "");
  const withoutFigures = [...figures]
    .sort((left, right) => right.index - left.index)
    .reduce(
      (redacted, { raw, index }) =>
        redacted.slice(0, index) + "[unverified value]" + redacted.slice(index + raw.length),
      source
    );

  return redactSpecNumbers(withoutFigures);
}

function normalizeSubjectToken(token) {
  const normalized = String(token || "").toLowerCase().replace(/[^a-z0-9-]/g, "");

  if (normalized.length > 3 && normalized.endsWith("s") && !normalized.endsWith("ss")) {
    return normalized.slice(0, -1);
  }

  return normalized;
}

// Normalized like the tokens they are compared with: "this" is "thi" by then,
// which is how it used to slip past a list written as plain words.
const SUBJECT_IGNORED_WORDS = new Set(
  ["a", "an", "the", "this", "that"].map((word) => normalizeSubjectToken(word))
);

/**
 * Normalized subject words, with the determiners dropped -- but not the letter A.
 *
 * Manuals name parts by letter ("Bolt A", Speed Sensor "A", "(A)"). B through H
 * always survived as tokens, while A was dropped as the article, so a claim
 * about Bolt A was checked as a claim about "bolt" and the quote for Bolt B
 * certified it. The two are told apart by how the corpus writes them (measured
 * 2026-09-28): a capital A standing alone as a word right after another word
 * is a designator or a flowchart branch label almost every time, while the
 * article is lowercase unless it starts a sentence. So a piece is kept as the
 * letter only when it is a capital A, is a word of its own (the A of "A/F" and
 * "A/C" is not a letter), and directly follows a word the subject keeps, with
 * no clause punctuation between them. "The" does not count: the parser cuts a
 * claim's subject right after "the", so counting it would read the same "the A"
 * differently depending on where the cut fell. A designator written in
 * lowercase is still read as the article -- a deliberate limit: reading every
 * "a" after a word as a letter would make ordinary articles required subject
 * words.
 */
function subjectTokens(text) {
  return subjectPieces(text)
    .filter((piece) => piece.kept)
    .map((piece) => piece.token);
}

/**
 * Every normalized piece of the text, whether the subject keeps it, and the
 * index of the whitespace-separated word it came from -- so the phrase readings
 * can ask which "a" is the letter using the same decision subjectTokens makes.
 */
function subjectPieces(text) {
  const pieces = [];
  // The piece before this one, if the subject kept it. A letter needs a kept
  // word in front of it: after "the", an A is read as the article, as it is at
  // the start of the text.
  let previousKept = "";

  String(text || "")
    .split(/\s+/)
    .forEach((word, wordIndex) => {
      const parts = word.split(/[-_/]+/).filter((part) => normalizeSubjectToken(part));

      for (const part of parts) {
        const token = normalizeSubjectToken(part);
        const isLetterA =
          token === "a" &&
          part.includes("A") &&
          parts.length === 1 &&
          previousKept !== "" &&
          !/[.!?;:,]["')\]]*$/.test(previousKept);
        const kept = isLetterA || !SUBJECT_IGNORED_WORDS.has(token);

        pieces.push({ token, kept, word: wordIndex });
        previousKept = kept ? part : "";
      }
    });

  return pieces;
}

// Head nouns that make a specification component-scoped: in "<part> <noun> is
// <value>" the words before the noun name the part. Torque was the first, but a
// capacity, a pressure, and a clearance are just as component-specific -- "4.2
// liters" is the right number for the wrong system if the quote says coolant and
// the claim says engine oil.
const SPEC_SUBJECT_NOUNS = [
  "torque",
  "capacity",
  "pressure",
  "clearance",
  "thickness",
  "diameter",
  "depth",
];

// Units outside the measurement families that are still component-scoped, added
// in N4. Voltage, resistance, engine-speed, and temperature values were passing
// on a numeric match alone: 13.5 V at the charging system is not 13.5 V at the
// battery, and 700 rpm of cooling fan is not 700 rpm of idle.
//
// Each family carries its OWN head noun rather than sharing one pooled list.
// extractSpecSubject takes the last matching noun in the clause, so a pooled
// list let an unrelated qualifier steal the subject: "the battery voltage at
// operating temperature is 12.6 volts" parsed off "temperature" and produced
// the subject "battery voltage at operating", which its own quote could not
// match. Pairing each unit with its noun keeps the parse anchored on the
// specification actually being checked.
//
// Current (amps) is absent on purpose. The numeric detector still checks it,
// but ordinary current wording ("draws 150 amps", "current draw") gives the
// head-noun parser no subject to read, so listing it here would claim a guard
// that almost never runs.
//
// Voltage and resistance take their noun from ELECTRICAL_UNITS, which knows each
// unit both spelled out and as a symbol, so "12.6 V" gates the subject exactly
// as "12.6 volts" does, and "2.4 kΩ" exactly as "2.4 kilohms".
const OTHER_GUARDED_FAMILIES = [
  { ids: ["rpm"], noun: "speed" },
  { ids: ["°C", "°F"], noun: "temperature" },
];

function otherFamilySubjectNoun(unit) {
  const electrical = findElectricalUnit(unit);

  if (electrical) {
    return electrical.noun;
  }

  const id = unitAlias(unit);
  const family = OTHER_GUARDED_FAMILIES.find(({ ids }) => ids.includes(id));

  return family ? family.noun : "";
}

/**
 * Extract the named part from common specification-claim shapes.
 *
 * This is intentionally conservative. If the claim uses a shape the server
 * cannot parse, this check does not pretend to understand it; the quote and
 * numeric checks still run. When a subject is parsed, however, every word of it
 * must be found in the evidence quote -- see checkClaimSubject for exactly how.
 */
function extractSpecSubject(text, nouns) {
  const normalized = normalizeForMatch(text);
  // The shapes are matched on the lowercased text, but the subject is cut from
  // the text as written, at the same offsets, so subjectTokens can see whether
  // an A is capitalized. Lowercasing a character can lengthen it (a dotted
  // capital I becomes two), and then the offsets would not line up, so such a
  // claim is read lowercased -- the article-only reading used before letters
  // were recognized.
  const collapsed = collapseForMatch(text);
  const written = collapsed.length === normalized.length ? collapsed : normalized;
  const imperative = normalized.match(
    /\b((?:torque|tighten|inflate|fill)\s+(?:the\s+)?)([^.!?;,:]{1,100}?)\s+(?:to|at)\s+\d/
  );

  if (imperative) {
    const start = imperative.index + imperative[1].length;
    return subjectTokens(written.slice(start, start + imperative[2].length));
  }

  const writtenClauses = written.split(/[.!?;,:]/);

  for (const [clauseIndex, clause] of normalized.split(/[.!?;,:]/).entries()) {
    // The LAST head noun in the clause wins, matching the torque-only behavior
    // this generalizes: the nearest noun is the one the part name qualifies.
    const nounIndex = nouns.reduce(
      (found, noun) => Math.max(found, clause.lastIndexOf(` ${noun}`)),
      -1
    );

    if (nounIndex < 0) {
      continue;
    }

    const prefix = clause.slice(0, nounIndex).trim();
    let writtenPrefix = writtenClauses[clauseIndex].slice(0, nounIndex).trim();
    const lastDeterminer = prefix.lastIndexOf(" the ");

    if (lastDeterminer >= 0) {
      writtenPrefix = writtenPrefix.slice(lastDeterminer + 5);
    }

    const tokens = subjectTokens(writtenPrefix);
    return tokens.slice(-6);
  }

  return [];
}

function containsTokenSequence(haystack, needle) {
  if (!needle.length || needle.length > haystack.length) {
    return false;
  }

  for (let start = 0; start <= haystack.length - needle.length; start += 1) {
    if (needle.every((token, offset) => token === haystack[start + offset])) {
      return true;
    }
  }

  return false;
}

// "standard" is these manuals' own table label ("Fuel injector assembly Standard
// resistance"): it sits between the part and the specification noun in 285
// chunks, while a claim naturally leads with it ("the standard fuel injector
// resistance"). WHERE it sits says nothing about which part; WHETHER it is there
// still says which specification, so it may move within the quote's phrase but
// may never be missing -- a "standard" claim still fails against a "minimum".
const FLOATING_SUBJECT_WORDS = new Set(["standard"]);

// Words naming the enclosing system or the procedure step, never a part: the
// "fuel system pressure" is the fuel pressure, and the "water drain cock
// installation torque" is the water drain cock's torque. Both were rejected
// live (Experiment D, 2026-09-27), and either side may omit them. A subject made
// of nothing else is still compared in full by the contiguous check.
const TRANSPARENT_SUBJECT_WORDS = new Set(["system", "installation"]);

const PHRASE_DETERMINERS = new Set(["the", "a", "an"]);

/**
 * Split a quote into the phrases one part name can come from: its clauses, and
 * within a clause the runs of words between bare numbers. Flattened spec tables
 * carry no punctuation between rows -- the values are the only thing separating
 * one row's label from the next -- so without the number boundaries "Front brake
 * disc thickness 25.0 mm Rear brake pad thickness 1.0 mm" would yield a "front
 * brake pad". A number right after "No." is a part designation, not a value.
 */
function quotePhrases(text) {
  const phrases = [];

  // Words keep their case (see subjectTokens: a capital A may be a letter), so
  // every comparison against a word here is case-insensitive.
  for (const clause of collapseForMatch(text).split(/(?<!\bno)[.!?;,:](?=\s|$)/i)) {
    const words = clause.split(" ").filter(Boolean);
    let phrase = [];

    words.forEach((word, index) => {
      const isValue =
        /^[([]*\d+(?:[.,]\d+)*[)\],]*$/.test(word) && !/^no\.?$/i.test(words[index - 1] || "");

      if (!isValue) {
        phrase.push(word);
        return;
      }

      if (phrase.length) {
        phrases.push(phrase);
      }

      phrase = [];
    });

    if (phrase.length) {
      phrases.push(phrase);
    }
  }

  return phrases;
}

/**
 * One phrase as written, plus each "A of the B" read as "B A": "the valve opening
 * temperature of the thermostat" also reads "the thermostat valve opening
 * temperature". B is EVERYTHING after "of" to the end of the phrase, never a
 * prefix of it, so "of the EGR cooler bypass" cannot be cut down to "EGR" and
 * certify an "EGR valve".
 */
function phraseReadings(words) {
  const readings = [words];
  // "the bolt A of the water pump": that A is the bolt's letter, not a
  // determiner starting a new phrase. The same decision subjectTokens makes.
  const letters = new Set(
    subjectPieces(words.join(" "))
      .filter((piece) => piece.kept && piece.token === "a")
      .map((piece) => piece.word)
  );
  const isDeterminer = (index) =>
    PHRASE_DETERMINERS.has(String(words[index]).toLowerCase()) && !letters.has(index);

  words.forEach((word, ofIndex) => {
    if (word.toLowerCase() !== "of") {
      return;
    }

    let determiner = ofIndex - 1;

    while (determiner >= 0 && !isDeterminer(determiner)) {
      determiner -= 1;
    }

    const owned = words.slice(determiner + 1, ofIndex);
    const owner = words.slice(ofIndex + 1);

    if (isDeterminer(ofIndex + 1)) {
      owner.shift();
    }

    if (owned.length && owner.length) {
      readings.push([...words.slice(0, determiner + 1), ...owner, ...owned]);
    }
  });

  return readings;
}

/**
 * Does ONE phrase of the quote name the claim's part, once word order is
 * allowed the three variations real manuals and claims actually differ by?
 *
 * The part words keep their order and must stay unbroken -- that is what
 * rejects a "drive shaft nut" against "drive shaft bearing lock nut", or a
 * "front brake pad" against "rear brake pad and front disc". Only three things
 * are relaxed: "standard" may sit anywhere in the phrase (but must be there),
 * "system" and "installation" may be absent on either side, and "A of the B"
 * may be read as "B A". Measured before it was chosen (2026-09-27): set
 * membership over the quote or a clause, and an ordered subsequence, each
 * accepted wrong parts that this rejects.
 */
function phraseNamesSubject(subject, evidenceText) {
  const isPartWord = (token) =>
    !FLOATING_SUBJECT_WORDS.has(token) && !TRANSPARENT_SUBJECT_WORDS.has(token);
  const partWords = subject.filter(isPartWord);
  const floatingWords = subject.filter((token) => FLOATING_SUBJECT_WORDS.has(token));

  if (!partWords.length) {
    return false;
  }

  return quotePhrases(evidenceText).some((words) => {
    const phraseTokens = subjectTokens(words.join(" "));

    if (!floatingWords.every((token) => phraseTokens.includes(token))) {
      return false;
    }

    return phraseReadings(words).some((reading) =>
      containsTokenSequence(subjectTokens(reading.join(" ")).filter(isPartWord), partWords)
    );
  });
}

/**
 * Deterministic subject guard for component-scoped specifications.
 *
 * A matching number is not enough: "oil filter cap, 37 Nm" must not be
 * certified by a quote about an "oil drain plug, 37 Nm", and "engine oil
 * capacity, 4.2 liters" must not be certified by a coolant capacity that
 * happens to print the same figure. Two sets of units are gated: the four
 * measurement families (torque, pressure, volume, length), and the families
 * added in N4 (volts, ohms, rpm, temperature), which were reaching the owner on
 * a numeric match alone. The measurement families share one pooled noun list;
 * each N4 family contributes only its own noun, so a qualifier naming another
 * family cannot steal the subject from the specification being checked.
 *
 * The parsed subject passes when its words occur in the quote as one unbroken,
 * in-order run -- or, failing that, when ONE phrase of the quote names the same
 * part allowing only the variations real claims and manuals differ by (word
 * order around "of", the table label "standard", the words "system" and
 * "installation"; see phraseNamesSubject). Before the second test existed, the
 * first live answer eval after N4 found correct claims rejected purely on word
 * order: "the thermostat valve opening temperature" against "the valve opening
 * temperature of the thermostat".
 *
 * This lexical check is deliberately fail-closed for recognized claim shapes.
 * It is not a general semantic-entailment engine, which is documented as a
 * remaining limit.
 */
export function checkClaimSubject(claimText, evidenceText) {
  const subject = parseClaimSubject(claimText);

  if (!subject.length) {
    return { grounded: true, checked: false, subject: "" };
  }

  return {
    grounded: textNamesSubject(evidenceText, subject),
    checked: true,
    subject: subject.join(" "),
  };
}

/**
 * The part a claim's specification is about, as subject tokens, or [] when the
 * claim states no guarded specification or has a shape the parser cannot read.
 * Shared by the subject check and the row check, so both read one subject.
 */
function parseClaimSubject(claimText) {
  const specs = extractSpecNumbers(claimText);
  const hasMeasurementSpec = specs.some(
    (spec) => spec.unit !== "viscosity" && Boolean(findMeasurementUnit(spec.unit))
  );
  // Only the nouns of the families actually detected are offered to the parser.
  // Passing all four would let "at operating temperature" outrank the voltage
  // this claim is really about, because the last noun in the clause wins.
  const otherFamilyNouns = [
    ...new Set(specs.map((spec) => otherFamilySubjectNoun(spec.unit)).filter(Boolean)),
  ];

  if (!hasMeasurementSpec && !otherFamilyNouns.length) {
    return [];
  }

  // A claim carrying a measurement spec keeps the original noun list, so its
  // parse is byte-identical to the behavior shipped in PR #122.
  return extractSpecSubject(claimText, hasMeasurementSpec ? SPEC_SUBJECT_NOUNS : otherFamilyNouns);
}

/** Does this text name the parsed subject (see checkClaimSubject for how)? */
function textNamesSubject(text, subject) {
  // The unbroken run is still the first test, unchanged. The phrase test only
  // ever ADDS acceptances, so no claim verified before this can be rejected now.
  return containsTokenSequence(subjectTokens(text), subject) || phraseNamesSubject(subject, text);
}

// ---------------------------------------------------------------------------
// Row-aware verification (S1)
// ---------------------------------------------------------------------------
//
// A flattened table puts several rows in one quote: "Oil change with filter
// 4.5 liters ... Oil change without filter 4.1 liters". The subject check asks
// whether the quote names the claim's part, and the numeric check whether it
// prints the claim's figure -- each ANYWHERE in the quote. Together they
// verified the part of one row with the figure of another: diagnosed
// 2026-10-28, a quote spanning both capacity rows "confirmed" the without-
// filter figure as the with-filter capacity. The row check asks what neither
// can: is there ONE row that prints every figure of the claim, names its part,
// and carries no condition the claim contradicts?
//
// A row is a run of printed values -- a figure, the same figure in its other
// units, both ends of a range -- and the label text before it, back to the
// previous row's values. A quote with one row is judged exactly as before.

// Words that may stand between two values of ONE row, besides units and
// punctuation: "13.2 to 14.8 V", "25 and 30 N*m", and "at" introducing the
// value's own measurement condition, "11.6 to 12.4 Ω at 20°C (68°F)".
const ROW_GLUE_WORDS = new Set(["to", "and", "or", "at"]);

// A step number opening a sentence ("1. Remove", "(2)") is not a value.
const STEP_MARKER = /^\(?\d{1,2}[.)]$/;

// Label words that never name a part: links between words, the specification
// nouns, table vocabulary, and the action a capacity row names ("Drain and
// refill with oil filter change"). Only a part word in a later row's label
// keeps a shared header from carrying over to it.
const ROW_NON_PART_WORDS = new Set(
  [
    ...["and", "or", "to", "of", "for", "at", "in", "on", "by", "x", "is", "are"],
    ...SPEC_SUBJECT_NOUNS,
    ...["voltage", "resistance", "speed", "temperature", "current"],
    ...["item", "condition", "specified", "specification", "standard", "value", "part"],
    ...["tightened", "tightening", "system", "installation"],
    ...["drain", "refill", "fill", "replace", "replacement", "change", "install", "remove"],
    ...["check", "inspect", "tighten"],
  ].map((word) => normalizeSubjectToken(word))
);

// Links that may follow a shared header's part name inside the first row's
// label without being that row's own label.
const HEADER_GLUE_WORDS = new Set(
  ["and", "or", "to", "of", "for", "at", "in", "on", "by", "x", "is", "are"].map((word) =>
    normalizeSubjectToken(word)
  )
);

// A threshold printed AFTER its value -- "0.2 V or less" -- qualifies that
// value, not the next row's. It is read into the value's row, as one word
// ("orless"), so it can tell two threshold rows of one signal apart.
const THRESHOLD_TAIL = /^\s*\)?\s*or\s+(?:less|lower|below|more|higher|greater|above)\b/i;
const THRESHOLD_REGEX = /\bor\s+(less|lower|below|more|higher|greater|above)\b/gi;

// Conditions that tell table rows apart. Each group lists the alternatives,
// and each alternative its spellings. A row's condition must not be
// contradicted by the claim, and where another row about the SAME part carries
// a different alternative, the claim must state the row's own -- that is what
// keeps "with filter" from claiming the "without filter" row's figure, and a
// table's minimum from passing as its standard value.
const ROW_CONDITION_GROUPS = [
  [["with"], ["without"]],
  [["front"], ["rear"]],
  [["left", "lh"], ["right", "rh"]],
  [["upper"], ["lower"]],
  [["inner"], ["outer"]],
  [["intake"], ["exhaust"]],
  [["hot"], ["cold"]],
  [["new"], ["used", "reused"]],
  [["released"], ["depressed", "pressed", "pushed"]],
  [["standard"], ["minimum", "min"], ["maximum", "max"], ["limit"]],
  [
    ["orless", "orlower", "orbelow"],
    ["ormore", "orhigher", "orgreater", "orabove"],
  ],
];

const ROW_CONDITION_WORDS = new Set(ROW_CONDITION_GROUPS.flat(2));

// The alternative a claim means by saying none: "the disc thickness is 25.0 mm"
// is the standard thickness, never the minimum.
const UNMARKED_CONDITION_WORDS = new Set(["standard"]);

// A part designation, "No. 1" or "No.2", read as one word ("no1"): rows for
// No. 1 and No. 2 of the same part differ by nothing else.
const DESIGNATION_REGEX = /\bno\.?\s*(\d+)\b/gi;

/** [start, end) spans of every match of these global regexes. */
function spansOf(text, regexes) {
  return regexes.flatMap((regex) =>
    [...text.matchAll(regex)].map((match) => [match.index, match.index + match[0].length])
  );
}

const insideSpans = (spans, index) => spans.some(([start, end]) => index >= start && index < end);

/** Is this bare number a name, a step number, or a designation rather than a value? */
function isNonValueNumber(text, number) {
  if (IDENTIFIER_TOKEN_PATTERNS.some((pattern) => pattern.test(tokenAt(text, number.index)))) {
    return true;
  }

  const before = text.slice(0, number.index);

  if (/\bno\.?\s*$/i.test(before)) {
    return true;
  }

  let start = number.index;
  let end = number.index;

  while (start > 0 && !/\s/.test(text[start - 1])) start -= 1;
  while (end < text.length && !/\s/.test(text[end])) end += 1;

  const preceding = text.slice(0, start).trimEnd();

  return STEP_MARKER.test(text.slice(start, end)) && (!preceding || /[.!?:;]$/.test(preceding));
}

/**
 * Where the quote prints values: every unit-bearing specification and
 * viscosity grade, and -- only when the quote carries a unit header -- every
 * bare number that is not a name. Without a header a bare number is a count
 * or a step ("remove the 4 bolts"), never a table cell.
 */
function rowValueSpans(text) {
  const spans = spansOf(text, [...SPEC_REGEXES, VISCOSITY_REGEX]);

  if (headerUnitsIn(text).length) {
    const names = spansOf(text, [
      ENGINE_DESIGNATION_REGEX,
      SPELLED_HEADER_UNIT_REGEX,
      SYMBOL_HEADER_UNIT_REGEX,
    ]);
    const valueSpans = [...spans];

    for (const number of signedNumbers(text)) {
      if (
        !insideSpans(valueSpans, number.index) &&
        !insideSpans(names, number.index) &&
        !isNonValueNumber(text, number)
      ) {
        spans.push([number.index, number.index + number.raw.length]);
      }
    }
  }

  return spans.sort((left, right) => left[0] - right[0]);
}

/** Does only glue -- units, punctuation, "to", "and", "or" -- stand between two values? */
function isRowGlue(gap) {
  return gap
    .replace(SPELLED_HEADER_UNIT_REGEX, " ")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .every((word) => ROW_GLUE_WORDS.has(word.toLowerCase()));
}

/** A value's end, moved past a threshold printed after it ("or less"). */
function endOverThreshold(source, end) {
  const tail = source.slice(end).match(THRESHOLD_TAIL);

  return tail ? end + tail[0].length : end;
}

/**
 * The rows of a quote, in order: each row's label (the text since the previous
 * row's values, or since the start for the first), the [start, end) span of
 * its values, and their text -- which includes a threshold printed after them.
 * Exported for the row_mismatch eval probe.
 *
 * @returns {Array<{ label: string, labelStart: number, start: number, end: number, values: string }>}
 */
export function quoteRows(text) {
  const source = String(text || "");
  const rows = [];

  for (const [start, end] of rowValueSpans(source)) {
    const last = rows[rows.length - 1];

    if (last && (start <= last.end || isRowGlue(source.slice(last.end, start)))) {
      last.end = endOverThreshold(source, Math.max(last.end, end));
      continue;
    }

    const labelStart = last ? last.end : 0;
    rows.push({
      label: source.slice(labelStart, start),
      labelStart,
      start,
      end: endOverThreshold(source, end),
    });
  }

  return rows.map((row) => ({ ...row, values: source.slice(row.start, row.end) }));
}

/** Where the evidence prints one claimed figure, by position. */
function claimFigurePositions(spec, evidenceNumbers, evidenceSpecs, headerUnits) {
  if (spec.unit === "viscosity") {
    const grade = collapseGrade(spec.raw);

    return evidenceSpecs
      .filter((evidenceSpec) => evidenceSpec.unit === "viscosity" && collapseGrade(evidenceSpec.raw) === grade)
      .map(({ index }) => index);
  }

  return evidenceMatchesFor(spec, evidenceNumbers, evidenceSpecs, headerUnits).map(({ index }) => index);
}

/** Subject tokens of a label, without the column-header units it carries. */
function labelTokens(label) {
  return subjectTokens(String(label || "").replace(SPELLED_HEADER_UNIT_REGEX, " "));
}

/**
 * Does the first row's label hold a SHARED header naming the subject -- the
 * subject followed by more of that row's own label? "Engine oil capacity Oil
 * change with filter 4.5 liters" does; "Drain plug 40 N*m" does not, because
 * there "drain plug" is the first row's part, not a header over the next row.
 */
function headerNamesSubject(firstLabel, subject) {
  const tokens = labelTokens(firstLabel);

  for (let start = 0; start + subject.length <= tokens.length; start += 1) {
    if (
      subject.every((token, offset) => tokens[start + offset] === token) &&
      tokens.slice(start + subject.length).some((token) => !HEADER_GLUE_WORDS.has(token))
    ) {
      return true;
    }
  }

  return false;
}

/** The condition words of a row: its label and any threshold after its values. */
function rowConditionWords(row) {
  return conditionWords(`${row.label} ${row.values}`);
}

/**
 * Does a row carry a condition -- with/without, front/rear, a limit, a
 * threshold, a designation? Only such a row is a SUB-row a shared header can
 * carry over to: "Oil change without filter" under "Engine oil capacity". A row
 * naming neither a part nor a condition is not recognizably the header's.
 */
function rowCarriesCondition(row) {
  return [...rowConditionWords(row)].some(
    (word) => ROW_CONDITION_WORDS.has(word) || /^no\d+$/.test(word)
  );
}

/**
 * Does a later row's label name something the claim does not -- a different
 * part? Condition words are judged by rowConditionsAgree instead.
 */
function labelNamesOtherPart(label, claimText) {
  const claimTokens = new Set(subjectTokens(claimText));

  return labelTokens(label).some(
    (token) =>
      !ROW_NON_PART_WORDS.has(token) && !ROW_CONDITION_WORDS.has(token) && !claimTokens.has(token)
  );
}

/** Does row `r` name the subject, itself or through a shared header it may inherit? */
function rowNamesSubject(rows, r, subject, claimText) {
  if (textNamesSubject(rows[r].label, subject)) {
    return true;
  }

  return (
    r > 0 &&
    rowCarriesCondition(rows[r]) &&
    headerNamesSubject(rows[0].label, subject) &&
    !labelNamesOtherPart(rows[r].label, claimText)
  );
}

/**
 * Lowercase words of a text, plus each part designation ("no1") and each
 * threshold ("orless") as one word.
 */
function conditionWords(text) {
  const source = String(text || "");
  const words = new Set(source.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));

  for (const match of source.matchAll(DESIGNATION_REGEX)) {
    words.add(`no${match[1]}`);
  }

  for (const match of source.matchAll(THRESHOLD_REGEX)) {
    words.add(`or${match[1].toLowerCase()}`);
  }

  return words;
}

/**
 * Is row `k` about the same part as row `r`? It names the subject itself, or it
 * is a sibling sub-row under the same shared header: it carries a condition
 * and names no part word that row `r` or the claim does not also name ("Oil
 * change with filter" beside "Oil change without filter").
 */
function rowIsSamePart(rows, k, r, subject, claimText) {
  if (textNamesSubject(rows[k].label, subject)) {
    return true;
  }

  if (k === 0 || !rowCarriesCondition(rows[k]) || !headerNamesSubject(rows[0].label, subject)) {
    return false;
  }

  const known = new Set([...labelTokens(rows[r].label), ...subjectTokens(claimText)]);

  return labelTokens(rows[k].label).every(
    (token) => ROW_NON_PART_WORDS.has(token) || ROW_CONDITION_WORDS.has(token) || known.has(token)
  );
}

/**
 * Does the claim agree with every condition that sets row `r` apart from the
 * other rows about the same part? A condition another part's row prints ("No.
 * 2" on a different bracket) says nothing about which of this part's rows the
 * claim means. With no parsed subject every row counts, the cautious reading.
 */
function rowConditionsAgree(rows, r, claimText, subject) {
  const claimWords = conditionWords(claimText);
  const rowWords = rowConditionWords(rows[r]);
  const otherRowWords = rows
    .filter(
      (_, index) =>
        index !== r && (!subject.length || rowIsSamePart(rows, index, r, subject, claimText))
    )
    .map((row) => rowConditionWords(row));
  const designations = [
    ...new Set([claimWords, rowWords, ...otherRowWords].flatMap((words) => [...words].filter((word) => /^no\d+$/.test(word)))),
  ].map((word) => [word]);
  const groups = designations.length ? [...ROW_CONDITION_GROUPS, designations] : ROW_CONDITION_GROUPS;

  for (const group of groups) {
    const present = (words) =>
      group.flatMap((spellings, alternative) =>
        spellings.some((spelling) => words.has(spelling)) ? [alternative] : []
      );
    const inRow = present(rowWords);

    if (!inRow.length) {
      continue;
    }

    const inClaim = present(claimWords);
    const rowIsUnmarked = inRow.some((alternative) =>
      group[alternative].some((spelling) => UNMARKED_CONDITION_WORDS.has(spelling))
    );
    const agrees =
      inClaim.some((alternative) => inRow.includes(alternative)) ||
      (!inClaim.length && rowIsUnmarked);
    const tellsRowsApart = otherRowWords.some((words) =>
      present(words).some((alternative) => !inRow.includes(alternative))
    );

    if ((inClaim.length || tellsRowsApart) && !agrees) {
      return false;
    }
  }

  return true;
}

/**
 * Row-aware check: one row of the quote must print every figure of the claim,
 * name its part, and carry no condition the claim contradicts or leaves out
 * where that condition tells the rows apart.
 *
 * The part may come from the row's own label, or from a shared header over the
 * table when the row's label names no other part ("Engine oil capacity" over
 * "Oil change without filter"). Units printed only in a column header verify a
 * row's bare numbers as before (printedSpecFor) -- but only that row's.
 *
 * Applies only to claims stating a specification, and only to quotes printing
 * two or more rows; anything else is unchecked here and judged as before. Like
 * the subject check it is lexical: it cannot read a condition worded
 * differently from the page, and it prefers a safe rejection to a guess.
 *
 * @returns {{ grounded: boolean, checked: boolean, detail: "" | "figures_split" | "subject_not_in_row" | "condition_mismatch" }}
 */
export function checkClaimRow(claimText, evidenceText) {
  const specs = extractSpecNumbers(claimText);
  const evidence = String(evidenceText || "");
  const rows = quoteRows(evidence);

  if (!specs.length || rows.length < 2) {
    return { grounded: true, checked: false, detail: "" };
  }

  const holding = rowsHoldingFigures(specs, rows, evidence);

  if (!holding.length) {
    return { grounded: false, checked: true, detail: "figures_split" };
  }

  const subject = parseClaimSubject(claimText);
  const named = holding.filter(
    (row) => !subject.length || rowNamesSubject(rows, row, subject, claimText)
  );

  if (!named.length) {
    return { grounded: false, checked: true, detail: "subject_not_in_row" };
  }

  if (!named.some((row) => rowConditionsAgree(rows, row, claimText, subject))) {
    return { grounded: false, checked: true, detail: "condition_mismatch" };
  }

  return { grounded: true, checked: true, detail: "" };
}

/** Indexes of the rows that print every figure the claim states. */
function rowsHoldingFigures(specs, rows, evidence) {
  const evidenceNumbers = allNumbersIn(evidence);
  const evidenceSpecs = readSpecs(evidence);
  const headerUnits = headerUnitsIn(evidence);
  const rowOf = (index) => rows.findIndex((row) => index >= row.start && index < row.end);
  const figureRows = specs.map(
    (spec) =>
      new Set(
        claimFigurePositions(spec, evidenceNumbers, evidenceSpecs, headerUnits)
          .map(rowOf)
          .filter((row) => row >= 0)
      )
  );

  return rows
    .map((_, row) => row)
    .filter((row) => figureRows.every((figureRow) => figureRow.has(row)));
}

// A row's label runs back to the previous figure, so it can hold another
// sentence ("...less than the minimum, replace the rotor. Standard rotor
// thickness:"). Only the sentence that prints the figure ties a word to it.
// "No. 1" is a designation, not a sentence end.
const SENTENCE_END_REGEX = /(?<!\b[Nn]o)[.;!?]["')\]]*\s+/;
const CLAUSE_END_REGEX = /;\s+|(?<!\b[Nn]o)[.!?]\s+(?=[A-Z])/;
const WITH_GROUP = ROW_CONDITION_GROUPS.find((group) => group[0][0] === "with");
// Where a heading's phrase starts within its sentence: after another field's
// colon or a spaced dash. A data list prints one item's condition column
// straight into the next item's name ("...fully depressed - Pedal sensor
// voltage: Min.:"), and that condition is not the heading's.
const HEADING_START_REGEX = /:|\s[-–—]\s/;

/** A label naming no part, only conditions: "Rear", "Exhaust", "Used". */
function isConditionOnly(text) {
  return (
    !partTokens(text).length &&
    [...conditionWords(text)].some((word) => ROW_CONDITION_WORDS.has(word))
  );
}

/**
 * A sentence opening a table, "Minimum lining thickness: Front", split into
 * its heading and the first row's own label -- or null when the text before
 * the colon names no part or the text after it is not only conditions.
 */
function splitHeading(sentence) {
  const text = sentence.replace(/[\s:]+$/, "");
  const colon = text.lastIndexOf(":");
  const heading = text.slice(0, colon).split(HEADING_START_REGEX).at(-1) || "";
  const label = text.slice(colon + 1);

  return colon >= 0 && partTokens(heading).length && isConditionOnly(label) ? { heading, label } : null;
}

/**
 * The heading a row is listed under, or "". "Minimum lining thickness: Front
 * 1.0 mm Rear 1.5 mm" lists Front and Rear under "Minimum lining thickness":
 * a heading ending in a colon, followed by rows whose own labels are only
 * conditions. The first row naming a part of its own ("... 1.5 mm. Shoe
 * clearance: Front ...") ends the heading's reach.
 */
function headingOver(rows, index) {
  for (let k = index; k >= 1; k -= 1) {
    if (!isConditionOnly(rows[k].label.split(SENTENCE_END_REGEX).at(-1) || "")) {
      return "";
    }

    const previous = rows[k - 1].label.split(SENTENCE_END_REGEX).at(-1) || "";

    if (previous.replace(/[\s:]+$/, "").includes(":")) {
      return splitHeading(previous)?.heading ?? "";
    }
  }

  return "";
}

function figureSentence(rows, index, subject) {
  const row = rows[index];
  const sentences = row.label.split(SENTENCE_END_REGEX);
  const ownLabel = sentences.at(-1) || "";
  const heading = headingOver(rows, index);

  // A row listed under a heading holds under the heading's conditions as well
  // as its own -- required, not just allowed, since the heading explicitly
  // governs it. (A row printing another alternative of the heading's group,
  // "new belt: Standard 5 mm Used 7 mm", is already held apart by the row
  // check, which reads the row's own label.)
  if (heading) {
    const words = conditionWords(`${heading} ${ownLabel} ${row.values}`);

    return { label: `${heading} ${ownLabel}`, words, ownWords: words };
  }

  // The row opening such a table is read the same way, as its heading and its
  // own label, so a condition run in before the heading belongs to neither.
  const opening = index + 1 < rows.length && headingOver(rows, index + 1) ? splitHeading(ownLabel) : null;

  if (opening) {
    const words = conditionWords(`${opening.heading} ${opening.label} ${row.values}`);

    return { label: `${opening.heading} ${opening.label}`, words, ownWords: words };
  }

  let label = ownLabel;

  // A figure under a bare heading ("Install a new drain plug. Torque : 37 Nm")
  // takes its part -- and that part's conditions -- from the sentence just
  // before, but only when that sentence names the claim's own part: "Use a new
  // gasket. Torque : 37 Nm" lends the drain plug nothing.
  if (
    !partTokens(label).length &&
    sentences.length > 1 &&
    subject.length &&
    textNamesSubject(sentences.at(-2), subject)
  ) {
    label = `${sentences.at(-2)} ${label}`;
  }

  return {
    label,
    words: conditionWords(`${label} ${row.values}`),
    // The figure's sentence alone. A borrowed sentence may also qualify another
    // noun ("install the drain plug with a new gasket"), so it can support a
    // condition the claim states but never impose one.
    ownWords: conditionWords(`${ownLabel} ${row.values}`),
  };
}

function partTokens(label) {
  return labelTokens(label).filter(
    (token) => !ROW_NON_PART_WORDS.has(token) && !ROW_CONDITION_WORDS.has(token)
  );
}

function alternativesIn(words, group) {
  return group.flatMap((spellings, alternative) =>
    spellings.some((spelling) => words.has(spelling)) ? [alternative] : []
  );
}

function normalizeRowValues(values) {
  return values.replace(/\s+/g, " ").trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Column headers (F4)
// ---------------------------------------------------------------------------
//
// A table prints its column header once ("Front Rear") and then rows of cells.
// The condition checks above read the header words as conditions of the whole
// row, so a quote printing the header and both cells supported the right
// column's claim AND the wrong column's: "the rear height is 310 mm" against a
// cell printed under Front. They also could not tell a quote cut after the first
// cell from a different row (see columnReading).
//
// A column is read the only way a flattened table allows: by POSITION. The
// cited chunk's row must end its label in a clean header run and print exactly
// as many cells as the run has columns; cell i is then under header i. Anything
// the verifier cannot align -- a footnoted extra cell, a stacked table, a blank
// cell, a header printed only above the first row -- is not a column row and is
// judged as before, except that a claim naming a column of a header it cannot
// align is rejected (`column_unresolved`).

// "with" is ordinary English, so with/without is never a printed column header.
// (The "or less" / "or more" group needs no exclusion: its tokens are
// synthesized from two words and never occur as a word of a label.)
const COLUMN_GROUPS = ROW_CONDITION_GROUPS.filter((group) => group !== WITH_GROUP);

// Measured on the real tables, not tuned: they print their header words 2 to 3
// words apart and 4 to 5 words before the first value. Looser bounds would read
// prose ("front brake pads wear faster than the rear ones ...") as a header.
const COLUMN_HEADER_MAX_GAP = 4;
const COLUMN_HEADER_MAX_TAIL = 8;

/**
 * The column header a row's label ends in, or null.
 *
 * Takes the last sentence of the label and, for one condition group at a time,
 * the cluster of its words nearest the values: header words from the end
 * backwards, no more than COLUMN_HEADER_MAX_GAP words apart. A label that
 * wanders through earlier text ("... B Rear axle bolt ... C Front wheel ...
 * Front C - A Rear D - B") still yields its real header, because the earlier
 * words are too far back to join the cluster. The run needs two DIFFERENT
 * alternatives of ONE group and must end within COLUMN_HEADER_MAX_TAIL words of
 * the values. It yields none when the reading is ambiguous: an alternative
 * repeated inside the cluster, or two groups each with a run (Front/Rear beside
 * Inner/Outer). Exported for tests and probes.
 *
 * @param {string} label
 * @returns {{ group: string[][], alternatives: number[] } | null} the group and
 *   the alternative printed first, second, ... (the column order)
 */
export function columnHeaderRun(label) {
  const sentence = String(label || "").split(SENTENCE_END_REGEX).at(-1) || "";
  const words = sentence.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const runs = [];

  for (const group of COLUMN_GROUPS) {
    const hits = words.flatMap((word, position) => {
      const alternative = group.findIndex((spellings) => spellings.includes(word));

      return alternative >= 0 ? [{ position, alternative }] : [];
    });
    const seen = new Set();
    /** @type {Array<{ position: number, alternative: number }>} */
    const run = [];
    let ambiguous = false;

    for (let index = hits.length - 1; index >= 0; index -= 1) {
      const hit = hits[index];

      // A hit this far back starts an earlier cluster: not part of this header.
      if (run.length && run[0].position - hit.position - 1 > COLUMN_HEADER_MAX_GAP) {
        break;
      }

      // The same alternative twice inside one cluster ("Front Rear Front axle"):
      // the nearest occurrences would read as Rear, Front and reverse every
      // column, and the words cannot say which occurrence is the header.
      if (seen.has(hit.alternative)) {
        ambiguous = true;
        break;
      }

      seen.add(hit.alternative);
      run.unshift(hit);
    }

    if (
      !ambiguous &&
      run.length >= 2 &&
      words.length - 1 - run[run.length - 1].position <= COLUMN_HEADER_MAX_TAIL
    ) {
      runs.push({ group, alternatives: run.map((hit) => hit.alternative) });
    }
  }

  return runs.length === 1 ? runs[0] : null;
}

/**
 * The cells of one row, as [start, end) spans in `text`. A figure and its
 * alternate-unit rendering are ONE cell -- "310 mm (12.2 in.)", "37 N*m (377
 * kgf*cm, 27 ft.*lbf)" -- because a value inside an unclosed parenthesis belongs
 * to the cell before it; so does a value linked to it by "to", "and", "or" or
 * "at" (the words quoteRows already treats as glue inside one row: "10 mm or 12
 * mm", "12 mm at 20 °C") or by a dash, tilde or slash ("1.5° +/- 0.3°": a value
 * and its tolerance are one value, not two columns). A range ("0.6 to 1.2 V") is
 * one value, so one cell.
 * Otherwise each value starts a new cell: two adjacent same-unit values are two
 * cells, and an extra or missing cell shows up as a count that does not match
 * the header's. Exported for tests and probes.
 *
 * @param {string} text
 * @param {{ start: number, end: number }} row a row of quoteRows(text)
 * @returns {Array<[number, number]>}
 */
export function quoteRowCells(text, row) {
  const source = String(text || "");
  /** @type {Array<[number, number]>} */
  const cells = [];
  let previousEnd = -1;

  for (const [start, end] of rowValueSpans(source)) {
    if (start < row.start || start >= row.end) {
      continue;
    }

    if (!cells.length) {
      cells.push([start, end]);
      previousEnd = end;
      continue;
    }

    const opened = source.slice(row.start, start);
    const depth = (opened.match(/\(/g) || []).length - (opened.match(/\)/g) || []).length;
    const gap = source.slice(previousEnd, start);
    const linked =
      gap.split(/[^A-Za-z]+/).some((word) => ROW_GLUE_WORDS.has(word.toLowerCase())) ||
      /[-–~/]/.test(gap);

    if (depth > 0 || start < previousEnd || linked) {
      const last = cells[cells.length - 1];

      last[1] = Math.max(last[1], end);
    } else {
      cells.push([start, end]);
    }

    previousEnd = Math.max(previousEnd, end);
  }

  return cells;
}

/**
 * Which row of the cited chunk is this quote row? The chunk's row whose label
 * ENDS with the quote row's label (the quote may start inside it) and whose
 * values START with the quote row's values (the quote may stop inside them).
 * Exactly one such row, or -1: two identical rows in one chunk cannot be told
 * apart, so no column is read and the older rules decide.
 */
function sourceRowIndex(quoteRow, sourceRows) {
  const label = normalizeForMatch(quoteRow.label);
  const values = normalizeForMatch(quoteRow.values);
  const candidates = sourceRows.flatMap((row, index) =>
    normalizeForMatch(row.label).endsWith(label) && normalizeForMatch(row.values).startsWith(values)
      ? [index]
      : []
  );

  return candidates.length === 1 ? candidates[0] : -1;
}

/**
 * Where the claim's figures sit in the table: null when the row is not a
 * column row at all, otherwise
 *   { status: "aligned", group, sourceIndex, columnsOf }
 *     the cited chunk's row ends its label in a clean header run and prints
 *     exactly as many cells as the run has columns, and every figure the claim
 *     states was found in a cell. `columnsOf` holds the columns (alternative
 *     numbers) under which EVERY figure is printed -- the intersection, so a
 *     figure printed in both columns of a row can be stated by either, and two
 *     figures under different columns can be stated by neither;
 *   { status: "unaligned", group, sourceIndex }
 *     the run is clean but the cells do not line up with it.
 *
 * The header and the cell count come from the CHUNK's row, not the quote: a
 * quote cut after the first cell still has that cell under the first column,
 * and a quote starting inside the header cannot move a cell to another column.
 * A row printing fewer than two cells is not read at all (see the guard below),
 * so a sentence that merely contains both words of a group is never a table.
 */
function columnReading(rows, index, specs, evidence, sourceRows, sourceText) {
  const row = rows[index];
  const sourceIndex = sourceRowIndex(row, sourceRows);

  if (sourceIndex < 0) {
    return null;
  }

  const run = columnHeaderRun(sourceRows[sourceIndex].label);

  if (!run) {
    return null;
  }

  const unaligned = { status: "unaligned", group: run.group, sourceIndex };
  const sourceCells = quoteRowCells(sourceText, sourceRows[sourceIndex]);
  const quoteCells = quoteRowCells(evidence, row);

  // One value after a pair of group words is a sentence, not a row of cells:
  // "Height difference between the right and left strut caps: 2.0 mm or less". There is
  // nothing to place under a column, so the row is not read and a claim that
  // restates those words is judged as before. Rejecting it would reject real
  // alignment, steering, fuel-sender and climate specifications. A genuine
  // column row with a blank cell also prints one value and is left to the older
  // rules for the same reason; that is a documented limit.
  if (sourceCells.length < 2) {
    return null;
  }

  if (sourceCells.length !== run.alternatives.length) {
    return unaligned;
  }

  // The quote's cells are the chunk row's first cells, cell for cell: the row was
  // matched by label suffix and values prefix (sourceRowIndex), so the same
  // spans, cut at most inside the last one. A figure's position therefore lies
  // in a cell of the quote row, and cell i is under header i.
  const evidenceNumbers = allNumbersIn(evidence);
  const evidenceSpecs = readSpecs(evidence);
  const headerUnits = headerUnitsIn(evidence);
  const cellAt = (position) =>
    quoteCells.findIndex(([start, end]) => position >= start && position < end);
  /** @type {Set<number> | null} */
  let columnsOf = null;

  for (const spec of specs) {
    // The row holds every figure (rowsHoldingFigures chose it) and everything
    // inside a row's span is inside a value span, so each position is in a cell.
    // Were that ever false the figure would be printed under no column, so
    // `columnsOf` would not contain the column a claim names and it would be
    // rejected: the failure direction is the safe one.
    const printedUnder = new Set(
      claimFigurePositions(spec, evidenceNumbers, evidenceSpecs, headerUnits)
        .filter((position) => position >= row.start && position < row.end)
        .map((position) => run.alternatives[cellAt(position)])
    );

    columnsOf = columnsOf
      ? new Set([...columnsOf].filter((alternative) => printedUnder.has(alternative)))
      : printedUnder;
  }

  return { status: "aligned", group: run.group, sourceIndex, columnsOf: columnsOf || new Set() };
}

function judgeFigureRow(rows, index, claimWords, sourceRows, subject, reading = null) {
  const row = rows[index];
  const own = figureSentence(rows, index, subject);

  // The column the claim's figures sit under (F4). Three early rejections; the
  // loop below then still requires the claim's column word to be PRINTED in the
  // figure's own sentence, as it always did.
  if (reading) {
    const stated = alternativesIn(claimWords, reading.group);

    if (reading.status === "unaligned") {
      // A header the verifier cannot align to cells cannot place a figure under
      // a column, so a claim that names one has nothing to stand on.
      if (stated.length) {
        return "column_unresolved";
      }
    } else {
      if (!reading.columnsOf.size) {
        return "column_unresolved";
      }

      // A figure in a table with several columns must say which one, whether or
      // not the quote kept the header.
      if (!stated.length) {
        return "column_unstated";
      }

      if (stated.some((alternative) => !reading.columnsOf.has(alternative))) {
        return "wrong_column";
      }
    }
  }

  // The chunk's own full row, when this quote is a cut of it, is this very row
  // and not another one. Only an aligned column row says so reliably: for any
  // other row the sibling check keeps seeing it, because a quote that dropped a
  // condition word AND cut its values is exactly what that check catches.
  const ownSourceIndex = reading?.status === "aligned" ? reading.sourceIndex : -1;
  const part = partTokens(own.label);
  // Other rows of the source for the same part: their own sentence names it.
  // A row printing the same figure cannot make this one ambiguous.
  const siblings = part.length
    ? sourceRows
        .flatMap((other, otherIndex) =>
          otherIndex !== ownSourceIndex &&
          normalizeRowValues(other.values) !== normalizeRowValues(row.values)
            ? [figureSentence(sourceRows, otherIndex, subject)]
            : []
        )
        .filter((other) => containsTokenSequence(partTokens(other.label), part))
        .map((other) => other.words)
    : [];
  // "with" is a condition only where the source contrasts it with "without";
  // otherwise it is ordinary English ("tightened with a torque wrench").
  const withIsCondition = [claimWords, own.words, ...siblings].some((words) => words.has("without"));

  for (const group of ROW_CONDITION_GROUPS) {
    if (group === WITH_GROUP && !withIsCondition) {
      continue;
    }

    const printed = alternativesIn(own.words, group);
    const stated = alternativesIn(claimWords, group);

    if (stated.some((alternative) => !printed.includes(alternative))) {
      return "condition_not_in_row";
    }

    // The figure's own sentence limits it (minimum, used, cold, without, or
    // less, ...): a claim leaving that out states the figure as if it always
    // held. Only the unmarked default (standard) goes without saying.
    if (
      !stated.length &&
      alternativesIn(own.ownWords, group).some(
        (alternative) =>
          !group[alternative].some((spelling) => UNMARKED_CONDITION_WORDS.has(spelling))
      )
    ) {
      return "condition_dropped";
    }

    // Nothing printed marks an unlabelled row as the standard value: beside a
    // labelled row for the same part it may be the limit (the v3 capture's own
    // page), so a claim cannot say which it is.
    if (!printed.length && siblings.some((words) => alternativesIn(words, group).length)) {
      return "unlabelled_row";
    }
  }

  return "";
}

/**
 * F1v3: a condition must be printed WITH the part and figure it qualifies.
 *
 * Three rules, on the sentence of the quote that prints the claim's figures:
 *   - every condition the claim's figure clause states (used, maximum, hot,
 *     standard, ...) is printed in that sentence -- the same word elsewhere in
 *     the quote does not count (`condition_not_in_row`);
 *   - every condition that sentence prints, other than the unmarked standard,
 *     is stated by the claim, so a limited figure is never presented as if it
 *     always held (`condition_dropped`);
 *   - when another row of the cited SOURCE for the same part carries a
 *     condition the figure's own sentence lacks, the unlabelled figure is
 *     ambiguous and no claim can rest on it (`unlabelled_row`).
 *
 * Reads the source as well as the quote, because a one-row quote shows no
 * sibling. Lexical like the row check: conditions outside ROW_CONDITION_GROUPS
 * ("at idle") are not seen, a condition word in the figure's sentence is taken
 * to qualify the figure, and a label printed only in another chunk is out of
 * reach.
 *
 * F4 adds the table's columns to the same check. When the cited chunk's row
 * ends its label in a column header and prints one cell per column, each
 * figure the claim states is placed under its column by position, and the claim
 * must name that column (`wrong_column` when it names another, `column_unstated`
 * when it names none, `column_unresolved` when its figures sit under different
 * columns, or when a header's cells cannot be aligned and the claim names a
 * column of it). See columnReading for what counts as aligned; a header printed
 * only above a table's first row is not read for the rows after it.
 *
 * @returns {{ grounded: boolean, checked: boolean, detail: "" | "condition_not_in_row" | "condition_dropped" | "unlabelled_row" | "wrong_column" | "column_unstated" | "column_unresolved" }}
 */
export function checkClaimQualifiers(claimText, evidenceText, sourceText) {
  const clauses = String(claimText || "")
    .split(CLAUSE_END_REGEX)
    .filter((clause) => extractSpecNumbers(clause).length);
  const specs = extractSpecNumbers(claimText);
  const evidence = String(evidenceText || "");
  const rows = quoteRows(evidence);
  const holding = specs.length && rows.length ? rowsHoldingFigures(specs, rows, evidence) : [];

  if (!clauses.length || !holding.length) {
    return { grounded: true, checked: false, detail: "" };
  }

  const claimWords = conditionWords(clauses.join(" "));
  const source = String(sourceText ?? evidence);
  const sourceRows = quoteRows(source);
  const subject = parseClaimSubject(claimText);
  // Only the claimed part's rows can support it: another part's row printing
  // the same figure ("Rotor minimum thickness 25.0 mm. Pad thickness 25.0 mm")
  // says nothing about the rotor. When no row names the part (a subject the
  // parser cannot read, a part printed after its figure) every row is judged,
  // which is never looser than before.
  const named = subject.length
    ? holding.filter((row) => rowNamesSubject(rows, row, subject, claimText))
    : [];
  const details = (named.length ? named : holding).map((row) =>
    judgeFigureRow(
      rows,
      row,
      claimWords,
      sourceRows,
      subject,
      columnReading(rows, row, specs, evidence, sourceRows, source)
    )
  );

  if (details.includes("")) {
    return { grounded: true, checked: true, detail: "" };
  }

  return { grounded: false, checked: true, detail: /** @type {any} */ (details[0]) };
}

function createEvidenceId({ documentId, pageNumber, chunkIndex, evidenceQuote }) {
  const digest = createHash("sha256")
    .update(
      [
        "ask-evidence-v1",
        documentId,
        pageNumber,
        chunkIndex,
        normalizeForMatch(evidenceQuote),
      ].join("\u0000")
    )
    .digest("hex")
    .slice(0, 24);

  return `ask_ev_v1_${digest}`;
}

/**
 * Replace unit-bearing specifications with a placeholder.
 *
 * A gap explains what could NOT be verified, so it must not reprint the very
 * number that failed verification -- doing so would put an ungrounded torque
 * value back on screen, just under a different heading. The topic survives so
 * the gap stays useful; the value is kept server-side in `rejected`.
 */
export function redactSpecNumbers(text) {
  return [...SPEC_REGEXES, VISCOSITY_REGEX].reduce(
    (redacted, regex) => redacted.replace(regex, "[unverified value]"),
    String(text || "")
  );
}

/**
 * The fewest words a quote needs to support a claim that states no
 * specification. A claim WITH one is anchored by the numeric check, so "37 Nm"
 * alone may still quote its figure.
 */
const MIN_QUOTE_WORDS_WITHOUT_SPEC = 3;

/** Words in a quote: whitespace-separated pieces holding a letter or digit. */
function quoteWordCount(quote) {
  return String(quote || "")
    .split(/\s+/)
    .filter((piece) => /[\p{L}\p{N}]/u.test(piece)).length;
}

/**
 * Every reason this module can remove a claim, guidance line, or gap for.
 *
 * Exported so the response contract and the metrics sanitizer describe exactly
 * the set the verifier can actually produce, instead of a hand-copied list that
 * drifts. verifyEvidence still writes the literals inline, where they read
 * naturally; askEvidenceContract.test.js drives every rejection path and asserts
 * each emitted reason appears here, so the two cannot diverge silently.
 */
export const ASK_REJECTION_REASONS = Object.freeze([
  "unknown_source",
  "quote_not_in_source",
  "quote_too_short",
  "numeric_anomaly",
  "unrecognized_figure",
  "subject_mismatch",
  "row_mismatch",
  "unsourced_specification",
  "unsourced_gap_specification",
]);

/** The channel of the model's reply a rejected item came from. */
export const ASK_REJECTION_CHANNELS = Object.freeze([
  "documentSupported",
  "generalGuidance",
  "gaps",
]);

/**
 * Verify every claim and gate every channel.
 *
 * Fails CLOSED for unsupported technical numeric claims: they are removed from
 * the actionable answer and converted into explicit gaps, rather than rendered
 * with a warning decoration next to a number that may be invented.
 *
 * Each entry in the returned `rejected` array carries both the safe metadata a
 * caller may expose (`channel`, `itemIndex`, `reason`, `sourceId`) and the
 * detailed fields kept for server-side diagnosis only (`claim`, `unsupported`,
 * `subject`). The detailed fields hold document text and the very specification
 * values that failed verification, so anything shipping this off the server must
 * sanitize first — see buildRejectedMetrics in aiAnswerService.js.
 *
 * @param {{ documentSupported: any[], generalGuidance: string[], gaps: string[], droppedClaimCount?: number }} validated
 * @param {any[]} chunks - retrieval order; index maps to S1..Sn
 */
export function verifyEvidence(validated, chunks) {
  const byLabel = new Map(chunks.map((chunk, index) => [sourceLabel(index), { chunk, index }]));
  const supported = [];
  const gaps = [];
  const rejected = [];

  // Gaps are model-authored too. They describe missing evidence, so a technical
  // value inside one is unsupported by definition and must not leak back onto
  // the screen under a safer-sounding heading.
  for (const [itemIndex, gap] of validated.gaps.entries()) {
    const specs = extractSpecNumbers(gap);

    if (specs.length) {
      rejected.push({
        channel: "gaps",
        itemIndex,
        sourceId: null,
        claim: gap,
        reason: "unsourced_gap_specification",
        unsupported: specs.map((spec) => spec.raw),
      });
      gaps.push("Unverified gap: " + redactSpecNumbers(gap));
      continue;
    }

    gaps.push(gap);
  }

  for (const [itemIndex, claim] of validated.documentSupported.entries()) {
    // Carried on every rejection from this channel. `sourceId` is the label the
    // MODEL supplied, so it is echoed here as-is for diagnosis but must be
    // shape-checked before it can leave the server.
    const origin = { channel: "documentSupported", itemIndex, sourceId: claim.sourceId };
    const mapped = byLabel.get(claim.sourceId.toUpperCase());

    if (!mapped) {
      rejected.push({ ...origin, claim: claim.claim, reason: "unknown_source" });
      gaps.push(`Unverified (source not recognized): ${gapClaimText(claim.claim, "")}`);
      continue;
    }

    if (!quoteAppearsInChunk(claim.evidenceQuote, mapped.chunk.chunkText)) {
      rejected.push({ ...origin, claim: claim.claim, reason: "quote_not_in_source" });
      gaps.push(
        `Unverified (quote not found in the cited page): ${gapClaimText(claim.claim, "")}`
      );
      continue;
    }

    // A claim with no specification has only its words to check, and a quote
    // as short as "OK" cannot support a sentence -- least of all "it is OK to
    // reuse the gasket" on a page saying not to (1A-11).
    if (
      !extractSpecNumbers(claim.claim).length &&
      quoteWordCount(claim.evidenceQuote) < MIN_QUOTE_WORDS_WITHOUT_SPEC
    ) {
      rejected.push({ ...origin, claim: claim.claim, reason: "quote_too_short" });
      gaps.push(
        `Unverified (the quote is too short to support it): ${gapClaimText(
          claim.claim,
          claim.evidenceQuote
        )}`
      );
      continue;
    }

    // The quote is real; now the numbers in the CLAIM must be present in it.
    const numeric = matchClaimNumbers(claim.claim, claim.evidenceQuote);

    if (numeric.unsupported.length) {
      rejected.push({
        ...origin,
        claim: claim.claim,
        reason: "numeric_anomaly",
        unsupported: numeric.unsupported,
      });
      // The failing value is deliberately NOT reprinted here.
      gaps.push(
        `Unverified specification (not found in the cited text): ${gapClaimText(
          claim.claim,
          claim.evidenceQuote
        )}`
      );
      continue;
    }

    // A number no specification pattern could read is checked the only way
    // left: it must be printed in the quote. An unknown unit fails closed.
    const figures = checkUnrecognizedFigures(claim.claim, claim.evidenceQuote);

    if (!figures.grounded) {
      rejected.push({
        ...origin,
        claim: claim.claim,
        reason: "unrecognized_figure",
        unsupported: figures.unsupported.map((figure) => figure.raw),
      });
      gaps.push(
        `Unverified (a figure in it is not printed in the cited text): ${gapClaimText(
          claim.claim,
          claim.evidenceQuote
        )}`
      );
      continue;
    }

    const subject = checkClaimSubject(claim.claim, claim.evidenceQuote);

    if (!subject.grounded) {
      rejected.push({
        ...origin,
        claim: claim.claim,
        reason: "subject_mismatch",
        subject: subject.subject,
      });
      gaps.push(
        `Unverified (the cited text does not name the same part): ${gapClaimText(
          claim.claim,
          claim.evidenceQuote
        )}`
      );
      continue;
    }

    // The part and the figure are both in the quote; in a multi-row quote they
    // must also be in the SAME row, under the claim's condition (S1).
    const row = checkClaimRow(claim.claim, claim.evidenceQuote);

    // ...and a condition the claim states must be printed with that part and
    // figure, which the source must not leave ambiguous (F1v3).
    const qualifiers = row.grounded
      ? checkClaimQualifiers(claim.claim, claim.evidenceQuote, mapped.chunk.chunkText)
      : row;

    if (!qualifiers.grounded) {
      rejected.push({
        ...origin,
        claim: claim.claim,
        reason: "row_mismatch",
        detail: qualifiers.detail,
      });
      gaps.push(
        `Unverified (the cited table prints that figure in another row or condition): ${gapClaimText(
          claim.claim,
          claim.evidenceQuote
        )}`
      );
      continue;
    }

    supported.push({
      evidenceId: createEvidenceId({
        documentId: mapped.chunk.documentId,
        pageNumber: mapped.chunk.pageNumber,
        chunkIndex: mapped.chunk.chunkIndex,
        evidenceQuote: claim.evidenceQuote,
      }),
      claim: claim.claim,
      evidenceQuote: claim.evidenceQuote,
      // The quote's own text for each figure the claim states, verbatim (owner
      // decision D1), so the answer can show what the manual prints beside the
      // claim: "76 ft.*lbf" for a claimed "76 ft-lbs", "80 to 84 °C" for a
      // claimed "80 °C". Empty when the claim states no specification. Like the
      // quote it comes from, it shows the owner what was compared; it does not
      // make the claim correct.
      printedFigures: numeric.printedFigures,
      documentId: mapped.chunk.documentId,
      documentTitle: mapped.chunk.documentTitle,
      originalFilename: mapped.chunk.originalFilename,
      pageNumber: mapped.chunk.pageNumber,
      chunkIndex: mapped.chunk.chunkIndex,
    });
  }

  // Claims the validator dropped past MAX_ITEMS were never checked. Saying so
  // is also what keeps the answer from reading as complete: a gap makes the
  // derived status `partial`, never `answered`.
  const dropped = Number(validated.droppedClaimCount) || 0;

  if (dropped > 0) {
    gaps.push(
      `This answer is incomplete: ${dropped} more ${
        dropped === 1 ? "claim was" : "claims were"
      } not checked, so ${dropped === 1 ? "it is" : "they are"} not shown.`
    );
  }

  // General guidance is not sourced, so ANY technical specification in it is
  // unsupported by definition -- it fails closed regardless of how confident it
  // reads. Step numbers and counts are untouched (no unit, no match).
  const generalGuidance = [];

  for (const [itemIndex, guidance] of validated.generalGuidance.entries()) {
    const specs = extractSpecNumbers(guidance);

    if (specs.length) {
      rejected.push({
        channel: "generalGuidance",
        itemIndex,
        sourceId: null,
        claim: guidance,
        reason: "unsourced_specification",
        unsupported: specs.map((spec) => spec.raw),
      });
      gaps.push(
        `Removed unsourced specification: ${redactSpecNumbers(
          guidance
        )} Check the manual before relying on this.`
      );
      continue;
    }

    generalGuidance.push(guidance);
  }

  return { documentSupported: supported, generalGuidance, gaps, rejected };
}

/**
 * Status derived by the SERVER from what actually verified -- never taken from
 * a model-supplied field, which could contradict its own claims.
 */
export function deriveEvidenceStatus({ documentSupported, gaps }) {
  if (!documentSupported.length) {
    return "not_found";
  }

  return gaps.length ? "partial" : "answered";
}

/**
 * Flatten the verified evidence into the plain `answer` string, so existing
 * consumers of the response keep working unchanged.
 */
export function renderEvidenceAnswer({ documentSupported, generalGuidance, gaps }) {
  const sections = [];

  if (documentSupported.length) {
    sections.push(
      documentSupported
        .map(
          (item) =>
            `${item.claim} [${item.documentTitle || item.originalFilename}, page ${
              item.pageNumber
            }]`
        )
        .join("\n")
    );
  }

  if (generalGuidance.length) {
    sections.push(
      `General guidance — not from your documents:\n${generalGuidance
        .map((line) => `- ${line}`)
        .join("\n")}`
    );
  }

  if (gaps.length) {
    sections.push(`Not covered by your documents:\n${gaps.map((gap) => `- ${gap}`).join("\n")}`);
  }

  return sections.join("\n\n").trim();
}
