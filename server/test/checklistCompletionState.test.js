import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import request from "supertest";

// `repairHistoryId` on a checklist payload (roadmap N3.3).
//
// The field exists so the browser can tell, on a cold load, whether a checklist
// has already been recorded as a repair. Everything below is really one
// question asked four ways: is that answer derived from the completion itself,
// or from something that only looks like completion?
//
// The distinction the whole N3.2 design rests on is that `status = 'done'` is an
// organizational state and records NO repair. A client that inferred completion
// from the status would offer to record a repair that already exists, or claim
// one that never happened -- so "merely done is still not recorded" is the
// central test here, not an edge case.

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-completion-state-"));

process.env.DATABASE_FILE = path.join(tempRoot, "test.db");
process.env.UPLOADS_DIR = path.join(tempRoot, "uploads");
process.env.OPENAI_API_KEY = "";
process.env.OCR_ENABLED = "false";

fs.mkdirSync(process.env.UPLOADS_DIR, { recursive: true });

const { createApp } = await import("../src/app.js");
const { db } = await import("../src/database.js");

const app = createApp();

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
        path.join(process.env.UPLOADS_DIR, `${title}-stored.pdf`),
        "application/pdf",
        "Brakes",
        "Repair Manual",
        "completed"
      ).lastInsertRowid
  );
}

async function createChecklist(title) {
  const response = await request(app).post("/api/repair-checklists").send({ title });

  assert.equal(response.status, 201);

  return response.body.checklist;
}

function attachProvenance(checklistId, documentId, documentTitle, pageNumber) {
  db.prepare(`
    INSERT INTO repair_checklist_documents (
      repair_checklist_id, document_id, document_title, page_number
    ) VALUES (?, ?, ?, ?)
  `).run(checklistId, documentId, documentTitle, pageNumber);
}

function findChecklistInList(checklists, checklistId) {
  return checklists.find((entry) => entry.id === checklistId);
}

// --- Tests ------------------------------------------------------------------

test("a checklist created by hand reports no recorded repair", async () => {
  const checklist = await createChecklist("Hand-written brake job");

  assert.equal(checklist.repairHistoryId, null);

  const fetched = await request(app).get(`/api/repair-checklists/${checklist.id}`);
  assert.equal(fetched.status, 200);
  assert.equal(fetched.body.checklist.repairHistoryId, null);

  const listed = await request(app).get("/api/repair-checklists");
  assert.equal(listed.status, 200);
  assert.equal(findChecklistInList(listed.body.checklists, checklist.id).repairHistoryId, null);
});

test("completing a checklist reports the repair it became, on every read", async () => {
  const checklist = await createChecklist("Front pads and rotors");

  const completed = await request(app)
    .post(`/api/repair-checklists/${checklist.id}/complete`)
    .send({ performedOn: "2026-08-20", odometerMiles: 183456, outcome: "fixed" });

  assert.equal(completed.status, 201);
  assert.equal(completed.body.created, true);

  const repairHistoryId = completed.body.repairHistory.id;
  assert.ok(repairHistoryId > 0);

  // The completion response's own checklist copy already carries it, so the
  // client does not have to re-fetch to learn what it just created.
  assert.equal(completed.body.checklist.repairHistoryId, repairHistoryId);
  assert.equal(completed.body.checklist.status, "done");

  const fetched = await request(app).get(`/api/repair-checklists/${checklist.id}`);
  assert.equal(fetched.body.checklist.repairHistoryId, repairHistoryId);

  // The list view answers identically, from its batched query rather than a
  // per-row lookup -- the two must not be able to disagree.
  const listed = await request(app).get("/api/repair-checklists");
  assert.equal(
    findChecklistInList(listed.body.checklists, checklist.id).repairHistoryId,
    repairHistoryId
  );
});

test("a checklist merely marked done records no repair and says so", async () => {
  const checklist = await createChecklist("Marked done by hand");

  const updated = await request(app)
    .put(`/api/repair-checklists/${checklist.id}`)
    .send({ status: "done" });

  assert.equal(updated.status, 200);
  assert.equal(updated.body.checklist.status, "done");
  // THE POINT: done is an organizational state. It writes nothing to history,
  // and the payload must not let a client read it as if it had.
  assert.equal(updated.body.checklist.repairHistoryId, null);

  const historyRows = db
    .prepare("SELECT COUNT(*) AS total FROM repair_history WHERE checklist_id = ?")
    .get(checklist.id);
  assert.equal(historyRows.total, 0);

  const listed = await request(app).get("/api/repair-checklists");
  assert.equal(findChecklistInList(listed.body.checklists, checklist.id).repairHistoryId, null);
});

