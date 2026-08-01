// Per-chunk relevance floor for Ask (Milestone 3).
//
// The audit's proposed "near-zero-risk immediate fix" was to drop every
// retrieved chunk below MINIMUM_SEMANTIC_SCORE before building context. That was
// deferred deliberately, for two reasons that still hold:
//
//   1. The 0.2 threshold is UNCALIBRATED. It was never derived from real
//      positive/negative pairs, so nobody knows whether it drops noise or good
//      evidence. Shipping a filter built on an unvalidated constant is not
//      near-zero-risk.
//   2. `npm run eval:retrieval` structurally CANNOT observe this filter -- it
//      imports only the retrieval layer, while the filter lives above it in
//      askQuestionUsingDocuments. A green retrieval eval would have proved
//      nothing about it.
//
// So the floor ships in SHADOW MODE by default: it computes exactly what it
// would drop, reports that through the existing log-safe metrics channel, and
// changes nothing. `ASK_RELEVANCE_FLOOR=true` enforces it once calibration on a
// real corpus justifies the threshold.
//
// A leaf module: it imports nothing.

/**
 * Would this chunk be dropped by the floor?
 *
 * Only chunks with a real semantic score are judged. A keyword-only chunk has no
 * comparable score (it was never embedded, or its embedding version is stale),
 * and dropping it would silently delete newly-uploaded documents from Ask --
 * exactly the failure mode the embedding-version degradation logic exists to
 * prevent.
 */
function isBelowFloor(chunk, threshold) {
  if (!chunk || typeof chunk !== "object") {
    return false;
  }

  if (chunk.retrievalMode !== "hybrid") {
    return false;
  }

  const semanticScore = Number(chunk.semanticScore);

  if (!Number.isFinite(semanticScore) || semanticScore <= 0) {
    // No usable semantic signal: judged by keyword ranking alone, as before.
    return false;
  }

  // Exempt on the chunk's OWN TEXT matching, not on keywordScore.
  //
  // scoreChunkForTerms awards +6 for a chunk-text hit but also +2 title, +1
  // filename, +1 system -- so keywordScore > 0 can mean nothing more than "this
  // document is named after your question", with the chunk body matching no term
  // at all. Exempting on keywordScore made the floor completely inert on the
  // real corpus (measured: 0 chunks dropped at every threshold up to 0.5).
  // chunkMatchedTerms counts only real body-text hits, which is the evidence
  // that actually stands on its own.
  if (Number(chunk.chunkMatchedTerms) > 0) {
    return false;
  }

  return semanticScore < threshold;
}

/**
 * Apply (or shadow) the floor.
 *
 * @param {any[]} chunks - retrieval order
 * @param {{ threshold?: number, enforce?: boolean }} [options]
 * @returns {{
 *   chunks: any[],
 *   enforced: boolean,
 *   threshold: number,
 *   droppedCount: number,
 *   keptCount: number,
 *   dropped: Array<{ documentId: any, pageNumber: any, chunkIndex: any, semanticScore: number }>,
 * }}
 */
export function applyRelevanceFloor(chunks, { threshold = 0.2, enforce = false } = {}) {
  const input = Array.isArray(chunks) ? chunks : [];
  const kept = [];
  const dropped = [];

  for (const chunk of input) {
    if (isBelowFloor(chunk, threshold)) {
      dropped.push({
        documentId: chunk.documentId ?? null,
        pageNumber: chunk.pageNumber ?? null,
        chunkIndex: chunk.chunkIndex ?? null,
        semanticScore: Number(chunk.semanticScore),
      });
      continue;
    }

    kept.push(chunk);
  }

  // Never empty the context. If the floor would drop everything, enforcing it
  // would convert a weak-but-real answer into a not_found with no evidence to
  // show -- strictly worse than letting the existing relevance gate decide.
  const wouldEmpty = enforce && kept.length === 0 && input.length > 0;

  return {
    chunks: enforce && !wouldEmpty ? kept : input,
    enforced: enforce && !wouldEmpty,
    threshold,
    droppedCount: dropped.length,
    keptCount: kept.length,
    // Numeric references only -- no chunk text, titles, or filenames, so this
    // stays safe to log.
    dropped,
  };
}

/**
 * Sweep candidate thresholds over labelled retrieval results.
 *
 * A "positive" chunk is one a case expects to be used; everything else in the
 * result set is a negative. This is the calibration input the audit's fix was
 * missing: without it, any chosen threshold is a guess.
 *
 * @param {Array<{ chunks: any[], isPositive: (chunk: any) => boolean }>} samples
 * @param {number[]} thresholds
 */
export function sweepThresholds(samples, thresholds) {
  return thresholds.map((threshold) => {
    let keptPositive = 0;
    let droppedPositive = 0;
    let keptNegative = 0;
    let droppedNegative = 0;

    for (const sample of samples) {
      for (const chunk of sample.chunks) {
        const positive = sample.isPositive(chunk);
        const below = isBelowFloor(chunk, threshold);

        if (positive && below) {
          droppedPositive += 1;
        } else if (positive) {
          keptPositive += 1;
        } else if (below) {
          droppedNegative += 1;
        } else {
          keptNegative += 1;
        }
      }
    }

    return {
      threshold,
      keptPositive,
      // The number that matters: good evidence this threshold would throw away.
      droppedPositive,
      keptNegative,
      droppedNegative,
      noiseReduction:
        keptNegative + droppedNegative > 0
          ? droppedNegative / (keptNegative + droppedNegative)
          : 0,
      // Safe only when it drops no positives at all.
      safe: droppedPositive === 0,
    };
  });
}
