import assert from "node:assert/strict";
import test from "node:test";

// Pure: the probes build a payload, and verifyEvidence checks it. No database,
// no network, no corpus. That is the point of this file — the live eval needs a
// real embedded database and an API key, so without these tests the probes
// would only ever be exercised on one machine, and a probe that quietly stopped
// tripping its intended check would show up as a passing eval.
import {
  createRejectionProbe,
  REJECTION_PROBE_NAMES,
  REJECTION_PROBE_SENTINEL,
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
