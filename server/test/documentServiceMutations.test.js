// Unit tests for the document persistence logic extracted out of
// routes/documents.js so the route stays thin: the record getters used by the
// file-serve / re-extract / update / delete handlers, plus the create,
// re-extract, and metadata-update pipelines (exercised against the real PDF
// fixture, so extraction + chunk rebuild run for real). They use a scratch DB
// and uploads dir, no API key required.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, beforeEach } from "node:test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePdf = path.join(__dirname, "fixtures", "sample-maintenance-schedule.pdf");

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-doc-mutations-"));

process.env.DATABASE_FILE = path.join(tempRoot, "documents.db");
process.env.UPLOADS_DIR = path.join(tempRoot, "uploads");
process.env.OPENAI_API_KEY = "";

fs.mkdirSync(process.env.UPLOADS_DIR, { recursive: true });

const { db } = await import("../src/database.js");
const { initializeDatabase } = await import("../src/initDatabase.js");
const { config } = await import("../src/config.js");
const {
  createDocument,
  getDocument,
  getDocumentFileLocation,
  getDocumentFileRecord,
  getDocumentMetadataRecord,
  reextractDocument,
  updateDocumentMetadata,
} = await import("../src/services/documentService.js");

initializeDatabase();

const fixtureBuffer = fs.readFileSync(fixturePdf);

