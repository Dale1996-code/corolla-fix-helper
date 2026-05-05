import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import request from "supertest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, "fixtures");

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
  assert.equal(response.body.backupExport.supported, true);
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

test("documents API keeps favorites as the only saved-document flag in V1", async () => {
  const response = await request(app).get("/api/documents");

  assert.equal(response.status, 200);
  assert.ok(Array.isArray(response.body.documents));
  assert.ok(response.body.documents.length > 0);

  const firstDocument = response.body.documents[0];

  assert.equal(typeof firstDocument.isFavorite, "boolean");
  assert.equal("tags" in firstDocument, false);
  assert.equal("isBookmarked" in firstDocument, false);
});

test("POST /api/documents/:id/extract re-runs extraction and updates status fields", async () => {
  const vehicle = db.prepare("SELECT id FROM vehicles ORDER BY id ASC LIMIT 1").get();
  assert.ok(vehicle);

  const sourcePdf = path.join(fixturesDir, "sample-maintenance-schedule.pdf");
  const storedFilename = "extract-rerun-test.pdf";
  const uploadedPdfPath = path.join(process.env.UPLOADS_DIR, storedFilename);
  fs.copyFileSync(sourcePdf, uploadedPdfPath);

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
        document_type,
        extracted_text,
        extraction_status,
        page_count
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      vehicle.id,
      "Extraction retry test document",
      "extract-rerun-test.pdf",
      storedFilename,
      `server/uploads/${storedFilename}`,
      "application/pdf",
      "Engine",
      "Reference",
      "",
      "failed: prior error",
      null
    ).lastInsertRowid
  );

  const response = await request(app).post(`/api/documents/${documentId}/extract`);

  assert.equal(response.status, 200);
  assert.equal(response.body.message, "Extraction re-run complete.");
  assert.equal(response.body.document.id, documentId);
  assert.ok(["completed", "no_text_found"].includes(response.body.document.extractionStatus));
  assert.equal(typeof response.body.document.extractedText, "string");
  assert.equal(typeof response.body.document.pageCount, "number");
});

