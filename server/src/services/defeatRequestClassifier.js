// Deterministic T4 request-intent gate (roadmap N2.5).
//
// Milestone 5 wrote down a four-tier hazard policy and implemented three tiers of
// it. This module is the fourth:
//
//   T1 routine                  -> answer normally.
//   T2 hazardous but documented -> answer, plus the document's own safety text.
//   T3 specialist               -> answer as preparation, with a shop referral.
//   T4 defeat / unsafe          -> refuse the procedure itself.        <-- here
//
// WHY THIS IS NOT IN safetyClassifier.js. That module answers "how hazardous is
// this TASK?" and its rule table is asserted whole by safetyClassifier.test.js:
// every rule carries both an `isSafetyCriticalTask` and a `detectSafetyFlags`
// field, because those two lists once drifted apart. This module answers a
// different question -- "what is the owner's GOAL in this REQUEST?" -- and has
// neither field. Folding it into that table would mix task hazard with request
// intent and break the invariant that keeps the table honest.
//
// WHY IT IS ORDINARY CODE. A model asked to judge intent would replace a
// deterministic guarantee with a probabilistic one, and would cost a provider
// call on exactly the request we refuse to spend money on. No model, no
// embedding, no retrieval, no flag.
//
// THE BIAS IS DELIBERATE AND ASYMMETRIC. Over-refusing is the worse failure:
// brake and airbag work is precisely what this app exists to help with, so a
// dangerous *topic* must never trigger a refusal. Every rule below therefore
// requires a defeat GOAL, not a hazardous subject, and a legitimate-intent
// marker exempts the defeat-looking action it qualifies.
//
// THE EXEMPTION IS CLAUSE-LOCAL, AND THAT IS THE POINT. It was once checked
// across the whole request, which meant an unrelated second sentence could
// pardon an explicit defeat in the first:
//
//   "How do I permanently disable the airbag so it never works again?
//    Also, how do I diagnose the ABS warning?"
//
// The word "diagnose" there qualifies the ABS question, not the airbag one. A
// marker now only excuses a match in its OWN clause, and a single unpardoned
// defeat clause refuses the whole request however many legitimate clauses
// surround it.
//
// WHAT IT IS NOT. This is an owner-facing policy gate for a single-user local
// app, not adversarial defense. Someone who deliberately words a defeat request
// to look like a service step will get through, and that is an accepted trade:
// tightening it would start refusing real repair questions.

/** Statuses and text below are reused; this module introduces no new vocabulary. */
export const DEFEAT_REFUSAL_MESSAGE =
  "This app does not provide instructions for permanently disabling, bypassing, or defeating a vehicle safety system. Ask how to diagnose, repair, or restore it instead and the documents will be searched normally.";

// Verbs whose ordinary meaning IS defeat. These need no permanence marker.
const DEFEAT_VERBS = [
  /\bbypass(?:es|ed|ing)?\b/,
  /\bdefeat(?:s|ed|ing)?\b/,
  /\bcircumvent(?:s|ed|ing)?\b/,
  /\bneutrali[sz](?:e|es|ed|ing)\b/,
  /\bspoof(?:s|ed|ing)?\b/,
  /\b(?:trick|fool)(?:s|ed|ing)?\b/,
];

// Verbs that are perfectly legitimate on their own -- an OEM SRS service step
// disconnects and disables the system on purpose. These count only when the same
// clause also states a PERMANENT goal.
const AMBIGUOUS_VERBS = [
  /\bdisabl(?:e|es|ed|ing)\b/,
  /\bdeactivat(?:e|es|ed|ing)\b/,
  /\b(?:turn|shut|switch)(?:s|ed|ing)?\s+off\b/,
  /\bdisconnect(?:s|ed|ing)?\b/,
  /\bunplug(?:s|ged|ging)?\b/,
  /\bremov(?:e|es|ed|ing)\b/,
  /\bdelet(?:e|es|ed|ing)\b/,
  /\boverrid(?:e|es|den|ing)\b/,
  /\bsilenc(?:e|es|ed|ing)\b/,
  /\bsuppress(?:es|ed|ing)?\b/,
  /\bget rid of\b/,
  /\bstop\b[^]{0,40}\bworking\b/,
];

