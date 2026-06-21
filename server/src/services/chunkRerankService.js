// Optional LLM reranker for hybrid retrieval.
//
// Hybrid retrieval (chunkRetrievalService.js) already produces a fused, ranked
// candidate list. This service is a thin, optional second pass: it hands a
// bounded pool of those candidates to the model and asks ONLY for a reordering
// by usefulness. The model never writes answer content here -- it just ranks.
//
// It is off by default (config.rerankEnabled) and degrades safely: without a
// key, on a model error, or on any malformed / ungrounded reply, rerankChunks
// returns the original fusion order untouched. A working Ask request must never
// fail just because reranking failed.
//
// Like the Ask and procedure-suggestion services, every external dependency is
// injectable so tests run without an API key and without network calls.

import { config } from "../config.js";

// Keep the per-chunk snippet short so the whole prompt stays bounded even with a
// wide candidate pool.
const RERANK_SNIPPET_LENGTH = 320;

function buildRerankSnippet(text) {
  const normalized = typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";

  if (!normalized) {
    return "";
  }

  return normalized.length > RERANK_SNIPPET_LENGTH
    ? `${normalized.slice(0, RERANK_SNIPPET_LENGTH - 3)}...`
    : normalized;
}

/** Pull a JSON array out of a model reply, tolerating code fences and prose. */
function extractJsonArray(rawText) {
  if (typeof rawText !== "string") {
    return null;
  }

  let text = rawText.trim();
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);

  if (fenceMatch) {
    text = fenceMatch[1].trim();
  }

  if (!text.startsWith("[")) {
    const start = text.indexOf("[");
    const end = text.lastIndexOf("]");

    if (start === -1 || end === -1 || end <= start) {
      return null;
    }

    text = text.slice(start, end + 1);
  }

  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Validate a model ranking reply into 1-based candidate indexes.
 *
 * Returns the validated index list (which may be a useful subset of the pool),
 * or null when the reply is malformed, empty, references an unknown index, or
 * repeats one. A null result tells the caller to keep the original order.
 *
 * @param {string} rawText - raw model output
 * @param {number} candidateCount - size of the candidate pool that was ranked
 * @returns {number[] | null}
 */
export function parseRerankedOrder(rawText, candidateCount) {
  const parsedArray = extractJsonArray(rawText);

  if (!parsedArray || !parsedArray.length) {
    return null;
  }

  const order = [];
  const seen = new Set();

  for (const entry of parsedArray) {
    const index = Number(entry);

    // Reject anything that is not a known 1-based candidate index, and reject
    // duplicates, rather than silently guessing -- the caller then falls back.
    if (!Number.isInteger(index) || index < 1 || index > candidateCount) {
      return null;
    }

    if (seen.has(index)) {
      return null;
    }

    seen.add(index);
    order.push(index);
  }

  return order;
}

/**
 * Reorder candidates by a validated 1-based index order. Any candidate the
 * model omitted is appended in its original position, so no candidate is ever
 * dropped and the returned length always equals the input length.
 *
 * @param {any[]} candidates
 * @param {number[]} order - 1-based indexes from parseRerankedOrder
 * @returns {any[]}
 */
export function applyRanking(candidates, order) {
  const reordered = [];
  const usedIndexes = new Set();

  for (const index of order) {
    const candidate = candidates[index - 1];

    if (candidate && !usedIndexes.has(index)) {
      reordered.push(candidate);
      usedIndexes.add(index);
    }
  }

  for (let index = 1; index <= candidates.length; index += 1) {
    if (!usedIndexes.has(index)) {
      reordered.push(candidates[index - 1]);
    }
  }

  return reordered;
}

function parseOpenAiOutputText(payload) {
  const outputText =
    typeof payload?.output_text === "string"
      ? payload.output_text
      : Array.isArray(payload?.output)
      ? payload.output
          .flatMap((item) =>
            Array.isArray(item?.content)
              ? item.content.map((content) =>
                  content?.type === "output_text" ? content.text || "" : ""
                )
              : []
          )
          .join("\n")
      : "";

  return outputText.trim();
}

/**
 * Ask OpenAI to rank the candidate chunks by usefulness for the question.
 * Returns the raw model text; the caller parses and validates it defensively.
 *
 * @param {{ question: string, candidates: any[], model?: string, fetchImpl?: Function }} params
 * @returns {Promise<string>}
 */
export async function generateChunkRankingFromOpenAi({
  question,
  candidates,
  model = config.openAiRerankModel,
  fetchImpl = fetch,
}) {
  const candidateText = candidates
    .map(
      (chunk, index) =>
        `[${index + 1}] ${chunk.documentTitle} (${chunk.originalFilename}) page ${
          chunk.pageNumber
        }: ${buildRerankSnippet(chunk.chunkText)}`
    )
    .join("\n\n");

  const prompt = [
    "You rank Toyota Corolla repair-manual chunks by how useful each one is for answering the question.",
    "Prefer chunks with direct specifications, torque values, capacities, procedures, warning text, or diagnostic steps.",
    "Do NOT answer the question. Do NOT write any explanation. Only rank the chunks.",
    "Return ONLY a JSON array of the chunk numbers, best first, for example [3, 1, 2].",
    "Use only the chunk numbers shown below. Never invent a number and never include a number that was not provided.",
    "",
    `Question: ${question}`,
    "",
    "Chunks:",
    candidateText,
  ].join("\n");

  const response = await fetchImpl("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.openAiApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: prompt,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI chunk rerank failed (${response.status}): ${errorText}`);
  }

  return parseOpenAiOutputText(await response.json());
}

/**
 * Reorder a bounded candidate pool with the LLM reranker, or return it
 * unchanged when reranking is unavailable or the reply is unusable.
 *
 * @param {string} question
 * @param {any[]} candidates - the fused candidate pool to reorder
 * @param {{
 *   isAiConfigured?: boolean,
 *   model?: string,
 *   generateRanking?: Function,
 * }} [options]
 * @returns {Promise<any[]>}
 */
export async function rerankChunks(
  question,
  candidates,
  {
    isAiConfigured = Boolean(config.openAiApiKey),
    model = config.openAiRerankModel,
    generateRanking = generateChunkRankingFromOpenAi,
  } = {}
) {
  const pool = Array.isArray(candidates) ? candidates : [];

  // Nothing to do without a key, or when there is nothing to reorder.
  if (!isAiConfigured || pool.length < 2) {
    return pool;
  }

  let rawText;

  try {
    rawText = await generateRanking({ question, candidates: pool, model });
  } catch {
    return pool;
  }

  const order = parseRerankedOrder(rawText, pool.length);

  if (!order) {
    return pool;
  }

  return applyRanking(pool, order);
}
