import assert from "node:assert/strict";
import test from "node:test";

// Pure: the probes build a payload, and verifyEvidence checks it. No database,
// no network, no corpus. That is the point of this file — the live eval needs a
// real embedded database and an API key, so without these tests the probes
// would only ever be exercised on one machine, and a probe that quietly stopped
// tripping its intended check would show up as a passing eval.
import {
  createRejectionProbe,
  REJECTION_PROBE_FABRICATED_QUOTE,
  REJECTION_PROBE_NAMES,
  REJECTION_PROBE_SENTINEL,
  REJECTION_PROBE_SENTINEL_PART,
  REJECTION_PROBE_SENTINEL_PATTERN,
} from "../src/evals/answerRejectionProbes.js";
import { verifyEvidence } from "../src/services/askEvidenceContract.js";

const chunk = () => ({
  documentId: 748,
  documentTitle: "Oil and Oil Filter Replacement",
  originalFilename: "oil.pdf",
  pageNumber: 1,
  chunkIndex: 0,
  chunkText:
    "Clean and install the oil drain plug with a new gasket. Torque : 37 Nm (377 kgf-cm, 27 ft-lbf)",
});

async function runProbe(name) {
  const chunks = [chunk()];
  const reply = await createRejectionProbe(name)({ chunks });

  return { reply, verified: verifyEvidence(reply, chunks) };
}

test("the numeric probe is rejected as a numeric anomaly, not one check earlier", async () => {
  // The distinction that makes this probe worth having: a fabricated quote would
  // die at quote_not_in_source and never reach the anomaly detector, so the
  // probe would be testing the wrong thing while still looking like it worked.
  const { verified } = await runProbe("numeric_anomaly");

  assert.equal(verified.documentSupported.length, 0);
  assert.equal(verified.rejected.length, 1);
  assert.equal(verified.rejected[0].reason, "numeric_anomaly");
  assert.equal(verified.rejected[0].channel, "documentSupported");
  assert.equal(verified.rejected[0].sourceId, "S1");
});

test("the numeric probe quotes the document verbatim", async () => {
  const { reply } = await runProbe("numeric_anomaly");
  const quote = reply.documentSupported[0].evidenceQuote;

  assert.ok(quote.length > 0);
  assert.ok(chunk().chunkText.includes(quote), "the probe quote is not in the chunk");
});

test("the unknown-source probe is rejected for its label", async () => {
  const { verified } = await runProbe("unknown_source");

  assert.equal(verified.documentSupported.length, 0);
  assert.equal(verified.rejected.length, 1);
  assert.equal(verified.rejected[0].reason, "unknown_source");
  assert.equal(verified.rejected[0].sourceId, "S999");
});

test("the sentinel never survives verification into a gap", async () => {
  // Gap text is rendered to the owner. A rejected specification that reappears
  // there is still on screen — under a safer-sounding heading, which is worse.
  const { verified } = await runProbe("numeric_anomaly");

  assert.ok(verified.gaps.length > 0, "expected the rejection to become a gap");
  assert.doesNotMatch(verified.gaps.join(" "), REJECTION_PROBE_SENTINEL_PATTERN);
  assert.match(verified.gaps.join(" "), /\[unverified value\]/);
});

test("the sentinel is a value no real manual can contain", async () => {
  const { reply } = await runProbe("numeric_anomaly");

  assert.match(reply.documentSupported[0].claim, REJECTION_PROBE_SENTINEL_PATTERN);
  assert.ok(REJECTION_PROBE_SENTINEL.includes("999999"));
  // A torque of ~1,000,000 N·m is about the output of a ship's engine. If this
  // ever matched a document, the corpus would be the problem.
  assert.doesNotMatch(chunk().chunkText, REJECTION_PROBE_SENTINEL_PATTERN);
});

test("every declared probe trips exactly one rejection", async () => {
  for (const name of REJECTION_PROBE_NAMES) {
    const { verified } = await runProbe(name);
    assert.equal(verified.rejected.length, 1, `${name} did not reject exactly once`);
    assert.equal(verified.documentSupported.length, 0, `${name} let a claim through`);
  }
});

test("an unknown probe name fails loudly rather than stubbing nothing", () => {
  // A silent no-op probe would turn a rejection case into an ordinary refusal
  // case that passes for the wrong reason.
  assert.throws(() => createRejectionProbe("does_not_exist"), /Unknown rejection probe/);
});

test("a probe with no retrieved chunks invents no source", async () => {
  const reply = await createRejectionProbe("numeric_anomaly")({ chunks: [] });

  assert.deepEqual(reply, { documentSupported: [], generalGuidance: [], gaps: [] });
});

// ---- N1: the four probes added for the previously uncovered reasons ----

/**
 * A more realistic retrieval set than a single chunk: the torque page is NOT
 * first. Source labels are positional, so a probe that assumed S1 would cite
 * the wrong chunk here and die as a quote mismatch instead of the reason it is
 * named for.
 */
