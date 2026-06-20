import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import express from "express";
import request from "supertest";

const tempRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "corolla-fix-helper-suggested-procedures-")
);
process.env.DATABASE_FILE = path.join(tempRoot, "suggested.db");
process.env.UPLOADS_DIR = path.join(tempRoot, "uploads");
process.env.OPENAI_API_KEY = "";

const { db } = await import("../src/database.js");
const { initializeDatabase } = await import("../src/initDatabase.js");
const { createSymptomsRouter } = await import("../src/routes/symptoms.js");
const { rebuildDocumentChunksFromPages } = await import(
  "../src/services/documentChunkService.js"
);

initializeDatabase();

after(() => {
  if (typeof db.close === "function") {
    db.close();
  }

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function vehicleId() {
  return db.prepare("SELECT id FROM vehicles ORDER BY id ASC LIMIT 1").get().id;
}

function insertSymptom(fields) {
  return Number(
    db
      .prepare(`
        INSERT INTO symptoms (vehicle_id, title, description, suspected_causes, system, status)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(
        vehicleId(),
        fields.title,
        fields.description || "",
        fields.suspectedCauses || "",
        fields.system || "",
        "open"
      ).lastInsertRowid
  );
}

function insertProcedure(fields) {
  return Number(
    db
      .prepare(`
        INSERT INTO procedures (vehicle_id, title, system, difficulty, steps)
        VALUES (?, ?, ?, ?, ?)
      `)
      .run(
        vehicleId(),
        fields.title,
        fields.system || "",
        fields.difficulty || "beginner",
        fields.steps || ""
      ).lastInsertRowid
  );
}

function insertDocumentWithChunk(title, system, pageText) {
  const documentId = Number(
    db
      .prepare(`
        INSERT INTO documents (
          vehicle_id, title, original_filename, system, document_type, extraction_status
        )
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(
        vehicleId(),
        title,
        `${title.toLowerCase().replace(/\s+/g, "-")}.pdf`,
        system,
        "Reference",
        "completed"
      ).lastInsertRowid
  );

  rebuildDocumentChunksFromPages(documentId, [{ pageNumber: 1, text: pageText }]);
  return documentId;
}

function makeApp(options) {
  const app = express();
  app.use(express.json());
  app.use("/api/symptoms", createSymptomsRouter(options));
  return app;
}

test("GET /api/symptoms/:id/suggested-procedures works with an injected suggester", async () => {
  const symptomId = insertSymptom({ title: "Injected idle", system: "Engine" });
  /** @type {{ symptomId: number, candidateCount: number } | null} */
  let seen = null;

  const app = makeApp({
    suggestProcedures: async (symptom, candidates) => {
      seen = { symptomId: symptom.id, candidateCount: candidates.length };
      return {
        status: "answered",
        mode: "deterministic",
        aiConfigured: false,
        query: "injected idle",
        suggestions: [
          {
            procedureId: 4242,
            title: "Mock procedure",
            system: "Engine",
            difficulty: "beginner",
            reason: "Injected reason.",
            source: "keyword",
            citations: [],
          },
        ],
        citations: [],
      };
    },
  });

  const response = await request(app).get(
    `/api/symptoms/${symptomId}/suggested-procedures`
  );

  assert.equal(response.status, 200);
  assert.equal(response.body.status, "answered");
  assert.equal(response.body.suggestions[0].title, "Mock procedure");
  assert.ok(seen, "the injected suggest function should have been called");
  assert.equal(seen.symptomId, symptomId);
});

test("GET /api/symptoms/:id/suggested-procedures returns 404 for a missing symptom", async () => {
  let calls = 0;
  const app = makeApp({
    suggestProcedures: async () => {
      calls += 1;
      return { status: "answered", suggestions: [], citations: [] };
    },
  });

  const response = await request(app).get(
    "/api/symptoms/999999/suggested-procedures"
  );

  assert.equal(response.status, 404);
  assert.equal(calls, 0);
});

test("suggested-procedures degrades to deterministic results without OPENAI_API_KEY", async () => {
  const symptomId = insertSymptom({
    title: "Rough idle and stalling",
    description: "Idle surges then the engine nearly stalls",
    suspectedCauses: "dirty throttle body",
    system: "Engine",
  });
  const procedureId = insertProcedure({
    title: "Clean the throttle body",
    system: "Engine",
    steps: "Remove the intake tube and clean the throttle body, then idle relearn.",
  });
  insertDocumentWithChunk(
    "Idle service notes",
    "Engine",
    "Rough idle can be caused by a dirty throttle body. Clean the throttle body and perform idle relearn."
  );

  // The real router uses the real suggestion service (default), no key set.
  const app = makeApp();

  const response = await request(app).get(
    `/api/symptoms/${symptomId}/suggested-procedures`
  );

  assert.equal(response.status, 200);
  assert.equal(response.body.aiConfigured, false);
  assert.equal(response.body.status, "answered");
  assert.equal(response.body.mode, "deterministic");

  const suggestion = response.body.suggestions.find(
    (item) => item.procedureId === procedureId
  );

  assert.ok(suggestion, "should suggest the throttle body procedure");
  assert.ok(suggestion.reason.length > 0);
  assert.ok(suggestion.citations.length >= 1, "deterministic match should be grounded");
});
