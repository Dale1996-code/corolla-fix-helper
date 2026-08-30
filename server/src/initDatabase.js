import fs from "node:fs";
import path from "node:path";
import { db } from "./database.js";
import { config } from "./config.js";
import { ensureAppSettingsRecord } from "./services/appSettingsService.js";

// Filename of the optional demo document, stored under config.uploadsDir.
const SEED_DOCUMENT_STORED_FILENAME = "sample-maintenance-schedule.pdf";

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
      file_md5 TEXT,
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
      name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS document_tags (
      document_id INTEGER NOT NULL,
      tag_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
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

    CREATE TABLE IF NOT EXISTS symptom_procedures (
      symptom_id INTEGER NOT NULL,
      procedure_id INTEGER NOT NULL,
      PRIMARY KEY (symptom_id, procedure_id),
      FOREIGN KEY (symptom_id) REFERENCES symptoms(id) ON DELETE CASCADE,
      FOREIGN KEY (procedure_id) REFERENCES procedures(id) ON DELETE CASCADE
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

    CREATE TABLE IF NOT EXISTS document_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id INTEGER NOT NULL,
      page_number INTEGER NOT NULL,
      chunk_index INTEGER NOT NULL,
      chunk_text TEXT NOT NULL,
      embedding BLOB,
      embedding_version TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
      UNIQUE (document_id, page_number, chunk_index)
    );

    CREATE INDEX IF NOT EXISTS idx_document_chunks_document_id
      ON document_chunks (document_id);

    CREATE INDEX IF NOT EXISTS idx_document_chunks_page
      ON document_chunks (page_number);

    CREATE TABLE IF NOT EXISTS attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT NOT NULL,
      entity_id INTEGER NOT NULL,
      original_filename TEXT NOT NULL,
      stored_filename TEXT NOT NULL,
      file_path TEXT,
      mime_type TEXT NOT NULL,
      file_size INTEGER,
      caption TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_attachments_entity
      ON attachments (entity_type, entity_id);
  `);

  ensureColumn("documents", "file_type", "TEXT");
  ensureColumn("documents", "subsystem", "TEXT");
  ensureColumn("documents", "source", "TEXT");
  ensureColumn("documents", "file_md5", "TEXT");
  ensureColumn(
    "documents",
    "extraction_status",
    "TEXT NOT NULL DEFAULT 'not_attempted'"
  );
  ensureColumn("documents", "page_count", "INTEGER");
  ensureColumn("documents", "is_bookmarked", "INTEGER NOT NULL DEFAULT 0");
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
  ensureColumn("document_chunks", "embedding", "BLOB");
  ensureColumn("document_chunks", "embedding_version", "TEXT");

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_document_chunks_embedding_version
      ON document_chunks (embedding_version);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_file_md5
      ON documents (file_md5)
      WHERE file_md5 IS NOT NULL AND TRIM(file_md5) <> '';

    CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_name
      ON tags (name COLLATE NOCASE);

    CREATE INDEX IF NOT EXISTS idx_document_tags_document_id
      ON document_tags (document_id);

    CREATE INDEX IF NOT EXISTS idx_document_tags_tag_id
      ON document_tags (tag_id);
  `);
}

