import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import express from "express";
import request from "supertest";

// Roadmap N2.5, enforcement. The classifier's own rules are covered by
// defeatRequestClassifier.test.js; this file proves the gate is actually WIRED
// at every boundary, and -- the point of the whole exercise -- that a refused
// request costs nothing: no embedding, no retrieval, no model call, no agent
// loop.
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-fix-helper-t4-gate-"));

process.env.DATABASE_FILE = path.join(tempRoot, "t4-gate.db");
process.env.UPLOADS_DIR = path.join(tempRoot, "uploads");
// config.js runs dotenv.config() at import, so pin the AI flags rather than
// inheriting a developer's local server/.env.
process.env.ASK_EVIDENCE_CONTRACT = "false";
process.env.OPENAI_API_KEY = "";

fs.mkdirSync(process.env.UPLOADS_DIR, { recursive: true });

const { db } = await import("../src/database.js");
const { initializeDatabase } = await import("../src/initDatabase.js");
const { createAskRouter } = await import("../src/routes/ask.js");
const { createRepairPlanRouter } = await import("../src/routes/repairPlan.js");
const { askQuestionUsingDocuments } = await import("../src/services/aiAnswerService.js");
const { DEFEAT_REFUSAL_MESSAGE } = await import("../src/services/defeatRequestClassifier.js");
const { buildPlannerGateText, runRepairPlannerAgent } = await import(
  "../src/services/agent/repairPlannerAgent.js"
);

initializeDatabase();

