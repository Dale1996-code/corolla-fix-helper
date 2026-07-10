// Unit tests for procedureService — the persistence + shaping logic extracted
// out of routes/procedures.js so the route stays thin. These pin the behaviors
// the API contract depends on: value normalization (with its exact error
// messages), the camelCase row shape the client renders, list ordering, and the
// atomic document-link replacement. They run against a scratch DB, no API key
// required.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, beforeEach } from "node:test";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-procedure-service-"));

process.env.DATABASE_FILE = path.join(tempRoot, "procedure.db");
process.env.UPLOADS_DIR = path.join(tempRoot, "uploads");
process.env.OPENAI_API_KEY = "";

const { db } = await import("../src/database.js");
const { initializeDatabase } = await import("../src/initDatabase.js");
const { setProcedureSymptoms } = await import("../src/services/symptomProcedureService.js");
const {
  createProcedure,
  deleteProcedure,
  getProcedure,
  getProcedureRecord,
  listProcedures,
  mapProcedureRow,
  normalizeConfidence,
  normalizeDifficulty,
  replaceProcedureDocumentLinks,
  updateProcedureFields,
} = await import("../src/services/procedureService.js");

initializeDatabase();

after(() => {
  if (typeof db.close === "function") {
    db.close();
  }

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

beforeEach(() => {
  db.exec(`
    DELETE FROM procedure_documents;
    DELETE FROM symptom_procedures;
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

const baseFields = {
  title: "Flush coolant",
  system: "",
  difficulty: "intermediate",
  toolsNeeded: "",
  partsNeeded: "",
  safetyNotes: "",
  steps: "",
  notes: "",
  confidence: "medium",
  linkedDocumentIds: [],
};

// --- normalizeConfidence ---------------------------------------------------

test("normalizeConfidence defaults blank input to medium and lower-cases valid values", () => {
  assert.equal(normalizeConfidence(""), "medium");
  assert.equal(normalizeConfidence(undefined), "medium");
  assert.equal(normalizeConfidence("HIGH"), "high");
  assert.equal(normalizeConfidence("Low"), "low");
});

test("normalizeConfidence rejects values outside the allowed set", () => {
  assert.throws(
    () => normalizeConfidence("urgent"),
    /Confidence must be low, medium, or high\./
  );
});

// --- normalizeDifficulty ---------------------------------------------------

test("normalizeDifficulty defaults blank input to intermediate and lower-cases valid values", () => {
  assert.equal(normalizeDifficulty(""), "intermediate");
  assert.equal(normalizeDifficulty(undefined), "intermediate");
  assert.equal(normalizeDifficulty("BEGINNER"), "beginner");
  assert.equal(normalizeDifficulty("Advanced"), "advanced");
});

test("normalizeDifficulty rejects values outside the allowed set", () => {
  assert.throws(
    () => normalizeDifficulty("expert"),
    /Difficulty must be beginner, intermediate, or advanced\./
  );
});

// --- mapProcedureRow -------------------------------------------------------

test("mapProcedureRow fills defaults and empty link arrays for a bare row", () => {
  const mapped = mapProcedureRow(
    { id: 7, title: "Flush coolant", created_at: "t0", updated_at: "t1" },
    new Map(),
    new Map()
  );

  assert.deepEqual(mapped, {
    id: 7,
    title: "Flush coolant",
    system: "",
    difficulty: "intermediate",
    toolsNeeded: "",
    partsNeeded: "",
    safetyNotes: "",
    steps: "",
    notes: "",
    confidence: "medium",
    createdAt: "t0",
    updatedAt: "t1",
    linkedDocumentIds: [],
    linkedDocuments: [],
    linkedSymptomIds: [],
    linkedSymptoms: [],
  });
});

test("mapProcedureRow attaches linked documents/symptoms and their id lists", () => {
  const documentLinksMap = new Map([
    [7, [{ id: 3, title: "Doc", system: "Engine", documentType: "Repair Manual" }]],
  ]);
  const symptomLinksMap = new Map([
    [7, [{ id: 9, title: "Sym", system: "Engine", status: "open" }]],
  ]);

  const mapped = mapProcedureRow(
    { id: 7, title: "Flush coolant", tools_needed: "socket set" },
    documentLinksMap,
    symptomLinksMap
  );

  assert.equal(mapped.toolsNeeded, "socket set");
  assert.deepEqual(mapped.linkedDocumentIds, [3]);
  assert.deepEqual(mapped.linkedSymptomIds, [9]);
  assert.equal(mapped.linkedDocuments[0].title, "Doc");
  assert.equal(mapped.linkedSymptoms[0].title, "Sym");
});

// --- createProcedure / getProcedure / getProcedureRecord -------------------

test("createProcedure inserts and returns the mapped procedure with its document links", () => {
  const docId = insertDocument("Engine Manual");
  const created = createProcedure(vehicleId(), {
    ...baseFields,
    title: "Replace ignition coil",
    difficulty: "advanced",
    confidence: "high",
    linkedDocumentIds: [docId],
  });

  assert.equal(created.title, "Replace ignition coil");
  assert.equal(created.difficulty, "advanced");
  assert.equal(created.confidence, "high");
  assert.deepEqual(created.linkedDocumentIds, [docId]);
  assert.equal(created.linkedDocuments[0].title, "Engine Manual");

  // getProcedure round-trips the same shape; unknown ids yield undefined.
  assert.deepEqual(getProcedure(vehicleId(), created.id), created);
  assert.equal(getProcedure(vehicleId(), Number(created.id) + 999), undefined);
});

test("getProcedureRecord returns the raw row only for an owned procedure", () => {
  const created = createProcedure(vehicleId(), {
    ...baseFields,
    title: "Bleed brakes",
    toolsNeeded: "wrench",
  });

  const record = getProcedureRecord(vehicleId(), created.id);
  assert.equal(record.title, "Bleed brakes");
  assert.equal(record.tools_needed, "wrench"); // snake_case raw row

  assert.equal(getProcedureRecord(vehicleId() + 999, created.id), undefined);
});

// --- listProcedures --------------------------------------------------------

test("listProcedures orders by updated_at then id, both descending", () => {
  db.prepare(
    "INSERT INTO procedures (vehicle_id, title, difficulty, updated_at) VALUES (?, ?, ?, ?)"
  ).run(vehicleId(), "older", "beginner", "2026-07-01 10:00:00");
  db.prepare(
    "INSERT INTO procedures (vehicle_id, title, difficulty, updated_at) VALUES (?, ?, ?, ?)"
  ).run(vehicleId(), "newer", "beginner", "2026-07-02 10:00:00");

  const titles = listProcedures(vehicleId()).map((procedure) => procedure.title);
  assert.deepEqual(titles, ["newer", "older"]);
});

// --- updateProcedureFields -------------------------------------------------

test("updateProcedureFields writes the merged core fields", () => {
  const created = createProcedure(vehicleId(), { ...baseFields, title: "Old title" });

  updateProcedureFields(vehicleId(), created.id, {
    title: "New title",
    system: "Engine",
    difficulty: "advanced",
    toolsNeeded: "socket set",
    partsNeeded: "gasket",
    safetyNotes: "chock the wheels",
    steps: "do the thing",
    notes: "done",
    confidence: "low",
  });

  const updated = getProcedure(vehicleId(), created.id);
  assert.equal(updated.title, "New title");
  assert.equal(updated.difficulty, "advanced");
  assert.equal(updated.confidence, "low");
  assert.equal(updated.toolsNeeded, "socket set");
});

// --- replaceProcedureDocumentLinks -----------------------------------------

test("replaceProcedureDocumentLinks sets, replaces, and clears the link set", () => {
  const docA = insertDocument("A");
  const docB = insertDocument("B");
  const created = createProcedure(vehicleId(), { ...baseFields, linkedDocumentIds: [docA] });

  replaceProcedureDocumentLinks(created.id, vehicleId(), [docB]);
  assert.deepEqual(getProcedure(vehicleId(), created.id).linkedDocumentIds, [docB]);

  replaceProcedureDocumentLinks(created.id, vehicleId(), []);
  assert.deepEqual(getProcedure(vehicleId(), created.id).linkedDocumentIds, []);
});

test("replaceProcedureDocumentLinks silently drops document ids from other vehicles", () => {
  const created = createProcedure(vehicleId(), { ...baseFields });
  const realDoc = insertDocument("Real");

  replaceProcedureDocumentLinks(created.id, vehicleId(), [realDoc, 999999]);
  assert.deepEqual(getProcedure(vehicleId(), created.id).linkedDocumentIds, [realDoc]);
});

test("linked symptoms flow through from setProcedureSymptoms", () => {
  const created = createProcedure(vehicleId(), { ...baseFields });
  const symptomId = insertSymptom("Rough idle");

  setProcedureSymptoms(created.id, [symptomId]);
  assert.deepEqual(getProcedure(vehicleId(), created.id).linkedSymptomIds, [symptomId]);
});

// --- deleteProcedure -------------------------------------------------------

test("deleteProcedure returns the removed-row count so callers can detect not-found", () => {
  const created = createProcedure(vehicleId(), { ...baseFields });

  assert.equal(deleteProcedure(vehicleId(), created.id), 1);
  assert.equal(deleteProcedure(vehicleId(), created.id), 0);
});
