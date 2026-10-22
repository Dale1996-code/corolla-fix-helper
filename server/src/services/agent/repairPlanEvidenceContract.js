import {
  checkClaimNumbers,
  quoteAppearsInChunk,
  redactSpecNumbers,
} from "../askEvidenceContract.js";

// Repair-plan evidence contract.
//
// The problem this exists for: the planner used to stream the model's prose
// straight to the browser. A sentence containing an invented torque value
// rendered exactly like one copied from the owner's manual, and readiness was
// scored from free-text inventory strings that nothing checked against the
// repair's real requirements.
//
// The contract instead asks the model for ATOMIC CLAIMS, each carrying a
// verbatim `evidenceQuote` and a run-wide source id (S1, S2, ...). The server:
//   1. validates the shape (hand-written; no new dependency),
//   2. maps each source id back to the chunk it was built from,
//   3. verifies the quote really appears in what the model was shown,
//   4. verifies the claim itself appears within that quote,
//   5. runs the numeric anomaly detector over the claim,
//   6. derives verified / partial / not_found ITSELF,
//   7. renders the final text from accepted claims only.
//
// It deliberately does NOT reuse Ask's schema, renderer, or "answered" status.
// Ask answers a question; the planner covers a task list, so its states and its
// coverage rules are different. Only the three neutral, config-free helpers are
// shared.

/**
 * Technical claims naming an item the repair REQUIRES. They are grouped into
 * requirement rows rather than read as statements about the repair, so anything
 * that renders claims must partition on this list rather than inventing its own
 * copy -- two modules disagreeing about what counts as "a verified statement" is
 * how a checklist ended up saying nothing was verified directly above a list of
 * verified requirements.
 */
export const REQUIREMENT_CLAIM_KINDS = ["required_tool", "required_part"];

/** Technical claims that state something about the repair itself. */
export const STATEMENT_CLAIM_KINDS = [
  "procedure",
  "numeric_spec",
  "safety_instruction",
  "vehicle_fact",
];

/** Claims that describe the repair itself. Coverage requires one of these. */
export const TECHNICAL_CLAIM_KINDS = [...STATEMENT_CLAIM_KINDS, ...REQUIREMENT_CLAIM_KINDS];

/** Grounded assertions that a requirement group is empty. */
export const NEGATIVE_CLAIM_KINDS = ["no_required_tools", "no_required_parts"];

export const CLAIM_KINDS = [...TECHNICAL_CLAIM_KINDS, ...NEGATIVE_CLAIM_KINDS];

// Same list, as a set: a requirement claim is exactly the kind that must name
// the item it requires.
const ITEM_NAME_KINDS = new Set(REQUIREMENT_CLAIM_KINDS);

const ALLOWED_CLAIM_FIELDS = new Set([
  "taskId",
  "kind",
  "claim",
  "sourceId",
  "evidenceQuote",
  "itemName",
  "clauseIndex",
]);

// Fixed, server-authored guidance. It describes how to organize the job, never
// what the vehicle requires, so it needs no citation and can never carry an
// invented specification.
export const ORGANIZATIONAL_GUIDANCE = [
  "Work on level ground with the vehicle secured before starting.",
  "Read every cited procedure end to end before touching a fastener.",
  "Confirm part numbers against the vehicle before buying.",
];

/**
 * Normalizes a requirement name, a claim, or an owner inventory entry. Every
 * item match runs BOTH sides through this one function (1A-07): an asymmetric
 * pair once let punctuation that one side kept decide a match.
 *
 * Parenthetical asides drop out ("torque wrench (1/2 in drive)"), hyphens
 * become spaces ("10-mm" is "10 mm"), "n't" becomes "not" so a negated entry
 * stays recognizable, and "&" becomes "and".
 */
export function normalizeRequirementName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/n['’]t\b/g, " not")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function nameTokens(normalized) {
  return normalized ? normalized.split(" ") : [];
}

/** Start indexes where `needle` occurs as a run of whole tokens of `haystack`. */
function tokenRunStarts(haystack, needle) {
  const starts = [];

  if (!needle.length) {
    return starts;
  }

  for (let at = 0; at + needle.length <= haystack.length; at += 1) {
    if (needle.every((token, offset) => haystack[at + offset] === token)) {
      starts.push(at);
    }
  }

  return starts;
}

// "e", "a", and "is" are whole words of "A torque wrench is required" and name
// no tool. A real name is two words or one word of four letters or more.
const MIN_SINGLE_WORD_ITEM_LENGTH = 4;

