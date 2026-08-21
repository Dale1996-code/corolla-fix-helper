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
  // N1. Same probe-driven reasoning as the two above, extended to the four
  // rejection reasons that had no end-to-end case. askEvidenceContract.test.js
  // drives all six reasons, but against a hand-built chunk -- these are the only
  // cases that put them through real retrieval, real source mapping, status
  // derivation, citation suppression and the metrics sanitizer.
  "reject-wrong-component-torque",
  "reject-fabricated-quote",
  "reject-unsourced-guidance-spec",
  "reject-unsourced-gap-spec",
  // N1. Verified the same way refuse-turbo-boost-pressure was: by proving
  // ABSENCE across the whole corpus rather than by observing one run. "timing
  // belt" and "cam belt" match 0 of 20,447 chunks because this engine uses a
  // chain, while "timing" (809) and "belt" (589) are both common -- so the
  // refusal has to come from the missing PART, not from missing words.
  "refuse-timing-belt-interval",
  // Promoted 2026-08-20 after the live baseline run, taking the gate from 13
  // to 14. The only applicability case promoted: its evidence is a single
  // unambiguous chunk carrying exactly two variants, Ask produced both
  // values correctly scoped on every observed run, and the qualifiedValues
  // rule was proven against the dangerous alternatives (one variant only,
  // values swapped, numbers with no plant) rather than against the one
  // answer that happened to pass. applicability-vehicle-height-wrong-engine
  // and applicability-abs-wiring-variant stay templates -- see their notes.
  "applicability-engine-mount-build-variant",
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

test("every rejection reason the verifier can produce has an eval case (N1)", () => {
  // The invariant that keeps this suite honest as the verifier grows. Adding a
  // seventh reason to ASK_REJECTION_REASONS without an eval case for it now
  // fails here instead of shipping an untested rejection path, the same way
  // safetyClassifier.test.js asserts over its whole rule table rather than over
  // a hand-copied subset.
  //
  // Why it belongs at the EVAL layer when askEvidenceContract.test.js already
  // drives all six: that suite calls verifyEvidence directly on a chunk it
  // built itself. It cannot see source labels assigned across really-retrieved
  // chunks, status derivation in askQuestionUsingDocuments, citation
  // suppression, or buildRejectedMetrics -- the sanitizer deciding what leaves
  // the server. Those are exactly what an end-to-end rejection regression
  // breaks, and before N1 four of the six reasons never went through them.
  const covered = new Set(
    answerQualityCases
      .filter((testCase) => testCase.expect === "rejected")
      .flatMap((testCase) => testCase.requiredRejectedReasons || [])
  );

  const uncovered = ASK_REJECTION_REASONS.filter((reason) => !covered.has(reason));

  assert.deepEqual(
    uncovered,
    [],
    `rejection reasons with no eval case: ${uncovered.join(", ")}`
  );
});

test("every rejection probe is a real rejection reason (N1)", () => {
  // Probes are named after the reason they trip. A probe whose name is not in
  // the contract's table is either misnamed or testing something the verifier
  // no longer produces, and both make a green case meaningless.
  for (const name of REJECTION_PROBE_NAMES) {
    assert.ok(
      ASK_REJECTION_REASONS.includes(name),
      `probe ${name} does not name a rejection reason`
    );
  }
});

test("applicability cases name the variant axis they are scoped to (N1)", () => {
  // The most dangerous failure this app can produce is a confident answer for
  // the wrong variant, because it is indistinguishable from a correct one. Each
  // applicability case therefore has to require the ANSWER to carry a condition
  // -- engine, build plant, or optional equipment -- rather than merely mention
  // the topic.
  //
  // Two mechanisms satisfy that, and qualifiedValues is the stronger one: rather
  // than asking that a condition appear somewhere, it binds a specific value to
  // a specific condition in the same sentence. The 2026-08-20 live run is why
  // both are accepted -- the engine-mount case moved off mustIncludeAny because
  // an answer could satisfy it by naming one plant and giving one number.
  const applicabilityCases = answerQualityCases.filter((testCase) =>
    /^applicability-/.test(testCase.id)
  );

  assert.ok(
    applicabilityCases.length >= 3,
    "expected applicability cases across more than one variant axis"
  );

  const axes = new Set();

  for (const testCase of applicabilityCases) {
    const includePatterns = Array.isArray(testCase.mustIncludeAny)
      ? testCase.mustIncludeAny.map(String)
      : [];
    const qualifiers = Array.isArray(testCase.qualifiedValues)
      ? testCase.qualifiedValues.map((rule) => String(rule.qualifier))
      : [];

    assert.ok(
      includePatterns.length || qualifiers.length,
      `${testCase.id} must require the answer to name its condition`
    );

    // Only the CONDITION half counts toward axis coverage. A value pattern such
    // as /\b92\s*mm/i says nothing about which variant it belongs to.
    const conditions = [...includePatterns, ...qualifiers].join(" ");

    if (/2ZR|2AZ|engine/i.test(conditions)) axes.add("engine");
    if (/TMC|TMMT|plant|build|manufactur/i.test(conditions)) axes.add("build");
    if (/ABS|VSC|TRAC/i.test(conditions) || /ABS|VSC/i.test(testCase.question || "")) {
      axes.add("equipment");
    }
  }

  for (const axis of ["engine", "build", "equipment"]) {
    assert.ok(axes.has(axis), `no applicability case covers the ${axis} axis`);
  }
});

