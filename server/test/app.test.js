import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import request from "supertest";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-fix-helper-server-"));

process.env.DATABASE_FILE = path.join(tempRoot, "test.db");
process.env.UPLOADS_DIR = path.join(tempRoot, "uploads");
process.env.PORT = "4100";
process.env.CLIENT_PORT = "5174";

const { createApp } = await import("../src/app.js");
const { db } = await import("../src/database.js");

const app = createApp();

after(() => {
  if (typeof db.close === "function") {
    db.close();
  }

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("GET /api/settings returns vehicle and runtime info", async () => {
  const response = await request(app).get("/api/settings");

  assert.equal(response.status, 200);
  assert.equal(typeof response.body.vehicle.id, "number");
  assert.equal(typeof response.body.vehicle.make, "string");
  assert.equal(response.body.runtime.databaseFile, process.env.DATABASE_FILE);
  assert.equal(response.body.runtime.uploadsDir, process.env.UPLOADS_DIR);
  assert.equal(response.body.runtime.pathsEditable, false);
  assert.ok(Array.isArray(response.body.documentDefaults.commonSystems));
  assert.ok(response.body.documentDefaults.commonSystems.includes("Engine"));
  assert.ok(Array.isArray(response.body.documentDefaults.documentTypes));
  assert.equal(response.body.backupExport.supported, false);
});

test("PUT /api/settings/vehicle updates the stored vehicle profile", async () => {
  const updatedVehicle = {
    year: 2010,
    make: "Toyota",
    model: "Matrix",
    trim: "S",
    engine: "1.8L",
  };

  const updateResponse = await request(app)
    .put("/api/settings/vehicle")
    .send(updatedVehicle);

  assert.equal(updateResponse.status, 200);
  assert.equal(updateResponse.body.vehicle.year, updatedVehicle.year);
  assert.equal(updateResponse.body.vehicle.model, updatedVehicle.model);
  assert.equal(updateResponse.body.vehicle.trim, updatedVehicle.trim);

  const getResponse = await request(app).get("/api/settings");

  assert.equal(getResponse.status, 200);
  assert.equal(getResponse.body.vehicle.year, updatedVehicle.year);
  assert.equal(getResponse.body.vehicle.model, updatedVehicle.model);
  assert.equal(getResponse.body.vehicle.trim, updatedVehicle.trim);
});

test("PUT /api/settings/document-defaults updates reusable document defaults", async () => {
  const updatedDefaults = {
    commonSystems: ["Engine", "Cooling", "Electrical"],
    documentTypes: ["Repair Manual", "Inspection", "Reference"],
  };

  const updateResponse = await request(app)
    .put("/api/settings/document-defaults")
    .send(updatedDefaults);

  assert.equal(updateResponse.status, 200);
  assert.deepEqual(
    updateResponse.body.documentDefaults.commonSystems,
    updatedDefaults.commonSystems
  );
  assert.deepEqual(
    updateResponse.body.documentDefaults.documentTypes,
    updatedDefaults.documentTypes
  );

  const getResponse = await request(app).get("/api/settings");

  assert.equal(getResponse.status, 200);
  assert.deepEqual(
    getResponse.body.documentDefaults.commonSystems,
    updatedDefaults.commonSystems
  );
  assert.deepEqual(
    getResponse.body.documentDefaults.documentTypes,
    updatedDefaults.documentTypes
  );
});

test("existing core routes still respond after the app startup refactor", async () => {
  const [healthResponse, documentsResponse, symptomsResponse] = await Promise.all([
    request(app).get("/api/health"),
    request(app).get("/api/documents"),
    request(app).get("/api/symptoms"),
  ]);

  assert.equal(healthResponse.status, 200);
  assert.equal(healthResponse.body.status, "ok");
  assert.equal(documentsResponse.status, 200);
  assert.ok(Array.isArray(documentsResponse.body.documents));
  assert.equal(symptomsResponse.status, 200);
  assert.ok(Array.isArray(symptomsResponse.body.symptoms));
});

test("notes API returns linked symptom and procedure details", async () => {
  const vehicle = db.prepare("SELECT id FROM vehicles ORDER BY id ASC LIMIT 1").get();

  assert.ok(vehicle);

  const symptomId = Number(
    db.prepare(`
      INSERT INTO symptoms (vehicle_id, title, system, status)
      VALUES (?, ?, ?, ?)
    `).run(vehicle.id, "Rough idle at stoplight", "Engine", "monitoring").lastInsertRowid
  );

  const procedureId = Number(
    db.prepare(`
      INSERT INTO procedures (vehicle_id, title, system, difficulty)
      VALUES (?, ?, ?, ?)
    `).run(vehicle.id, "Throttle body cleaning", "Engine", "beginner").lastInsertRowid
  );

  const symptomNoteResponse = await request(app)
    .post("/api/notes")
    .send({
      title: "Track idle change after cleaning",
      content: "Watch RPM after the next cold start.",
      noteType: "observation",
      relatedEntityType: "symptom",
      relatedEntityId: symptomId,
    });

  assert.equal(symptomNoteResponse.status, 201);
  assert.equal(symptomNoteResponse.body.note.relatedEntityType, "symptom");
  assert.equal(symptomNoteResponse.body.note.relatedEntityId, symptomId);
  assert.equal(symptomNoteResponse.body.note.linkedSymptom.title, "Rough idle at stoplight");
  assert.equal(symptomNoteResponse.body.note.linkedSymptom.status, "monitoring");

  const procedureNoteResponse = await request(app)
    .post("/api/notes")
    .send({
      title: "Use the basic throttle body walkthrough",
      content: "Start with the easy version before removing extra parts.",
      noteType: "repair_log",
      relatedEntityType: "procedure",
      relatedEntityId: procedureId,
    });

  assert.equal(procedureNoteResponse.status, 201);
  assert.equal(procedureNoteResponse.body.note.relatedEntityType, "procedure");
  assert.equal(procedureNoteResponse.body.note.relatedEntityId, procedureId);
  assert.equal(procedureNoteResponse.body.note.linkedProcedure.title, "Throttle body cleaning");
  assert.equal(procedureNoteResponse.body.note.linkedProcedure.difficulty, "beginner");

  const listResponse = await request(app).get("/api/notes");

  assert.equal(listResponse.status, 200);

  const symptomNote = listResponse.body.notes.find(
    (note) => note.title === "Track idle change after cleaning"
  );
  const procedureNote = listResponse.body.notes.find(
    (note) => note.title === "Use the basic throttle body walkthrough"
  );

  assert.ok(symptomNote);
  assert.equal(symptomNote.linkedSymptom.title, "Rough idle at stoplight");
  assert.equal(symptomNote.linkedProcedure, null);

  assert.ok(procedureNote);
  assert.equal(procedureNote.linkedProcedure.title, "Throttle body cleaning");
  assert.equal(procedureNote.linkedSymptom, null);
});

test("notes API updates linked note targets across documents, symptoms, and procedures", async () => {
  const vehicle = db.prepare("SELECT id FROM vehicles ORDER BY id ASC LIMIT 1").get();

  assert.ok(vehicle);

  const documentId = Number(
    db.prepare(`
      INSERT INTO documents (
        vehicle_id,
        title,
        original_filename,
        stored_filename,
        file_path,
        file_type,
        system,
        document_type
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      vehicle.id,
      "Idle inspection notes",
      "idle-inspection.pdf",
      "idle-inspection-copy.pdf",
      "C:/temp/idle-inspection.pdf",
      "application/pdf",
      "Engine",
      "Reference"
    ).lastInsertRowid
  );

  const symptomId = Number(
    db.prepare(`
      INSERT INTO symptoms (vehicle_id, title, system, status)
      VALUES (?, ?, ?, ?)
    `).run(vehicle.id, "Idle drops after warmup", "Engine", "monitoring").lastInsertRowid
  );

  const procedureId = Number(
    db.prepare(`
      INSERT INTO procedures (vehicle_id, title, system, difficulty)
      VALUES (?, ?, ?, ?)
    `).run(vehicle.id, "Idle relearn steps", "Engine", "intermediate").lastInsertRowid
  );

  const createdResponse = await request(app)
    .post("/api/notes")
    .send({
      title: "Start from the idle inspection PDF",
      content: "Check the baseline document first.",
      noteType: "general",
      relatedEntityType: "document",
      relatedEntityId: documentId,
    });

  assert.equal(createdResponse.status, 201);
  assert.equal(createdResponse.body.note.linkedDocument.title, "Idle inspection notes");
  assert.equal(createdResponse.body.note.linkedSymptom, null);
  assert.equal(createdResponse.body.note.linkedProcedure, null);

  const noteId = createdResponse.body.note.id;

  const symptomUpdateResponse = await request(app)
    .put(`/api/notes/${noteId}`)
    .send({
      relatedEntityType: "symptom",
      relatedEntityId: symptomId,
    });

  assert.equal(symptomUpdateResponse.status, 200);
  assert.equal(symptomUpdateResponse.body.note.relatedEntityType, "symptom");
  assert.equal(symptomUpdateResponse.body.note.relatedEntityId, symptomId);
  assert.equal(symptomUpdateResponse.body.note.linkedDocument, null);
  assert.equal(symptomUpdateResponse.body.note.linkedSymptom.title, "Idle drops after warmup");
  assert.equal(symptomUpdateResponse.body.note.linkedProcedure, null);

  const procedureUpdateResponse = await request(app)
    .put(`/api/notes/${noteId}`)
    .send({
      relatedEntityType: "procedure",
      relatedEntityId: procedureId,
    });

  assert.equal(procedureUpdateResponse.status, 200);
  assert.equal(procedureUpdateResponse.body.note.relatedEntityType, "procedure");
  assert.equal(procedureUpdateResponse.body.note.relatedEntityId, procedureId);
  assert.equal(procedureUpdateResponse.body.note.linkedDocument, null);
  assert.equal(procedureUpdateResponse.body.note.linkedSymptom, null);
  assert.equal(procedureUpdateResponse.body.note.linkedProcedure.title, "Idle relearn steps");
});
