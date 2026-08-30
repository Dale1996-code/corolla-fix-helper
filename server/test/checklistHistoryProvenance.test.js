import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import express from "express";
import request from "supertest";

// The N3.2 evidence chain, end to end:
//
//   planner citations (documentId + pageNumber)
//     -> durable checklist provenance   (repair_checklist_documents)
//     -> checklist completion
//     -> repair history                 (repair_history)
//     -> historical provenance          (repair_history_documents)
//
// What these tests exist to pin is not the happy path -- it is that the evidence
// survives the four things that used to destroy it: the plan run expiring, the
// server restarting, the cited document being renamed, and the cited document
// being deleted. Each of those is a separate test below, because each broke the
// chain in a different place.

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-checklist-history-"));

process.env.DATABASE_FILE = path.join(tempRoot, "test.db");
process.env.UPLOADS_DIR = path.join(tempRoot, "uploads");
process.env.PORT = "4213";
process.env.CLIENT_PORT = "5293";
process.env.OPENAI_API_KEY = "";
process.env.OCR_ENABLED = "false";

fs.mkdirSync(process.env.UPLOADS_DIR, { recursive: true });

const { createApp } = await import("../src/app.js");
const { db } = await import("../src/database.js");
const { createRepairChecklistsRouter } = await import("../src/routes/repairChecklists.js");
const { repairHistoryRouter } = await import("../src/routes/repairHistory.js");
const { createPlanRunStore } = await import("../src/services/agent/planRunStore.js");
const { runRepairPlannerAgent } = await import("../src/services/agent/repairPlannerAgent.js");
const { buildDraftSources } = await import("../src/services/agent/plannerChecklistDraft.js");
const { completeChecklistIntoHistory, listChecklistSources } = await import(
  "../src/services/repairChecklistProvenanceService.js"
);

createApp();

