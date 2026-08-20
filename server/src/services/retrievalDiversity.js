// Post-ranking result diversity for chunk retrieval (Milestone N1).
//
// The problem this solves, measured on the real corpus: an "interior light
// wiring" query filled all 8 hybrid slots from only 4 logically distinct
// sources. The cause is not a ranking bug. Wiring-diagram sheets repeat their
// title on every page, so their page-one chunks score almost identically, and
// the library holds 130 groups of documents (310 of 1,443) whose extracted text
// is byte-for-byte identical. Those duplicates are separate PDFs with separate
// MD5s, so import-time file dedup cannot see them and a per-document cap alone
// would not have moved a single slot on that query.
//
// So diversity is applied as a SELECTION step over an already-ranked list, never
// as a re-ranking:
//
//   1. Identical evidence is returned once. Two chunks whose text is the same
//      after whitespace/case normalization are the same words; a second copy
//      cannot support a claim the first one does not already support.
//   2. Each logical SOURCE gets at most `maxPerSource` slots. A source is a
//      content group, not a document id -- documents carrying identical text are
//      one source (see chunkRetrievalService's resolver), which is what stops a
//      duplicate group from spending the budget several times over.
//   3. Chunks held back by rule 2 are DEFERRED, not discarded, and backfill the
//      remaining slots in their original rank order. A query whose only relevant
//      evidence lives in one document therefore returns exactly what it returned
//      before -- diversity is never bought by leaving slots empty.
//
// Because the walk runs in rank order and admits before it defers, the
// top-ranked chunk is always admitted first. Relevance ordering is preserved
// among admitted results, and nothing is ever promoted above a better-ranked
// result of a different kind: this deliberately has no notion of what a document
// IS, so it cannot favour or penalize diagrams, prose, or any other class.
//
// A leaf module: it imports nothing.

/**
 * Chunks one source may contribute to a single result set.
 *
 * Three, not one, and not "however many fit". Measured on this corpus: a torque
 * specification routinely spans two overlapping chunks of one page, and a brake
 * bleeding procedure spans three chunks across two pages -- a cap of two cuts
 * real evidence in half. Three also guarantees at least ceil(8/3) = 3 distinct
 * sources in Ask's 8 slots whenever the corpus can supply them.
 */
export const DEFAULT_MAX_CHUNKS_PER_SOURCE = 3;

const DEFAULT_RESULT_LIMIT = 8;

function safeLimit(limit) {
  return Math.max(1, Number(limit) || DEFAULT_RESULT_LIMIT);
}

/**
 * Identity of the words a chunk contributes.
 *
 * Whitespace and case only. No stemming, no similarity, no truncation: two
 * chunks collapse only when they really do say the same thing, so a near-miss
 * (an overlapping neighbour chunk, a reworded paragraph) is kept as the distinct
 * evidence it is.
 */
function evidenceFingerprint(chunk) {
  return String(chunk.chunkText ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function defaultSourceKey(chunk) {
  return `document:${chunk.documentId}`;
}

/**
 * Select up to `limit` results from an already-ranked candidate list, preferring
 * usefully different evidence while preserving the ranked order.
 *
 * @param {any[]} rankedChunks candidates, best first
 * @param {{
 *   limit?: number,
 *   maxPerSource?: number,
 *   resolveSourceKey?: (chunk: any) => string,
 * }} [options] `maxPerSource: 0` disables diversification and returns the plain
 *   ranked slice, which is how the feature is switched off end to end.
 * @returns {any[]} the selected chunks, unmodified and in rank order
 */
export function diversifyRankedChunks(
  rankedChunks,
  {
    limit = DEFAULT_RESULT_LIMIT,
    maxPerSource = DEFAULT_MAX_CHUNKS_PER_SOURCE,
    resolveSourceKey = defaultSourceKey,
  } = {}
) {
  const candidates = Array.isArray(rankedChunks) ? rankedChunks : [];
  const resultLimit = safeLimit(limit);
  const perSourceLimit = Number(maxPerSource);

  if (!Number.isInteger(perSourceLimit) || perSourceLimit <= 0) {
    return candidates.slice(0, resultLimit);
  }

  const seenEvidence = new Set();
  const usedPerSource = new Map();
  const selected = [];
  const deferred = [];

  for (const candidate of candidates) {
    if (selected.length >= resultLimit) {
      break;
    }

    if (!candidate || typeof candidate !== "object") {
      continue;
    }

    // A blank chunk is not evidence that two rows are the same row, so blankness
    // never triggers the duplicate rule.
    const fingerprint = evidenceFingerprint(candidate);

    if (fingerprint) {
      if (seenEvidence.has(fingerprint)) {
        continue;
      }

      seenEvidence.add(fingerprint);
    }

    const sourceKey = resolveSourceKey(candidate);
    const used = usedPerSource.get(sourceKey) || 0;

    if (used >= perSourceLimit) {
      deferred.push(candidate);
      continue;
    }

    usedPerSource.set(sourceKey, used + 1);
    selected.push(candidate);
  }

  // Backfill. Slots left empty by the cap go back to the best chunks it held
  // back, so a genuinely single-source question loses nothing.
  for (const candidate of deferred) {
    if (selected.length >= resultLimit) {
      break;
    }

    selected.push(candidate);
  }

  return selected;
}

/**
 * Deterministic diversity summary for tests, evals, and the metrics channel.
 *
 * Three numbers, because no one of them tells the truth alone:
 *
 * - `distinctDocumentCount` is the misleading one. It was already 8 of 8 on the
 *   query that motivated this work, while only 4 logically different sources
 *   were present.
 * - `distinctSourceCount` counts logical sources, and is the headline number --
 *   but it can legitimately FALL when several sources were each contributing the
 *   same paragraph and the copies collapse into one.
 * - `distinctEvidenceCount` counts how many different things the result set
 *   actually says. This is the one that must never regress: it is the quantity
 *   the safeguard exists to raise.
 *
 * @param {any[]} chunks
 * @param {{ resolveSourceKey?: (chunk: any) => string }} [options]
 */
export function measureRetrievalDiversity(
  chunks,
  { resolveSourceKey = defaultSourceKey } = {}
) {
  const rows = (Array.isArray(chunks) ? chunks : []).filter(
    (chunk) => chunk && typeof chunk === "object"
  );

  return {
    slotCount: rows.length,
    distinctDocumentCount: new Set(rows.map((chunk) => chunk.documentId)).size,
    distinctSourceCount: new Set(rows.map((chunk) => resolveSourceKey(chunk))).size,
    distinctEvidenceCount: new Set(rows.map((chunk) => evidenceFingerprint(chunk))).size,
  };
}
