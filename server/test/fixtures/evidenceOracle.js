// Must-reject / must-accept oracle for the two evidence verifiers.
//
// Every expectation is written from what the manual MEANS, never from what the
// verifier happens to do today. Rows the verifier gets wrong today carry a
// `todo` naming the audit finding; evidenceOracle.test.js reports them as todo
// so the suite stays green while every known defect stays visible by ID.
//
// Rules for this table:
//   - A fix removes `todo` from the rows it fixes. A row is never deleted or
//     re-labelled to make a fix pass.
//   - `finding: "control"` rows are must-accept (or must-reject) guards against
//     a fix that over-corrects. A control never carries `todo`.
//   - The repository is public. Every string here is a short SYNTHETIC
//     manual-style line written for this table; never paste real manual text or
//     a captured model reply into it.
//   - No control depends on cross-unit conversion (37 N*m grounding 27 ft-lbf):
//     whether conversion stays is owner decision D1 in the 2026-10-18 plan.
//
// Row shape:
//   id        unique, stable label
//   verifier  "ask" (verifyEvidence + deriveEvidenceStatus) or
//             "planner" (verifyClaims)
//   channel   Ask: the reply channel the item arrives on ("documentSupported"
//             or "generalGuidance"). Planner: the claim `kind`.
//   chunkText the passage the model was shown (Ask chunkText / planner
//             evidenceText); null for generalGuidance, which cites nothing
//   quote     the model's evidenceQuote; null for generalGuidance
//   claim     the model's claim (for generalGuidance, the guidance line)
//   task      planner only: the task title the claim is filed under
//   itemName  planner only, required_tool / required_part claims
//   expect    "accept" or "reject"
//   finding   audit finding ID, or "control"
//   todo      present only while the verifier gets this row wrong today
//   note      why the expectation holds

/**
 * @typedef {object} EvidenceOracleRow
 * @property {string} id
 * @property {"ask" | "planner"} verifier
 * @property {string} channel
 * @property {string | null} chunkText
 * @property {string | null} quote
 * @property {string} claim
 * @property {string} [task]
 * @property {string} [itemName]
 * @property {"accept" | "reject"} expect
 * @property {string} finding
 * @property {string} [todo]
 * @property {string} note
 */

