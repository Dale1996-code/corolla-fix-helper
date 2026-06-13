import { db } from "../database.js";

const MAX_TAG_LENGTH = 40;
const MAX_TAGS_PER_DOCUMENT = 25;

/**
 * Normalize freeform tag input (an array of strings, or a single
 * comma-separated string) into a clean, de-duplicated list of tag names.
 *
 * Rules: trim whitespace, drop a leading "#", collapse inner whitespace,
 * drop empties, cap each tag length, and de-duplicate case-insensitively
 * while preserving the first spelling the user provided.
 */
export function normalizeTagInput(input) {
  const rawValues = Array.isArray(input)
    ? input
    : typeof input === "string"
      ? input.split(",")
      : [];

  const seen = new Set();
  const tags = [];

  for (const rawValue of rawValues) {
    if (typeof rawValue !== "string") {
      continue;
    }

    const cleaned = rawValue
      .replace(/^#+/, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_TAG_LENGTH);

    if (!cleaned) {
      continue;
    }

    const dedupeKey = cleaned.toLowerCase();

    if (seen.has(dedupeKey)) {
      continue;
    }

    seen.add(dedupeKey);
    tags.push(cleaned);

    if (tags.length >= MAX_TAGS_PER_DOCUMENT) {
      break;
    }
  }

  return tags;
}

function getOrCreateTagId(name) {
  const existing = db
    .prepare("SELECT id FROM tags WHERE name = ? COLLATE NOCASE")
    .get(name);

  if (existing) {
    return existing.id;
  }

  const result = db.prepare("INSERT INTO tags (name) VALUES (?)").run(name);
  return Number(result.lastInsertRowid);
}

/** Remove tag rows that are no longer linked to any document. */
export function pruneOrphanTags() {
  db.prepare(`
    DELETE FROM tags
    WHERE id NOT IN (SELECT DISTINCT tag_id FROM document_tags)
  `).run();
}

/**
 * Replace the full tag set for one document. Creates any new tag rows,
 * links them, and prunes tags that are no longer referenced.
 */
export function setDocumentTags(documentId, input) {
  const tagNames = normalizeTagInput(input);

  db.exec("BEGIN IMMEDIATE TRANSACTION");

  try {
    db.prepare("DELETE FROM document_tags WHERE document_id = ?").run(documentId);

    const linkTag = db.prepare(
      "INSERT OR IGNORE INTO document_tags (document_id, tag_id) VALUES (?, ?)"
    );

    for (const name of tagNames) {
      linkTag.run(documentId, getOrCreateTagId(name));
    }

    pruneOrphanTags();
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  return tagNames;
}

/**
 * Return a Map of documentId -> ordered tag-name array for the given ids.
 * Documents with no tags are omitted from the map.
 */
export function getTagsForDocuments(documentIds) {
  const tagsByDocument = new Map();

  if (!Array.isArray(documentIds) || documentIds.length === 0) {
    return tagsByDocument;
  }

  const uniqueIds = Array.from(new Set(documentIds.filter((id) => Number.isInteger(id))));

  if (uniqueIds.length === 0) {
    return tagsByDocument;
  }

  const placeholders = uniqueIds.map(() => "?").join(", ");
  const rows = db
    .prepare(`
      SELECT document_tags.document_id AS document_id, tags.name AS name
      FROM document_tags
      JOIN tags ON tags.id = document_tags.tag_id
      WHERE document_tags.document_id IN (${placeholders})
      ORDER BY tags.name COLLATE NOCASE ASC
    `)
    .all(...uniqueIds);

  for (const row of rows) {
    const current = tagsByDocument.get(row.document_id) || [];
    current.push(row.name);
    tagsByDocument.set(row.document_id, current);
  }

  return tagsByDocument;
}

/** Return the tags for a single document as an ordered array of names. */
export function getTagsForDocument(documentId) {
  return getTagsForDocuments([documentId]).get(documentId) || [];
}

/** Return every distinct tag name in use, sorted alphabetically. */
export function listAllTags() {
  return db
    .prepare(`
      SELECT DISTINCT tags.name AS name
      FROM tags
      JOIN document_tags ON document_tags.tag_id = tags.id
      ORDER BY tags.name COLLATE NOCASE ASC
    `)
    .all()
    .map((row) => row.name);
}