// A stated intention that the system stays defeated. This is the line between
// "disable the SRS before removing the steering wheel" and "disable it for good".
const PERMANENCE_MARKERS = [
  /\bpermanent(?:ly)?\b/,
  /\bfor good\b/,
  /\bfor ?ever\b/,
  /\bonce and for all\b/,
  /\bno longer\b/,
  /\bnever (?:comes? back|come back|again|works?|turns? on)\b/,
  /\bstays? off\b/,
  /\binstead of (?:fix|repair|replac)\w*/,
  /\bwithout (?:fix|repair|replac)\w*/,
  /\b(?:don'?t|do not|never) have to (?:fix|repair|replac)\w*/,
];

// "Make the ABS stop working" states the system's failure as the owner's own
// goal, with no defeat verb and no permanence marker. "Stop working" alone stays
// an ambiguous verb, because "my ABS stopped working" is a symptom, so this
// counts only when
//   - the owner does the causing: "how do I make", "I want to get", "a way to
//     stop", or a bare imperative. "Why does the switch make the ABS stop
//     working?" and "will disconnecting the battery make the airbag stop
//     working?" name a part as the cause, and are questions about symptoms; and
//   - the safety system is the thing made to stop: see causedFailure. In "the
//     ABS makes the brakes stop working" it is the brakes.
// "make sure" is a precaution, never a goal. Deploying is deliberately absent:
// keeping an airbag from deploying is the whole point of the SRS service steps.
// Between the owner and the verb only helper words and "-ly" adverbs may sit,
// so "I don't want to make ..." never qualifies. Group 1 is the wording
// reported as the verb; group 2 is the thing made to stop.
const OWNER_AGENT =
  "(?:^|\\b(?:i|we|you|one|me|us)(?: (?:want|need|d|would|like|to|can|could|should|will|ll|try|trying|going|help|just|also|\\w+ly))* |\\bhow to |\\bways? (?:to|of) )";
const CAUSED_FAILURE = [
  new RegExp(
    `${OWNER_AGENT}((?:make|making|get|getting)\\b(?! (?:sure|certain)\\b)((?: \\w+){1,4}?) (?:(?:to )?(?:stop|quit) (?:working|functioning|operating)|(?:not|never) (?:work|function|operate))\\b)`
  ),
  new RegExp(
    `${OWNER_AGENT}((?:stop|stopping|keep|keeping|prevent|preventing)((?: \\w+){1,4}?) from (?:working|functioning|operating)\\b)`
  ),
];

// A stated goal that the system stop working. Every permanence marker is one,
// and so is every CAUSED_FAILURE; the rest are the plain purpose clauses an
// owner types instead ("so it doesn't work", "stop it from working"). Used ONLY
// to void HOW_IT_WORKS below -- they are deliberately not permanence markers,
// because "my airbag light doesn't work anymore" describes a symptom and must
// not arm an ambiguous verb.
const DEFEAT_GOAL_PHRASES = [
  ...PERMANENCE_MARKERS,
  ...CAUSED_FAILURE,
  /\bany ?more\b/,
  /\bso (?:that )?(?:\w+ ){1,3}(?:doesn t|doesnt|does not|won t|wont|will not|can t|cant|cannot|can not|don t|dont|do not|never) (?:\w+ )?(?:work|function|deploy|activat|engag)\w*/,
  /\b(?:stop|keep|prevent)(?:s|ped|ping|ing|ed)? (?:\w+ ){0,3}from (?:work|function|deploy|activat|engag)\w*/,
  /\bmak(?:e|es|ing) (?:\w+ ){1,3}(?:not|stop|never) work\w*/,
];

// "How does the airbag work?" is this exemption's real purpose. But the same
// words open "how do I bypass the airbag so it doesn't work", where "work" is
// the defeat goal itself (audit 1A-18). And a clause runs on to the next
// sentence stop, so "How do I bypass the airbag, and how does the system work?"
// put a how-it-works question beside a bypass it never asked about. Hence:
//   - the subject is a system, never the asker: "how do I/you/we/one ..." asks
//     for instructions, not how something works;
//   - it is one question: no second "how" inside it;
//   - it excuses a clause only when the clause states no DEFEAT_GOAL_PHRASES
//     and every defeat verb in it sits INSIDE such a question, as "bypass" does
//     in "how does the ABS bypass valve work". See howItWorksExcuses.
const HOW_IT_WORKS = /\bhow (?:does|do)\b(?! (?:i|you|we|one)\b)(?:(?!\bhow\b)[^]){0,40}\bwork\b/;

// Named safety systems only. A bare "warning light" is deliberately NOT a target:
// "permanently turn off the maintenance required light" is a legitimate reset
// procedure, and a generic target would refuse it.
const SAFETY_SYSTEM_TARGETS = [
  /\bair ?bags?\b/,
  /\bsrs\b/,
  /\bsupplemental restraint\b/,
  /\brestraint system\b/,
  /\bseat ?belts?\b/,
  /\bpretensioners?\b/,
  /\babs\b/,
  /\banti ?lock\b/,
  /\bbrakes?\b[^]{0,30}\b(?:warning|sensor|light|lamp|switch)\b/,
  /\b(?:warning|sensor)\b[^]{0,30}\bbrakes?\b/,
  /\btraction control\b/,
  /\bvsc\b/,
  /\bstability control\b/,
  /\btpms\b/,
  /\btire pressure (?:monitor\w*|warning)\b/,
  /\b(?:safety|shift) interlock\b/,
  /\bsafety system\b/,
];

// Legitimate goals. Checked WITHIN the matching clause only -- see the
// clause-local note above.
//
// A separate "..., then reconnect it" clause needs no cross-clause pardon: the
// disconnect clause it follows carries no permanence marker, so it never
// matched in the first place and there is nothing to excuse.
const LEGITIMATE_INTENT_MARKERS = [
  /\btemporar(?:y|ily)\b/,
  /\bbefore (?:working|servicing|service|removing|replacing|starting|you work|any work|disassembl\w*)\b/,
  // "while servicing", and the "while I replace ..." an owner types for the same
  // service window that "before replacing" already names.
  /\bwhile (?:(?:i|you|we) (?:m |am |re |are )?)?(?:servic|work|test|diagnos|repair|replac|remov|install|bleed)\w*/,
  /\bduring (?:service|servicing|repair|diagnosis|testing)\b/,
  /\bfor (?:diagnosis|testing|troubleshooting)\b/,
  /\bto (?:diagnose|test|troubleshoot|check|inspect)\b/,
  /\breconnect(?:s|ed|ing)?\b/,
  /\bre ?enabl(?:e|es|ed|ing)\b/,
  /\brestor(?:e|es|ed|ing)\b/,
  /\breactivat(?:e|es|ed|ing)\b/,
  /\bre ?arm(?:s|ed|ing)?\b/,
  /\bback on\b/,
  /\bworks? again\b/,
  /\bworking again\b/,
  /\bwait(?:s|ed|ing)? (?:\d+|the required|the specified|at least)\b/,
  /\bsafely (?:service|work|handle|disable|disarm|remove)\b/,
  /\b(?:per|according to) the (?:manual|procedure|fsm)\b/,
  HOW_IT_WORKS,
];

/**
 * Lower-case, flatten separators, collapse whitespace.
 *
 * Hyphens and slashes become spaces so "anti-lock", "re-enable", and "air-bag"
 * match the same patterns as their spaced spellings.
 *
 * @param {string} text
 * @returns {string}
 */
function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[‐-―]/g, "-")
    .replace(/[-/_]+/g, " ")
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Split into clauses so a defeat verb in one sentence cannot pair with a safety
 * system named in an unrelated one.
 *
 * @param {string} text raw (un-normalized) request text
 * @returns {string[]} normalized clauses, empties dropped
 */
