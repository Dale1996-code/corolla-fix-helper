import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { db } from "../database.js";
import { extractPdfData } from "./pdfService.js";

const DEFAULT_CHUNK_WORD_SIZE = 200;
const DEFAULT_CHUNK_WORD_OVERLAP = 40;

function normalizeWords(text) {
  if (typeof text !== "string") {
    return [];
  }

  return text
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map((word) => word.trim())
    .filter(Boolean);
}

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

export function buildChunksFromPages(
  pages,
  { chunkWordSize = DEFAULT_CHUNK_WORD_SIZE, chunkWordOverlap = DEFAULT_CHUNK_WORD_OVERLAP } = {}
) {
  if (!Array.isArray(pages)) {
    return [];
  }

  const chunks = [];

  for (const page of pages) {
    const pageNumber = Number(page?.pageNumber);

    if (!Number.isInteger(pageNumber) || pageNumber <= 0) {
      continue;
    }

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

export function rebuildDocumentChunksFromPages(
  documentId,
  pages,
  { chunkWordSize = DEFAULT_CHUNK_WORD_SIZE, chunkWordOverlap = DEFAULT_CHUNK_WORD_OVERLAP } = {}
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

  const deleteStatement = db.prepare(`
    DELETE FROM document_chunks
    WHERE document_id = ?
  `);

  const insertStatement = db.prepare(`
    INSERT INTO document_chunks (
      document_id,
      page_number,
      chunk_index,
      chunk_text
    ) VALUES (?, ?, ?, ?)
  `);

  db.exec("BEGIN IMMEDIATE TRANSACTION");

  try {
    deleteStatement.run(normalizedDocumentId);

    for (const chunk of chunks) {
      insertStatement.run(
        chunk.documentId,
        chunk.pageNumber,
        chunk.chunkIndex,
        chunk.chunkText
      );
    }

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

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
