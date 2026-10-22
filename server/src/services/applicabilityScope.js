// Applicability scope tagger (N5, docs/n5-applicability-design.md §6).
//
// The manuals print some specifications per engine or build plant, often in one
// table: a 2ZR-FE row and a 2AZ-FE row two lines apart. This module reads, from
// text alone, which variant each stretch of a page is scoped to, so a figure can
// later be judged against the owner's vehicle profile.
//
// It CLASSIFIES ONLY. Nothing here filters retrieval, rejects a claim, or changes
// what Ask or the Repair Planner returns; that enforcement is a later phase (P3,
// P4). applicabilityNotEnforced.test.js fails if a retrieval, verification, or
// planner module starts importing this one without that deliberate change.
//
// Fail-closed by construction. Where the text is ambiguous -- a legend, two codes
// side by side, a code nobody has seen in this corpus -- the region is marked
// UNRESOLVED rather than guessed, and the account header that ALLDATA prints on
// every article ("…Corolla L4-1.8L (2ZR-FE)") is never read as evidence: it
// names the owner's account, not what the article covers (780 documents mention
// 2ZR-FE only there).
//
// Pure leaf: imports only the chunk geometry leaf.

/** Bump when a rule changes, so persisted scopes (P2) can be recomputed. */
export const APPLICABILITY_SCOPE_VERSION = "scope-v1";

/** Engine codes measured in this corpus. Any other code-shaped token is unknown. */
export const KNOWN_ENGINE_CODES = Object.freeze([
  "2ZR-FE",
  "2AZ-FE",
  "1NZ-FE",
  "1NR-FE",
  "1AR-FE",
  "2AR-FE",
  "1UR-FE",
  "3UR-FE",
]);

/** Plants the manuals name. TMMT is real in the corpus and is never an owner plant. */
export const PLANT_VALUES = Object.freeze(["TMC", "NUMMI", "TMMC", "TMMT"]);

/**
 * @typedef {"article_title"|"diagram_title"|"inline_for"|"row_label"|"link"|"legend"|"column_header"|"unknown_code"} MarkerKind
 * @typedef {{ axis: "engine"|"plant", kind: MarkerKind, value: string|null, exclude: boolean, start: number, end: number }} ScopeMarker
 */

const ACCOUNT_HEADER = /Corolla\s+L4[-\s]?1\.8L\s*\(\s*2ZR-FE\s*\)/g;
const ENGINE_TOKEN = /\b([1-9][A-Z]{2})\s?-?\s?(FE|FXE|FAE|FSE|FKS|GE|GZE)\b/g;
const EXCEPT_PLANT_TOKEN = /\bExcept[\s_]+TMC[\s_]+Made\b/gi;
const PLANT_TOKEN = /\b(TMC|TMMT|NUMMI|TMMC)[\s_]+Made\b/gi;
const ARTICLE_START = /\bVehicle\s*>/g;
const ARTICLE_TERMINATORS = ["Locations:", " NOTICE", " CAUTION", " HINT"];
const ARTICLE_MAX_LENGTH = 250;
const DIAGRAM_GROUP = /<[^<>]{1,80}>/g;
const BRACKET_GROUP = /\[[^[\]]{0,200}\]/g;

/**
 * Replace the ALLDATA account header with spaces of the same length, so every
 * offset into the text still points at the same character.
 *
 * @param {string} text
 * @returns {string}
 */
export function blankAccountHeader(text) {
  return String(text || "").replace(ACCOUNT_HEADER, (match) => " ".repeat(match.length));
}

function rangesOf(pattern, text) {
  return [...text.matchAll(pattern)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }));
}

function articleSpans(text) {
  return [...text.matchAll(ARTICLE_START)].map((match) => {
    const start = match.index;
    let end = Math.min(text.length, start + ARTICLE_MAX_LENGTH);

    for (const terminator of ARTICLE_TERMINATORS) {
      const at = text.indexOf(terminator, start);
      if (at !== -1 && at < end) {
        end = at;
      }
    }

    return { start, end };
  });
}

