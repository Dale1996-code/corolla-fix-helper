import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { db } from "../database.js";
import {
  getTagsForDocuments,
  listAllTags,
  pruneOrphanTags,
  setDocumentTags,
} from "./documentTagService.js";
import { rebuildDocumentChunksFromPages } from "./documentChunkService.js";
import { clearChunkEmbeddingCache } from "./chunkEmbeddingService.js";
import { extractPdfData } from "./pdfService.js";
import { getVehicleId } from "./vehicleService.js";
import {
  createStoredFilename,
  deriveTitleFromFilename,
} from "../utils/sanitizeFilename.js";

/**
 * Resolve the on-disk path for a document's stored file.
 *
 * Returns `{ safeFileName, absoluteFilePath }`, or `null` when the document has
 * no usable filename reference. `path.basename` guards against directory
 * traversal from the stored value.
 */
export function resolveStoredFilePath(document) {
  const fileName =
    document.stored_filename || path.basename(document.file_path || "");

  if (!fileName) {
    return null;
  }

  const safeFileName = path.basename(fileName);

  return {
    safeFileName,
    absoluteFilePath: path.join(config.uploadsDir, safeFileName),
  };
}

/**
 * Delete a document and everything that depends on it.
 *
 * Most child rows (chunks, symptom/procedure links, tag links) are removed by
 * `ON DELETE CASCADE`; the polymorphic note links are not foreign keys, so they
 * are cleared explicitly here. Returns the cleanup counts the API surfaces.
 *
 * `document` must include `id`, `stored_filename`, and `file_path`.
 */
