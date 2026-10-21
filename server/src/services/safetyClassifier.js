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
 * @property {string | null} system  System this hazard implies, or null when the
 *                                   hazard says nothing about which system the
 *                                   work belongs to (lifting, springs).
 * @property {string} hazard       Short hazard-category label, used to say WHY
 *                                 readiness is blocked.
 * @property {RegExp} pattern      Matched against the lowercased task text.
 * @property {boolean} blocksReadiness  Whether a match blocks a "Ready" rating.
 * @property {string} flag         Warning shown to the owner. When the rule
 *                                 blocks readiness the text must say why.
 */

// Brake friction parts named without the word "brake".
//
// "brake pads" was already covered; a bare "front pads" or "swap the pads" was
// NOT, so a real brake job scored Ready with no safety flag. A global \bpads?\b
// would fix that and re-introduce exactly the substring problem the \babs\b
// comment above warns about -- it mis-files seat pads, pedal pads, jack pads,
// and polishing pads as brake work.
//
// Instead the cue requires context immediately around the noun:
//   - a positional qualifier directly before it ("front pads", "rear shoes"), or
//   - a repair verb before it, with only determiners in between
//     ("replace the pads", "swap out the worn pads").
//
// Requiring adjacency is what excludes the unrelated pads: in "front seat pads"
// and "replace the polishing pads" another noun sits between the qualifier and
// "pads", so neither cue fires. Anything with a real brake noun elsewhere
// ("pads and rotor", "pads on the drum") is already matched by the brake, rotor,
// caliper, and drum alternatives, so no whole-string context scan is needed.
const BRAKE_POSITION = "front|rear|left|right|inner|outer|driver|passenger";
const BRAKE_SERVICE_VERB = "replace|swap|change|install|inspect|check|measure";
const BRAKE_DETERMINER = `the|my|both|all|two|four|out|worn|old|new|${BRAKE_POSITION}`;
const BRAKE_FRICTION_NOUN = "pads?|shoes?";

const BRAKE_FRICTION_CUE = [
  `\\b(?:${BRAKE_POSITION})\\s+(?:${BRAKE_FRICTION_NOUN})\\b`,
  `\\b(?:${BRAKE_SERVICE_VERB})\\s+(?:(?:${BRAKE_DETERMINER})\\s+)*(?:${BRAKE_FRICTION_NOUN})\\b`,
].join("|");

// Tires coming off: the car is lifted, and every lug nut goes back on.
//
// A bare \btires?\b would make "check the tire pressure" and "inspect the tire
// tread" lifting jobs. Same approach as BRAKE_FRICTION_CUE: a removal or
// rotation verb with only determiners before the noun, a service noun after it
// ("tire rotation"), or a spare or flat tire, which is only ever put on or taken
// off. Inspection verbs are deliberately absent -- looking at a tire is not
// taking it off.
const TIRE_NOUN = "tires?|tyres?";
const TIRE_SERVICE_VERB =
  "rotate|rotating|remove|removing|replace|replacing|swap|swapping|change|changing|install|installing|mount|mounting|dismount|dismounting|take off|taking off|put on|putting on";
const TIRE_DETERMINER = `the|my|a|an|both|all|two|four|new|old|worn|winter|summer|snow|${BRAKE_POSITION}`;

const TIRE_SERVICE_CUE = [
  `\\b(?:${TIRE_SERVICE_VERB})\\s+(?:(?:${TIRE_DETERMINER})\\s+)*(?:${TIRE_NOUN})\\b`,
  `\\b(?:${TIRE_NOUN})\\s+(?:rotation|removal|change|swap|replacement|installation)\\b`,
  `\\b(?:spare|flat)\\s+(?:${TIRE_NOUN})\\b`,
].join("|");

// Exhaust-system parts. "exhaust" alone is not enough: this engine's manuals
// say "exhaust camshaft", "exhaust valve", and "exhaust VVT" far more often than
// "muffler", and none of those is a hot pipe under the car.
const EXHAUST_PART =
  "systems?|pipes?|manifolds?|leaks?|hangers?|gaskets?|flanges?|clamps?|heat shields?|resonators?|tips?|fumes|work|repairs?";