const rankedChunks = () => [
  {
    documentId: 748,
    documentTitle: "Oil and Oil Filter Replacement",
    originalFilename: "oil.pdf",
    pageNumber: 1,
    chunkIndex: 2,
    chunkText:
      "engine oil. Do not use gasoline, thinners or solvents. Wash your hands with soap and water.",
  },
  chunk(),
];

test("the subject probe is rejected for the PART, having cleared every earlier check", async () => {
  // The failure class the roadmap names first: a real source, a real quote, a
  // real number, and the wrong component. If any earlier check fired instead,
  // the probe would be testing something other than the subject guard.
  const chunks = [chunk()];
  const reply = await createRejectionProbe("subject_mismatch")({ chunks });
  const claim = reply.documentSupported[0];

  assert.ok(chunk().chunkText.includes(claim.evidenceQuote), "the quote is not verbatim");
  assert.match(claim.claim, /37\s*Nm/i, "the probe did not reuse the document's own value");

  const verified = verifyEvidence(reply, chunks);

  assert.equal(verified.documentSupported.length, 0);
  assert.equal(verified.rejected.length, 1);
  assert.equal(verified.rejected[0].reason, "subject_mismatch");
});

test("the subject probe reads its value and label out of the retrieval order", async () => {
  // Guards the part most likely to rot: a hard-coded "S1" would keep passing
  // while silently testing quote_not_in_source instead.
  const chunks = rankedChunks();
  const reply = await createRejectionProbe("subject_mismatch")({ chunks });

  assert.equal(reply.documentSupported[0].sourceId, "S2", "label must follow the chunk index");
  assert.equal(verifyEvidence(reply, chunks).rejected[0].reason, "subject_mismatch");
});

test("the subject probe fails loudly when no torque is in the evidence", async () => {
  // Rather than degrading into a different rejection reason and going green.
  await assert.rejects(
    () =>
      createRejectionProbe("subject_mismatch")({
        chunks: [{ ...chunk(), chunkText: "Wash your hands with soap and water." }],
      }),
    /no torque value in the retrieved evidence/
  );
});

test("the fabricated-quote probe dies on the quote, not on the label", async () => {
  const { verified, reply } = await runProbe("quote_not_in_source");

  assert.equal(reply.documentSupported[0].sourceId, "S1", "the label must resolve");
  assert.equal(verified.rejected.length, 1);
  assert.equal(verified.rejected[0].reason, "quote_not_in_source");
  assert.ok(
    !chunk().chunkText.includes(REJECTION_PROBE_FABRICATED_QUOTE),
    "the fabricated quote must not be in the chunk"
  );
});

test("a specification in the unsourced channels is rejected either way", async () => {
  for (const [name, reason] of [
    ["unsourced_specification", "unsourced_specification"],
    ["unsourced_gap_specification", "unsourced_gap_specification"],
  ]) {
    const { verified } = await runProbe(name);

    assert.equal(verified.rejected.length, 1, `${name} did not reject once`);
    assert.equal(verified.rejected[0].reason, reason);
    // Both channels are model-authored and neither carries a source, so the
    // value must be redacted before it reaches the rendered gap.
    assert.doesNotMatch(verified.gaps.join(" "), REJECTION_PROBE_SENTINEL_PATTERN);
    assert.match(verified.gaps.join(" "), /\[unverified value\]/);
  }
});

test("no probe lets its sentinel value survive into rendered text", async () => {
  // The whole point of a sentinel: one scan proves the value reached no heading.
  for (const name of REJECTION_PROBE_NAMES) {
    const chunks = [chunk()];
    const verified = verifyEvidence(await createRejectionProbe(name)({ chunks }), chunks);
    const rendered = JSON.stringify({
      gaps: verified.gaps,
      generalGuidance: verified.generalGuidance,
      documentSupported: verified.documentSupported,
    });

    assert.doesNotMatch(rendered, REJECTION_PROBE_SENTINEL_PATTERN, `${name} leaked the sentinel`);
  }
});

test("the sentinel part name is one no quote can contain", async () => {
  // Confirmed against the local corpus: /flux/i matches 0 of 20,447 chunks. A
  // plausible neighbouring part would make the probe depend on which page
  // ranked first, because real pages mix parts freely -- the drain-plug page
  // also says "oil filter cap", so a claim about the filter cap is ACCEPTED
  // there. That is the documented verification boundary, not a defect, and it
  // is why this probe uses an impossible part rather than a subtle one.
  assert.match(REJECTION_PROBE_SENTINEL_PART, /flux capacitor/i);
  assert.doesNotMatch(chunk().chunkText, /flux/i);

  const withFilterCap = {
    ...chunk(),
    chunkText: `${chunk().chunkText} 2. REMOVE OIL FILTER CAP ASSEMBLY`,
  };
  const chunks = [withFilterCap];
  const verified = verifyEvidence(
    await createRejectionProbe("subject_mismatch")({ chunks }),
    chunks
  );

  assert.equal(
    verified.rejected[0].reason,
    "subject_mismatch",
    "the probe must still reject on a page that names several parts"
  );
});