function isUsableItemName(normalized) {
  return nameTokens(normalized).length >= 2 || normalized.length >= MIN_SINGLE_WORD_ITEM_LENGTH;
}

// An inventory entry naming the item after one of these says the owner does
// NOT have it: "no torque wrench", "do not have a jack", "need brake pads".
const INVENTORY_ABSENCE_WORDS = new Set([
  "no", "not", "never", "without", "none", "cannot", "need", "needs", "missing",
]);

// Words that may follow an item inside one entry without making it a longer
// name: "jack and jack stands" owns a jack; "jack stands" does not.
const INVENTORY_LIST_JOINERS = new Set(["and", "or", "plus", "with", "but"]);

/**
 * Does one owner inventory entry say the owner has `item`?
 *
 * The item's words must appear whole and END a name: words in front describe it
 * ("3-ton floor jack" owns a jack) but a word after it makes a different thing
 * ("jack stands" are not a jack, "110 mm wrench" is not a "10 mm wrench"). And
 * no absence word may come before it ("no torque wrench"); "no" before a digit
 * is the size abbreviation in "No. 2 Phillips screwdriver", not a negation.
 */
function inventoryEntryHas(entry, item) {
  const tokens = nameTokens(normalizeRequirementName(entry));
  const itemTokens = nameTokens(item);
  const isAbsenceWord = (token, index) =>
    INVENTORY_ABSENCE_WORDS.has(token) && !(token === "no" && /^\d/.test(tokens[index + 1] || ""));

  return tokenRunStarts(tokens, itemTokens).some((at) => {
    const next = tokens[at + itemTokens.length];
    const endsName = next === undefined || INVENTORY_LIST_JOINERS.has(next);
    const negated = tokens.slice(0, at).some(isAbsenceWord);

    return endsName && !negated;
  });
}

/**
 * Validates the finalizer payload's SHAPE against the canonical task list.
 *
 * Structural problems are returned as errors rather than thrown so the agent
 * can hand them back to the model for a bounded number of corrections.
 *
 * @param {any} payload
 * @param {{ tasks?: any[], sourceIds?: Set<string> }} [context]
 */
export function validateFinalizerPayload(payload, { tasks = [], sourceIds = new Set() } = {}) {
  const errors = [];

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { valid: false, errors: ["finalize_repair_plan expects an object."], claims: [] };
  }

  for (const key of Object.keys(payload)) {
    if (key !== "claims") {
      errors.push(`Unknown field "${key}". Only "claims" is accepted.`);
    }
  }

  if (!Array.isArray(payload.claims)) {
    errors.push('"claims" must be an array. Send [] when nothing could be grounded.');
    return { valid: false, errors, claims: [] };
  }

  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const claims = [];

  payload.claims.forEach((claim, index) => {
    const label = `claims[${index}]`;

    if (!claim || typeof claim !== "object" || Array.isArray(claim)) {
      errors.push(`${label} must be an object.`);
      return;
    }

    for (const key of Object.keys(claim)) {
      if (!ALLOWED_CLAIM_FIELDS.has(key)) {
        errors.push(`${label} has unknown field "${key}".`);
      }
    }

    const task = tasksById.get(claim.taskId);

    if (!task) {
      errors.push(`${label}.taskId ${JSON.stringify(claim.taskId)} is not a canonical task id.`);
    }

    if (!CLAIM_KINDS.includes(claim.kind)) {
      errors.push(`${label}.kind ${JSON.stringify(claim.kind)} is not a recognized kind.`);
    }

    if (typeof claim.claim !== "string" || !claim.claim.trim()) {
      errors.push(`${label}.claim must be a non-empty string.`);
    }

    if (typeof claim.sourceId !== "string" || !sourceIds.has(claim.sourceId)) {
      errors.push(`${label}.sourceId ${JSON.stringify(claim.sourceId)} is not a retrieved source.`);
    }

    if (typeof claim.evidenceQuote !== "string" || !claim.evidenceQuote.trim()) {
      errors.push(`${label}.evidenceQuote must be a non-empty verbatim excerpt.`);
    }

    if (ITEM_NAME_KINDS.has(claim.kind) && (typeof claim.itemName !== "string" || !claim.itemName.trim())) {
      errors.push(`${label}.itemName is required for ${claim.kind}.`);
    }

    // A compound task covers more than one clause. Requiring the model to say
    // WHICH clause a claim supports is what stops one brake citation from
    // certifying an ungrounded steering diagnosis in the same task.
    if (task?.compound) {
      const clauseCount = task.clauses?.length || 0;

      if (
        !Number.isInteger(claim.clauseIndex) ||
        claim.clauseIndex < 0 ||
        claim.clauseIndex >= clauseCount
      ) {
        errors.push(
          `${label}.clauseIndex must be an integer 0-${clauseCount - 1} because task ${
            claim.taskId
          } covers ${clauseCount} clauses.`
        );
      }
    }

    claims.push(claim);
  });

  return { valid: errors.length === 0, errors, claims };
}

