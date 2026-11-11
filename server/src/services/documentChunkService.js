import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { db, withTransaction } from "../database.js";
import { clearChunkEmbeddingCache } from "./chunkEmbeddingService.js";
import {
  CHUNK_SCOPE_VERSION,
  chunkScopeKey,
  computeChunkScopeColumns,
} from "./chunkScopePersistence.js";
import { clearDocumentContentIdentityCache } from "./documentContentIdentity.js";
import { extractPdfData } from "./pdfService.js";
// The window lives in a leaf module because the applicability tagger must cut
// pages at exactly the same word boundaries (N5).
import {
  CHUNK_WORD_OVERLAP as DEFAULT_CHUNK_WORD_OVERLAP,
  CHUNK_WORD_SIZE as DEFAULT_CHUNK_WORD_SIZE,
  normalizeChunkWords as normalizeWords,
} from "./chunkGeometry.js";

export function chunkPageText(
  text,
  { chunkWordSize = DEFAULT_CHUNK_WORD_SIZE, chunkWordOverlap = DEFAULT_CHUNK_WORD_OVERLAP } = {}
) {
  const words = normalizeWords(text);

  if (!words.length) {
    return [];
  }

  const safeChunkWordSize = Math.max(1, Number(chunkWordSize) || DEFAULT_CHUNK_WORD_SIZE);
  const safeChunkWordOverlap = Math.max(
    0,
    Math.min(
      safeChunkWordSize - 1,
      Number(chunkWordOverlap) || DEFAULT_CHUNK_WORD_OVERLAP
    )
  );
  const step = Math.max(1, safeChunkWordSize - safeChunkWordOverlap);
  const chunks = [];

  for (let startIndex = 0; startIndex < words.length; startIndex += step) {
    const chunkWords = words.slice(startIndex, startIndex + safeChunkWordSize);

    if (!chunkWords.length) {
      continue;
    }

    chunks.push(chunkWords.join(" "));

    if (startIndex + safeChunkWordSize >= words.length) {
      break;
    }
  }

  return chunks;
}

/** A page the chunker stores: one with a positive integer page number. */
function hasStorablePageNumber(page) {
  const pageNumber = Number(page?.pageNumber);
  return Number.isInteger(pageNumber) && pageNumber > 0;
}

export function buildChunksFromPages(
  pages,
  { chunkWordSize = DEFAULT_CHUNK_WORD_SIZE, chunkWordOverlap = DEFAULT_CHUNK_WORD_OVERLAP } = {}
) {
  if (!Array.isArray(pages)) {
    return [];
  }

  const chunks = [];

  for (const page of pages) {
    if (!hasStorablePageNumber(page)) {
      continue;
    }

    const pageNumber = Number(page.pageNumber);

    const pageChunks = chunkPageText(page?.text || "", {
      chunkWordSize,
      chunkWordOverlap,
    });

    for (let chunkIndex = 0; chunkIndex < pageChunks.length; chunkIndex += 1) {
      chunks.push({
        documentId: null,
        pageNumber,
        chunkIndex,
        chunkText: pageChunks[chunkIndex],
      });
    }
  }

  return chunks;
}

/**
 * `scope_at_start` for each chunk the rebuild will store, keyed by
 * chunkScopeKey. An empty map stores NULL -- "not computed" -- which is never
 * read as "applies", and the backfill can retry it later.
 */
function computeStoredChunkScopes(
  documentId,
  pages,
  { chunkWordSize, chunkWordOverlap, computeScopeColumns }
) {
  // The tagger finds each chunk's first word with the default window. Under
  // any other window it would read the scope at the wrong word.
  if (chunkWordSize !== DEFAULT_CHUNK_WORD_SIZE || chunkWordOverlap !== DEFAULT_CHUNK_WORD_OVERLAP) {
    return new Map();
  }

  // Exactly the pages the chunker stores, so the scope matches what the
  // backfill later rebuilds from those same stored chunks.
  const storedPages = (Array.isArray(pages) ? pages : [])
    .filter(hasStorablePageNumber)
    .map((page) => ({ pageNumber: Number(page.pageNumber), text: page?.text || "" }));

  try {
    return computeScopeColumns(storedPages);
  } catch {
    // Classification must never stop a PDF from being saved: nothing reads the
    // scope yet, and the chunks are what Ask needs. Log-safe: the id only.
    console.warn(
      `[applicability] Scope not computed for document ${documentId}; its chunks are saved with no scope. ` +
        "Run npm run backfill:applicability to retry."
    );
    return new Map();
  }
}