const ENGINE_EXHAUST_WORD = "cam\\w*|valves?|vvt\\w*|ports?|strokes?|gas|side";

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
    system: "Brakes",
    hazard: "brake system",
    // \babs\b, not a bare "abs" substring: the old rule fired on "shock absorber".
    // \bdrums?\b is safe standalone -- on this vehicle a "drum" is always a brake
    // drum. "pads"/"shoes" are not, hence BRAKE_FRICTION_CUE.
    pattern: new RegExp(
      [
        "\\bbrakes?\\b",
        "\\bbraking\\b",
        "\\babs\\b",
        "\\bcalipers?\\b",
        "\\brotors?\\b",
        "\\bdrums?\\b",
        "\\bmaster cylinder\\b",
        "\\bbrake booster\\b",
        "\\bbrake (line|fluid|pads?|shoes?)\\b",
        BRAKE_FRICTION_CUE,
      ].join("|")
    ),
    blocksReadiness: true,
    flag:
      "Brake work affects stopping safety. Bleed the system and test at low speed before driving. This is why the task cannot be marked Ready without acknowledging the risk.",
  },
  {
    id: "fuel",
    system: "Fuel",
    hazard: "fuel system",
    pattern: /\bfuel\b|\binjectors?\b|\bgas tank\b|\bfuel (line|rail|pump|filter)\b/,
    blocksReadiness: true,
    flag:
      "Fuel system work is a fire hazard. Relieve fuel pressure, work away from ignition sources, and keep an extinguisher nearby. This is why the task cannot be marked Ready without acknowledging the risk.",
  },
  {
    id: "electrical",
    system: "Electrical",
    hazard: "electrical system",
    // "electrical shock" belongs here, NOT with suspension shocks.
    pattern:
      /\bbatter(y|ies)\b|\balternators?\b|\bwiring\b|\bwiring harness\b|\belectrical\b|\bstarter\b|\belectric(al)? shock\b|\bshock hazard\b/,
    blocksReadiness: true,
    flag:
      "Disconnect the battery before electrical work to avoid shorts, burns, and shock. This is why the task cannot be marked Ready without acknowledging the risk.",
  },
  {
    id: "lifting",
    system: null,
    hazard: "vehicle lifting",
    // Only lifting THE VEHICLE. "valve lift" is a measurement, not a hazard,
    // and a "steering wheel" is not a road wheel that implies the car is up on
    // stands -- hence the lookbehinds rather than a bare \bwheels?\b.
    //
    // Tire, CV axle, and hub jobs are done with the car up and the wheel off
    // (audit 1A-19). A hub needs a bearing, assembly, or position beside it, so
    // a USB hub and a hub cap are not a road wheel's hub; "axle" cannot match
    // inside "transaxle".
    pattern: new RegExp(
      [
        "\\bjacks?\\b",
        "\\bjacking\\b",
        "\\bjack stands?\\b",
        "\\b(lift|lifting|raise|raising|support|supporting)( the)? (vehicle|car)\\b",
        "\\bunder the (vehicle|car)\\b",
        "\\b(?<!steering )wheels?\\b",
        "(?<!steering )\\bwheel (bearing|hub)\\b",
        TIRE_SERVICE_CUE,
        "\\baxles?\\b",
        "\\bcv[ -]?(?:joints?|boots?)\\b",
        "\\b(?:drive|half)[ -]?shafts?\\b",
        "(?<!steering wheel )\\bhub (?:bearings?|assembl(?:y|ies)|units?|nuts?)\\b",
        "\\b(?:axle|front|rear) hubs?\\b(?![ -]?caps?)",
      ].join("|")
    ),
    blocksReadiness: true,
    flag:
      "The vehicle must be lifted and supported. Use jack stands on level ground and never work under a vehicle held only by a jack. This is why the task cannot be marked Ready without acknowledging the risk.",
  },
  {
    id: "wheel-retention",
    system: null,
    hazard: "wheel retention",
    // The fasteners that hold a road wheel on, plus the jobs whose whole point
    // is taking wheels off and putting them back. "wheel nut" excludes the
    // steering wheel's retaining nut, and a bare "lug" is not enough: battery
    // terminals and ground straps have lugs too.
    //
    // No lifting cue for the fasteners themselves: final lug-nut torque is done
    // with the car back on the ground.
    pattern: new RegExp(
      [
        "\\blug (?:nuts?|studs?|bolts?)\\b",
        "(?<!steering )\\bwheel (?:nuts?|studs?|bolts?|locks?)\\b",
        "(?<!steering )\\bwheel (?:rotation|removal|swap|change)\\b",
        "\\brotat(?:e|es|ed|ing) (?:(?:the|all|four|my) )*wheels\\b",
        TIRE_SERVICE_CUE,
      ].join("|")
    ),
    blocksReadiness: true,
    flag:
      "Lug nuts and studs are all that hold a wheel on; an under-torqued, over-torqued, or cross-threaded one can let a wheel come off while driving. Support the car on jack stands while a wheel is off, tighten the lug nuts in a star pattern to the specified torque with a torque wrench, and re-check them after a short drive. This is why the task cannot be marked Ready without acknowledging the risk.",
  },
  {
    id: "suspension",
    system: "Suspension",
    hazard: "suspension",
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
    system: "Suspension",
    hazard: "steering and wheel-locating joints",
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
    system: null,
    hazard: "stored spring energy",
    // Stored mechanical energy. Requires a spring CONTEXT -- "spring-loaded
    // clip" is a trim fastener, not a compressed suspension spring.
    pattern: /\b(coil|leaf|valve|strut) springs?\b|\bspring compressor\b|\bsprings\b/,
    blocksReadiness: true,
    flag:
      "Compressed springs store enough energy to cause severe injury if released suddenly. Use a proper spring compressor and keep out of the line of release. This is why the task cannot be marked Ready without acknowledging the risk.",
  },
  {
    id: "srs",
    system: "Restraints",
    hazard: "SRS/airbag",
    pattern: /\bair ?bags?\b|\bsrs\b|\bpretensioners?\b|\bclock ?spring\b|\binflators?\b/,
    blocksReadiness: true,
    flag:
      "SRS/airbag components can deploy unexpectedly and cause serious injury. Disconnect the battery and wait at least 90 seconds before working near them, and never strike or apply power to an inflator. This is why the task cannot be marked Ready without acknowledging the risk.",
  },
  {
    id: "cooling",
    system: "Cooling",
    hazard: "pressurized cooling system",
    // Requires a cooling CONTEXT: "radiator support panel" is body work, and a
    // bare "cooling" mention is not by itself a pressurized-system hazard.
    pattern:
      /\bcoolants?\b|\bradiators?\b(?! support)|\bthermostats?\b|\boverheat(ing|ed|s)?\b|\bwater pump\b|\bcooling system\b|\bheater core\b/,
    blocksReadiness: true,
    flag:
      "A hot cooling system is pressurized and can spray scalding coolant. Let the engine cool fully before opening any cap or hose. This is why the task cannot be marked Ready without acknowledging the risk.",
  },
  {
    id: "exhaust",
    system: null,
    hazard: "hot exhaust under the car",
    // Parts of the exhaust system only; see EXHAUST_PART. "the exhaust" alone
    // counts unless an engine-internal word follows it, and "exhausted" never
    // matches \bexhaust\b. A resonator needs the word "exhaust" in front of it:
    // this engine's air intake has one too.
    pattern: new RegExp(
      [
        `\\bexhaust (?:${EXHAUST_PART})\\b`,
        `\\bthe exhaust\\b(?! (?:${ENGINE_EXHAUST_WORD})\\b)`,
        "\\bmufflers?\\b",
        "\\b(?:catalytic|cat) converters?\\b",
        "\\btail ?pipes?\\b",
      ].join("|")
    ),
    blocksReadiness: true,
    flag:
      "Exhaust parts get hot enough to burn within minutes of the engine running, and most exhaust work is done under a raised car. Let the exhaust cool fully, support the car on jack stands, and wear eye protection against falling rust. An exhaust leak can let carbon monoxide into the cabin, so check for leaks before driving. This is why the task cannot be marked Ready without acknowledging the risk.",
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

/**
 * THE single classification entry point for the repair planner.
 *
 * Every downstream answer -- detected system, safety-critical status, warning
 * flags, and the readiness-blocking reason -- comes from this one evaluation, so
 * the planner cannot mark a task Shop Recommended while showing no warning, or
 * warn about a hazard the readiness check ignored.
 *
 * When a hazard rule matches, its `system` is authoritative: "diagnose engine
 * overheating" is Cooling work even though the word "engine" appears. Rules with
 * a null system (lifting, springs) contribute a hazard but do not name a system,
 * so a generic fallback still applies.
 *
 * @param {string} text
 * @param {{ fallbackSystem?: string }} [options]
 * @returns {{
 *   system: string | null,
 *   safetyCritical: boolean,
 *   flags: string[],
 *   ruleIds: string[],
 *   hazards: string[],
 *   blockingReason: string,
 * }}
 */
export function classifyRepairTask(text, { fallbackSystem = null } = {}) {
  const rules = matchingRules(text);
  const blocking = rules.filter((rule) => rule.blocksReadiness);
  const systemRule = rules.find((rule) => rule.system);
  const hazards = blocking.map((rule) => rule.hazard);

  return {
    system: systemRule ? systemRule.system : fallbackSystem,
    safetyCritical: blocking.length > 0,
    flags: rules.map((rule) => rule.flag),
    ruleIds: rules.map((rule) => rule.id),
    hazards,
    blockingReason: hazards.length
      ? `Safety-critical work detected (${hazards.join(", ")}). Treat the steps as preparation only and have a professional confirm the repair.`
      : "",
  };
}
