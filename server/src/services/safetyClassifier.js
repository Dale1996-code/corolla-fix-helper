// Safety classification for repair tasks.
//
// Extracted from agent/repairTools.js so the two halves of the rubric live side
// by side and can be audited together. They had drifted apart while colocated
// with the tool executors:
//   - "airbag" was safety-critical but produced NO safety flag at all, so an SRS
//     task rendered with an empty warning list.
//   - "ball joint", "spring", and "steering" had the same gap.
//   - Cooling work produced a burn warning but was NOT safety-critical, so it
//     could be marked Ready without the shop-referral path the flag implies.
//
// A leaf module: it imports nothing, so anything may use it.

// Work that can injure a beginner (or others on the road) if done wrong. A task
// touching any of these is "safety critical": it cannot be marked Ready and is
// recommended to a shop, unless the owner explicitly acknowledges the risk.
//
// Matching is substring-based and deliberately over-inclusive: a false positive
// costs an unnecessary shop referral, a false negative can cost a beginner an
// injury.
export const SAFETY_CRITICAL_KEYWORDS = [
  "brake",
  "rotor",
  "caliper",
  "master cylinder",
  "fuel",
  "injector",
  "gas tank",
  "electrical",
  "wiring",
  "battery",
  "alternator",
  "starter",
  "lift",
  "lifting",
  "jack",
  "suspension",
  "strut",
  "shock",
  "control arm",
  "ball joint",
  "spring",
  "airbag",
  "steering",
  // Cooling work already produced a scalding warning in detectSafetyFlags but
  // was missing here, so a task that warns "never open a hot cooling system"
  // could still be marked Ready. A pressurized 100 C system is a burn risk.
  "coolant",
  "radiator",
  "thermostat",
];

/**
 * @param {{ title?: string, system?: string } | null | undefined} task
 * @returns {boolean}
 */
export function isSafetyCriticalTask(task) {
  const haystack = `${task?.title || ""} ${task?.system || ""}`.toLowerCase();
  return SAFETY_CRITICAL_KEYWORDS.some((keyword) => haystack.includes(keyword));
}

// One rule per hazard class. Kept as data so the set is inspectable and every
// rule can be exercised by a table-driven test.
export const SAFETY_FLAG_RULES = [
  {
    id: "brakes",
    pattern: /(brake|abs|caliper|rotor|master cylinder)/,
    flag: "Brake work affects stopping safety. Bleed and test before driving.",
  },
  {
    id: "fuel",
    pattern: /(fuel|injector|gas tank)/,
    flag: "Fuel system work is a fire hazard. Relieve pressure and avoid sparks.",
  },
  {
    id: "electrical",
    pattern: /(battery|alternator|wiring|electrical|starter)/,
    flag: "Disconnect the battery before electrical work.",
  },
  {
    id: "lifting",
    // "shock" was safety-critical but matched no rule, so a shock-absorber task
    // blocked Ready while showing the owner no reason why.
    pattern: /(jack|lift|wheel|suspension|strut|shock|control arm|ball joint)/,
    flag: "Use jack stands. Never work under a vehicle held only by a jack.",
  },
  {
    id: "cooling",
    pattern: /(coolant|radiator|thermostat|overheat)/,
    flag: "Never open a hot cooling system. Let it cool to avoid burns.",
  },
  // ---- Rules below close gaps found auditing this against SAFETY_CRITICAL_KEYWORDS ----
  {
    id: "srs",
    // "airbag" was listed as safety-critical but had no flag, so the most
    // dangerous system in the car rendered with no warning text.
    pattern: /(airbag|air bag|\bsrs\b|pretensioner|clock ?spring)/,
    flag:
      "SRS/airbag components can deploy unexpectedly and cause serious injury. Disconnect the battery and wait at least 90 seconds before working near them, and never strike or apply power to an inflator. This is shop work unless you have SRS experience.",
  },
  {
    id: "steering",
    // Steering and the joints that locate a wheel: failure here is loss of
    // control, not just a leak. ("steering rack" needs no alternative of its
    // own -- "steering" already matches it.)
    pattern: /(steering|tie rod|ball joint|knuckle)/,
    flag:
      "Steering and suspension joints carry vehicle control loads. Torque every fastener to spec, fit new cotter pins or lock nuts, and have the alignment checked before driving.",
  },
  {
    id: "spring",
    // Stored mechanical energy. A compressed coil spring released uncontrolled
    // is one of the classic ways a DIY repair maims someone, so match a bare
    // "spring" too -- on this vehicle that is a coil or valve spring either way.
    // The lookbehind excludes an SRS clock spring, which is a different hazard
    // and is already covered by the srs rule above.
    pattern: /(?<!clock ?)\bsprings?\b/,
    flag:
      "Compressed springs store enough energy to cause severe injury. Use a proper spring compressor, keep your body out of the line of release, and do not improvise.",
  },
];

/**
 * Warning strings for a task description. Order follows SAFETY_FLAG_RULES so
 * output is deterministic.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function detectSafetyFlags(text) {
  const lowered = String(text || "").toLowerCase();

  return SAFETY_FLAG_RULES.filter((rule) => rule.pattern.test(lowered)).map((rule) => rule.flag);
}
