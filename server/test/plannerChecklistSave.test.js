import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import express from "express";
import request from "supertest";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-planner-checklist-"));

process.env.DATABASE_FILE = path.join(tempRoot, "test.db");
process.env.UPLOADS_DIR = path.join(tempRoot, "uploads");
process.env.PORT = "4211";
process.env.CLIENT_PORT = "5291";
process.env.OPENAI_API_KEY = "";
process.env.OCR_ENABLED = "false";

fs.mkdirSync(process.env.UPLOADS_DIR, { recursive: true });

const { createApp } = await import("../src/app.js");
const { db } = await import("../src/database.js");
const { createRepairChecklistsRouter, CHECKLIST_DRAFT_EXPIRED_MESSAGE } = await import(
  "../src/routes/repairChecklists.js"
);
const { createPlanRunStore } = await import("../src/services/agent/planRunStore.js");
const { runRepairPlannerAgent } = await import("../src/services/agent/repairPlannerAgent.js");
const { buildPlannerChecklistDraft } = await import(
  "../src/services/agent/plannerChecklistDraft.js"
);

// Creating the app once runs the schema migrations and seeds the single vehicle
// every checklist hangs off.
createApp();

after(() => {
  if (typeof db.close === "function") {
    db.close();
  }

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

// --- Fixtures ---------------------------------------------------------------

const CHUNK_TEXT =
  "Front brake pad replacement: use a torque wrench to torque caliper bolts to 25 ft-lb, install new brake pads, and bleed the system.";

const mockRetrieve = async () => [
  {
    documentId: 7,
    pageNumber: 4,
    chunkIndex: 1,
    chunkText: CHUNK_TEXT,
    documentTitle: "Brake Service Guide",
    originalFilename: "brake-guide.pdf",
  },
];

const TORQUE_CLAIM = {
  taskId: 1,
  kind: "numeric_spec",
  claim: "torque caliper bolts to 25 ft-lb",
  sourceId: "S1",
  evidenceQuote: "use a torque wrench to torque caliper bolts to 25 ft-lb",
};

const TOOL_CLAIM = {
  taskId: 1,
  kind: "required_tool",
  itemName: "torque wrench",
  claim: "use a torque wrench to torque caliper bolts to 25 ft-lb",
  sourceId: "S1",
  evidenceQuote: "use a torque wrench to torque caliper bolts to 25 ft-lb",
};

const PART_CLAIM = {
  taskId: 1,
  kind: "required_part",
  itemName: "brake pads",
  claim: "install new brake pads",
  sourceId: "S1",
  evidenceQuote: "install new brake pads, and bleed the system",
};

// Quote is nowhere in the retrieved text, so the contract rejects it. The number
// is distinctive so a test can prove it never reached SQLite.
const REJECTED_CLAIM = {
  taskId: 1,
  kind: "numeric_spec",
  claim: "torque the caliper bolts to 999 ft-lb",
  sourceId: "S1",
  evidenceQuote: "torque the caliper bolts to 999 ft-lb",
};

function createMockStreamTurn(claims) {
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
      arguments: { claims },
    };
  };
}

async function runPlan({
  brief = "Replace the front brake pads.",
  claims = [TORQUE_CLAIM, TOOL_CLAIM, PART_CLAIM],
  availableTools = "torque wrench",
  availableParts = "brake pads",
  planRuns,
} = {}) {
  return runRepairPlannerAgent(
    { brief, skillLevel: "beginner", availableTools, availableParts },
    {
      streamTurn: createMockStreamTurn(claims),
      retrieve: mockRetrieve,
      isAiConfigured: true,
      planRuns,
    }
  );
}

function createTestApp(planRuns) {
  const app = express();
  app.use(express.json());
  app.use("/api/repair-checklists", createRepairChecklistsRouter({ planRuns }));
  return app;
}

function countChecklistsTitled(title) {
  return db
    .prepare("SELECT COUNT(*) AS total FROM repair_checklists WHERE title = ?")
    .get(title).total;
}

// --- Every completed status produces a saveable draft -------------------------

