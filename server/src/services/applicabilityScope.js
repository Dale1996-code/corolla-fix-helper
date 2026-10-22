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

import {
  CHUNK_WORD_SIZE,
  CHUNK_WORD_STEP,
  chunkStartWordIndex,
  normalizeChunkWords,
} from "./chunkGeometry.js";

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
 * @typedef {null | { value: string, exclude: boolean, kind: MarkerKind } | { unresolved: true, kind: MarkerKind }} AxisScope
 * @typedef {{ engine: AxisScope, plant: AxisScope }} Scope
 * @typedef {{ start: number, end: number, scope: Scope }} ScopeSegment
 */

/** @type {Readonly<Scope>} */
export const EMPTY_SCOPE = Object.freeze({ engine: null, plant: null });

const AXES = /** @type {const} */ (["engine", "plant"]);
const BASE_KINDS = new Set(["article_title", "diagram_title"]);
const OVERLAY_KINDS = new Set(["inline_for", "row_label"]);
const UNRESOLVED_KINDS = new Set(["legend", "column_header", "unknown_code"]);
// "6. INSTALL ..." -- a new numbered step ends the step-local (for X) scope.
const NUMBERED_STEP = /(?:^|\s)\d{1,3}\.\s+[A-Z]{2,}/g;

const ACCOUNT_HEADER = /Corolla\s+L4[-\s]?1\.8L\s*\(\s*2ZR-FE\s*\)/g;
const ENGINE_TOKEN = /\b([1-9][A-Z]{2})\s?-?\s?(FE|FXE|FAE|FSE|FKS|GE|GZE)\b/g;
// OCR swaps letters and digits ("2A2-FE"). With the hyphen required, a code-
// shaped token the strict pattern cannot read is still seen -- as unknown.
const OCR_ENGINE_TOKEN = /\b([0-9][A-Z0-9]{2})\s?-\s?(FE|FXE|FAE|FSE|FKS|GE|GZE)\b/g;
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

  const strictTokens = [...blanked.matchAll(ENGINE_TOKEN)];
  const ocrTokens = [...blanked.matchAll(OCR_ENGINE_TOKEN)].filter(
    (ocr) =>
      !strictTokens.some(
        (strict) => ocr.index < strict.index + strict[0].length && strict.index < ocr.index + ocr[0].length
      )
  );
  const engineTokens = [...strictTokens, ...ocrTokens].sort((left, right) => left.index - right.index);

  /** @type {ScopeMarker[]} */
  const engineMarkers = engineTokens.map((match) => {
    const value = `${match[1]}-${match[2]}`;
    const start = match.index;
    const end = start + match[0].length;
    const before = blanked.slice(Math.max(0, start - 12), start);
    const after = blanked.slice(end, end + 4);
    const inlineFor = /\(\s*for\s+$/i.test(before) && /^\s*\)/.test(after);

    /** @type {MarkerKind} */
    let kind = "row_label";
    if (!KNOWN_ENGINE_CODES.includes(value)) {
      kind = "unknown_code";
    } else if (within(diagrams, start, end)) {
      kind = "diagram_title";
    } else if (within(articles, start, end) && (isParenthesized(blanked, start, end) || inlineFor)) {
      // "Inspection (for 2AZ-FE)" in a title line scopes the whole article.
      kind = "article_title";
    } else if (inlineFor) {
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
    const plantInlineFor =
      /\(\s*for\s+$/i.test(blanked.slice(Math.max(0, token.start - 8), token.start)) &&
      /^\s*\)/.test(blanked.slice(token.end, token.end + 3));
    if (within(diagrams, token.start, token.end)) {
      kind = "diagram_title";
    } else if (
      within(articles, token.start, token.end) &&
      (isParenthesized(blanked, token.start, token.end) || plantInlineFor)
    ) {
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

/**
 * Split text into segments of constant scope.
 *
 * Per axis, three layers apply, strongest first:
 *   1. UNRESOLVED -- from a legend, a column header, or an unknown code to the
 *      end of the text. Nothing can be paired with a variant there.
 *   2. OVERLAY -- a (for X) block or a row label, until the next one on the same
 *      axis, a diagram or article title, a numbered step, or the end of the text.
 *   3. BASE -- an article title or a diagram title, until the next one. Only
 *      this layer is handed to the next page (`carryOut`); an article line
 *      resets it even when its title names no variant.
 *
 * @param {string} text
 * @param {{ carryIn?: Scope }} [options]
 * @returns {{ segments: ScopeSegment[], carryOut: Scope, markers: ScopeMarker[] }}
 */
export function resolveSegments(text, { carryIn = EMPTY_SCOPE } = {}) {
  const source = String(text || "");
  const blanked = blankAccountHeader(source);
  const markers = findScopeMarkers(source);

  /** @type {Array<{ at: number, apply: (state: any) => void }>} */
  const events = [];
  for (const span of articleSpans(blanked)) {
    events.push({
      at: span.start,
      apply: (state) => {
        for (const axis of AXES) {
          state[axis].base = null;
          state[axis].overlay = null;
        }
      },
    });
  }
  for (const match of blanked.matchAll(NUMBERED_STEP)) {
    events.push({
      at: match.index,
      apply: (state) => {
        for (const axis of AXES) {
          state[axis].overlay = null;
        }
      },
    });
  }
  // A diagram title or an article title is judged as a WHOLE: one clear variant
  // scopes it; two different variants, or a code nobody can read, make it an
  // unresolved base that carries on like any title. Otherwise the print order of
  // "<2AZ-FE / 2ZR-FE>" would decide, and a misread "<2ZA-FE>" would leave the
  // previous diagram's engine in force on the pages that follow it.
  const titleGroups = [
    ...rangesOf(DIAGRAM_GROUP, blanked).map((range) => ({ ...range, kind: "diagram_title" })),
    ...articleSpans(blanked).map((range) => ({ ...range, kind: "article_title" })),
  ];
  const groupOf = (marker) =>
    titleGroups.find(
      (group) =>
        marker.start >= group.start &&
        marker.end <= group.end &&
        (marker.kind === group.kind || marker.kind === "unknown_code")
    );
  const grouped = new Set();
  for (const group of titleGroups) {
    for (const axis of AXES) {
      const members = markers.filter((marker) => marker.axis === axis && groupOf(marker) === group);
      if (!members.length) {
        continue;
      }
      members.forEach((marker) => grouped.add(marker));
      const variants = new Set(members.map((marker) => `${marker.value}|${marker.exclude}`));
      const readable = members.every((marker) => marker.kind !== "unknown_code");
      const base =
        readable && variants.size === 1
          ? { value: /** @type {string} */ (members[0].value), exclude: members[0].exclude, kind: group.kind }
          : { unresolved: /** @type {true} */ (true), kind: group.kind };
      events.push({
        at: members[0].start,
        apply: (state) => {
          state[axis].base = base;
          state[axis].overlay = null;
        },
      });
    }
  }

  for (const marker of markers) {
    if (grouped.has(marker)) {
      continue;
    }
    events.push({
      at: marker.start,
      apply: (state) => {
        const layer = state[marker.axis];
        if (UNRESOLVED_KINDS.has(marker.kind)) {
          layer.unresolved = layer.unresolved || { unresolved: true, kind: marker.kind };
        } else if (BASE_KINDS.has(marker.kind)) {
          layer.base = { value: /** @type {string} */ (marker.value), exclude: marker.exclude, kind: marker.kind };
          layer.overlay = null;
        } else if (OVERLAY_KINDS.has(marker.kind)) {
          layer.overlay = { value: /** @type {string} */ (marker.value), exclude: marker.exclude, kind: marker.kind };
        }
        // Links never scope the text around them.
      },
    });
  }
  // Stable order: at one offset, an article reset runs before the title marker
  // inside it, because spans start at "Vehicle >" which precedes the title.
  events.sort((left, right) => left.at - right.at);

  // Only a title's scope crosses a page -- including an unresolved title.
  const readCarry = (axisScope) => (axisScope && BASE_KINDS.has(axisScope.kind) ? axisScope : null);
  const state = {
    engine: { base: readCarry(carryIn.engine), overlay: null, unresolved: null },
    plant: { base: readCarry(carryIn.plant), overlay: null, unresolved: null },
  };
  /** @returns {Scope} */
  const current = () => ({
    engine: state.engine.unresolved || state.engine.overlay || state.engine.base,
    plant: state.plant.unresolved || state.plant.overlay || state.plant.base,
  });

  /** @type {ScopeSegment[]} */
  const segments = [];
  let segmentStart = 0;
  let index = 0;
  while (index < events.length) {
    const at = events[index].at;
    if (at > segmentStart) {
      segments.push({ start: segmentStart, end: at, scope: current() });
      segmentStart = at;
    }
    while (index < events.length && events[index].at === at) {
      events[index].apply(state);
      index += 1;
    }
  }
  if (source.length > segmentStart || segments.length === 0) {
    segments.push({ start: segmentStart, end: source.length, scope: current() });
  }

  return {
    segments,
    carryOut: { engine: state.engine.base, plant: state.plant.base },
    markers,
  };
}

/**
 * The scope in effect at a character offset. An offset at or past the end
 * reads the last segment.
 *
 * @param {ScopeSegment[]} segments
 * @param {number} offset
 * @returns {Scope}
 */
export function scopeAt(segments, offset) {
  if (!segments.length) {
    return EMPTY_SCOPE;
  }

  const found = segments.find((segment) => offset >= segment.start && offset < segment.end);
  return found ? found.scope : segments[segments.length - 1].scope;
}

/** Character offset of each word in a single-space-joined word list. */
function wordOffsets(words) {
  const offsets = [];
  let at = 0;
  for (const word of words) {
    offsets.push(at);
    at += word.length + 1;
  }
  return offsets;
}

/**
 * Scope every page of one document, and every stored chunk on it.
 *
 * Page text is normalized exactly as the chunker normalizes it, so chunk `i`
 * of a page starts at word `chunkStartWordIndex(i)` of `text`. A chunk's
 * `entryScope` is the scope in effect at its first word -- which is how a chunk
 * that names no engine itself still knows it sits inside a 2AZ-FE block.
 *
 * @param {Array<{ pageNumber: number, text: string }>} pages
 */
export function computeDocumentScopes(pages) {
  const ordered = [...(pages || [])].sort((left, right) => left.pageNumber - right.pageNumber);
  /** @type {Scope} */
  let carry = EMPTY_SCOPE;

  return ordered.map(({ pageNumber, text: rawText }) => {
    const words = normalizeChunkWords(rawText);
    const text = words.join(" ");
    const { segments, carryOut, markers } = resolveSegments(text, { carryIn: carry });
    carry = carryOut;

    const offsets = wordOffsets(words);
    const chunks = [];
    // Same loop shape as chunkPageText, so the chunk count matches storage.
    for (let chunkIndex = 0; chunkIndex * CHUNK_WORD_STEP < words.length; chunkIndex += 1) {
      const startWord = chunkStartWordIndex(chunkIndex);
      const endWord = Math.min(startWord + CHUNK_WORD_SIZE, words.length);
      const startChar = offsets[startWord];
      const endChar = endWord < words.length ? offsets[endWord] : text.length;

      chunks.push({
        chunkIndex,
        entryScope: scopeAt(segments, startChar),
        ownMarkers: markers.filter((marker) => marker.start >= startChar && marker.start < endChar),
      });

      if (startWord + CHUNK_WORD_SIZE >= words.length) {
        break;
      }
    }

    return { pageNumber, text, segments, chunks };
  });
}

/**
 * @typedef {"applies"|"other_variant"|"unresolved"|"not_stated"} ApplicabilityVerdict
 */

const PROFILE_FIELD_BY_AXIS = { engine: "engineCode", plant: "buildPlant" };

/**
 * Judge one axis. Unknown is never a match: a scoped axis whose owner value is
 * not set is `unresolved`.
 *
 * @param {AxisScope} axisScope
 * @param {string | null} ownerValue
 * @returns {ApplicabilityVerdict}
 */
function classifyAxis(axisScope, ownerValue) {
  if (!axisScope) {
    return "not_stated";
  }
  if ("unresolved" in axisScope) {
    return "unresolved";
  }
  if (!ownerValue) {
    return "unresolved";
  }

  const matches = axisScope.value === ownerValue;
  return matches !== axisScope.exclude ? "applies" : "other_variant";
}

/**
 * Classify a scope against the owner's vehicle profile. By default only the
 * engine axis is checked (N5 decision #9); pass `axes` to add the plant.
 *
 * Combination is fail-closed: any axis naming another variant makes the whole
 * verdict `other_variant`; otherwise any unresolved axis makes it `unresolved`;
 * `applies` needs at least one axis to apply and none to object.
 *
 * @param {Scope} scope
 * @param {import("./vehicleApplicabilityProfile.js").ApplicabilityProfile} profile
 * @param {{ axes?: Array<"engine" | "plant"> }} [options]
 * @returns {{ verdict: ApplicabilityVerdict, byAxis: Partial<Record<"engine" | "plant", ApplicabilityVerdict>> }}
 */
export function classifyScope(scope, profile, { axes = ["engine"] } = {}) {
  /** @type {Partial<Record<"engine" | "plant", ApplicabilityVerdict>>} */
  const byAxis = {};
  for (const axis of axes) {
    byAxis[axis] = classifyAxis(scope[axis], profile[PROFILE_FIELD_BY_AXIS[axis]]);
  }

  const verdicts = Object.values(byAxis);
  /** @type {ApplicabilityVerdict} */
  let verdict = "not_stated";
  if (verdicts.includes("other_variant")) {
    verdict = "other_variant";
  } else if (verdicts.includes("unresolved")) {
    verdict = "unresolved";
  } else if (verdicts.includes("applies")) {
    verdict = "applies";
  }

  return { verdict, byAxis };
}
