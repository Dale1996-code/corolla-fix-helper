import { config } from "../config.js";
import {
  MINIMUM_SEMANTIC_SCORE,
  retrieveRelevantChunks,
} from "./chunkRetrievalService.js";
import { reserveAiCall } from "./aiUsageBudget.js";
import {
  createRedactedOpenAiHttpError,
  parseCompleteOpenAiOutputText,
  readOpenAiResponse,
} from "./openAiResponsePayload.js";
import { applyRelevanceFloor } from "./relevanceFloor.js";
import { buildModelTuning } from "./openAiModelCapabilities.js";
import {
  buildEvidenceContext,
  buildEvidencePromptLines,
  deriveEvidenceStatus,
  EVIDENCE_RESPONSE_SCHEMA,
  renderEvidenceAnswer,
  validateEvidencePayload,
  verifyEvidence,
} from "./askEvidenceContract.js";

export const AI_NOT_CONFIGURED_MESSAGE =
  "AI is not configured yet. Set OPENAI_API_KEY in the server environment to enable Ask.";
export const NOT_FOUND_MESSAGE = "not in documents";
export const EVIDENCE_UNAVAILABLE_MESSAGE =
  "The AI reply could not be checked against your documents, so it was not shown. Please try again.";

const MAX_HISTORY_MESSAGES = 10;
const MAX_HISTORY_CONTENT_LENGTH = 1200;

export const OPENAI_REQUEST_TIMEOUT_MS = 30_000;
export const OPENAI_TIMEOUT_MESSAGE =
  "The AI request took too long and was cancelled. Please try again.";

/**
 * POST a body to the OpenAI Responses API with a hard timeout.
 *
 * An AbortController cancels the request after `timeoutMs`, and a timeout
 * surfaces a short, user-friendly message instead of a stack trace. `fetchImpl`
 * is injectable so the timeout path is testable without a real network call.
 */
