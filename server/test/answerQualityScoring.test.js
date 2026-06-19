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
