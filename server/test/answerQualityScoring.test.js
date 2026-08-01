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
