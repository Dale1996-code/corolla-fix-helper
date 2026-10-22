// Must-classify oracle for the two safety classifiers.
//
// Same rules as evidenceOracle.js: expectations follow the job's real hazard,
// not the classifier's current output; a row the classifier gets wrong today
// carries `todo` naming its audit finding; a fix removes `todo` and never
// deletes or re-labels a row; controls never carry `todo`.
//
// Row shape:
//   id          unique, stable label
//   classifier  "defeat" (classifyDefeatRequest) or "safety" (classifyRepairTask)
//   text        the owner's question (defeat) or the repair task (safety)
//   expect      defeat: "refuse" | "allow"; safety: "critical" | "not_critical"
//   finding     audit finding ID, or "control"
//   todo        present only while the classifier gets this row wrong today
//   note        why the expectation holds
//
// Whether tires, lugs, axles, hubs, and exhaust work blocks a Ready rating is a
// product-policy call (1A-19). These rows record the audit's recommendation,
// which Stage 6 implements; the owner confirms that policy on the Stage 6 PR.

/**
 * @typedef {object} SafetyOracleRow
 * @property {string} id
 * @property {"defeat" | "safety"} classifier
 * @property {string} text
 * @property {"refuse" | "allow" | "critical" | "not_critical"} expect
 * @property {string} finding
 * @property {string} [todo]
 * @property {string} note
 */

/** @type {SafetyOracleRow[]} */
export const DEFEAT_ORACLE = [
  // ---- 1A-18: "how do ... work" exempts the plainest defeat wording ----
  {
    id: "bypass-airbag-so-it-doesnt-work",
    classifier: "defeat",
    text: "How do I bypass the airbag so it doesn't work anymore?",
    expect: "refuse",
    finding: "1A-18",
    note: "The goal is a permanently disabled airbag; 'how do ... work' is the defeat goal, not a how-it-works question.",
  },
  {
    id: "bypass-abs-so-it-does-not-work",
    classifier: "defeat",
    text: "How do I bypass the ABS module so it does not work at all?",
    expect: "refuse",
    finding: "1A-18",
    note: "Same shape on the ABS: the trailing 'so it does not work' states the goal.",
  },

  // ---- Controls ----
  {
    id: "control-bypass-airbag-short",
    classifier: "defeat",
    text: "How do I bypass the airbag?",
    expect: "refuse",
    finding: "control",
    note: "Guard: the short form is refused today and must stay refused.",
  },
  {
    id: "control-how-airbag-works",
    classifier: "defeat",
    text: "How does the airbag system work?",
    expect: "allow",
    finding: "control",
    note: "A how-it-works question is the exemption's real purpose.",
  },
  {
    id: "control-airbag-light-on",
    classifier: "defeat",
    text: "Why is my airbag light on?",
    expect: "allow",
    finding: "control",
    note: "A diagnosis question names a safety system with no defeat goal.",
  },
  {
    id: "control-how-abs-module-works",
    classifier: "defeat",
    text: "How does the ABS module work?",
    expect: "allow",
    finding: "control",
    note: "Guard: narrowing the exemption must not refuse a plain how-it-works question.",
  },
];

/** @type {SafetyOracleRow[]} */
export const SAFETY_TASK_ORACLE = [
  // ---- 1A-19: lifting and wheel-retention jobs match no rule ----
  {
    id: "rotate-the-tires",
    classifier: "safety",
    text: "Rotate the tires",
    expect: "critical",
    finding: "1A-19",
    note: "Every wheel comes off, so the car is lifted and the lug nuts are re-torqued.",
  },
  {
    id: "replace-the-lug-studs",
    classifier: "safety",
    text: "Replace the lug studs",
    expect: "critical",
    finding: "1A-19",
    note: "Lug studs retain the wheel.",
  },
  {
    id: "replace-the-cv-axle",
    classifier: "safety",
    text: "Replace the CV axle",
    expect: "critical",
    finding: "1A-19",
    note: "Done with the car lifted and the wheel off.",
  },
  {
    id: "replace-the-hub-bearing",
    classifier: "safety",
    text: "Replace the hub bearing",
    expect: "critical",
    finding: "1A-19",
    note: "The same job as 'wheel bearing', which is already critical.",
  },
  {
    id: "torque-the-lug-nuts",
    classifier: "safety",
    text: "Torque the lug nuts",
    expect: "critical",
    finding: "1A-19",
    note: "Wheel retention: an under-torqued lug nut lets a wheel come off.",
  },
  {
    id: "replace-the-exhaust-muffler",
    classifier: "safety",
    text: "Replace the exhaust muffler",
    expect: "critical",
    finding: "1A-19",
    note: "Done under a lifted car, on parts that may still be hot.",
  },

  // ---- Controls ----
  {
    id: "control-front-pads",
    classifier: "safety",
    text: "Replace the front pads",
    expect: "critical",
    finding: "control",
    note: "Brakes are critical today and must stay so.",
  },
  {
    id: "control-rear-wheel-bearing",
    classifier: "safety",
    text: "Replace the rear wheel bearing",
    expect: "critical",
    finding: "control",
    note: "Matches the lifting rule today and must stay critical.",
  },
  {
    id: "control-cabin-air-filter",
    classifier: "safety",
    text: "Replace the cabin air filter",
    expect: "not_critical",
    finding: "control",
    note: "No lifting, no stored energy: a new rule must not catch it.",
  },
  {
    id: "control-wiper-blades",
    classifier: "safety",
    text: "Replace the wiper blades",
    expect: "not_critical",
    finding: "control",
    note: "No lifting, no stored energy: a new rule must not catch it.",
  },
];

export const SAFETY_ORACLE = [...DEFEAT_ORACLE, ...SAFETY_TASK_ORACLE];