// Migration 002: additive Repair Checklists feature. Two vehicle-scoped tables
// that stand on their own — no changes to existing tables. Items cascade-delete
// with their parent checklist (foreign keys are enabled in database.js).
function createRepairChecklistsTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS repair_checklists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vehicle_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'planned',
      description TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (vehicle_id) REFERENCES vehicles(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS repair_checklist_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      checklist_id INTEGER NOT NULL,
      text TEXT NOT NULL,
      is_done INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (checklist_id) REFERENCES repair_checklists(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_repair_checklist_items_checklist
      ON repair_checklist_items (checklist_id);
  `);
}

// Reverse-link and sort indexes. Each column order matches how the query it
// serves filters (equality columns first) then sorts (sort columns in order):
//   - documents list sorts by (created_at DESC, id DESC) with no equality
//     filter, so (created_at, id) lets SQLite scan the index backward instead of
//     building a temp B-tree for ORDER BY.
//   - The link tables' primary keys start with the OWNING id (symptom_id /
//     procedure_id / symptom_id), so a lookup by the OTHER id (document_id /
//     procedure_id) has no usable prefix and scans; these indexes cover that
//     reverse direction and the matching ON DELETE CASCADE.
//   - repair_checklists filters by vehicle_id then sorts by (updated_at, id);
//     repair_checklist_items filters by checklist_id then sorts by
//     (sort_order, id) — the composite indexes cover both filter and sort.
// All are CREATE INDEX IF NOT EXISTS, so this migration only adds indexes and
// never touches row data.
function createLinkAndSortIndexes() {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_documents_created_at
      ON documents (created_at, id);

    CREATE INDEX IF NOT EXISTS idx_symptom_documents_document_id
      ON symptom_documents (document_id);

    CREATE INDEX IF NOT EXISTS idx_procedure_documents_document_id
      ON procedure_documents (document_id);

    CREATE INDEX IF NOT EXISTS idx_symptom_procedures_procedure_id
      ON symptom_procedures (procedure_id);

    CREATE INDEX IF NOT EXISTS idx_repair_checklists_vehicle_updated
      ON repair_checklists (vehicle_id, updated_at, id);

    CREATE INDEX IF NOT EXISTS idx_repair_checklist_items_order
      ON repair_checklist_items (checklist_id, sort_order, id);
  `);
}

