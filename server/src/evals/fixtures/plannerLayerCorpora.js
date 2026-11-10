// Invented corpora for the Repair Planner judge's layer and negative fixtures
// (docs/planner-eval-spec.md, Phase 2b, sections 5.1 and 8).
//
// EVERY sentence here is written for this file. None is copied or derived from
// a repair manual, every title says "Synthetic Fixture", and plannerJudge's
// tests run the same source-derived-material check over this text that
// plannerFixtures.test.js runs over the Phase 2a corpora. Figures are either
// the short golden figures already public in the Ask eval cases or invented
// for the trap (the variant torques here are deliberately NOT the real ones).
//
// Each corpus exists to make ONE judge outcome or ONE negative row real. What
// a corpus is for is said beside it; a corpus that stopped producing its
// situation must be reported, never quietly reworded until a test passes.

const chunk = (documentId, documentTitle, pageNumber, chunkText, extra = {}) => ({
  documentId,
  documentTitle,
  originalFilename: `${documentTitle.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}.pdf`,
  pageNumber,
  chunkIndex: 0,
  chunkText,
  origin: "invented",
  ...extra,
});

// Padding that pushes a sentence past the 1,500-character evidence cap. Plain
// invented prose, repeated, so it cannot be mistaken for a manual passage.
const FILLER =
  "This filler sentence exists only to make the synthetic fixture chunk longer than the evidence limit. ";

const UNRELATED = [
  chunk(
    401,
    "Wiper Blade Notes - Synthetic Fixture",
    1,
    "Lift the wiper arm away from the glass and slide the old blade off the hook."
  ),
];

// The drain-plug sentence sits after character 1,500, so the stored chunk holds
// it and the text the model is shown does not (NEG-IP-3, S:cap_truncated).
const CAP_TRUNCATED = [
  chunk(
    411,
    "Oil and Oil Filter Replacement - Synthetic Fixture",
    1,
    `${FILLER.repeat(17)}Tighten the oil drain plug to 37 N·m (27 ft-lbf).`,
    { purpose: "the fact exists in the stored chunk but past the evidence cap" }
  ),
];

// The right page, with the figure printed so badly that no sentence states it
// (S:source_unusable, when the survey has rated the page unusable).
const GARBLED = [
  chunk(
    421,
    "Oil and Oil Filter Replacement - Synthetic Fixture",
    1,
    "Ti ghten th e oi l dr ain pl ug t o 3 7 N m ( 2 7 f t lbf ).",
    { purpose: "the right page, with the figure unreadable in the extracted text" }
  ),
];

// Two engine rows for one part, the other engine FIRST (NEG-WE-1). The 40 N·m
// figure is invented.
const OTHER_ENGINE_FIRST = [
  chunk(
    431,
    "Lubrication Service Data - Synthetic Fixture",
    1,
    "2AZ-FE engine: tighten the oil drain plug to 40 N·m. 2ZR-FE engine: tighten the oil drain plug to 37 N·m.",
    { purpose: "an other-engine row printed before the owner's engine" }
  ),
];

// Two build-plant torques for one fastener (NEG-WE-2, NEG-WE-3). Both figures
// are invented; the plant codes are vehicle metadata.
const PLANT_VARIANTS = [
  chunk(
    441,
    "Engine Mounting Service Data - Synthetic Fixture",
    1,
    "Front mount bolt torque for TMC built vehicles: 50 N·m. Front mount bolt torque for TMMT built vehicles: 80 N·m.",
    { purpose: "one fastener, two build-plant figures" }
  ),
];

// One of four steps of an invented procedure, plus grounded "no tools" and
// "no parts" statements, so a plan can reach `verified` while covering a
// quarter of the procedure (NEG-IP-1).
const ONE_OF_FOUR_STEPS = [
  chunk(
    451,
    "Cabin Filter Procedure Step One - Synthetic Fixture",
    1,
    "Empty the glove box and squeeze its sides to let it swing down. This job requires no tools. This job requires no parts other than the filter element."
  ),
  chunk(
    452,
    "Cabin Filter Procedure Later Steps - Synthetic Fixture",
    2,
    "Unclip the filter cover from the housing. Slide the used element out of the housing. Fit the new element with its arrow pointing down.",
    { purpose: "the remaining steps, which the scripted search never retrieves" }
  ),
];

// A compound brake task where only the pads clause is supported (NEG-IP-2).
const PADS_ONLY = [
  chunk(
    461,
    "Brake Pad Procedure - Synthetic Fixture",
    1,
    "Remove the two slide pins and lift the caliper off the brake pads. Lift the old brake pads out of the bracket."
  ),
];

// A sentence the planner must not invert (NEG-X-3), and a tool sentence a
// requirement claim can be checked against (NEG-ME-5, NEG-X-4).
const TOOL_AND_WARNING = [
  chunk(
    471,
    "Drain Plug Gasket Notes - Synthetic Fixture",
    1,
    "Do not reuse the drain plug gasket. Use a socket wrench to loosen the drain plug. Hold the plug with SST while you turn it."
  ),
];

/** @type {Record<string, any[]>} */
export const LAYER_CORPORA = {
  empty: [],
  unrelated: UNRELATED,
  "cap-truncated": CAP_TRUNCATED,
  garbled: GARBLED,
  "other-engine-first": OTHER_ENGINE_FIRST,
  "plant-variants": PLANT_VARIANTS,
  "one-of-four-steps": ONE_OF_FOUR_STEPS,
  "pads-only": PADS_ONLY,
  "tool-and-warning": TOOL_AND_WARNING,
};
