// Characterization tests for the shared row-mapper cores extracted during the
// Phase 3 row-mapper consolidation. They pin the exact core shape (so the full
// API view and the search view cannot silently drift) and prove that each full
// entity mapper is exactly its core plus the one cross-entity link set it adds.
// Pure functions, but importing the services opens the SQLite connection, so a
// scratch DB/uploads dir is set first. No API key required.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-row-mapper-cores-"));

process.env.DATABASE_FILE = path.join(tempRoot, "cores.db");
process.env.UPLOADS_DIR = path.join(tempRoot, "uploads");
process.env.OPENAI_API_KEY = "";

const { db } = await import("../src/database.js");
const { mapSymptomCore, mapSymptomRow } = await import("../src/services/symptomService.js");
const { mapProcedureCore, mapProcedureRow } = await import("../src/services/procedureService.js");

after(() => {
  if (typeof db.close === "function") {
    db.close();
  }

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

const CORE_SYMPTOM_KEYS = [
  "id",
  "title",
  "description",
  "system",
  "suspectedCauses",
  "confidence",
  "status",
  "notes",
  "createdAt",
  "updatedAt",
  "linkedDocumentIds",
  "linkedDocuments",
];

const CORE_PROCEDURE_KEYS = [
  "id",
  "title",
  "system",
  "difficulty",
  "toolsNeeded",
  "partsNeeded",
  "safetyNotes",
  "steps",
  "notes",
  "confidence",
  "createdAt",
  "updatedAt",
  "linkedDocumentIds",
  "linkedDocuments",
];

// --- mapSymptomCore --------------------------------------------------------

test("mapSymptomCore returns the shared core shape (core columns + document links, no procedures)", () => {
  const linkedDocuments = [{ id: 3, title: "Doc", system: "Engine", documentType: "Repair Manual" }];
  const core = mapSymptomCore(
    { id: 7, title: "Stall", suspected_causes: "vacuum leak" },
    linkedDocuments
  );

  assert.deepEqual(Object.keys(core), CORE_SYMPTOM_KEYS);
  assert.equal(core.suspectedCauses, "vacuum leak");
  assert.equal(core.confidence, "medium"); // default
  assert.equal(core.status, "open"); // default
  assert.deepEqual(core.linkedDocumentIds, [3]);
  assert.equal(core.linkedDocuments, linkedDocuments); // passed through by reference

  // The core deliberately stops at documents; procedures are the full view's job.
  assert.ok(!("linkedProcedures" in core));
  assert.ok(!("linkedProcedureIds" in core));
});

test("mapSymptomRow is exactly the symptom core plus linked procedures", () => {
  const row = { id: 7, title: "Stall" };
  const doc = { id: 3, title: "Doc", system: "", documentType: "" };
  const proc = { id: 9, title: "Proc", system: "", difficulty: "beginner" };
  const documentLinksMap = new Map([[7, [doc]]]);
  const procedureLinksMap = new Map([[7, [proc]]]);

  const full = mapSymptomRow(row, documentLinksMap, procedureLinksMap);

  assert.deepEqual(full, {
    ...mapSymptomCore(row, [doc]),
    linkedProcedureIds: [9],
    linkedProcedures: [proc],
  });
});

// --- mapProcedureCore ------------------------------------------------------

test("mapProcedureCore returns the shared core shape (core columns + document links, no symptoms)", () => {
  const linkedDocuments = [{ id: 3, title: "Doc", system: "", documentType: "" }];
  const core = mapProcedureCore(
    { id: 5, title: "Bleed brakes", tools_needed: "wrench" },
    linkedDocuments
  );

  assert.deepEqual(Object.keys(core), CORE_PROCEDURE_KEYS);
  assert.equal(core.toolsNeeded, "wrench");
  assert.equal(core.difficulty, "intermediate"); // default
  assert.equal(core.confidence, "medium"); // default
  assert.deepEqual(core.linkedDocumentIds, [3]);
  assert.equal(core.linkedDocuments, linkedDocuments);

  assert.ok(!("linkedSymptoms" in core));
  assert.ok(!("linkedSymptomIds" in core));
});

test("mapProcedureRow is exactly the procedure core plus linked symptoms", () => {
  const row = { id: 5, title: "Bleed brakes" };
  const doc = { id: 3, title: "Doc", system: "", documentType: "" };
  const sym = { id: 8, title: "Sym", system: "", status: "open" };
  const documentLinksMap = new Map([[5, [doc]]]);
  const symptomLinksMap = new Map([[5, [sym]]]);

  const full = mapProcedureRow(row, documentLinksMap, symptomLinksMap);

  assert.deepEqual(full, {
    ...mapProcedureCore(row, [doc]),
    linkedSymptomIds: [8],
    linkedSymptoms: [sym],
  });
});