test("a verified run keeps its accepted statements, sources, requirements, and safety warnings", async () => {
  const planRuns = createPlanRunStore();
  const result = await runPlan({ planRuns });

  assert.equal(result.status, "completed");
  assert.equal(result.evidenceStatus, "verified");

  const { checklistDraft, checklistDraftId } = result.artifacts;

  assert.equal(typeof checklistDraftId, "string");
  assert.ok(checklistDraftId.length > 0);

  const app = createTestApp(planRuns);
  const response = await request(app)
    .post("/api/repair-checklists/from-planner")
    .send({ checklistDraftId })
    .expect(201);

  const { checklist } = response.body;

  assert.equal(checklist.title, checklistDraft.title);
  assert.equal(checklist.status, "planned");
  assert.equal(checklist.itemCount, 1);
  assert.equal(checklist.items[0].text, "Replace the front brake pads.");
  assert.equal(checklist.items[0].isDone, false);

  // The accepted statement, with the document and page it came from.
  assert.match(checklist.notes, /torque caliper bolts to 25 ft-lb/);
  assert.match(checklist.notes, /Brake Service Guide, page 4/);

  // The requirements that were actually verified.
  assert.match(checklist.notes, /Tools: torque wrench/);
  assert.match(checklist.notes, /Parts: brake pads/);

  // And the safety warning for brake work.
  assert.match(checklist.notes, /Safety warnings/);
  assert.match(checklist.notes, /Brake work affects stopping safety/);
});

test("a partial run saves every task but only the statements that verified", async () => {
  const planRuns = createPlanRunStore();
  const result = await runPlan({
    brief: "Replace the front brake pads and change the engine oil.",
    planRuns,
  });

  assert.equal(result.evidenceStatus, "partial");
  assert.equal(result.artifacts.tasks.length, 2, "the brief splits into two canonical tasks");

  const app = createTestApp(planRuns);
  const response = await request(app)
    .post("/api/repair-checklists/from-planner")
    .send({ checklistDraftId: result.artifacts.checklistDraftId })
    .expect(201);

  const { checklist } = response.body;

  assert.equal(checklist.itemCount, 2, "an item per high-level task, covered or not");
  assert.match(checklist.notes, /torque caliper bolts to 25 ft-lb/);
  // The uncovered task is named honestly rather than left looking verified.
  assert.match(
    checklist.notes,
    /No statement from your documents could be verified for this task/
  );
});

test("a not_found run saves only the tasks and warnings, and says nothing was verified", async () => {
  const planRuns = createPlanRunStore();
  const result = await runPlan({ claims: [], planRuns });

  assert.equal(result.evidenceStatus, "not_found");

  const app = createTestApp(planRuns);
  const response = await request(app)
    .post("/api/repair-checklists/from-planner")
    .send({ checklistDraftId: result.artifacts.checklistDraftId })
    .expect(201);

  const { checklist } = response.body;

  assert.equal(checklist.itemCount, 1);
  assert.equal(checklist.items[0].text, "Replace the front brake pads.");
  assert.match(checklist.notes, /No statement in this plan could be verified/);
  assert.match(checklist.notes, /Brake work affects stopping safety/);
  assert.doesNotMatch(
    checklist.notes,
    /Verified statements from your documents/,
    "there are none to list"
  );
  assert.doesNotMatch(checklist.notes, /25 ft-lb/, "no specification survives a not_found run");
});

// --- What must never reach SQLite --------------------------------------------

test("model prose, gaps, placeholder steps, handoff drafts, and rejected claims stay out of the saved checklist", async () => {
  const planRuns = createPlanRunStore();
  const result = await runPlan({
    claims: [TORQUE_CLAIM, TOOL_CLAIM, PART_CLAIM, REJECTED_CLAIM],
    planRuns,
  });

  // The run really did produce all the things that must not be copied.
  assert.ok(result.artifacts.evidence.gaps.length > 0, "the rejected claim became a gap");
  assert.ok(
    result.artifacts.checklist.some((entry) =>
      entry.steps.some((step) => step.startsWith("Placeholder:"))
    ),
    "the owner checklist really does carry placeholder steps"
  );
  assert.ok(result.artifacts.handoffNotes.mechanicHandoff.length > 0);
  assert.match(result.text, /Before you start/, "the rendered plan text exists to be excluded");

  const app = createTestApp(planRuns);
  const response = await request(app)
    .post("/api/repair-checklists/from-planner")
    .send({ checklistDraftId: result.artifacts.checklistDraftId })
    .expect(201);

  const saved = `${response.body.checklist.title}\n${response.body.checklist.description}\n${
    response.body.checklist.notes
  }\n${response.body.checklist.items.map((item) => item.text).join("\n")}`;

  assert.doesNotMatch(saved, /999/, "a rejected claim's number never reaches storage");
  assert.doesNotMatch(saved, /Dropped an unverified statement/, "gaps are not copied");
  assert.doesNotMatch(saved, /Placeholder:/, "placeholder steps are not copied");
  assert.doesNotMatch(saved, /Parts run for/, "the parts shopping draft is not copied");
  assert.doesNotMatch(saved, /Please confirm diagnosis/, "the mechanic handoff is not copied");
  assert.doesNotMatch(saved, /Maintenance log/, "the log entry draft is not copied");
  assert.doesNotMatch(saved, /Before you start/, "the rendered plan text is not copied");
  assert.doesNotMatch(saved, /Readiness|\/100/, "the readiness score is not copied");
});