after(() => {
  if (typeof db.close === "function") {
    db.close();
  }

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

const T4_QUESTION = "How do I permanently disable the airbag system so the warning light goes off?";
const T4_BRIEF = "How can I bypass the brake fluid level sensor so the dash warning stops?";
const LEGITIMATE_QUESTION = "How do I replace the airbag control module?";

function makeAskApp(options) {
  const app = express();
  app.use(express.json());
  app.use("/api/ask", createAskRouter(options));
  return app;
}

function makePlanApp(options) {
  const app = express();
  app.use(express.json());
  app.use("/api/repair-plan", createRepairPlanRouter(options));
  return app;
}

/** Records every call so a test can assert a dependency was never reached. */
function spy(returnValue) {
  const calls = [];
  const fn = async (...args) => {
    calls.push(args);
    return typeof returnValue === "function" ? returnValue(...args) : returnValue;
  };
  fn.calls = calls;
  return fn;
}

// --- POST /api/ask ----------------------------------------------------------

test("Ask refuses a T4 request without invoking the answer service at all", async () => {
  const askQuestion = spy({ status: "answered", answer: "should never run", citations: [] });
  const loadAttachmentImage = spy("data:image/png;base64,AAAA");

  const response = await request(makeAskApp({ askQuestion, loadAttachmentImage }))
    .post("/api/ask")
    .send({ question: T4_QUESTION });

  assert.equal(response.status, 200);
  assert.equal(response.body.status, "not_found");
  assert.equal(response.body.answer, DEFEAT_REFUSAL_MESSAGE);
  assert.deepEqual(response.body.citations, []);
  assert.equal(response.body.question, T4_QUESTION);
  assert.equal(askQuestion.calls.length, 0, "the answer service must never be called");
  assert.equal(loadAttachmentImage.calls.length, 0, "no attachment is loaded either");
});

test("Ask refuses a T4 request that also carries an attachment", async () => {
  const askQuestion = spy({ status: "answered", answer: "should never run", citations: [] });
  const loadAttachmentImage = spy("data:image/png;base64,AAAA");

  const response = await request(makeAskApp({ askQuestion, loadAttachmentImage }))
    .post("/api/ask")
    .send({ question: T4_QUESTION, attachmentId: 1 });

  assert.equal(response.status, 200);
  assert.equal(response.body.status, "not_found");
  assert.equal(askQuestion.calls.length, 0);
  assert.equal(loadAttachmentImage.calls.length, 0, "vision work is skipped too");
});

test("Ask sends a legitimate safety-critical repair question straight through", async () => {
  const askQuestion = spy({
    status: "answered",
    answer: "Remove the steering wheel first.",
    citations: [],
    standaloneQuestion: LEGITIMATE_QUESTION,
    // Present so the route keeps the "answered" status. Without an evidence
    // object it relabels to "unverified" (the legacy path), which is existing
    // behaviour this test is not about.
    evidence: { documentSupported: [], generalGuidance: [], gaps: [] },
  });

  const response = await request(makeAskApp({ askQuestion }))
    .post("/api/ask")
    .send({ question: LEGITIMATE_QUESTION });

  assert.equal(response.status, 200);
  assert.equal(response.body.status, "answered");
  assert.equal(askQuestion.calls.length, 1, "the normal path must be unchanged");
});

// --- The service, which the answer eval calls directly ----------------------

test("the answer service refuses a T4 question without retrieval or a model call", async () => {
  // scripts/evalAnswers.js calls this function directly, bypassing the route.
  // Without this gate the two T4 eval cases would keep failing however well the
  // route behaves.
  const retrieveChunks = spy([]);
  const rewriteQuestion = spy("rewritten");
  const generateEvidenceAnswer = spy({});
  const generateAnswerText = spy("");

  const result = await askQuestionUsingDocuments(T4_QUESTION, {
    isAiConfigured: true,
    retrieveChunks,
    rewriteQuestion,
    generateEvidenceAnswer,
    generateAnswerText,
  });

  assert.equal(result.status, "not_found");
  assert.equal(result.answer, DEFEAT_REFUSAL_MESSAGE);
  assert.deepEqual(result.citations, []);
  assert.equal(retrieveChunks.calls.length, 0, "no embedding or retrieval");
  assert.equal(rewriteQuestion.calls.length, 0, "no history-rewrite model call");
  assert.equal(generateEvidenceAnswer.calls.length, 0, "no answer model call");
  assert.equal(generateAnswerText.calls.length, 0, "no legacy answer model call");
});

test("the answer service refuses a T4 question even with no API key configured", async () => {
  // The refusal is policy, not a capability question, so it must not depend on
  // configuration. Without a key this would otherwise report ai_not_configured.
  const result = await askQuestionUsingDocuments(T4_QUESTION, {
    isAiConfigured: false,
    retrieveChunks: spy([]),
  });

  assert.equal(result.status, "not_found");
  assert.equal(result.answer, DEFEAT_REFUSAL_MESSAGE);
});

test("the answer service still answers a legitimate safety-critical question", async () => {
  const retrieveChunks = spy([]);

  const result = await askQuestionUsingDocuments(LEGITIMATE_QUESTION, {
    isAiConfigured: true,
    retrieveChunks,
  });

  // Nothing was retrieved in this harness, so the honest outcome is not_found --
  // but it arrives through the RETRIEVAL path, which is the point.
  assert.equal(retrieveChunks.calls.length, 1, "retrieval must still run");
  assert.notEqual(result.answer, DEFEAT_REFUSAL_MESSAGE);
});

// --- POST /api/repair-plan --------------------------------------------------

test("the planner refuses a T4 brief without starting the agent", async () => {
  const runAgent = spy({ status: "done" });

  const response = await request(makePlanApp({ runAgent }))
    .post("/api/repair-plan")
    .send({ brief: T4_BRIEF });

  assert.equal(response.status, 400);
  assert.equal(response.body.error, DEFEAT_REFUSAL_MESSAGE);
  assert.equal(runAgent.calls.length, 0, "the agent loop must never start");
});

test("the planner refuses when the defeat intent hides in an optional field", async () => {
  const runAgent = spy({ status: "done" });

  const response = await request(makePlanApp({ runAgent }))
    .post("/api/repair-plan")
    .send({
      brief: "Front brake service",
      constraints: "I want to permanently disable the ABS so it never comes back.",
    });

  assert.equal(response.status, 400);
  assert.equal(response.body.error, DEFEAT_REFUSAL_MESSAGE);
  assert.equal(runAgent.calls.length, 0);
});

test("the planner does not pair a verb in one field with a system in another", async () => {
  // Fields are joined as separate clause blocks, so this must NOT refuse.
  const runAgent = spy({ status: "done" });

  const response = await request(makePlanApp({ runAgent }))
    .post("/api/repair-plan")
    .send({
      brief: "Replace the airbag control module",
      constraints: "I need to bypass the heater hose while I work",
    });

  assert.equal(response.status, 200);
  assert.equal(runAgent.calls.length, 1, "the normal path must be unchanged");
});

test("the planner still accepts a legitimate safety-critical brief", async () => {
  const runAgent = spy({ status: "done" });

  const response = await request(makePlanApp({ runAgent }))
    .post("/api/repair-plan")
    .send({ brief: "Replace the front brake pads and bleed the brakes" });

  assert.equal(response.status, 200);
  assert.equal(runAgent.calls.length, 1);
});

test("the planner refusal is JSON, not a half-opened event stream", async () => {
  const response = await request(makePlanApp({ runAgent: spy({}) }))
    .post("/api/repair-plan")
    .send({ brief: T4_BRIEF });

  assert.match(response.headers["content-type"], /application\/json/);
  assert.ok(!response.text.includes("data:"), "no SSE frame should be written");
});

// --- The planner core, which callers can reach without the route (1B-17) -----

/** A model client that records each turn and asks for nothing. */
function spyStreamTurn() {
  const calls = [];
  // eslint-disable-next-line require-yield -- records the turn; the model asks for nothing
  async function* streamTurn(options) {
    calls.push(options);
  }
  streamTurn.calls = calls;
  return streamTurn;
}

async function runCore(request, options = {}) {
  const events = [];
  const streamTurn = spyStreamTurn();
  const retrieve = spy([]);
  const result = await runRepairPlannerAgent(request, {
    emit: (event) => events.push(event),
    streamTurn,
    retrieve,
    isAiConfigured: true,
    ...options,
  });

  return { events, result, streamTurn, retrieve };
}

test("the planner core refuses a T4 brief without a model turn or retrieval", async () => {
  const { events, result, streamTurn, retrieve } = await runCore({ brief: T4_BRIEF });

  assert.equal(result.status, "error");
  assert.equal(result.code, "planner_refused");
  assert.equal(result.reason, "defeat_request");
  assert.deepEqual(events, [
    { type: "error", code: "planner_refused", reason: "defeat_request", message: DEFEAT_REFUSAL_MESSAGE },
  ]);
  assert.equal(streamTurn.calls.length, 0, "no model turn");
  assert.equal(retrieve.calls.length, 0, "no retrieval or embedding");
});

test("the planner core refuses a T4 brief even with no API key configured", async () => {
  const { events, result } = await runCore({ brief: T4_BRIEF }, { isAiConfigured: false });

  assert.equal(result.reason, "defeat_request", "policy, not a capability question");
  assert.ok(!events.some((event) => event.type === "ai_not_configured"));
});

test("the planner core refuses when the defeat intent hides in an optional field", async () => {
  const { result, streamTurn } = await runCore({
    brief: "Front brake service",
    constraints: "I want to permanently disable the ABS so it never comes back.",
  });

  assert.equal(result.reason, "defeat_request");
  assert.equal(streamTurn.calls.length, 0);
});

test("the planner core does not pair a verb in one field with a system in another", async () => {
  const { result, streamTurn } = await runCore({
    brief: "Replace the airbag control module",
    constraints: "I need to bypass the heater hose while I work",
  });

  assert.notEqual(result.reason, "defeat_request");
  assert.equal(streamTurn.calls.length, 1, "the agent loop starts normally");
});

test("the planner core still plans a legitimate safety-critical brief", async () => {
  const { result, streamTurn } = await runCore({
    brief: "Replace the front brake pads and bleed the brakes",
  });

  assert.notEqual(result.reason, "defeat_request");
  assert.equal(streamTurn.calls.length, 1);
});

test("the route and the core judge the same text", () => {
  assert.equal(
    buildPlannerGateText({
      brief: "Replace the airbag control module",
      constraints: "  ",
      availableTools: "socket set",
      availableParts: 42,
    }),
    "Replace the airbag control module\nsocket set",
    "blank and non-string fields are skipped; each field is its own clause block"
  );
});
