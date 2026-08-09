import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

// Isolate to a scratch DB/uploads dir BEFORE importing anything that pulls in
// database.js (answerQualityScoring -> aiAnswerService -> chunkRetrievalService
// -> database.js opens config.databaseFile at import time). Without this the
// suite would open the real dev DB and race other suites on the WAL pragma.
const tempRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "corolla-fix-helper-answer-cases-")
);
process.env.DATABASE_FILE = path.join(tempRoot, "answer-cases.db");
process.env.UPLOADS_DIR = path.join(tempRoot, "uploads");

const { answerQualityCases } = await import("../src/evals/answerQualityCases.js");
const { summarize } = await import("../src/evals/answerQualityScoring.js");
const { REJECTION_PROBE_NAMES } = await import("../src/evals/answerRejectionProbes.js");
const { ASK_REJECTION_REASONS } = await import("../src/services/askEvidenceContract.js");
const { db } = await import("../src/database.js");

after(() => {
  if (typeof db.close === "function") {
    db.close();
  }

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

// Only these cases have been confirmed against the real embedded manuals. Every
// other case must stay verified:false so a guessed template can never gate CI.
const VERIFIED_IDS = [
  "oil-drain-plug-torque",
  "refuse-flux-capacitor",
  "refuse-boeing-tire",
  "refuse-warp-core",
  // Confirmed against the real local corpus (1443 docs / 19636 chunks) rather
  // than inferred from a passing run — see the evidence recorded on each case in
  // src/evals/answerQualityCases.js. These two are what make the gate meaningful:
  // the first is the only assertion that a CITED SNIPPET backs the value (the
  // anti-laundering check), the second is the only plausible-but-absent
  // automotive refusal (the other three refusals are fictional).
  "oil-drain-plug-torque-citation-support",
  "refuse-turbo-boost-pressure",
  // Verified without a corpus confirmation, which is unusual here and
  // deliberate: both stub the model through a probe, so their expected outcome
  // is a property of the verifier's rules rather than of any document. See the
  // note on the cases themselves in src/evals/answerQualityCases.js.
  "reject-invented-drain-plug-torque",
  "reject-unknown-source-label",
];

const VALID_CATEGORIES = new Set([
  "torque",
  "capacity",
  "procedure",
  "refusal",
  // Not "rejection": one letter of difference from "refusal" for two cases that
  // exist specifically to stop those being confused. This names the component
  // under test instead.
  "verifier",
  "behavior",
]);

test("only the known-confirmed cases are marked verified", () => {
  const verifiedIds = answerQualityCases
    .filter((testCase) => testCase.verified === true)
    .map((testCase) => testCase.id)
    .sort();

  assert.deepEqual(verifiedIds, [...VERIFIED_IDS].sort());
});

test("every case has a valid category and expectation", () => {
  const validExpectations = new Set(["answered", "refused", "rejected"]);

  for (const testCase of answerQualityCases) {
    assert.ok(testCase.id, "case is missing an id");
    assert.ok(VALID_CATEGORIES.has(testCase.category), `bad category on ${testCase.id}`);
    assert.ok(validExpectations.has(testCase.expect), `bad expect on ${testCase.id}`);
  }
});

test("rejection cases name a real probe and the status the verifier must derive", () => {
  const rejectionCases = answerQualityCases.filter((testCase) => testCase.expect === "rejected");

  assert.ok(rejectionCases.length >= 2, "expected at least two verifier-rejection cases");

  const reasonsCovered = new Set();

  for (const testCase of rejectionCases) {
    assert.ok(
      REJECTION_PROBE_NAMES.includes(testCase.rejectionProbe),
      `${testCase.id} names an unknown rejection probe`
    );
    // Without this a "rejected" case could pass on `answered`, inverting it.
    assert.ok(
      testCase.expectedStatus && testCase.expectedStatus !== "answered",
      `${testCase.id} must expect a non-answered status`
    );
    assert.ok(
      Array.isArray(testCase.requiredRejectedReasons) &&
        testCase.requiredRejectedReasons.length > 0,
      `${testCase.id} must require at least one rejection reason`
    );

    for (const reason of testCase.requiredRejectedReasons) {
      assert.ok(
        ASK_REJECTION_REASONS.includes(reason),
        `${testCase.id} requires unknown reason ${reason}`
      );
      reasonsCovered.add(reason);
    }
  }

  // The two shapes the issue called out: an invented value on real evidence, and
  // a citation to a label that was never issued.
  assert.ok(reasonsCovered.has("numeric_anomaly"), "no invented-specification case");
  assert.ok(reasonsCovered.has("unknown_source"), "no unknown-source-label case");
});

test("a rejection case is not a refusal case in disguise", () => {
  // The distinction these cases exist to preserve. A "rejected" case must
  // stub the model; a "refused" case must not, because its whole claim is that
  // the real pipeline declined to answer.
  for (const testCase of answerQualityCases) {
    if (testCase.expect === "rejected") {
      assert.ok(testCase.rejectionProbe, `${testCase.id} must use a probe`);
    } else {
      assert.equal(
        testCase.rejectionProbe,
        undefined,
        `${testCase.id} must not stub the model`
      );
    }
  }
});

test("new template cases cover the major vehicle systems", () => {
  const systems = new Set(
    answerQualityCases
      .map((testCase) => testCase.system)
      .filter(Boolean)
      .map((system) => system.toLowerCase())
  );

  for (const system of [
    "engine",
    "brakes",
    "cooling",
    "electrical",
    "suspension",
    "transmission",
    "fuel",
    "hvac",
  ]) {
    assert.ok(systems.has(system), `no eval case covers the ${system} system`);
  }
});

test("a vision case guards that an image cannot unlock an unsupported spec", () => {
  const visionCases = answerQualityCases.filter((testCase) => testCase.image);

  assert.ok(visionCases.length >= 1, "expected at least one vision (image) case");
  assert.ok(
    visionCases.every((testCase) => testCase.expect === "refused"),
    "vision guard cases must expect a refusal when the chunks do not support the spec"
  );
});

test("golden repair topics are covered by eval cases", () => {
  const hasQuestion = (pattern) =>
    answerQualityCases.some((testCase) => pattern.test(testCase.question || ""));

  assert.ok(hasQuestion(/P0301/i), "no P0301 cylinder-1 misfire case");
  assert.ok(hasQuestion(/coolant|radiator/i), "no coolant/radiator case");
  assert.ok(hasQuestion(/squeal/i), "no startup-squeal case");
  assert.ok(hasQuestion(/\bbelt\b/i), "no drive/alternator belt case");
  assert.ok(hasQuestion(/turbo/i), "no unsupported turbo refusal case");

  // The citation-support golden case anchors to a source we already confirmed
  // (the oil-drain-plug torque), so its expected snippet can be trusted.
  const citationCase = answerQualityCases.find(
    (testCase) =>
      /citation/i.test(testCase.id) && Array.isArray(testCase.citationSupportsAny)
  );
  assert.ok(citationCase, "no citation-support golden case");
});

test("failing unverified template cases never gate the result", () => {
  // Simulate a CI run where every template case fails but the verified cases
  // pass: the gate (allVerifiedPass) must stay green.
  const results = answerQualityCases.map((testCase) => ({
    id: testCase.id,
    category: testCase.category,
    verified: Boolean(testCase.verified),
    pass: Boolean(testCase.verified),
  }));

  const summary = summarize(results);
  assert.equal(summary.allVerifiedPass, true);
  assert.equal(summary.verifiedTotal, VERIFIED_IDS.length);
});
