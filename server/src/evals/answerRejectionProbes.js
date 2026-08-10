// Deterministic probes for the Ask verifier's REJECTION paths.
//
// Why these exist: every other case in answerQualityCases.js asks the real model
// and checks what came back. That cannot test rejection, because it would depend
// on the model volunteering a hallucination on the day the eval runs — an
// untestable premise, and one that gets less likely as models improve. The
// result was an eval suite that only ever exercised the accept path of a
// verifier whose entire job is rejecting.
//
// A probe replaces the model call through the `generateEvidenceAnswer` seam in
// askQuestionUsingDocuments, returning a reply crafted to fail one specific
// check. BE HONEST ABOUT WHAT THIS PROVES: the model is stubbed, so nothing here
// says anything about model behavior. Everything downstream is real — retrieval
// against the live embedded corpus, source mapping, quote verification, the
// numeric anomaly detector, status derivation, citation construction, gap
// redaction, and the metrics sanitizer. Those are what a rejection regression
// would break, and they are what these cases pin.

/**
 * An impossible torque figure. Chosen so it cannot collide with a real value in
 * any manual, and so a plain substring scan of the response proves the value
 * never reached the owner under any heading.
 */
export const REJECTION_PROBE_SENTINEL = "999999 N·m";

/** Matches the sentinel's digits alone, so a reformatted unit cannot hide it. */
export const REJECTION_PROBE_SENTINEL_PATTERN = /999999/;

/** Longest verbatim slice we quote back. Bounded so a probe stays readable. */
const QUOTE_LENGTH = 400;

/**
 * A genuine substring of the retrieved chunk.
 *
 * This is what makes the numeric probe sharp rather than trivial: the quote
 * really is in the document, so the claim clears the source and quote checks and
 * can only fail on the number itself. A fabricated quote would be rejected one
 * step earlier as quote_not_in_source and would never reach the detector.
 */
function verbatimQuote(chunk) {
  return String(chunk?.chunkText || "").slice(0, QUOTE_LENGTH);
}

const PROBES = {
  /**
   * A real source, a real verbatim quote, and an invented specification.
   * The dangerous shape: everything about it looks grounded except the value.
   */
  numeric_anomaly: (chunks) => ({
    documentSupported: [
      {
        claim: `The oil drain plug torque is ${REJECTION_PROBE_SENTINEL}.`,
        sourceId: "S1",
        evidenceQuote: verbatimQuote(chunks[0]),
      },
    ],
    generalGuidance: [],
    gaps: [],
  }),

  /**
   * An otherwise well-formed claim citing a label that was never issued.
   * Source ids are prompt-local and assigned per request, so a model naming S999
   * is citing something that does not exist for this question.
   */
  unknown_source: (chunks) => ({
    documentSupported: [
      {
        claim: "The oil drain plug torque is stated in the repair manual.",
        sourceId: "S999",
        evidenceQuote: verbatimQuote(chunks[0]),
      },
    ],
    generalGuidance: [],
    gaps: [],
  }),
};

export const REJECTION_PROBE_NAMES = Object.freeze(Object.keys(PROBES));

/**
 * Build a `generateEvidenceAnswer` stand-in for one named probe.
 *
 * @param {string} name one of REJECTION_PROBE_NAMES
 * @returns {(params: { chunks: any[] }) => Promise<object>}
 */
export function createRejectionProbe(name) {
  const build = PROBES[name];

  if (!build) {
    throw new Error(`Unknown rejection probe: ${name}`);
  }

  return async ({ chunks }) => {
    const retrieved = Array.isArray(chunks) ? chunks : [];

    // Unreachable in the live runner — askQuestionUsingDocuments returns
    // not_found before the answer step when retrieval is empty — but a probe
    // that silently invented a source would defeat its own purpose.
    if (!retrieved.length) {
      return { documentSupported: [], generalGuidance: [], gaps: [] };
    }

    return build(retrieved);
  };
}
