import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import express from "express";
import request from "supertest";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-safety-ack-"));

process.env.DATABASE_FILE = path.join(tempRoot, "test.db");
process.env.UPLOADS_DIR = path.join(tempRoot, "uploads");
process.env.PORT = "4207";
process.env.CLIENT_PORT = "5281";
process.env.OPENAI_API_KEY = "";

fs.mkdirSync(process.env.UPLOADS_DIR, { recursive: true });

const { db } = await import("../src/database.js");
const { createRepairPlanRouter, PLAN_RUN_EXPIRED_MESSAGE } = await import(
  "../src/routes/repairPlan.js"
);
const { createPlanRunStore } = await import("../src/services/agent/planRunStore.js");
const { runRepairPlannerAgent } = await import("../src/services/agent/repairPlannerAgent.js");

after(() => {
  if (typeof db.close === "function") {
    db.close();
  }
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

// --- Fixtures ---------------------------------------------------------------

const BRAKE_TASK = {
  id: 1,
  title: "Replace front brake pads",
  system: "Brakes",
  difficulty: "beginner",
  safetyFlags: ["Brake work affects stopping safety."],
};

// Requirement groups that already satisfy tools, parts, and skill, so the ONLY
// thing standing between this plan and Ready is the acknowledgment.
const SATISFIED_REQUIREMENTS = {
  tools: { status: "satisfied", required: ["torque wrench"], satisfied: ["torque wrench"], missing: [] },
  parts: { status: "satisfied", required: ["brake pads"], satisfied: ["brake pads"], missing: [] },
};

function createTestApp({ planRuns }) {
  const app = express();
  app.use(express.json());
  app.use("/api/repair-plan", createRepairPlanRouter({ planRuns }));
  return app;
}

function seedRun(planRuns, { tasks = [BRAKE_TASK], requirements = SATISFIED_REQUIREMENTS } = {}) {
  return planRuns.save({
    tasks,
    skillLevel: "beginner",
    requirements,
    evidenceStatus: "verified",
  });
}

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
  let turn = 0;

  return async function* mockStreamTurn() {
    turn += 1;

    if (turn === 1) {
      yield {
        type: "function_call",
        callId: "call_search",
        name: "search_repair_docs",
        arguments: { taskId: 1, query: "front brake pad torque" },
      };
      return;
    }

    yield {
      type: "function_call",
      callId: "call_finalize",
      name: "finalize_repair_plan",
      arguments: {
        claims: [
          {
            taskId: 1,
            kind: "numeric_spec",
            claim: "torque caliper bolts to 25 ft-lb",
            sourceId: "S1",
            evidenceQuote: "torque caliper bolts to 25 ft-lb and bleed the system",
          },
        ],
      },
    };
  };
}

// --- The generated plan starts unacknowledged --------------------------------

test("a safety-critical plan is generated unacknowledged and below Ready, with a run id to acknowledge it", async () => {
  const planRuns = createPlanRunStore();

  const result = await runRepairPlannerAgent(
    { brief: "Replace the front brake pads.", skillLevel: "beginner" },
    {
      streamTurn: createMockStreamTurn(),
      retrieve: mockRetrieve,
      isAiConfigured: true,
      planRuns,
    }
  );

  assert.equal(result.status, "completed");

  const { readiness, checklist, planRunId } = result.artifacts;

  assert.equal(readiness.safetyCritical, true);
  assert.equal(readiness.safetyAcknowledged, false, "a fresh plan is never pre-acknowledged");
  assert.notEqual(readiness.level, "ready");
  assert.equal(
    readiness.rubric.find((item) => item.id === "safety_reviewed").met,
    false,
    "the safety row is unmet until the owner acts"
  );
  assert.equal(checklist[0].owner, "Shop Recommended");

  // The run id is what makes the acknowledgment reachable at all. Without it the
  // rubric row would be permanently unsatisfiable -- the defect this fixes.
  assert.equal(typeof planRunId, "string");
  assert.ok(planRunId.length > 0);
  assert.ok(planRuns.get(planRunId), "the server kept its own copy of the run's readiness inputs");
});

test("a plan with no safety-critical work needs no acknowledgment and gets no run id", async () => {
  const planRuns = createPlanRunStore();

  const result = await runRepairPlannerAgent(
    { brief: "Change the engine oil.", skillLevel: "beginner" },
    {
      streamTurn: createMockStreamTurn(),
      retrieve: mockRetrieve,
      isAiConfigured: true,
      planRuns,
    }
  );

  const { readiness, planRunId } = result.artifacts;

  assert.equal(readiness.safetyCritical, false);
  assert.equal(
    readiness.rubric.find((item) => item.id === "safety_reviewed").met,
    true,
    "a non-safety-critical plan must not be blocked by a requirement that does not apply"
  );
  assert.equal(planRunId, undefined, "nothing to acknowledge, so no run is stored");
  assert.equal(planRuns.size, 0);
});

// --- Acknowledging ----------------------------------------------------------

test("acknowledging a safety-critical run satisfies the safety rubric row and re-scores the plan", async () => {
  const planRuns = createPlanRunStore();
  const runId = seedRun(planRuns);
  const app = createTestApp({ planRuns });

  const before = await request(app)
    .post(`/api/repair-plan/${runId}/safety-acknowledgment`)
    .send({ acknowledged: false })
    .expect(200);

  assert.equal(before.body.readiness.safetyAcknowledged, false);
  assert.equal(before.body.readiness.rubric.find((item) => item.id === "safety_reviewed").met, false);
  assert.notEqual(before.body.readiness.level, "ready");
  assert.equal(before.body.checklist[0].owner, "Shop Recommended");

  const after_ = await request(app)
    .post(`/api/repair-plan/${runId}/safety-acknowledgment`)
    .send({ acknowledged: true })
    .expect(200);

  const safetyRow = after_.body.readiness.rubric.find((item) => item.id === "safety_reviewed");

  assert.equal(after_.body.safetyAcknowledged, true);
  assert.equal(safetyRow.met, true);
  assert.equal(
    after_.body.readiness.score,
    before.body.readiness.score + safetyRow.points,
    "the score moves by exactly the safety row's points -- nothing is hard-coded"
  );
  assert.equal(after_.body.readiness.level, "ready");
  assert.equal(after_.body.checklist[0].owner, "DIY");
});

test("readiness messaging tracks the acknowledgment state", async () => {
  const planRuns = createPlanRunStore();
  const runId = seedRun(planRuns);
  const app = createTestApp({ planRuns });

  const unacknowledged = await request(app)
    .post(`/api/repair-plan/${runId}/safety-acknowledgment`)
    .send({ acknowledged: false })
    .expect(200);

  assert.ok(
    unacknowledged.body.readiness.gaps.some((gap) => /safety-critical work detected/i.test(gap)),
    "the blocking reason is stated while the plan is unacknowledged"
  );

  const acknowledged = await request(app)
    .post(`/api/repair-plan/${runId}/safety-acknowledgment`)
    .send({ acknowledged: true })
    .expect(200);

  assert.equal(
    acknowledged.body.readiness.gaps.some((gap) => /safety-critical work detected/i.test(gap)),
    false,
    "the gap disappears once the risk is acknowledged"
  );
  // The hazard warnings themselves stay -- acknowledging is not dismissing.
  assert.ok(acknowledged.body.readiness.safetyFlags.length > 0);
  assert.ok(acknowledged.body.checklist[0].safetyFlags.length > 0);
  assert.equal(acknowledged.body.checklist[0].safetyCritical, true);
});

test("an acknowledgment can be withdrawn and the plan drops back below Ready", async () => {
  const planRuns = createPlanRunStore();
  const runId = seedRun(planRuns);
  const app = createTestApp({ planRuns });

  await request(app)
    .post(`/api/repair-plan/${runId}/safety-acknowledgment`)
    .send({ acknowledged: true })
    .expect(200);

  const withdrawn = await request(app)
    .post(`/api/repair-plan/${runId}/safety-acknowledgment`)
    .send({ acknowledged: false })
    .expect(200);

  assert.equal(withdrawn.body.readiness.safetyAcknowledged, false);
  assert.notEqual(withdrawn.body.readiness.level, "ready");
  assert.equal(withdrawn.body.checklist[0].owner, "Shop Recommended");
});

// --- Trust boundary ---------------------------------------------------------

test("the client cannot make a server-classified safety-critical task non-critical", async () => {
  const planRuns = createPlanRunStore();
  const runId = seedRun(planRuns);
  const app = createTestApp({ planRuns });

  // Everything a client might try to smuggle in to buy points: a harmless task
  // list, a raised skill level, satisfied requirement groups, a pre-set verdict.
  const response = await request(app)
    .post(`/api/repair-plan/${runId}/safety-acknowledgment`)
    .send({
      acknowledged: false,
      tasks: [{ id: 1, title: "Wash the car", system: "General", difficulty: "beginner" }],
      skillLevel: "advanced",
      requirements: SATISFIED_REQUIREMENTS,
      evidenceStatus: "verified",
      readiness: { score: 100, level: "ready", safetyCritical: false },
      safetyCritical: false,
      safetyAcknowledged: true,
    })
    .expect(200);

  assert.equal(
    response.body.readiness.safetyCritical,
    true,
    "safety classification is re-derived from the server's stored tasks"
  );
  assert.equal(response.body.readiness.safetyAcknowledged, false);
  assert.equal(response.body.readiness.skillLevel, "beginner");
  assert.notEqual(response.body.readiness.level, "ready");
  assert.equal(response.body.checklist[0].task, "Replace front brake pads");
  assert.equal(response.body.checklist[0].owner, "Shop Recommended");
});

test("an unknown or retired run id cannot be acknowledged", async () => {
  const planRuns = createPlanRunStore();
  const app = createTestApp({ planRuns });

  const response = await request(app)
    .post("/api/repair-plan/not-a-real-run/safety-acknowledgment")
    .send({ acknowledged: true })
    .expect(404);

  assert.equal(response.body.error, PLAN_RUN_EXPIRED_MESSAGE);
});

test("the acknowledgment flag must be a boolean", async () => {
  const planRuns = createPlanRunStore();
  const runId = seedRun(planRuns);
  const app = createTestApp({ planRuns });

  for (const acknowledged of ["true", 1, null, undefined]) {
    const response = await request(app)
      .post(`/api/repair-plan/${runId}/safety-acknowledgment`)
      .send({ acknowledged })
      .expect(400);

    assert.match(response.body.error, /must be true or false/);
  }
});

// --- Acknowledgment does not survive the plan it belonged to ------------------

test("regenerating a plan mints a new run id, so the previous acknowledgment cannot carry over", async () => {
  const planRuns = createPlanRunStore();
  const app = createTestApp({ planRuns });

  const runOptions = {
    streamTurn: createMockStreamTurn(),
    retrieve: mockRetrieve,
    isAiConfigured: true,
    planRuns,
  };

  const first = await runRepairPlannerAgent(
    { brief: "Replace the front brake pads.", skillLevel: "beginner" },
    runOptions
  );

  await request(app)
    .post(`/api/repair-plan/${first.artifacts.planRunId}/safety-acknowledgment`)
    .send({ acknowledged: true })
    .expect(200);

  const second = await runRepairPlannerAgent(
    { brief: "Replace the rear brake shoes.", skillLevel: "beginner" },
    { ...runOptions, streamTurn: createMockStreamTurn() }
  );

  assert.notEqual(
    second.artifacts.planRunId,
    first.artifacts.planRunId,
    "a regenerated plan is a different run"
  );
  assert.equal(
    second.artifacts.readiness.safetyAcknowledged,
    false,
    "the new plan starts unacknowledged regardless of what was acknowledged before"
  );
  assert.notEqual(second.artifacts.readiness.level, "ready");
});

test("the run store is bounded and evicts the oldest runs", () => {
  const planRuns = createPlanRunStore({ maxRuns: 3 });
  const ids = [];

  for (let index = 0; index < 5; index += 1) {
    ids.push(planRuns.save({ tasks: [BRAKE_TASK], skillLevel: "beginner" }));
  }

  assert.equal(planRuns.size, 3);
  assert.equal(planRuns.get(ids[0]), null, "the oldest run was retired");
  assert.equal(planRuns.get(ids[1]), null);
  assert.ok(planRuns.get(ids[4]), "the newest run is still acknowledgeable");
});

test("a run past its TTL can no longer be acknowledged", () => {
  let clock = 1_000;
  const planRuns = createPlanRunStore({ ttlMs: 100, now: () => clock });

  const runId = planRuns.save({ tasks: [BRAKE_TASK], skillLevel: "beginner" });
  assert.ok(planRuns.get(runId));

  clock += 101;
  assert.equal(planRuns.get(runId), null);
});

test("a stored run cannot be mutated through the record the store hands back", () => {
  const planRuns = createPlanRunStore();
  const runId = planRuns.save({ tasks: [BRAKE_TASK], skillLevel: "beginner" });
  const record = planRuns.get(runId);

  assert.throws(() => {
    record.skillLevel = "advanced";
  }, TypeError);
  assert.throws(() => {
    record.tasks[0].system = "General";
  }, TypeError);

  assert.equal(planRuns.get(runId).skillLevel, "beginner");
  assert.equal(planRuns.get(runId).tasks[0].system, "Brakes");
});

// --- The model still cannot acknowledge for the owner -------------------------

test("no model-facing path can pre-acknowledge a plan", async () => {
  const planRuns = createPlanRunStore();

  // The model tries to set ackSafety on every tool it calls.
  let turn = 0;

  async function* hostileStreamTurn() {
    turn += 1;

    if (turn === 1) {
      yield {
        type: "function_call",
        callId: "call_search",
        name: "search_repair_docs",
        arguments: { taskId: 1, query: "front brake pad torque" },
      };
      return;
    }

    yield {
      type: "function_call",
      callId: "call_ready",
      name: "check_repair_readiness",
      arguments: { ackSafety: true, skillLevel: "advanced" },
    };
    yield {
      type: "function_call",
      callId: "call_list",
      name: "build_owner_checklist",
      arguments: { ackSafety: true },
    };
    yield {
      type: "function_call",
      callId: "call_finalize",
      name: "finalize_repair_plan",
      arguments: {
        claims: [
          {
            taskId: 1,
            kind: "numeric_spec",
            claim: "torque caliper bolts to 25 ft-lb",
            sourceId: "S1",
            evidenceQuote: "torque caliper bolts to 25 ft-lb and bleed the system",
          },
        ],
      },
    };
  }

  const result = await runRepairPlannerAgent(
    { brief: "Replace the front brake pads.", skillLevel: "beginner" },
    {
      streamTurn: hostileStreamTurn,
      retrieve: mockRetrieve,
      isAiConfigured: true,
      planRuns,
    }
  );

  assert.equal(result.artifacts.readiness.safetyAcknowledged, false);
  assert.equal(result.artifacts.checklist[0].owner, "Shop Recommended");

  // And the run the acknowledgment route would later re-score carries the
  // owner's real skill level, not the one the model asked for.
  assert.equal(planRuns.get(result.artifacts.planRunId).skillLevel, "beginner");
});
