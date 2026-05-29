import { db } from "../database.js";

function tokenizeQuestion(question) {
  if (typeof question !== "string") {
    return [];
  }

  const uniqueTerms = new Set();
  const normalizedTerms = question
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 2);

  for (const term of normalizedTerms) {
    uniqueTerms.add(term);
  }

  return [...uniqueTerms];
}

function scoreChunkForTerms(row, terms) {
  const chunkText = (row.chunk_text || "").toLowerCase();
  const title = (row.title || "").toLowerCase();
  const filename = (row.original_filename || "").toLowerCase();
  const system = (row.system || "").toLowerCase();

  let score = 0;
  let matchedTerms = 0;
  let chunkMatchedTerms = 0;

  for (const term of terms) {
    let termMatched = false;

    if (chunkText.includes(term)) {
      score += 6;
      termMatched = true;
      chunkMatchedTerms += 1;
    }

    if (title.includes(term)) {
      score += 2;
      termMatched = true;
    }

    if (filename.includes(term)) {
      score += 1;
      termMatched = true;
    }

    if (system.includes(term)) {
      score += 1;
      termMatched = true;
    }

    if (termMatched) {
      matchedTerms += 1;
    }
  }

  return {
    score,
    matchedTerms,
    chunkMatchedTerms,
  };
}

export function retrieveRelevantChunks(question, { limit = 8 } = {}) {
  const terms = tokenizeQuestion(question);

  if (!terms.length) {
    return [];
  }

  const rows = db
    .prepare(`
      SELECT
        document_chunks.document_id,
        document_chunks.page_number,
        document_chunks.chunk_index,
        document_chunks.chunk_text,
        documents.title,
        documents.original_filename,
        documents.system
      FROM document_chunks
      JOIN documents ON documents.id = document_chunks.document_id
    `)
    .all();

  const scored = rows
    .map((row) => {
      const { score, matchedTerms, chunkMatchedTerms } = scoreChunkForTerms(row, terms);

      return {
        documentId: row.document_id,
        pageNumber: row.page_number,
        chunkIndex: row.chunk_index,
        chunkText: row.chunk_text,
        documentTitle: row.title,
        originalFilename: row.original_filename,
        system: row.system,
        relevanceScore: score,
        matchedTerms,
        chunkMatchedTerms,
        totalQueryTerms: terms.length,
      };
    })
    .filter((result) => result.relevanceScore > 0)
    .sort((left, right) => {
      if (right.relevanceScore !== left.relevanceScore) {
        return right.relevanceScore - left.relevanceScore;
      }

      if (right.matchedTerms !== left.matchedTerms) {
        return right.matchedTerms - left.matchedTerms;
      }

      if (left.documentId !== right.documentId) {
        return left.documentId - right.documentId;
      }

      if (left.pageNumber !== right.pageNumber) {
        return left.pageNumber - right.pageNumber;
      }

      return left.chunkIndex - right.chunkIndex;
    });

  const safeLimit = Math.max(1, Number(limit) || 8);
  return scored.slice(0, safeLimit);
}
