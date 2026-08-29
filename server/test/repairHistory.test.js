import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import request from "supertest";

// The HTTP surface of repair history. What is pinned here is that every bad
// input becomes a clean 400 with a readable message rather than a database 500,
// and that a partial update leaves the historical snapshots alone.

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-fix-helper-history-api-"));

process.env.DATABASE_FILE = path.join(tempRoot, "test.db");
process.env.UPLOADS_DIR = path.join(tempRoot, "uploads");
process.env.OPENAI_API_KEY = "";
process.env.OCR_ENABLED = "false";

const { createApp } = await import("../src/app.js");
const { db } = await import("../src/database.js");

const app = createApp();

after(() => {
  if (typeof db.close === "function") {
    db.close();
  }

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

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

function insertChecklist(title) {
  return Number(
    db
      .prepare("INSERT INTO repair_checklists (vehicle_id, title, status) VALUES (?, ?, ?)")
      .run(vehicleId(), title, "planned").lastInsertRowid
  );
}

function validBody(overrides = {}) {
  return {
    performedOn: "2026-08-14",
    title: "Front brake pads and rotors",
    ...overrides,
  };
}

test("creates, reads, lists, and deletes a repair history record", async () => {
  const symptomId = insertSymptom("Grinding when braking");
  const checklistId = insertChecklist("Front brake job");
  const documentId = insertDocument("brake-manual");

  const createResponse = await request(app)
    .post("/api/repair-history")
    .send(
      validBody({
        odometerMiles: 142350,
        outcome: "fixed",
        summary: "Replaced pads and rotors.",
        followUp: "Re-torque lug nuts after 50 miles.",
        symptomId,
        checklistId,
        sources: [{ documentId, pageNumber: 412 }],
      })
    );

  assert.equal(createResponse.status, 201);

  const created = createResponse.body.repairHistory;
  assert.ok(created.id > 0);
  assert.equal(created.performedOn, "2026-08-14");
  assert.equal(created.odometerMiles, 142350);
  assert.equal(created.outcome, "fixed");
  assert.equal(created.symptomTitle, "Grinding when braking");
  assert.equal(created.checklistTitle, "Front brake job");
  assert.equal(created.sourceCount, 1);
  assert.equal(created.sources[0].documentTitle, "brake-manual");
  assert.equal(created.sources[0].pageNumber, 412);

  const getResponse = await request(app).get(`/api/repair-history/${created.id}`);
  assert.equal(getResponse.status, 200);
  assert.equal(getResponse.body.repairHistory.title, "Front brake pads and rotors");

  const listResponse = await request(app).get("/api/repair-history");
  assert.equal(listResponse.status, 200);
  assert.ok(Array.isArray(listResponse.body.repairHistory));
  assert.ok(listResponse.body.repairHistory.some((entry) => entry.id === created.id));
  assert.equal(typeof listResponse.body.total, "number");

  const deleteResponse = await request(app).delete(`/api/repair-history/${created.id}`);
  assert.equal(deleteResponse.status, 200);

  const missing = await request(app).get(`/api/repair-history/${created.id}`);
  assert.equal(missing.status, 404);
});

test("defaults outcome to unknown and accepts a null odometer reading", async () => {
  const created = await request(app)
    .post("/api/repair-history")
    .send(validBody({ odometerMiles: null }));

  assert.equal(created.status, 201);
  assert.equal(created.body.repairHistory.outcome, "unknown");
  assert.equal(created.body.repairHistory.odometerMiles, null);
  assert.deepEqual(created.body.repairHistory.sources, []);

  // Omitting the field entirely is the same as recording nothing.
  const omitted = await request(app).post("/api/repair-history").send(validBody());
  assert.equal(omitted.status, 201);
  assert.equal(omitted.body.repairHistory.odometerMiles, null);
});

test("rejects invalid odometer readings with a clean 400", async () => {
  const cases = [
    { odometerMiles: -1, label: "negative" },
    { odometerMiles: -142350, label: "large negative" },
    { odometerMiles: 142350.5, label: "decimal" },
    { odometerMiles: 2000001, label: "above the ceiling" },
    { odometerMiles: "142350", label: "numeric string" },
  ];

  for (const { odometerMiles, label } of cases) {
    const response = await request(app)
      .post("/api/repair-history")
      .send(validBody({ odometerMiles }));

    assert.equal(response.status, 400, `${label} odometer should be a 400`);
    assert.match(response.body.error, /Odometer reading/);
  }
});

test("rejects dates that are not real YYYY-MM-DD calendar days", async () => {
  for (const performedOn of ["2026-02-30", "08/29/2026", "2026-8-29", "not a date", ""]) {
    const response = await request(app)
      .post("/api/repair-history")
      .send({ title: "Some job", performedOn });

    assert.equal(response.status, 400, `${JSON.stringify(performedOn)} should be a 400`);
    assert.match(response.body.error, /Repair date/);
  }

  // A missing date field is refused the same way -- the date is the spine of a
  // history record and cannot be inferred later.
  const missing = await request(app).post("/api/repair-history").send({ title: "Some job" });
  assert.equal(missing.status, 400);
  assert.match(missing.body.error, /Repair date/);
});

test("rejects a missing title and an unknown outcome", async () => {
  const noTitle = await request(app)
    .post("/api/repair-history")
    .send({ performedOn: "2026-08-14" });
  assert.equal(noTitle.status, 400);
  assert.match(noTitle.body.error, /Title is required/);

  const badOutcome = await request(app)
    .post("/api/repair-history")
    .send(validBody({ outcome: "resolved" }));
  assert.equal(badOutcome.status, 400);
  assert.match(badOutcome.body.error, /Outcome must be/);
});

test("refuses unknown symptom, checklist, and document ids", async () => {
  const countRecords = () =>
    Number(db.prepare("SELECT COUNT(*) AS count FROM repair_history").get().count);
  const before = countRecords();

  const badSymptom = await request(app)
    .post("/api/repair-history")
    .send(validBody({ symptomId: 999999 }));
  assert.equal(badSymptom.status, 400);
  assert.match(badSymptom.body.error, /Linked symptom does not exist/);

  const badChecklist = await request(app)
    .post("/api/repair-history")
    .send(validBody({ checklistId: 999999 }));
  assert.equal(badChecklist.status, 400);
  assert.match(badChecklist.body.error, /Linked checklist does not exist/);

  const badDocument = await request(app)
    .post("/api/repair-history")
    .send(validBody({ sources: [{ documentId: 999999, pageNumber: 3 }] }));
  assert.equal(badDocument.status, 400);
  assert.match(badDocument.body.error, /Linked document/);

  // None of the three rejected requests stored anything.
  assert.equal(countRecords(), before);
});

test("rejects a malformed sources payload instead of dropping it", async () => {
  const notAnArray = await request(app)
    .post("/api/repair-history")
    .send(validBody({ sources: "doc-1" }));
  assert.equal(notAnArray.status, 400);
  assert.match(notAnArray.body.error, /must be an array/);

  const badEntry = await request(app)
    .post("/api/repair-history")
    .send(validBody({ sources: [{ documentId: "not-a-number" }] }));
  assert.equal(badEntry.status, 400);
  assert.match(badEntry.body.error, /positive number/);

  const badPage = await request(app)
    .post("/api/repair-history")
    .send(validBody({ sources: [{ documentId: 1, pageNumber: 0 }] }));
  assert.equal(badPage.status, 400);
  assert.match(badPage.body.error, /pageNumber/);
});

test("duplicate source entries collapse to one provenance row", async () => {
  const documentId = insertDocument("cited-twice");

  const created = await request(app)
    .post("/api/repair-history")
    .send(
      validBody({
        sources: [
          { documentId, pageNumber: 88 },
          { documentId, pageNumber: 88 },
          { documentId, pageNumber: 89 },
        ],
      })
    );

  assert.equal(created.status, 201);
  assert.equal(created.body.repairHistory.sourceCount, 2);
  assert.deepEqual(
    created.body.repairHistory.sources.map((source) => source.pageNumber),
    [88, 89]
  );
});

test("a partial update leaves untouched fields and every snapshot alone", async () => {
  const symptomId = insertSymptom("Snapshot source symptom");
  const documentId = insertDocument("snapshot-source-doc");

  const created = await request(app)
    .post("/api/repair-history")
    .send(
      validBody({
        odometerMiles: 100000,
        summary: "Original summary.",
        symptomId,
        sources: [{ documentId, pageNumber: 5 }],
      })
    );

  assert.equal(created.status, 201);
  const recordId = created.body.repairHistory.id;

  db.prepare("UPDATE symptoms SET title = ? WHERE id = ?").run("Renamed later", symptomId);
  db.prepare("UPDATE documents SET title = ? WHERE id = ?").run("Renamed doc", documentId);

  const updated = await request(app)
    .put(`/api/repair-history/${recordId}`)
    .send({ outcome: "partial" });

  assert.equal(updated.status, 200);

  const record = updated.body.repairHistory;
  assert.equal(record.outcome, "partial");
  assert.equal(record.summary, "Original summary.", "an omitted field is left alone");
  assert.equal(record.odometerMiles, 100000);
  assert.equal(record.performedOn, "2026-08-14");
  assert.equal(record.symptomTitle, "Snapshot source symptom", "the snapshot must not refresh");
  assert.equal(record.sources[0].documentTitle, "snapshot-source-doc");
  assert.equal(record.sources[0].pageNumber, 5);
});

test("explicitly changing a relationship on update captures the new snapshot", async () => {
  const firstSymptomId = insertSymptom("Symptom A");
  const secondSymptomId = insertSymptom("Symptom B");
  const checklistId = insertChecklist("Checklist B");
  const documentId = insertDocument("doc-b");

  const created = await request(app)
    .post("/api/repair-history")
    .send(validBody({ symptomId: firstSymptomId }));

  const updated = await request(app)
    .put(`/api/repair-history/${created.body.repairHistory.id}`)
    .send({
      symptomId: secondSymptomId,
      checklistId,
      sources: [{ documentId, pageNumber: 31 }],
    });

  assert.equal(updated.status, 200);
  assert.equal(updated.body.repairHistory.symptomId, secondSymptomId);
  assert.equal(updated.body.repairHistory.symptomTitle, "Symptom B");
  assert.equal(updated.body.repairHistory.checklistTitle, "Checklist B");
  assert.equal(updated.body.repairHistory.sources[0].documentTitle, "doc-b");
  assert.equal(updated.body.repairHistory.sources[0].pageNumber, 31);
});

test("an update that fails validation changes nothing", async () => {
  const created = await request(app)
    .post("/api/repair-history")
    .send(validBody({ summary: "Untouched summary." }));

  const recordId = created.body.repairHistory.id;

  const rejected = await request(app)
    .put(`/api/repair-history/${recordId}`)
    .send({ summary: "Should not be saved.", odometerMiles: -10 });

  assert.equal(rejected.status, 400);
  assert.match(rejected.body.error, /Odometer reading/);

  const reread = await request(app).get(`/api/repair-history/${recordId}`);
  assert.equal(reread.body.repairHistory.summary, "Untouched summary.");
});

test("rejects malformed ids and reports missing records as 404", async () => {
  for (const badId of ["abc", "0", "-3", "1.5"]) {
    const get = await request(app).get(`/api/repair-history/${badId}`);
    assert.equal(get.status, 400);
    assert.match(get.body.error, /must be a positive number/);
  }

  const missingUpdate = await request(app)
    .put("/api/repair-history/999999")
    .send({ summary: "nope" });
  assert.equal(missingUpdate.status, 404);

  const missingDelete = await request(app).delete("/api/repair-history/999999");
  assert.equal(missingDelete.status, 404);
});

test("deleting a cited document leaves the history record readable over the API", async () => {
  const documentId = insertDocument("doomed-manual");

  const created = await request(app)
    .post("/api/repair-history")
    .send(validBody({ sources: [{ documentId, pageNumber: 77 }] }));

  const recordId = created.body.repairHistory.id;

  const deleted = await request(app).delete(`/api/documents/${documentId}`);
  assert.equal(deleted.status, 200);

  const reread = await request(app).get(`/api/repair-history/${recordId}`);

  assert.equal(reread.status, 200);
  assert.equal(reread.body.repairHistory.sourceCount, 1);
  assert.equal(reread.body.repairHistory.sources[0].documentId, null);
  assert.equal(reread.body.repairHistory.sources[0].documentTitle, "doomed-manual");
  assert.equal(reread.body.repairHistory.sources[0].pageNumber, 77);
});

test("a non-object request body is refused cleanly, not with a 500", async () => {
  // Express's JSON parser accepts a top-level array, and leaves request.body
  // undefined when there is no body at all. Both reach the route as a non-object
  // and, without the router's normalizing guard, would throw a TypeError while
  // reading a field -- surfacing as an HTML 500 before validation could answer.
  const arrayBody = await request(app)
    .post("/api/repair-history")
    .set("Content-Type", "application/json")
    .send("[]");

  assert.equal(arrayBody.status, 400);
  assert.match(arrayBody.body.error, /Title is required/);

  const noBody = await request(app).post("/api/repair-history");

  assert.equal(noBody.status, 400);
  assert.match(noBody.body.error, /Title is required/);
});