export function rebuildDocumentChunksFromPages(
  documentId,
  pages,
  {
    chunkWordSize = DEFAULT_CHUNK_WORD_SIZE,
    chunkWordOverlap = DEFAULT_CHUNK_WORD_OVERLAP,
    computeScopeColumns = computeChunkScopeColumns,
  } = {}
) {
  const normalizedDocumentId = Number(documentId);

  if (!Number.isInteger(normalizedDocumentId) || normalizedDocumentId <= 0) {
    throw new Error("Document ID must be a positive integer.");
  }

  const chunks = buildChunksFromPages(pages, {
    chunkWordSize,
    chunkWordOverlap,
  }).map((chunk) => ({
    ...chunk,
    documentId: normalizedDocumentId,
  }));
  // N5 P2: each chunk's applicability scope, from the same pages, written by
  // the same inserts below -- so a re-extraction can never leave new text
  // under an old scope. Nothing reads it yet.
  const scopeColumns = computeStoredChunkScopes(normalizedDocumentId, pages, {
    chunkWordSize,
    chunkWordOverlap,
    computeScopeColumns,
  });

  const deleteStatement = db.prepare(`
    DELETE FROM document_chunks
    WHERE document_id = ?
  `);

  const insertStatement = db.prepare(`
    INSERT INTO document_chunks (
      document_id,
      page_number,
      chunk_index,
      chunk_text,
      scope_at_start,
      scope_version
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);

  // Its own transaction when called alone; a savepoint inside the caller's when
  // the rebuild is one step of a larger write (persistExtractionResult).
  withTransaction(() => {
    deleteStatement.run(normalizedDocumentId);

    for (const chunk of chunks) {
      const scopeAtStart = scopeColumns.get(chunkScopeKey(chunk.pageNumber, chunk.chunkIndex)) ?? null;

      insertStatement.run(
        chunk.documentId,
        chunk.pageNumber,
        chunk.chunkIndex,
        chunk.chunkText,
        scopeAtStart,
        scopeAtStart === null ? null : CHUNK_SCOPE_VERSION
      );
    }
  });

  clearChunkEmbeddingCache();
  // Chunks are only ever rebuilt after the document's extracted text was
  // rewritten, which is exactly when a cached content-group key goes stale.
  clearDocumentContentIdentityCache();

  return {
    documentId: normalizedDocumentId,
    chunkCount: chunks.length,
  };
}

function resolveUploadFilePath(documentRow) {
  const safeFileName = path.basename(
    documentRow?.stored_filename || documentRow?.file_path || ""
  );

  if (!safeFileName) {
    return "";
  }

  return path.join(config.uploadsDir, safeFileName);
}

async function extractPagesFromDocumentFile(documentRow) {
  const absoluteFilePath = resolveUploadFilePath(documentRow);

  if (!absoluteFilePath) {
    return [];
  }

  const fileBuffer = await fs.readFile(absoluteFilePath);
  const extractionResult = await extractPdfData(fileBuffer);
  return extractionResult.pages;
}

export async function rebuildDocumentChunksFromStoredPdf(documentId) {
  const normalizedDocumentId = Number(documentId);

  if (!Number.isInteger(normalizedDocumentId) || normalizedDocumentId <= 0) {
    throw new Error("Document ID must be a positive integer.");
  }

  const documentRow = db
    .prepare(`
      SELECT id, stored_filename, file_path
      FROM documents
      WHERE id = ?
    `)
    .get(normalizedDocumentId);

  if (!documentRow) {
    throw new Error("Document not found.");
  }

  const pages = await extractPagesFromDocumentFile(documentRow);
  return rebuildDocumentChunksFromPages(normalizedDocumentId, pages);
}

export async function backfillDocumentChunks() {
  const documents = db
    .prepare(`
      SELECT id
      FROM documents
      ORDER BY id ASC
    `)
    .all();

  const summary = {
    totalDocuments: documents.length,
    rebuiltDocuments: 0,
    skippedDocuments: 0,
  };

  for (const document of documents) {
    try {
      await rebuildDocumentChunksFromStoredPdf(document.id);
      summary.rebuiltDocuments += 1;
    } catch {
      summary.skippedDocuments += 1;
    }
  }

  return summary;
}
