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
