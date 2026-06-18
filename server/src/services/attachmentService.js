// Image attachments for symptoms, procedures, and notes.
//
// Attachments are polymorphic: an (entity_type, entity_id) pair points at a
// symptom, procedure, or note. Like the note links, that pairing is NOT a
// foreign key, so the owning routes must call deleteAttachmentsForEntity on
// delete to clean up the rows and the files on disk.
//
// Documents stay PDF-only and untouched. Attachment images live in their own
// folder (uploadsDir/attachments/images) so a backup that copies uploadsDir
// captures them automatically. Uses node:sqlite via the shared db only.

import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { db } from "../database.js";
import { createStoredFilename } from "../utils/sanitizeFilename.js";

export const ATTACHMENT_ENTITY_TYPES = new Set([
  "symptom",
  "procedure",
  "note",
]);

export const ALLOWED_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export function isAllowedEntityType(entityType) {
  return ATTACHMENT_ENTITY_TYPES.has(entityType);
}

export function isAllowedImageMimeType(mimeType) {
  return ALLOWED_IMAGE_MIME_TYPES.has(mimeType);
}

/**
 * Absolute directory where attachment images are stored.
 *
 * Kept under uploadsDir so the existing backup/restore (which copies the whole
 * uploads tree) includes attachment images with no extra wiring.
 */
export function getAttachmentsImageDir() {
  return path.join(config.uploadsDir, "attachments", "images");
}

function assertEntityType(entityType) {
  if (!isAllowedEntityType(entityType)) {
    throw new Error(
      "Attachment entity type must be symptom, procedure, or note."
    );
  }
}

/**
 * Resolve the on-disk path for a stored attachment file.
 *
 * `path.basename` guards against directory traversal from the stored value, the
 * same way documentService.resolveStoredFilePath does.
 */
function resolveAttachmentPath(storedFilename) {
  const safeFileName = path.basename(storedFilename || "");

  if (!safeFileName) {
    return null;
  }

  return {
    safeFileName,
    absoluteFilePath: path.join(getAttachmentsImageDir(), safeFileName),
  };
}

function mapAttachmentRow(row) {
  return {
    id: row.id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    originalFilename: row.original_filename,
    storedFilename: row.stored_filename,
    filePath: row.file_path,
    mimeType: row.mime_type,
    fileSize: row.file_size,
    caption: row.caption || "",
    createdAt: row.created_at,
  };
}

export function getAttachmentById(attachmentId) {
  const row = db
    .prepare(
      `
      SELECT
        id,
        entity_type,
        entity_id,
        original_filename,
        stored_filename,
        file_path,
        mime_type,
        file_size,
        caption,
        created_at
      FROM attachments
      WHERE id = ?
    `
    )
    .get(attachmentId);

  return row ? mapAttachmentRow(row) : null;
}

export function listAttachments(entityType, entityId) {
  assertEntityType(entityType);

  const rows = db
    .prepare(
      `
      SELECT
        id,
        entity_type,
        entity_id,
        original_filename,
        stored_filename,
        file_path,
        mime_type,
        file_size,
        caption,
        created_at
      FROM attachments
      WHERE entity_type = ?
      AND entity_id = ?
      ORDER BY created_at ASC, id ASC
    `
    )
    .all(entityType, entityId);

  return rows.map((row) => mapAttachmentRow(row));
}

/**
 * Store an uploaded image and record it against an entity.
 *
 * Throws when the entity type is unknown or the mime type is not an allowed
 * image type. The file is written first, then the row is inserted; if the
 * insert fails the orphaned file is removed.
 */
export async function createAttachment({
  entityType,
  entityId,
  originalFilename,
  mimeType,
  buffer,
  caption = "",
}) {
  assertEntityType(entityType);

  if (!isAllowedImageMimeType(mimeType)) {
    throw new Error("Attachments must be a JPEG, PNG, or WebP image.");
  }

  const numericEntityId = Number(entityId);

  if (!Number.isInteger(numericEntityId) || numericEntityId <= 0) {
    throw new Error("Attachment entity ID must be a positive number.");
  }

  const storedFilename = createStoredFilename(originalFilename || "image");
  const imageDir = getAttachmentsImageDir();
  const absoluteFilePath = path.join(imageDir, storedFilename);
  const relativeFilePath =
    `server/uploads/attachments/images/${storedFilename}`.replace(/\\/g, "/");

  await fs.mkdir(imageDir, { recursive: true });
  await fs.writeFile(absoluteFilePath, buffer);

  try {
    const result = db
      .prepare(
        `
        INSERT INTO attachments (
          entity_type,
          entity_id,
          original_filename,
          stored_filename,
          file_path,
          mime_type,
          file_size,
          caption
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `
      )
      .run(
        entityType,
        numericEntityId,
        originalFilename || storedFilename,
        storedFilename,
        relativeFilePath,
        mimeType,
        buffer.length,
        caption || null
      );

    return getAttachmentById(Number(result.lastInsertRowid));
  } catch (error) {
    await fs.rm(absoluteFilePath, { force: true });
    throw error;
  }
}

/**
 * Delete one attachment by id, removing its row and stored file.
 *
 * Returns the deleted attachment, or null when no row matched.
 */
export async function deleteAttachment(attachmentId) {
  const existing = getAttachmentById(attachmentId);

  if (!existing) {
    return null;
  }

  db.prepare("DELETE FROM attachments WHERE id = ?").run(attachmentId);

  const resolved = resolveAttachmentPath(existing.storedFilename);

  if (resolved) {
    await fs.rm(resolved.absoluteFilePath, { force: true });
  }

  return existing;
}

/**
 * Delete every attachment for an entity, removing rows and stored files.
 *
 * Called from the symptom/procedure/note delete paths because the
 * (entity_type, entity_id) pairing is not a foreign key. Returns the number of
 * attachments removed.
 */
export async function deleteAttachmentsForEntity(entityType, entityId) {
  assertEntityType(entityType);

  const rows = db
    .prepare(
      "SELECT id, stored_filename FROM attachments WHERE entity_type = ? AND entity_id = ?"
    )
    .all(entityType, entityId);

  if (!rows.length) {
    return 0;
  }

  db.prepare(
    "DELETE FROM attachments WHERE entity_type = ? AND entity_id = ?"
  ).run(entityType, entityId);

  for (const row of rows) {
    const resolved = resolveAttachmentPath(row.stored_filename);

    if (resolved) {
      await fs.rm(resolved.absoluteFilePath, { force: true });
    }
  }

  return rows.length;
}