const within = (ranges, start, end) =>
  ranges.some((range) => start >= range.start && end <= range.end);

function isParenthesized(text, start, end) {
  return /\(\s*$/.test(text.slice(Math.max(0, start - 3), start)) && /^\s*\)/.test(text.slice(end, end + 3));
}

function plantTokens(text) {
  const excepts = [...text.matchAll(EXCEPT_PLANT_TOKEN)].map((match) => ({
    value: "TMC",
    exclude: true,
    start: match.index,
    end: match.index + match[0].length,
  }));
  const plain = [...text.matchAll(PLANT_TOKEN)]
    .map((match) => ({
      value: match[1].toUpperCase(),
      exclude: false,
      start: match.index,
      end: match.index + match[0].length,
    }))
    .filter((token) => !excepts.some((except) => token.start >= except.start && token.end <= except.end));

  return [...excepts, ...plain];
}

/**
 * Find every engine and plant scope marker in a piece of text, in order. The
 * account header is blanked first and yields nothing.
 *
 * @param {string} text
 * @returns {ScopeMarker[]}
 */
export function findScopeMarkers(text) {
  const blanked = blankAccountHeader(text);
  const articles = articleSpans(blanked);
  const diagrams = rangesOf(DIAGRAM_GROUP, blanked);
  const brackets = rangesOf(BRACKET_GROUP, blanked);

  /** @type {ScopeMarker[]} */
  const engineMarkers = [...blanked.matchAll(ENGINE_TOKEN)].map((match) => {
    const value = `${match[1]}-${match[2]}`;
    const start = match.index;
    const end = start + match[0].length;
    const before = blanked.slice(Math.max(0, start - 12), start);
    const after = blanked.slice(end, end + 4);

    /** @type {MarkerKind} */
    let kind = "row_label";
    if (!KNOWN_ENGINE_CODES.includes(value)) {
      kind = "unknown_code";
    } else if (within(diagrams, start, end)) {
      kind = "diagram_title";
    } else if (within(articles, start, end) && isParenthesized(blanked, start, end)) {
      kind = "article_title";
    } else if (/\(\s*for\s+$/i.test(before) && /^\s*\)/.test(after)) {
      kind = "inline_for";
    } else if (/\*\s*\d+\s*:\s*$/.test(before)) {
      kind = "legend";
    } else if (/^\s*\[/.test(after) || within(brackets, start, end)) {
      kind = "link";
    }

    return { axis: "engine", kind, value, exclude: false, start, end };
  });

  // Two different codes with nothing but a few non-digit characters between
  // them are column headers: the values below cannot be paired with either.
  for (let index = 0; index + 1 < engineMarkers.length; index += 1) {
    const left = engineMarkers[index];
    const right = engineMarkers[index + 1];
    const gap = blanked.slice(left.end, right.start);

    if (
      left.kind === "row_label" &&
      right.kind === "row_label" &&
      left.value !== right.value &&
      gap.length <= 3 &&
      !/\d/.test(gap)
    ) {
      left.kind = "column_header";
      right.kind = "column_header";
    }
  }

  /** @type {ScopeMarker[]} */
  const plantMarkers = plantTokens(blanked).map((token) => {
    /** @type {MarkerKind} */
    let kind = "row_label";
    if (within(diagrams, token.start, token.end)) {
      kind = "diagram_title";
    } else if (within(articles, token.start, token.end) && isParenthesized(blanked, token.start, token.end)) {
      kind = "article_title";
    } else if (within(brackets, token.start, token.end)) {
      kind = "link";
    } else if (
      isParenthesized(blanked, token.start, token.end) ||
      (/\(\s*for\s+$/i.test(blanked.slice(Math.max(0, token.start - 8), token.start)) &&
        /^\s*\)/.test(blanked.slice(token.end, token.end + 3)))
    ) {
      kind = "inline_for";
    }

    return { axis: "plant", kind, value: token.value, exclude: token.exclude, start: token.start, end: token.end };
  });

  return [...engineMarkers, ...plantMarkers].sort((left, right) => left.start - right.start);
}
