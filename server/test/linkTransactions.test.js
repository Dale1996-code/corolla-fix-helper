import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-link-tx-"));

process.env.DATABASE_FILE = path.join(tempRoot, "links.db");
process.env.UPLOADS_DIR = path.join(tempRoot, "uploads");
process.env.OPENAI_API_KEY = "";

const { db } = await import("../src/database.js");
const { initializeDatabase } = await import("../src/initDatabase.js");
const { replaceSymptomDocumentLinks } = await import("../src/services/symptomService.js");
const { replaceProcedureDocumentLinks } = await import("../src/services/procedureService.js");

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

function insertDocument(name) {
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
        name,
        name,
        name,
        `server/uploads/${name}`,
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

// Run `fn` with db.prepare patched to throw for any SQL containing `marker`,
// simulating a database error partway through a link replacement.
function withFailingStatement(marker, fn) {
  const originalPrepare = db.prepare.bind(db);

  db.prepare = (sql) => {
    if (sql.includes(marker)) {
      throw new Error("simulated insert failure");
    }
    return originalPrepare(sql);
  };

  try {
    fn();
  } finally {
    db.prepare = originalPrepare;
  }
}

test("replaceSymptomDocumentLinks rolls back and keeps original links on failure", () => {
  const symptomId = insertSymptom("Idle dips when warm");
  const docA = insertDocument("sym-a.pdf");
  const docB = insertDocument("sym-b.pdf");

  // Establish the original link set.
  replaceSymptomDocumentLinks(symptomId, vehicleId(), [docA, docB]);

  // A failure during the re-insert must roll back the delete, not half-clear it.
  withFailingStatement("INSERT INTO symptom_documents", () => {
    assert.throws(
      () => replaceSymptomDocumentLinks(symptomId, vehicleId(), [docA]),
      /simulated insert failure/
    );
  });

  const remaining = db
    .prepare("SELECT document_id FROM symptom_documents WHERE symptom_id = ? ORDER BY document_id")
    .all(symptomId)
    .map((row) => row.document_id);

  assert.deepEqual(remaining, [docA, docB].sort((a, b) => a - b));
});

test("replaceProcedureDocumentLinks rolls back and keeps original links on failure", () => {
  const procedureId = insertProcedure("Clean the throttle body");
  const docA = insertDocument("proc-a.pdf");
  const docB = insertDocument("proc-b.pdf");

  replaceProcedureDocumentLinks(procedureId, vehicleId(), [docA, docB]);

  withFailingStatement("INSERT INTO procedure_documents", () => {
    assert.throws(
      () => replaceProcedureDocumentLinks(procedureId, vehicleId(), [docA]),
      /simulated insert failure/
    );
  });

  const remaining = db
    .prepare("SELECT document_id FROM procedure_documents WHERE procedure_id = ? ORDER BY document_id")
    .all(procedureId)
    .map((row) => row.document_id);

  assert.deepEqual(remaining, [docA, docB].sort((a, b) => a - b));
});