test("an answered case constrains a wrong-variant claim, not only a rejection case (N1)", () => {
  // Before N1 nothing an answered case could declare would fail an answer for
  // WHAT IT ASSERTED -- mustNotIncludeAny ran only for expect:"rejected". This
  // guards that at least one answered case still carries such a constraint, or
  // the applicability assertions above would silently never run.
  //
  // The 2026-08-20 run showed a flat ban is the wrong shape: it failed an answer
  // that correctly reported every variant. qualifiedValues replaced it, and both
  // mechanisms count here -- mustNotIncludeAny is still honored on answered
  // cases (see answerQualityScoring.test.js) and remains right for a value that
  // must never appear under any condition.
  const constrained = answerQualityCases.filter(
    (testCase) =>
      testCase.expect === "answered" &&
      ((Array.isArray(testCase.mustNotIncludeAny) && testCase.mustNotIncludeAny.length) ||
        (Array.isArray(testCase.qualifiedValues) && testCase.qualifiedValues.length))
  );

  assert.ok(
    constrained.length >= 1,
    "expected at least one answered case that constrains a wrong-variant claim"
  );
});

/**
 * Every reason a qualifiedValues rule is malformed, as a list.
 *
 * Shared by the invariant over the real cases and by the synthetic test below,
 * so the rejection path is proven rather than merely asserted. Testing a COPY of
 * these rules would prove nothing: the copy could stay correct while the
 * invariant quietly became a no-op.
 *
 * The flag check is not pedantry. `g` and `y` make a regex carry lastIndex
 * between calls, and scanning happens once per sentence, so a stateful pattern
 * resumes the next sentence mid-string and can MISS an unqualified statement --
 * a false PASS on a build gate. Rejecting the definition tells the author
 * exactly what is wrong; quietly rewriting their pattern would hide it. The
 * scorer separately builds its own non-global scanner, and that defence stays:
 * validation catches the author, the scanner catches everything else.
 */
function qualifiedValueRuleProblems(rule) {
  const problems = [];

  for (const field of ["value", "qualifier"]) {
    const pattern = rule[field];

    if (!(pattern instanceof RegExp) && typeof pattern !== "string") {
      problems.push(`${field} is missing`);
      continue;
    }

    if (pattern instanceof RegExp) {
      if (pattern.global) {
        problems.push(`${field} uses the g flag`);
      }

      if (pattern.sticky) {
        problems.push(`${field} uses the y flag`);
      }
    }
  }

  return problems;
}

test("every qualifiedValues rule is well formed (N1)", () => {
  // A rule missing its qualifier would silently pass everything, which is worse
  // than no rule at all: the case would look like an applicability gate and gate
  // nothing.
  for (const testCase of answerQualityCases) {
    for (const rule of testCase.qualifiedValues || []) {
      assert.deepEqual(
        qualifiedValueRuleProblems(rule),
        [],
        `${testCase.id}: malformed qualifiedValues rule`
      );
    }
  }
});

test("a stateful qualifiedValues pattern is rejected as malformed (N1)", () => {
  // Exercises the REJECTION path, which the real cases never reach because they
  // are all well formed. Without this the invariant above could be refactored
  // into a no-op and nothing would notice.
  assert.deepEqual(
    qualifiedValueRuleProblems({ value: /96 mm/i, qualifier: /2AZ-FE/i }),
    [],
    "an ordinary regex rule must be accepted"
  );
  assert.deepEqual(
    qualifiedValueRuleProblems({ value: "96 mm", qualifier: "2AZ-FE" }),
    [],
    "a string rule must be accepted"
  );

  assert.deepEqual(qualifiedValueRuleProblems({ value: /96 mm/gi, qualifier: /2AZ-FE/i }), [
    "value uses the g flag",
  ]);
  assert.deepEqual(qualifiedValueRuleProblems({ value: /96 mm/i, qualifier: /2AZ-FE/gi }), [
    "qualifier uses the g flag",
  ]);
  assert.deepEqual(qualifiedValueRuleProblems({ value: /96 mm/iy, qualifier: /2AZ-FE/i }), [
    "value uses the y flag",
  ]);
  assert.deepEqual(qualifiedValueRuleProblems({ value: /96 mm/i, qualifier: /2AZ-FE/iy }), [
    "qualifier uses the y flag",
  ]);
  assert.deepEqual(qualifiedValueRuleProblems({ value: /96 mm/i }), ["qualifier is missing"]);
});

test("OCR-recovered diagram evidence is represented in the suite (N1)", () => {
  // N0 recovered 114 scanned wiring diagrams through OCR and no eval case
  // touched one. OCR pages behave differently from clean text -- noisy tables,
  // near-duplicate titles, variant headers repeated inline -- so a retrieval or
  // chunking change can move them without anything else noticing.
  const hasDiagramCase = answerQualityCases.some((testCase) =>
    /wiring|diagram/i.test(testCase.question || "")
  );

  assert.ok(hasDiagramCase, "no eval case exercises an OCR-recovered diagram page");
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
