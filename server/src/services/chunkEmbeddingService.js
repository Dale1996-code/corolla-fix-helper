import { config } from "../config.js";
import { createRedactedOpenAiHttpError } from "./openAiResponsePayload.js";
import { db } from "../database.js";

let chunkEmbeddingCache = null;

function embeddingByteLength() {
  return config.openAiEmbeddingDimensions * Float32Array.BYTES_PER_ELEMENT;
}

function normalizeInputText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function assertEmbeddingVector(vector) {
  if (!vector || typeof vector.length !== "number") {
    throw new Error("Embedding vector must be an array of numbers.");
  }

  if (vector.length !== config.openAiEmbeddingDimensions) {
    throw new Error(
      `Embedding vector has ${vector.length} dimensions, expected ${config.openAiEmbeddingDimensions}.`
    );
  }
}

export function float32ArrayToBuffer(vector) {
  assertEmbeddingVector(vector);

  const floatVector = vector instanceof Float32Array ? vector : Float32Array.from(vector);
  const bytes = new Uint8Array(
    floatVector.buffer,
    floatVector.byteOffset,
    floatVector.byteLength
  );

  return Buffer.from(bytes);
}

export function bufferToFloat32Array(blob) {
  const bytes = blob instanceof Uint8Array ? blob : Buffer.from(blob || []);

  if (bytes.length !== embeddingByteLength()) {
    throw new Error(
      `Embedding BLOB has ${bytes.length} bytes, expected ${embeddingByteLength()}.`
    );
  }

  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return new Float32Array(copy.buffer);
}

export function vectorMagnitude(vector) {
  let sum = 0;

  for (let index = 0; index < vector.length; index += 1) {
    sum += vector[index] * vector[index];
  }

  return Math.sqrt(sum);
}

export function cosineSimilarity(leftVector, leftMagnitude, rightVector, rightMagnitude) {
  if (!leftMagnitude || !rightMagnitude) {
    return 0;
  }

  let dotProduct = 0;
  const length = Math.min(leftVector.length, rightVector.length);

  for (let index = 0; index < length; index += 1) {
    dotProduct += leftVector[index] * rightVector[index];
  }

  return dotProduct / (leftMagnitude * rightMagnitude);
}

export function clearChunkEmbeddingCache() {
  chunkEmbeddingCache = null;
}

export function loadChunkEmbeddingCache() {
  const cacheKey = `${config.openAiEmbeddingVersion}:${embeddingByteLength()}`;

  if (chunkEmbeddingCache?.cacheKey === cacheKey) {
    return chunkEmbeddingCache.rows;
  }

  const rows = db
    .prepare(`
      SELECT
        document_chunks.id,
        document_chunks.document_id,
        document_chunks.page_number,
        document_chunks.chunk_index,
        document_chunks.chunk_text,
        document_chunks.embedding,
        documents.title,
        documents.original_filename,
        documents.system
      FROM document_chunks
      JOIN documents ON documents.id = document_chunks.document_id
      WHERE document_chunks.embedding_version = ?
        AND document_chunks.embedding IS NOT NULL
        AND length(document_chunks.embedding) = ?
      ORDER BY document_chunks.id ASC
    `)
    .all(config.openAiEmbeddingVersion, embeddingByteLength());

  chunkEmbeddingCache = {
    cacheKey,
    rows: rows.map((row) => {
      const embedding = bufferToFloat32Array(row.embedding);

      return {
        chunkId: row.id,
        documentId: row.document_id,
        pageNumber: row.page_number,
        chunkIndex: row.chunk_index,
        chunkText: row.chunk_text,
        documentTitle: row.title,
        originalFilename: row.original_filename,
        system: row.system,
        embedding,
        embeddingMagnitude: vectorMagnitude(embedding),
      };
    }),
  };

  return chunkEmbeddingCache.rows;
}

