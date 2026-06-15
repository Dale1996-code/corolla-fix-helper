import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import request from "supertest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-repair-planner-"));

process.env.DATABASE_FILE = path.join(tempRoot, "test.db");
process.env.UPLOADS_DIR = path.join(tempRoot, "uploads");
process.env.PORT = "4200";
process.env.CLIENT_PORT = "5274";
process.env.OPENAI_API_KEY = "";

fs.mkdirSync(process.env.UPLOADS_DIR, { recursive: true });

const { createApp } = await import("../src/app.js");
const { db } = await import("../src/database.js");
const {
  extractRepairTasks,
  checkRepairReadiness,
  buildOwnerChecklist,
  draftHandoffNotes,
  searchRepairDocs,
} = await import("../src/services/agent/repairTools.js");
const { runRepairPlannerAgent, AI_NOT_CONFIGURED_MESSAGE } = await import(
  "../src/services/agent/repairPlannerAgent.js"
);
const { streamResponsesTurn } = await import(
  "../src/services/agent/openAiResponsesClient.js"
);

after(() => {
  if (typeof db.close === "function") {
    db.close();
  }
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

// --- Test helpers ----------------------------------------------------------

// The real retrieveRelevantChunks is async; mirror that here so the tools and
// agent loop are exercised against a Promise-returning retriever.
const mockRetrieve = async () => [
  {
    documentId: 7,
    pageNumber: 4,
    chunkIndex: 1,
    chunkText: "Front brake pad replacement: torque caliper bolts to 25 ft-lb and bleed the system.",
    documentTitle: "Brake Service Guide",
    originalFilename: "brake-guide.pdf",
  },
];

function createMockStreamTurn() {
  // Turn 1: request tool calls. Turn 2: stream the final narrative text.
  let turn = 0;

  return async function* mockStreamTurn() {
    turn += 1;

    if (turn === 1) {
      yield {
        type: "function_call",
        callId: "call_extract",
        name: "extract_repair_tasks",
        arguments: { brief: "Front brakes squeak. Replace pads." },
      };
      yield {
        type: "function_call",
        callId: "call_search",
        name: "search_repair_docs",
        arguments: { query: "front brake pad torque" },
      };
      yield {
        type: "function_call",
        callId: "call_ready",
        name: "check_repair_readiness",
        arguments: {
          tasks: [{ id: 1, title: "Replace front brake pads", difficulty: "intermediate", safetyFlags: ["x"] }],
          availableTools: "socket set",
          availableParts: "brake pads",
          skillLevel: "intermediate",
        },
      };
      return;
    }

    for (const piece of ["The brake job is the priority. ", "Torque to 25 ft-lb. ", "\nFollow-up questions: What is the mileage?"]) {
      yield { type: "text_delta", text: piece };
    }
  };
}

function parseSse(text) {
  return text
    .split("\n\n")
    .map((frame) => frame.trim())
    .filter((frame) => frame.startsWith("data:"))
    .map((frame) => JSON.parse(frame.slice(5).trim()));
}

// --- Tool unit tests -------------------------------------------------------

test("extract_repair_tasks splits a brief into system-tagged tasks", () => {
  const { tasks } = extractRepairTasks({
    brief: "Front brakes squeak when stopping.\nCoolant smell after long drives.",
  });

  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].system, "Brakes");
  assert.equal(tasks[1].system, "Cooling");
  assert.ok(tasks[0].safetyFlags.length >= 1);
  assert.ok(Array.isArray(tasks[0].keywords));
});

test("check_repair_readiness scores against the rubric and reports gaps", () => {
  const readyResult = checkRepairReadiness({
    tasks: [{ id: 1, title: "Replace cabin filter", difficulty: "beginner", safetyFlags: [] }],
    availableTools: "screwdriver",
    availableParts: "cabin filter",
    skillLevel: "beginner",
  });

  assert.equal(readyResult.score, 100);
  assert.equal(readyResult.level, "ready");
  assert.deepEqual(readyResult.gaps, []);

  const gapResult = checkRepairReadiness({
    tasks: [{ id: 1, title: "Replace timing chain", difficulty: "advanced", safetyFlags: [] }],
    availableTools: "",
    availableParts: "",
    skillLevel: "beginner",
  });

  assert.ok(gapResult.score < 50);
  assert.equal(gapResult.level, "not_ready");
  assert.ok(gapResult.gaps.length >= 3);
});

test("build_owner_checklist assigns DIY vs shop by difficulty and prioritizes", () => {
  const { checklist } = buildOwnerChecklist({
    tasks: [
      { id: 1, title: "Easy job", difficulty: "beginner" },
      { id: 2, title: "Hard job", difficulty: "advanced" },
    ],
    skillLevel: "beginner",
  });

  assert.equal(checklist[0].task, "Hard job");
  assert.equal(checklist[0].owner, "Professional shop");
  assert.equal(checklist[1].owner, "DIY");
  assert.ok(checklist[0].steps.length >= 3);
});

test("draft_handoff_notes produces three channel-specific drafts", () => {
  const notes = draftHandoffNotes({
    tasks: [{ id: 1, title: "Replace brake pads", system: "Brakes" }],
    vehicle: "2009 Toyota Corolla",
    partsNeeded: "brake pads, brake cleaner",
  });

  assert.match(notes.partsShoppingList, /brake pads/);
  assert.match(notes.mechanicHandoff, /Brakes/);
  assert.match(notes.maintenanceLogEntry, /planned/i);
});

