import { config } from "../config.js";
import { retrieveRelevantChunks } from "./chunkRetrievalService.js";

export const AI_NOT_CONFIGURED_MESSAGE =
  "AI is not configured yet. Set OPENAI_API_KEY in the server environment to enable Ask.";
export const NOT_FOUND_MESSAGE = "not in documents";

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
  { fetchImpl = fetch, timeoutMs = OPENAI_REQUEST_TIMEOUT_MS } = {}
) {
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

function buildCitationsFromChunks(chunks) {
  return chunks.map((chunk) => ({
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
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI question rewrite failed (${response.status}): ${errorText}`);
  }

  const rewrittenQuestion = parseOpenAiOutputText(await response.json())
    .replace(/^["']|["']$/g, "")
    .trim();

  return rewrittenQuestion || normalizedQuestion;
}

/**
 * @param {{
 *   question: string,
 *   originalQuestion?: string,
 *   chunks: any[],
 *   history?: any[],
 *   citations?: any[],
 *   image?: string | null,
 * }} params
 * @returns {Promise<string>}
 */
export async function generateAnswerTextFromOpenAi({
  question,
  originalQuestion,
  chunks,
  image = null,
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

  const response = await postToOpenAiResponses({ model, input });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI request failed (${response.status}): ${errorText}`);
  }

  return parseOpenAiOutputText(await response.json());
}

export async function askQuestionUsingDocuments(
  question,
  {
    chunkLimit = 8,
    generateAnswerText = generateAnswerTextFromOpenAi,
    history = [],
    image = null,
    isAiConfigured = Boolean(config.openAiApiKey),
    retrieveChunks = retrieveRelevantChunks,
    rewriteQuestion = rewriteQuestionFromOpenAi,
  } = {}
) {
  const normalizedQuestion = typeof question === "string" ? question.trim() : "";
  const normalizedHistory = normalizeConversationHistory(history);

  if (!normalizedQuestion) {
    throw new Error("Question is required.");
  }

  if (!isAiConfigured) {
    return {
      status: "ai_not_configured",
      answer: AI_NOT_CONFIGURED_MESSAGE,
      citations: [],
      standaloneQuestion: normalizedQuestion,
    };
  }

  const standaloneQuestion = normalizedHistory.length
    ? await rewriteQuestion({
        question: normalizedQuestion,
        history: normalizedHistory,
      })
    : normalizedQuestion;
  const retrievalQuestion = standaloneQuestion.trim() || normalizedQuestion;

  const chunks = await retrieveChunks(retrievalQuestion, {
    limit: chunkLimit,
    mode: "hybrid",
  });

  if (!chunks.length) {
    return {
      status: "not_found",
      answer: NOT_FOUND_MESSAGE,
      citations: [],
      standaloneQuestion: retrievalQuestion,
    };
  }

  const bestChunk = chunks[0];
  const minimumChunkTermMatches = Math.max(1, Math.ceil(bestChunk.totalQueryTerms * 0.4));

  const hasSemanticEvidence =
    bestChunk.retrievalMode === "hybrid" && Number(bestChunk.semanticScore || 0) >= 0.2;

  if (!hasSemanticEvidence && (bestChunk.chunkMatchedTerms || 0) < minimumChunkTermMatches) {
    return {
      status: "not_found",
      answer: NOT_FOUND_MESSAGE,
      citations: [],
      standaloneQuestion: retrievalQuestion,
    };
  }

  const citations = buildCitationsFromChunks(chunks);

  if (!citations.length) {
    return {
      status: "not_found",
      answer: NOT_FOUND_MESSAGE,
      citations: [],
      standaloneQuestion: retrievalQuestion,
    };
  }

  const answerText = await generateAnswerText({
    question: retrievalQuestion,
    originalQuestion: normalizedQuestion,
    history: normalizedHistory,
    chunks,
    citations,
    image,
  });

  if (!answerText || isNotFoundAnswer(answerText)) {
    return {
      status: "not_found",
      answer: NOT_FOUND_MESSAGE,
      citations: [],
      standaloneQuestion: retrievalQuestion,
    };
  }

  return {
    status: "answered",
    answer: answerText,
    citations,
    standaloneQuestion: retrievalQuestion,
  };
}