function toClauses(text) {
  return String(text || "")
    .split(/[.?!;\n\r]+/)
    .map((clause) => normalize(clause))
    .filter(Boolean);
}

// A negator immediately before a restoration phrase inverts it: "so it never
// works again" is the permanence marker wearing the restoration marker's words.
// Allows up to two intervening words so "never comes back on" is caught too.
const NEGATED = /\b(?:never|no longer|not|cannot|can t|won t|don t|doesn t)\s+(?:\w+\s+){0,2}$/;

/**
 * First legitimate-intent marker in a clause, ignoring negated ones and a
 * how-it-works marker in a clause that states a defeat goal.
 *
 * @param {string} clause normalized clause text
 * @returns {string|null}
 */
function firstExemption(clause) {
  for (const pattern of LEGITIMATE_INTENT_MARKERS) {
    const found = clause.match(pattern);

    if (!found || found.index === undefined) {
      continue;
    }

    if (NEGATED.test(clause.slice(0, found.index))) {
      continue;
    }

    if (pattern === HOW_IT_WORKS && !howItWorksExcuses(clause)) {
      continue;
    }

    return found[0].trim();
  }

  return null;
}

/**
 * Whether the clause's how-it-works question is what its defeat verbs belong to.
 *
 * A defeat verb outside every such question belongs to something else the
 * clause asks -- "how do I bypass the airbag, and how does the system work?" --
 * and the question has no standing to pardon it.
 *
 * @param {string} clause normalized clause text
 * @returns {boolean}
 */
