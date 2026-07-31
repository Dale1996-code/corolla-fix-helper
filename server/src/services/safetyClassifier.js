// Safety classification for repair tasks.
//
// ONE rule table drives both questions, so they cannot disagree:
//   - isSafetyCriticalTask() -- does this block a "Ready" rating?
//   - detectSafetyFlags()    -- which warnings does the owner see?
//
// Previously these were two independent systems living in agent/repairTools.js:
// a flat SAFETY_CRITICAL_KEYWORDS substring list, and a separate if-chain of
// warning regexes. They had drifted:
//   - "airbag", "ball joint", "spring", "steering", and "shock" blocked Ready
//     but produced NO warning, so the owner saw a block with no reason.
//   - Cooling work warned about scalding but did NOT block Ready.
// Unifying them makes both invariants structural rather than aspirational, and
// safetyClassifier.test.js asserts them over the whole table.
//
// Matching uses small, context-specific patterns with word boundaries rather
// than broad substring tests. The old list matched substrings, which produced
// real false positives -- most notably "abs" inside "shock ABSorber", so
// replacing a shock absorber raised a BRAKE warning.
//
// A leaf module: it imports nothing.

/**
 * @typedef {object} SafetyRule
 * @property {string} id
 * @property {RegExp} pattern      Matched against the lowercased task text.
 * @property {boolean} blocksReadiness  Whether a match blocks a "Ready" rating.
 * @property {string} flag         Warning shown to the owner. When the rule
 *                                 blocks readiness the text must say why.
 */

/**
 * Every rule currently blocks readiness: on a single-owner DIY car, each of
 * these hazards can injure the owner or someone on the road. `blocksReadiness`
 * is still explicit so a future advisory-only rule can be added without
 * silently gaining blocking power, and so the invariant tests have something
 * real to check.
 *
 * @type {SafetyRule[]}
 */
