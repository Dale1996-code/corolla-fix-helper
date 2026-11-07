// Invented mini-corpora for the scripted Repair Planner runs
// (docs/planner-eval-spec.md, Phase 2a).
//
// EVERY sentence here is written for this file. None is copied or derived from
// a repair manual, and every title says "Synthetic Fixture" so a chunk cannot be
// mistaken for a real document. Figures are the short golden figures already
// public in the Ask eval cases (an invented sentence around a bare figure), plus
// invented ones for the traps. plannerFixtures.test.js checks the corpus text for
// source-derived material.
//
// Each corpus holds the traps one scenario needs, and nothing else:
//
//   S1                 the right drain-plug torque, a chunk with no figure, and
//                      ANOTHER VARIANT's figure for the same part -- text the real
//                      verifier accepts, so a plan can hold a correct and an
//                      incorrect specification for one fact.
//   S2                 the full table, and the real hazard in miniature: a label
//                      that ends one page and its value that opens the next, bare
//                      and unqualified, above the new-plug range.
//   S8-premise-holds   a timing CHAIN and a drive belt that really has a mileage
//                      interval, but no timing belt anywhere: the corpus the
//                      scenario's premise describes.
//   S8-premise-violated the same, plus one generic chunk that mentions a timing
//                      belt. It exists only so a test can produce an ACCEPTED
//                      belt claim; it breaks the premise on purpose and says so.

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

const S1_CORPUS = [
  chunk(
    101,
    "Oil and Oil Filter Replacement - Synthetic Fixture",
    1,
    "Engine oil change, fixture procedure. Warm the engine, then drain the oil into a pan. Fit a new gasket on the drain plug. Tighten the oil drain plug to 37 N·m (27 ft-lbf). Refill with the specified oil."
  ),
  chunk(
    102,
    "Oil Filter Housing Notes - Synthetic Fixture",
    2,
    "Oil filter cap: tighten the cap by hand, then a further quarter turn."
  ),
  chunk(
    103,
    "Alternate Variant Zeta Service Notes - Synthetic Fixture",
    4,
    "Variant Zeta engines only. Tighten the oil drain plug to 45 N·m (33 ft-lbf).",
    { purpose: "another variant's figure for the same part, which the verifier accepts" }
  ),
];

const S2_CORPUS = [
  chunk(
    201,
    "Ignition Service Data - Synthetic Fixture",
    1,
    "Spark plug service data. Spark plug electrode gap for a new plug: 1.0 to 1.1 mm (0.0394 to 0.0433 in). Maximum spark plug electrode gap for a used plug: 1.3 mm (0.0512 in)."
  ),
  chunk(
    202,
    "Ignition System On-Vehicle Inspection - Synthetic Fixture",
    5,
    "Remove the spark plug and inspect the electrode. The wear limit for the gap of a used spark plug:",
    { purpose: "a label cut at the end of a page" }
  ),
  chunk(
    202,
    "Ignition System On-Vehicle Inspection - Synthetic Fixture",
    6,
    "Spark plug electrode gap 1.3 mm (0.0512 in). Spark plug electrode gap for a new spark plug: 1.0 to 1.1 mm (0.0394 to 0.0433 in).",
    { purpose: "the orphaned value, bare and unqualified, printed above the new-plug range" }
  ),
];

const S8_HOLDS = [
  chunk(
    301,
    "Timing Chain Service - Synthetic Fixture",
    1,
    "The timing chain is lubricated by engine oil and has no scheduled replacement. Chain cover bolt torque: 10 N·m."
  ),
  chunk(
    302,
    "Drive Belt Replacement - Synthetic Fixture",
    1,
    "Replace the drive belt when cracks appear. Replace the drive belt every 60,000 miles in severe service.",
    { purpose: "real replacement text for a different belt, as the manuals hold" }
  ),
];

const S8_VIOLATED = [
  ...S8_HOLDS,
  chunk(
    303,
    "Generic Maintenance Intervals - Synthetic Fixture",
    1,
    "Where a timing belt is fitted, renew the timing belt every 90,000 miles.",
    { purpose: "breaks the scenario's premise on purpose, so a test can produce an accepted timing-belt claim" }
  ),
];

/** @type {Record<string, any[]>} */
export const MINI_CORPORA = {
  S1: S1_CORPUS,
  S2: S2_CORPUS,
  "S8-premise-holds": S8_HOLDS,
  "S8-premise-violated": S8_VIOLATED,
};

const wordSet = (text) => new Set(String(text).toLowerCase().match(/[a-z0-9]+/g) ?? []);

/**
 * A deterministic stand-in for the real retriever: a chunk's score is how many
 * distinct query words (three letters or more) it holds, whole-word, in its text
 * or title. Ranked by score, ties by corpus order. No embeddings, no database,
 * and the same query always returns the same chunks in the same order.
 *
 * It hands back COPIES, so a consumer that mutates a result cannot corrupt the
 * corpus the next run reads.
 *
 * @param {any[]} chunks
 * @returns {(query: string, options?: { limit?: number }) => Promise<any[]>}
 */
export function createKeywordRetriever(chunks) {
  const indexed = chunks.map((entry) => ({ entry, words: wordSet(`${entry.chunkText} ${entry.documentTitle}`) }));

  return async (query, options = {}) => {
    const queryWords = [...wordSet(query)].filter((word) => word.length >= 3);
    const limit = Number.isFinite(options?.limit) && options.limit > 0 ? options.limit : 8;

    return indexed
      .map(({ entry, words }, index) => ({
        entry,
        index,
        score: queryWords.filter((word) => words.has(word)).length,
      }))
      .filter((scored) => scored.score > 0)
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .slice(0, limit)
      .map(({ entry, score }) => ({ ...entry, score }));
  };
}
