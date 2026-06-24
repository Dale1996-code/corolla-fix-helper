import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Point at an isolated database/uploads dir before importing modules that open
// the SQLite connection, so this file does not contend with the default DB used
// by other test files running in parallel.
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-doc-service-"));

process.env.DATABASE_FILE = path.join(tempRoot, "test.db");
process.env.UPLOADS_DIR = path.join(tempRoot, "uploads");

fs.mkdirSync(process.env.UPLOADS_DIR, { recursive: true });

const { config } = await import("../src/config.js");
const { db } = await import("../src/database.js");
const { initializeDatabase } = await import("../src/initDatabase.js");
const { resolveStoredFilePath, deleteDocument, listDocuments, countDocuments } =
  await import("../src/services/documentService.js");

initializeDatabase();

function insertNamedDocument(name) {
  const vehicle = db.prepare("SELECT id FROM vehicles ORDER BY id ASC LIMIT 1").get();
  return Number(
    db
      .prepare(`
        INSERT INTO documents (
          vehicle_id, title, original_filename, stored_filename, file_path,
          file_type, system, document_type, extraction_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        vehicle.id,
        name,
        `${name}.pdf`,
        `${name}.pdf`,
        `server/uploads/${name}.pdf`,
        "application/pdf",
        "Engine",
        "Repair Manual",
        "completed"
      ).lastInsertRowid
  );
}

test("resolveStoredFilePath prefers stored_filename and joins the uploads dir", () => {
  const resolved = resolveStoredFilePath({
    stored_filename: "abc.pdf",
    file_path: "server/uploads/abc.pdf",
  });

  assert.deepEqual(resolved, {
    safeFileName: "abc.pdf",
    absoluteFilePath: path.join(config.uploadsDir, "abc.pdf"),
  });
});

test("resolveStoredFilePath falls back to the basename of file_path", () => {
  const resolved = resolveStoredFilePath({
    stored_filename: "",
    file_path: "server/uploads/nested/legacy.pdf",
  });

  assert.equal(resolved.safeFileName, "legacy.pdf");
});

test("resolveStoredFilePath strips directory traversal from stored values", () => {
  const resolved = resolveStoredFilePath({
    stored_filename: "../../etc/passwd",
    file_path: "",
  });

  assert.equal(resolved.safeFileName, "passwd");
  assert.equal(resolved.absoluteFilePath, path.join(config.uploadsDir, "passwd"));
});

test("resolveStoredFilePath returns null when no filename reference exists", () => {
  assert.equal(resolveStoredFilePath({ stored_filename: "", file_path: "" }), null);
});

test("listDocuments paginates with limit/offset while countDocuments counts all", () => {
  db.exec("DELETE FROM documents");

  for (let index = 0; index < 5; index += 1) {
    insertNamedDocument(`paginated-${index}`);
  }

  assert.equal(countDocuments(), 5);

  // No options returns every document (backward compatible).
  assert.equal(listDocuments().length, 5);

  const firstPage = listDocuments({ limit: 2, offset: 0 });
  const secondPage = listDocuments({ limit: 2, offset: 2 });

  assert.equal(firstPage.length, 2);
  assert.equal(secondPage.length, 2);

  // Pages must not overlap.
  const firstIds = new Set(firstPage.map((doc) => doc.id));
  assert.ok(secondPage.every((doc) => !firstIds.has(doc.id)));
});

test("deleteDocument rolls back note unlinking and restores the file when the delete fails", async () => {
  const vehicle = db.prepare("SELECT id FROM vehicles ORDER BY id ASC LIMIT 1").get();

  const documentId = Number(
    db
      .prepare(`
        INSERT INTO documents (
          vehicle_id, title, original_filename, stored_filename, file_path,
          file_type, system, document_type, extraction_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        vehicle.id,
        "Delete me",
        "del.pdf",
        "del.pdf",
        "server/uploads/del.pdf",
        "application/pdf",
        "Engine",
        "Repair Manual",
        "completed"
      ).lastInsertRowid
  );

  // A note linked to the document; its link must survive a failed delete.
  const noteId = Number(
    db
      .prepare(`
        INSERT INTO notes (
          vehicle_id, document_id, content, note_type, related_entity_type, related_entity_id
        ) VALUES (?, ?, ?, 'general', 'document', ?)
      `)
      .run(vehicle.id, documentId, "Note about the doc", documentId).lastInsertRowid
  );

  const filePath = path.join(config.uploadsDir, "del.pdf");
  fs.writeFileSync(filePath, "PDF BYTES");

  const document = {
    id: documentId,
    stored_filename: "del.pdf",
    file_path: "server/uploads/del.pdf",
  };

  // Force the row delete to fail partway through the transaction.
  const originalPrepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    if (sql.includes("DELETE FROM documents")) {
      throw new Error("simulated delete failure");
    }
    return originalPrepare(sql);
  };

  try {
    await assert.rejects(() => deleteDocument(document), /simulated delete failure/);
  } finally {
    db.prepare = originalPrepare;
  }

  // The document row still exists.
  assert.ok(
    db.prepare("SELECT id FROM documents WHERE id = ?").get(documentId),
    "document row must remain after a failed delete"
  );

  // The note's link was rolled back, not committed separately.
  const note = db
    .prepare("SELECT related_entity_type, related_entity_id FROM notes WHERE id = ?")
    .get(noteId);
  assert.equal(note.related_entity_type, "document");
  assert.equal(note.related_entity_id, documentId);

  // The stored file was moved aside, then restored on failure.
  assert.ok(fs.existsSync(filePath), "stored file must be restored after a failed delete");
});
