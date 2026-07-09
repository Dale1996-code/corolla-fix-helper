// Unit tests for symptomService — the persistence + shaping logic extracted out
// of routes/symptoms.js so the route stays thin. These pin the behaviors the API
// contract depends on: value normalization (with its exact error messages), the
// camelCase row shape the client renders, list ordering, and the atomic
// document-link replacement. They run against a scratch DB, no API key required.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, beforeEach } from "node:test";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-symptom-service-"));

process.env.DATABASE_FILE = path.join(tempRoot, "symptom.db");
process.env.UPLOADS_DIR = path.join(tempRoot, "uploads");
process.env.OPENAI_API_KEY = "";

const { db } = await import("../src/database.js");
const { initializeDatabase } = await import("../src/initDatabase.js");
const { setSymptomProcedures } = await import("../src/services/symptomProcedureService.js");
const {
  createSymptom,
  deleteSymptom,
  getSymptom,
  getSymptomRecord,
  listCandidateProcedures,
  listSymptoms,
  mapSymptomRow,
  normalizeConfidence,
  normalizeStatus,
  replaceSymptomDocumentLinks,
  updateSymptomFields,
} = await import("../src/services/symptomService.js");

initializeDatabase();

after(() => {
  if (typeof db.close === "function") {
    db.close();
  }

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

beforeEach(() => {
  db.exec(`
    DELETE FROM symptom_documents;
    DELETE FROM symptom_procedures;
    DELETE FROM symptoms;
    DELETE FROM procedures;
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

function insertProcedure(title, updatedAt) {
  return Number(
    db
      .prepare(`
        INSERT INTO procedures (vehicle_id, title, system, difficulty, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `)
      .run(vehicleId(), title, "Engine", "beginner", updatedAt || "2026-07-01 10:00:00")
      .lastInsertRowid
  );
}

const baseFields = {
  title: "Rough idle",
  description: "",
  system: "",
  suspectedCauses: "",
  confidence: "medium",
  status: "open",
  notes: "",
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

// --- normalizeStatus -------------------------------------------------------

test("normalizeStatus defaults blank input to open and lower-cases valid values", () => {
  assert.equal(normalizeStatus(""), "open");
  assert.equal(normalizeStatus(undefined), "open");
  assert.equal(normalizeStatus("Monitoring"), "monitoring");
  assert.equal(normalizeStatus("RESOLVED"), "resolved");
});

test("normalizeStatus rejects values outside the allowed set", () => {
  assert.throws(
    () => normalizeStatus("closed"),
    /Status must be open, monitoring, or resolved\./
  );
});

// --- mapSymptomRow ---------------------------------------------------------

test("mapSymptomRow fills defaults and empty link arrays for a bare row", () => {
  const mapped = mapSymptomRow(
    { id: 7, title: "Stall", created_at: "t0", updated_at: "t1" },
    new Map(),
    new Map()
  );

  assert.deepEqual(mapped, {
    id: 7,
    title: "Stall",
    description: "",
    system: "",
    suspectedCauses: "",
    confidence: "medium",
    status: "open",
    notes: "",
    createdAt: "t0",
    updatedAt: "t1",
    linkedDocumentIds: [],
    linkedDocuments: [],
    linkedProcedureIds: [],
    linkedProcedures: [],
  });
});

test("mapSymptomRow attaches linked documents/procedures and their id lists", () => {
  const documentLinksMap = new Map([
    [7, [{ id: 3, title: "Doc", system: "Engine", documentType: "Repair Manual" }]],
  ]);
  const procedureLinksMap = new Map([
    [7, [{ id: 9, title: "Proc", system: "Engine", difficulty: "beginner" }]],
  ]);

  const mapped = mapSymptomRow(
    { id: 7, title: "Stall", suspected_causes: "vacuum leak" },
    documentLinksMap,
    procedureLinksMap
  );

  assert.equal(mapped.suspectedCauses, "vacuum leak");
  assert.deepEqual(mapped.linkedDocumentIds, [3]);
  assert.deepEqual(mapped.linkedProcedureIds, [9]);
  assert.equal(mapped.linkedDocuments[0].title, "Doc");
  assert.equal(mapped.linkedProcedures[0].title, "Proc");
});

// --- createSymptom / getSymptom / getSymptomRecord -------------------------

test("createSymptom inserts and returns the mapped symptom with its document links", () => {
  const docId = insertDocument("Engine Manual");
  const created = createSymptom(vehicleId(), {
    ...baseFields,
    title: "Misfire",
    confidence: "high",
    status: "monitoring",
    linkedDocumentIds: [docId],
  });

  assert.equal(created.title, "Misfire");
  assert.equal(created.confidence, "high");
  assert.equal(created.status, "monitoring");
  assert.deepEqual(created.linkedDocumentIds, [docId]);
  assert.equal(created.linkedDocuments[0].title, "Engine Manual");

  // getSymptom round-trips the same shape; unknown ids yield undefined.
  assert.deepEqual(getSymptom(vehicleId(), created.id), created);
  assert.equal(getSymptom(vehicleId(), Number(created.id) + 999), undefined);
});

test("getSymptomRecord returns the raw row only for an owned symptom", () => {
  const created = createSymptom(vehicleId(), { ...baseFields, title: "Knock" });

  const record = getSymptomRecord(vehicleId(), created.id);
  assert.equal(record.title, "Knock");
  assert.equal(record.suspected_causes, ""); // snake_case raw row

  assert.equal(getSymptomRecord(vehicleId() + 999, created.id), undefined);
});

// --- listSymptoms ----------------------------------------------------------

test("listSymptoms orders by updated_at then id, both descending", () => {
  db.prepare(
    "INSERT INTO symptoms (vehicle_id, title, status, updated_at) VALUES (?, ?, ?, ?)"
  ).run(vehicleId(), "older", "open", "2026-07-01 10:00:00");
  db.prepare(
    "INSERT INTO symptoms (vehicle_id, title, status, updated_at) VALUES (?, ?, ?, ?)"
  ).run(vehicleId(), "newer", "open", "2026-07-02 10:00:00");

  const titles = listSymptoms(vehicleId()).map((symptom) => symptom.title);
  assert.deepEqual(titles, ["newer", "older"]);
});

// --- updateSymptomFields ---------------------------------------------------

test("updateSymptomFields writes the merged core fields", () => {
  const created = createSymptom(vehicleId(), { ...baseFields, title: "Old title" });

  updateSymptomFields(vehicleId(), created.id, {
    title: "New title",
    description: "now described",
    system: "Engine",
    suspectedCauses: "coil",
    confidence: "low",
    status: "resolved",
    notes: "fixed",
  });

  const updated = getSymptom(vehicleId(), created.id);
  assert.equal(updated.title, "New title");
  assert.equal(updated.description, "now described");
  assert.equal(updated.confidence, "low");
  assert.equal(updated.status, "resolved");
});

// --- replaceSymptomDocumentLinks -------------------------------------------

test("replaceSymptomDocumentLinks sets, replaces, and clears the link set", () => {
  const docA = insertDocument("A");
  const docB = insertDocument("B");
  const created = createSymptom(vehicleId(), { ...baseFields, linkedDocumentIds: [docA] });

  replaceSymptomDocumentLinks(created.id, vehicleId(), [docB]);
  assert.deepEqual(getSymptom(vehicleId(), created.id).linkedDocumentIds, [docB]);

  replaceSymptomDocumentLinks(created.id, vehicleId(), []);
  assert.deepEqual(getSymptom(vehicleId(), created.id).linkedDocumentIds, []);
});

test("replaceSymptomDocumentLinks silently drops document ids from other vehicles", () => {
  const created = createSymptom(vehicleId(), { ...baseFields });
  const realDoc = insertDocument("Real");

  replaceSymptomDocumentLinks(created.id, vehicleId(), [realDoc, 999999]);
  assert.deepEqual(getSymptom(vehicleId(), created.id).linkedDocumentIds, [realDoc]);
});

test("linked procedures flow through from setSymptomProcedures", () => {
  const created = createSymptom(vehicleId(), { ...baseFields });
  const procId = insertProcedure("Replace coil");

  setSymptomProcedures(created.id, [procId]);
  assert.deepEqual(getSymptom(vehicleId(), created.id).linkedProcedureIds, [procId]);
});

// --- deleteSymptom ---------------------------------------------------------

test("deleteSymptom returns the removed-row count so callers can detect not-found", () => {
  const created = createSymptom(vehicleId(), { ...baseFields });

  assert.equal(deleteSymptom(vehicleId(), created.id), 1);
  assert.equal(deleteSymptom(vehicleId(), created.id), 0);
});

// --- listCandidateProcedures -----------------------------------------------

test("listCandidateProcedures returns camelCase rows newest-first", () => {
  insertProcedure("older proc", "2026-07-01 10:00:00");
  insertProcedure("newer proc", "2026-07-03 10:00:00");

  const candidates = listCandidateProcedures(vehicleId());
  assert.deepEqual(
    candidates.map((procedure) => procedure.title),
    ["newer proc", "older proc"]
  );
  assert.equal(candidates[0].difficulty, "beginner");
  assert.equal(candidates[0].toolsNeeded, "");
});
