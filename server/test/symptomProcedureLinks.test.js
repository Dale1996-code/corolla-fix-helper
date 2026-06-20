import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import express from "express";
import request from "supertest";

const tempRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "corolla-fix-helper-symptom-procedure-")
);

process.env.DATABASE_FILE = path.join(tempRoot, "links.db");
process.env.UPLOADS_DIR = path.join(tempRoot, "uploads");
process.env.OPENAI_API_KEY = "";

const { db } = await import("../src/database.js");
const { initializeDatabase } = await import("../src/initDatabase.js");
const { symptomsRouter } = await import("../src/routes/symptoms.js");
const { proceduresRouter } = await import("../src/routes/procedures.js");

initializeDatabase();

const app = express();
app.use(express.json());
app.use("/api/symptoms", symptomsRouter);
app.use("/api/procedures", proceduresRouter);

after(() => {
  if (typeof db.close === "function") {
    db.close();
  }

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function vehicleId() {
  return db.prepare("SELECT id FROM vehicles ORDER BY id ASC LIMIT 1").get().id;
}

function insertSymptom(title, system = "Engine") {
  return Number(
    db
      .prepare(
        "INSERT INTO symptoms (vehicle_id, title, system, status) VALUES (?, ?, ?, ?)"
      )
      .run(vehicleId(), title, system, "open").lastInsertRowid
  );
}

function insertProcedure(title, system = "Engine") {
  return Number(
    db
      .prepare(
        "INSERT INTO procedures (vehicle_id, title, system, difficulty) VALUES (?, ?, ?, ?)"
      )
      .run(vehicleId(), title, system, "beginner").lastInsertRowid
  );
}

test("symptom_procedures join table exists", () => {
  const table = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'symptom_procedures'"
    )
    .get();

  assert.ok(table, "symptom_procedures table should exist");

  const columnNames = db
    .prepare("PRAGMA table_info(symptom_procedures)")
    .all()
    .map((column) => column.name);

  assert.deepEqual([...columnNames].sort(), ["procedure_id", "symptom_id"]);
});

test("PUT /api/symptoms/:id/procedures creates and replaces the link set", async () => {
  const symptomId = insertSymptom("Rough idle at stoplight");
  const procedureA = insertProcedure("Clean the throttle body");
  const procedureB = insertProcedure("Replace spark plugs");

  const linkResponse = await request(app)
    .put(`/api/symptoms/${symptomId}/procedures`)
    .send({ procedureIds: [procedureA, procedureB] });

  assert.equal(linkResponse.status, 200);
  assert.deepEqual(
    [...linkResponse.body.symptom.linkedProcedureIds].sort((a, b) => a - b),
    [procedureA, procedureB].sort((a, b) => a - b)
  );

  // Replacing the set with one id drops the other (DELETE-then-INSERT).
  const replaceResponse = await request(app)
    .put(`/api/symptoms/${symptomId}/procedures`)
    .send({ procedureIds: [procedureA] });

  assert.equal(replaceResponse.status, 200);
  assert.deepEqual(replaceResponse.body.symptom.linkedProcedureIds, [procedureA]);
});

test("GET /api/symptoms/:id includes linked procedures", async () => {
  const symptomId = insertSymptom("Brake squeal when cold", "Brakes");
  const procedureId = insertProcedure("Inspect brake pads", "Brakes");

  await request(app)
    .put(`/api/symptoms/${symptomId}/procedures`)
    .send({ procedureIds: [procedureId] });

  const response = await request(app).get(`/api/symptoms/${symptomId}`);

  assert.equal(response.status, 200);
  assert.equal(response.body.symptom.linkedProcedures.length, 1);
  assert.equal(response.body.symptom.linkedProcedures[0].id, procedureId);
  assert.equal(response.body.symptom.linkedProcedures[0].title, "Inspect brake pads");
  assert.equal(response.body.symptom.linkedProcedures[0].system, "Brakes");
});

test("GET /api/procedures/:id includes linked symptoms", async () => {
  const symptomId = insertSymptom("Hesitation under load");
  const procedureId = insertProcedure("Fuel system test");

  await request(app)
    .put(`/api/symptoms/${symptomId}/procedures`)
    .send({ procedureIds: [procedureId] });

  const response = await request(app).get(`/api/procedures/${procedureId}`);

  assert.equal(response.status, 200);
  assert.equal(response.body.procedure.linkedSymptoms.length, 1);
  assert.equal(response.body.procedure.linkedSymptoms[0].id, symptomId);
  assert.equal(response.body.procedure.linkedSymptoms[0].title, "Hesitation under load");
  assert.equal(response.body.procedure.linkedSymptoms[0].status, "open");
});

test("PUT /api/procedures/:id/symptoms links symptoms the other direction", async () => {
  const procedureId = insertProcedure("Coolant flush");
  const symptomA = insertSymptom("Overheating in traffic", "Cooling");
  const symptomB = insertSymptom("Coolant smell", "Cooling");

  const response = await request(app)
    .put(`/api/procedures/${procedureId}/symptoms`)
    .send({ symptomIds: [symptomA, symptomB] });

  assert.equal(response.status, 200);
  assert.deepEqual(
    [...response.body.procedure.linkedSymptomIds].sort((a, b) => a - b),
    [symptomA, symptomB].sort((a, b) => a - b)
  );

  // The link is visible from the symptom side too.
  const symptomResponse = await request(app).get(`/api/symptoms/${symptomA}`);
  assert.ok(
    symptomResponse.body.symptom.linkedProcedureIds.includes(procedureId)
  );
});

test("deleting a symptom cascades and removes its join rows", async () => {
  const symptomId = insertSymptom("Cascade symptom");
  const procedureId = insertProcedure("Cascade procedure");

  await request(app)
    .put(`/api/symptoms/${symptomId}/procedures`)
    .send({ procedureIds: [procedureId] });

  assert.equal(
    db
      .prepare("SELECT COUNT(*) AS count FROM symptom_procedures WHERE symptom_id = ?")
      .get(symptomId).count,
    1
  );

  const deleteResponse = await request(app).delete(`/api/symptoms/${symptomId}`);
  assert.equal(deleteResponse.status, 200);

  assert.equal(
    db
      .prepare("SELECT COUNT(*) AS count FROM symptom_procedures WHERE symptom_id = ?")
      .get(symptomId).count,
    0
  );
});

test("deleting a procedure cascades and removes its join rows", async () => {
  const symptomId = insertSymptom("Cascade symptom 2");
  const procedureId = insertProcedure("Cascade procedure 2");

  await request(app)
    .put(`/api/symptoms/${symptomId}/procedures`)
    .send({ procedureIds: [procedureId] });

  const deleteResponse = await request(app).delete(`/api/procedures/${procedureId}`);
  assert.equal(deleteResponse.status, 200);

  assert.equal(
    db
      .prepare("SELECT COUNT(*) AS count FROM symptom_procedures WHERE procedure_id = ?")
      .get(procedureId).count,
    0
  );
});

test("PUT /api/symptoms/:id/procedures returns 404 for a missing symptom", async () => {
  const response = await request(app)
    .put("/api/symptoms/999999/procedures")
    .send({ procedureIds: [] });

  assert.equal(response.status, 404);
});