// ---------------------------------------------------------------------------
// Claim placement (1A-05)
// ---------------------------------------------------------------------------
//
// The claim is a span of its quote, which is a span of the source. Containment
// alone let a claim be ANY substring: "apply grease to the friction surface of
// the brake pads" verified from "Do not apply grease...", and that inverted
// instruction was written into the saved checklist. Where the claim sits is
// part of what it says, so three placement rules apply (owner decision D2):
//
//   - No negator in the three words before the claim, read in the SOURCE, not
//     the quote: otherwise trimming "Do not" off the quote as well launders it.
//     The window stops at a clause boundary, so "Do not reuse the gasket.
//     Replace the gasket..." does not block the second sentence.
//   - No cut through a range or a signed number, also read in the source:
//     "14.8 V" from "13.2 to 14.8 V" and "37 °C" from "-37 °C" change the value.
//   - numeric_spec and safety_instruction claims must be a whole clause of
//     their quote, running from a clause boundary (. ; : ! ? or a | table cell)
//     to the next. Other kinds may be any part of the quote that passes the two
//     rules above.
//
// What this does not do: the whole-clause rule is measured against the quote,
// so a quote that itself stops mid-sentence can still leave out a trailing
// qualifier ("at 2,000 rpm"). And a comma is not a boundary, so a later stage
// ("30 N*m, then a further 90°") is not tied to the first.

const WHOLE_CLAUSE_KINDS = new Set(["numeric_spec", "safety_instruction"]);

const NEGATORS = new Set(["not", "no", "never", "without", "cannot", "nor", "none", "neither"]);

// "dont"/"cant": PDF text and model quotes both drop apostrophes.
const NEGATED_CONTRACTION = /n't$|^(?:dont|doesnt|didnt|cant|wont|isnt|arent|shouldnt|mustnt)$/;

const NEGATION_WINDOW = 3;

// Mirrors quoteAppearsInChunk in askEvidenceContract.js, whose normalizer and
// boundary helpers are private to that module. Kept local so this change does
// not touch the shared module. Every claim reaching these helpers has already
// passed quoteAppearsInChunk twice, so if the two copies ever drift apart the
// only possible effect is a rejection, never an acceptance.
const LETTER = /\p{L}/u;
const DIGIT = /\d/;
const DECIMAL_MARK = /[.,]/;

