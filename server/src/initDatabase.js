import { db } from "./database.js";
import { ensureAppSettingsRecord } from "./services/appSettingsService.js";

function ensureColumn(tableName, columnName, columnDefinition) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  const hasColumn = columns.some((column) => column.name === columnName);

  if (!hasColumn) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`);
  }
}

function createTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS vehicles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      year INTEGER NOT NULL,
      make TEXT NOT NULL,
      model TEXT NOT NULL,
      trim TEXT,
      engine TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      document_system_defaults TEXT NOT NULL DEFAULT '[]',
      document_type_defaults TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vehicle_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      original_filename TEXT NOT NULL,
      stored_filename TEXT,
      file_path TEXT,
      file_type TEXT,
      system TEXT NOT NULL,
      subsystem TEXT,
      document_type TEXT NOT NULL,
      source TEXT,
      notes TEXT,
      extracted_text TEXT,
      extraction_status TEXT NOT NULL DEFAULT 'not_attempted',
      page_count INTEGER,
      is_favorite INTEGER NOT NULL DEFAULT 0,
      is_bookmarked INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (vehicle_id) REFERENCES vehicles(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS document_tags (
      document_id INTEGER NOT NULL,
      tag_id INTEGER NOT NULL,
      PRIMARY KEY (document_id, tag_id),
      FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
      FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS symptoms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vehicle_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      system TEXT,
      suspected_causes TEXT,
      confidence TEXT NOT NULL DEFAULT 'medium',
      severity TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      notes TEXT,
      first_observed_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (vehicle_id) REFERENCES vehicles(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS symptom_documents (
      symptom_id INTEGER NOT NULL,
      document_id INTEGER NOT NULL,
      PRIMARY KEY (symptom_id, document_id),
      FOREIGN KEY (symptom_id) REFERENCES symptoms(id) ON DELETE CASCADE,
      FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS procedures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vehicle_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      system TEXT,
      difficulty TEXT NOT NULL DEFAULT 'intermediate',
      tools_needed TEXT,
      parts_needed TEXT,
      safety_notes TEXT,
      steps TEXT,
      confidence TEXT NOT NULL DEFAULT 'medium',
      status TEXT NOT NULL DEFAULT 'draft',
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (vehicle_id) REFERENCES vehicles(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS procedure_documents (
      procedure_id INTEGER NOT NULL,
      document_id INTEGER NOT NULL,
      PRIMARY KEY (procedure_id, document_id),
      FOREIGN KEY (procedure_id) REFERENCES procedures(id) ON DELETE CASCADE,
      FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vehicle_id INTEGER NOT NULL,
      document_id INTEGER,
      title TEXT,
      body TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL DEFAULT '',
      note_type TEXT NOT NULL DEFAULT 'general',
      related_entity_type TEXT NOT NULL DEFAULT 'none',
      related_entity_id INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (vehicle_id) REFERENCES vehicles(id) ON DELETE CASCADE,
      FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE SET NULL
    );
  `);

  ensureColumn("documents", "file_type", "TEXT");
  ensureColumn("documents", "subsystem", "TEXT");
  ensureColumn("documents", "source", "TEXT");
  ensureColumn(
    "documents",
    "extraction_status",
    "TEXT NOT NULL DEFAULT 'not_attempted'"
  );
  ensureColumn("documents", "page_count", "INTEGER");
  ensureColumn("symptoms", "system", "TEXT");
  ensureColumn("symptoms", "suspected_causes", "TEXT");
  ensureColumn("symptoms", "confidence", "TEXT NOT NULL DEFAULT 'medium'");
  ensureColumn("symptoms", "notes", "TEXT");
  ensureColumn("procedures", "difficulty", "TEXT NOT NULL DEFAULT 'intermediate'");
  ensureColumn("procedures", "tools_needed", "TEXT");
  ensureColumn("procedures", "parts_needed", "TEXT");
  ensureColumn("procedures", "safety_notes", "TEXT");
  ensureColumn("procedures", "steps", "TEXT");
  ensureColumn("procedures", "confidence", "TEXT NOT NULL DEFAULT 'medium'");
  ensureColumn("notes", "content", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("notes", "note_type", "TEXT NOT NULL DEFAULT 'general'");
  ensureColumn("notes", "related_entity_type", "TEXT NOT NULL DEFAULT 'none'");
  ensureColumn("notes", "related_entity_id", "INTEGER");
}

