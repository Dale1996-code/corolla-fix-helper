// Unit tests for the Search page's keyword ranking service.
//
// searchService owns three behaviors worth pinning independently of the
// /api/search route: relevance ordering (field weights + exact-title boost),
// filter/sort semantics, and the camelCase row shapes the client renders.
// Ranking regressions are silent — results still return, just in the wrong
// order — so these tests assert relative order rather than exact scores
// (retuning weights should be a deliberate choice, not a test rewrite).

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, beforeEach } from "node:test";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-search-service-"));

process.env.DATABASE_FILE = path.join(tempRoot, "search.db");
process.env.UPLOADS_DIR = path.join(tempRoot, "uploads");
process.env.OPENAI_API_KEY = "";

const { db } = await import("../src/database.js");
const { initializeDatabase } = await import("../src/initDatabase.js");
const {
  getNoteFilterOptions,
  getProcedureFilterOptions,
  getSymptomFilterOptions,
  searchNotes,
  searchProcedures,
  searchSymptoms,
} = await import("../src/services/searchService.js");

initializeDatabase();

after(() => {
  if (typeof db.close === "function") {
    db.close();
  }

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

// Each test builds its own rows; only the seeded vehicle survives between
// tests so orderings stay fully deterministic.
beforeEach(() => {
  db.exec(`
    DELETE FROM symptom_documents;
    DELETE FROM procedure_documents;
    DELETE FROM notes;
    DELETE FROM symptoms;
    DELETE FROM procedures;
    DELETE FROM documents;
  `);
});

function vehicleId() {
  return db.prepare("SELECT id FROM vehicles ORDER BY id ASC LIMIT 1").get().id;
}

// SQLite CURRENT_TIMESTAMP format, so string comparisons in compareNewest
// behave exactly as they do against real rows.
const TIMESTAMP = "2026-07-01 10:00:00";

function insertSymptom({
  title,
  description = "",
  system = "",
  suspectedCauses = "",
  status = "open",
  notes = "",
  updatedAt = TIMESTAMP,
}) {
  return Number(
    db
      .prepare(`
        INSERT INTO symptoms (
          vehicle_id, title, description, system, suspected_causes, status, notes, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(vehicleId(), title, description, system, suspectedCauses, status, notes, updatedAt)
      .lastInsertRowid
  );
}

function insertProcedure({
  title,
  system = "",
  difficulty = "intermediate",
  toolsNeeded = "",
  partsNeeded = "",
  safetyNotes = "",
  steps = "",
  notes = "",
  updatedAt = TIMESTAMP,
}) {
  return Number(
    db
      .prepare(`
        INSERT INTO procedures (
          vehicle_id, title, system, difficulty, tools_needed, parts_needed,
          safety_notes, steps, notes, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        vehicleId(),
        title,
        system,
        difficulty,
        toolsNeeded,
        partsNeeded,
        safetyNotes,
        steps,
        notes,
        updatedAt
      ).lastInsertRowid
  );
}

function insertNote({
  title = "",
  content = "",
  body = "",
  noteType = "general",
  relatedEntityType = "none",
  relatedEntityId = null,
  documentId = null,
  updatedAt = TIMESTAMP,
}) {
  return Number(
    db
      .prepare(`
        INSERT INTO notes (
          vehicle_id, title, content, body, note_type,
          related_entity_type, related_entity_id, document_id, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        vehicleId(),
        title,
        content,
        body,
        noteType,
        relatedEntityType,
        relatedEntityId,
        documentId,
        updatedAt
      ).lastInsertRowid
  );
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
        `${title}.pdf`,
        `${title}.pdf`,
        `server/uploads/${title}.pdf`,
        "application/pdf",
        "Brakes",
        "Repair Manual",
        "",
        "completed",
        1
      ).lastInsertRowid
  );
}

function linkSymptomDocument(symptomId, documentId) {
  db.prepare("INSERT INTO symptom_documents (symptom_id, document_id) VALUES (?, ?)").run(
    symptomId,
    documentId
  );
}

// --- Symptoms ---------------------------------------------------------------

test("searchSymptoms ranks exact title above partial title above description match", () => {
  insertSymptom({ title: "Grinding noise", description: "Loud brake squeal at low speed" });
  insertSymptom({ title: "Brake squeal when cold" });
  insertSymptom({ title: "Brake squeal" });
  insertSymptom({ title: "Dead battery", description: "No crank in the morning" });

  const results = searchSymptoms({ query: "brake squeal" });

  assert.deepEqual(
    results.map((symptom) => symptom.title),
    ["Brake squeal", "Brake squeal when cold", "Grinding noise"]
  );
  assert.ok(results[0].relevanceScore > results[1].relevanceScore);
  assert.ok(results[1].relevanceScore > results[2].relevanceScore);
  assert.ok(results[2].relevanceScore > 0);
});

test("searchSymptoms reports the field that matched through snippet metadata", () => {
  insertSymptom({ title: "Grinding noise", description: "Loud brake squeal at low speed" });
  insertSymptom({ title: "Brake squeal" });

  const results = searchSymptoms({ query: "brake squeal" });
  const titleMatch = results.find((symptom) => symptom.title === "Brake squeal");
  const descriptionMatch = results.find((symptom) => symptom.title === "Grinding noise");

  assert.equal(titleMatch.snippetField, "Title");
  assert.equal(descriptionMatch.snippetField, "Description");
  assert.match(descriptionMatch.snippet, /brake squeal/i);
});

test("searchSymptoms applies system and status filters", () => {
  insertSymptom({ title: "Soft pedal", system: "Brakes", status: "open" });
  insertSymptom({ title: "Squeal at stops", system: "Brakes", status: "resolved" });
  insertSymptom({ title: "Rough idle", system: "Engine", status: "open" });

  const brakeResults = searchSymptoms({ query: "", system: "Brakes" });
  assert.deepEqual(
    brakeResults.map((symptom) => symptom.title).sort(),
    ["Soft pedal", "Squeal at stops"]
  );

  const openBrakeResults = searchSymptoms({ query: "", system: "Brakes", status: "open" });
  assert.deepEqual(
    openBrakeResults.map((symptom) => symptom.title),
    ["Soft pedal"]
  );
});

test("searchSymptoms without a query returns everything newest first", () => {
  insertSymptom({ title: "Oldest", updatedAt: "2026-07-01 10:00:00" });
  insertSymptom({ title: "Newest", updatedAt: "2026-07-03 10:00:00" });
  insertSymptom({ title: "Middle", updatedAt: "2026-07-02 10:00:00" });

  const results = searchSymptoms({ query: "" });

  assert.deepEqual(
    results.map((symptom) => symptom.title),
    ["Newest", "Middle", "Oldest"]
  );
});

test("searchSymptoms breaks equal timestamps by newest id first", () => {
  insertSymptom({ title: "First inserted" });
  insertSymptom({ title: "Second inserted" });

  const results = searchSymptoms({ query: "" });

  assert.deepEqual(
    results.map((symptom) => symptom.title),
    ["Second inserted", "First inserted"]
  );
});

test("searchSymptoms sorts alphabetically when sort is title", () => {
  insertSymptom({ title: "Coolant smell" });
  insertSymptom({ title: "brake fade" });
  insertSymptom({ title: "Alternator whine" });

  const results = searchSymptoms({ query: "", sort: "title" });

  assert.deepEqual(
    results.map((symptom) => symptom.title),
    ["Alternator whine", "brake fade", "Coolant smell"]
  );
});

test("searchSymptoms sorts oldest first when sort is oldest", () => {
  insertSymptom({ title: "Oldest", updatedAt: "2026-07-01 10:00:00" });
  insertSymptom({ title: "Newest", updatedAt: "2026-07-03 10:00:00" });
  insertSymptom({ title: "Middle", updatedAt: "2026-07-02 10:00:00" });

  const results = searchSymptoms({ query: "", sort: "oldest" });

  assert.deepEqual(
    results.map((symptom) => symptom.title),
    ["Oldest", "Middle", "Newest"]
  );
});

test("searchSymptoms surfaces linked documents in the mapped shape", () => {
  const symptomId = insertSymptom({ title: "Pulsing pedal", system: "Brakes" });
  const rotorDocId = insertDocument("Rotor runout spec");
  const padDocId = insertDocument("Pad replacement");
  linkSymptomDocument(symptomId, rotorDocId);
  linkSymptomDocument(symptomId, padDocId);

  const [result] = searchSymptoms({ query: "pulsing" });

  assert.equal(result.linkedDocumentCount, 2);
  assert.deepEqual(result.linkedDocumentIds.sort(), [padDocId, rotorDocId].sort());
  // Link rows come back ordered by document title, case-insensitively.
  assert.deepEqual(
    result.linkedDocuments.map((document) => document.title),
    ["Pad replacement", "Rotor runout spec"]
  );
  assert.deepEqual(Object.keys(result.linkedDocuments[0]).sort(), [
    "documentType",
    "id",
    "system",
    "title",
  ]);
});

test("getSymptomFilterOptions returns unique sorted systems and statuses", () => {
  insertSymptom({ title: "One", system: "Brakes", status: "open" });
  insertSymptom({ title: "Two", system: "Engine", status: "resolved" });
  insertSymptom({ title: "Three", system: "Brakes", status: "open" });
  insertSymptom({ title: "Four", system: "", status: "monitoring" });

  const options = getSymptomFilterOptions();

  assert.deepEqual(options.systems, ["Brakes", "Engine"]);
  assert.deepEqual(options.statuses, ["monitoring", "open", "resolved"]);
});

// --- Procedures --------------------------------------------------------------

test("searchProcedures matches step text and applies the difficulty filter", () => {
  insertProcedure({
    title: "Front pad replacement",
    difficulty: "beginner",
    steps: "Compress the caliper piston with a C-clamp before fitting new pads.",
  });
  insertProcedure({
    title: "Caliper rebuild",
    difficulty: "advanced",
    partsNeeded: "Caliper seal kit",
  });
  insertProcedure({ title: "Oil change", difficulty: "beginner" });

  const results = searchProcedures({ query: "caliper" });
  assert.deepEqual(
    results.map((procedure) => procedure.title),
    ["Caliper rebuild", "Front pad replacement"]
  );

  const beginnerResults = searchProcedures({ query: "caliper", difficulty: "beginner" });
  assert.deepEqual(
    beginnerResults.map((procedure) => procedure.title),
    ["Front pad replacement"]
  );
  assert.equal(beginnerResults[0].snippetField, "Steps");
});

test("getProcedureFilterOptions returns unique sorted systems and difficulties", () => {
  insertProcedure({ title: "One", system: "Brakes", difficulty: "beginner" });
  insertProcedure({ title: "Two", system: "Engine", difficulty: "advanced" });
  insertProcedure({ title: "Three", system: "Engine", difficulty: "beginner" });

  const options = getProcedureFilterOptions();

  assert.deepEqual(options.systems, ["Brakes", "Engine"]);
  assert.deepEqual(options.difficulties, ["advanced", "beginner"]);
});

// --- Notes -------------------------------------------------------------------

test("searchNotes matches the linked document title and reports it as the match", () => {
  const documentId = insertDocument("Torque spec sheet");
  insertNote({
    title: "Wheel work log",
    content: "Re-torqued after 50 miles.",
    relatedEntityType: "document",
    relatedEntityId: documentId,
  });
  insertNote({ title: "Unrelated reminder", content: "Buy washer fluid." });

  const results = searchNotes({ query: "torque spec" });

  assert.equal(results.length, 1);
  assert.equal(results[0].title, "Wheel work log");
  assert.equal(results[0].linkedTitle, "Torque spec sheet");
  assert.equal(results[0].snippetField, "Linked item");
  assert.equal(results[0].linkedDocument.title, "Torque spec sheet");
});

test("searchNotes applies noteType and relatedEntityType filters", () => {
  const symptomId = insertSymptom({ title: "Vibration" });
  insertNote({ title: "General thought", noteType: "general" });
  insertNote({
    title: "Symptom observation",
    noteType: "observation",
    relatedEntityType: "symptom",
    relatedEntityId: symptomId,
  });

  const observations = searchNotes({ query: "", noteType: "observation" });
  assert.deepEqual(
    observations.map((note) => note.title),
    ["Symptom observation"]
  );
  assert.equal(observations[0].linkedSymptom.title, "Vibration");

  const symptomNotes = searchNotes({ query: "", relatedEntityType: "symptom" });
  assert.deepEqual(
    symptomNotes.map((note) => note.title),
    ["Symptom observation"]
  );
});

test("searchNotes maps legacy document_id notes onto the document link shape", () => {
  // Older rows stored the link in document_id with a blank related_entity_type
  // and their text in body instead of content; the mapper still has to present
  // them as document-linked notes with readable content.
  const documentId = insertDocument("Owner manual");
  insertNote({
    title: "Legacy note",
    body: "Written before the related-entity columns existed.",
    relatedEntityType: "",
    documentId,
  });

  const [result] = searchNotes({ query: "legacy" });

  assert.equal(result.relatedEntityType, "document");
  assert.equal(result.relatedEntityId, documentId);
  assert.equal(result.linkedDocument.title, "Owner manual");
  assert.equal(result.content, "Written before the related-entity columns existed.");
});

test("getNoteFilterOptions returns unique sorted note types and entity types", () => {
  const documentId = insertDocument("Any doc");
  insertNote({ title: "A", noteType: "reminder" });
  insertNote({ title: "B", noteType: "general" });
  insertNote({
    title: "C",
    noteType: "general",
    relatedEntityType: "document",
    relatedEntityId: documentId,
  });

  const options = getNoteFilterOptions();

  assert.deepEqual(options.noteTypes, ["general", "reminder"]);
  assert.deepEqual(options.relatedEntityTypes, ["document", "none"]);
});

// --- Missing vehicle ----------------------------------------------------------

test("search functions fail loudly when no vehicle row exists", () => {
  // Pins the vehicleService contract through its main consumer: an
  // uninitialized database is an error, not an empty result set.
  db.prepare("DELETE FROM vehicles").run();

  try {
    assert.throws(() => searchSymptoms({ query: "" }), /No vehicle record exists yet/);
    assert.throws(() => searchProcedures({ query: "" }), /No vehicle record exists yet/);
    assert.throws(() => searchNotes({ query: "" }), /No vehicle record exists yet/);
  } finally {
    db.prepare(
      "INSERT INTO vehicles (year, make, model, trim, engine) VALUES (?, ?, ?, ?, ?)"
    ).run(2009, "Toyota", "Corolla", "LE", "1.8L");
  }
});
