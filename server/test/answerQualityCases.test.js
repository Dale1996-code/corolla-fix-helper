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
];

const VALID_CATEGORIES = new Set([
  "torque",
  "capacity",
  "procedure",
  "refusal",
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
  for (const testCase of answerQualityCases) {
    assert.ok(testCase.id, "case is missing an id");
    assert.ok(VALID_CATEGORIES.has(testCase.category), `bad category on ${testCase.id}`);
    assert.ok(
      testCase.expect === "answered" || testCase.expect === "refused",
      `bad expect on ${testCase.id}`
    );
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