function seedVehicle() {
  const existingVehicle = db
    .prepare("SELECT id FROM vehicles WHERE year = ? AND make = ? AND model = ? AND trim = ?")
    .get(2009, "Toyota", "Corolla", "LE");

  if (existingVehicle) {
    return existingVehicle.id;
  }

  const insertVehicle = db.prepare(`
    INSERT INTO vehicles (year, make, model, trim, engine)
    VALUES (?, ?, ?, ?, ?)
  `);

  const result = insertVehicle.run(2009, "Toyota", "Corolla", "LE", "1.8L");
  return result.lastInsertRowid;
}

function seedDocument(vehicleId) {
  const existingDocument = db
    .prepare("SELECT id FROM documents WHERE original_filename = ?")
    .get("2009-corolla-maintenance-sample.pdf");

  if (existingDocument) {
    return existingDocument.id;
  }

  const insertDocument = db.prepare(`
    INSERT INTO documents (
      vehicle_id,
      title,
      original_filename,
      stored_filename,
      file_path,
      file_type,
      system,
      subsystem,
      document_type,
      source,
      notes,
      extracted_text,
      extraction_status,
      page_count,
      is_favorite,
      is_bookmarked
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = insertDocument.run(
    vehicleId,
    "Sample Maintenance Schedule",
    "2009-corolla-maintenance-sample.pdf",
    "sample-maintenance-schedule.pdf",
    "server/uploads/sample-maintenance-schedule.pdf",
    "application/pdf",
    "Engine",
    "Routine Service",
    "Maintenance Schedule",
    "Seed Data",
      "Sample document used to verify document import and browsing.",
    "Oil changes every 5,000 miles. Inspect belts, hoses, spark plugs, and engine air filter.",
    "completed",
    1,
    1,
    1
  );

  return result.lastInsertRowid;
}

function seedTags(documentId) {
  const tagNames = ["maintenance", "engine", "sample"];

  const insertTag = db.prepare(`
    INSERT INTO tags (name)
    VALUES (?)
    ON CONFLICT(name) DO NOTHING
  `);

  const selectTag = db.prepare("SELECT id FROM tags WHERE name = ?");
  const linkTag = db.prepare(`
    INSERT OR IGNORE INTO document_tags (document_id, tag_id)
    VALUES (?, ?)
  `);

  for (const tagName of tagNames) {
    insertTag.run(tagName);
    const tag = selectTag.get(tagName);
    linkTag.run(documentId, tag.id);
  }
}

function backfillSeedDocument() {
  db.prepare(`
    UPDATE documents
    SET
      file_type = COALESCE(file_type, 'application/pdf'),
      subsystem = COALESCE(subsystem, 'Routine Service'),
      source = COALESCE(source, 'Seed Data'),
      extraction_status = CASE
        WHEN extraction_status IS NULL OR extraction_status = '' THEN 'completed'
        ELSE extraction_status
      END,
      page_count = COALESCE(page_count, 1),
      updated_at = CURRENT_TIMESTAMP
    WHERE original_filename = ?
  `).run("2009-corolla-maintenance-sample.pdf");
}

function backfillNotesData() {
  db.exec(`
    UPDATE notes
    SET content = COALESCE(NULLIF(content, ''), body, '')
    WHERE content IS NULL OR TRIM(content) = '';

    UPDATE notes
    SET related_entity_type = 'document',
        related_entity_id = document_id
    WHERE (related_entity_type IS NULL OR TRIM(related_entity_type) = '')
      AND document_id IS NOT NULL
      AND (related_entity_id IS NULL OR related_entity_id <= 0);

    UPDATE notes
    SET note_type = 'general'
    WHERE note_type IS NULL OR TRIM(note_type) = '';
  `);
}

export function initializeDatabase() {
  createTables();
  ensureAppSettingsRecord();
  const vehicleId = seedVehicle();
  const documentId = seedDocument(vehicleId);
  backfillSeedDocument();
  backfillNotesData();
  seedTags(documentId);
}
