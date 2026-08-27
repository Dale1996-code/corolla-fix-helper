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
// requires a defeat GOAL, not a hazardous subject, and any legitimate-intent
// marker anywhere in the text wins outright.
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

// Legitimate goals. Checked across the WHOLE request, not per clause, because
// "..., then reconnect it" is usually a separate clause from the disconnect. Any
// hit here allows the request outright -- see the asymmetric-bias note above.
const LEGITIMATE_INTENT_MARKERS = [
  /\btemporar(?:y|ily)\b/,
  /\bbefore (?:working|servicing|service|removing|replacing|starting|you work|any work|disassembl\w*)\b/,
  /\bwhile (?:servicing|working|testing|diagnosing)\b/,
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
  /\bhow (?:does|do)\b[^]{0,40}\bwork\b/,
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
 * @property {string|null} allowedBy the legitimate-intent marker that allowed an
 *   otherwise-matching request. Non-null only when `refuse` is false.
 */

/**
 * Classify one free-text request for safety-system defeat intent.
 *
 * Refuses only when a single clause carries BOTH a defeat goal and a named
 * safety system, AND the request states no legitimate service, diagnostic, or
 * restoration intent anywhere.
 *
 * @param {string} text the owner's question or repair brief, as typed
 * @returns {DefeatRequestVerdict}
 */
export function classifyDefeatRequest(text) {
  const empty = { refuse: false, verb: null, target: null, permanence: null, allowedBy: null };
  const whole = normalize(text);

  if (!whole) {
    return empty;
  }

  for (const clause of toClauses(text)) {
    const target = firstMatch(SAFETY_SYSTEM_TARGETS, clause);

    if (!target) {
      continue;
    }

    const defeatVerb = firstMatch(DEFEAT_VERBS, clause);
    const ambiguousVerb = firstMatch(AMBIGUOUS_VERBS, clause);
    const permanence = ambiguousVerb ? firstMatch(PERMANENCE_MARKERS, clause) : null;

    if (!defeatVerb && !(ambiguousVerb && permanence)) {
      continue;
    }

    // Only now is the exemption worth checking: a request that never matched is
    // allowed anyway, and reporting `allowedBy` on it would be noise.
    const allowedBy = firstMatch(LEGITIMATE_INTENT_MARKERS, whole);

    if (allowedBy) {
      return {
        refuse: false,
        verb: defeatVerb || ambiguousVerb,
        target,
        permanence,
        allowedBy,
      };
    }

    return {
      refuse: true,
      verb: defeatVerb || ambiguousVerb,
      target,
      permanence,
      allowedBy: null,
    };
  }

  return empty;
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
  SAFETY_SYSTEM_TARGETS,
  LEGITIMATE_INTENT_MARKERS,
});
