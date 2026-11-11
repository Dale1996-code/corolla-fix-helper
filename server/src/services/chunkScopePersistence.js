// Applicability scope as it is STORED on document_chunks (N5 P2,
// docs/n5-applicability-design.md §6.1 part 3).
//
// Each chunk records the scope in effect at its first word (`scope_at_start`)
// and the tagger rules that produced it (`scope_version`). That repairs the
// context a 200-word chunk loses: a chunk that names no engine itself still
// records that it opens inside a "(for 2AZ-FE)" block or under an article
// titled "(2AZ-FE)" two pages back -- without changing chunk text or embeddings.
//
// The scope of a chunk depends on every page BEFORE it (an article title
// carries across pages), so it is always computed from a whole document's
// pages, never from one chunk on its own. Two writers use this module: the
// chunk rebuild, which has the extracted pages in hand, and
// `npm run backfill:applicability`, which rebuilds the same pages from stored
// chunks. Both feed it the same words, so both store the same scope.
//
// WRITE SIDE ONLY. Nothing in Ask, the planner, or retrieval reads these
// columns until a later phase enforces scope on purpose;
// applicabilityNotEnforced.test.js fails if something starts to.

import { APPLICABILITY_SCOPE_VERSION, computeDocumentScopes } from "./applicabilityScope.js";

/** The value stored in `scope_version`. */
export const CHUNK_SCOPE_VERSION = APPLICABILITY_SCOPE_VERSION;

/** Map key for one stored chunk. */
export function chunkScopeKey(pageNumber, chunkIndex) {
  return `${pageNumber}:${chunkIndex}`;
}

/**
 * One axis in a fixed field order, so the same scope is always the same text.
 *
 * @param {import("./applicabilityScope.js").AxisScope} axisScope
 */
function serializableAxis(axisScope) {
  if (!axisScope) {
    return null;
  }
  if ("unresolved" in axisScope) {
    return { unresolved: true, kind: axisScope.kind };
  }
  return { value: axisScope.value, exclude: axisScope.exclude, kind: axisScope.kind };
}

/**
 * The JSON stored in `scope_at_start`. A chunk with no scope on either axis is
 * `{"engine":null,"plant":null}` -- computed, and nothing stated -- which is
 * different from a NULL column, meaning "not computed".
 *
 * @param {import("./applicabilityScope.js").Scope} scope
 * @returns {string}
 */
export function serializeChunkScope(scope) {
  return JSON.stringify({
    engine: serializableAxis(scope.engine),
    plant: serializableAxis(scope.plant),
  });
}

/**
 * Compute `scope_at_start` for every chunk of one document.
 *
 * `pages` must be the document's pages as the chunker cuts them (the default
 * 200/40 word window) -- every page, since a title on page 1 scopes page 2.
 *
 * @param {Array<{ pageNumber: number, text: string }>} pages
 * @returns {Map<string, string>} keyed by chunkScopeKey(pageNumber, chunkIndex)
 */
export function computeChunkScopeColumns(pages) {
  /** @type {Map<string, string>} */
  const columns = new Map();

  for (const page of computeDocumentScopes(pages)) {
    for (const chunk of page.chunks) {
      columns.set(chunkScopeKey(page.pageNumber, chunk.chunkIndex), serializeChunkScope(chunk.entryScope));
    }
  }

  return columns;
}