export async function deleteDocument(document) {
  const documentId = document.id;

  const linkedCounts = db
    .prepare(`
      SELECT
        (SELECT COUNT(*) FROM symptom_documents WHERE document_id = ?) AS symptom_count,
        (SELECT COUNT(*) FROM procedure_documents WHERE document_id = ?) AS procedure_count,
        (SELECT COUNT(*) FROM notes WHERE related_entity_type = 'document' AND related_entity_id = ?) AS note_count
    `)
    .get(documentId, documentId, documentId);

  const resolved = resolveStoredFilePath(document);

  // Move the stored PDF aside before touching the database so the row delete and
  // file removal are all-or-nothing: if the DB work fails we restore the file,
  // and we only remove it for good once the row is committed gone.
  let movedAside = null;
  if (resolved) {
    const trashPath = `${resolved.absoluteFilePath}.trash-${documentId}-${process.pid}`;

    try {
      await fs.rename(resolved.absoluteFilePath, trashPath);
      movedAside = trashPath;
    } catch (error) {
      // Nothing to move if the file is already gone; rethrow anything else.
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }

  try {
    db.exec("BEGIN IMMEDIATE TRANSACTION");

    db.prepare(`
      UPDATE notes
      SET related_entity_type = 'none',
          related_entity_id = NULL,
          document_id = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE related_entity_type = 'document' AND related_entity_id = ?
    `).run(documentId);

    db.prepare("DELETE FROM documents WHERE id = ?").run(documentId);
    pruneOrphanTags();

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");

    // Restore the file we moved aside so the row and its PDF stay consistent.
    if (movedAside) {
      await fs.rename(movedAside, resolved.absoluteFilePath);
    }

    throw error;
  }

  if (movedAside) {
    await fs.rm(movedAside, { force: true });
  }

  // The in-memory embedding cache still holds this document's chunks; drop it so
  // deleted PDF text can no longer be retrieved, cited, or sent to OpenAI.
  clearChunkEmbeddingCache();

  return {
    symptomLinksRemoved: linkedCounts.symptom_count,
    procedureLinksRemoved: linkedCounts.procedure_count,
    noteLinksCleared: linkedCounts.note_count,
    fileRemoved: Boolean(resolved),
  };
}

function mapDocumentRow(row, tags = []) {
  return {
    id: row.id,
    title: row.title,
    originalFilename: row.original_filename,
    storedFilename: row.stored_filename,
    filePath: row.file_path,
    fileType: row.file_type,
    system: row.system,
    subsystem: row.subsystem || "",
    documentType: row.document_type,
    source: row.source || "",
    notes: row.notes || "",
    extractionStatus: row.extraction_status,
    pageCount: row.page_count,
    isFavorite: Boolean(row.is_favorite),
    isBookmarked: Boolean(row.is_bookmarked),
    tags,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    vehicleLabel: `${row.year} ${row.make} ${row.model} ${row.trim}`,
  };
}

function attachTags(rows, mapRow) {
  const tagsByDocument = getTagsForDocuments(rows.map((row) => row.id));
  return rows.map((row) => mapRow(row, tagsByDocument.get(row.id) || []));
}

function getDocumentBaseQuery() {
  return `
    SELECT
      documents.id,
      documents.title,
      documents.original_filename,
      documents.stored_filename,
      documents.file_path,
      documents.file_type,
      documents.system,
      documents.subsystem,
      documents.document_type,
      documents.source,
      documents.notes,
      documents.extraction_status,
      documents.page_count,
      documents.is_favorite,
      documents.is_bookmarked,
      documents.created_at,
      documents.updated_at,
      vehicles.year,
      vehicles.make,
      vehicles.model,
      vehicles.trim
    FROM documents
    JOIN vehicles ON vehicles.id = documents.vehicle_id
  `;
}

export function countDocuments() {
  return Number(
    db.prepare("SELECT COUNT(*) AS count FROM documents").get().count
  );
}

// Document ids that have at least one chunk not embedded at the current version
// (never embedded, or embedded under an older model/dimension). Used to show an
// "embedding pending" hint: such documents are still findable by keyword, but
// have not yet gained semantic ranking.
function getPendingEmbeddingDocumentIds() {
  const rows = db
    .prepare(`
      SELECT DISTINCT document_id
      FROM document_chunks
      WHERE COALESCE(embedding_version, '') <> ?
    `)
    .all(config.openAiEmbeddingVersion);

  return new Set(rows.map((row) => row.document_id));
}

/**
 * List documents, newest first.
 *
 * With no options every document is returned (backward compatible). Pass a
 * positive `limit` (and optional `offset`) to page through large libraries.
 */
export function listDocuments({ limit = null, offset = 0 } = {}) {
  const hasLimit = Number.isInteger(limit) && limit > 0;
  const safeOffset = Number.isInteger(offset) && offset > 0 ? offset : 0;

  const rows = db
    .prepare(`
      ${getDocumentBaseQuery()}
      ORDER BY documents.created_at DESC, documents.id DESC
      ${hasLimit ? "LIMIT ? OFFSET ?" : ""}
    `)
    .all(...(hasLimit ? [limit, safeOffset] : []));

  const documents = attachTags(rows, (row, tags) => mapDocumentRow(row, tags));
  const pendingIds = getPendingEmbeddingDocumentIds();

  return documents.map((document) => ({
    ...document,
    embeddingPending: pendingIds.has(document.id),
  }));
}

export function getDocumentFilterOptions() {
  const systems = db
    .prepare(`
      SELECT DISTINCT system
      FROM documents
      WHERE system IS NOT NULL AND TRIM(system) <> ''
      ORDER BY system COLLATE NOCASE ASC
    `)
    .all()
    .map((row) => row.system);

  const documentTypes = db
    .prepare(`
      SELECT DISTINCT document_type
      FROM documents
      WHERE document_type IS NOT NULL AND TRIM(document_type) <> ''
      ORDER BY document_type COLLATE NOCASE ASC
    `)
    .all()
    .map((row) => row.document_type);

  return {
    systems,
    documentTypes,
    tags: listAllTags(),
  };
}

function buildSnippet(text, query) {
  const cleanText = typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";

  if (!cleanText) {
    return "";
  }

  if (!query) {
    return cleanText.length > 180 ? `${cleanText.slice(0, 177)}...` : cleanText;
  }

  const loweredText = cleanText.toLowerCase();
  const loweredQuery = query.toLowerCase();
  const matchIndex = loweredText.indexOf(loweredQuery);

  if (matchIndex === -1) {
    return cleanText.length > 180 ? `${cleanText.slice(0, 177)}...` : cleanText;
  }

  const snippetRadius = 80;
  const start = Math.max(0, matchIndex - snippetRadius);
  const end = Math.min(cleanText.length, matchIndex + loweredQuery.length + snippetRadius);
  const snippet = cleanText.slice(start, end).trim();
  const prefix = start > 0 ? "..." : "";
  const suffix = end < cleanText.length ? "..." : "";

  return `${prefix}${snippet}${suffix}`;
}

function buildMatchSnippet(row, query) {
  const fieldsInPriorityOrder = [
    { label: "Title", value: row.title || "" },
    { label: "Filename", value: row.original_filename || "" },
    { label: "Notes", value: row.notes || "" },
    { label: "Extracted text", value: row.extracted_text || "" },
  ];

  if (!query) {
    const previewField =
      fieldsInPriorityOrder.find(
        (field) => field.label === "Notes" && field.value.trim()
      ) ||
      fieldsInPriorityOrder.find(
        (field) => field.label === "Extracted text" && field.value.trim()
      ) ||
      fieldsInPriorityOrder.find(
        (field) => field.label === "Filename" && field.value.trim()
      ) ||
      fieldsInPriorityOrder.find((field) => field.value.trim());

    return {
      snippet: previewField ? buildSnippet(previewField.value, "") : "",
      snippetField: previewField ? previewField.label : "",
    };
  }

  const loweredQuery = query.toLowerCase();
  const matchingField = fieldsInPriorityOrder.find((field) =>
    field.value.toLowerCase().includes(loweredQuery)
  );

  if (!matchingField) {
    return {
      snippet: "",
      snippetField: "",
    };
  }

  return {
    snippet: buildSnippet(matchingField.value, query),
    snippetField: matchingField.label,
  };
}

function mapSearchResultRow(row, query, tags) {
  const baseDocument = mapDocumentRow(row, tags);
  const matchSnippet = buildMatchSnippet(row, query);

  return {
    ...baseDocument,
    relevanceScore: row.relevance_score,
    snippet: matchSnippet.snippet,
    snippetField: matchSnippet.snippetField,
  };
}

export function searchDocuments({
  query = "",
  system = "",
  documentType = "",
  favorite = "",
  bookmarked = "",
  tag = "",
  sort = "relevance",
}) {
  const trimmedQuery = query.trim();
  const loweredQuery = trimmedQuery.toLowerCase();
  const searchPattern = `%${loweredQuery}%`;
  const whereClauses = [];
  const params = [];

  const relevanceSql = trimmedQuery
    ? `
      (
        CASE
          WHEN lower(documents.title) = ? THEN 900
          WHEN lower(documents.title) LIKE ? THEN 400
          ELSE 0
        END
        + CASE
          WHEN lower(documents.original_filename) = ? THEN 700
          WHEN lower(documents.original_filename) LIKE ? THEN 300
          ELSE 0
        END
        + CASE
          WHEN lower(COALESCE(documents.notes, '')) LIKE ? THEN 200
          ELSE 0
        END
        + CASE
          WHEN lower(COALESCE(documents.extracted_text, '')) LIKE ? THEN 100
          ELSE 0
        END
        + CASE
          WHEN EXISTS (
            SELECT 1
            FROM document_tags
            JOIN tags ON tags.id = document_tags.tag_id
            WHERE document_tags.document_id = documents.id
              AND lower(tags.name) LIKE ?
          ) THEN 250
          ELSE 0
        END
      )
    `
    : "0";

  if (trimmedQuery) {
    params.push(
      loweredQuery,
      searchPattern,
      loweredQuery,
      searchPattern,
      searchPattern,
      searchPattern,
      searchPattern
    );

    whereClauses.push(`(
      lower(documents.title) LIKE ?
      OR lower(documents.original_filename) LIKE ?
      OR lower(COALESCE(documents.notes, '')) LIKE ?
      OR lower(COALESCE(documents.extracted_text, '')) LIKE ?
      OR EXISTS (
        SELECT 1
        FROM document_tags
        JOIN tags ON tags.id = document_tags.tag_id
        WHERE document_tags.document_id = documents.id
          AND lower(tags.name) LIKE ?
      )
    )`);

    params.push(searchPattern, searchPattern, searchPattern, searchPattern, searchPattern);
  }

  if (system) {
    whereClauses.push("documents.system = ?");
    params.push(system);
  }

  if (documentType) {
    whereClauses.push("documents.document_type = ?");
    params.push(documentType);
  }

  if (favorite === "true") {
    whereClauses.push("documents.is_favorite = 1");
  }

  if (bookmarked === "true") {
    whereClauses.push("documents.is_bookmarked = 1");
  }

  const trimmedTag = typeof tag === "string" ? tag.trim() : "";

  if (trimmedTag) {
    whereClauses.push(`EXISTS (
      SELECT 1
      FROM document_tags
      JOIN tags ON tags.id = document_tags.tag_id
      WHERE document_tags.document_id = documents.id
        AND tags.name = ? COLLATE NOCASE
    )`);
    params.push(trimmedTag);
  }

  const whereSql = whereClauses.length ? `WHERE ${whereClauses.join(" AND ")}` : "";

  const sortSql = {
    relevance: trimmedQuery
      ? "ORDER BY relevance_score DESC, documents.created_at DESC, documents.id DESC"
      : "ORDER BY documents.created_at DESC, documents.id DESC",
    newest: "ORDER BY documents.created_at DESC, documents.id DESC",
    title: "ORDER BY documents.title COLLATE NOCASE ASC, documents.created_at DESC",
  }[sort] || "ORDER BY documents.created_at DESC, documents.id DESC";

  const rows = db
    .prepare(`
      SELECT
        documents.id,
        documents.title,
        documents.original_filename,
        documents.stored_filename,
        documents.file_path,
        documents.file_type,
        documents.system,
        documents.subsystem,
        documents.document_type,
        documents.source,
        documents.notes,
        documents.extracted_text,
        documents.extraction_status,
        documents.page_count,
        documents.is_favorite,
        documents.is_bookmarked,
        documents.created_at,
        documents.updated_at,
        vehicles.year,
        vehicles.make,
        vehicles.model,
        vehicles.trim,
        ${relevanceSql} AS relevance_score
      FROM documents
      JOIN vehicles ON vehicles.id = documents.vehicle_id
      ${whereSql}
      ${sortSql}
    `)
    .all(...params);

  return attachTags(rows, (row, tags) =>
    mapSearchResultRow(row, trimmedQuery, tags)
  );
}

// True when the document has at least one chunk not embedded at the current
// version. Targeted single-document form of getPendingEmbeddingDocumentIds, so
// getDocument does not have to scan every chunk in the library.
function documentHasPendingEmbedding(documentId) {
  const row = db
    .prepare(`
      SELECT 1
      FROM document_chunks
      WHERE document_id = ?
        AND COALESCE(embedding_version, '') <> ?
      LIMIT 1
    `)
    .get(documentId, config.openAiEmbeddingVersion);

  return Boolean(row);
}

// A single mapped document, or undefined when it does not exist. Uses a direct
// `WHERE id = ?` lookup (not a whole-library scan) but returns the same shape as
// the list view: tags attached and the embedding-pending flag set.
export function getDocument(documentId) {
  const row = db
    .prepare(`${getDocumentBaseQuery()} WHERE documents.id = ?`)
    .get(documentId);

  if (!row) {
    return undefined;
  }

  const [document] = attachTags([row], (tagRow, tags) => mapDocumentRow(tagRow, tags));

  return {
    ...document,
    embeddingPending: documentHasPendingEmbedding(documentId),
  };
}

// Minimal row for serving a document's stored file (download/inline view).
export function getDocumentFileRecord(documentId) {
  return db
    .prepare(`
      SELECT
        id,
        original_filename,
        stored_filename,
        file_path,
        file_type
      FROM documents
      WHERE id = ?
    `)
    .get(documentId);
}

// Minimal row for locating a document's stored file on disk, used by the
// re-extract and delete flows. Returns undefined when the document is missing.
export function getDocumentFileLocation(documentId) {
  return db
    .prepare(`
      SELECT id, stored_filename, file_path
      FROM documents
      WHERE id = ?
    `)
    .get(documentId);
}

// Raw metadata row (snake_case) for the partial-update merge in the route.
// Returns undefined when the document does not exist.
export function getDocumentMetadataRecord(documentId) {
  return db
    .prepare(`
      SELECT
        id,
        title,
        system,
        subsystem,
        document_type,
        source,
        notes,
        is_favorite,
        is_bookmarked
      FROM documents
      WHERE id = ?
    `)
    .get(documentId);
}

// Persist an uploaded PDF: derive its stored path, write the file, extract its
// text/pages, insert the row, rebuild chunks, and set tags — returning the
// freshly mapped document. On any failure the written file and (if it was
// created) the row + chunks are cleaned up before the error is rethrown, so a
// failed upload never leaves an orphan file or half-inserted document. Fields
// are already parsed/normalized by the caller.
export async function createDocument({
  fileBuffer,
  originalFilename,
  mimetype,
  titleInput,
  system,
  subsystem,
  documentType,
  source,
  notes,
  isBookmarked,
  tags,
  hasTags,
}) {
  const storedFilename = createStoredFilename(originalFilename);
  const absoluteFilePath = path.join(config.uploadsDir, storedFilename);
  const relativeFilePath = `server/uploads/${storedFilename}`.replace(/\\/g, "/");
  const fileType =
    path.extname(originalFilename).toLowerCase() === ".pdf"
      ? "application/pdf"
      : mimetype || "application/octet-stream";
  const title = titleInput || deriveTitleFromFilename(originalFilename);

  let createdDocumentId = null;

  try {
    await fs.writeFile(absoluteFilePath, fileBuffer);

    const extractionResult = await extractPdfData(fileBuffer);
    const vehicleId = getVehicleId();

    const result = db
      .prepare(`
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
          extracted_text,
          extraction_status,
          page_count,
          notes,
          is_favorite,
          is_bookmarked
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        vehicleId,
        title,
        originalFilename,
        storedFilename,
        relativeFilePath,
        fileType,
        system,
        subsystem,
        documentType,
        source,
        extractionResult.extractedText,
        extractionResult.extractionStatus,
        extractionResult.pageCount,
        notes,
        0,
        isBookmarked ? 1 : 0
      );

    const newDocumentId = Number(result.lastInsertRowid);
    createdDocumentId = newDocumentId;
    rebuildDocumentChunksFromPages(newDocumentId, extractionResult.pages);

    if (hasTags) {
      setDocumentTags(newDocumentId, tags);
    }

    return getDocument(newDocumentId);
  } catch (error) {
    await fs.rm(absoluteFilePath, { force: true });

    if (createdDocumentId) {
      try {
        db.prepare("DELETE FROM document_chunks WHERE document_id = ?").run(createdDocumentId);
        db.prepare("DELETE FROM documents WHERE id = ?").run(createdDocumentId);
      } catch {
        // Best-effort cleanup; surface the original create error to the caller.
      }
    }

    throw error;
  }
}

// Re-run extraction for an existing document from its stored bytes: refresh the
// extracted text/status/page count and rebuild its chunks, returning the freshly
// mapped document.
export async function reextractDocument(documentId, fileBuffer) {
  const extractionResult = await extractPdfData(fileBuffer);

  db.prepare(`
    UPDATE documents
    SET
      extracted_text = ?,
      extraction_status = ?,
      page_count = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    extractionResult.extractedText,
    extractionResult.extractionStatus,
    extractionResult.pageCount,
    documentId
  );

  rebuildDocumentChunksFromPages(documentId, extractionResult.pages);

  return getDocument(documentId);
}

// Update an existing document's editable metadata (fields already merged +
// normalized by the caller). Tag replacement is a separate, caller-driven step.
export function updateDocumentMetadata(documentId, fields) {
  db.prepare(`
    UPDATE documents
    SET
      title = ?,
      system = ?,
      subsystem = ?,
      document_type = ?,
      source = ?,
      notes = ?,
      is_favorite = ?,
      is_bookmarked = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    fields.title,
    fields.system,
    fields.subsystem,
    fields.documentType,
    fields.source,
    fields.notes,
    fields.isFavorite ? 1 : 0,
    fields.isBookmarked ? 1 : 0,
    documentId
  );

  // The cache carries per-chunk document title/system copied at load time; drop
  // it so retrieval citations reflect the updated metadata instead of stale values.
  clearChunkEmbeddingCache();
}
