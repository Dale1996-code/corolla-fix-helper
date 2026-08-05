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
const {
  resolveStoredFilePath,
  deleteDocument,
  isDocumentFileAvailable,
  listDocuments,
  countDocuments,
} = await import("../src/services/documentService.js");

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

// Ask source cards offer an "open the PDF" action only when this says yes, so
// it has to answer the same way GET /api/documents/:id/file would.
test("isDocumentFileAvailable is true only when the stored PDF is on disk", () => {
  const documentId = insertNamedDocument("available-source");

  // Row exists, file does not: the file route would answer 404.
  assert.equal(isDocumentFileAvailable(documentId), false);

  fs.writeFileSync(path.join(config.uploadsDir, "available-source.pdf"), "%PDF-1.4\n");

  assert.equal(isDocumentFileAvailable(documentId), true);
});

test("isDocumentFileAvailable is false for a missing or malformed document id", () => {
  const documentId = insertNamedDocument("deleted-source");
  db.prepare("DELETE FROM documents WHERE id = ?").run(documentId);

  assert.equal(isDocumentFileAvailable(documentId), false);

  for (const badId of [0, -1, 1.5, "1", null, undefined, true, {}]) {
    assert.equal(isDocumentFileAvailable(/** @type {any} */ (badId)), false);
  }
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

test("listDocuments flags documents whose chunks still need embeddings", () => {
  db.exec("DELETE FROM document_chunks");
  db.exec("DELETE FROM documents");

  const pendingId = insertNamedDocument("pending-embed");
  const readyId = insertNamedDocument("ready-embed");

  // Pending: a chunk with no embedding yet.
  db.prepare(`
    INSERT INTO document_chunks (document_id, page_number, chunk_index, chunk_text)
    VALUES (?, 1, 0, ?)
  `).run(pendingId, "oil filter 2009 Corolla");

  // Ready: a chunk already embedded at the current version.
  db.prepare(`
    INSERT INTO document_chunks
      (document_id, page_number, chunk_index, chunk_text, embedding, embedding_version)
    VALUES (?, 1, 0, ?, ?, ?)
  `).run(readyId, "spark plug gap", Buffer.from([1, 2, 3, 4]), config.openAiEmbeddingVersion);

  const documents = listDocuments();
  const pending = documents.find((doc) => doc.id === pendingId);
  const ready = documents.find((doc) => doc.id === readyId);

  assert.equal(pending.embeddingPending, true);
  assert.equal(ready.embeddingPending, false);
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