export const SAFETY_RULES = [
  {
    id: "brakes",
    // \babs\b, not a bare "abs" substring: the old rule fired on "shock absorber".
    pattern:
      /\bbrakes?\b|\bbraking\b|\babs\b|\bcalipers?\b|\brotors?\b|\bmaster cylinder\b|\bbrake booster\b|\bbrake (line|fluid|pads?|shoes?)\b/,
    blocksReadiness: true,
    flag:
      "Brake work affects stopping safety. Bleed the system and test at low speed before driving. This is why the task cannot be marked Ready without acknowledging the risk.",
  },
  {
    id: "fuel",
    pattern: /\bfuel\b|\binjectors?\b|\bgas tank\b|\bfuel (line|rail|pump|filter)\b/,
    blocksReadiness: true,
    flag:
      "Fuel system work is a fire hazard. Relieve fuel pressure, work away from ignition sources, and keep an extinguisher nearby. This is why the task cannot be marked Ready without acknowledging the risk.",
  },
  {
    id: "electrical",
    // "electrical shock" belongs here, NOT with suspension shocks.
    pattern:
      /\bbatter(y|ies)\b|\balternators?\b|\bwiring\b|\bwiring harness\b|\belectrical\b|\bstarter\b|\belectric(al)? shock\b|\bshock hazard\b/,
    blocksReadiness: true,
    flag:
      "Disconnect the battery before electrical work to avoid shorts, burns, and shock. This is why the task cannot be marked Ready without acknowledging the risk.",
  },
  {
    id: "lifting",
    // Only lifting THE VEHICLE. "valve lift" is a measurement, not a hazard,
    // and a "steering wheel" is not a road wheel that implies the car is up on
    // stands -- hence the lookbehind rather than a bare \bwheels?\b.
    pattern:
      /\bjacks?\b|\bjacking\b|\bjack stands?\b|\b(lift|lifting|raise|raising|support|supporting)( the)? (vehicle|car)\b|\bunder the (vehicle|car)\b|\b(?<!steering )wheels?\b|\bwheel (bearing|hub)\b/,
    blocksReadiness: true,
    flag:
      "The vehicle must be lifted and supported. Use jack stands on level ground and never work under a vehicle held only by a jack. This is why the task cannot be marked Ready without acknowledging the risk.",
  },
  {
    id: "suspension",
    // Product policy: ordinary suspension work IS treated as safety-critical,
    // because a mis-torqued or mis-assembled suspension joint fails at speed.
    // Documented rather than silently inherited: this is why "shock absorber
    // replacement" blocks Ready, and it gets a SUSPENSION warning -- never the
    // electrical-shock one.
    pattern:
      /\bsuspensions?\b|\bstruts?\b|\bshock absorbers?\b|\bshocks\b|\bcontrol arms?\b|\bsway bar\b|\bbushings?\b/,
    blocksReadiness: true,
    flag:
      "Suspension components carry the vehicle's weight and locate the wheels; a loose or mis-torqued joint can fail at speed. Torque every fastener to spec and support the vehicle properly. This is why the task cannot be marked Ready without acknowledging the risk.",
  },
  {
    id: "steering",
    // \bsteering\b(?! wheel) so "steering wheel audio switch" is ordinary trim
    // work, while "steering rack" / "steering column" remain critical.
    pattern:
      /\bsteering (rack|gear|column|linkage|knuckle)\b|\btie rods?\b|\btie rod ends?\b|\bball joints?\b|\bsteering\b(?! wheel)/,
    blocksReadiness: true,
    flag:
      "Steering components and the joints that locate a wheel carry vehicle-control loads; failure means loss of control. Torque to spec, fit new cotter pins or lock nuts, and have the alignment checked before driving. This is why the task cannot be marked Ready without acknowledging the risk.",
  },
  {
    id: "spring",
    // Stored mechanical energy. Requires a spring CONTEXT -- "spring-loaded
    // clip" is a trim fastener, not a compressed suspension spring.
    pattern: /\b(coil|leaf|valve|strut) springs?\b|\bspring compressor\b|\bsprings\b/,
    blocksReadiness: true,
    flag:
      "Compressed springs store enough energy to cause severe injury if released suddenly. Use a proper spring compressor and keep out of the line of release. This is why the task cannot be marked Ready without acknowledging the risk.",
  },
  {
    id: "srs",
    pattern: /\bair ?bags?\b|\bsrs\b|\bpretensioners?\b|\bclock ?spring\b|\binflators?\b/,
    blocksReadiness: true,
    flag:
      "SRS/airbag components can deploy unexpectedly and cause serious injury. Disconnect the battery and wait at least 90 seconds before working near them, and never strike or apply power to an inflator. This is why the task cannot be marked Ready without acknowledging the risk.",
  },
  {
    id: "cooling",
    // Requires a cooling CONTEXT: "radiator support panel" is body work, and a
    // bare "cooling" mention is not by itself a pressurized-system hazard.
    pattern:
      /\bcoolants?\b|\bradiators?\b(?! support)|\bthermostats?\b|\boverheat(ing|ed|s)?\b|\bwater pump\b|\bcooling system\b|\bheater core\b/,
    blocksReadiness: true,
    flag:
      "A hot cooling system is pressurized and can spray scalding coolant. Let the engine cool fully before opening any cap or hose. This is why the task cannot be marked Ready without acknowledging the risk.",
  },
];

function matchingRules(text) {
  const lowered = String(text || "").toLowerCase();

  return SAFETY_RULES.filter((rule) => rule.pattern.test(lowered));
}

/**
 * Warning strings for a task description. Order follows SAFETY_RULES, so output
 * is deterministic.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function detectSafetyFlags(text) {
  return matchingRules(text).map((rule) => rule.flag);
}

/**
 * Whether this task blocks a "Ready" rating.
 *
 * Reads the SAME rule table as detectSafetyFlags, so a task can never be
 * blocked without also being told why.
 *
 * @param {{ title?: string, system?: string } | null | undefined} task
 * @returns {boolean}
 */
export function isSafetyCriticalTask(task) {
  const haystack = `${task?.title || ""} ${task?.system || ""}`;

  return matchingRules(haystack).some((rule) => rule.blocksReadiness);
}

/**
 * Rule ids that matched. Exported as an internal testing/diagnostic seam -- it
 * is not part of the HTTP API or any stable public contract.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function matchedSafetyRuleIds(text) {
  return matchingRules(text).map((rule) => rule.id);
}