test("search_repair_docs returns citations from the injected retriever", async () => {
  // Regression guard: searchRepairDocs must await the (async) retriever before
  // mapping chunks. Previously it called .map() on the returned Promise, which
  // threw with the real retrieveRelevantChunks and only passed because the mock
  // retriever was synchronous.
  const result = await searchRepairDocs({ query: "brake pad torque" }, { retrieve: mockRetrieve });

  assert.equal(result.citations.length, 1);
  assert.equal(result.citations[0].documentId, 7);
  assert.equal(result.citations[0].pageNumber, 4);
  assert.match(result.citations[0].snippet, /25 ft-lb/);
});

// --- Responses client glue test --------------------------------------------

test("streamResponsesTurn sends a non-empty model string in the request body", async () => {
  // Regression guard: the agent previously passed `config.openAiModel`, which
  // does not exist, so `model` was undefined and OpenAI rejected the request
  // with a 400. The existing tests all inject a mock `streamTurn`, so they
  // never exercised this glue. Here we drive the real client with an injected
  // `fetchImpl`, capture the request body, and assert a real model is sent.
  let capturedBody;

  const fakeFetch = async (_url, options) => {
    capturedBody = JSON.parse(options.body);

    const frame = new TextEncoder().encode(
      'data: {"type":"response.output_text.delta","delta":"ok"}\n\n'
    );
    let read = false;

    return {
      ok: true,
      body: {
        getReader() {
          return {
            read() {
              if (read) {
                return Promise.resolve({ value: undefined, done: true });
              }
              read = true;
              return Promise.resolve({ value: frame, done: false });
            },
            releaseLock() {},
          };
        },
      },
    };
  };

  const events = [];
  // Intentionally omit `model` so the client falls back to the config default,
  // which is exactly the path the agent uses.
  for await (const event of streamResponsesTurn({
    instructions: "test",
    input: [{ role: "user", content: "hi" }],
    tools: [],
    apiKey: "test-key",
    fetchImpl: fakeFetch,
  })) {
    events.push(event);
  }

  assert.equal(typeof capturedBody.model, "string");
  assert.ok(
    capturedBody.model.length > 0,
    "expected a non-empty model in the request body"
  );
  assert.ok(events.some((event) => event.type === "text_delta"));
});

// --- Agent loop tests ------------------------------------------------------

test("runRepairPlannerAgent emits tool events and text deltas and assembles artifacts", async () => {
  const events = [];

  const result = await runRepairPlannerAgent(
    { brief: "Front brakes squeak. Replace pads.", skillLevel: "intermediate" },
    {
      emit: (event) => events.push(event),
      streamTurn: createMockStreamTurn(),
      retrieve: mockRetrieve,
      isAiConfigured: true,
    }
  );

  const toolCallEvents = events.filter((event) => event.type === "tool_call");
  const textDeltaEvents = events.filter((event) => event.type === "text_delta");

  assert.ok(toolCallEvents.length >= 1, "expected at least one tool_call event");
  assert.ok(textDeltaEvents.length >= 1, "expected at least one text_delta event");

  assert.equal(result.status, "completed");
  assert.match(result.text, /brake job/);
  assert.equal(result.artifacts.tasks.length >= 1, true);
  assert.equal(result.artifacts.citations.length, 1);
  assert.ok(result.artifacts.readiness);
  assert.ok(events.some((event) => event.type === "trace"));
  assert.equal(events.at(-1).type, "done");
});

test("runRepairPlannerAgent reports ai_not_configured when no key is set", async () => {
  const events = [];

  const result = await runRepairPlannerAgent(
    { brief: "Replace brake pads." },
    { emit: (event) => events.push(event), isAiConfigured: false }
  );

  assert.equal(result.status, "ai_not_configured");
  assert.equal(events[0].type, "ai_not_configured");
  assert.equal(events[0].message, AI_NOT_CONFIGURED_MESSAGE);
});

// --- End-to-end SSE route test --------------------------------------------

test("POST /api/repair-plan streams >=1 tool event and >=1 text delta end-to-end", async () => {
  const runRepairPlan = (req, opts) =>
    runRepairPlannerAgent(req, {
      ...opts,
      streamTurn: createMockStreamTurn(),
      retrieve: mockRetrieve,
      isAiConfigured: true,
    });

  const app = createApp({ runRepairPlan });

  const response = await request(app)
    .post("/api/repair-plan")
    .send({ brief: "Front brakes squeak. Replace pads.", skillLevel: "intermediate" });

  assert.equal(response.status, 200);
  assert.match(response.headers["content-type"], /text\/event-stream/);

  const events = parseSse(response.text);
  const toolEvents = events.filter((event) => event.type === "tool_call" || event.type === "tool_result");
  const textDeltas = events.filter((event) => event.type === "text_delta");
  const doneEvent = events.find((event) => event.type === "done");

  assert.ok(toolEvents.length >= 1, "expected at least one tool event in the stream");
  assert.ok(textDeltas.length >= 1, "expected at least one text delta in the stream");
  assert.ok(doneEvent, "expected a done event");
  assert.equal(doneEvent.status, "completed");
  assert.ok(doneEvent.artifacts.citations.length >= 1);
});

test("POST /api/repair-plan validates a missing brief", async () => {
  const app = createApp();
  const response = await request(app).post("/api/repair-plan").send({ brief: "  " });

  assert.equal(response.status, 400);
  assert.equal(response.body.error, "A repair brief is required.");
});

test("POST /api/repair-plan streams ai_not_configured when no key is configured", async () => {
  const app = createApp();
  const response = await request(app)
    .post("/api/repair-plan")
    .send({ brief: "Replace the brake pads on the front axle." });

  assert.equal(response.status, 200);
  const events = parseSse(response.text);
  assert.ok(events.some((event) => event.type === "ai_not_configured"));
});
