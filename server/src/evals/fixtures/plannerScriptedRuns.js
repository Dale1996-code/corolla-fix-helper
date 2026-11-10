// Scripted whole runs for the Repair Planner evaluation (docs/planner-eval-spec.md,
// Phase 2a): the situations the scenario data describes, produced by the REAL
// agent and the REAL verifier from invented text.
//
// Each run is "search once for the one task, then finalize these claims". Every
// claim's text is EXACTLY one of the scenario's labelled examples (a test checks
// it), and its quote is the whole sentence it came from, because the verifier
// accepts a specification only as a whole clause of its source. The claims here
// are the ones the real verifier ACCEPTS; the situations a plan can only reach
// through a verifier gap (a lone range endpoint, say) stay labelled data in the
// scenarios and have no run.
//
// Nothing here judges a run. What each run is -- a contradiction, a trap, a
// correct refusal -- is classified in Phase 2b.

import { createScriptedModel, finalizeCall, searchCall, sourceIdFor } from "../plannerScriptedModel.js";

// The sentences, exactly as the invented corpora print them.
const S1_RIGHT = "Tighten the oil drain plug to 37 N·m (27 ft-lbf).";
const S1_VARIANT = "Tighten the oil drain plug to 45 N·m (33 ft-lbf).";
const S2_RANGE = "Spark plug electrode gap for a new plug: 1.0 to 1.1 mm (0.0394 to 0.0433 in).";
const S2_USED = "Maximum spark plug electrode gap for a used plug: 1.3 mm (0.0512 in).";
const S2_ORPHAN = "Spark plug electrode gap 1.3 mm (0.0512 in).";
const S8_BELT = "Where a timing belt is fitted, renew the timing belt every 90,000 miles.";
const S8_DRIVE = "Replace the drive belt every 60,000 miles in severe service.";

const S1_FACT = "s1-drain-plug-torque";
const S2_NEW = "s2-new-plug-gap";
const S2_MAX = "s2-used-plug-max-gap";
const S8_FACT = "s8-no-timing-belt-procedure";

// `source` picks the one retrieved chunk the claim is quoted from, by a pattern
// on its context line, the way a model finds the id it must cite.
const claim = (text, source, labelFor) => ({ text, source, labelFor });

const S1_RIGHT_CLAIM = claim(S1_RIGHT, /Oil and Oil Filter Replacement/, { [S1_FACT]: "covers" });
const S1_VARIANT_CLAIM = claim(S1_VARIANT, /Variant Zeta/, { [S1_FACT]: "wrong_figure" });
const S2_RANGE_CLAIM = claim(S2_RANGE, /Ignition Service Data/, { [S2_NEW]: "covers", [S2_MAX]: "other_fact" });
const S2_USED_CLAIM = claim(S2_USED, /Ignition Service Data/, { [S2_NEW]: "other_fact", [S2_MAX]: "covers" });
const S2_ORPHAN_CLAIM = claim(S2_ORPHAN, /\(page 6\)/, { [S2_NEW]: "wrong_figure", [S2_MAX]: "unrelated" });
const S8_BELT_CLAIM = claim(S8_BELT, /Generic Maintenance Intervals/, { [S8_FACT]: "forbidden" });
const S8_DRIVE_CLAIM = claim(S8_DRIVE, /Drive Belt Replacement/, { [S8_FACT]: "not_forbidden" });

/**
 * @type {Record<string, {
 *   scenarioId: string, corpus: string, query: string,
 *   claims: Array<{ text: string, source: RegExp, labelFor: Record<string, string> }>,
 *   expect: { evidenceStatus: string, accepted: string[], rejected: number },
 * }>}
 */
export const SCRIPTED_RUNS = {
  // The control: the right figure, nothing else.
  "S1-correct-only": {
    scenarioId: "S1-oil-and-filter",
    corpus: "S1",
    query: "oil drain plug torque",
    claims: [S1_RIGHT_CLAIM],
    expect: { evidenceStatus: "partial", accepted: [S1_RIGHT], rejected: 0 },
  },
  // The owner's example: a correct and an incorrect specification for one fact,
  // both accepted by the real verifier because another variant's chunk names the
  // same part.
  "S1-contradiction": {
    scenarioId: "S1-oil-and-filter",
    corpus: "S1",
    query: "oil drain plug torque",
    claims: [S1_RIGHT_CLAIM, S1_VARIANT_CLAIM],
    expect: { evidenceStatus: "partial", accepted: [S1_RIGHT, S1_VARIANT], rejected: 0 },
  },
  "S2-correct": {
    scenarioId: "S2-spark-plugs",
    corpus: "S2",
    query: "spark plug electrode gap",
    claims: [S2_RANGE_CLAIM],
    expect: { evidenceStatus: "partial", accepted: [S2_RANGE], rejected: 0 },
  },
  // The real hazard in miniature: the orphaned, unqualified value is accepted
  // beside the correct range.
  "S2-trap": {
    scenarioId: "S2-spark-plugs",
    corpus: "S2",
    query: "spark plug electrode gap",
    claims: [S2_RANGE_CLAIM, S2_ORPHAN_CLAIM],
    expect: { evidenceStatus: "partial", accepted: [S2_RANGE, S2_ORPHAN], rejected: 0 },
  },
  // 1.3 mm WITH its qualifier is the used-plug fact, so this is not a trap.
  "S2-both-facts": {
    scenarioId: "S2-spark-plugs",
    corpus: "S2",
    query: "spark plug electrode gap",
    claims: [S2_RANGE_CLAIM, S2_USED_CLAIM],
    expect: { evidenceStatus: "partial", accepted: [S2_RANGE, S2_USED], rejected: 0 },
  },
  // A correct refusal: the premise holds, so nothing can be grounded.
  "S8-refusal": {
    scenarioId: "S8-timing-belt",
    corpus: "S8-premise-holds",
    query: "timing belt replacement interval",
    claims: [],
    expect: { evidenceStatus: "not_found", accepted: [], rejected: 0 },
  },
  // Only reachable because the corpus breaks the premise on purpose.
  "S8-fabrication": {
    scenarioId: "S8-timing-belt",
    corpus: "S8-premise-violated",
    query: "timing belt replacement interval",
    claims: [S8_BELT_CLAIM],
    expect: { evidenceStatus: "partial", accepted: [S8_BELT], rejected: 0 },
  },
  // Real drive-belt replacement text, cited for the timing-belt task.
  "S8-drive-belt-decoy": {
    scenarioId: "S8-timing-belt",
    corpus: "S8-premise-holds",
    query: "timing belt replacement interval",
    claims: [S8_DRIVE_CLAIM],
    expect: { evidenceStatus: "partial", accepted: [S8_DRIVE], rejected: 0 },
  },
};

/**
 * A run ready to drive the agent, with a FRESH scripted model: a model remembers
 * how many turns it has played, so sharing one between runs would start the
 * second run mid-script.
 *
 * @param {string} id
 */
export function scriptedRun(id) {
  const definition = SCRIPTED_RUNS[id];

  if (!definition) {
    throw new Error(`no scripted run named ${id}`);
  }

  const model = createScriptedModel([
    [searchCall(1, definition.query)],
    ({ input }) => [
      finalizeCall(
        definition.claims.map((entry) => ({
          taskId: 1,
          kind: "numeric_spec",
          claim: entry.text,
          sourceId: sourceIdFor(input, entry.source),
          evidenceQuote: entry.text,
        }))
      ),
    ],
  ]);

  return { id, ...definition, model };
}