export async function postToOpenAiResponses(
  body,
  { fetchImpl = fetch, timeoutMs = OPENAI_REQUEST_TIMEOUT_MS, reserveCall = reserveAiCall } = {}
) {
  // Count this model call against the daily ceiling before spending on it.
  reserveCall();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetchImpl("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.openAiApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(OPENAI_TIMEOUT_MESSAGE, { cause: error });
    }

    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function normalizeConversationHistory(history) {
  if (!Array.isArray(history)) {
    return [];
  }

  return history
    .map((message) => {
      const role = message?.role === "assistant" ? "assistant" : "user";
      const content =
        typeof message?.content === "string"
          ? message.content.replace(/\s+/g, " ").trim()
          : "";

      return {
        role,
        content:
          content.length > MAX_HISTORY_CONTENT_LENGTH
            ? content.slice(0, MAX_HISTORY_CONTENT_LENGTH)
            : content,
      };
    })
    .filter((message) => message.content)
    .slice(-MAX_HISTORY_MESSAGES);
}

function buildConversationHistoryText(history) {
  return history
    .map((message) => `${message.role === "assistant" ? "Assistant" : "User"}: ${message.content}`)
    .join("\n");
}

function isNotFoundAnswer(answerText) {
  return String(answerText || "").trim().toLowerCase() === NOT_FOUND_MESSAGE;
}

function buildSnippet(text) {
  const normalized = typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";

  if (!normalized) {
    return "";
  }

  return normalized.length > 220 ? `${normalized.slice(0, 217)}...` : normalized;
}

/**
 * A chunk is citable only if it can point the owner at something. A row with no
 * document identity AND no text is not evidence -- it is a malformed row, and
 * rendering it as a citation would imply a source that cannot be opened.
 *
 * This filter is what makes the "no citations could be built" guard below a
 * reachable contract rather than dead defensive code.
 */
function isCitableChunk(chunk) {
  if (!chunk || typeof chunk !== "object") {
    return false;
  }

  const hasSource =
    chunk.documentId !== undefined && chunk.documentId !== null
      ? true
      : Boolean(chunk.documentTitle || chunk.originalFilename);

  return hasSource || Boolean(buildSnippet(chunk.chunkText));
}

function buildCitationsFromChunks(chunks) {
  return (Array.isArray(chunks) ? chunks : []).filter(isCitableChunk).map((chunk) => ({
    documentId: chunk.documentId,
    documentTitle: chunk.documentTitle,
    originalFilename: chunk.originalFilename,
    pageNumber: chunk.pageNumber,
    chunkIndex: chunk.chunkIndex,
    snippet: buildSnippet(chunk.chunkText),
  }));
}

function buildModelContext(chunks) {
  return chunks
    .map(
      (chunk, index) =>
        `[${index + 1}] ${chunk.documentTitle} (${chunk.originalFilename}) page ${
          chunk.pageNumber
        }, chunk ${chunk.chunkIndex}: ${chunk.chunkText}`
    )
    .join("\n\n");
}

/**
 * Build a log-safe metrics summary for one Ask request.
 *
 * Only counts, durations, sizes, and numeric IDs are included — never chunk
 * text, document titles, filenames, or citation snippets — so the result is
 * safe to log or return behind a dev flag without exposing private document
 * content. `contextChars` approximates the model context size from chunk text
 * lengths (never the text itself); `approxContextTokens` is a rough chars/4
 * estimate.
 *
 * @param {{
 *   chunks?: any[],
 *   citations?: any[],
 *   retrievalMs?: number,
 *   rewriteMs?: number,
 *   answerMs?: number,
 *   totalMs?: number,
 *   relevanceFloor?: any,
 * }} [params]
 */
export function buildAskMetrics({
  chunks = [],
  citations = [],
  retrievalMs = 0,
  rewriteMs = 0,
  answerMs = 0,
  totalMs = 0,
  relevanceFloor = null,
} = {}) {
  const roundMs = (value) => Math.round(Number(value) || 0);
  const contextChars = chunks.reduce(
    (sum, chunk) => sum + (typeof chunk?.chunkText === "string" ? chunk.chunkText.length : 0),
    0
  );
  const bestChunk = chunks[0] || null;

  return {
    retrievalMs: roundMs(retrievalMs),
    rewriteMs: roundMs(rewriteMs),
    answerMs: roundMs(answerMs),
    totalMs: roundMs(totalMs),
    chunkCount: chunks.length,
    citationCount: citations.length,
    contextChars,
    approxContextTokens: Math.ceil(contextChars / 4),
    topSemanticScore:
      bestChunk && typeof bestChunk.semanticScore === "number" ? bestChunk.semanticScore : null,
    retrievalMode:
      bestChunk && typeof bestChunk.retrievalMode === "string" ? bestChunk.retrievalMode : null,
    chunkRefs: chunks.map((chunk) => ({
      documentId: chunk?.documentId ?? null,
      pageNumber: chunk?.pageNumber ?? null,
      chunkIndex: chunk?.chunkIndex ?? null,
    })),
    // Shadow-mode visibility for the relevance floor. Numeric references and
    // scores only, so this stays safe to log.
    relevanceFloor,
  };
}

export async function rewriteQuestionFromOpenAi({ question, history }) {
  const normalizedQuestion = typeof question === "string" ? question.trim() : "";
  const normalizedHistory = normalizeConversationHistory(history);

  if (!normalizedQuestion || !normalizedHistory.length) {
    return normalizedQuestion;
  }

  const prompt = [
    "Rewrite the latest user question into one standalone repair-manual search query.",
    "Use the conversation history only to resolve references like front/rear, left/right, it, them, or the previous part.",
    "Do not answer the question. Do not add facts that are not in the conversation.",
    "Return only the rewritten standalone question as one sentence.",
    "",
    "Conversation history:",
    buildConversationHistoryText(normalizedHistory),
    "",
    `Latest user question: ${normalizedQuestion}`,
  ].join("\n");

  const response = await postToOpenAiResponses({
    model: config.openAiAnswerModel,
    input: prompt,
    // Model-aware sampling: temperature: 0 on a classic model, reasoning.effort
    // on a reasoning model (which rejects temperature outright).
    ...buildModelTuning(config.openAiAnswerModel),
    max_output_tokens: config.openAiMaxOutputTokens,
  });

  // Fail SOFT on an HTTP error too, matching the parse-failure path below. The
  // rewrite is an optimization -- retrieving on the user's own question is a
  // perfectly good outcome, and far better than failing the whole Ask request.
  // The body is drained but never surfaced: it can echo the prompt.
  if (!response.ok) {
    await response.text();
    return normalizedQuestion;
  }

  const parsed = readOpenAiResponse(await response.json());

  // A truncated, filtered, or otherwise unfinished rewrite would become a
  // mangled search query. This path is not wrapped by a caller, so fail SOFT:
  // fall back to the user's own question rather than failing the whole request.
  if (!parsed.ok) {
    return normalizedQuestion;
  }

  const rewrittenQuestion = parsed.text.replace(/^["']|["']$/g, "").trim();

  return rewrittenQuestion || normalizedQuestion;
}

/**
 * @param {{
 *   question: string,
 *   originalQuestion?: string,
 *   chunks: any[],
 *   citations?: any[],
 *   image?: string | null,
 *   fetchImpl?: typeof fetch,
 * }} params
 * @returns {Promise<string>}
 */
export async function generateAnswerTextFromOpenAi({
  question,
  originalQuestion,
  chunks,
  image = null,
  fetchImpl = fetch,
}) {
  const contextText = buildModelContext(chunks);
  const promptLines = [
    "Answer ONLY using the provided Toyota Corolla repair-manual chunks.",
    "Write for a beginner DIY mechanic: use plain English, short steps, and cautious wording.",
    "Write a thorough, step-by-step repair answer when the chunks support it.",
    "Clearly separate document-supported facts from general safety reminders.",
    "If a safety reminder is not stated in the chunks, label it as general safety guidance.",
    "For torque specs, capacities, dimensions, counts, fluid quantities, and other exact numbers, copy the exact number and unit verbatim from the chunks.",
    "Put a citation beside each quoted spec or procedure detail in this format: [Document title, page N].",
    "Never invent a spec, step, tool, warning, or quantity.",
  ];

  if (image) {
    promptLines.push(
      "An image from the user is attached. You may briefly describe what is visible in it to acknowledge the photo and to understand the symptom or context the user is showing.",
      "Do NOT treat the image as a source for any specification, torque value, capacity, fluid quantity, tool, repair step, procedure, or warning. Those repair facts must come only from the repair-manual chunks above and must still be cited.",
      "If the chunks do not support the requested repair, spec, or procedure answer, reply with the exact not-found reply below even when the image looks related."
    );
  }

  promptLines.push(
    "If the chunks do not support the answer, reply exactly:",
    NOT_FOUND_MESSAGE,
    "",
    `Original user question: ${originalQuestion || question}`,
    `Question: ${question}`,
    "",
    "Context chunks:",
    contextText
  );

  const prompt = promptLines.join("\n");
  // Plain-string input keeps the text-only request unchanged; only an attached
  // image switches to the structured Responses input and the vision model.
  const model = image ? config.openAiVisionModel : config.openAiAnswerModel;
  const input = image
    ? [
        {
          role: "user",
          content: [
            { type: "input_text", text: prompt },
            { type: "input_image", image_url: image },
          ],
        },
      ]
    : prompt;

  const response = await postToOpenAiResponses(
    {
      model,
      input,
      ...buildModelTuning(model),
      max_output_tokens: config.openAiMaxOutputTokens,
    },
    { fetchImpl }
  );

  if (!response.ok) {
    // Redacted: this prompt contains retrieved document passages, and ask.js
    // serializes error.message straight to the browser.
    throw createRedactedOpenAiHttpError(response.status, await response.text());
  }

  // Throws when the reply was truncated, filtered, or refused. Half a repair
  // procedure reads exactly like a complete one, so it must never be returned
  // as if it were the finished answer.
  return parseCompleteOpenAiOutputText(await response.json());
}

/**
 * Evidence-contract answer generation (Milestone 2, behind ASK_EVIDENCE_CONTRACT).
 *
 * Asks for structured atomic claims instead of prose, using `text.format` with a
 * json_schema. Returns the PARSED, VALIDATED payload -- verification against the
 * chunks happens in askQuestionUsingDocuments, which owns the chunk mapping.
 *
 * Separate from generateAnswerTextFromOpenAi rather than a mode inside it, so
 * the flag-off path is not touched at all.
 *
 * @param {{
 *   question: string,
 *   originalQuestion?: string,
 *   chunks: any[],
 *   image?: string | null,
 *   fetchImpl?: typeof fetch,
 * }} params
 */
export async function generateEvidenceAnswerFromOpenAi({
  question,
  originalQuestion,
  chunks,
  image = null,
  fetchImpl = fetch,
}) {
  const promptLines = buildEvidencePromptLines({
    question,
    originalQuestion,
    hasImage: Boolean(image),
  });
  const prompt = [...promptLines, "", "Sources:", buildEvidenceContext(chunks)].join("\n");
  const model = image ? config.openAiVisionModel : config.openAiAnswerModel;
  const input = image
    ? [
        {
          role: "user",
          content: [
            { type: "input_text", text: prompt },
            { type: "input_image", image_url: image },
          ],
        },
      ]
    : prompt;

  const response = await postToOpenAiResponses(
    {
      model,
      input,
      ...buildModelTuning(model),
      text: { format: EVIDENCE_RESPONSE_SCHEMA },
      max_output_tokens: config.openAiMaxOutputTokens,
    },
    { fetchImpl }
  );

  if (!response.ok) {
    throw createRedactedOpenAiHttpError(response.status, await response.text());
  }

  // Same fail-closed gate as the prose path: an unfinished structured reply is
  // truncated JSON, which is worse than truncated prose.
  const text = parseCompleteOpenAiOutputText(await response.json());

  let parsed;

  try {
    parsed = JSON.parse(text);
  } catch {
    const error = new Error(EVIDENCE_UNAVAILABLE_MESSAGE);
    // @ts-expect-error -- diagnostic detail intentionally attached
    error.failure = { kind: "evidence_not_json", reason: "json_parse_failed" };
    throw error;
  }

  const validated = validateEvidencePayload(parsed);

  if (!validated.ok) {
    const error = new Error(EVIDENCE_UNAVAILABLE_MESSAGE);
    // @ts-expect-error -- diagnostic detail intentionally attached
    error.failure = { kind: "evidence_schema_invalid", reason: validated.reason };
    throw error;
  }

  return validated.value;
}

export async function askQuestionUsingDocuments(
  question,
  {
    chunkLimit = 8,
    evidenceContract = config.askEvidenceContract,
    relevanceFloor = config.askRelevanceFloor,
    relevanceFloorThreshold = MINIMUM_SEMANTIC_SCORE,
    generateEvidenceAnswer = generateEvidenceAnswerFromOpenAi,
    generateAnswerText = generateAnswerTextFromOpenAi,
    history = [],
    image = null,
    includeMetrics = config.askDebugMetrics,
    isAiConfigured = Boolean(config.openAiApiKey),
    retrieveChunks = retrieveRelevantChunks,
    rewriteQuestion = rewriteQuestionFromOpenAi,
  } = {}
) {
  // Stage timings and the collected chunks/citations feed the optional metrics
  // summary. finalize() attaches metrics only when includeMetrics is on, so the
  // default return shape (and logs) stay exactly as before.
  const startedAt = performance.now();
  let retrievalMs = 0;
  let rewriteMs = 0;
  let answerMs = 0;
  let retrievedChunks = [];
  let builtCitations = [];
  let relevanceFloorReport = null;

  // Passages that were retrieved but that the response does not cite.
  //
  // Every not_found exit sets `citations: []`, which threw away evidence the
  // system already had in hand: the user was told "not in documents" with no way
  // to see what the search actually found. This is PURELY ADDITIVE -- `citations`
  // keeps its exact current shape (including [] on not_found) so no existing
  // consumer changes behavior, and the recovered passages arrive alongside it.
  //
  // Derived from `retrievedChunks` rather than the built citations, because two
  // of the four not_found exits fire BEFORE citations are built (the relevance
  // gate and the empty-citations guard). Omitted entirely when the response
  // already cites its sources, so an answered response stays byte-identical.
  const buildRetrievedContext = (result) => {
    const hasCitations = Array.isArray(result.citations) && result.citations.length > 0;

    if (hasCitations || !Array.isArray(retrievedChunks) || !retrievedChunks.length) {
      return null;
    }

    // Bound and de-duplicate locally rather than trusting the retriever: an
    // injected or future retriever could return more than chunkLimit, or repeat
    // a chunk. Retrieval order is preserved (best first).
    const seen = new Set();
    const unique = [];

    for (const chunk of retrievedChunks) {
      if (!chunk || typeof chunk !== "object") {
        continue;
      }

      // Stable identity, with a document+page+index fallback when the row id is
      // absent (injected chunks in tests and evals often omit it).
      const chunkId = chunk.chunkId ?? chunk.id;
      const identity =
        chunkId === undefined || chunkId === null
          ? `doc:${chunk.documentId ?? "?"}:${chunk.pageNumber ?? "?"}:${
              chunk.chunkIndex ?? "?"
            }`
          : `id:${chunkId}`;

      if (seen.has(identity)) {
        continue;
      }

      seen.add(identity);
      unique.push(chunk);

      if (unique.length >= chunkLimit) {
        break;
      }
    }

    return unique.length ? buildCitationsFromChunks(unique) : null;
  };

  const finalize = (result) => {
    const retrievedContext = buildRetrievedContext(result);
    const withContext = retrievedContext ? { ...result, retrievedContext } : result;

    return includeMetrics
      ? {
          ...withContext,
          metrics: buildAskMetrics({
            chunks: retrievedChunks,
            citations: builtCitations,
            retrievalMs,
            rewriteMs,
            answerMs,
            totalMs: performance.now() - startedAt,
            relevanceFloor: relevanceFloorReport,
          }),
        }
      : withContext;
  };

  const normalizedQuestion = typeof question === "string" ? question.trim() : "";
  const normalizedHistory = normalizeConversationHistory(history);

  if (!normalizedQuestion) {
    throw new Error("Question is required.");
  }

  if (!isAiConfigured) {
    return finalize({
      status: "ai_not_configured",
      answer: AI_NOT_CONFIGURED_MESSAGE,
      citations: [],
      standaloneQuestion: normalizedQuestion,
    });
  }

  let standaloneQuestion = normalizedQuestion;
  if (normalizedHistory.length) {
    const rewriteStart = performance.now();
    standaloneQuestion = await rewriteQuestion({
      question: normalizedQuestion,
      history: normalizedHistory,
    });
    rewriteMs = performance.now() - rewriteStart;
  }
  const retrievalQuestion = standaloneQuestion.trim() || normalizedQuestion;

  const retrievalStart = performance.now();
  const rawChunks = await retrieveChunks(retrievalQuestion, {
    limit: chunkLimit,
    mode: "hybrid",
  });
  // Drop rows that are not objects before anything reads their fields. The
  // relevance gate below dereferences chunks[0] directly, so a null or string
  // row from an injected or future retriever would throw and surface as a 500
  // instead of an honest not_found.
  retrievedChunks = (Array.isArray(rawChunks) ? rawChunks : []).filter(
    (chunk) => chunk && typeof chunk === "object"
  );
  retrievalMs = performance.now() - retrievalStart;

  // Relevance floor. Shadow by default: it reports what it WOULD drop without
  // dropping anything, so the effect can be measured on a real corpus before it
  // is allowed to change answers. See services/relevanceFloor.js.
  const floor = applyRelevanceFloor(retrievedChunks, {
    threshold: relevanceFloorThreshold,
    enforce: relevanceFloor,
  });
  relevanceFloorReport = {
    enforced: floor.enforced,
    threshold: floor.threshold,
    droppedCount: floor.droppedCount,
    keptCount: floor.keptCount,
    dropped: floor.dropped,
  };

  if (floor.enforced) {
    retrievedChunks = floor.chunks;
  }

  const chunks = retrievedChunks;

  if (!chunks.length) {
    return finalize({
      status: "not_found",
      answer: NOT_FOUND_MESSAGE,
      citations: [],
      standaloneQuestion: retrievalQuestion,
    });
  }

  const bestChunk = chunks[0];
  const minimumChunkTermMatches = Math.max(1, Math.ceil(bestChunk.totalQueryTerms * 0.4));

  // Shares chunkRetrievalService's floor rather than repeating the literal, so
  // calibrating the threshold later moves one number instead of two.
  const hasSemanticEvidence =
    bestChunk.retrievalMode === "hybrid" &&
    Number(bestChunk.semanticScore || 0) >= MINIMUM_SEMANTIC_SCORE;

  if (!hasSemanticEvidence && (bestChunk.chunkMatchedTerms || 0) < minimumChunkTermMatches) {
    return finalize({
      status: "not_found",
      answer: NOT_FOUND_MESSAGE,
      citations: [],
      standaloneQuestion: retrievalQuestion,
    });
  }

  const citations = buildCitationsFromChunks(chunks);
  builtCitations = citations;

  // Reachable contract, not dead defense: buildCitationsFromChunks drops rows
  // with no document identity and no text, so retrieval can return chunks while
  // none of them are citable. Answering from sources we cannot show the owner
  // would be ungrounded, so refuse instead.
  if (!citations.length) {
    return finalize({
      status: "not_found",
      answer: NOT_FOUND_MESSAGE,
      citations: [],
      standaloneQuestion: retrievalQuestion,
    });
  }

  // Evidence contract (ASK_EVIDENCE_CONTRACT). Everything above is shared; only
  // the answer step differs, so retrieval, the relevance gate, citations, and
  // retrievedContext behave identically with the flag on or off.
  if (evidenceContract) {
    const evidenceStart = performance.now();
    const raw = await generateEvidenceAnswer({
      question: retrievalQuestion,
      originalQuestion: normalizedQuestion,
      chunks,
      image,
    });
    answerMs = performance.now() - evidenceStart;

    // Server-side verification: every quote must really be in the chunk it
    // names, and every unit-bearing number must be present in that quote.
    const verified = verifyEvidence(raw, chunks);
    // Status is DERIVED, never taken from the model -- a model-supplied status
    // could contradict its own claims.
    const status = deriveEvidenceStatus(verified);
    const evidenceCitations = buildCitationsFromChunks(
      chunks.filter((_, index) =>
        verified.documentSupported.some(
          (item) =>
            item.pageNumber === chunks[index].pageNumber &&
            item.chunkIndex === chunks[index].chunkIndex &&
            item.documentId === chunks[index].documentId
        )
      )
    );
    builtCitations = evidenceCitations;

    return finalize({
      status,
      answer:
        status === "not_found"
          ? NOT_FOUND_MESSAGE
          : renderEvidenceAnswer(verified) || NOT_FOUND_MESSAGE,
      // Only chunks that actually backed a verified claim are cited. This is the
      // fix for "every retrieved chunk becomes a citation".
      citations: status === "not_found" ? [] : evidenceCitations,
      standaloneQuestion: retrievalQuestion,
      evidence: {
        documentSupported: verified.documentSupported,
        generalGuidance: verified.generalGuidance,
        gaps: verified.gaps,
      },
    });
  }

  const answerStart = performance.now();
  // NOTE: `history` is deliberately NOT passed. Nothing reads it -- not
  // generateAnswerTextFromOpenAi, and not any injected implementation -- so it
  // was a genuinely dead parameter. Multi-turn context reaches the model solely
  // through the rewrite call above (rewriteQuestion), which folds the history
  // into the standalone question. Do not reintroduce it without a test proving
  // it is read; conversation history does not belong in the answer prompt.
  //
  // `citations` IS still passed even though the default OpenAI implementation
  // ignores it. It is part of this dependency-injection seam's contract, and
  // four injected test doubles read it (app.test.js, pdfOcr.test.js). Dropping
  // it would narrow a public seam, not delete dead code.
  const answerText = await generateAnswerText({
    question: retrievalQuestion,
    originalQuestion: normalizedQuestion,
    chunks,
    citations,
    image,
  });
  answerMs = performance.now() - answerStart;

  if (!answerText || isNotFoundAnswer(answerText)) {
    return finalize({
      status: "not_found",
      answer: NOT_FOUND_MESSAGE,
      citations: [],
      standaloneQuestion: retrievalQuestion,
    });
  }

  return finalize({
    status: "answered",
    answer: answerText,
    citations,
    standaloneQuestion: retrievalQuestion,
  });
}
