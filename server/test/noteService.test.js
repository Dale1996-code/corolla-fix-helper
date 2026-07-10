// Unit tests for noteService — the persistence + shaping logic extracted out of
// routes/notes.js so the route stays thin. These pin the behaviors the API
// contract depends on: value normalization (with its exact error messages), the
// polymorphic related-entity lookup, the camelCase row shape the client renders
// (including the legacy document_id fallback and body/content fallback), list
// ordering, and the linked-entity joins. They run against a scratch DB, no API
// key required.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, beforeEach } from "node:test";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-note-service-"));

process.env.DATABASE_FILE = path.join(tempRoot, "note.db");
process.env.UPLOADS_DIR = path.join(tempRoot, "uploads");
process.env.OPENAI_API_KEY = "";

const { db } = await import("../src/database.js");
const { initializeDatabase } = await import("../src/initDatabase.js");
const {
  createNote,
  deleteNote,
  getNote,
  getNoteRecord,
  getRelatedEntityForVehicle,
  listNotes,
  mapNoteRow,
  normalizeNoteType,
  normalizeRelatedEntityId,
  normalizeRelatedEntityType,
  updateNoteFields,
} = await import("../src/services/noteService.js");

initializeDatabase();

after(() => {
  if (typeof db.close === "function") {
    db.close();
  }

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

beforeEach(() => {
  db.exec(`
    DELETE FROM notes;
    DELETE FROM procedures;
    DELETE FROM symptoms;
    DELETE FROM documents;
  `);
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
          file_type, system, document_type, extracted_text, extraction_status, page_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        vehicleId(),
        title,
        title,
        title,
        `server/uploads/${title}`,
        "application/pdf",
        "Engine",
        "Repair Manual",
        "",
        "completed",
        1
      ).lastInsertRowid
  );
}

function insertSymptom(title) {
  return Number(
    db
      .prepare("INSERT INTO symptoms (vehicle_id, title, system, status) VALUES (?, ?, ?, ?)")
      .run(vehicleId(), title, "Engine", "open").lastInsertRowid
  );
}

function insertProcedure(title) {
  return Number(
    db
      .prepare("INSERT INTO procedures (vehicle_id, title, system, difficulty) VALUES (?, ?, ?, ?)")
      .run(vehicleId(), title, "Engine", "beginner").lastInsertRowid
  );
}

const baseFields = {
  title: "Checked the oil",
  content: "Looked clean",
  noteType: "general",
  relatedEntityType: "none",
  relatedEntityId: null,
};

// --- normalizeNoteType -----------------------------------------------------

test("normalizeNoteType defaults blank input to general and lower-cases valid values", () => {
  assert.equal(normalizeNoteType(""), "general");
  assert.equal(normalizeNoteType(undefined), "general");
  assert.equal(normalizeNoteType("OBSERVATION"), "observation");
  assert.equal(normalizeNoteType("Repair_Log"), "repair_log");
});

test("normalizeNoteType rejects values outside the allowed set", () => {
  assert.throws(
    () => normalizeNoteType("urgent"),
    /Note type must be general, observation, repair_log, or reminder\./
  );
});

// --- normalizeRelatedEntityType --------------------------------------------

test("normalizeRelatedEntityType defaults blank input to none and lower-cases valid values", () => {
  assert.equal(normalizeRelatedEntityType(""), "none");
  assert.equal(normalizeRelatedEntityType(undefined), "none");
  assert.equal(normalizeRelatedEntityType("Document"), "document");
  assert.equal(normalizeRelatedEntityType("SYMPTOM"), "symptom");
});

test("normalizeRelatedEntityType rejects values outside the allowed set", () => {
  assert.throws(
    () => normalizeRelatedEntityType("engine"),
    /Related entity type must be none, document, symptom, or procedure\./
  );
});

// --- normalizeRelatedEntityId ----------------------------------------------

test("normalizeRelatedEntityId returns null for blank, null, and undefined", () => {
  assert.equal(normalizeRelatedEntityId(""), null);
  assert.equal(normalizeRelatedEntityId(null), null);
  assert.equal(normalizeRelatedEntityId(undefined), null);
});

test("normalizeRelatedEntityId accepts positive integers and rejects everything else", () => {
  assert.equal(normalizeRelatedEntityId("5"), 5);
  assert.equal(normalizeRelatedEntityId(7), 7);

  for (const bad of [0, -1, 1.5, "abc"]) {
    assert.throws(
      () => normalizeRelatedEntityId(bad),
      /Related entity ID must be a positive number\./
    );
  }
});

// --- getRelatedEntityForVehicle --------------------------------------------

test("getRelatedEntityForVehicle dispatches by type and scopes to the vehicle", () => {
  const docId = insertDocument("Manual");
  const symptomId = insertSymptom("Rough idle");
  const procedureId = insertProcedure("Replace coil");

  assert.equal(getRelatedEntityForVehicle(vehicleId(), "document", docId).id, docId);
  assert.equal(getRelatedEntityForVehicle(vehicleId(), "symptom", symptomId).id, symptomId);
  assert.equal(getRelatedEntityForVehicle(vehicleId(), "procedure", procedureId).id, procedureId);

  // "none" never looks anything up; a foreign vehicle sees nothing.
  assert.equal(getRelatedEntityForVehicle(vehicleId(), "none", null), null);
  assert.equal(getRelatedEntityForVehicle(vehicleId() + 999, "document", docId), undefined);
});

// --- mapNoteRow ------------------------------------------------------------

test("mapNoteRow fills defaults, prefers content over body, and empty links for a bare row", () => {
  const mapped = mapNoteRow({
    id: 4,
    title: "Oil change",
    body: "legacy body",
    created_at: "t0",
    updated_at: "t1",
  });

  assert.deepEqual(mapped, {
    id: 4,
    title: "Oil change",
    content: "legacy body", // falls back to body when content is absent
    noteType: "general",
    relatedEntityType: "none",
    relatedEntityId: null,
    linkedDocument: null,
    linkedSymptom: null,
    linkedProcedure: null,
    createdAt: "t0",
    updatedAt: "t1",
  });
});

test("mapNoteRow infers a document link from the legacy document_id column", () => {
  const mapped = mapNoteRow({
    id: 4,
    title: "Legacy",
    content: "body",
    document_id: 12,
    linked_document_id: 12,
    linked_document_title: "Old Manual",
  });

  assert.equal(mapped.relatedEntityType, "document");
  assert.equal(mapped.relatedEntityId, 12);
  assert.deepEqual(mapped.linkedDocument, {
    id: 12,
    title: "Old Manual",
    system: "",
    documentType: "",
  });
});

test("mapNoteRow attaches linked symptom/procedure from the joined columns", () => {
  const symptomMapped = mapNoteRow({
    id: 5,
    title: "Sym note",
    related_entity_type: "symptom",
    related_entity_id: 9,
    linked_symptom_id: 9,
    linked_symptom_title: "Stalls",
    linked_symptom_status: "monitoring",
  });
  assert.deepEqual(symptomMapped.linkedSymptom, {
    id: 9,
    title: "Stalls",
    system: "",
    status: "monitoring",
  });

  const procedureMapped = mapNoteRow({
    id: 6,
    title: "Proc note",
    related_entity_type: "procedure",
    related_entity_id: 3,
    linked_procedure_id: 3,
    linked_procedure_title: "Bleed brakes",
  });
  assert.deepEqual(procedureMapped.linkedProcedure, {
    id: 3,
    title: "Bleed brakes",
    system: "",
    difficulty: "intermediate",
  });
});

// --- createNote / getNote / getNoteRecord ----------------------------------

test("createNote inserts an unlinked note and getNote round-trips its shape", () => {
  const created = createNote(vehicleId(), { ...baseFields, noteType: "observation" });

  assert.equal(created.title, "Checked the oil");
  assert.equal(created.content, "Looked clean");
  assert.equal(created.noteType, "observation");
  assert.equal(created.relatedEntityType, "none");
  assert.equal(created.relatedEntityId, null);
  assert.equal(created.linkedDocument, null);

  assert.deepEqual(getNote(vehicleId(), created.id), created);
  assert.equal(getNote(vehicleId(), Number(created.id) + 999), undefined);
});

test("createNote links a document and populates the joined linkedDocument", () => {
  const docId = insertDocument("Engine Manual");
  const created = createNote(vehicleId(), {
    ...baseFields,
    relatedEntityType: "document",
    relatedEntityId: docId,
  });

  assert.equal(created.relatedEntityType, "document");
  assert.equal(created.relatedEntityId, docId);
  assert.equal(created.linkedDocument.title, "Engine Manual");

  // The legacy document_id column is kept in sync for document links.
  const record = getNoteRecord(vehicleId(), created.id);
  assert.equal(record.document_id, docId);
});

test("getNoteRecord returns the raw row only for an owned note", () => {
  const created = createNote(vehicleId(), { ...baseFields, title: "Owned" });

  const record = getNoteRecord(vehicleId(), created.id);
  assert.equal(record.title, "Owned");
  assert.equal(record.content, "Looked clean"); // snake_case raw row keeps both columns
  assert.equal(record.body, "Looked clean");

  assert.equal(getNoteRecord(vehicleId() + 999, created.id), undefined);
});

// --- listNotes -------------------------------------------------------------

test("listNotes orders by updated_at then id, both descending", () => {
  db.prepare(
    "INSERT INTO notes (vehicle_id, title, note_type, updated_at) VALUES (?, ?, ?, ?)"
  ).run(vehicleId(), "older", "general", "2026-07-01 10:00:00");
  db.prepare(
    "INSERT INTO notes (vehicle_id, title, note_type, updated_at) VALUES (?, ?, ?, ?)"
  ).run(vehicleId(), "newer", "general", "2026-07-02 10:00:00");

  const titles = listNotes(vehicleId()).map((note) => note.title);
  assert.deepEqual(titles, ["newer", "older"]);
});

// --- updateNoteFields ------------------------------------------------------

test("updateNoteFields writes merged fields and re-links to a new related entity", () => {
  const docId = insertDocument("Manual");
  const symptomId = insertSymptom("Rough idle");
  const created = createNote(vehicleId(), {
    ...baseFields,
    relatedEntityType: "document",
    relatedEntityId: docId,
  });

  updateNoteFields(vehicleId(), created.id, {
    title: "Now about the idle",
    content: "Relinked to a symptom",
    noteType: "repair_log",
    relatedEntityType: "symptom",
    relatedEntityId: symptomId,
  });

  const updated = getNote(vehicleId(), created.id);
  assert.equal(updated.title, "Now about the idle");
  assert.equal(updated.noteType, "repair_log");
  assert.equal(updated.relatedEntityType, "symptom");
  assert.equal(updated.relatedEntityId, symptomId);
  assert.equal(updated.linkedSymptom.title, "Rough idle");
  assert.equal(updated.linkedDocument, null);

  // Switching away from a document clears the legacy document_id column.
  assert.equal(getNoteRecord(vehicleId(), created.id).document_id, null);
});

// --- deleteNote ------------------------------------------------------------

test("deleteNote returns the removed-row count so callers can detect not-found", () => {
  const created = createNote(vehicleId(), { ...baseFields });

  assert.equal(deleteNote(vehicleId(), created.id), 1);
  assert.equal(deleteNote(vehicleId(), created.id), 0);
});