test("the request body carries a draft id only: task text, claims, and warnings from the browser are ignored", async () => {
  const planRuns = createPlanRunStore();
  const result = await runPlan({ planRuns });
  const app = createTestApp(planRuns);

  const response = await request(app)
    .post("/api/repair-checklists/from-planner")
    .send({
      checklistDraftId: result.artifacts.checklistDraftId,
      // Everything a tampered page might try to write into permanent storage.
      title: "Torque everything to 400 ft-lb",
      status: "done",
      description: "Injected description.",
      notes: "Injected notes: skip the jack stands.",
      items: [{ text: "Injected item" }],
      claims: [{ claim: "brake fluid is optional" }],
      safetyFlags: [],
      evidence: { verifiedClaims: [] },
    })
    .expect(201);

  const { checklist } = response.body;

  assert.equal(checklist.title, result.artifacts.checklistDraft.title);
  assert.equal(checklist.status, "planned");
  assert.equal(checklist.notes, result.artifacts.checklistDraft.notes);
  assert.equal(checklist.itemCount, 1);
  assert.equal(checklist.items[0].text, "Replace the front brake pads.");
  assert.doesNotMatch(
    `${checklist.title}${checklist.description}${checklist.notes}`,
    /Injected|400 ft-lb|optional/
  );
});

// --- Transactional creation and idempotency ----------------------------------

test("saving the same draft twice returns the checklist it already became", async () => {
  const planRuns = createPlanRunStore();
  const result = await runPlan({ planRuns });
  const app = createTestApp(planRuns);
  const { checklistDraftId, checklistDraft } = result.artifacts;
  // Earlier tests in this file share the database, so measure the delta rather
  // than the absolute count.
  const before = countChecklistsTitled(checklistDraft.title);

  const first = await request(app)
    .post("/api/repair-checklists/from-planner")
    .send({ checklistDraftId })
    .expect(201);

  const second = await request(app)
    .post("/api/repair-checklists/from-planner")
    .send({ checklistDraftId })
    .expect(200);

  assert.equal(second.body.checklist.id, first.body.checklist.id);
  assert.equal(second.body.created, false);
  assert.equal(
    countChecklistsTitled(checklistDraft.title) - before,
    1,
    "a repeated save creates no duplicate"
  );
});

test("a checklist and all its items are created together or not at all", async () => {
  const planRuns = createPlanRunStore();
  // A second item the items table will refuse (text is NOT NULL). The header row
  // must not survive the failure.
  const checklistDraftId = planRuns.saveChecklistDraft({
    title: "Atomicity probe",
    status: "planned",
    description: "",
    notes: "",
    items: [{ text: "First item" }, { text: null }],
  });

  const app = createTestApp(planRuns);

  await request(app)
    .post("/api/repair-checklists/from-planner")
    .send({ checklistDraftId })
    .expect(500);

  assert.equal(
    countChecklistsTitled("Atomicity probe"),
    0,
    "the checklist row was rolled back with its items"
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS total FROM repair_checklist_items WHERE text = ?").get("First item")
      .total,
    0,
    "the item that did insert was rolled back too"
  );
});

// --- Expiry and validation ---------------------------------------------------

test("an unknown draft id fails safely with rebuild guidance", async () => {
  const planRuns = createPlanRunStore();
  const app = createTestApp(planRuns);

  const response = await request(app)
    .post("/api/repair-checklists/from-planner")
    .send({ checklistDraftId: "not-a-real-draft" })
    .expect(404);

  assert.equal(response.body.error, CHECKLIST_DRAFT_EXPIRED_MESSAGE);
  assert.match(response.body.error, /[Bb]uild the plan again/);
});

test("an expired draft id fails safely and writes nothing", async () => {
  let clock = 1_000;
  const planRuns = createPlanRunStore({ ttlMs: 100, now: () => clock });
  const checklistDraftId = planRuns.saveChecklistDraft({
    title: "Expiring draft",
    status: "planned",
    description: "",
    notes: "",
    items: [{ text: "Do the thing" }],
  });

  const app = createTestApp(planRuns);
  clock += 101;

  const response = await request(app)
    .post("/api/repair-checklists/from-planner")
    .send({ checklistDraftId })
    .expect(404);

  assert.equal(response.body.error, CHECKLIST_DRAFT_EXPIRED_MESSAGE);
  assert.equal(countChecklistsTitled("Expiring draft"), 0);
});

