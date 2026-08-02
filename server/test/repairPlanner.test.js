import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import request from "supertest";

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
  createToolRegistry,
  repairToolSchemas,
} = await import("../src/services/agent/repairTools.js");
const { runRepairPlannerAgent, AI_NOT_CONFIGURED_MESSAGE } = await import(
  "../src/services/agent/repairPlannerAgent.js"
);
const { streamResponsesTurn } = await import(
  "../src/services/agent/openAiResponsesClient.js"
);
const { createRepairPlanRouter } = await import("../src/routes/repairPlan.js");

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
        // A brief the model made up. The server ignores it and returns the
        // canonical list derived from the owner's real brief.
        arguments: { brief: "Detail the paint." },
      };
      yield {
        type: "function_call",
        callId: "call_search",
        name: "search_repair_docs",
        arguments: { taskId: 1, query: "front brake pad torque" },
      };
      yield {
        type: "function_call",
        callId: "call_ready",
        name: "check_repair_readiness",
        // Every one of these is a trusted owner input the model must not be
        // able to set. They are ignored; the trusted context supplies the real
        // values. See the trust-boundary tests below.
        arguments: {
          tasks: [{ id: 1, title: "Replace front brake pads", difficulty: "intermediate", safetyFlags: ["x"] }],
          availableTools: "socket set",
          availableParts: "brake pads",
          skillLevel: "advanced",
          ackSafety: true,
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

// Drives the SSE route with fake req/res EventEmitters so disconnect wiring can
// be exercised deterministically (supertest cannot model a mid-stream abort).
// The express Router returned by createRepairPlanRouter is itself a callable
// `(req, res, next)` middleware.
function invokeRoute(runAgent, body) {
  const router = createRepairPlanRouter({ runAgent });

  const req = new EventEmitter();
  req.method = "POST";
  req.url = "/";
  req.headers = {};
  req.body = body;

  const frames = [];
  const res = new EventEmitter();
  res.writableFinished = false;
  res.writeHead = () => res;
  res.write = (chunk) => {
    frames.push(String(chunk));
    return true;
  };

  let resolveFinished;
  const finished = new Promise((resolve) => {
    resolveFinished = resolve;
  });
  res.end = () => {
    if (!res.writableFinished) {
      res.writableFinished = true;
      res.emit("finish");
      res.emit("close");
    }
    resolveFinished();
  };

  router(req, res, (error) => {
    if (error) {
      throw error;
    }
  });

  return { req, res, frames, finished };
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

// --- Safety guardrail tests ------------------------------------------------

test("safety-critical work cannot be marked Ready + DIY without acknowledgment", () => {
  const tasks = [
    {
      id: 1,
      title: "Replace front brake pads and rotors",
      system: "Brakes",
      difficulty: "beginner",
      safetyFlags: ["Brake work affects stopping safety."],
    },
  ];

  const readiness = checkRepairReadiness({
    tasks,
    availableTools: "socket set, torque wrench",
    availableParts: "brake pads, rotors",
    skillLevel: "beginner",
  });

  const { checklist } = buildOwnerChecklist({ tasks, skillLevel: "beginner" });

  // Even with tools, parts, and a matching skill level, brake work must not be
  // presented as Ready + DIY unless the owner explicitly accepts the risk.
  assert.equal(readiness.safetyCritical, true);
  assert.notEqual(readiness.level, "ready");
  assert.equal(checklist[0].owner, "Shop Recommended");
});

test("acknowledging safety-critical work unlocks Ready + DIY", () => {
  const tasks = [
    {
      id: 1,
      title: "Replace front brake pads",
      system: "Brakes",
      difficulty: "beginner",
      safetyFlags: ["Brake work affects stopping safety."],
    },
  ];

  const readiness = checkRepairReadiness({
    tasks,
    availableTools: "socket set, torque wrench",
    availableParts: "brake pads",
    skillLevel: "beginner",
    ackSafety: true,
  });

  const { checklist } = buildOwnerChecklist({
    tasks,
    skillLevel: "beginner",
    ackSafety: true,
  });

  assert.equal(readiness.level, "ready");
  assert.equal(checklist[0].owner, "DIY");
});

test("listing tools and parts alone does not award the safety sub-score", () => {
  const readiness = checkRepairReadiness({
    tasks: [
      {
        id: 1,
        title: "Bleed the brakes",
        system: "Brakes",
        difficulty: "beginner",
        safetyFlags: ["Brake work affects stopping safety."],
      },
    ],
    availableTools: "wrench, bleeder kit",
    availableParts: "brake fluid",
    skillLevel: "beginner",
  });

  const safetyItem = readiness.rubric.find((item) => item.id === "safety_reviewed");
  assert.equal(safetyItem.met, false);
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

test("search_repair_docs treats non-array retriever results as no citations", async () => {
  const result = await searchRepairDocs(
    { query: "brake pad torque" },
    { retrieve: async () => null }
  );

  assert.deepEqual(result.citations, []);
  assert.equal(result.context, "");
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
      'data: {"type":"response.output_text.delta","delta":"ok"}\n\n' +
        'data: {"type":"response.completed"}\n\n'
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

test("runRepairPlannerAgent returns a tool error result when one tool throws", async () => {
  const events = [];
  let sawToolErrorOutput = false;

  async function* streamTurn({ input }) {
    const toolOutput = input.find(
      (item) => item.type === "function_call_output" && item.call_id === "call_search"
    );

    if (toolOutput) {
      sawToolErrorOutput = JSON.parse(toolOutput.output).error.includes("database timeout");
      yield { type: "text_delta", text: "The document search failed, but planning continued." };
      return;
    }

    yield {
      type: "function_call",
      callId: "call_search",
      name: "search_repair_docs",
      arguments: { taskId: 1, query: "front brake pad torque" },
    };
  }

  const result = await runRepairPlannerAgent(
    { brief: "Front brakes squeak. Replace pads." },
    {
      emit: (event) => events.push(event),
      streamTurn,
      retrieve: async () => {
        throw new Error("database timeout");
      },
      isAiConfigured: true,
      maxTurns: 2,
    }
  );

  const toolResult = events.find((event) => event.type === "tool_result");

  assert.equal(result.status, "completed");
  assert.ok(toolResult);
  assert.match(toolResult.summary, /database timeout/);
  assert.equal(sawToolErrorOutput, true);
  assert.match(result.text, /planning continued/);
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

test("POST /api/repair-plan rejects an unrecognized skill level", async () => {
  const app = createApp();

  // Skill drives 30 of the 100 readiness points and the DIY vs shop split.
  // Silently falling back to "beginner" would score the owner against a level
  // they did not choose.
  const response = await request(app)
    .post("/api/repair-plan")
    .send({ brief: "Replace the front brake pads.", skillLevel: "expert" });

  assert.equal(response.status, 400);
  assert.match(response.body.error, /skillLevel/);

  for (const skillLevel of ["beginner", "intermediate", "advanced"]) {
    const accepted = await request(app)
      .post("/api/repair-plan")
      .send({ brief: "Replace the front brake pads.", skillLevel });

    assert.notEqual(accepted.status, 400, `"${skillLevel}" must be accepted`);
  }
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

// --- Disconnect handling regression tests ----------------------------------

test("repair-plan route does not abort the agent when the request body completes", async () => {
  // Regression guard: the route used to call abortController.abort() on the
  // request's "close" event, which Node fires as soon as the POST body has been
  // read — not on disconnect. That cancelled the in-flight OpenAI request and
  // surfaced as a spurious "This operation was aborted" error.
  let capturedSignal;

  const runAgent = async (_req, { emit, signal }) => {
    capturedSignal = signal;
    // Yield to the event loop so any spurious request "close" abort would land.
    await new Promise((resolve) => setTimeout(resolve, 20));
    emit({ type: "done", status: "completed", text: "Plan ready.", artifacts: {} });
  };

  const { req, frames, finished } = invokeRoute(runAgent, { brief: "Front brakes squeak." });

  // Simulate Node emitting the request's "close" once the body is parsed.
  req.emit("close");

  await finished;

  assert.equal(capturedSignal.aborted, false, "the agent signal must not abort on normal body completion");
  assert.ok(
    frames.some((frame) => frame.includes('"type":"done"')),
    "expected a done frame to reach the client"
  );
  assert.ok(
    !frames.some((frame) => frame.includes('"type":"error"')),
    "a completed request must not produce an error frame"
  );
});

test("repair-plan route aborts the agent on a real client disconnect without an error frame", async () => {
  let capturedSignal;

  const runAgent = async (_req, { emit, signal }) => {
    capturedSignal = signal;
    emit({ type: "status", message: "Analyzing repair brief..." });
    // Model in flight: resolve only once the client disconnect aborts us.
    await new Promise((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
  };

  const { res, frames, finished } = invokeRoute(runAgent, { brief: "Front brakes squeak." });

  // Let the handler register its response "close" listener and start the agent.
  await new Promise((resolve) => setTimeout(resolve, 0));

  // The client goes away before the response finished streaming.
  res.emit("close");

  await finished;

  assert.ok(capturedSignal.aborted, "expected the agent signal to abort on a real disconnect");
  assert.ok(
    !frames.some((frame) => frame.includes('"type":"error"')),
    "a genuine disconnect must not emit a user-facing error frame"
  );
});

test("runRepairPlannerAgent treats an AbortError as a quiet client disconnect", async () => {
  const events = [];

  // eslint-disable-next-line require-yield -- models an abort thrown before any output
  async function* abortingStreamTurn() {
    const error = new Error("This operation was aborted");
    error.name = "AbortError";
    throw error;
  }

  const result = await runRepairPlannerAgent(
    { brief: "Front brakes squeak. Replace pads." },
    {
      emit: (event) => events.push(event),
      streamTurn: abortingStreamTurn,
      retrieve: mockRetrieve,
      isAiConfigured: true,
    }
  );

  assert.equal(result.status, "aborted");
  assert.ok(
    !events.some((event) => event.type === "error"),
    "an AbortError must not surface a user-facing error frame"
  );
});

test("runRepairPlannerAgent still surfaces real model failures as an error frame", async () => {
  // The AbortError guard must not swallow genuine OpenAI/network failures.
  const events = [];

  // eslint-disable-next-line require-yield -- models a model/network failure before any output
  async function* failingStreamTurn() {
    throw new Error("OpenAI request failed (500): upstream error");
  }

  const result = await runRepairPlannerAgent(
    { brief: "Front brakes squeak. Replace pads." },
    {
      emit: (event) => events.push(event),
      streamTurn: failingStreamTurn,
      retrieve: mockRetrieve,
      isAiConfigured: true,
    }
  );

  assert.equal(result.status, "error");
  const errorEvent = events.find((event) => event.type === "error");
  assert.ok(errorEvent, "expected an error frame for a real model failure");
  assert.match(errorEvent.message, /500/);
});

test("runRepairPlannerAgent fails the run when the turn budget is exhausted", async () => {
  const events = [];

  // The model only ever asks for a tool and never writes narrative text, so the
  // turn budget is exhausted with an empty finalText.
  //
  // This previously asserted `status: "completed"` with an advisory status
  // frame -- the browser rendered a readiness score and checklist for a run
  // that produced no plan. A truncated run is now a failure.
  async function* toolOnlyStreamTurn() {
    yield {
      type: "function_call",
      callId: "call_extract",
      name: "extract_repair_tasks",
      arguments: {},
    };
  }

  const result = await runRepairPlannerAgent(
    { brief: "Front brakes squeak. Replace pads." },
    {
      emit: (event) => events.push(event),
      streamTurn: toolOnlyStreamTurn,
      retrieve: mockRetrieve,
      isAiConfigured: true,
      maxTurns: 2,
    }
  );

  assert.equal(result.status, "error");
  assert.equal(result.code, "planner_incomplete");
  assert.equal(result.reason, "turn_limit");

  const doneEvents = events.filter((event) => event.type === "done");
  assert.equal(doneEvents.length, 0, "a truncated run must not emit a done frame");

  const errorEvent = events.at(-1);
  assert.equal(errorEvent.type, "error");
  assert.equal(errorEvent.reason, "turn_limit");
  assert.ok(errorEvent.message.length > 0, "a failure must carry a fixed user-facing message");
});

test("runRepairPlannerAgent fails the run when the model writes no narrative", async () => {
  const events = [];

  // The model stops calling tools but writes nothing: no plan was produced.
  async function* silentStreamTurn() {
    for (const nothing of []) {
      yield nothing;
    }
  }

  const result = await runRepairPlannerAgent(
    { brief: "Front brakes squeak. Replace pads." },
    {
      emit: (event) => events.push(event),
      streamTurn: silentStreamTurn,
      retrieve: mockRetrieve,
      isAiConfigured: true,
    }
  );

  assert.equal(result.status, "error");
  assert.equal(result.reason, "empty_output");
  assert.equal(events.filter((event) => event.type === "done").length, 0);
});

test("runRepairPlannerAgent rejects a brief too vague to yield a canonical task", async () => {
  const events = [];
  let modelWasCalled = false;

  async function* neverCalled() {
    modelWasCalled = true;
    yield { type: "text_delta", text: "should not run" };
  }

  const result = await runRepairPlannerAgent(
    { brief: "help" },
    {
      emit: (event) => events.push(event),
      streamTurn: neverCalled,
      retrieve: mockRetrieve,
      isAiConfigured: true,
    }
  );

  assert.equal(result.status, "error");
  assert.equal(result.reason, "no_canonical_task");
  assert.equal(modelWasCalled, false, "a vague brief must fail before spending a model call");
  assert.equal(events.filter((event) => event.type === "done").length, 0);
});

// --- Canonical task rules --------------------------------------------------
//
// The task list is the foundation the whole plan is built on: readiness counts
// tasks, the checklist assigns owners per task, and the evidence contract will
// demand coverage per task. Splitting it wrong is not cosmetic.

test("a compound brief splits into one task per independent repair", () => {
  const { tasks } = extractRepairTasks({
    brief: "Replace the front brakes and diagnose a steering shake.",
  });

  assert.equal(tasks.length, 2, "each side is its own repair action");

  const { tasks: twoJobs } = extractRepairTasks({ brief: "Change the oil and rotate the tires." });
  assert.equal(twoJobs.length, 2);
});

test("object lists and procedure steps are not split into fabricated tasks", () => {
  const singleTaskBriefs = [
    // "and" terminating a list of parts, not a second job.
    "Replace the pads, rotors, and calipers.",
    "Replace the pads, rotors, and the front calipers.",
    "Remove the caliper and bracket.",
    "Check the pads and shims for wear.",
    // Steps within one repair, not independent work.
    "Lift the car and support it on stands.",
    "Replace the front brakes and torque to spec.",
    "Bleed the brakes and top off the reservoir.",
  ];

  for (const brief of singleTaskBriefs) {
    const { tasks } = extractRepairTasks({ brief });
    assert.equal(tasks.length, 1, `expected "${brief}" to stay one task, got ${tasks.length}`);
  }
});

test("a task kept whole despite a conjunction is marked compound with its clauses", () => {
  const { tasks } = extractRepairTasks({ brief: "Remove the caliper and bracket." });

  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].compound, true, "evidence must later cover each clause, not just one");
  assert.equal(tasks[0].clauses.length, 2);
});

test("duplicate wording yields one task, not two", () => {
  const { tasks } = extractRepairTasks({
    brief: "Replace front brake pads. Replace front brake pads.",
  });

  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].id, 1);
});

test("a brief too vague to plan yields no canonical task", () => {
  for (const brief of ["help", "car makes noise", "   "]) {
    const { tasks } = extractRepairTasks({ brief });
    assert.equal(tasks.length, 0, `expected "${brief}" to produce no task`);
  }
});

test("task ids stay contiguous after dedupe and rejection", () => {
  const { tasks } = extractRepairTasks({
    brief: "Replace front brake pads. help. Replace front brake pads. Change the oil.",
  });

  assert.deepEqual(
    tasks.map((task) => task.id),
    tasks.map((_task, index) => index + 1)
  );
});

// --- Trust boundary --------------------------------------------------------

test("model-supplied readiness inputs cannot change the result", async () => {
  const events = [];

  // A model doing everything it is not allowed to do: acknowledging the safety
  // risk on the owner's behalf, replacing the task list with something benign,
  // handing itself a full tool chest, and claiming advanced skill.
  async function* hostileStreamTurn({ input }) {
    const alreadyRan = input.some((item) => item.type === "function_call_output");

    if (alreadyRan) {
      yield { type: "text_delta", text: "Plan written." };
      return;
    }

    yield {
      type: "function_call",
      callId: "call_ready",
      name: "check_repair_readiness",
      arguments: {
        tasks: [{ id: 1, title: "Wash the car", difficulty: "beginner", safetyFlags: [] }],
        availableTools: "complete professional tool chest",
        availableParts: "every part needed",
        skillLevel: "advanced",
        ackSafety: true,
      },
    };
    yield {
      type: "function_call",
      callId: "call_list",
      name: "build_owner_checklist",
      arguments: { tasks: [{ id: 1, title: "Wash the car" }], skillLevel: "advanced", ackSafety: true },
    };
  }

  const result = await runRepairPlannerAgent(
    // The owner listed nothing and is a beginner.
    { brief: "Replace the front brake pads.", skillLevel: "beginner", availableTools: "none", availableParts: "n/a" },
    {
      emit: (event) => events.push(event),
      streamTurn: hostileStreamTurn,
      retrieve: mockRetrieve,
      isAiConfigured: true,
    }
  );

  assert.equal(result.status, "completed");

  const { readiness, checklist, tasks } = result.artifacts;

  assert.equal(readiness.safetyAcknowledged, false, "the model must not acknowledge risk for the owner");
  assert.equal(readiness.skillLevel, "beginner", "the model must not raise the owner's skill level");
  assert.notEqual(readiness.level, "ready", "unacknowledged brake work cannot be Ready");
  assert.equal(
    readiness.rubric.find((item) => item.id === "tools_listed").met,
    false,
    '"none" is not a tool inventory'
  );
  assert.equal(readiness.rubric.find((item) => item.id === "parts_listed").met, false);

  assert.equal(tasks.length, 1);
  assert.match(tasks[0].title, /brake/i, "the canonical task list came from the owner's brief");
  assert.equal(checklist[0].owner, "Shop Recommended");
});

test("none and n/a inventories earn no readiness points", () => {
  const { tasks } = extractRepairTasks({ brief: "Change the oil." });

  for (const sentinel of ["none", "n/a", "N/A", "unknown", "not sure", ""]) {
    const readiness = checkRepairReadiness({
      tasks,
      availableTools: sentinel,
      availableParts: sentinel,
      skillLevel: "beginner",
    });

    assert.equal(
      readiness.rubric.find((item) => item.id === "tools_listed").met,
      false,
      `"${sentinel}" must not count as a tool inventory`
    );
    assert.equal(readiness.rubric.find((item) => item.id === "parts_listed").met, false);
  }

  const real = checkRepairReadiness({
    tasks,
    availableTools: "socket set, oil filter wrench",
    availableParts: "5w30 oil, filter",
    skillLevel: "beginner",
  });

  assert.equal(real.rubric.find((item) => item.id === "tools_listed").met, true);
});

test("search_repair_docs rejects a taskId that is not a canonical task", async () => {
  const registry = createToolRegistry({
    retrieve: mockRetrieve,
    trusted: { tasks: [{ id: 1, title: "Replace front brake pads" }] },
  });

  const invented = await registry.search_repair_docs({ taskId: 99, query: "brake torque" });
  assert.match(invented.error, /Unknown taskId/);

  const valid = await registry.search_repair_docs({ taskId: 1, query: "brake torque" });
  assert.equal(valid.taskId, 1);
  assert.equal(valid.citations.length, 1);
});

test("no model-facing schema exposes a trusted owner input", () => {
  const forbidden = ["ackSafety", "skillLevel", "availableTools", "availableParts", "tasks", "brief"];

  for (const schema of repairToolSchemas) {
    const exposed = Object.keys(schema.parameters?.properties || {});

    for (const field of forbidden) {
      assert.ok(
        !exposed.includes(field),
        `tool "${schema.name}" must not let the model set "${field}"`
      );
    }
  }

  const search = repairToolSchemas.find((schema) => schema.name === "search_repair_docs");
  assert.ok(search.parameters.required.includes("taskId"), "searches must name their canonical task");
});
