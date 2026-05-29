import { config } from "../config.js";
import { retrieveRelevantChunks } from "./chunkRetrievalService.js";

export const AI_NOT_CONFIGURED_MESSAGE =
  "AI is not configured yet. Set OPENAI_API_KEY in the server environment to enable Ask.";
export const NOT_FOUND_MESSAGE =
  "The uploaded documents do not contain enough information to answer that.";

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

export async function generateAnswerTextFromOpenAi({ question, chunks }) {
  const contextText = buildModelContext(chunks);
  const prompt = [
    "Answer ONLY using the provided document chunks.",
    "If the context is not enough, reply exactly:",
    NOT_FOUND_MESSAGE,
    "",
    `Question: ${question}`,
    "",
    "Context chunks:",
    contextText,
  ].join("\n");

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.openAiApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.openAiModel,
      input: prompt,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI request failed (${response.status}): ${errorText}`);
  }

  const payload = await response.json();
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

export async function askQuestionUsingDocuments(
  question,
  {
    chunkLimit = 8,
    generateAnswerText = generateAnswerTextFromOpenAi,
    isAiConfigured = Boolean(config.openAiApiKey),
  } = {}
) {
  const normalizedQuestion = typeof question === "string" ? question.trim() : "";

  if (!normalizedQuestion) {
    throw new Error("Question is required.");
  }

  const chunks = retrieveRelevantChunks(normalizedQuestion, {
    limit: chunkLimit,
  });

  if (!chunks.length) {
    return {
      status: "not_found",
      answer: NOT_FOUND_MESSAGE,
      citations: [],
    };
  }

  const bestChunk = chunks[0];
  const minimumChunkTermMatches = Math.max(1, Math.ceil(bestChunk.totalQueryTerms * 0.4));

  if ((bestChunk.chunkMatchedTerms || 0) < minimumChunkTermMatches) {
    return {
      status: "not_found",
      answer: NOT_FOUND_MESSAGE,
      citations: [],
    };
  }

  if (!isAiConfigured) {
    return {
      status: "ai_not_configured",
      answer: AI_NOT_CONFIGURED_MESSAGE,
      citations: [],
    };
  }

  const citations = buildCitationsFromChunks(chunks);

  if (!citations.length) {
    return {
      status: "not_found",
      answer: NOT_FOUND_MESSAGE,
      citations: [],
    };
  }

  const answerText = await generateAnswerText({
    question: normalizedQuestion,
    chunks,
    citations,
  });

  if (!answerText || answerText === NOT_FOUND_MESSAGE) {
    return {
      status: "not_found",
      answer: NOT_FOUND_MESSAGE,
      citations: [],
    };
  }

  return {
    status: "answered",
    answer: answerText,
    citations,
  };
}
