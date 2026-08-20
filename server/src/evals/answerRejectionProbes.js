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

// The source-label format is owned by the evidence contract; importing it keeps
// the probe and the verifier from drifting apart on what "S1" means.
import { sourceLabel } from "../services/askEvidenceContract.js";

/**
 * An impossible torque figure. Chosen so it cannot collide with a real value in
 * any manual, and so a plain substring scan of the response proves the value
 * never reached the owner under any heading.
 */
export const REJECTION_PROBE_SENTINEL = "999999 N·m";

/** Matches the sentinel's digits alone, so a reformatted unit cannot hide it. */
export const REJECTION_PROBE_SENTINEL_PATTERN = /999999/;

/**
 * A component name no repair manual can contain.
 *
 * The subject guard is lexical: it asks whether the part named in the claim
 * appears in the quote. A probe that named a PLAUSIBLE neighbouring part would
 * be testing the corpus rather than the guard, because whether it rejects then
 * depends on which chunk retrieval happened to rank first -- and real pages mix
 * parts freely (the drain-plug page also says "oil filter cap", so a claim about
 * the filter cap would be ACCEPTED there, which the verification boundary in
 * CLAUDE.md documents as expected). Confirmed against the local corpus: "flux"
 * appears in 0 of 20,447 chunks, so this sequence cannot be present in any
 * quote, whichever chunk is retrieved. Adversarial subtlety belongs in the
 * contract unit tests, which control the quote; this probe exists to prove the
 * END-TO-END path rejects, and for that it must be deterministic.
 */
export const REJECTION_PROBE_SENTINEL_PART = "flux capacitor mounting bolt";

/**
 * A quote that is in no document, for the same reason as the part name above.
 * It must fail `quoteAppearsInChunk` no matter what retrieval returned.
 */
export const REJECTION_PROBE_FABRICATED_QUOTE =
  "Tighten the flux capacitor mounting bolt with the calibrated dilithium wrench.";

/** A torque value as printed in these manuals ("37 Nm", "5.5 N*m", "27 N·m"). */
const TORQUE_VALUE_PATTERN = /\d+(?:\.\d+)?\s*N\s*[*·.]?\s*m\b/i;

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

/**
 * Find the first retrieved chunk whose quote states a torque, with the source
 * label that chunk will be given.
 *
 * Labels are POSITIONAL -- verifyEvidence maps S1..Sn onto the retrieval order
 * -- so the label has to be derived from the same index the quote came from.
 * Hard-coding "S1" here would make the probe depend on the drain-plug page
 * still ranking first, which is a retrieval fact and not the thing under test.
 */
function findTorqueEvidence(chunks) {
  for (const [index, chunk] of chunks.entries()) {
    const quote = verbatimQuote(chunk);
    const match = quote.match(TORQUE_VALUE_PATTERN);

    if (match) {
      return { sourceId: sourceLabel(index), quote, torque: match[0] };
    }
  }

  return null;
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
  /**
   * A real source, a real verbatim quote, a real NUMBER -- and the wrong part.
   *
   * This is the failure class the roadmap names first: "the correct number
   * attached to the wrong component". It is the only probe whose claim clears
   * every earlier check -- known source, verbatim quote, and a value the
   * evidence really does state -- so it can only be stopped by the subject
   * guard. The torque is read back OUT of the retrieved evidence at run time
   * rather than hard-coded, so the probe keeps testing the guard rather than
   * testing whether one particular chunk still ranks first.
   */
  subject_mismatch: (chunks) => {
    const evidence = findTorqueEvidence(chunks);

    if (!evidence) {
      // Loudly, not silently. A probe that quietly fell back to some other
      // claim shape would still "reject", and the case would go green while
      // testing a different check than the one it is named for.
      throw new Error(
        "subject_mismatch probe: no torque value in the retrieved evidence, " +
          "so the claim could not clear the numeric check first"
      );
    }

    return {
      documentSupported: [
        {
          claim: `The ${REJECTION_PROBE_SENTINEL_PART} torque is ${evidence.torque}.`,
          sourceId: evidence.sourceId,
          evidenceQuote: evidence.quote,
        },
      ],
      generalGuidance: [],
      gaps: [],
    };
  },

  /**
   * A real source label with a quote that is in no document at all.
   *
   * Distinct from numeric_anomaly on purpose: that probe proves a real quote
   * with a bad number is caught, this one proves the quote itself is checked
   * against the chunk the label maps to, rather than trusted because the label
   * resolved.
   */
  quote_not_in_source: () => ({
    documentSupported: [
      {
        claim: `The oil drain plug torque is ${REJECTION_PROBE_SENTINEL}.`,
        sourceId: "S1",
        evidenceQuote: REJECTION_PROBE_FABRICATED_QUOTE,
      },
    ],
    generalGuidance: [],
    gaps: [],
  }),

  /**
   * A specification smuggled through the UNSOURCED channel.
   *
   * General guidance carries no source id and no quote, so any unit-bearing
   * value in it is unsupported by definition however confidently it reads.
   * Worth an end-to-end case because this channel bypasses source mapping and
   * quote checking entirely -- it is gated only by the specification detector.
   */
  unsourced_specification: () => ({
    documentSupported: [],
    generalGuidance: [
      `As a general rule, tighten the drain plug to ${REJECTION_PROBE_SENTINEL}.`,
    ],
    gaps: [],
  }),

  /**
   * The same value smuggled through the channel that describes what is MISSING.
   *
   * A gap is model-authored text rendered to the owner, so an invented figure
   * inside one is still on screen -- under a heading that reads as a caveat,
   * which is worse than stating it outright.
   */
  unsourced_gap_specification: () => ({
    documentSupported: [],
    generalGuidance: [],
    gaps: [
      `The documents do not confirm the ${REJECTION_PROBE_SENTINEL} drain plug torque.`,
    ],
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