// Migration 004: repair history (roadmap N3). Two additive, vehicle-scoped
// tables recording a repair that was actually carried out. Nothing existing is
// touched — no ALTER on `vehicles`, no change to `repair_checklists`.
//
// The odometer lives HERE, on the repair, and there is deliberately no
// `vehicles.current_odometer`. A reading taken on the day of a job is a
// historical fact; a "current" odometer is a derived maximum, and storing both
// would create two writable sources of truth for one number with no rule for
// reconciling them. Nothing in the app reads a current odometer today, and
// `SELECT MAX(odometer_miles) FROM repair_history` answers the question if
// anything ever does.
//
// The integrity strategy is LIVE FOREIGN KEY + HISTORICAL SNAPSHOT, and both
// halves are load-bearing:
//
//   - Every inbound foreign key is ON DELETE SET NULL, never CASCADE. Deleting a
//     symptom, a checklist, or a document must not delete the owner's record
//     that they did the work. This matches what documentService.deleteDocument
//     already does by hand for note links.
//   - The *_title columns are snapshots taken when the row is written. They are
//     what keeps a history row readable after its links are gone or its linked
//     records have been renamed: a completed repair must never silently change
//     because a current record changed.
//
// The one CASCADE is repair_history -> repair_history_documents, where the child
// genuinely belongs to the parent.
//
// What is deliberately NOT stored: planner `sourceId` values (S1, S2, ...) and
// chunk ids. Source ids are request-local (Ask) or run-wide (planner)
// identifiers with no meaning outside the run that minted them, and
// documentChunkService rebuilds chunk rows on re-extraction, so a chunk id is
// stale the next time a PDF is re-extracted. `document_id` + `page_number`
// survives both, and is exactly what the client's buildDocumentFileLink already
// needs to deep-link a cited page.
function createRepairHistoryTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS repair_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vehicle_id INTEGER NOT NULL,
      performed_on TEXT NOT NULL,
      odometer_miles INTEGER
        CHECK (
          odometer_miles IS NULL
          OR (odometer_miles >= 0 AND odometer_miles <= 2000000)
        ),
      title TEXT NOT NULL,
      outcome TEXT NOT NULL DEFAULT 'unknown'
        CHECK (outcome IN ('fixed', 'partial', 'not_fixed', 'unknown')),
      summary TEXT NOT NULL DEFAULT '',
      follow_up TEXT NOT NULL DEFAULT '',
      symptom_id INTEGER,
      symptom_title TEXT NOT NULL DEFAULT '',
      checklist_id INTEGER,
      checklist_title TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (vehicle_id) REFERENCES vehicles(id) ON DELETE CASCADE,
      FOREIGN KEY (symptom_id) REFERENCES symptoms(id) ON DELETE SET NULL,
      FOREIGN KEY (checklist_id) REFERENCES repair_checklists(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS repair_history_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repair_history_id INTEGER NOT NULL,
      document_id INTEGER,
      document_title TEXT NOT NULL,
      page_number INTEGER CHECK (page_number IS NULL OR page_number > 0),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (repair_history_id) REFERENCES repair_history(id) ON DELETE CASCADE,
      FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_repair_history_vehicle_performed
      ON repair_history (vehicle_id, performed_on, id);

    CREATE INDEX IF NOT EXISTS idx_repair_history_symptom
      ON repair_history (symptom_id);

    CREATE INDEX IF NOT EXISTS idx_repair_history_checklist
      ON repair_history (checklist_id);

    -- Not redundant with the partial unique index below: that one is filtered on
    -- document_id IS NOT NULL, so SQLite cannot use it for the ordinary read
    -- that must also return provenance rows whose document was deleted.
    CREATE INDEX IF NOT EXISTS idx_repair_history_documents_history
      ON repair_history_documents (repair_history_id, id);

    -- Covers the ON DELETE SET NULL sweep when a document is deleted, the same
    -- way migration 003's reverse-link indexes cover their cascades.
    CREATE INDEX IF NOT EXISTS idx_repair_history_documents_document
      ON repair_history_documents (document_id);

    -- Partial ON PURPOSE. Once a document is deleted its provenance rows keep
    -- their snapshot and drop to document_id NULL; several such rows can belong
    -- to one history record, and an unfiltered unique index would have to treat
    -- them as colliding. Note this is a BACKSTOP, not the deduplication
    -- guarantee: SQLite treats NULLs as distinct, so two citations of the same
    -- document with no page number would both pass here. Deduplication of
    -- caller input is done deterministically in repairHistoryService.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_repair_history_documents_unique
      ON repair_history_documents (repair_history_id, document_id, page_number)
      WHERE document_id IS NOT NULL;
  `);
}

// Migration 005: durable checklist provenance (roadmap N3.2). One additive
// table, plus one partial unique index on the EXISTING `repair_history` table.
// Nothing in migrations 001-004 is edited.
//
// THE GAP THIS CLOSES. A Repair Planner run produces structured citations that
// each carry a `documentId` and a `pageNumber`. `buildPlannerChecklistDraft`
// rendered those into prose ("Brake Service Guide, page 4") and then dropped the
// structure on the floor: the saved checklist held a sentence a human could
// read, and nothing a query could follow. N3.1 built the destination
// (`repair_history_documents`); this table is the missing middle, so evidence
// survives the walk from a plan to a completed repair.
//
// `repair_checklist_documents` deliberately mirrors `repair_history_documents`
// column for column, because it is the same kind of fact at an earlier moment
// and completion copies one into the other verbatim. Same LIVE FOREIGN KEY +
// HISTORICAL SNAPSHOT strategy, and both halves are load-bearing for the reasons
// documented on migration 004:
//
//   - `document_id` is ON DELETE SET NULL. Deleting a PDF must not delete the
//     record of which page backed the work.
//   - `document_title` is a snapshot taken at write time, which is what keeps
//     the row readable after the document is renamed or removed.
//
// The CASCADE on `repair_checklist_id` is the ordinary parent/child one: these
// rows belong to the checklist and mean nothing without it. That is safe
// precisely BECAUSE completion copies them into `repair_history_documents`
// rather than pointing at them -- deleting a completed checklist later drops
// these rows and leaves the history copy untouched.
//
// What is deliberately NOT stored here, exactly as on migration 004: planner
// `sourceId` values (S1, S2, ...), chunk ids, embedding ids, and the plan run
// id. Source ids are scoped to the run that minted them, chunk rows are rebuilt
// on re-extraction, and the run itself is an in-memory record that expires in
// hours. `document_id` + title snapshot + `page_number` is the only identity
// that outlives all three.
function createRepairChecklistProvenance() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS repair_checklist_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repair_checklist_id INTEGER NOT NULL,
      document_id INTEGER,
      document_title TEXT NOT NULL,
      page_number INTEGER CHECK (page_number IS NULL OR page_number > 0),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (repair_checklist_id) REFERENCES repair_checklists(id) ON DELETE CASCADE,
      FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE SET NULL
    );

    -- The ordinary read: every provenance row for one checklist, including the
    -- rows whose document has since been deleted. The partial unique index below
    -- is filtered, so SQLite cannot serve this read from it.
    CREATE INDEX IF NOT EXISTS idx_repair_checklist_documents_checklist
      ON repair_checklist_documents (repair_checklist_id, id);

    -- Covers the ON DELETE SET NULL sweep when a document is deleted.
    CREATE INDEX IF NOT EXISTS idx_repair_checklist_documents_document
      ON repair_checklist_documents (document_id);

    -- Partial for the same reason as its repair_history_documents twin: once a
    -- document is deleted its rows drop to document_id NULL, and several such
    -- rows can belong to one checklist. A BACKSTOP, not the deduplication
    -- guarantee -- SQLite treats NULLs as distinct, so deduplication of planner
    -- citations is done deterministically in repairChecklistProvenanceService.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_repair_checklist_documents_unique
      ON repair_checklist_documents (repair_checklist_id, document_id, page_number)
      WHERE document_id IS NOT NULL;
  `);

  // ONE CHECKLIST IS ONE REPAIR. Completing a checklist writes a repair_history
  // row that links back to it, and a second completion of the same checklist
  // would record the same physical job twice with no way to tell the copies
  // apart afterwards.
  //
  // This is enforced in the SCHEMA rather than by a read-then-write check in the
  // service, because a check is only ever as good as the window between it and
  // the insert. The service does check first -- so a repeat completion gets a
  // clean, explanatory response instead of a constraint error -- but the index is
  // what makes the guarantee true. Partial on IS NOT NULL because `checklist_id`
  // is ON DELETE SET NULL: once a completed checklist is deleted its history row
  // drops to NULL, and any number of such orphaned records may coexist.
  //
  // It binds BOTH entry points, not just completion: the N3.1 CRUD route can
  // also link a history record to a checklist, and one repair recorded twice is
  // the same mistake whichever door it came through.
  const duplicateChecklistLink = db
    .prepare(`
      SELECT checklist_id, COUNT(*) AS total
      FROM repair_history
      WHERE checklist_id IS NOT NULL
      GROUP BY checklist_id
      HAVING total > 1
      LIMIT 1
    `)
    .get();

  // Checked up front so a pre-existing duplicate fails with a sentence naming
  // the offending checklist, rather than a bare "UNIQUE constraint failed"
  // during startup.
  if (duplicateChecklistLink) {
    throw new Error(
      `Cannot apply migration 005: repair checklist ${duplicateChecklistLink.checklist_id} is linked ` +
        `to ${duplicateChecklistLink.total} repair history records, but one checklist records one ` +
        "repair. Delete or re-link the duplicate repair_history rows, then restart."
    );
  }

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_repair_history_checklist_unique
      ON repair_history (checklist_id)
      WHERE checklist_id IS NOT NULL;
  `);
}

function seedVehicle() {
  // One-vehicle workspace: only insert when no vehicle exists at all. Matching
  // on the original year/make/model/trim would insert a second hidden row once
  // the user edits their vehicle details in Settings.
  const existingVehicle = db
    .prepare("SELECT id FROM vehicles ORDER BY id ASC LIMIT 1")
    .get();

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

function seedDocumentTags(documentId) {
  const existingLink = db
    .prepare("SELECT 1 FROM document_tags WHERE document_id = ? LIMIT 1")
    .get(documentId);

  if (existingLink) {
    return;
  }

  const insertTag = db.prepare("INSERT OR IGNORE INTO tags (name) VALUES (?)");
  const findTag = db.prepare("SELECT id FROM tags WHERE name = ? COLLATE NOCASE");
  const linkTag = db.prepare(
    "INSERT OR IGNORE INTO document_tags (document_id, tag_id) VALUES (?, ?)"
  );

  for (const tagName of ["maintenance", "engine", "sample"]) {
    insertTag.run(tagName);
    const tag = findTag.get(tagName);

    if (tag) {
      linkTag.run(documentId, tag.id);
    }
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

function seedDocumentChunks(documentId) {
  if (!documentId) {
    return;
  }

  const existingChunk = db
    .prepare("SELECT id FROM document_chunks WHERE document_id = ? LIMIT 1")
    .get(documentId);

  if (existingChunk) {
    return;
  }

  const seedRow = db
    .prepare("SELECT extracted_text FROM documents WHERE id = ?")
    .get(documentId);
  const seedText =
    typeof seedRow?.extracted_text === "string" ? seedRow.extracted_text.trim() : "";

  if (!seedText) {
    return;
  }

  db.prepare(`
    INSERT INTO document_chunks (document_id, page_number, chunk_index, chunk_text)
    VALUES (?, 1, 0, ?)
  `).run(documentId, seedText);
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

// Write a minimal but structurally valid PDF for the demo document so it points
// at a real file on disk instead of a dangling reference.
function ensureSeedDocumentFile() {
  fs.mkdirSync(config.uploadsDir, { recursive: true });

  const target = path.join(config.uploadsDir, SEED_DOCUMENT_STORED_FILENAME);

  if (fs.existsSync(target)) {
    return;
  }

  const minimalPdf = [
    "%PDF-1.4",
    "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj",
    "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj",
    "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj",
    "trailer<</Root 1 0 R>>",
    "%%EOF",
    "",
  ].join("\n");

  fs.writeFileSync(target, minimalPdf, "latin1");
}

// Whether to seed the optional demo/sample workspace data. Off unless SEED_DEMO
// is explicitly truthy, so a real workspace stays empty until the user adds
// their own documents. `npm run demo:seed` sets this for a one-off load.
function shouldSeedDemoData() {
  const value = process.env.SEED_DEMO;

  if (typeof value !== "string" || !value.trim()) {
    return false;
  }

  return !["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

/**
 * Seed the demo/sample document, its tags, and its retrievable chunks.
 *
 * Kept out of the default startup path and exposed for the explicit
 * `npm run demo:seed` script (see src/scripts/demoSeed.js).
 */
export function seedDemoData() {
  const existingVehicle = db
    .prepare("SELECT id FROM vehicles ORDER BY id ASC LIMIT 1")
    .get();
  const vehicleId = existingVehicle ? existingVehicle.id : seedVehicle();

  ensureSeedDocumentFile();
  const seedDocumentId = seedDocument(vehicleId);
  seedDocumentTags(seedDocumentId);
  backfillSeedDocument();
  seedDocumentChunks(seedDocumentId);
}

// --- Schema migrations -----------------------------------------------------
//
// A small version table records which numbered migrations have run, so future
// schema changes can be added as new numbered steps instead of ad hoc edits.
// Existing installs are safe: the initial schema is idempotent (CREATE TABLE IF
// NOT EXISTS + ensureColumn), so recording it as "001" the first time after this
// change never drops or rewrites data.

function ensureSchemaMigrationsTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

function hasMigrationRun(name) {
  return Boolean(
    db.prepare("SELECT 1 FROM schema_migrations WHERE name = ?").get(name)
  );
}

/**
 * Run a numbered migration exactly once. The migration body and the bookkeeping
 * insert share one transaction, so a failure rolls back without recording a
 * half-applied migration.
 */
function runMigration(name, migrate) {
  if (hasMigrationRun(name)) {
    return;
  }

  db.exec("BEGIN IMMEDIATE TRANSACTION");

  try {
    migrate();
    db.prepare("INSERT INTO schema_migrations (name) VALUES (?)").run(name);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function initializeDatabase() {
  ensureSchemaMigrationsTable();
  runMigration("001_initial_schema", createTables);
  runMigration("002_repair_checklists", createRepairChecklistsTables);
  runMigration("003_link_and_sort_indexes", createLinkAndSortIndexes);
  runMigration("004_repair_history", createRepairHistoryTables);
  runMigration("005_repair_checklist_provenance", createRepairChecklistProvenance);

  ensureAppSettingsRecord();
  seedVehicle();

  if (shouldSeedDemoData()) {
    seedDemoData();
  }

  backfillNotesData();
}
