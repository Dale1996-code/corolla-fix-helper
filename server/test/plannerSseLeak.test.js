import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

// A planner claim the evidence contract REJECTS must never reach the browser.
// The raw finalize_repair_plan arguments used to ride out on the tool_call
// frame, so the rejected value was visible in the activity log (1A-15). The
// frame now carries the tool name, ids, and counts only, and no other frame
// echoes a model argument either.
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-fix-helper-sse-leak-"));

process.env.DATABASE_FILE = path.join(tempRoot, "sse-leak.db");
process.env.UPLOADS_DIR = path.join(tempRoot, "uploads");
process.env.OPENAI_API_KEY = "";
process.env.NETWORK_MODE = "0";

fs.mkdirSync(process.env.UPLOADS_DIR, { recursive: true });

const { db } = await import("../src/database.js");
const { runRepairPlannerAgent } = await import("../src/services/agent/repairPlannerAgent.js");

after(() => {
  if (typeof db.close === "function") {
    db.close();
  }

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

// Synthetic passage: the manual-style text is written for this test.
const retrieve = async () => [
  {
    documentId: 7,
    pageNumber: 4,
    chunkIndex: 1,
    documentTitle: "Brake Service Guide",
    originalFilename: "brake-guide.pdf",
    chunkText: "Front brake pad replacement: torque caliper bolts to 25 ft-lb and bleed the system.",
  },
];

// The rejected claim's quote is not in the source, so verification must drop it.
const REJECTED = {
  taskId: 1,
  kind: "numeric_spec",
  claim: "torque caliper bolts to 54 Nm",
  sourceId: "S1",
  evidenceQuote: "torque caliper bolts to 54 Nm",
};
const VERIFIED = {
  taskId: 1,
  kind: "numeric_spec",
  claim: "torque caliper bolts to 25 ft-lb",
  sourceId: "S1",
  evidenceQuote: "Front brake pad replacement: torque caliper bolts to 25 ft-lb",
};

function scriptedTurns() {
  let turn = 0;

  return async function* () {
    turn += 1;

    if (turn === 1) {
      yield {
        type: "function_call",
        callId: "c1",
        name: "search_repair_docs",
        arguments: { taskId: 1, query: "front brake pad caliper torque" },
      };
      return;
    }

    yield {
      type: "function_call",
      callId: "c2",
      name: "finalize_repair_plan",
      arguments: { claims: [VERIFIED, REJECTED] },
    };
  };
}

test("the planner run completes with the rejected claim dropped", async () => {
  // Not a todo: this pins the setup, so the todo below can only be failing for
  // the leak itself.
  const events = [];
  const result = await runRepairPlannerAgent(
    { brief: "Front brakes squeak. Replace pads." },
    { emit: (event) => events.push(event), streamTurn: scriptedTurns(), retrieve, isAiConfigured: true }
  );

  assert.equal(result.status, "completed");
  assert.ok(!result.text.includes("54 Nm"), "the rejected value reached the final plan text");
  assert.ok(result.text.includes("25 ft-lb"), "the verified claim is missing from the plan");
});

test("a rejected planner claim's value appears in no SSE frame", async () => {
  const events = [];
  await runRepairPlannerAgent(
    { brief: "Front brakes squeak. Replace pads." },
    { emit: (event) => events.push(event), streamTurn: scriptedTurns(), retrieve, isAiConfigured: true }
  );

  const leaking = events.filter((event) => JSON.stringify(event).includes("54 Nm"));
  assert.deepEqual(
    leaking.map((event) => event.type),
    [],
    "the rejected value reached the browser via: " + JSON.stringify(leaking).slice(0, 300)
  );
});

test("tool_call frames carry the tool name, ids, and counts only", async () => {
  const events = [];
  await runRepairPlannerAgent(
    { brief: "Front brakes squeak. Replace pads." },
    { emit: (event) => events.push(event), streamTurn: scriptedTurns(), retrieve, isAiConfigured: true }
  );

  assert.deepEqual(
    events.filter((event) => event.type === "tool_call"),
    [
      { type: "tool_call", name: "search_repair_docs", turn: 1, taskId: 1 },
      { type: "tool_call", name: "finalize_repair_plan", turn: 2, claimCount: 2 },
    ]
  );
});

// Every other argument channel: a search query, a task id that names no task,
// and a function name the planner never offered. Each holds the marker, and the
// marker must reach no frame -- not the tool_call, the tool_result summary, nor
// a trace span.
test("model text in any tool argument reaches no SSE frame", async () => {
  const MARKER = "77 Nm";
  let turn = 0;

  async function* streamTurn() {
    turn += 1;

    if (turn === 1) {
      yield {
        type: "function_call",
        callId: "c1",
        name: "search_repair_docs",
        arguments: { taskId: 1, query: `caliper bolts ${MARKER}` },
      };
      yield {
        type: "function_call",
        callId: "c2",
        name: "search_repair_docs",
        arguments: { taskId: `bolts ${MARKER}`, query: "caliper" },
      };
      yield {
        type: "function_call",
        callId: "c3",
        name: `torque_${MARKER}`,
        arguments: { value: MARKER },
      };
      return;
    }

    yield {
      type: "function_call",
      callId: "c4",
      name: "finalize_repair_plan",
      arguments: { claims: [VERIFIED] },
    };
  }

  const events = [];
  const result = await runRepairPlannerAgent(
    { brief: "Front brakes squeak. Replace pads." },
    { emit: (event) => events.push(event), streamTurn, retrieve, isAiConfigured: true }
  );

  assert.equal(result.status, "completed");

  const leaking = events.filter((event) => JSON.stringify(event).includes(MARKER));
  assert.deepEqual(
    leaking.map((event) => event.type),
    [],
    "a model argument reached the browser via: " + JSON.stringify(leaking).slice(0, 300)
  );

  const calls = events.filter((event) => event.type === "tool_call");
  assert.deepEqual(
    calls.map((event) => event.name),
    ["search_repair_docs", "search_repair_docs", "unknown_tool", "finalize_repair_plan"]
  );
  assert.equal(calls[1].taskId, undefined, "an invalid task id is dropped, not coerced");

  const summaries = events.filter((event) => event.type === "tool_result").map((event) => event.summary);
  assert.match(summaries[0], /^Retrieved 1 passage for "/, "a search is named by its canonical task");
});