export async function createOpenAiEmbeddings(texts, { fetchImpl = fetch } = {}) {
  const input = Array.isArray(texts) ? texts.map(normalizeInputText) : [];

  if (!input.length) {
    return [];
  }

  if (!config.openAiApiKey) {
    throw new Error("OPENAI_API_KEY is required to create embeddings.");
  }

  const response = await fetchImpl("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.openAiApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.openAiEmbeddingModel,
      input,
      dimensions: config.openAiEmbeddingDimensions,
      encoding_format: "float",
    }),
  });

  if (!response.ok) {
    // Redacted. This runs on the Ask request path (chunkRetrievalService embeds
    // the question) and the throw propagates uncaught to ask.js, so a raw body
    // here would reach the browser. The embedding input is the question text and
    // chunk text, which is exactly what must not be echoed back.
    throw createRedactedOpenAiHttpError(response.status, await response.text());
  }

  const payload = await response.json();
  const data = Array.isArray(payload?.data) ? payload.data : [];

  if (data.length !== input.length) {
    throw new Error(
      `OpenAI returned ${data.length} embeddings for ${input.length} input chunks.`
    );
  }

  return data
    .toSorted((left, right) => left.index - right.index)
    .map((item) => {
      const embedding = item?.embedding;
      assertEmbeddingVector(embedding);
      return Float32Array.from(embedding);
    });
}

export async function createOpenAiEmbedding(text, options = {}) {
  const [embedding] = await createOpenAiEmbeddings([text], options);
  return embedding;
}

function getPendingEmbeddingRows() {
  return db
    .prepare(`
      SELECT id, chunk_text
      FROM document_chunks
      WHERE embedding_version IS NULL
        OR embedding_version <> ?
        OR embedding IS NULL
        OR length(embedding) <> ?
      ORDER BY id ASC
    `)
    .all(config.openAiEmbeddingVersion, embeddingByteLength());
}

function countCurrentEmbeddingRows() {
  const row = db
    .prepare(`
      SELECT COUNT(*) AS total
      FROM document_chunks
      WHERE embedding_version = ?
        AND embedding IS NOT NULL
        AND length(embedding) = ?
    `)
    .get(config.openAiEmbeddingVersion, embeddingByteLength());

  return Number(row?.total || 0);
}

export async function backfillChunkEmbeddings({
  createEmbeddings = createOpenAiEmbeddings,
  batchSize = config.openAiEmbeddingBatchSize,
} = {}) {
  const pendingRows = getPendingEmbeddingRows();
  const safeBatchSize = Math.max(1, Number(batchSize) || config.openAiEmbeddingBatchSize);
  const updateStatement = db.prepare(`
    UPDATE document_chunks
    SET embedding = ?, embedding_version = ?
    WHERE id = ?
  `);

  const summary = {
    embeddingVersion: config.openAiEmbeddingVersion,
    totalChunks: pendingRows.length + countCurrentEmbeddingRows(),
    pendingChunks: pendingRows.length,
    embeddedChunks: 0,
    skippedCurrentVersion: countCurrentEmbeddingRows(),
  };

  for (let startIndex = 0; startIndex < pendingRows.length; startIndex += safeBatchSize) {
    const batch = pendingRows.slice(startIndex, startIndex + safeBatchSize);
    const embeddings = await createEmbeddings(batch.map((row) => row.chunk_text));

    if (embeddings.length !== batch.length) {
      throw new Error(
        `Embedding function returned ${embeddings.length} vectors for ${batch.length} chunks.`
      );
    }

    db.exec("BEGIN IMMEDIATE TRANSACTION");

    try {
      for (let index = 0; index < batch.length; index += 1) {
        updateStatement.run(
          float32ArrayToBuffer(embeddings[index]),
          config.openAiEmbeddingVersion,
          batch[index].id
        );
      }

      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    summary.embeddedChunks += batch.length;
  }

  if (summary.embeddedChunks > 0) {
    clearChunkEmbeddingCache();
  }

  return summary;
}
