import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

// Migration 007 (audit 1B-03, owner decision D6) fills in `documents.file_md5`
// for web uploads, which never wrote it. These tests build a library the way a
// pre-007 install holds it -- imported rows with a hash, uploaded rows without
// one -- and then run the real initializeDatabase path over it. The hash is
// computed independently here, not with the app's helper, so a change to how
// the app spells the hash cannot also change what this test expects.

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-fix-helper-migration007-"));

process.env.DATABASE_FILE = path.join(tempRoot, "migration007.db");
process.env.UPLOADS_DIR = path.join(tempRoot, "uploads");

const { db } = await import("../src/database.js");
const { initializeDatabase } = await import("../src/initDatabase.js");

after(() => {
  if (typeof db.close === "function") {
    db.close();
  }

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

const MIGRATION = "007_backfill_upload_file_md5";
const md5 = (bytes) => createHash("md5").update(bytes).digest("hex");
const pdfBytes = (label) => Buffer.from(`%PDF-1.4\n% ${label}\n%%EOF\n`, "latin1");

initializeDatabase();
const vehicleId = db.prepare("SELECT id FROM vehicles LIMIT 1").get().id;

function insertDocument({ title, storedFilename, fileMd5 = null, bytes = null }) {
  if (bytes) {
    fs.writeFileSync(path.join(process.env.UPLOADS_DIR, storedFilename), bytes);
  }

  const info = db
    .prepare(`
      INSERT INTO documents (
        vehicle_id, title, original_filename, stored_filename, file_path,
        system, document_type, file_md5, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'Brakes', 'Manual', ?, '2026-01-01 00:00:00')
    `)
    .run(vehicleId, title, `${title}.pdf`, storedFilename, `server/uploads/${storedFilename}`, fileMd5);

  return Number(info.lastInsertRowid);
}

const row = (id) =>
  db.prepare("SELECT file_md5, title, updated_at FROM documents WHERE id = ?").get(id);

test("migration 007 hashes uploads, keeps the oldest copy's hash, and reports every NULL", (t) => {
  const imported = pdfBytes("imported manual");
  const unique = pdfBytes("only uploaded once");
  const twice = pdfBytes("uploaded twice");
  const emptyHash = pdfBytes("stored with an empty hash");

  const importedId = insertDocument({
    title: "Imported manual",
    storedFilename: "imported.pdf",
    fileMd5: md5(imported),
    bytes: imported,
  });
  const uploadOfImportedId = insertDocument({
    title: "Upload of the imported manual",
    storedFilename: "upload-of-imported.pdf",
    bytes: imported,
  });
  const uniqueId = insertDocument({ title: "Unique upload", storedFilename: "unique.pdf", bytes: unique });
  const firstCopyId = insertDocument({ title: "First copy", storedFilename: "first.pdf", bytes: twice });
  const laterCopyId = insertDocument({ title: "Later copy", storedFilename: "later.pdf", bytes: twice });
  const missingId = insertDocument({ title: "Missing file", storedFilename: "missing.pdf" });
  const emptyHashId = insertDocument({
    title: "Empty hash",
    storedFilename: "empty-hash.pdf",
    fileMd5: "",
    bytes: emptyHash,
  });

  // Make this database a pre-007 one, then start the app over it.
  db.prepare("DELETE FROM schema_migrations WHERE name = ?").run(MIGRATION);
  const filesBefore = fs.readdirSync(process.env.UPLOADS_DIR).sort();
  const countBefore = db.prepare("SELECT COUNT(*) AS c FROM documents").get().c;
  const logs = t.mock.method(console, "log", () => {});
  const warnings = t.mock.method(console, "warn", () => {});

  initializeDatabase();

  assert.equal(row(importedId).file_md5, md5(imported), "an imported hash is never rewritten");
  assert.equal(row(uniqueId).file_md5, md5(unique));
  assert.equal(row(firstCopyId).file_md5, md5(twice), "the oldest copy keeps the hash");
  assert.equal(row(emptyHashId).file_md5, md5(emptyHash), "an empty hash counts as missing");
  assert.equal(row(uploadOfImportedId).file_md5, null);
  assert.equal(row(laterCopyId).file_md5, null);
  assert.equal(row(missingId).file_md5, null);

  // Only file_md5 changes: no row, file, or timestamp is touched.
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM documents").get().c, countBefore);
  assert.deepEqual(fs.readdirSync(process.env.UPLOADS_DIR).sort(), filesBefore);
  assert.equal(row(uniqueId).updated_at, "2026-01-01 00:00:00");

  assert.equal(logs.mock.callCount(), 1);
  assert.match(logs.mock.calls[0].arguments[0], /Recorded file_md5 for 3 of 6 uploaded document/);
  assert.equal(warnings.mock.callCount(), 1);
  const warning = warnings.mock.calls[0].arguments[0];
  assert.match(warning, new RegExp(`document ${uploadOfImportedId} \\(same file as document ${importedId}\\)`));
  assert.match(warning, new RegExp(`document ${laterCopyId} \\(same file as document ${firstCopyId}\\)`));
  assert.match(warning, new RegExp(`document ${missingId} \\(stored file missing\\)`));
  // The log-safe convention: numeric ids, never a title or a filename.
  assert.doesNotMatch(warning, /Later copy|later\.pdf|Missing file|missing\.pdf/);

  assert.ok(
    db.prepare("SELECT 1 FROM schema_migrations WHERE name = ?").get(MIGRATION),
    "the migration is recorded even though some rows keep NULL"
  );
});

test("migration 007 runs once: a restart does not retry the rows it left NULL", (t) => {
  const logs = t.mock.method(console, "log", () => {});
  const warnings = t.mock.method(console, "warn", () => {});

  initializeDatabase();

  assert.equal(logs.mock.callCount(), 0);
  assert.equal(warnings.mock.callCount(), 0);
});

test("migration 007 on a library with nothing to backfill is silent", (t) => {
  db.prepare("DELETE FROM schema_migrations WHERE name = ?").run(MIGRATION);
  db.prepare("DELETE FROM documents WHERE file_md5 IS NULL").run();
  const logs = t.mock.method(console, "log", () => {});

  initializeDatabase();

  assert.equal(logs.mock.callCount(), 0);
});