test("a missing draft id is a 400, not a 500", async () => {
  const app = createTestApp(createPlanRunStore());

  for (const body of [{}, { checklistDraftId: "" }, { checklistDraftId: 7 }]) {
    const response = await request(app)
      .post("/api/repair-checklists/from-planner")
      .send(body)
      .expect(400);

    assert.match(response.body.error, /checklistDraftId/);
  }
});

test("a stored draft cannot be mutated through the record the store hands back", () => {
  const planRuns = createPlanRunStore();
  const checklistDraftId = planRuns.saveChecklistDraft({
    title: "Frozen draft",
    status: "planned",
    description: "",
    notes: "",
    items: [{ text: "Do the thing" }],
  });

  const record = planRuns.getChecklistDraft(checklistDraftId);

  assert.throws(() => {
    record.draft.title = "Tampered";
  }, TypeError);
  assert.throws(() => {
    record.draft.items[0].text = "Tampered";
  }, TypeError);

  assert.equal(planRuns.getChecklistDraft(checklistDraftId).draft.title, "Frozen draft");
});

// --- Existing planRunId behavior is unchanged --------------------------------

test("a safety-critical run still gets a planRunId, and now also a checklistDraftId", async () => {
  const planRuns = createPlanRunStore();
  const result = await runPlan({ planRuns });

  assert.equal(result.artifacts.readiness.safetyCritical, true);
  assert.equal(typeof result.artifacts.planRunId, "string");
  assert.ok(planRuns.get(result.artifacts.planRunId));
  assert.equal(typeof result.artifacts.checklistDraftId, "string");
  assert.notEqual(
    result.artifacts.checklistDraftId,
    result.artifacts.planRunId,
    "the two ids authorize different things and are never the same value"
  );
});

test("a run with no safety-critical work still gets no planRunId, but is saveable", async () => {
  const planRuns = createPlanRunStore();
  const result = await runPlan({
    brief: "Change the engine oil.",
    claims: [],
    planRuns,
  });

  assert.equal(result.artifacts.readiness.safetyCritical, false);
  assert.equal(result.artifacts.planRunId, undefined, "nothing to acknowledge, so no run record");
  assert.equal(planRuns.size, 0);

  assert.equal(typeof result.artifacts.checklistDraftId, "string");
  assert.equal(planRuns.checklistDraftSize, 1);

  const app = createTestApp(planRuns);
  const response = await request(app)
    .post("/api/repair-checklists/from-planner")
    .send({ checklistDraftId: result.artifacts.checklistDraftId })
    .expect(201);

  assert.equal(response.body.checklist.items[0].text, "Change the engine oil.");
});

// --- The draft builder in isolation ------------------------------------------

test("the draft never carries a number that no accepted claim supports", () => {
  const draft = buildPlannerChecklistDraft({
    tasks: [{ id: 1, title: "Replace the front brake pads", safetyFlags: ["Brake warning."] }],
    evidenceStatus: "partial",
    verifiedClaims: [
      { taskId: 1, kind: "numeric_spec", claim: "torque to 25 ft-lb", sourceId: "S1" },
    ],
    citations: [
      { sourceId: "S1", documentTitle: "Brake Guide", pageNumber: 12, documentId: 3 },
    ],
    requirements: {
      tools: { status: "unknown", required: [], satisfied: [], missing: [] },
      parts: { status: "none_required", required: [], satisfied: [], missing: [] },
    },
  });

  assert.equal(draft.status, "planned");
  assert.deepEqual(draft.items, [{ text: "Replace the front brake pads" }]);
  assert.match(draft.notes, /torque to 25 ft-lb \(Brake Guide, page 12\)/);
  assert.match(draft.notes, /Tools: not established from your documents/);
  assert.match(draft.notes, /Parts: the cited procedures state none are required/);
  assert.match(draft.notes, /Brake warning\./);
});

test("the draft title names the work and folds extra tasks into a count", () => {
  const draft = buildPlannerChecklistDraft({
    tasks: [
      { id: 1, title: "Replace the front brake pads", safetyFlags: [] },
      { id: 2, title: "Change the engine oil", safetyFlags: [] },
      { id: 3, title: "Flush the coolant", safetyFlags: [] },
    ],
    evidenceStatus: "not_found",
  });

  assert.equal(draft.title, "Replace the front brake pads (+2 more)");
  assert.equal(draft.items.length, 3);
});
