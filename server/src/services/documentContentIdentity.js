import { createHash } from "node:crypto";
import { db } from "../database.js";

// Content identity for a document: "which documents hold the same text?"
//
// This exists because retrieval diversity has to treat exact duplicates as ONE
// logical source, and no existing signal could do that job:
//
//   - `documents.file_md5` identifies the FILE, and it carries a unique index,
//     so duplicate-content documents necessarily have different md5s. Measured
//     on the real library: #835/#836/#837 hold byte-identical extracted text
//     under three different md5s. File dedup is structurally blind to this.
//   - Titles are OCR-derived and truncate differently per copy, so they differ
//     across a duplicate group.
//   - There is no document-relationship table, and building fuzzy similarity or
//     clustering would be a subsystem, not a safeguard.
//
// `documents.extracted_text` is already stored, is already the thing retrieval
// reasons about, and answers the question exactly. Measured: 310 of 1,443
// documents fall into 130 exact-duplicate-text groups, the largest holding 19
// documents. Grouping is by EXACT normalized equality -- no similarity, no
// thresholds, no near-duplicate judgment.
//
// A document with no extracted text is its own source. Falling back to the
// document id keeps unrelated empty-text documents from collapsing into one.

// documentId -> { updatedAt, key }.
//
// Bounded by the document count (a few hundred bytes per document), so it needs
// no eviction. Two independent guards keep it honest: `updated_at` is stamped by
// persistExtractionResult on every text write, and documentChunkService clears
// this cache wherever it clears the embedding cache. Either alone would do; both
// cost nothing.
const contentGroupCache = new Map();

export function clearDocumentContentIdentityCache() {
  contentGroupCache.clear();
}

function normalizeDocumentText(text) {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Stable key naming the logical source a document belongs to.
 *
 * Documents whose extracted text is identical share one key. Reading the text is
 * the expensive part (one document in the real library is 4.5 MB), so the cache
 * is checked against a cheap `updated_at` probe first and the text is only read
 * when the document has actually changed.
 *
 * @param {number|string} documentId
 * @returns {string}
 */
export function getDocumentContentGroupKey(documentId) {
  const numericId = Number(documentId);
  const fallbackKey = `document:${documentId}`;

  if (!Number.isInteger(numericId) || numericId <= 0) {
    return fallbackKey;
  }

  const stamp = db
    .prepare(`
      SELECT updated_at
      FROM documents
      WHERE id = ?
    `)
    .get(numericId);

  if (!stamp) {
    return fallbackKey;
  }

  const cached = contentGroupCache.get(numericId);

  if (cached && cached.updatedAt === stamp.updated_at) {
    return cached.key;
  }

  const row = db
    .prepare(`
      SELECT extracted_text
      FROM documents
      WHERE id = ?
    `)
    .get(numericId);

  const normalizedText = normalizeDocumentText(row?.extracted_text);
  const key = normalizedText
    ? `text:${createHash("sha256").update(normalizedText).digest("hex")}`
    : `document:${numericId}`;

  contentGroupCache.set(numericId, { updatedAt: stamp.updated_at, key });

  return key;
}