function normalizeForPlacement(text) {
  return String(text || "")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function startsOnTokenBoundary(haystack, at, needle) {
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

function endsOnTokenBoundary(haystack, end, needle) {
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

/** Every start index where `needle` sits in `haystack` on token boundaries. */
function tokenBoundedOccurrences(needle, haystack) {
  const starts = [];

  if (!needle || !haystack) {
    return starts;
  }

  for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + 1)) {
    if (
      startsOnTokenBoundary(haystack, at, needle) &&
      endsOnTokenBoundary(haystack, at + needle.length, needle)
    ) {
      starts.push(at);
    }
  }

  return starts;
}

const WRAPPING_PUNCTUATION = /["'()[\]]/;

// "." and ":" end a clause only before a space, a bracket, or the end of the
// text: never inside "1.5", "ft.*lbf", or "12:30".
function isClauseMark(text, index) {
  const char = text[index];

  if (";!?|".includes(char)) {
    return true;
  }

  if (char !== "." && char !== ":") {
    return false;
  }

  const next = text[index + 1];
  return next === undefined || next === " " || WRAPPING_PUNCTUATION.test(next);
}

function startsClause(text, start) {
  let index = start - 1;

  while (index >= 0 && (text[index] === " " || WRAPPING_PUNCTUATION.test(text[index]))) {
    index -= 1;
  }

  return index < 0 || isClauseMark(text, index);
}

function endsClause(text, start, end) {
  // A claim that ends with its own mark ("...before bleeding the brakes .")
  // already ends its clause, even when the quote runs on into the next
  // sentence. Live planner runs rejected whole safety sentences until this.
  // The look-back stays inside the claim, so a claim of bare punctuation
  // cannot borrow the period of the sentence before it.
  let back = end - 1;

  while (back >= start && (text[back] === " " || WRAPPING_PUNCTUATION.test(text[back]))) {
    back -= 1;
  }

  if (back >= start && isClauseMark(text, back)) {
    return true;
  }

  let index = end;

  while (index < text.length && (text[index] === " " || WRAPPING_PUNCTUATION.test(text[index]))) {
    index += 1;
  }

  return index >= text.length || isClauseMark(text, index);
}

function isNegator(word) {
  return NEGATORS.has(word) || NEGATED_CONTRACTION.test(word);
}

/** A negator among the last few words of the claim's own clause in the source. */
function dropsNegation(text, start) {
  let clauseStart = 0;

  for (let index = start - 1; index >= 0; index -= 1) {
    if (isClauseMark(text, index)) {
      clauseStart = index + 1;
      break;
    }
  }

  const words = text.slice(clauseStart, start).match(/[\p{L}\p{N}']+/gu) || [];
  return words.slice(-NEGATION_WINDOW).some(isNegator);
}

// A number immediately after a sign, or after "<number> to|through|-|±" (a
// range or a tolerance), is not the whole value.
const SIGN_BEFORE = /[-−–—+±~]$/;
const RANGE_BEFORE = /\d\s*(?:[-−–—~±]|\b(?:to|through|thru|and|or)\b)\s*$/;
const RANGE_AFTER = /^\s*(?:[-−–—~±]|(?:to|through|thru)\b)\s*[-−+]?\d/;
// The claim ends on a number, optionally followed by one short unit token.
const ENDS_ON_VALUE = /\d(?:[.,]\d+)?(?:\s*[^\s\d]{1,8})?$/;

function cutsRange(text, start, end, statement) {
  const before = text.slice(0, start);

  if (DIGIT.test(statement[0]) && (SIGN_BEFORE.test(before) || RANGE_BEFORE.test(before))) {
    return true;
  }

  return ENDS_ON_VALUE.test(statement) && RANGE_AFTER.test(text.slice(end));
}

/**
 * Checks where a claim sits, not just that it is contained. Every placement of
 * the quote in the source and of the claim in the quote is tried; one clean
 * placement verifies, otherwise the first problem found is the reason.
 *
 * @returns {string | null} rejection reason, or null when a clean placement exists
 */
function claimPlacementProblem(claim, evidenceText) {
  const text = normalizeForPlacement(evidenceText);
  const quote = normalizeForPlacement(claim.evidenceQuote);
  const statement = normalizeForPlacement(claim.claim);
  const wholeClause = WHOLE_CLAUSE_KINDS.has(claim.kind);
  let firstProblem = null;

  for (const quoteAt of tokenBoundedOccurrences(quote, text)) {
    for (const offset of tokenBoundedOccurrences(statement, quote)) {
      const start = quoteAt + offset;
      const end = start + statement.length;
      let problem = null;

      if (cutsRange(text, start, end, statement)) {
        problem = "range_cut";
      } else if (dropsNegation(text, start)) {
        problem = "negation_dropped";
      } else if (
        wholeClause &&
        !(startsClause(quote, offset) && endsClause(quote, offset, offset + statement.length))
      ) {
        problem = "not_whole_clause";
      }

      if (!problem) {
        return null;
      }

      if (!firstProblem) {
        firstProblem = problem;
      }
    }
  }

  // No placement at all means the local copy disagreed with quoteAppearsInChunk.
  return firstProblem || "claim_not_in_quote";
}

// ---------------------------------------------------------------------------
// Subject guard (1A-06 / 1B-01)
// ---------------------------------------------------------------------------
//
// A bare "37 N*m" copied from the drain-plug line verified the oil-filter task,
// and "torque: 107 Nm" verified a slide-pin task whose source says 34 Nm. Ask's
// subject guard cannot catch this: it asks whether the claim's part appears in
// its quote, and a planner claim is a verbatim fragment of its quote, so the
// answer is always yes. The missing link is the TASK:
//
//   - Any claim carrying a figure, and every numeric_spec, must name what it is
//     about: a word that is not a unit, a function word, a repair verb, a
//     position, or "torque" (every fastener has a torque). So a bare value never
//     counts toward coverage, under whatever kind it is filed.
//   - A numeric_spec must also share a subject word with its task -- in the
//     claim or in its quote. A compound task is matched against the clause the
//     claim says it supports, falling back to the title when that clause names
//     nothing.
//
// Lexical, not semantic: "caliper bolts" under "Replace brake pads" needs the
// quote to say "brake" too. That rejects some honest claims; the model can quote
// the line that names the part. A task with no subject word ("Check it") can
// verify no specification at all -- fail closed.

const FUNCTION_WORDS = [
  "a", "about", "after", "again", "all", "also", "am", "an", "and", "another", "any", "are", "as",
  "at", "be", "been", "before", "being", "both", "but", "by", "can", "could", "did", "do", "does",
  "don", "down", "each", "either", "every", "for", "from", "had", "has", "have", "here", "how", "i",
  "if", "in", "into", "is", "it", "its", "just", "less", "may", "me", "might", "more", "most",
  "must", "my", "neither", "never", "no", "nor", "not", "of", "off", "on", "only", "onto", "or",
  "other", "our", "out", "over", "per", "same", "should", "so", "some", "such", "than", "that",
  "the", "their", "them", "then", "there", "these", "they", "this", "those", "to", "under",
  "until", "up", "us", "very", "via", "was", "we", "were", "what", "when", "where", "which",
  "while", "who", "why", "will", "with", "without", "would", "you", "your",
];

const UNIT_WORDS = [
  "amp", "ampere", "amperes", "amps", "bar", "cc", "cm", "deg", "degree", "degrees", "feet", "foot",
  "ft", "gal", "gallon", "gallons", "hour", "hours", "hr", "hrs", "hz", "imp", "inch", "inches",
  "kg", "kgf", "khz", "km", "kmh", "kpa", "kv", "kω", "lb", "lbf", "lbs", "liter", "liters",
  "litre", "litres", "ma", "min", "mins", "minute", "minutes", "ml", "mm", "mpa", "mph", "mv",
  "nm", "ohm", "ohms", "oz", "pa", "percent", "pint", "pints", "psi", "pt", "qt", "qts", "quart",
  "quarts", "rpm", "sec", "second", "seconds", "secs", "volt", "volts", "watt", "watts",
];

// Words every task title and every specification line share, so sharing one
// is no evidence that a claim and a task are about the same part.
const GENERIC_WORDS = [
  "additional", "adjust", "adjustment", "apply", "approx", "approximately", "between", "bottom",
  "change", "changing", "check", "checked", "checking", "clean", "component", "components",
  "ensure", "final", "first", "front", "further", "inner", "inside", "inspect", "inspection",
  "install", "installation", "installed", "installing", "item", "items", "left", "lh", "limit",
  "loosen", "lower", "make", "max", "maximum", "measure", "measured", "measurement", "min",
  "minimum", "need", "needed", "new", "old", "outer", "outside", "part", "parts", "perform",
  "procedure", "range", "read", "reading", "reads", "rear", "reinstall", "remove", "removal",
  "removed", "removing", "replace", "replaced", "replacement", "replacing", "require", "required",
  "retighten", "rh", "right", "service", "servicing", "set", "setting", "side", "sides", "spec",
  "specification", "specifications", "specified", "specs", "standard", "step", "steps", "sure",
  "test", "testing", "third", "through", "thru", "tighten", "tightened", "tightening", "tool",
  "tools", "top", "torque", "torqued", "torquing", "turn", "upper", "use", "using", "value",
  "values", "verify",
];

const NON_SUBJECT_WORDS = new Set([...FUNCTION_WORDS, ...UNIT_WORDS, ...GENERIC_WORDS]);

// Enough to make "pads" meet "pad" and "batteries" meet "battery"; applied to
// both sides, so its mistakes cancel out.
function stemWord(word) {
  if (word.length > 4 && word.endsWith("ies")) {
    return `${word.slice(0, -3)}y`;
  }

  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) {
    return word.slice(0, -1);
  }

  return word;
}

/** The words of `text` that could name a part or a specification. */
function subjectWords(text) {
  const words = new Set();

  for (const word of String(text || "").toLowerCase().match(/\p{L}+/gu) || []) {
    const stem = stemWord(word);

    if (word.length >= 2 && !NON_SUBJECT_WORDS.has(word) && !NON_SUBJECT_WORDS.has(stem)) {
      words.add(stem);
    }
  }

  return words;
}

function taskSubjectWords(task, clauseIndex) {
  if (!task) {
    return new Set();
  }

  const clause = task.compound && Number.isInteger(clauseIndex) ? task.clauses?.[clauseIndex] : null;
  const fromClause = subjectWords(clause);

  return fromClause.size ? fromClause : subjectWords(task.title);
}

/** @returns {string | null} "subject_missing", or null when the claim is anchored */
function claimSubjectProblem(claim, task) {
  const isSpec = claim.kind === "numeric_spec";

  if (!isSpec && !DIGIT.test(claim.claim)) {
    return null;
  }

  const named = subjectWords(claim.claim);

  if (!named.size) {
    return "subject_missing";
  }

  if (!isSpec) {
    return null;
  }

  const taskWords = taskSubjectWords(task, claim.clauseIndex);
  const evidenceWords = new Set([...named, ...subjectWords(claim.evidenceQuote)]);

  return [...taskWords].some((word) => evidenceWords.has(word)) ? null : "subject_missing";
}

/**
 * Verifies each validated claim against the source it cites.
 *
 * Fails CLOSED: a claim whose quote is not in the source, whose text is not in
 * its own quote, which drops a negation or cuts a range or clause, whose
 * numbers are not supported, or which does not name its part and its task
 * becomes a GAP rather than rendered content. Rejected claims never disappear
 * silently -- if they did, a model could submit one easy claim, omit
 * everything hard, and still look fully grounded.
 *
 * @param {any[]} claims
 * @param {{ sourcesById: Map<string, any>, tasks?: any[] }} context
 */
export function verifyClaims(claims, { sourcesById, tasks = [] }) {
  const accepted = [];
  const rejected = [];
  const tasksById = new Map(tasks.map((task) => [task.id, task]));

  for (const claim of claims) {
    const source = sourcesById.get(claim.sourceId);
    // Verify against exactly what the model was shown, not the full stored
    // chunk: a quote can only be honest if it came from visible text.
    const evidenceText = source?.evidenceText || "";

    if (!quoteAppearsInChunk(claim.evidenceQuote, evidenceText)) {
      rejected.push({ claim, reason: "quote_not_in_source" });
      continue;
    }

    if (!quoteAppearsInChunk(claim.claim, claim.evidenceQuote)) {
      // Paraphrase. The quote may be real while the sentence built from it is
      // not, which is exactly how an invented spec acquires a citation.
      rejected.push({ claim, reason: "claim_not_in_quote" });
      continue;
    }

    const placementProblem = claimPlacementProblem(claim, evidenceText);

    if (placementProblem) {
      rejected.push({ claim, reason: placementProblem });
      continue;
    }

    const numbers = checkClaimNumbers(claim.claim, claim.evidenceQuote);

    if (!numbers.grounded) {
      rejected.push({ claim, reason: "unsupported_number" });
      continue;
    }

    const subjectProblem = claimSubjectProblem(claim, tasksById.get(claim.taskId));

    if (subjectProblem) {
      rejected.push({ claim, reason: subjectProblem });
      continue;
    }

    if (ITEM_NAME_KINDS.has(claim.kind)) {
      const itemName = normalizeRequirementName(claim.itemName);

      if (!isUsableItemName(itemName)) {
        rejected.push({ claim, reason: "item_name_too_short" });
        continue;
      }

      const claimTokens = nameTokens(normalizeRequirementName(claim.claim));

      if (!tokenRunStarts(claimTokens, nameTokens(itemName)).length) {
        rejected.push({ claim, reason: "item_not_in_claim" });
        continue;
      }
    }

    accepted.push({ ...claim, source });
  }

  return { accepted, rejected };
}

const REJECTION_TEXT = {
  quote_not_in_source: "the quoted text was not found in the cited document",
  claim_not_in_quote: "the statement was not supported word-for-word by its quote",
  negation_dropped: 'the statement left out a "not", "no", or "never" that comes right before it in the cited text',
  range_cut: "the statement cut a range or a signed value out of the cited text",
  not_whole_clause: "a specification or safety statement must be a whole sentence or clause of its quote",
  unsupported_number: "a number in the statement was not present in the cited text",
  subject_missing: "the statement did not name the part it applies to, or a part named by its task",
  item_name_too_short: "the named item was too short to identify a tool or part",
  item_not_in_claim: "the named item did not appear in the supporting statement",
};

/**
 * Turns rejections into owner-readable gaps.
 *
 * Numbers are redacted: reprinting "torque to 54 Nm" inside a gap that says the
 * value was unverified still puts the invented number in front of the owner.
 */
export function describeRejections(rejected) {
  return rejected.map((entry) => {
    const detail = REJECTION_TEXT[entry.reason] || "the statement could not be verified";
    return `Dropped an unverified statement for task ${entry.claim.taskId}: ${detail} (${redactSpecNumbers(
      entry.claim.claim
    )}).`;
  });
}

/**
 * Which canonical tasks are covered by accepted evidence.
 *
 * A task is covered when it has at least one accepted TECHNICAL claim and no
 * rejected claims. A compound task needs one per clause.
 */
export function assessTaskCoverage({ tasks, accepted, rejected }) {
  const rejectedTaskIds = new Set(rejected.map((entry) => entry.claim.taskId));

  return tasks.map((task) => {
    const technical = accepted.filter(
      (claim) => claim.taskId === task.id && TECHNICAL_CLAIM_KINDS.includes(claim.kind)
    );

    const hasRejection = rejectedTaskIds.has(task.id);
    let clausesCovered = true;

    if (task.compound) {
      const covered = new Set(technical.map((claim) => claim.clauseIndex));
      clausesCovered = (task.clauses || []).every((_clause, index) => covered.has(index));
    }

    return {
      taskId: task.id,
      title: task.title,
      claimCount: technical.length,
      covered: technical.length > 0 && !hasRejection && clausesCovered,
      hasRejection,
      clausesCovered,
    };
  });
}

/**
 * Derives the run's evidence status.
 *
 * `verified` is a claim about THIS RUN, not about the manuals: every displayed
 * statement passed the exact checks above. It does not mean the uploaded PDFs
 * are complete.
 */
export function deriveEvidenceStatus({ coverage, accepted, requirements }) {
  const technicalAccepted = accepted.filter((claim) =>
    TECHNICAL_CLAIM_KINDS.includes(claim.kind)
  );

  // An empty claims array is the honest "nothing could be grounded" result and
  // may only ever be not_found.
  if (!technicalAccepted.length) {
    return "not_found";
  }

  const everyTaskCovered = coverage.length > 0 && coverage.every((entry) => entry.covered);
  const requirementsResolved =
    requirements.tools.status !== "unknown" && requirements.parts.status !== "unknown";

  return everyTaskCovered && requirementsResolved ? "verified" : "partial";
}

/**
 * Groups accepted requirement claims and matches them against trusted inventory.
 *
 * Matching is whole-word on text both sides normalize the same way: an entry
 * owns an item when the item's words END a name in it and nothing before them
 * negates it (see inventoryEntryHas). No fuzzy or embedding guesses: an
 * uncertain match here becomes readiness points, and a wrongly-awarded point
 * tells an owner they are ready for a brake job they cannot finish. Until
 * 1A-07 this was a raw substring test, so "no torque wrench" satisfied
 * "torque wrench" and "jack stands" satisfied "jack".
 */
export function buildRequirementGroups({ accepted, availableTools, availableParts }) {
  const group = (itemKind, negativeKind, inventory) => {
    const required = [
      ...new Set(
        accepted
          .filter((claim) => claim.kind === itemKind)
          .map((claim) => normalizeRequirementName(claim.itemName))
          .filter(Boolean)
      ),
    ];

    const declaredNone = accepted.some((claim) => claim.kind === negativeKind);

    if (!required.length) {
      // A grounded "no tools required" satisfies the group. An EMPTY list does
      // not: silence is not evidence that nothing is needed.
      return declaredNone
        ? { status: "none_required", required: [], satisfied: [], missing: [] }
        : { status: "unknown", required: [], satisfied: [], missing: [] };
    }

    const satisfied = [];
    const missing = [];

    for (const item of required) {
      const owned = inventory.some((entry) => inventoryEntryHas(entry, item));
      (owned ? satisfied : missing).push(item);
    }

    return {
      status: missing.length ? "unmet" : "satisfied",
      required,
      satisfied,
      missing,
    };
  };

  return {
    tools: group("required_tool", "no_required_tools", availableTools),
    parts: group("required_part", "no_required_parts", availableParts),
  };
}

/**
 * Renders the plan the owner reads.
 *
 * Built from accepted claims plus fixed organizational guidance only. The
 * model's own prose never reaches this string.
 */
export function renderPlanText({ tasks, accepted, coverage, requirements, gaps }) {
  const lines = [];
  const coverageById = new Map(coverage.map((entry) => [entry.taskId, entry]));

  lines.push("Repair plan");
  lines.push("");

  for (const task of tasks) {
    const entry = coverageById.get(task.id);
    lines.push(`${task.id}. ${task.title}${task.safetyCritical ? "  [safety-critical]" : ""}`);

    const claims = accepted.filter(
      (claim) => claim.taskId === task.id && TECHNICAL_CLAIM_KINDS.includes(claim.kind)
    );

    if (!claims.length) {
      lines.push("   No statement from your documents could be verified for this task.");
    } else {
      for (const claim of claims) {
        const { source } = claim;
        lines.push(`   - ${claim.claim} [${claim.sourceId}: ${source.documentTitle} p.${source.pageNumber}]`);
      }
    }

    if (entry && !entry.covered && claims.length) {
      lines.push("   Coverage for this task is incomplete.");
    }

    lines.push("");
  }

  const describeGroup = (label, groupData) => {
    if (groupData.status === "none_required") {
      return `${label}: the cited procedures state none are required.`;
    }
    if (groupData.status === "unknown") {
      return `${label}: not established from your documents.`;
    }
    if (groupData.status === "satisfied") {
      return `${label}: all verified items are on your list (${groupData.required.join(", ")}).`;
    }
    return `${label}: missing ${groupData.missing.join(", ")}.`;
  };

  lines.push("Requirements");
  lines.push(`   ${describeGroup("Tools", requirements.tools)}`);
  lines.push(`   ${describeGroup("Parts", requirements.parts)}`);
  lines.push("");

  lines.push("Before you start");
  for (const guidance of ORGANIZATIONAL_GUIDANCE) {
    lines.push(`   - ${guidance}`);
  }

  if (gaps.length) {
    lines.push("");
    lines.push("Gaps");
    for (const gap of gaps) {
      lines.push(`   - ${gap}`);
    }
  }

  return lines.join("\n").trim();
}

/**
 * The whole contract in one call.
 *
 * @param {any} payload  Raw `finalize_repair_plan` arguments from the model.
 * @param {{ tasks: any[], sources: any[], availableTools: string[], availableParts: string[] }} context
 */
export function buildRepairPlanEvidence(payload, { tasks, sources, availableTools, availableParts }) {
  const sourcesById = new Map(sources.map((source) => [source.id, source]));
  const validation = validateFinalizerPayload(payload, {
    tasks,
    sourceIds: new Set(sourcesById.keys()),
  });

  if (!validation.valid) {
    return { valid: false, errors: validation.errors };
  }

  const { accepted, rejected } = verifyClaims(validation.claims, { sourcesById, tasks });
  const requirements = buildRequirementGroups({ accepted, availableTools, availableParts });
  const coverage = assessTaskCoverage({ tasks, accepted, rejected });

  const gaps = [...describeRejections(rejected)];

  for (const entry of coverage) {
    if (!entry.covered && !entry.hasRejection) {
      gaps.push(
        entry.claimCount === 0
          ? `No verified evidence was found for task ${entry.taskId} ("${entry.title}").`
          : `Task ${entry.taskId} ("${entry.title}") is only partly covered by verified evidence.`
      );
    }
  }

  if (requirements.tools.status === "unknown") {
    gaps.push("Required tools could not be established from your documents.");
  } else if (requirements.tools.status === "unmet") {
    gaps.push(`Tools not on your list: ${requirements.tools.missing.join(", ")}.`);
  }

  if (requirements.parts.status === "unknown") {
    gaps.push("Required parts could not be established from your documents.");
  } else if (requirements.parts.status === "unmet") {
    gaps.push(`Parts not on your list: ${requirements.parts.missing.join(", ")}.`);
  }

  const evidenceStatus = deriveEvidenceStatus({ coverage, accepted, requirements });

  // Only sources that actually support shown content become citations. A chunk
  // retrieved and then unused is not evidence for anything.
  const citedIds = new Set(accepted.map((claim) => claim.sourceId));
  const citations = sources
    .filter((source) => citedIds.has(source.id))
    .map((source) => ({
      sourceId: source.id,
      documentId: source.documentId,
      documentTitle: source.documentTitle,
      originalFilename: source.originalFilename,
      pageNumber: source.pageNumber,
      chunkIndex: source.chunkIndex,
      snippet: source.snippet,
    }));

  return {
    valid: true,
    evidenceStatus,
    requirements,
    coverage,
    citations,
    gaps,
    verifiedClaims: accepted.map((claim) => ({
      taskId: claim.taskId,
      kind: claim.kind,
      claim: claim.claim,
      sourceId: claim.sourceId,
    })),
    rejectedCount: rejected.length,
    text: renderPlanText({ tasks, accepted, coverage, requirements, gaps }),
  };
}
