// Core of `npm run backfill:applicability` (N5 P2, docs/n5-applicability-design.md §7).
//
// Fills document_chunks.scope_at_start / scope_version for chunks stored before
// the chunk rebuild computed them, or under older tagger rules. New chunks get
// their scope from the rebuild itself; this is for the library already saved.
//
// OFFLINE. It reads only stored chunks: no PDF, no model, no network. A page's
// text is rebuilt from its chunks exactly as diagnose:applicability does, so
// the scope stored here is the one the rebuild stores for the same pages.
//
// SAFE TO RE-RUN. With `apply: false` (the default) nothing is written. With
// `apply: true` each document is written in its own transaction, so an
// interrupted run leaves every document either fully tagged or untouched, and
// the next run picks up the documents still to do. Only the two scope columns
// are written, by chunk id: chunk text, embeddings, and embedding versions are
// never touched, so nothing needs re-embedding.
//
// FAIL CLOSED. A document is left as it was, and reported, when its stored
// chunks do not follow the chunker's 200/40 word window (the first word of each
// chunk could not be placed), when the tagger throws, or when it was rebuilt
// between this run's read and its write. A NULL scope means "not computed",
// never "applies".

import {
  CHUNK_WORD_OVERLAP,
  CHUNK_WORD_SIZE,
  normalizeChunkWords,
  reconstructPageWords,
} from "./chunkGeometry.js";
import { CHUNK_SCOPE_VERSION, chunkScopeKey, computeChunkScopeColumns } from "./chunkScopePersistence.js";

class ChangedDuringRun extends Error {}

/** @param {import("node:sqlite").DatabaseSync} db */
function hasScopeColumns(db) {
  const names = db
    .prepare("PRAGMA table_info(document_chunks)")
    .all()
    .map((column) => column.name);
  return names.includes("scope_at_start") && names.includes("scope_version");
}

/**
 * Whether one page's stored chunks are exactly what the chunker cuts: chunk
 * indexes 0, 1, 2, ... with none missing; every chunk but the last 200 words;
 * each next chunk opening with the 40 words the one before ends on. Only then
 * can the page be rebuilt and each chunk's first word be placed. (A page held
 * in a single chunk always can.)
 *
 * @param {Array<{ chunkIndex: number, chunkText: string }>} chunks in chunk order
 */
export function followsChunkWindow(chunks) {
  const words = chunks.map((chunk) => normalizeChunkWords(chunk.chunkText));

  return chunks.every((chunk, index) => {
    if (chunk.chunkIndex !== index || words[index].length === 0) {
      return false;
    }
    if (chunks.length === 1) {
      return true;
    }
    if (index === chunks.length - 1) {
      return words[index].length > CHUNK_WORD_OVERLAP && words[index].length <= CHUNK_WORD_SIZE;
    }
    if (words[index].length !== CHUNK_WORD_SIZE) {
      return false;
    }
    const tail = words[index].slice(CHUNK_WORD_SIZE - CHUNK_WORD_OVERLAP);
    const head = words[index + 1].slice(0, CHUNK_WORD_OVERLAP);
    return tail.every((word, position) => word === head[position]);
  });
}

/**
 * Rebuild a document's pages from its stored chunks, or null when a page's
 * chunks do not follow the chunk window.
 *
 * @param {Array<Record<string, unknown>>} rows page_number, chunk_index, chunk_text; ordered by page, chunk
 */
function pagesFromStoredChunks(rows) {
  /** @type {Map<number, Array<{ chunkIndex: number, chunkText: string }>>} */
  const byPage = new Map();
  for (const row of rows) {
    const pageNumber = Number(row.page_number);
    if (!byPage.has(pageNumber)) {
      byPage.set(pageNumber, []);
    }
    byPage.get(pageNumber)?.push({ chunkIndex: Number(row.chunk_index), chunkText: String(row.chunk_text) });
  }

  const pages = [];
  for (const [pageNumber, chunks] of byPage) {
    if (!followsChunkWindow(chunks)) {
      return null;
    }
    pages.push({
      pageNumber,
      text: reconstructPageWords(chunks.map((chunk) => chunk.chunkText)).join(" "),
    });
  }
  return pages;
}

/** The engine a stored scope opens under, as a report label. */
function engineLabel(scopeJson) {
  const engine = JSON.parse(scopeJson).engine;
  if (!engine) {
    return "not stated";
  }
  if (engine.unresolved) {
    return "unresolved";
  }
  return engine.exclude ? `not ${engine.value}` : engine.value;
}

/**
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {{
 *   apply?: boolean,
 *   withTransaction?: <T>(fn: () => T) => T,
 *   documentId?: number,
 *   limit?: number,
 *   computeScopeColumns?: typeof computeChunkScopeColumns,
 * }} [options] `withTransaction` must wrap the same connection as `db`; it is
 *   required with `apply: true` and unused without it.
 */