after(() => {
  if (typeof db.close === "function") {
    db.close();
  }

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

// --- Fixtures ---------------------------------------------------------------

function vehicleId() {
  return Number(db.prepare("SELECT id FROM vehicles ORDER BY id ASC LIMIT 1").get().id);
}

function insertDocument(title) {
  return Number(
    db
      .prepare(`
        INSERT INTO documents (
          vehicle_id, title, original_filename, stored_filename, file_path,
          file_type, system, document_type, extraction_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        vehicleId(),
        title,
        `${title}.pdf`,
        `${title}-stored.pdf`,
        `server/uploads/${title}.pdf`,
        "application/pdf",
        "Brakes",
        "Repair Manual",
        "completed"
      ).lastInsertRowid
  );
}

function insertSymptom(title) {
  return Number(
    db
      .prepare("INSERT INTO symptoms (vehicle_id, title, system, status) VALUES (?, ?, ?, ?)")
      .run(vehicleId(), title, "Brakes", "open").lastInsertRowid
  );
}

const CHUNK_TEXT =
  "Front brake pad replacement: use a torque wrench to torque caliper bolts to 25 ft-lb, install new brake pads, and bleed the system.";

// The planner cites ONE real document twice -- the same page for the numeric
// spec and for the tool requirement. That duplication is the ordinary case, and
// proving it collapses to a single durable row is requirement 4.
function createMockRetrieve(documentId, documentTitle) {
  return async () => [
    {
      documentId,
      pageNumber: 412,
      chunkIndex: 1,
      chunkText: CHUNK_TEXT,
      documentTitle,
      originalFilename: "brake-guide.pdf",
    },
  ];
}

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

async function runPlan({ documentId, documentTitle, planRuns, claims = [TORQUE_CLAIM, TOOL_CLAIM] }) {
  return runRepairPlannerAgent(
    {
      brief: "Replace the front brake pads.",
      skillLevel: "beginner",
      availableTools: "torque wrench",
      availableParts: "brake pads",
    },
    {
      streamTurn: createMockStreamTurn(claims),
      retrieve: createMockRetrieve(documentId, documentTitle),
      isAiConfigured: true,
      planRuns,
    }
  );
}

function createTestApp(planRuns) {
  const app = express();
  app.use(express.json());
  app.use("/api/repair-checklists", createRepairChecklistsRouter({ planRuns }));
  app.use("/api/repair-history", repairHistoryRouter);
  return app;
}

/**
 * Run a plan and save it as a checklist. Returns the saved checklist plus the
 * ids the test needs to manipulate afterwards.
 */
async function planAndSaveChecklist({ documentTitle = "Brake Service Guide", extraBody = {} } = {}) {
  const documentId = insertDocument(documentTitle);
  const planRuns = createPlanRunStore();
  const result = await runPlan({ documentId, documentTitle, planRuns });

  assert.equal(result.status, "completed");

  const app = createTestApp(planRuns);
  const response = await request(app)
    .post("/api/repair-checklists/from-planner")
    .send({ checklistDraftId: result.artifacts.checklistDraftId, ...extraBody })
    .expect(201);

  return {
    app,
    planRuns,
    documentId,
    checklistDraftId: result.artifacts.checklistDraftId,
    checklist: response.body.checklist,
  };
}

const VALID_COMPLETION = {
  performedOn: "2026-08-20",
  odometerMiles: 183456,
  outcome: "fixed",
  summary: "Replaced both front pads and bedded them in.",
  followUp: "Re-check pad seating in 500 miles.",
};

// --- Part A: durable checklist provenance -----------------------------------

test("saving a planner checklist persists structured documentId and pageNumber", async () => {
  const { checklist, documentId } = await planAndSaveChecklist();

  assert.equal(checklist.sourceCount, 1);
  assert.equal(checklist.sources[0].documentId, documentId);
  assert.equal(checklist.sources[0].pageNumber, 412);
  assert.equal(checklist.sources[0].documentTitle, "Brake Service Guide");

  // And it is really in SQLite, not just in the response shape.
  const stored = listChecklistSources(checklist.id);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].documentId, documentId);
  assert.equal(stored[0].pageNumber, 412);
});

test("the human-readable citation prose survives alongside the structured rows", async () => {
  const { checklist } = await planAndSaveChecklist({ documentTitle: "Prose Brake Guide" });

  // Structured provenance is an ADDITION. The sentence a human reads must not
  // have been traded away for it.
  assert.match(checklist.notes, /Prose Brake Guide, page 412/);
  assert.match(checklist.notes, /torque caliper bolts to 25 ft-lb/);
  assert.equal(checklist.sourceCount, 1);
});

test("a client cannot forge or replace planner provenance", async () => {
  const forgedDocumentId = insertDocument("Document The Browser Chose");

  const { checklist } = await planAndSaveChecklist({
    documentTitle: "Server Chosen Guide",
    extraBody: {
      // Everything a tampered client might try. The route reads `checklistDraftId`
      // and nothing else.
      sources: [{ documentId: forgedDocumentId, pageNumber: 9999, documentTitle: "Forged" }],
      title: "Forged title",
      notes: "Forged notes",
      items: [{ text: "Forged item" }],
    },
  });

  assert.equal(checklist.sourceCount, 1);
  assert.notEqual(checklist.sources[0].documentId, forgedDocumentId);
  assert.equal(checklist.sources[0].documentTitle, "Server Chosen Guide");
  assert.equal(checklist.sources[0].pageNumber, 412);
  assert.notEqual(checklist.title, "Forged title");
  assert.doesNotMatch(checklist.notes, /Forged/);
  assert.ok(checklist.items.every((item) => item.text !== "Forged item"));

  // The forged document exists, so a leaked row would be findable. Prove none is.
  const forged = db
    .prepare("SELECT COUNT(*) AS total FROM repair_checklist_documents WHERE document_id = ?")
    .get(forgedDocumentId).total;
  assert.equal(forged, 0);
});

test("duplicate planner citations produce exactly one durable source row", () => {
  // Two accepted claims citing the same page is the ordinary case: the plan
  // above does exactly that (numeric_spec + required_tool, both S1).
  const sources = buildDraftSources([
    { documentId: 4, documentTitle: "Guide", pageNumber: 412 },
    { documentId: 4, documentTitle: "Guide", pageNumber: 412 },
    { documentId: 4, documentTitle: "Guide", pageNumber: null },
    { documentId: 4, documentTitle: "Guide", pageNumber: null },
    { documentId: 5, documentTitle: "Other", pageNumber: 412 },
  ]);

  // Page 412 and "no page" are different facts and stay separate; exact repeats
  // collapse. First-seen order, so the result is deterministic.
  assert.deepEqual(sources, [
    { documentId: 4, documentTitle: "Guide", pageNumber: 412 },
    { documentId: 4, documentTitle: "Guide", pageNumber: null },
    { documentId: 5, documentTitle: "Other", pageNumber: 412 },
  ]);
});

test("a citation with no usable document id is dropped rather than half-stored", () => {
  assert.deepEqual(
    buildDraftSources([
      { documentId: null, documentTitle: "No id", pageNumber: 3 },
      { documentId: 0, documentTitle: "Zero", pageNumber: 3 },
      { documentId: "abc", documentTitle: "Text", pageNumber: 3 },
      { documentId: 6, documentTitle: "Real", pageNumber: 3 },
    ]),
    [{ documentId: 6, documentTitle: "Real", pageNumber: 3 }]
  );
});

test("checklist, items, and provenance save atomically", async () => {
  const documentId = insertDocument("Atomic Guide");
  const planRuns = createPlanRunStore();
  const result = await runPlan({ documentId, documentTitle: "Atomic Guide", planRuns });

  const app = createTestApp(planRuns);
  const before = db.prepare("SELECT COUNT(*) AS total FROM repair_checklists").get().total;

  // Break the provenance write only: the checklist and item inserts still
  // succeed, so if the transaction did not cover all three a titled checklist
  // with no citations would be left behind.
  //
  // The table is PARKED under another name rather than dropped and rebuilt. A
  // hand-written rebuild has to restate the table and every one of its indexes
  // from memory, and an omission there does not fail loudly -- it silently
  // leaves the rest of this file running on a schema that is not the one
  // migration 005 produces. Renaming carries the indexes along with the table,
  // so what comes back is exactly what left, and the fault injected is the same
  // one either way: the insert hits a table that is not there.
  db.exec("ALTER TABLE repair_checklist_documents RENAME TO repair_checklist_documents_parked");

  try {
    await request(app)
      .post("/api/repair-checklists/from-planner")
      .send({ checklistDraftId: result.artifacts.checklistDraftId })
      .expect(500);

    const after = db.prepare("SELECT COUNT(*) AS total FROM repair_checklists").get().total;
    assert.equal(after, before, "the checklist must not survive a failed provenance insert");
  } finally {
    db.exec("ALTER TABLE repair_checklist_documents_parked RENAME TO repair_checklist_documents");
  }

  // Prove the restore really put migration 005's shape back, so a later test
  // cannot quietly pass against a reduced schema.
  const restoredIndexes = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? ORDER BY name")
    .all("repair_checklist_documents")
    .map((row) => row.name);

  for (const expected of [
    "idx_repair_checklist_documents_checklist",
    "idx_repair_checklist_documents_document",
    "idx_repair_checklist_documents_unique",
  ]) {
    assert.ok(
      restoredIndexes.includes(expected),
      `${expected} must survive the fault-injection round trip`
    );
  }
});

// --- Provenance outlives the plan run ---------------------------------------

test("saved provenance survives the plan run being evicted for newer runs", async () => {
  const documentId = insertDocument("Eviction Guide");
  // A store with room for exactly one draft: the next plan evicts this one.
  const planRuns = createPlanRunStore({ maxRuns: 1 });
  const result = await runPlan({ documentId, documentTitle: "Eviction Guide", planRuns });

  const app = createTestApp(planRuns);
  const saved = await request(app)
    .post("/api/repair-checklists/from-planner")
    .send({ checklistDraftId: result.artifacts.checklistDraftId })
    .expect(201);

  const checklistId = saved.body.checklist.id;

  // Push a second plan through the same store, evicting the first draft.
  await runPlan({ documentId, documentTitle: "Eviction Guide", planRuns });
  assert.equal(planRuns.getChecklistDraft(result.artifacts.checklistDraftId), null);

  // The checklist's evidence is unaffected: it stopped depending on the run the
  // moment it was written.
  const stored = listChecklistSources(checklistId);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].documentId, documentId);
  assert.equal(stored[0].pageNumber, 412);
});

test("saved provenance survives the plan run expiring, and completion needs no run at all", async () => {
  const documentId = insertDocument("TTL Guide");
  let clock = 1_000_000;
  const planRuns = createPlanRunStore({ ttlMs: 1000, now: () => clock });
  const result = await runPlan({ documentId, documentTitle: "TTL Guide", planRuns });

  const app = createTestApp(planRuns);
  const saved = await request(app)
    .post("/api/repair-checklists/from-planner")
    .send({ checklistDraftId: result.artifacts.checklistDraftId })
    .expect(201);

  const checklistId = saved.body.checklist.id;

  // Days later. The draft is long gone -- the exact state a server restart also
  // produces, since the store is in memory.
  clock += 5 * 24 * 60 * 60 * 1000;
  assert.equal(planRuns.getChecklistDraft(result.artifacts.checklistDraftId), null);

  // Completion reads the checklist's own rows and never consults planRunStore,
  // so it still carries the full evidence into history.
  const completed = await request(app)
    .post(`/api/repair-checklists/${checklistId}/complete`)
    .send(VALID_COMPLETION)
    .expect(201);

  assert.equal(completed.body.repairHistory.sourceCount, 1);
  assert.equal(completed.body.repairHistory.sources[0].documentId, documentId);
  assert.equal(completed.body.repairHistory.sources[0].pageNumber, 412);
});

test("a checklist saved by one plan-run store completes through a server that has none", async () => {
  const { checklist } = await planAndSaveChecklist({ documentTitle: "Restart Guide" });

  // A brand-new, empty store stands in for the process restart: nothing in it
  // knows this checklist ever came from a plan.
  const restartedApp = createTestApp(createPlanRunStore());

  const completed = await request(restartedApp)
    .post(`/api/repair-checklists/${checklist.id}/complete`)
    .send(VALID_COMPLETION)
    .expect(201);

  assert.equal(completed.body.repairHistory.sourceCount, 1);
  assert.equal(completed.body.repairHistory.sources[0].pageNumber, 412);
});

// --- Provenance outlives the document ---------------------------------------

test("renaming a document does not change the checklist's title snapshot", async () => {
  const { checklist, documentId } = await planAndSaveChecklist({
    documentTitle: "Original Guide Title",
  });

  db.prepare("UPDATE documents SET title = ? WHERE id = ?").run("Renamed Guide", documentId);

  const stored = listChecklistSources(checklist.id);
  assert.equal(stored[0].documentId, documentId, "the live link still points at the document");
  assert.equal(
    stored[0].documentTitle,
    "Original Guide Title",
    "the snapshot is what the document was called when the evidence was recorded"
  );
});

test("deleting a document keeps the checklist and its provenance, nulling only the link", async () => {
  const { app, checklist, documentId } = await planAndSaveChecklist({
    documentTitle: "Doomed Guide",
  });

  db.prepare("DELETE FROM documents WHERE id = ?").run(documentId);

  const reread = await request(app).get(`/api/repair-checklists/${checklist.id}`).expect(200);

  assert.equal(reread.body.checklist.sourceCount, 1, "the checklist survives");
  assert.equal(reread.body.checklist.sources[0].documentId, null, "the live link is cleared");
  assert.equal(reread.body.checklist.sources[0].documentTitle, "Doomed Guide");
  assert.equal(reread.body.checklist.sources[0].pageNumber, 412);
});

// --- Part B: completion into repair history ---------------------------------

test("completing a checklist creates exactly one repair history record", async () => {
  const { app, checklist } = await planAndSaveChecklist({ documentTitle: "Completion Guide" });

  const completed = await request(app)
    .post(`/api/repair-checklists/${checklist.id}/complete`)
    .send(VALID_COMPLETION)
    .expect(201);

  assert.equal(completed.body.created, true);

  const record = completed.body.repairHistory;
  assert.equal(record.performedOn, "2026-08-20");
  assert.equal(record.odometerMiles, 183456);
  assert.equal(record.outcome, "fixed");
  assert.equal(record.summary, VALID_COMPLETION.summary);
  assert.equal(record.followUp, VALID_COMPLETION.followUp);

  const total = db
    .prepare("SELECT COUNT(*) AS total FROM repair_history WHERE checklist_id = ?")
    .get(checklist.id).total;
  assert.equal(total, 1);
});

test("history snapshots the checklist title, and the checklist moves to done", async () => {
  const { app, checklist } = await planAndSaveChecklist({ documentTitle: "Titled Guide" });

  const completed = await request(app)
    .post(`/api/repair-checklists/${checklist.id}/complete`)
    .send(VALID_COMPLETION)
    .expect(201);

  assert.equal(completed.body.repairHistory.checklistId, checklist.id);
  assert.equal(completed.body.repairHistory.checklistTitle, checklist.title);
  // The record is named by the work that was planned, not by anything the
  // caller sent.
  assert.equal(completed.body.repairHistory.title, checklist.title);
  assert.equal(completed.body.checklist.status, "done");

  // And renaming the checklist afterwards must not rewrite the snapshot.
  db.prepare("UPDATE repair_checklists SET title = ? WHERE id = ?").run(
    "Renamed after the fact",
    checklist.id
  );

  const reread = await request(app)
    .get(`/api/repair-history/${completed.body.repairHistory.id}`)
    .expect(200);
  assert.equal(reread.body.repairHistory.checklistTitle, checklist.title);
});

test("completion copies checklist provenance into repair_history_documents", async () => {
  const { app, checklist, documentId } = await planAndSaveChecklist({
    documentTitle: "Copied Guide",
  });

  const completed = await request(app)
    .post(`/api/repair-checklists/${checklist.id}/complete`)
    .send(VALID_COMPLETION)
    .expect(201);

  const { sources } = completed.body.repairHistory;
  assert.equal(sources.length, 1);
  assert.equal(sources[0].documentId, documentId);
  assert.equal(sources[0].documentTitle, "Copied Guide");
  assert.equal(sources[0].pageNumber, 412);

  // COPIED, not referenced: the checklist keeps its own rows too.
  assert.equal(listChecklistSources(checklist.id).length, 1);
});

test("completion after the source document was deleted keeps the null id, title, and page", async () => {
  const { app, checklist, documentId } = await planAndSaveChecklist({
    documentTitle: "Deleted Before Completion",
  });

  // The scenario from the roadmap: plan cites the document, checklist is saved,
  // the document is deleted, and the repair is completed days later.
  db.prepare("DELETE FROM documents WHERE id = ?").run(documentId);

  const completed = await request(app)
    .post(`/api/repair-checklists/${checklist.id}/complete`)
    .send(VALID_COMPLETION)
    .expect(201);

  const { sources } = completed.body.repairHistory;
  assert.equal(sources.length, 1, "a deleted document must not cost the record its evidence");
  assert.equal(sources[0].documentId, null);
  assert.equal(sources[0].documentTitle, "Deleted Before Completion");
  assert.equal(sources[0].pageNumber, 412);
});

test("the completion service snapshots titles itself, with no help from the route", async () => {
  // Called directly, with nothing but ids -- no route ran, so no pre-check read
  // a checklist row or a symptom title for it. Everything frozen into history
  // has to be read by the service, inside its own transaction, or this fails.
  //
  // That is the N3.1 invariant: a relationship snapshot is captured under the
  // same lock as the INSERT that stores it. A title read earlier and handed in
  // is a title from a moment that may already be over.
  const { checklist } = await planAndSaveChecklist({ documentTitle: "Self Snapshot Guide" });
  const symptomId = insertSymptom("Grinding noise when braking");

  const { created, repairHistory } = completeChecklistIntoHistory(vehicleId(), checklist.id, {
    performedOn: "2026-08-21",
    odometerMiles: 184000,
    outcome: "fixed",
    summary: "Direct service call.",
    followUp: "",
    symptomId,
  });

  assert.equal(created, true);
  assert.equal(repairHistory.title, checklist.title, "the title is read from the checklist row");
  assert.equal(repairHistory.checklistTitle, checklist.title);
  assert.equal(
    repairHistory.symptomTitle,
    "Grinding noise when braking",
    "the symptom title is read from the symptom row, not supplied"
  );
  assert.equal(repairHistory.sources.length, 1, "provenance still came from the checklist");
});

test("a document deleted BEFORE the checklist is saved still leaves its snapshot behind", async () => {
  // The sibling of the test above, and the harder one. There, the document was
  // alive when the checklist was saved, so provenance was written with a live id
  // and the foreign key nulled it later. Here the document is gone BEFORE the
  // save, which means there is no live row to read a title from and no foreign
  // key to do the nulling -- the only place the title still exists is the
  // planner's own snapshot, taken when it cited the page.
  //
  // This is the one path that exercises the missing-document branch of
  // insertChecklistSources. Without it, that branch could return an empty title,
  // or throw the way the N3.1 CRUD path deliberately does, and every other test
  // in this file would still pass.
  const documentTitle = "Deleted Before Save";
  const documentId = insertDocument(documentTitle);
  const planRuns = createPlanRunStore();
  const result = await runPlan({ documentId, documentTitle, planRuns });

  assert.equal(result.status, "completed");

  // The window this test is about: the plan is built and its evidence verified,
  // and the owner deletes the cited document before saving the plan.
  db.prepare("DELETE FROM documents WHERE id = ?").run(documentId);

  const app = createTestApp(planRuns);
  const saved = await request(app)
    .post("/api/repair-checklists/from-planner")
    .send({ checklistDraftId: result.artifacts.checklistDraftId })
    .expect(201);

  // The save must succeed. Refusing it would throw away verified evidence to
  // punish a race, and would leave the owner with no checklist at all.
  const { checklist } = saved.body;
  assert.equal(checklist.sourceCount, 1, "the citation is kept, not dropped");
  assert.equal(checklist.sources[0].documentId, null, "there is no live row to point at");
  assert.equal(
    checklist.sources[0].documentTitle,
    documentTitle,
    "the planner's snapshot is what survives when the live title is gone"
  );
  assert.equal(checklist.sources[0].pageNumber, 412);

  // And the snapshot carries through completion unchanged, which is the whole
  // point of storing it: the repair record still says which page backed it.
  const completed = await request(app)
    .post(`/api/repair-checklists/${checklist.id}/complete`)
    .send(VALID_COMPLETION)
    .expect(201);

  const { sources } = completed.body.repairHistory;
  assert.equal(sources.length, 1);
  assert.equal(sources[0].documentId, null);
  assert.equal(sources[0].documentTitle, documentTitle);
  assert.equal(sources[0].pageNumber, 412);
});

test("a hand-made checklist with no provenance completes cleanly", async () => {
  const app = createTestApp(createPlanRunStore());

  const created = await request(app)
    .post("/api/repair-checklists")
    .send({ title: "Oil change I typed myself" })
    .expect(201);

  assert.equal(created.body.checklist.sourceCount, 0);

  const completed = await request(app)
    .post(`/api/repair-checklists/${created.body.checklist.id}/complete`)
    .send({ performedOn: "2026-08-21", outcome: "fixed" })
    .expect(201);

  assert.equal(completed.body.repairHistory.sourceCount, 0);
  assert.deepEqual(completed.body.repairHistory.sources, []);
  assert.equal(completed.body.repairHistory.title, "Oil change I typed myself");
  // Odometer omitted entirely is "I did not write it down", not a reading of 0.
  assert.equal(completed.body.repairHistory.odometerMiles, null);
});

// --- Completion reuses the N3.1 validators ----------------------------------

test("completion uses the N3.1 date validation", async () => {
  const { app, checklist } = await planAndSaveChecklist({ documentTitle: "Date Guide" });

  for (const performedOn of ["", "08/20/2026", "2026-02-30", "2026-13-01", "not a date"]) {
    const response = await request(app)
      .post(`/api/repair-checklists/${checklist.id}/complete`)
      .send({ ...VALID_COMPLETION, performedOn })
      .expect(400);

    assert.match(response.body.error, /date/i);
  }

  // Nothing was written by any of those attempts.
  const total = db
    .prepare("SELECT COUNT(*) AS total FROM repair_history WHERE checklist_id = ?")
    .get(checklist.id).total;
  assert.equal(total, 0);
});

test("completion uses the N3.1 odometer validation", async () => {
  const { app, checklist } = await planAndSaveChecklist({ documentTitle: "Odometer Guide" });

  for (const odometerMiles of [-1, 2_000_001, 1234.5, "183456", ""]) {
    const response = await request(app)
      .post(`/api/repair-checklists/${checklist.id}/complete`)
      .send({ ...VALID_COMPLETION, odometerMiles })
      .expect(400);

    assert.match(response.body.error, /odometer/i);
  }

  // A genuine zero is a reading and must be accepted, exactly as in N3.1.
  const zero = await request(app)
    .post(`/api/repair-checklists/${checklist.id}/complete`)
    .send({ ...VALID_COMPLETION, odometerMiles: 0 })
    .expect(201);

  assert.equal(zero.body.repairHistory.odometerMiles, 0);
});

test("completion uses the N3.1 outcome validation", async () => {
  const { app, checklist } = await planAndSaveChecklist({ documentTitle: "Outcome Guide" });

  const rejected = await request(app)
    .post(`/api/repair-checklists/${checklist.id}/complete`)
    .send({ ...VALID_COMPLETION, outcome: "mostly_fixed" })
    .expect(400);
  assert.match(rejected.body.error, /Outcome must be/);

  // Blank means "the owner has not said yet", not an error.
  const blank = await request(app)
    .post(`/api/repair-checklists/${checklist.id}/complete`)
    .send({ ...VALID_COMPLETION, outcome: "" })
    .expect(201);
  assert.equal(blank.body.repairHistory.outcome, "unknown");
});

test("an unknown optional symptom is refused cleanly, and a real one is snapshotted", async () => {
  const { app, checklist } = await planAndSaveChecklist({ documentTitle: "Symptom Guide" });

  const missing = await request(app)
    .post(`/api/repair-checklists/${checklist.id}/complete`)
    .send({ ...VALID_COMPLETION, symptomId: 999999 })
    .expect(400);
  assert.equal(missing.body.error, "Linked symptom does not exist.");

  const malformed = await request(app)
    .post(`/api/repair-checklists/${checklist.id}/complete`)
    .send({ ...VALID_COMPLETION, symptomId: -3 })
    .expect(400);
  assert.match(malformed.body.error, /Symptom ID must be a positive number/);

  // Nothing was written by either refusal.
  assert.equal(
    db.prepare("SELECT COUNT(*) AS total FROM repair_history WHERE checklist_id = ?").get(
      checklist.id
    ).total,
    0
  );

  const symptomId = insertSymptom("Grinding when braking");
  const completed = await request(app)
    .post(`/api/repair-checklists/${checklist.id}/complete`)
    .send({ ...VALID_COMPLETION, symptomId })
    .expect(201);

  assert.equal(completed.body.repairHistory.symptomId, symptomId);
  assert.equal(completed.body.repairHistory.symptomTitle, "Grinding when braking");
});

test("a 404 checklist completes nothing", async () => {
  const app = createTestApp(createPlanRunStore());

  const response = await request(app)
    .post("/api/repair-checklists/999999/complete")
    .send(VALID_COMPLETION)
    .expect(404);

  assert.equal(response.body.error, "Checklist not found.");
});

// --- Completion atomicity and exactly-once ----------------------------------

test("a mid-completion provenance failure rolls the whole operation back", async () => {
  const { app, checklist } = await planAndSaveChecklist({ documentTitle: "Rollback Guide" });

  const historyBefore = db.prepare("SELECT COUNT(*) AS total FROM repair_history").get().total;

  // Break only the provenance copy. The history header insert and the checklist
  // status update both still succeed, so anything left behind proves the
  // transaction did not cover all three.
  db.exec("ALTER TABLE repair_history_documents RENAME TO repair_history_documents_parked");

  try {
    await request(app)
      .post(`/api/repair-checklists/${checklist.id}/complete`)
      .send(VALID_COMPLETION)
      .expect(500);

    assert.equal(
      db.prepare("SELECT COUNT(*) AS total FROM repair_history").get().total,
      historyBefore,
      "no history header may survive a failed provenance copy"
    );
    assert.equal(
      db.prepare("SELECT status FROM repair_checklists WHERE id = ?").get(checklist.id).status,
      "planned",
      "the checklist must not be left marked done by a failed completion"
    );
  } finally {
    db.exec("ALTER TABLE repair_history_documents_parked RENAME TO repair_history_documents");
  }

  // And the operation still works once the fault is cleared.
  await request(app)
    .post(`/api/repair-checklists/${checklist.id}/complete`)
    .send(VALID_COMPLETION)
    .expect(201);
});

test("repeating a completion returns the existing repair instead of creating a second", async () => {
  const { app, checklist } = await planAndSaveChecklist({ documentTitle: "Idempotent Guide" });

  const first = await request(app)
    .post(`/api/repair-checklists/${checklist.id}/complete`)
    .send(VALID_COMPLETION)
    .expect(201);
  assert.equal(first.body.created, true);

  // A double-click, a retry, or a different date typed the second time. One
  // checklist is one repair: the answer is the record it already became.
  const second = await request(app)
    .post(`/api/repair-checklists/${checklist.id}/complete`)
    .send({ ...VALID_COMPLETION, performedOn: "2026-08-25", summary: "Second attempt" })
    .expect(200);

  assert.equal(second.body.created, false);
  assert.equal(second.body.repairHistory.id, first.body.repairHistory.id);
  assert.equal(second.body.repairHistory.performedOn, "2026-08-20", "the first record is unchanged");
  assert.equal(second.body.repairHistory.summary, VALID_COMPLETION.summary);

  assert.equal(
    db.prepare("SELECT COUNT(*) AS total FROM repair_history WHERE checklist_id = ?").get(
      checklist.id
    ).total,
    1
  );
});

test("the schema itself refuses a second repair for one checklist", async () => {
  const { app, checklist } = await planAndSaveChecklist({ documentTitle: "Unique Index Guide" });

  await request(app)
    .post(`/api/repair-checklists/${checklist.id}/complete`)
    .send(VALID_COMPLETION)
    .expect(201);

  // Bypassing the service entirely: the guarantee is the partial unique index
  // from migration 005, not the read-then-write check above it.
  assert.throws(
    () =>
      db
        .prepare(`
          INSERT INTO repair_history (vehicle_id, performed_on, title, checklist_id)
          VALUES (?, ?, ?, ?)
        `)
        .run(vehicleId(), "2026-08-26", "Sneaked in", checklist.id),
    /UNIQUE constraint failed/
  );

  // The N3.1 CRUD route refuses the same thing with a sentence instead of a 500.
  const viaCrud = await request(app)
    .post("/api/repair-history")
    .send({ performedOn: "2026-08-26", title: "Via CRUD", checklistId: checklist.id })
    .expect(400);
  assert.match(viaCrud.body.error, /already recorded as repair history record/);
});

test("editing a repair record keeps the checklist link it already had", async () => {
  const { app, checklist } = await planAndSaveChecklist({ documentTitle: "Self Collision Guide" });

  const completed = await request(app)
    .post(`/api/repair-checklists/${checklist.id}/complete`)
    .send(VALID_COMPLETION)
    .expect(201);

  // Re-saving the same link must not collide with itself.
  const updated = await request(app)
    .put(`/api/repair-history/${completed.body.repairHistory.id}`)
    .send({ summary: "Corrected the summary", checklistId: checklist.id })
    .expect(200);

  assert.equal(updated.body.repairHistory.checklistId, checklist.id);
  assert.equal(updated.body.repairHistory.summary, "Corrected the summary");
});

// --- History outlives the checklist -----------------------------------------

test("deleting a completed checklist leaves the history and its copied provenance whole", async () => {
  const { app, checklist, documentId } = await planAndSaveChecklist({
    documentTitle: "Outlived Guide",
  });

  const completed = await request(app)
    .post(`/api/repair-checklists/${checklist.id}/complete`)
    .send(VALID_COMPLETION)
    .expect(201);

  const repairHistoryId = completed.body.repairHistory.id;

  await request(app).delete(`/api/repair-checklists/${checklist.id}`).expect(200);

  const reread = await request(app).get(`/api/repair-history/${repairHistoryId}`).expect(200);
  const record = reread.body.repairHistory;

  assert.equal(record.checklistId, null, "the live link is cleared");
  assert.equal(record.checklistTitle, checklist.title, "the snapshot remains");
  assert.equal(record.sourceCount, 1, "the copied provenance is untouched by the cascade");
  assert.equal(record.sources[0].documentId, documentId);
  assert.equal(record.sources[0].documentTitle, "Outlived Guide");
  assert.equal(record.sources[0].pageNumber, 412);

  // The checklist's own provenance rows went with it, as they should.
  assert.equal(listChecklistSources(checklist.id).length, 0);
});

// --- Ask / retrieval is out of reach ----------------------------------------

test("the N3.2 modules cannot reach the Ask or retrieval layer", () => {
  // A structural pin, not a behavioural one. N3.2 moves evidence that retrieval
  // already produced; it must not acquire the ability to change how that
  // evidence is found, scored, or answered from. An import appearing here is the
  // first symptom of that scope creep, and it is cheaper to catch than a drifted
  // eval.
  const forbidden = [
    "aiAnswerService",
    "askEvidenceContract",
    "chunkRetrievalService",
    "chunkRerankService",
    "documentChunkService",
    "relevanceFloor",
    "retrievalDiversity",
    "embedding",
  ];

  const modules = [
    "src/services/repairChecklistProvenanceService.js",
    "src/routes/repairChecklists.js",
    "src/services/repairHistoryService.js",
    "src/routes/repairHistory.js",
  ];

  for (const modulePath of modules) {
    const source = fs.readFileSync(new URL(`../${modulePath}`, import.meta.url), "utf8");
    const imports = source.match(/^import[\s\S]*?from\s+"[^"]+";/gm) || [];
    const importedText = imports.join("\n");

    for (const name of forbidden) {
      assert.ok(
        !importedText.includes(name),
        `${modulePath} must not import ${name}: N3.2 carries retrieval's output, it does not touch retrieval.`
      );
    }
  }
});

// --- The generic status route is unchanged ----------------------------------

test("marking a checklist done through the generic route creates no repair history", async () => {
  const { app, checklist } = await planAndSaveChecklist({ documentTitle: "Status Only Guide" });

  const updated = await request(app)
    .put(`/api/repair-checklists/${checklist.id}`)
    .send({ status: "done" })
    .expect(200);

  assert.equal(updated.body.checklist.status, "done");
  assert.equal(updated.body.checklist.sourceCount, 1, "the status edit does not disturb provenance");

  // status=done is an organizational state. Only the dedicated action records a
  // repair.
  assert.equal(
    db.prepare("SELECT COUNT(*) AS total FROM repair_history WHERE checklist_id = ?").get(
      checklist.id
    ).total,
    0
  );
});
