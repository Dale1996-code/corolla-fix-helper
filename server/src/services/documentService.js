import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { db } from "../database.js";
import {
  getTagsForDocuments,
  listAllTags,
  pruneOrphanTags,
} from "./documentTagService.js";

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

  if (resolved) {
    await fs.rm(resolved.absoluteFilePath, { force: true });
  }

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
    extractedText: row.extracted_text || "",
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
      vehicles.trim
    FROM documents
    JOIN vehicles ON vehicles.id = documents.vehicle_id
  `;
}

export function listDocuments() {
  const rows = db
    .prepare(`
      ${getDocumentBaseQuery()}
      ORDER BY documents.created_at DESC, documents.id DESC
    `)
    .all();

  return attachTags(rows, (row, tags) => mapDocumentRow(row, tags));
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
