import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

// Isolate to a scratch DB/uploads dir BEFORE importing anything that pulls in
// database.js (the eval module imports aiAnswerService -> chunkRetrievalService
// -> database.js, which opens config.databaseFile and runs PRAGMA journal_mode
// at import time). Without this, the suite would open the real dev DB and race
// with other un-isolated suites on the WAL pragma under `node --test`.
const tempRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "corolla-fix-helper-answer-quality-")
);

process.env.DATABASE_FILE = path.join(tempRoot, "answer-quality.db");
process.env.UPLOADS_DIR = path.join(tempRoot, "uploads");

const { evaluateAnswerCase, isRefusal, summarize } = await import(
  "../src/evals/answerQualityScoring.js"
);
// Case definitions only -- no corpus, no network. The deterministic preflight
// checks below score the two live-verified cases against fixed citation
// fixtures, so their specifications stay pinned in the normal unit suite.
const { answerQualityCases } = await import("../src/evals/answerQualityCases.js");
const { db } = await import("../src/database.js");

after(() => {
  if (typeof db.close === "function") {
    db.close();
  }

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("answered case passes when the value and a matching citation are present", () => {
  const testCase = {
    id: "torque",
    category: "torque",
    verified: true,
    expect: "answered",
    mustIncludeAny: [/\b37\s*N/i],
    citationDocLike: /oil/i,
  };
  const result = {
    status: "answered",
    answer: "The oil drain plug torque is 37 N·m (27 ft-lbf).",
    citations: [{ documentTitle: "Oil and Oil Filter Replacement", pageNumber: 1 }],
  };

  assert.equal(evaluateAnswerCase(testCase, result).pass, true);
});

test("answered case fails when the expected value is wrong", () => {
  const testCase = {
    id: "torque",
    category: "torque",
    verified: true,
    expect: "answered",
    mustIncludeAny: [/\b37\s*N/i],
  };
  const result = {
    status: "answered",
    answer: "The torque is 40 N·m.",
    citations: [{ documentTitle: "Oil" }],
  };

  assert.equal(evaluateAnswerCase(testCase, result).pass, false);
});

test("answered case fails when there is no citation", () => {
  const testCase = {
    id: "torque",
    category: "torque",
    verified: true,
    expect: "answered",
    mustIncludeAny: [/\b37\s*N/i],
  };
  const result = { status: "answered", answer: "37 N·m", citations: [] };

  assert.equal(evaluateAnswerCase(testCase, result).pass, false);
});

test("refusal case passes when the chatbot refuses", () => {
  const testCase = { id: "r", category: "refusal", verified: true, expect: "refused" };
  const result = { status: "not_found", answer: "not in documents", citations: [] };

  assert.equal(evaluateAnswerCase(testCase, result).pass, true);
  assert.equal(isRefusal(result), true);
});

test("refusal case fails when the chatbot answers anyway", () => {
  const testCase = { id: "r", category: "refusal", verified: true, expect: "refused" };
  const result = { status: "answered", answer: "It is 5 N·m.", citations: [{}] };

  assert.equal(evaluateAnswerCase(testCase, result).pass, false);
});

test("citationSupportsAny passes when a cited snippet contains a required term", () => {
  const testCase = {
    id: "torque",
    category: "torque",
    verified: false,
    expect: "answered",
    mustIncludeAny: [/\b37\s*N/i],
    citationSupportsAny: [/37\s*N/i],
  };
  const result = {
    status: "answered",
    answer: "The oil drain plug torque is 37 N·m.",
    citations: [
      { documentTitle: "Oil", snippet: "Drain plug tightening specification is 37 N·m." },
    ],
  };

  assert.equal(evaluateAnswerCase(testCase, result).pass, true);
});

test("citationSupportsAny fails when no cited snippet supports the required term", () => {
  const testCase = {
    id: "torque",
    category: "torque",
    verified: false,
    expect: "answered",
    mustIncludeAny: [/\b37\s*N/i],
    citationSupportsAny: [/37\s*N/i],
  };
  const result = {
    status: "answered",
    answer: "The oil drain plug torque is 37 N·m.",
    // The model asserted the value but the cited snippet does not contain it.
    citations: [{ documentTitle: "Oil", snippet: "Inspect the old washer before reuse." }],
  };

  const evaluated = evaluateAnswerCase(testCase, result);
  assert.equal(evaluated.pass, false);
  assert.ok(
    evaluated.checks.some(
      (check) => check.name.includes("cited snippet") && check.pass === false
    )
  );
});

test("multi-turn case checks the rewritten standalone question", () => {
  const testCase = {
    id: "m",
    category: "behavior",
    verified: false,
    expect: "answered",
    mustIncludeAny: [/water pump/i],
    mustCite: false,
    followUp: { question: "What about the torque?", standaloneIncludes: /water pump/i, mustCite: false },
  };
  const primary = { status: "answered", answer: "Replace the water pump...", citations: [{}] };
  const followUp = {
    status: "answered",
    answer: "Tighten to 11 N·m.",
    citations: [{}],
    standaloneQuestion: "What is the water pump torque specification?",
  };

  assert.equal(evaluateAnswerCase(testCase, primary, followUp).pass, true);
});

test("summary gates only on verified cases", () => {
  const results = [
    { id: "a", category: "torque", verified: true, pass: true },
    { id: "b", category: "capacity", verified: false, pass: false },
  ];
  const summary = summarize(results);

  assert.equal(summary.allVerifiedPass, true);
  assert.equal(summary.verifiedPassed, 1);
  assert.equal(summary.verifiedTotal, 1);
});

// ---- Cross-citation laundering ----

test("a document match and a value match from DIFFERENT citations no longer passes", () => {
  // Regression guard. Ask turns all eight retrieved chunks into citations, so
  // this shape is realistic: the oil document is cited but says nothing about
  // the value, while an unrelated document happens to contain "37 Nm".
  // Checking the two predicates independently passed this; requiring one
  // citation to satisfy both fails it.
  const laundered = evaluateAnswerCase(
    {
      id: "laundering-probe",
      category: "torque",
      expect: "answered",
      citationDocLike: /oil/i,
      citationSupportsAny: [/\b37\s*N/i],
    },
    {
      status: "answered",
      answer: "The oil drain plug torque is 37 Nm.",
      citations: [
        {
          documentTitle: "Oil and Oil Filter Replacement",
          pageNumber: 1,
          snippet: "Remove the oil filler cap and drain the oil into a container.",
        },
        {
          documentTitle: "Transmission Overhaul",
          pageNumber: 88,
          snippet: "Tighten the transaxle case bolts to 37 Nm.",
        },
      ],
    }
  );

  assert.equal(laundered.pass, false);
  const grounding = laundered.checks.find((check) => /one citation both cites/.test(check.name));
  assert.ok(grounding, "expected the conjunctive grounding check to run");
  assert.equal(grounding.pass, false);
});

test("a single citation satisfying both predicates still passes", () => {
  const grounded = evaluateAnswerCase(
    {
      id: "grounded-probe",
      category: "torque",
      expect: "answered",
      citationDocLike: /oil/i,
      citationSupportsAny: [/\b37\s*N/i],
    },
    {
      status: "answered",
      answer: "The oil drain plug torque is 37 Nm.",
      citations: [
        {
          documentTitle: "Transmission Overhaul",
          pageNumber: 88,
          snippet: "Unrelated content.",
        },
        {
          documentTitle: "Oil and Oil Filter Replacement",
          pageNumber: 1,
          snippet: "Clean and install the oil drain plug with a new gasket. Torque : 37 Nm.",
        },
      ],
    }
  );

  assert.equal(grounded.pass, true);
});

test("the conjunctive check also matches on originalFilename", () => {
  const grounded = evaluateAnswerCase(
    {
      id: "filename-probe",
      category: "torque",
      expect: "answered",
      citationDocLike: /oil/i,
      citationSupportsAny: [/\b37\s*N/i],
    },
    {
      status: "answered",
      answer: "37 Nm.",
      citations: [
        {
          documentTitle: "Untitled",
          originalFilename: "oil-and-filter.pdf",
          pageNumber: 1,
          snippet: "Torque : 37 Nm (377 kgf-cm, 27 ft-lbf)",
        },
      ],
    }
  );

  assert.equal(grounded.pass, true);
});

// ---- Deterministic preflight for the two live-verified cases ----
//
// The live gate (npm run eval:answers) needs the real corpus and an API key.
// These fixture-backed checks run in the normal unit suite with no database and
// no network, so the SPECIFICATIONS of the two verified cases stay pinned even
// when the live eval cannot run. They assert the scoring contract, not corpus
// contents -- the live-corpus evidence stays recorded on the cases themselves.

test("preflight: the oil-drain-plug citation-support case rejects a laundered citation", () => {
  const citationCase = answerQualityCases.find(
    (testCase) => testCase.id === "oil-drain-plug-torque-citation-support"
  );
  assert.ok(citationCase, "the citation-support case is missing");
  assert.equal(citationCase.verified, true);

  // A real chunk 14359 snippet grounds it...
  const grounded = evaluateAnswerCase(citationCase, {
    status: "answered",
    answer: "The oil drain plug torque is 37 Nm (27 ft-lbf).",
    citations: [
      {
        documentTitle: "Oil and Oil Filter Replacement [12 2007 ] (Engine Oil) ALLDATA diy",
        pageNumber: 1,
        snippet:
          "Clean and install the oil drain plug with a new gasket. Torque : 37 Nm (377 kgf-cm, 27 ft-lbf)",
      },
    ],
  });
  assert.equal(grounded.pass, true);

  // ...but an oil document with no figure, plus the figure from elsewhere, does not.
  const laundered = evaluateAnswerCase(citationCase, {
    status: "answered",
    answer: "The oil drain plug torque is 37 Nm (27 ft-lbf).",
    citations: [
      {
        documentTitle: "Oil change Precaution Instruction",
        pageNumber: 2,
        snippet: "Used engine oil contains harmful contaminants.",
      },
      {
        documentTitle: "Engine Mechanical Torque Specifications",
        pageNumber: 3,
        snippet: "Cylinder head x Cylinder block 37 Nm",
      },
    ],
  });
  assert.equal(laundered.pass, false);
});

test("preflight: the turbo refusal case is not satisfied by known distractor classes", () => {
  const turboCase = answerQualityCases.find(
    (testCase) => testCase.id === "refuse-turbo-boost-pressure"
  );
  assert.ok(turboCase, "the turbo refusal case is missing");
  assert.equal(turboCase.verified, true);
  assert.equal(turboCase.expect, "refused");

  // The corpus contains "turbo" and "boost" ONLY in these forms. If a future
  // change let any of them be answered as a boost-pressure spec, the case must
  // fail rather than quietly pass.
  const distractors = [
    "TC Turbocharger TCC Torque Converter Clutch", // SAE abbreviation glossary
    "BACS Boost Altitude Compensation System BAT Battery", // glossary
    "Check the brake booster function before driving.", // vacuum brake booster
    "CAC Charge Air Cooler Intercooler CARB Carburetor", // glossary
  ];

  for (const snippet of distractors) {
    const answered = evaluateAnswerCase(turboCase, {
      status: "answered",
      answer: `The turbocharger boost pressure specification is listed as ${snippet}`,
      citations: [{ documentTitle: "Glossary Of SAE and Toyota Terms", pageNumber: 3, snippet }],
    });

    assert.equal(
      answered.pass,
      false,
      `a refusal case must not pass when answered from distractor text: ${snippet}`
    );
  }

  // A genuine refusal passes.
  const refused = evaluateAnswerCase(turboCase, {
    status: "not_found",
    answer: "not in documents",
    citations: [],
  });
  assert.equal(refused.pass, true);
});

// ---- The evidence contract's `partial` status ----

test("partial counts as answered: a grounded answer that also reports gaps", () => {
  // Milestone 2 introduced `partial` (>=1 verified claim plus >=1 gap) after
  // this scorer was written. Rejecting it would penalize the contract for being
  // honest about what it could not support.
  const spec = {
    id: "partial-probe",
    category: "torque",
    expect: "answered",
    mustIncludeAny: [/\b37\s*N/i],
  };

  const partial = evaluateAnswerCase(spec, {
    status: "partial",
    answer: "The oil drain plug torque is 37 Nm.",
    citations: [{ documentTitle: "Oil Manual", pageNumber: 1, snippet: "Torque : 37 Nm" }],
  });

  assert.equal(partial.pass, true);
});

test("not_found still fails a case that expects an answer", () => {
  // The gate is not weakened: only `partial` was added, not `not_found`.
  const spec = {
    id: "notfound-probe",
    category: "torque",
    expect: "answered",
    mustIncludeAny: [/\b37\s*N/i],
  };

  const notFound = evaluateAnswerCase(spec, {
    status: "not_found",
    answer: "not in documents",
    citations: [],
  });

  assert.equal(notFound.pass, false);
});

test("partial does not excuse a missing value or citation", () => {
  const spec = {
    id: "partial-strict-probe",
    category: "torque",
    expect: "answered",
    mustIncludeAny: [/\b37\s*N/i],
  };

  const wrongValue = evaluateAnswerCase(spec, {
    status: "partial",
    answer: "The oil drain plug torque is 54 Nm.",
    citations: [{ documentTitle: "Oil Manual", pageNumber: 1, snippet: "..." }],
  });
  assert.equal(wrongValue.pass, false);

  const noCitation = evaluateAnswerCase(spec, {
    status: "partial",
    answer: "The oil drain plug torque is 37 Nm.",
    citations: [],
  });
  assert.equal(noCitation.pass, false);
});

// ---- expect: "rejected" (issue #107) ----
//
// A rejection is NOT a refusal. Both land on not_found, so the scorer has to
// look past the status: a refusal means retrieval found nothing, a rejection
// means a claim arrived with evidence and the verifier tore it out. Scoring them
// the same way would let a broken verifier pass as an honest miss.

const rejectionCase = (overrides = {}) => ({
  id: "reject-invented-drain-plug-torque",
  category: "verifier",
  expect: "rejected",
  expectedStatus: "not_found",
  requiredRejectedReasons: ["numeric_anomaly"],
  rejectionProbe: "numeric_anomaly",
  mustNotIncludeAny: [/999999/],
  ...overrides,
});

const rejectedResult = (overrides = {}) => ({
  status: "not_found",
  answer: "not in documents",
  citations: [],
  metrics: {
    rejectedCount: 1,
    rejected: [
      {
        channel: "documentSupported",
        itemIndex: 0,
        reason: "numeric_anomaly",
        sourceId: "S1",
        unsupportedSpecCount: 1,
      },
    ],
  },
  ...overrides,
});

test("a genuine verifier rejection passes", () => {
  const result = evaluateAnswerCase(rejectionCase(), rejectedResult());

  assert.equal(result.pass, true, JSON.stringify(result.checks, null, 2));
});

test("a rejected claim that reaches the owner as answered fails", () => {
  // The regression this case exists to catch.
  const result = evaluateAnswerCase(
    rejectionCase(),
    rejectedResult({
      status: "answered",
      answer: "The oil drain plug torque is 999999 N-m.",
      citations: [{ documentTitle: "Oil", snippet: "..." }],
    })
  );

  assert.equal(result.pass, false);
});

test("a rejection with no telemetry fails even when the status is right", () => {
  // Without metrics.rejected the run cannot tell this apart from a plain
  // retrieval miss, which is exactly the gap issue #107 opened on.
  const noMetrics = rejectedResult();
  delete noMetrics.metrics;

  const result = evaluateAnswerCase(rejectionCase(), noMetrics);

  assert.equal(result.pass, false);
  assert.ok(
    result.checks.some(
      (check) => check.name === "metrics report the rejection" && !check.pass
    )
  );
});

test("the wrong rejection reason fails", () => {
  const result = evaluateAnswerCase(
    rejectionCase(),
    rejectedResult({
      metrics: {
        rejectedCount: 1,
        rejected: [
          {
            channel: "documentSupported",
            itemIndex: 0,
            reason: "quote_not_in_source",
            sourceId: "S1",
            unsupportedSpecCount: 0,
          },
        ],
      },
    })
  );

  assert.equal(result.pass, false);
  assert.ok(
    result.checks.some(
      (check) => check.name === "metrics.rejected includes numeric_anomaly" && !check.pass
    )
  );
});

test("citations surviving a fully-rejected answer fail", () => {
  const result = evaluateAnswerCase(
    rejectionCase(),
    rejectedResult({ citations: [{ documentTitle: "Oil Manual", snippet: "..." }] })
  );

  assert.equal(result.pass, false);
});

test("the rejected value leaking anywhere in the response fails", () => {
  // Not just the answer text. A value that reappears in a gap or a citation
  // snippet is just as much on screen.
  const inGap = evaluateAnswerCase(
    rejectionCase(),
    rejectedResult({
      evidence: {
        documentSupported: [],
        generalGuidance: [],
        gaps: ["Unverified specification: the torque is 999999 N-m."],
      },
    })
  );

  assert.equal(inGap.pass, false);
  assert.ok(
    inGap.checks.some((check) => /appears nowhere/.test(check.name) && !check.pass)
  );
});

test("a rejection case never scores as an answered case", () => {
  // checkAnswered would happily pass a not_found with no citations if it were
  // ever routed there by mistake, so confirm the branch is chosen by `expect`.
  const checks = evaluateAnswerCase(rejectionCase(), rejectedResult()).checks;

  assert.ok(checks.some((check) => /status is not_found and not answered/.test(check.name)));
  assert.ok(!checks.some((check) => /has at least one citation/.test(check.name)));
});

// ---- N1: an answered case can forbid a claim, not only a rejection case ----

const applicabilityCase = () => ({
  id: "applicability",
  category: "capacity",
  verified: false,
  expect: "answered",
  mustIncludeAny: [/\b92\s*mm/i],
  mustNotIncludeAny: [/\b96\s*mm/i, /\b51\s*mm/i],
  citationDocLike: /alignment/i,
});

/**
 * The real shape of this evidence: one cited table listing BOTH engines. Any
 * assertion that scanned citations instead of the answer would fail here for
 * quoting the source correctly.
 */
const alignmentCitation = {
  documentTitle: "Alignment - Front Wheel Alignment - Adjustment",
  pageNumber: 2,
  snippet:
    "Vehicle Height (Unloaded Vehicle): for TMC Made 2ZR-FE 92 mm (3.62 in.) 45 mm (1.77 in.) " +
    "except TMC Made 2ZR-FE 92 mm 80 mm* 2AZ-FE 96 mm (3.78 in.) 81 mm* 51 mm (2.01 in.)",
};

test("an answered case passes when the answer names only this car's variant", () => {
  const result = {
    status: "answered",
    answer:
      "For the 1.8L 2ZR-FE the unloaded vehicle height is 92 mm (3.62 in.) at the front.",
    citations: [alignmentCitation],
  };

  assert.equal(evaluateAnswerCase(applicabilityCase(), result).pass, true);
});

test("an answered case fails when the answer asserts the other engine's figure", () => {
  // The applicability failure this field exists to catch: correctly retrieved,
  // correctly cited, and wrong for this car.
  const result = {
    status: "answered",
    answer: "The unloaded vehicle height is 96 mm (3.78 in.) at the front.",
    citations: [alignmentCitation],
  };

  const scored = evaluateAnswerCase(applicabilityCase(), result);

  assert.equal(scored.pass, false);
  assert.ok(
    scored.checks.some((check) => !check.pass && /does not assert/.test(check.name)),
    "the forbidden-claim check should be the one that failed"
  );
});

test("a citation may quote the wrong variant; only the answer may not assert it", () => {
  // Deliberate asymmetry with rejection cases, which scan the whole response.
  // Here the cited snippet contains 96 mm and 51 mm because the manual's table
  // really does, and showing the source honestly is not the failure.
  const result = {
    status: "answered",
    answer: "For your 2ZR-FE the figure is 92 mm; the 2AZ-FE row does not apply.",
    citations: [alignmentCitation],
  };

  assert.equal(evaluateAnswerCase(applicabilityCase(), result).pass, true);
  assert.match(alignmentCitation.snippet, /96 mm/);
});

test("the forbidden-claim check still runs alongside the conjunctive citation check", () => {
  // checkAnswered returns early once citationDocLike and citationSupportsAny are
  // both set. The forbidden-claim check must be evaluated before that return, or
  // it would silently vanish on exactly the strictest cases.
  const testCase = {
    ...applicabilityCase(),
    citationSupportsAny: [/\b92\s*mm/i],
  };
  const result = {
    status: "answered",
    answer: "The unloaded vehicle height is 96 mm.",
    citations: [alignmentCitation],
  };

  const scored = evaluateAnswerCase(testCase, result);

  assert.ok(
    scored.checks.some((check) => /does not assert/.test(check.name)),
    "the forbidden-claim check was skipped by the early return"
  );
  assert.equal(scored.pass, false);
});

test("cases without mustNotIncludeAny are scored exactly as before", () => {
  const { mustNotIncludeAny, ...withoutField } = applicabilityCase();
  const result = {
    status: "answered",
    answer: "The unloaded vehicle height is 92 mm, and the 2AZ-FE figure is 96 mm.",
    citations: [alignmentCitation],
  };

  assert.ok(mustNotIncludeAny, "the fixture should have had the field to remove");
  assert.equal(evaluateAnswerCase(withoutField, result).pass, true);
});

// ---- N1 preflight: every rejection case scores PASS on correct behavior ----
//
// These cases are marked verified:true without a live run, so something has to
// show they are not red for a mechanical reason -- a probe that trips a
// different check, a required reason the sanitizer strips, a sentinel that
// survives into the serialized response. This rebuilds the exact response shape
// aiAnswerService returns for an all-rejected answer and scores the real case
// definitions against it. No database, no network, no model.

const { verifyEvidence, deriveEvidenceStatus } = await import(
  "../src/services/askEvidenceContract.js"
);
const { buildRejectedMetrics, NOT_FOUND_MESSAGE } = await import(
  "../src/services/aiAnswerService.js"
);
const { createRejectionProbe } = await import("../src/evals/answerRejectionProbes.js");

/**
 * Retrieval as it really arrives: several chunks, the torque page not first.
 * Source labels are positional, so this also proves a case does not quietly
 * depend on one document ranking top.
 */
const retrievedChunks = () => [
  {
    documentId: 748,
    documentTitle: "Oil and Oil Filter Replacement",
    originalFilename: "oil.pdf",
    pageNumber: 1,
    chunkIndex: 2,
    chunkText: "engine oil. Do not use gasoline, thinners or solvents.",
  },
  {
    documentId: 748,
    documentTitle: "Oil and Oil Filter Replacement",
    originalFilename: "oil.pdf",
    pageNumber: 1,
    chunkIndex: 3,
    chunkText:
      "Clean and install the oil drain plug with a new gasket. Torque : 37 Nm " +
      "(377 kgf-cm, 27 ft-lbf) 2. REMOVE OIL FILTER CAP ASSEMBLY",
  },
];

/** The response askQuestionUsingDocuments builds once every claim is rejected. */
async function runRejectionCaseThroughPipeline(testCase) {
  const chunks = retrievedChunks();
  const reply = await createRejectionProbe(testCase.rejectionProbe)({ chunks });
  const verified = verifyEvidence(reply, chunks);
  const status = deriveEvidenceStatus(verified);

  return {
    status,
    answer: status === "not_found" ? NOT_FOUND_MESSAGE : "(rendered answer)",
    citations: status === "not_found" ? [] : [{ documentTitle: "Oil", pageNumber: 1 }],
    standaloneQuestion: testCase.question,
    evidence: {
      documentSupported: verified.documentSupported,
      generalGuidance: verified.generalGuidance,
      gaps: verified.gaps,
    },
    metrics: { rejected: buildRejectedMetrics(verified.rejected) },
  };
}

test("preflight: every verified rejection case passes on correct pipeline behavior", async () => {
  const rejectionCases = answerQualityCases.filter(
    (testCase) => testCase.expect === "rejected" && testCase.verified
  );

  assert.equal(rejectionCases.length, 6, "expected all six rejection reasons to be gated");

  for (const testCase of rejectionCases) {
    const result = await runRejectionCaseThroughPipeline(testCase);
    const scored = evaluateAnswerCase(testCase, result);
    const failed = scored.checks.filter((check) => !check.pass);

    assert.equal(
      scored.pass,
      true,
      `${testCase.id} would fail: ${failed.map((c) => `${c.name} (${c.detail})`).join("; ")}`
    );
  }
});

test("preflight: a rejection case fails if its own reason stops being reported", async () => {
  // Proves the assertion above is load-bearing rather than vacuously true.
  const testCase = answerQualityCases.find(
    (entry) => entry.id === "reject-wrong-component-torque"
  );
  const result = await runRejectionCaseThroughPipeline(testCase);

  assert.equal(evaluateAnswerCase(testCase, { ...result, metrics: { rejected: [] } }).pass, false);
});

test("preflight: the wrong-component case fails if the value survives beside the part", async () => {
  // The redaction this case exists to guard. If a gap ever reprinted the torque
  // next to the part name the claim invented, this must go red.
  const testCase = answerQualityCases.find(
    (entry) => entry.id === "reject-wrong-component-torque"
  );
  const result = await runRejectionCaseThroughPipeline(testCase);
  const leaked = {
    ...result,
    evidence: {
      ...result.evidence,
      gaps: ["Unverified: The flux capacitor mounting bolt torque is 37 Nm."],
    },
  };

  assert.equal(evaluateAnswerCase(testCase, result).pass, true);
  assert.equal(evaluateAnswerCase(testCase, leaked).pass, false);
});

// ---- qualifiedValues: "this value only when this condition is stated with it" ----
//
// Added after the 2026-08-20 live run, which failed
// applicability-vehicle-height-wrong-engine on an answer that was CORRECT. The
// positive controls below are the real answer text from that run, trimmed, so
// these tests pin the instrument against observed behaviour rather than against
// a sentence invented to make the rule pass.

const vehicleHeightCase = () =>
  answerQualityCases.find((entry) => entry.id === "applicability-vehicle-height-wrong-engine");
const engineMountCase = () =>
  answerQualityCases.find((entry) => entry.id === "applicability-engine-mount-build-variant");

const alignmentCitations = [
  {
    documentTitle: "Alignment Service and Repair Procedures Front Wheel Alignment Adjustment",
    pageNumber: 2,
    snippet:
      "Vehicle Height (Unloaded Vehicle): for TMC Made 2ZR-FE 92 mm (3.62 in.) 45 mm (1.77 in.) " +
      "except TMC Made 2ZR-FE 92 mm 80 mm* 2AZ-FE 96 mm (3.78 in.) 81 mm* 51 mm (2.01 in.)",
  },
];
const torqueCitations = [
  {
    documentTitle: "torque Engine Mechanical Torque Specifications (Engine) ALLDATA diy",
    pageNumber: 1,
    snippet:
      "Front engine mounting insulator x Front crossmember for TMMT made 81 826 60 for TMC made 52 520 38",
  },
];

const answered = (answer, citations) => ({ status: "partial", answer, citations });
const failedChecks = (scored) => scored.checks.filter((check) => !check.pass).map((c) => c.name);

// Verbatim from the 2026-08-20 run (claim lines, citation markers removed).
const LIVE_VEHICLE_HEIGHT_ANSWER = [
  "Before inspecting front wheel alignment, adjust the vehicle height to the specified value.",
  "For TMC Made 2ZR-FE, unloaded vehicle height is Front C - A 92 mm (3.62 in.).",
  "For TMC Made 2ZR-FE, unloaded vehicle height is Rear D - B 45 mm (1.77 in.).",
  "For except TMC Made 2ZR-FE, unloaded vehicle height is Front C - A 92 mm (3.62 in.).",
  "For except TMC Made 2ZR-FE Mexico vehicle height, Front C - A is 80 mm (3.15 in.).",
  "For 2AZ-FE, unloaded vehicle height is Front C - A 96 mm (3.78 in.).",
  "For 2AZ-FE, unloaded vehicle height is Rear D - B 51 mm (2.01 in.).",
  "For vehicle height for Mexico, add 15 mm (0.591 in.).",
].join("\n");

test("vehicle height: the real multi-variant live answer now PASSES", () => {
  // The regression this rule exists to undo. Under the old mustNotIncludeAny
  // this exact answer failed three checks for correctly reporting the 2AZ-FE row.
  const scored = evaluateAnswerCase(
    vehicleHeightCase(),
    answered(LIVE_VEHICLE_HEIGHT_ANSWER, alignmentCitations)
  );

  assert.equal(scored.pass, true, `unexpected failures: ${failedChecks(scored).join("; ")}`);
});

test("vehicle height: the wrong engine's figure asserted BARE fails", () => {
  const scored = evaluateAnswerCase(
    vehicleHeightCase(),
    answered(
      "The unloaded vehicle height is 92 mm (3.62 in.) at the front and 96 mm at the rear.",
      alignmentCitations
    )
  );

  assert.equal(scored.pass, false);
  assert.ok(
    failedChecks(scored).some((name) => /never states .*96/.test(name)),
    `expected the 96 mm qualification check to fail, got: ${failedChecks(scored).join("; ")}`
  );
});

test("vehicle height: naming the other engine elsewhere does not launder a bare value", () => {
  // The hole a whole-answer scan would leave: mention 2AZ-FE in one sentence and
  // assert its number, unconditioned, in another.
  const scored = evaluateAnswerCase(
    vehicleHeightCase(),
    answered(
      "This car may be a 2ZR-FE or a 2AZ-FE. The unloaded vehicle height is 92 mm. " +
        "The rear figure is 51 mm.",
      alignmentCitations
    )
  );

  assert.equal(scored.pass, false);
  assert.ok(failedChecks(scored).some((name) => /never states .*51/.test(name)));
});

test("vehicle height: an answer giving ONLY this car's figures passes", () => {
  // The alternate values are permitted, not required. A correct narrow answer
  // must not be punished for omitting the other engine.
  const scored = evaluateAnswerCase(
    vehicleHeightCase(),
    answered(
      "For the 2ZR-FE, the unloaded vehicle height is 92 mm (3.62 in.) at the front.",
      alignmentCitations
    )
  );

  assert.equal(scored.pass, true, `unexpected failures: ${failedChecks(scored).join("; ")}`);
});

test("engine mount: both associations stated correctly PASSES", () => {
  // Verbatim shape from the 2026-08-20 run.
  const scored = evaluateAnswerCase(
    engineMountCase(),
    answered(
      "The torque for the front engine mounting insulator to the front crossmember is " +
        "81 N·m (826 kgf·cm, 60 ft·lbf) for TMMT-made vehicles.\n" +
        "The torque for the front engine mounting insulator to the front crossmember is " +
        "52 N·m (520 kgf·cm, 38 ft·lbf) for TMC-made vehicles.",
      torqueCitations
    )
  );

  assert.equal(scored.pass, true, `unexpected failures: ${failedChecks(scored).join("; ")}`);
});

test("engine mount: only the TMMT variant fails", () => {
  const scored = evaluateAnswerCase(
    engineMountCase(),
    answered("The torque is 81 N·m (60 ft·lbf) for TMMT-made vehicles.", torqueCitations)
  );

  assert.equal(scored.pass, false);
  assert.ok(failedChecks(scored).some((name) => /states 52 N\*m/.test(name)));
});

test("engine mount: only the TMC variant fails", () => {
  const scored = evaluateAnswerCase(
    engineMountCase(),
    answered("The torque is 52 N·m (38 ft·lbf) for TMC-made vehicles.", torqueCitations)
  );

  assert.equal(scored.pass, false);
  assert.ok(failedChecks(scored).some((name) => /states 81 N\*m/.test(name)));
});

test("engine mount: the values swapped between plants fails", () => {
  // Both numbers, both plants, every token the old rule looked for -- and
  // dangerously wrong. This is the case the old mustIncludeAny could not see.
  const scored = evaluateAnswerCase(
    engineMountCase(),
    answered(
      "The torque is 81 N·m for TMC-made vehicles.\nThe torque is 52 N·m for TMMT-made vehicles.",
      torqueCitations
    )
  );

  assert.equal(scored.pass, false);
  const failed = failedChecks(scored);
  assert.ok(failed.some((name) => /never states .*81/.test(name)), failed.join("; "));
  assert.ok(failed.some((name) => /never states .*52/.test(name)), failed.join("; "));
});

test("engine mount: both numbers with no plant attached fails", () => {
  const scored = evaluateAnswerCase(
    engineMountCase(),
    answered("The torque is 81 N·m, or 52 N·m depending on the vehicle.", torqueCitations)
  );

  assert.equal(scored.pass, false);
  // Assert WHY. Both values are present, so this must fail on the missing
  // conditions rather than on some unrelated requirement.
  const failed = failedChecks(scored);
  assert.ok(failed.some((name) => /never states .*81/.test(name)), failed.join("; "));
  assert.ok(failed.some((name) => /never states .*52/.test(name)), failed.join("; "));
});

test("engine mount: one bare number presented as universal fails", () => {
  const scored = evaluateAnswerCase(
    engineMountCase(),
    answered("The front engine mounting insulator torque is 52 N·m (38 ft·lbf).", torqueCitations)
  );

  assert.equal(scored.pass, false);
  // Distinct from "only the TMC variant fails", which drops 81 while qualifying
  // 52 correctly. Here the stated value is itself unconditioned, so the
  // qualification check must be among the failures -- not just the missing 81.
  const failed = failedChecks(scored);
  assert.ok(failed.some((name) => /never states .*52/.test(name)), failed.join("; "));
  assert.ok(failed.some((name) => /states 81 N\*m/.test(name)), failed.join("; "));
});

test("engine mount: a plant named without its value does not satisfy the rule", () => {
  // Exactly what the old rule accepted: the vocabulary without the structure.
  const scored = evaluateAnswerCase(
    engineMountCase(),
    answered(
      "The torque depends on whether the vehicle is TMC-made or TMMT-made; it is 52 N·m.",
      torqueCitations
    )
  );

  assert.equal(scored.pass, false, "mentioning both plants must not be enough");
});

test("qualifiedValues is inert on cases that do not use it", () => {
  const scored = evaluateAnswerCase(
    { id: "plain", category: "torque", expect: "answered", mustIncludeAny: [/\b37\s*N/i] },
    answered("The oil drain plug torque is 37 N·m.", [{ documentTitle: "Oil", pageNumber: 1 }])
  );

  assert.equal(scored.pass, true);
  assert.ok(!scored.checks.some((check) => /never states/.test(check.name)));
});

test("qualifiedValues survives decimals and bracketed units when segmenting", () => {
  // "3.78 in.)" must not split into fragments that separate a value from its
  // qualifier -- the reason the splitter keys on punctuation FOLLOWED BY space.
  const scored = evaluateAnswerCase(
    vehicleHeightCase(),
    answered(
      "For 2AZ-FE, unloaded vehicle height is Front C - A 96 mm (3.78 in.). " +
        "For 2ZR-FE it is 92 mm (3.62 in.).",
      alignmentCitations
    )
  );

  assert.equal(scored.pass, true, `unexpected failures: ${failedChecks(scored).join("; ")}`);
});

// ---- review fixes: segmentation, competing qualifiers, stateful flags ----

test("segmentation: an abbreviation does not orphan a value from its qualifier", () => {
  // These manuals say "No. 1 lower suspension arm bushing" and answers restate
  // it. Splitting on every period-space cut this sentence in two and failed a
  // correctly qualified statement -- a false FAIL of exactly the kind this case
  // was repaired to stop producing.
  const scored = evaluateAnswerCase(
    vehicleHeightCase(),
    answered(
      "For the 2ZR-FE the height is 92 mm. For 2AZ-FE, the No. 1 bushing clearance is 96 mm.",
      alignmentCitations
    )
  );

  assert.equal(scored.pass, true, `unexpected failures: ${failedChecks(scored).join("; ")}`);
});

test("segmentation: a real sentence boundary still separates value from qualifier", () => {
  // The other half of the same fix: making abbreviations safe must not make
  // sentence ends permissive, or the laundering control below stops working.
  const scored = evaluateAnswerCase(
    vehicleHeightCase(),
    answered(
      "This car may be a 2ZR-FE or a 2AZ-FE. The unloaded vehicle height is 92 mm. " +
        "The rear figure is 51 mm.",
      alignmentCitations
    )
  );

  assert.equal(scored.pass, false);
  assert.ok(failedChecks(scored).some((name) => /never states .*51/.test(name)));
});

test("engine mount: a ONE-SENTENCE swap fails, not only a two-sentence one", () => {
  // The defect the review found. Same segment, both values, both plants, and
  // exactly backwards -- membership alone accepted it. No distance bound could
  // reject it either: TMMT sits 31 characters from "81 N" both here and in the
  // correct live answer. The competing qualifier being NEARER is the signal.
  const scored = evaluateAnswerCase(
    engineMountCase(),
    answered(
      "The torque is 81 N·m for TMC-made and 52 N·m for TMMT-made vehicles.",
      torqueCitations
    )
  );

  assert.equal(scored.pass, false, "a one-sentence swap must not pass");
  const failed = failedChecks(scored);
  assert.ok(failed.some((name) => /never states .*81/.test(name)), failed.join("; "));
  assert.ok(failed.some((name) => /never states .*52/.test(name)), failed.join("; "));
});

test("engine mount: a ONE-SENTENCE correct pairing still passes", () => {
  // Guards against over-correcting: the fix must reject the swap without
  // rejecting the same structure stated the right way round.
  const scored = evaluateAnswerCase(
    engineMountCase(),
    answered(
      "The torque is 81 N·m for TMMT-made and 52 N·m for TMC-made vehicles.",
      torqueCitations
    )
  );

  assert.equal(scored.pass, true, `unexpected failures: ${failedChecks(scored).join("; ")}`);
});

test("qualifiedValues rules sharing one qualifier do not compete with each other", () => {
  // The vehicle-height case writes /2AZ-FE/i three times. Three separate regex
  // literals with the same source are one condition, not three rivals -- if they
  // were compared by object identity, every rule would treat the others as
  // competing and the case could never pass.
  const scored = evaluateAnswerCase(
    vehicleHeightCase(),
    answered(
      "For 2AZ-FE the front height is 96 mm (3.78 in.) and the rear is 51 mm.\n" +
        "For the 2ZR-FE it is 92 mm.",
      alignmentCitations
    )
  );

  assert.equal(scored.pass, true, `unexpected failures: ${failedChecks(scored).join("; ")}`);
});

test("a global-flag pattern cannot silently hide an unqualified statement", () => {
  // Proven in review: with /g, lastIndex carries between sentences, the scanner
  // starts the next one mid-string, misses the bare "It is 96 mm." and reports
  // PASS. The scorer now builds its own non-global scanner, so the verdict is
  // the same either way -- and case definitions are rejected outright for
  // declaring the flag (answerQualityCases.test.js).
  const answerText = "For 2AZ-FE the front figure measured at the wheel centre is 96 mm. It is 96 mm.";
  const build = (value) => ({
    id: "flags",
    category: "capacity",
    expect: "answered",
    mustCite: false,
    qualifiedValues: [{ value, qualifier: /2AZ-FE/i }],
  });

  const withGlobal = evaluateAnswerCase(build(/96 mm/gi), answered(answerText, []));
  const withoutGlobal = evaluateAnswerCase(build(/96 mm/i), answered(answerText, []));

  assert.equal(withoutGlobal.pass, false, "the bare statement must fail");
  assert.equal(withGlobal.pass, false, "a global pattern must not change the verdict");
});

// ---- the laundering hole the capital-lookahead segmentation opened ----
//
// Requiring the next sentence to start with a capital fixed "No. 1" but stopped
// splitting sentences that open with a digit or a lowercase word, so a stale
// qualifier from the previous sentence silently qualified a bare value. These
// two are the controls that keep that hole shut; they FAILED to fail before the
// splitter was changed to exclude "No." instead.

test("segmentation: a sentence starting with a DIGIT still ends the previous one", () => {
  // "92 mm is the front figure." is entirely natural phrasing here, so this is
  // not a contrived shape.
  const scored = evaluateAnswerCase(
    vehicleHeightCase(),
    answered(
      "For the 2ZR-FE it is 92 mm. This car may be a 2AZ-FE. 96 mm is the front figure.",
      alignmentCitations
    )
  );

  assert.equal(scored.pass, false, "a bare value must not borrow the previous sentence's qualifier");
  assert.ok(failedChecks(scored).some((name) => /never states .*96/.test(name)));
});

test("segmentation: a sentence starting LOWERCASE still ends the previous one", () => {
  const scored = evaluateAnswerCase(
    vehicleHeightCase(),
    answered(
      "For the 2ZR-FE it is 92 mm. This car may be a 2AZ-FE. the front figure is 96 mm.",
      alignmentCitations
    )
  );

  assert.equal(scored.pass, false);
  assert.ok(failedChecks(scored).some((name) => /never states .*96/.test(name)));
});