after(() => {
  if (typeof db.close === "function") {
    db.close();
  }

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

beforeEach(() => {
  db.exec(`
    DELETE FROM document_tags;
    DELETE FROM document_chunks;
    DELETE FROM documents;
    DELETE FROM tags;
  `);
});

function vehicleId() {
  return Number(db.prepare("SELECT id FROM vehicles ORDER BY id ASC LIMIT 1").get().id);
}

function insertDocument(overrides = {}) {
  const values = {
    title: "Owner's Manual",
    original_filename: "owners.pdf",
    stored_filename: "owners-stored.pdf",
    file_path: "server/uploads/owners-stored.pdf",
    file_type: "application/pdf",
    system: "Engine",
    subsystem: "Cooling",
    document_type: "Repair Manual",
    source: "Toyota",
    notes: "some notes",
    is_favorite: 0,
    is_bookmarked: 0,
    ...overrides,
  };

  return Number(
    db
      .prepare(`
        INSERT INTO documents (
          vehicle_id, title, original_filename, stored_filename, file_path,
          file_type, system, subsystem, document_type, source, notes,
          extraction_status, is_favorite, is_bookmarked
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        vehicleId(),
        values.title,
        values.original_filename,
        values.stored_filename,
        values.file_path,
        values.file_type,
        values.system,
        values.subsystem,
        values.document_type,
        values.source,
        values.notes,
        "completed",
        values.is_favorite,
        values.is_bookmarked
      ).lastInsertRowid
  );
}

function uploadsFileCount() {
  return fs.readdirSync(config.uploadsDir).length;
}

// --- record getters --------------------------------------------------------

test("getDocumentFileRecord returns the file-serving columns, or undefined when missing", () => {
  const id = insertDocument({
    original_filename: "brakes.pdf",
    stored_filename: "brakes-stored.pdf",
    file_type: "application/pdf",
  });

  const record = getDocumentFileRecord(id);
  assert.equal(record.id, id);
  assert.equal(record.original_filename, "brakes.pdf");
  assert.equal(record.stored_filename, "brakes-stored.pdf");
  assert.equal(record.file_path, "server/uploads/owners-stored.pdf");
  assert.equal(record.file_type, "application/pdf");

  assert.equal(getDocumentFileRecord(id + 999), undefined);
});

test("getDocumentFileLocation returns just id + stored_filename + file_path", () => {
  const id = insertDocument({ stored_filename: "loc.pdf", file_path: "server/uploads/loc.pdf" });

  const record = getDocumentFileLocation(id);
  assert.deepEqual(Object.keys(record).sort(), ["file_path", "id", "stored_filename"]);
  assert.equal(record.stored_filename, "loc.pdf");

  assert.equal(getDocumentFileLocation(id + 999), undefined);
});

test("getDocumentMetadataRecord returns the raw editable metadata columns", () => {
  const id = insertDocument({ title: "Meta", subsystem: "Belts", is_bookmarked: 1 });

  const record = getDocumentMetadataRecord(id);
  assert.equal(record.title, "Meta");
  assert.equal(record.subsystem, "Belts");
  assert.equal(record.document_type, "Repair Manual"); // snake_case raw row
  assert.equal(record.is_bookmarked, 1);

  assert.equal(getDocumentMetadataRecord(id + 999), undefined);
});

test("getDocument returns the camelCase mapped document, or undefined when missing", () => {
  const id = insertDocument({ title: "Mapped", is_favorite: 1 });

  const mapped = getDocument(id);
  assert.equal(mapped.id, id);
  assert.equal(mapped.title, "Mapped");
  assert.equal(mapped.documentType, "Repair Manual"); // camelCase mapped shape
  assert.equal(mapped.isFavorite, true);
  assert.deepEqual(mapped.tags, []);

  assert.equal(getDocument(id + 999), undefined);
});

// --- updateDocumentMetadata ------------------------------------------------

test("updateDocumentMetadata writes the merged fields and leaves tags untouched", () => {
  const id = insertDocument({ title: "Before" });

  updateDocumentMetadata(id, {
    title: "After",
    system: "Brakes",
    subsystem: "Calipers",
    documentType: "Service Bulletin",
    source: "TSB",
    notes: "updated notes",
    isFavorite: true,
    isBookmarked: true,
  });

  const updated = getDocument(id);
  assert.equal(updated.title, "After");
  assert.equal(updated.system, "Brakes");
  assert.equal(updated.subsystem, "Calipers");
  assert.equal(updated.documentType, "Service Bulletin");
  assert.equal(updated.source, "TSB");
  assert.equal(updated.notes, "updated notes");
  assert.equal(updated.isFavorite, true);
  assert.equal(updated.isBookmarked, true);
  assert.deepEqual(updated.tags, []); // metadata update never touches tags
});

// --- createDocument --------------------------------------------------------

test("createDocument writes the file, extracts it, and returns the mapped document", async () => {
  const before = uploadsFileCount();

  const created = await createDocument({
    fileBuffer: fixtureBuffer,
    originalFilename: "maintenance-schedule.pdf",
    mimetype: "application/pdf",
    titleInput: "Maintenance Schedule",
    system: "Maintenance",
    subsystem: "",
    documentType: "Schedule",
    source: "",
    notes: "",
    isBookmarked: true,
    tags: undefined,
    hasTags: false,
  });

  assert.equal(created.title, "Maintenance Schedule");
  assert.equal(created.system, "Maintenance");
  assert.equal(created.documentType, "Schedule");
  assert.equal(created.isBookmarked, true);
  assert.equal(created.isFavorite, false);
  assert.equal(created.fileType, "application/pdf");
  assert.ok(created.pageCount >= 1, "extraction should report at least one page");

  // The stored PDF landed in the uploads dir and the row round-trips.
  assert.equal(uploadsFileCount(), before + 1);
  assert.deepEqual(getDocument(created.id), created);
});

test("createDocument derives the title from the filename when no title is given, and stores tags", async () => {
  const created = await createDocument({
    fileBuffer: fixtureBuffer,
    originalFilename: "cooling-system-overview.pdf",
    mimetype: "application/pdf",
    titleInput: "",
    system: "Cooling",
    subsystem: "",
    documentType: "Reference",
    source: "",
    notes: "",
    isBookmarked: false,
    tags: "coolant, thermostat",
    hasTags: true,
  });

  // Blank title falls back to a filename-derived title (non-empty, no extension).
  assert.ok(created.title.length > 0);
  assert.ok(!created.title.toLowerCase().endsWith(".pdf"));
  // Tags come back as an ordered array of name strings.
  assert.deepEqual(created.tags, ["coolant", "thermostat"]);
});

test("createDocument cleans up the written file and inserts no row when persistence fails", async () => {
  const before = uploadsFileCount();
  const beforeRows = Number(db.prepare("SELECT COUNT(*) AS c FROM documents").get().c);

  // Force the INSERT to fail after the file is written and extraction succeeds.
  const originalPrepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    if (sql.includes("INSERT INTO documents")) {
      throw new Error("simulated insert failure");
    }
    return originalPrepare(sql);
  };

  try {
    await assert.rejects(
      () =>
        createDocument({
          fileBuffer: fixtureBuffer,
          originalFilename: "doomed.pdf",
          mimetype: "application/pdf",
          titleInput: "Doomed",
          system: "Engine",
          subsystem: "",
          documentType: "Repair Manual",
          source: "",
          notes: "",
          isBookmarked: false,
          tags: undefined,
          hasTags: false,
        }),
      /simulated insert failure/
    );
  } finally {
    db.prepare = originalPrepare;
  }

  // No orphaned file and no orphaned/half-inserted row.
  assert.equal(uploadsFileCount(), before, "the written file must be cleaned up on failure");
  assert.equal(
    Number(db.prepare("SELECT COUNT(*) AS c FROM documents").get().c),
    beforeRows,
    "no document row should remain after a failed create"
  );
});

// --- reextractDocument -----------------------------------------------------

test("reextractDocument refreshes extraction fields and rebuilds chunks", async () => {
  const id = insertDocument({ original_filename: "reextract.pdf" });

  // Start from a stale/empty extraction state and no chunks.
  db.prepare(
    "UPDATE documents SET extracted_text = '', extraction_status = 'pending', page_count = 0 WHERE id = ?"
  ).run(id);
  assert.equal(
    Number(db.prepare("SELECT COUNT(*) AS c FROM document_chunks WHERE document_id = ?").get(id).c),
    0
  );

  const updated = await reextractDocument(id, fixtureBuffer);

  assert.equal(updated.id, id);
  assert.ok(updated.pageCount >= 1, "page count should be refreshed from the PDF");
  assert.notEqual(updated.extractionStatus, "pending");
  assert.ok(
    Number(db.prepare("SELECT COUNT(*) AS c FROM document_chunks WHERE document_id = ?").get(id).c) >= 1,
    "chunks should be rebuilt from the extracted pages"
  );
});