test("a repeated completion reports the same repair rather than a second one", async () => {
  const checklist = await createChecklist("Coolant flush");

  const first = await request(app)
    .post(`/api/repair-checklists/${checklist.id}/complete`)
    .send({ performedOn: "2026-07-01" });
  assert.equal(first.status, 201);

  const second = await request(app)
    .post(`/api/repair-checklists/${checklist.id}/complete`)
    .send({ performedOn: "2026-07-02", outcome: "partial" });

  assert.equal(second.status, 200);
  assert.equal(second.body.created, false);
  assert.equal(second.body.repairHistory.id, first.body.repairHistory.id);
  assert.equal(second.body.checklist.repairHistoryId, first.body.repairHistory.id);
});

test("the recorded repair survives deleting a document that backed it", async () => {
  const documentId = insertDocument("Brake Service Guide");
  const checklist = await createChecklist("Rear brake job");

  attachProvenance(checklist.id, documentId, "Brake Service Guide", 4);

  const completed = await request(app)
    .post(`/api/repair-checklists/${checklist.id}/complete`)
    .send({ performedOn: "2026-08-25", odometerMiles: 190000, outcome: "fixed" });

  assert.equal(completed.status, 201);

  const repairHistoryId = completed.body.repairHistory.id;
  assert.equal(completed.body.repairHistory.sources.length, 1);
  assert.equal(completed.body.repairHistory.sources[0].documentId, documentId);

  const deleted = await request(app).delete(`/api/documents/${documentId}`);
  assert.equal(deleted.status, 200);

  // The checklist still points at the same repair...
  const fetched = await request(app).get(`/api/repair-checklists/${checklist.id}`);
  assert.equal(fetched.body.checklist.repairHistoryId, repairHistoryId);

  // ...and the repair still remembers the page, minus the live link.
  const history = await request(app).get(`/api/repair-history/${repairHistoryId}`);
  assert.equal(history.status, 200);
  assert.equal(history.body.repairHistory.sources.length, 1);
  assert.equal(history.body.repairHistory.sources[0].documentId, null);
  assert.equal(history.body.repairHistory.sources[0].documentTitle, "Brake Service Guide");
  assert.equal(history.body.repairHistory.sources[0].pageNumber, 4);
});

test("deleting the completed checklist leaves the repair whole", async () => {
  const checklist = await createChecklist("Serpentine belt");

  const completed = await request(app)
    .post(`/api/repair-checklists/${checklist.id}/complete`)
    .send({ performedOn: "2026-06-10", outcome: "fixed" });

  const repairHistoryId = completed.body.repairHistory.id;

  const deleted = await request(app).delete(`/api/repair-checklists/${checklist.id}`);
  assert.equal(deleted.status, 200);

  const history = await request(app).get(`/api/repair-history/${repairHistoryId}`);
  assert.equal(history.status, 200);
  // The live link is gone; the snapshot the owner reads is not.
  assert.equal(history.body.repairHistory.checklistId, null);
  assert.equal(history.body.repairHistory.checklistTitle, "Serpentine belt");
  assert.equal(history.body.repairHistory.title, "Serpentine belt");
});

test("a client-supplied title or provenance is ignored by completion", async () => {
  const documentId = insertDocument("Cooling System Manual");
  const checklist = await createChecklist("Thermostat replacement");

  attachProvenance(checklist.id, documentId, "Cooling System Manual", 12);

  const completed = await request(app)
    .post(`/api/repair-checklists/${checklist.id}/complete`)
    .send({
      performedOn: "2026-08-28",
      // None of these may reach the record: the server owns the title and reads
      // provenance from the checklist's own rows.
      title: "Something the owner never planned",
      sources: [{ documentId: 999999, pageNumber: 3 }],
      checklistId: 4242,
    });

  assert.equal(completed.status, 201);

  const record = completed.body.repairHistory;
  assert.equal(record.title, "Thermostat replacement");
  assert.equal(record.checklistId, checklist.id);
  assert.equal(record.sources.length, 1);
  assert.equal(record.sources[0].documentId, documentId);
  assert.equal(record.sources[0].pageNumber, 12);
});