/** @type {EvidenceOracleRow[]} */
export const ASK_ORACLE = [
  // ---- 1A-01: the max(0.51, 2%) floor is applied in canonical mm and litres ----
  {
    id: "A1-runout-10x",
    verifier: "ask",
    channel: "documentSupported",
    chunkText: "Disc runout: Maximum 0.05 mm. If the runout is greater than the maximum, replace the disc.",
    quote: "Disc runout: Maximum 0.05 mm",
    claim: "The maximum disc runout is 0.5 mm.",
    expect: "reject",
    finding: "1A-01",
    note: "0.5 mm is ten times the printed 0.05 mm limit.",
  },
  {
    id: "A2-pad-minimum-halved",
    verifier: "ask",
    channel: "documentSupported",
    chunkText: "Minimum brake pad thickness 1.0 mm. Replace the pads if less than the minimum.",
    quote: "Minimum brake pad thickness 1.0 mm",
    claim: "The minimum brake pad thickness is 0.5 mm.",
    expect: "reject",
    finding: "1A-01",
    note: "Half the printed minimum pad thickness.",
  },
  {
    id: "A3-spark-plug-gap",
    verifier: "ask",
    channel: "documentSupported",
    chunkText: "Spark plug electrode gap 1.0 to 1.1 mm.",
    quote: "Spark plug electrode gap 1.0 to 1.1 mm",
    claim: "The spark plug electrode gap is 1.6 mm.",
    expect: "reject",
    finding: "1A-01",
    note: "1.6 mm is outside the printed 1.0 to 1.1 mm range.",
  },
  {
    id: "A4-oil-capacity-plus-half-litre",
    verifier: "ask",
    channel: "documentSupported",
    chunkText: "Engine oil capacity (with oil filter change) 4.2 liters.",
    quote: "Engine oil capacity (with oil filter change) 4.2 liters",
    claim: "The engine oil capacity is 4.7 liters.",
    expect: "reject",
    finding: "1A-01",
    note: "Half a litre over the printed capacity overfills the engine.",
  },
  {
    id: "A5-valve-clearance-tripled",
    verifier: "ask",
    channel: "documentSupported",
    chunkText: "Intake valve clearance (cold) 0.19 to 0.29 mm.",
    quote: "Intake valve clearance (cold) 0.19 to 0.29 mm",
    claim: "The intake valve clearance is 0.75 mm.",
    expect: "reject",
    finding: "1A-01",
    note: "0.75 mm is far outside the printed 0.19 to 0.29 mm range.",
  },
  {
    id: "A6-torque-two-over",
    verifier: "ask",
    channel: "documentSupported",
    chunkText: "Oil pan drain plug torque 37 N*m (377 kgf*cm, 27 ft.*lbf).",
    quote: "Oil pan drain plug torque 37 N*m",
    claim: "The oil pan drain plug torque is 39 N*m.",
    expect: "reject",
    finding: "1A-01",
    note: "Guard: the floor is harmless at 37 N*m, and a fix must keep rejecting 39.",
  },

  // ---- 1A-02: a thousands separator is read as a decimal point ----
  {
    id: "B1-compression-1000-vs-1500",
    verifier: "ask",
    channel: "documentSupported",
    chunkText: "Compression pressure: Standard 1,500 kPa (15.3 kgf/cm2, 218 psi) at 250 rpm.",
    quote: "Compression pressure: Standard 1,500 kPa",
    claim: "The compression pressure is 1,000 kPa.",
    expect: "reject",
    finding: "1A-02",
    note: "1,000 and 1,500 differ by a third; parsed as 1.0 and 1.5 they look close.",
  },
  {
    id: "B2-fast-idle-1900-vs-1500",
    verifier: "ask",
    channel: "documentSupported",
    chunkText: "Fast idle speed 1,500 rpm with the engine cold.",
    quote: "Fast idle speed 1,500 rpm",
    claim: "The fast idle speed is 1,900 rpm.",
    expect: "reject",
    finding: "1A-02",
    note: "1,900 rpm is not the printed 1,500 rpm.",
  },
  {
    id: "B3-fast-idle-without-separator",
    verifier: "ask",
    channel: "documentSupported",
    chunkText: "Fast idle speed 1,500 rpm with the engine cold.",
    quote: "Fast idle speed 1,500 rpm",
    claim: "The fast idle speed is 1500 rpm.",
    expect: "accept",
    finding: "1A-02",
    note: "False rejection: 1500 is the printed 1,500 written without a separator.",
  },

  // ---- 1A-03: no number boundary in quotes; the bare-number fallback takes any number ----
  {
    id: "C1-step-number-grounds-torque",
    verifier: "ask",
    channel: "documentSupported",
    chunkText: "Tighten the bolts in the sequence shown, from 1 to 10.",
    quote: "Tighten the bolts in the sequence shown, from 1 to 10",
    claim: "Tighten the bolts to 10 N*m.",
    expect: "reject",
    finding: "1A-03",
    note: "The 10 is a step number, not a torque.",
  },
  {
    id: "C2-quote-cut-mid-number",
    verifier: "ask",
    channel: "documentSupported",
    chunkText: "Wheel lug nut torque 103 N*m (1,050 kgf*cm, 76 ft.*lbf).",
    quote: "Wheel lug nut torque 10",
    claim: "The wheel lug nut torque is 10 N*m.",
    expect: "reject",
    finding: "1A-03",
    note: "The quote stops inside 103, so it is not a quote of anything the page says.",
  },
  {
    id: "C3-quote-starts-mid-number",
    verifier: "ask",
    channel: "documentSupported",
    chunkText: "Apply 25 N*m to the oil filter cap.",
    quote: "5 N*m to the oil filter cap",
    claim: "The oil filter cap torque is 5 N*m.",
    expect: "reject",
    finding: "1A-03",
    note: "The quote starts inside 25.",
  },

  // ---- 1A-04: unrecognized units skip the numeric and subject checks ----
  {
    id: "D1-inches",
    verifier: "ask",
    channel: "documentSupported",
    chunkText: "Front disc minimum thickness 23.0 mm (0.906 in.).",
    quote: "Front disc minimum thickness 23.0 mm (0.906 in.)",
    claim: "The front disc minimum thickness is 0.800 in.",
    expect: "reject",
    finding: "1A-04",
    note: "Inches are not detected, so 0.800 is never compared with 0.906.",
  },
  {
    id: "D2-kgf-per-cm2-ascii",
    verifier: "ask",
    channel: "documentSupported",
    chunkText: "Fuel pressure 304 to 343 kPa (3.1 to 3.5 kgf/cm2, 44 to 50 psi).",
    quote: "Fuel pressure 304 to 343 kPa (3.1 to 3.5 kgf/cm2",
    claim: "The fuel pressure is 5.5 kgf/cm2.",
    expect: "reject",
    finding: "1A-04",
    note: "The trailing ASCII 2 defeats the unit's word boundary.",
  },
  {
    id: "D3-miles-interval",
    verifier: "ask",
    channel: "documentSupported",
    chunkText: "Replace the engine coolant at the first 100,000 miles.",
    quote: "Replace the engine coolant at the first 100,000 miles",
    claim: "Replace the engine coolant every 30,000 miles.",
    expect: "reject",
    finding: "1A-04",
    note: "Miles are not detected, so 30,000 is never compared with 100,000.",
  },
  {
    id: "D4-angle-torque",
    verifier: "ask",
    channel: "documentSupported",
    chunkText: "Tighten the cylinder head bolts an additional 90° in the order shown.",
    quote: "Tighten the cylinder head bolts an additional 90°",
    claim: "Tighten the cylinder head bolts an additional 180°.",
    expect: "reject",
    finding: "1A-04",
    note: "An angle without C or F is not detected; 180° doubles the printed turn.",
  },

  // ---- 1A-04, the boundary itself: a figure in an unlisted unit fails closed ----
  // Added with the fix (Stage 2). Whatever the vocabulary lists, the next unit it
  // misses must not mean "nothing to check".
  {
    id: "E1-unlisted-unit-wait-time",
    verifier: "ask",
    channel: "documentSupported",
    chunkText: "Wait at least 90 seconds after disconnecting the cable from the negative battery terminal.",
    quote: "Wait at least 90 seconds after disconnecting the cable from the negative battery terminal",
    claim: "Wait 30 seconds after disconnecting the negative battery cable.",
    expect: "reject",
    finding: "1A-04",
    note: "Seconds are not a detected unit; 30 is not the printed 90, and the wait protects the airbag.",
  },
  {
    id: "E2-unlisted-count",
    verifier: "ask",
    channel: "documentSupported",
    chunkText: "Remove the 4 bolts and the cylinder head cover.",
    quote: "Remove the 4 bolts and the cylinder head cover",
    claim: "Remove the 6 bolts and the cylinder head cover.",
    expect: "reject",
    finding: "1A-04",
    note: "A count is a figure the code cannot read; 6 is not printed.",
  },
  {
    id: "control-count-printed",
    verifier: "ask",
    channel: "documentSupported",
    chunkText: "Remove the 4 bolts and the cylinder head cover.",
    quote: "Remove the 4 bolts and the cylinder head cover",
    claim: "Remove the 4 bolts and the cylinder head cover.",
    expect: "accept",
    finding: "control",
    note: "An unlisted figure the quote prints passes.",
  },
  {
    id: "control-engine-designation-is-a-name",
    verifier: "ask",
    channel: "documentSupported",
    chunkText: "Oil pan drain plug torque 37 N*m (377 kgf*cm, 27 ft.*lbf).",
    quote: "Oil pan drain plug torque 37 N*m",
    claim: "For the 2009 Corolla L4 1.8L 2ZR-FE, the oil pan drain plug torque is 37 N*m.",
    expect: "accept",
    finding: "control",
    note: "The vehicle descriptor's 1.8L names the engine; it is not a 1.8-litre capacity.",
  },
  {
    id: "control-identifiers-are-names",
    verifier: "ask",
    channel: "documentSupported",
    chunkText: "Install spark plug 90919-01253 on the 2ZR-FE engine. Check terminals B9-1 and B9-2.",
    quote: "Install spark plug 90919-01253 on the 2ZR-FE engine",
    claim: "On the 2009 2ZR-FE engine, install spark plug 90919-01253.",
    expect: "accept",
    finding: "control",
    note: "A model year, an engine code, and a part number name things; they are not figures.",
  },

  // ---- 3B-01: the commonest torque and capacity spellings are not detected ----
  {
    id: "3B01-lug-nut-ft-lbs",
    verifier: "ask",
    channel: "documentSupported",
    chunkText: "Wheel lug nut torque 103 N*m (1,050 kgf*cm, 76 ft.*lbf).",
    quote: "Wheel lug nut torque 103 N*m",
    claim: "The wheel lug nut torque is 50 ft-lbs.",
    expect: "reject",
    finding: "3B-01",
    note: "ft-lbs is not detected; 50 ft-lbs is about two thirds of the printed 76 ft-lbf.",
  },
  {
    id: "3B01-oil-capacity-bare-L",
    verifier: "ask",
    channel: "documentSupported",
    chunkText: "Engine oil capacity with oil filter change 4.2 L.",
    quote: "Engine oil capacity with oil filter change 4.2 L",
    claim: "The engine oil capacity with oil filter change is 5.5 L.",
    expect: "reject",
    finding: "3B-01",
    note: "A bare L is not detected; 5.5 L overfills the engine.",
  },
  {
    id: "3B01-oil-capacity-qts",
    verifier: "ask",
    channel: "documentSupported",
    chunkText: "Engine oil capacity with oil filter change 4.2 liters.",
    quote: "Engine oil capacity with oil filter change 4.2 liters",
    claim: "The engine oil capacity with oil filter change is 5.5 qts.",
    expect: "reject",
    finding: "3B-01",
    note: "qts is not detected; 5.5 qts is about 5.2 liters, not 4.2.",
  },
  {
    id: "3B01-guidance-litres-and-qts",
    verifier: "ask",
    channel: "generalGuidance",
    chunkText: null,
    quote: null,
    claim: "Refill with about 4.7 L of oil (5 qts).",
    expect: "reject",
    finding: "3B-01",
    note: "General guidance cites nothing, so any specification in it must be removed.",
  },
  {
    id: "3B01-guidance-ft-lbs",
    verifier: "ask",
    channel: "generalGuidance",
    chunkText: null,
    quote: null,
    claim: "Tighten the lug nuts to 76 ft lbs.",
    expect: "reject",
    finding: "3B-01",
    note: "An unsourced torque must not survive under the general-guidance heading.",
  },

  // ---- 1A-10: signs and range lower bounds ----
  {
    id: "G1-range-low-end-unchecked",
    verifier: "ask",
    channel: "documentSupported",
    chunkText: "Standard voltage 10.5 to 14 V.",
    quote: "Standard voltage 10.5 to 14 V",
    claim: "The standard voltage is 5 to 14 V.",
    expect: "reject",
    finding: "1A-10",
    note: "Only the number before the unit is checked, so the wrong 5 V lower bound passes.",
  },
  {
    id: "G2-range-low-end-false-rejection",
    verifier: "ask",
    channel: "documentSupported",
    chunkText: "Thermostat valve opening temperature 80 to 84 °C.",
    quote: "Thermostat valve opening temperature 80 to 84 °C",
    claim: "The thermostat valve opening temperature is 80 °C.",
    expect: "accept",
    finding: "1A-10",
    note: "False rejection: 80 °C is the printed lower end of the range.",
  },
  {
    id: "G3-sign-dropped",
    verifier: "ask",
    channel: "documentSupported",
    chunkText: "Sensor output voltage 5 V.",
    quote: "Sensor output voltage 5 V",
    claim: "The sensor output voltage is -5 V.",
    expect: "reject",
    finding: "1A-10",
    note: "-5 V is not 5 V.",
  },

  // ---- 1A-11: one-word or one-character quotes ----
  {
    id: "OK-quote-reuse-gasket",
    verifier: "ask",
    channel: "documentSupported",
    chunkText: "Inspect the gasket. If it is OK, continue. Do not reuse a damaged gasket.",
    quote: "OK",
    claim: "Yes, it is OK to reuse the gasket.",
    expect: "reject",
    finding: "1A-11",
    note: "A one-word quote cannot support a sentence, least of all one the page contradicts.",
  },
  {
    id: "one-letter-quote",
    verifier: "ask",
    channel: "documentSupported",
    chunkText: "Inspect the gasket. If it is OK, continue. Do not reuse a damaged gasket.",
    quote: " e ",
    claim: "Replace the timing chain.",
    expect: "reject",
    finding: "1A-11",
    note: "A single letter is not evidence for anything.",
  },

  // ---- 1A-13: kgf/cm² (a pressure) is filed in the torque family ----
  {
    id: "kgf-cm2-pressure-grounds-torque",
    verifier: "ask",
    channel: "documentSupported",
    chunkText: "Fuel pressure 304 kPa (3.1 kgf/cm²).",
    quote: "Fuel pressure 304 kPa (3.1 kgf/cm²)",
    claim: "The fuel pressure is 0.3 N*m.",
    expect: "reject",
    finding: "1A-13",
    note: "A pressure cannot ground a torque; 3.1 kgf/cm² is read as 3.1 kgf*cm = 0.3 N*m.",
  },

  // ---- Controls: must-accept, so a stricter fix cannot over-reject ----
  {
    id: "control-drain-plug-exact",
    verifier: "ask",
    channel: "documentSupported",
    chunkText: "Oil pan drain plug torque 37 N*m (377 kgf*cm, 27 ft.*lbf).",
    quote: "Oil pan drain plug torque 37 N*m",
    claim: "The oil pan drain plug torque is 37 N*m.",
    expect: "accept",
    finding: "control",
    note: "Exact printed value, same unit.",
  },
  {
    id: "control-runout-exact",
    verifier: "ask",
    channel: "documentSupported",
    chunkText: "Disc runout: Maximum 0.05 mm. If the runout is greater than the maximum, replace the disc.",
    quote: "Disc runout: Maximum 0.05 mm",
    claim: "The maximum disc runout is 0.05 mm.",
    expect: "accept",
    finding: "control",
    note: "Exact printed small-magnitude value.",
  },
  {
    id: "control-oil-capacity-exact",
    verifier: "ask",
    channel: "documentSupported",
    chunkText: "Engine oil capacity (with oil filter change) 4.2 liters.",
    quote: "Engine oil capacity (with oil filter change) 4.2 liters",
    claim: "The engine oil capacity is 4.2 liters.",
    expect: "accept",
    finding: "control",
    note: "Exact printed capacity.",
  },
  {
    id: "control-lug-nut-full-quote",
    verifier: "ask",
    channel: "documentSupported",
    chunkText: "Wheel lug nut torque 103 N*m (1,050 kgf*cm, 76 ft.*lbf).",
    quote: "Wheel lug nut torque 103 N*m",
    claim: "The wheel lug nut torque is 103 N*m.",
    expect: "accept",
    finding: "control",
    note: "The full value, quoted on its number boundary.",
  },
  {
    id: "control-guidance-without-spec",
    verifier: "ask",
    channel: "generalGuidance",
    chunkText: null,
    quote: null,
    claim: "Let the engine cool before you remove the drain plug.",
    expect: "accept",
    finding: "control",
    note: "Guidance with no specification stays.",
  },
  {
    id: "control-guidance-torque-removed",
    verifier: "ask",
    channel: "generalGuidance",
    chunkText: null,
    quote: null,
    claim: "Tighten the drain plug to 37 N*m.",
    expect: "reject",
    finding: "control",
    note: "Guard: a recognized unsourced torque is already removed and must stay removed.",
  },
];