export function runApplicabilityBackfill(
  db,
  { apply = false, withTransaction, documentId = 0, limit = 0, computeScopeColumns = computeChunkScopeColumns } = {}
) {
  if (apply && typeof withTransaction !== "function") {
    throw new TypeError("runApplicabilityBackfill needs withTransaction to apply.");
  }
  const columnsExist = hasScopeColumns(db);
  if (apply && !columnsExist) {
    throw new Error(
      "document_chunks has no scope columns: migration 008 has not run on this database. Start the app once, or run with --apply through the CLI, which applies it first."
    );
  }

  const countCurrent = () =>
    columnsExist
      ? Number(
          db
            .prepare(
              "SELECT COUNT(*) AS c FROM document_chunks WHERE scope_version = ? AND scope_at_start IS NOT NULL"
            )
            .get(CHUNK_SCOPE_VERSION).c
        )
      : 0;
  const listPending = () =>
    (columnsExist
      ? db
          .prepare(
            `SELECT DISTINCT document_id FROM document_chunks
             WHERE scope_version IS NULL OR scope_version <> ? OR scope_at_start IS NULL
             ORDER BY document_id`
          )
          .all(CHUNK_SCOPE_VERSION)
      : db.prepare("SELECT DISTINCT document_id FROM document_chunks ORDER BY document_id").all()
    ).map((row) => Number(row.document_id));

  const totalChunks = Number(db.prepare("SELECT COUNT(*) AS c FROM document_chunks").get().c);
  const currentBefore = countCurrent();
  const allPending = listPending();
  const pending = allPending.filter((id) => !documentId || id === documentId);
  const selected = limit > 0 ? pending.slice(0, limit) : pending;

  const readChunks = db.prepare(`
    SELECT id, page_number, chunk_index, chunk_text
    FROM document_chunks
    WHERE document_id = ?
    ORDER BY page_number, chunk_index
  `);
  const update = apply
    ? db.prepare("UPDATE document_chunks SET scope_at_start = ?, scope_version = ? WHERE id = ?")
    : null;

  const summary = {
    applied: apply,
    scopeVersion: CHUNK_SCOPE_VERSION,
    migrationPending: !columnsExist,
    totalChunks,
    currentBefore,
    documentsToTag: selected.length,
    chunksToTag: 0,
    taggedDocuments: 0,
    taggedChunks: 0,
    /** @type {number | null} */
    currentAfter: null,
    // Documents in the whole library still to tag (after this run, when applied).
    remainingDocuments: allPending.length,
    /** @type {Record<string, number>} */
    engineAtStart: {},
    skipped: {
      /** @type {number[]} */ window_mismatch: [],
      /** @type {number[]} */ tagger_failed: [],
      /** @type {number[]} */ changed_during_run: [],
    },
  };

  for (const id of selected) {
    const rows = readChunks.all(id);
    const pages = pagesFromStoredChunks(rows);
    if (!pages) {
      summary.skipped.window_mismatch.push(id);
      continue;
    }

    let columns;
    try {
      columns = computeScopeColumns(pages);
    } catch {
      summary.skipped.tagger_failed.push(id);
      continue;
    }

    const values = rows.map((row) => ({
      id: row.id,
      scope: columns.get(chunkScopeKey(Number(row.page_number), Number(row.chunk_index))),
    }));
    if (values.some((value) => typeof value.scope !== "string")) {
      summary.skipped.window_mismatch.push(id);
      continue;
    }

    if (update) {
      try {
        /** @type {NonNullable<typeof withTransaction>} */ (withTransaction)(() => {
          let changed = 0;
          for (const value of values) {
            changed += Number(update.run(value.scope, CHUNK_SCOPE_VERSION, value.id).changes);
          }
          // Chunk ids are never reused, so a chunk rebuilt since it was read
          // matches nothing here; the rebuild already stored its own scope.
          if (changed !== values.length) {
            throw new ChangedDuringRun();
          }
        });
      } catch (error) {
        if (error instanceof ChangedDuringRun) {
          summary.skipped.changed_during_run.push(id);
          continue;
        }
        throw error;
      }
      summary.taggedDocuments += 1;
      summary.taggedChunks += values.length;
    }

    summary.chunksToTag += values.length;
    for (const value of values) {
      const label = engineLabel(/** @type {string} */ (value.scope));
      summary.engineAtStart[label] = (summary.engineAtStart[label] || 0) + 1;
    }
  }

  if (apply) {
    summary.currentAfter = countCurrent();
    summary.remainingDocuments = listPending().length;
  }

  return summary;
}