test("POST /api/documents/:id/extract returns 404 when document does not exist", async () => {
  const response = await request(app).post("/api/documents/999999/extract");

  assert.equal(response.status, 404);
  assert.equal(response.body.error, "Document not found.");
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

test("search API keeps legacy document search compatible with /api/search/documents", async () => {
  const vehicle = db.prepare("SELECT id FROM vehicles ORDER BY id ASC LIMIT 1").get();

  assert.ok(vehicle);

  db.prepare(`
    INSERT INTO documents (
      vehicle_id,
      title,
      original_filename,
      stored_filename,
      file_path,
      file_type,
      system,
      document_type,
      notes,
      extracted_text,
      is_favorite
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    vehicle.id,
    "Thermostat replacement bulletin",
    "thermostat-bulletin.pdf",
    "thermostat-bulletin-copy.pdf",
    "C:/temp/thermostat-bulletin.pdf",
    "application/pdf",
    "Cooling",
    "Bulletin",
    "Use this bulletin when the thermostat housing starts seeping.",
    "Thermostat torque specs and coolant refill notes.",
    1
  );

  const [legacyResponse, documentsResponse] = await Promise.all([
    request(app).get("/api/search").query({ q: "thermostat", system: "Cooling" }),
    request(app).get("/api/search/documents").query({ q: "thermostat", system: "Cooling" }),
  ]);

  assert.equal(legacyResponse.status, 200);
  assert.equal(documentsResponse.status, 200);
  assert.deepEqual(legacyResponse.body, documentsResponse.body);
  assert.ok(legacyResponse.body.results.length >= 1);
  assert.equal(legacyResponse.body.results[0].title, "Thermostat replacement bulletin");
  assert.equal(legacyResponse.body.results[0].system, "Cooling");
  assert.equal(legacyResponse.body.results[0].documentType, "Bulletin");
  assert.match(legacyResponse.body.results[0].snippet, /thermostat/i);
  assert.ok(Array.isArray(legacyResponse.body.filters.systems));
  assert.ok(legacyResponse.body.filters.systems.includes("Cooling"));
  assert.ok(Array.isArray(legacyResponse.body.filters.documentTypes));
  assert.ok(legacyResponse.body.filters.documentTypes.includes("Bulletin"));
});

test("GET /api/search/symptoms returns matching symptoms with filters and snippets", async () => {
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
      "Idle airflow diagram",
      "idle-airflow-diagram.pdf",
      "idle-airflow-diagram-copy.pdf",
      "C:/temp/idle-airflow-diagram.pdf",
      "application/pdf",
      "Engine",
      "Diagram"
    ).lastInsertRowid
  );

  const symptomId = Number(
    db.prepare(`
      INSERT INTO symptoms (
        vehicle_id,
        title,
        description,
        system,
        suspected_causes,
        confidence,
        status,
        notes
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      vehicle.id,
      "Idle surge after warm start",
      "The idle climbs and drops for a few seconds after a warm restart.",
      "Engine",
      "Dirty throttle body or vacuum leak",
      "high",
      "monitoring",
      "Check the throttle plate before replacing parts."
    ).lastInsertRowid
  );

  db.prepare(`
    INSERT INTO symptom_documents (symptom_id, document_id)
    VALUES (?, ?)
  `).run(symptomId, documentId);

  db.prepare(`
    INSERT INTO symptoms (
      vehicle_id,
      title,
      description,
      system,
      status
    )
    VALUES (?, ?, ?, ?, ?)
  `).run(
    vehicle.id,
    "Rear brake squeak",
    "Short squeak during light braking.",
    "Brakes",
    "open"
  );

  const response = await request(app)
    .get("/api/search/symptoms")
    .query({ q: "throttle", system: "Engine", status: "monitoring" });

  assert.equal(response.status, 200);
  assert.equal(response.body.total, 1);
  assert.equal(response.body.results[0].title, "Idle surge after warm start");
  assert.equal(response.body.results[0].system, "Engine");
  assert.equal(response.body.results[0].status, "monitoring");
  assert.equal(response.body.results[0].confidence, "high");
  assert.match(response.body.results[0].snippet, /throttle/i);
  assert.equal(response.body.results[0].snippetField, "Suspected causes");
  assert.equal(response.body.results[0].linkedDocumentCount, 1);
  assert.equal(response.body.results[0].linkedDocuments.length, 1);
  assert.equal(response.body.results[0].linkedDocuments[0].title, "Idle airflow diagram");
  assert.ok(response.body.filters.systems.includes("Engine"));
  assert.ok(response.body.filters.systems.includes("Brakes"));
  assert.ok(response.body.filters.statuses.includes("monitoring"));
  assert.ok(response.body.filters.statuses.includes("open"));
});

test("GET /api/search/procedures returns matching procedures with filters and snippets", async () => {
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
      "Throttle cleaning checklist",
      "throttle-cleaning-checklist.pdf",
      "throttle-cleaning-checklist-copy.pdf",
      "C:/temp/throttle-cleaning-checklist.pdf",
      "application/pdf",
      "Engine",
      "Checklist"
    ).lastInsertRowid
  );

  const procedureId = Number(
    db.prepare(`
      INSERT INTO procedures (
        vehicle_id,
        title,
        system,
        difficulty,
        tools_needed,
        parts_needed,
        safety_notes,
        steps,
        notes,
        confidence
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      vehicle.id,
      "Clean the throttle body",
      "Engine",
      "beginner",
      "Socket set and shop towels",
      "Throttle body cleaner",
      "Keep hands clear of the throttle plate edge.",
      "Remove the intake tube, spray cleaner, and wipe the throttle body.",
      "Use light pressure so the coating is not damaged.",
      "medium"
    ).lastInsertRowid
  );

  db.prepare(`
    INSERT INTO procedure_documents (procedure_id, document_id)
    VALUES (?, ?)
  `).run(procedureId, documentId);

  db.prepare(`
    INSERT INTO procedures (
      vehicle_id,
      title,
      system,
      difficulty,
      steps
    )
    VALUES (?, ?, ?, ?, ?)
  `).run(
    vehicle.id,
    "Replace cabin air filter",
    "HVAC",
    "beginner",
    "Open the glove box and swap the filter."
  );

  const response = await request(app)
    .get("/api/search/procedures")
    .query({ q: "cleaner", system: "Engine", difficulty: "beginner" });

  assert.equal(response.status, 200);
  assert.equal(response.body.total, 1);
  assert.equal(response.body.results[0].title, "Clean the throttle body");
  assert.equal(response.body.results[0].system, "Engine");
  assert.equal(response.body.results[0].difficulty, "beginner");
  assert.match(response.body.results[0].snippet, /cleaner/i);
  assert.equal(response.body.results[0].snippetField, "Parts needed");
  assert.equal(response.body.results[0].linkedDocumentCount, 1);
  assert.equal(response.body.results[0].linkedDocuments.length, 1);
  assert.equal(
    response.body.results[0].linkedDocuments[0].title,
    "Throttle cleaning checklist"
  );
  assert.ok(response.body.filters.systems.includes("Engine"));
  assert.ok(response.body.filters.systems.includes("HVAC"));
  assert.ok(response.body.filters.difficulties.includes("beginner"));
});

test("GET /api/search/notes returns matching notes with filters and linked entity details", async () => {
  const vehicle = db.prepare("SELECT id FROM vehicles ORDER BY id ASC LIMIT 1").get();

  assert.ok(vehicle);

  const procedureId = Number(
    db.prepare(`
      INSERT INTO procedures (vehicle_id, title, system, difficulty)
      VALUES (?, ?, ?, ?)
    `).run(vehicle.id, "Torque wheel lug nuts", "Wheels", "beginner").lastInsertRowid
  );

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
      "Wheel torque spec sheet",
      "wheel-torque-specs.pdf",
      "wheel-torque-specs-copy.pdf",
      "C:/temp/wheel-torque-specs.pdf",
      "application/pdf",
      "Wheels",
      "Specification"
    ).lastInsertRowid
  );

  const createdProcedureNote = await request(app)
    .post("/api/notes")
    .send({
      title: "Wheel torque reminder",
      content: "Torque the lug nuts again after 50 miles.",
      noteType: "reminder",
      relatedEntityType: "procedure",
      relatedEntityId: procedureId,
    });

  assert.equal(createdProcedureNote.status, 201);

  const createdDocumentNote = await request(app)
    .post("/api/notes")
    .send({
      title: "Wheel spec reference",
      content: "The PDF has the factory torque numbers.",
      noteType: "general",
      relatedEntityType: "document",
      relatedEntityId: documentId,
    });

  assert.equal(createdDocumentNote.status, 201);

  const response = await request(app)
    .get("/api/search/notes")
    .query({ q: "torque", noteType: "reminder", relatedEntityType: "procedure" });

  assert.equal(response.status, 200);
  assert.equal(response.body.total, 1);
  assert.equal(response.body.results[0].title, "Wheel torque reminder");
  assert.equal(response.body.results[0].noteType, "reminder");
  assert.equal(response.body.results[0].relatedEntityType, "procedure");
  assert.equal(response.body.results[0].linkedTitle, "Torque wheel lug nuts");
  assert.equal(response.body.results[0].linkedProcedure.title, "Torque wheel lug nuts");
  assert.equal(response.body.results[0].linkedDocument, null);
  assert.match(response.body.results[0].snippet, /torque/i);
  assert.equal(response.body.results[0].snippetField, "Content");
  assert.ok(response.body.filters.noteTypes.includes("reminder"));
  assert.ok(response.body.filters.noteTypes.includes("general"));
  assert.ok(response.body.filters.relatedEntityTypes.includes("procedure"));
  assert.ok(response.body.filters.relatedEntityTypes.includes("document"));
});


test("DELETE /api/documents/:id removes document file and clears links safely", async () => {
  const vehicle = db.prepare("SELECT id FROM vehicles ORDER BY id ASC LIMIT 1").get();
  assert.ok(vehicle);

  const insertDocument = db.prepare(`
    INSERT INTO documents (
      vehicle_id,
      title,
      original_filename,
      stored_filename,
      file_path,
      file_type,
      system,
      document_type,
      extraction_status,
      is_favorite
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const storedFilename = "delete-me.pdf";
  const filePath = path.join(process.env.UPLOADS_DIR, storedFilename);
  fs.writeFileSync(filePath, "%PDF-1.4 test");

  const documentId = Number(
    insertDocument.run(
      vehicle.id,
      "Delete Me",
      storedFilename,
      storedFilename,
      `server/uploads/${storedFilename}`,
      "application/pdf",
      "Engine",
      "Reference",
      "completed",
      0
    ).lastInsertRowid
  );

  const symptomId = Number(
    db.prepare(`INSERT INTO symptoms (vehicle_id, title, status) VALUES (?, ?, ?)`)
      .run(vehicle.id, "Linked symptom", "open").lastInsertRowid
  );
  db.prepare("INSERT INTO symptom_documents (symptom_id, document_id) VALUES (?, ?)").run(symptomId, documentId);

  const procedureId = Number(
    db.prepare(`INSERT INTO procedures (vehicle_id, title, status) VALUES (?, ?, ?)`)
      .run(vehicle.id, "Linked procedure", "draft").lastInsertRowid
  );
  db.prepare("INSERT INTO procedure_documents (procedure_id, document_id) VALUES (?, ?)").run(procedureId, documentId);

  db.prepare(`
    INSERT INTO notes (vehicle_id, title, content, related_entity_type, related_entity_id, document_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(vehicle.id, "Linked note", "Keep this for now.", "document", documentId, documentId);

  const response = await request(app).delete(`/api/documents/${documentId}`);

  assert.equal(response.status, 200);
  assert.equal(response.body.cleanup.symptomLinksRemoved, 1);
  assert.equal(response.body.cleanup.procedureLinksRemoved, 1);
  assert.equal(response.body.cleanup.noteLinksCleared, 1);

  const deletedDocument = db.prepare("SELECT id FROM documents WHERE id = ?").get(documentId);
  assert.equal(deletedDocument, undefined);

  const noteAfterDelete = db.prepare("SELECT related_entity_type, related_entity_id, document_id FROM notes WHERE title = ?").get("Linked note");
  assert.equal(noteAfterDelete.related_entity_type, "none");
  assert.equal(noteAfterDelete.related_entity_id, null);
  assert.equal(noteAfterDelete.document_id, null);

  assert.equal(fs.existsSync(filePath), false);
});