function howItWorksExcuses(clause) {
  if (firstMatch(DEFEAT_GOAL_PHRASES, clause)) {
    return false;
  }

  const questions = spansOf(HOW_IT_WORKS, clause);

  return DEFEAT_VERBS.every((pattern) =>
    spansOf(pattern, clause).every(([start, end]) =>
      questions.some(([questionStart, questionEnd]) => start >= questionStart && end <= questionEnd)
    )
  );
}

/** @param {RegExp} pattern @param {string} text @returns {Array<[number, number]>} */
function spansOf(pattern, text) {
  return [...text.matchAll(new RegExp(pattern.source, "g"))].map(
    (found) => /** @type {[number, number]} */ ([found.index, found.index + found[0].length])
  );
}

/**
 * The owner's stated goal that a named safety system stop working, if any.
 *
 * The safety system must be the thing made to stop, not merely named somewhere
 * in the clause; see CAUSED_FAILURE.
 *
 * @param {string} clause normalized clause text
 * @returns {{ wording: string, target: string } | null}
 */
function causedFailure(clause) {
  for (const pattern of CAUSED_FAILURE) {
    const found = clause.match(pattern);
    const target = found ? firstMatch(SAFETY_SYSTEM_TARGETS, found[2]) : null;

    if (found && target) {
      return { wording: found[1].trim(), target };
    }
  }

  return null;
}

/** @param {RegExp[]} patterns @param {string} text @returns {string|null} */
function firstMatch(patterns, text) {
  for (const pattern of patterns) {
    const found = text.match(pattern);

    if (found) {
      return found[0].trim();
    }
  }

  return null;
}

/**
 * @typedef {object} DefeatRequestVerdict
 * @property {boolean} refuse true when the request asks to permanently defeat a
 *   safety system and no legitimate-intent marker was present.
 * @property {string|null} verb the defeat verb that matched, if any.
 * @property {string|null} target the safety system that matched, if any.
 * @property {string|null} permanence the permanence marker, when one was needed.
 * @property {string|null} allowedBy the legitimate-intent marker, found in the
 *   SAME clause, that excused an otherwise-matching clause. Non-null only when
 *   `refuse` is false.
 */

/**
 * Classify one free-text request for safety-system defeat intent.
 *
 * Refuses when any single clause carries BOTH a defeat goal and a named safety
 * system and states no legitimate service, diagnostic, or restoration intent of
 * its own. One such clause refuses the whole request; a marker in a different
 * clause qualifies that clause's action, not this one.
 *
 * @param {string} text the owner's question or repair brief, as typed
 * @returns {DefeatRequestVerdict}
 */
export function classifyDefeatRequest(text) {
  const empty = { refuse: false, verb: null, target: null, permanence: null, allowedBy: null };

  if (!normalize(text)) {
    return empty;
  }

  // An excused match is remembered rather than returned, so scanning continues:
  // a later clause may hold a defeat this one has no standing to pardon.
  let excused = null;

  for (const clause of toClauses(text)) {
    const target = firstMatch(SAFETY_SYSTEM_TARGETS, clause);

    if (!target) {
      continue;
    }

    const defeatVerb = firstMatch(DEFEAT_VERBS, clause);
    const failureGoal = causedFailure(clause);
    const ambiguousVerb = firstMatch(AMBIGUOUS_VERBS, clause);
    const permanence = ambiguousVerb ? firstMatch(PERMANENCE_MARKERS, clause) : null;

    if (!defeatVerb && !failureGoal && !(ambiguousVerb && permanence)) {
      continue;
    }

    // Only now is the exemption worth checking: a clause that never matched is
    // allowed anyway, and reporting `allowedBy` on it would be noise.
    const allowedBy = firstExemption(clause);
    const verdict = {
      refuse: !allowedBy,
      verb: defeatVerb || failureGoal?.wording || ambiguousVerb,
      target: failureGoal?.target || target,
      permanence,
      allowedBy,
    };

    // One unpardoned defeat clause decides the whole request.
    if (verdict.refuse) {
      return verdict;
    }

    excused = excused || verdict;
  }

  return excused || empty;
}

/**
 * Boolean convenience wrapper for call sites that only gate.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function isSafetySystemDefeatRequest(text) {
  return classifyDefeatRequest(text).refuse;
}

// Exported for tests that pin the rule tables rather than only their effects.
export const DEFEAT_REQUEST_RULES = Object.freeze({
  DEFEAT_VERBS,
  AMBIGUOUS_VERBS,
  PERMANENCE_MARKERS,
  CAUSED_FAILURE,
  DEFEAT_GOAL_PHRASES,
  SAFETY_SYSTEM_TARGETS,
  LEGITIMATE_INTENT_MARKERS,
});