/** @type {EvidenceOracleRow[]} */
export const PLANNER_ORACLE = [
  // ---- 1A-05: a claim may be any substring of its quote ----
  {
    id: "P1a-negation-dropped",
    verifier: "planner",
    channel: "safety_instruction",
    chunkText: "Do not apply grease to the friction surface of the brake pads.",
    quote: "Do not apply grease to the friction surface of the brake pads",
    claim: "apply grease to the friction surface of the brake pads",
    task: "Replace the front brake pads",
    expect: "reject",
    finding: "1A-05",
    note: "Dropping 'Do not' inverts a safety instruction.",
  },
  {
    id: "P1b-never-dropped",
    verifier: "planner",
    channel: "procedure",
    chunkText: "Never reuse the drain plug gasket. Always replace it with a new one.",
    quote: "Never reuse the drain plug gasket",
    claim: "reuse the drain plug gasket",
    task: "Change the engine oil",
    expect: "reject",
    finding: "1A-05",
    note: "Dropping 'Never' inverts the step.",
  },
  {
    id: "P2-range-cut",
    verifier: "planner",
    channel: "numeric_spec",
    chunkText: "Charging voltage: 13.2 to 14.8 V at 2,000 rpm.",
    quote: "Charging voltage: 13.2 to 14.8 V",
    claim: "2 to 14.8 V",
    task: "Check the charging voltage",
    expect: "reject",
    finding: "1A-05",
    note: "The claim starts inside 13.2, turning the lower bound into 2 V.",
  },
  {
    id: "P3a-claim-ends-mid-number",
    verifier: "planner",
    channel: "numeric_spec",
    chunkText: "Wheel lug nut torque 103 N*m (1,050 kgf*cm, 76 ft.*lbf).",
    quote: "Wheel lug nut torque 103",
    claim: "Wheel lug nut torque 10",
    task: "Install the wheels",
    expect: "reject",
    finding: "1A-05",
    note: "The claim stops inside 103 and has no unit, so no number check runs.",
  },
  {
    id: "P3b-claim-starts-mid-number",
    verifier: "planner",
    channel: "numeric_spec",
    chunkText: "Tighten the caliper bolts to 107 N*m.",
    quote: "Tighten the caliper bolts to 107 N*m",
    claim: "7 N*m",
    task: "Install the brake calipers",
    expect: "reject",
    finding: "1A-05",
    note: "Guard: rejected today only because a unit follows the cut; a boundary fix must keep it.",
  },
  {
    id: "P3c-decimal-cut",
    verifier: "planner",
    channel: "numeric_spec",
    chunkText: "Brake pad minimum thickness 1.5 mm.",
    quote: "Brake pad minimum thickness 1.5 mm",
    claim: "5 mm",
    task: "Inspect the brake pads",
    expect: "reject",
    finding: "1A-05",
    note: "Guard: the claim drops '1.' from 1.5 mm.",
  },

  // ---- 1A-06: no subject guard ----
  {
    id: "P4-other-parts-value",
    verifier: "planner",
    channel: "numeric_spec",
    chunkText: "Oil pan drain plug 37 N*m. Oil filter cap 25 N*m.",
    quote: "Oil pan drain plug 37 N*m",
    claim: "37 N*m",
    task: "Replace the oil filter",
    expect: "reject",
    finding: "1A-06",
    note: "A bare value names no part; 37 N*m is the drain plug's, the filter cap's is 25. Closed first by the D2 whole-clause rule: the quote names the plug and the claim drops it.",
  },
  {
    id: "P4b-bare-value-trimmed-quote",
    verifier: "planner",
    channel: "numeric_spec",
    chunkText: "Oil pan drain plug 37 N*m. Oil filter cap 25 N*m.",
    quote: "37 N*m",
    claim: "37 N*m",
    task: "Replace the oil filter",
    expect: "reject",
    finding: "1A-06",
    note: "P4 with the quote trimmed to the value too: a whole clause of its own quote, and still the drain plug's value.",
  },
  {
    id: "P4c-bare-value-other-kind",
    verifier: "planner",
    channel: "vehicle_fact",
    chunkText: "Oil pan drain plug 37 N*m. Oil filter cap 25 N*m.",
    quote: "37 N*m",
    claim: "37 N*m",
    task: "Replace the oil filter",
    expect: "reject",
    finding: "1A-06",
    note: "Filing the bare value under another kind does not make it name a part.",
  },
  {
    id: "P4d-spec-noun-only-other-part",
    verifier: "planner",
    channel: "numeric_spec",
    chunkText: "Caliper slide pin bolt torque: 34 N*m. Caliper bracket bolt torque: 107 N*m.",
    quote: "torque: 107 N*m",
    claim: "torque: 107 N*m",
    task: "Tighten the caliper slide pin bolts",
    expect: "reject",
    finding: "1A-06",
    note: "The 1B-01 probe: 107 N*m is the bracket bolt's; 'torque' names no part, and the slide pins' value is 34.",
  },
  {
    id: "P4e-part-from-another-task",
    verifier: "planner",
    channel: "numeric_spec",
    chunkText: "Coolant drain cock 13 N*m. Oil pan drain plug 37 N*m.",
    quote: "Coolant drain cock 13 N*m",
    claim: "Coolant drain cock 13 N*m",
    task: "Replace the oil filter",
    expect: "reject",
    finding: "1A-06",
    note: "The claim names a part, but nothing it or its quote names belongs to the task it is filed under.",
  },

  // ---- 1A-07: raw-substring itemName ----
  {
    id: "P5a-one-letter-item",
    verifier: "planner",
    channel: "required_tool",
    chunkText: "A torque wrench is required.",
    quote: "A torque wrench is required",
    claim: "A torque wrench is required",
    task: "Install the wheels",
    itemName: "e",
    expect: "reject",
    finding: "1A-07",
    note: "'e' is a letter of the claim, not the name of a tool.",
  },

  // ---- Controls ----
  {
    id: "control-planner-full-safety-sentence",
    verifier: "planner",
    channel: "safety_instruction",
    chunkText: "Do not apply grease to the friction surface of the brake pads.",
    quote: "Do not apply grease to the friction surface of the brake pads",
    claim: "Do not apply grease to the friction surface of the brake pads",
    task: "Replace the front brake pads",
    expect: "accept",
    finding: "control",
    note: "The whole instruction, negation included.",
  },
  {
    id: "control-planner-full-range",
    verifier: "planner",
    channel: "numeric_spec",
    chunkText: "Charging voltage: 13.2 to 14.8 V at 2,000 rpm.",
    quote: "Charging voltage: 13.2 to 14.8 V",
    claim: "Charging voltage: 13.2 to 14.8 V",
    task: "Check the charging voltage",
    expect: "accept",
    finding: "control",
    note: "The whole range with its spec noun; the claim equals its quote.",
  },
  {
    id: "control-planner-part-named",
    verifier: "planner",
    channel: "numeric_spec",
    chunkText: "Oil pan drain plug 37 N*m. Oil filter cap 25 N*m.",
    quote: "Oil filter cap 25 N*m",
    claim: "Oil filter cap 25 N*m",
    task: "Replace the oil filter",
    expect: "accept",
    finding: "control",
    note: "The value with the part it belongs to, filed under that part's task.",
  },
  {
    id: "control-planner-task-part-in-quote",
    verifier: "planner",
    channel: "numeric_spec",
    chunkText: "Front brake pad replacement: torque the caliper bolts to 25 ft-lb.",
    quote: "Front brake pad replacement: torque the caliper bolts to 25 ft-lb",
    claim: "torque the caliper bolts to 25 ft-lb",
    task: "Replace the front brake pads",
    expect: "accept",
    finding: "control",
    note: "The claim names its own part (caliper bolts) and its quote names the task's (brake pads); plurals match.",
  },
  {
    id: "control-planner-tool-named",
    verifier: "planner",
    channel: "required_tool",
    chunkText: "A torque wrench is required.",
    quote: "A torque wrench is required",
    claim: "A torque wrench is required",
    task: "Install the wheels",
    itemName: "torque wrench",
    expect: "accept",
    finding: "control",
    note: "A real tool name that appears whole in the claim.",
  },
];

export const EVIDENCE_ORACLE = [...ASK_ORACLE, ...PLANNER_ORACLE];
