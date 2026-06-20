import { db } from "../database.js";
import { config } from "../config.js";
import {
  cosineSimilarity,
  createOpenAiEmbedding,
  loadChunkEmbeddingCache,
  vectorMagnitude,
} from "./chunkEmbeddingService.js";

const RECIPROCAL_RANK_K = 60;
const MINIMUM_SEMANTIC_SCORE = 0.2;

export function tokenizeQuestion(question) {
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
  const chunkText = (row.chunk_text || row.chunkText || "").toLowerCase();
  const title = (row.title || row.documentTitle || "").toLowerCase();
  const filename = (row.original_filename || row.originalFilename || "").toLowerCase();
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

function compareKeywordResults(left, right) {
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
}

function compareChunkOrder(left, right) {
  if (left.documentId !== right.documentId) {
    return left.documentId - right.documentId;
  }

  if (left.pageNumber !== right.pageNumber) {
    return left.pageNumber - right.pageNumber;
  }

  return left.chunkIndex - right.chunkIndex;
}

function normalizeKeywordResult(row, terms) {
  const { score, matchedTerms, chunkMatchedTerms } = scoreChunkForTerms(row, terms);

  return {
    chunkId: row.id || row.chunkId,
    documentId: row.document_id || row.documentId,
    pageNumber: row.page_number || row.pageNumber,
    chunkIndex: row.chunk_index || row.chunkIndex,
    chunkText: row.chunk_text || row.chunkText,
    documentTitle: row.title || row.documentTitle,
    originalFilename: row.original_filename || row.originalFilename,
    system: row.system,
    relevanceScore: score,
    keywordScore: score,
    matchedTerms,
    chunkMatchedTerms,
    totalQueryTerms: terms.length,
    retrievalMode: "keyword",
  };
}

function getSafeLimit(limit) {
  return Math.max(1, Number(limit) || 8);
}

export function retrieveKeywordChunks(question, { limit = 8 } = {}) {
  const terms = tokenizeQuestion(question);

  if (!terms.length) {
    return [];
  }

  const rows = db
    .prepare(`
      SELECT
        document_chunks.id,
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
    .map((row) => normalizeKeywordResult(row, terms))
    .filter((result) => result.relevanceScore > 0)
    .sort(compareKeywordResults);

  return scored.slice(0, getSafeLimit(limit));
}

function assertQueryEmbedding(queryEmbedding) {
  if (!queryEmbedding || queryEmbedding.length !== config.openAiEmbeddingDimensions) {
    throw new Error(
      `Query embedding must have ${config.openAiEmbeddingDimensions} dimensions.`
    );
  }
}

function addRankedCandidate(candidates, row, scorePatch) {
  const key = String(row.chunkId);
  const existing = candidates.get(key) || {
    ...row,
    relevanceScore: 0,
    keywordScore: 0,
    semanticScore: 0,
    hybridScore: 0,
    matchedTerms: 0,
    chunkMatchedTerms: 0,
    totalQueryTerms: 0,
    retrievalMode: "hybrid",
  };

  candidates.set(key, {
    ...existing,
    ...scorePatch,
    relevanceScore: Math.max(
      existing.relevanceScore || 0,
      scorePatch.hybridScore || 0,
      scorePatch.keywordScore || 0
    ),
    hybridScore: (existing.hybridScore || 0) + (scorePatch.hybridScore || 0),
  });
}

async function retrieveHybridChunks(
  question,
  { limit = 8, createQueryEmbedding = createOpenAiEmbedding } = {}
) {
  const terms = tokenizeQuestion(question);

  if (!terms.length) {
    return [];
  }

  const cacheRows = loadChunkEmbeddingCache();

  if (!cacheRows.length) {
    return [];
  }

  const queryEmbedding = await createQueryEmbedding(question);
  assertQueryEmbedding(queryEmbedding);

  const queryMagnitude = vectorMagnitude(queryEmbedding);
  const vectorRanked = cacheRows
    .map((row) => ({
      ...row,
      semanticScore: cosineSimilarity(
        queryEmbedding,
        queryMagnitude,
        row.embedding,
        row.embeddingMagnitude
      ),
    }))
    .filter((row) => row.semanticScore > 0)
    .sort((left, right) => {
      if (right.semanticScore !== left.semanticScore) {
        return right.semanticScore - left.semanticScore;
      }

      return compareChunkOrder(left, right);
    });

  const keywordRanked = cacheRows
    .map((row) => normalizeKeywordResult(row, terms))
    .filter((result) => result.keywordScore > 0)
    .sort(compareKeywordResults);

  const candidates = new Map();

  for (let index = 0; index < vectorRanked.length; index += 1) {
    const row = vectorRanked[index];
    addRankedCandidate(candidates, row, {
      semanticRank: index + 1,
      semanticScore: row.semanticScore,
      hybridScore: 1 / (RECIPROCAL_RANK_K + index + 1),
    });
  }

  for (let index = 0; index < keywordRanked.length; index += 1) {
    const row = keywordRanked[index];
    addRankedCandidate(candidates, row, {
      keywordRank: index + 1,
      keywordScore: row.keywordScore,
      matchedTerms: row.matchedTerms,
      chunkMatchedTerms: row.chunkMatchedTerms,
      totalQueryTerms: row.totalQueryTerms,
      hybridScore: 1 / (RECIPROCAL_RANK_K + index + 1),
    });
  }

  return [...candidates.values()]
    .filter(
      (candidate) =>
        candidate.keywordScore > 0 || candidate.semanticScore >= MINIMUM_SEMANTIC_SCORE
    )
    .sort((left, right) => {
      if (right.hybridScore !== left.hybridScore) {
        return right.hybridScore - left.hybridScore;
      }

      if (right.semanticScore !== left.semanticScore) {
        return right.semanticScore - left.semanticScore;
      }

      if (right.keywordScore !== left.keywordScore) {
        return right.keywordScore - left.keywordScore;
      }

      return compareChunkOrder(left, right);
    })
    .slice(0, getSafeLimit(limit));
}

export async function retrieveRelevantChunks(question, options = {}) {
  if (options.mode === "keyword") {
    return retrieveKeywordChunks(question, options);
  }

  return retrieveHybridChunks(question, options);
}
