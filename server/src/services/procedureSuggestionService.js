// Suggest existing repair procedures for a symptom.
//
// Two modes behind one seam, mirroring the Ask service:
//   1. Deterministic fallback (default, no API key): rank stored procedures by
//      keyword/system overlap between the symptom text, the procedure text, and
//      the document chunks retrieved for the symptom. Always available.
//   2. LLM-assisted (only when OPENAI_API_KEY is set): ask the model to rank the
//      candidate procedures using the retrieved chunks. Every model suggestion
//      must cite a retrieved chunk; anything malformed or ungrounded falls back
//      to the deterministic ranking so the route never breaks.
//
// The model can only point at procedures that already exist (it is handed a
// fixed candidate list of ids) -- it never creates a new procedure here.

import { config } from "../config.js";
import {
  retrieveRelevantChunks,
  tokenizeQuestion,
} from "./chunkRetrievalService.js";

const DEFAULT_CHUNK_LIMIT = 8;
const DEFAULT_SUGGESTION_LIMIT = 5;

/** Build one search/grounding query from the symptom fields. */
export function buildSuggestionQuery(symptom) {
  return [
    symptom?.title,
    symptom?.description,
    symptom?.suspectedCauses,
    symptom?.system,
  ]
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean)
    .join(" ")
    .trim();
}

/** All searchable text on a candidate procedure, used for keyword overlap. */
function procedureText(procedure) {
  return [
    procedure?.title,
    procedure?.system,
    procedure?.toolsNeeded,
    procedure?.partsNeeded,
    procedure?.safetyNotes,
    procedure?.steps,
    procedure?.notes,
  ]
    .map((value) => (typeof value === "string" ? value : ""))
    .join(" ");
}

function buildChunkTokenSet(chunks) {
  const tokens = new Set();

  for (const chunk of chunks) {
    for (const term of tokenizeQuestion(chunk.chunkText || "")) {
      tokens.add(term);
    }
  }

  return tokens;
}

function buildSnippet(text) {
  const normalized = typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";

  if (!normalized) {
    return "";
  }

  return normalized.length > 220 ? `${normalized.slice(0, 217)}...` : normalized;
}

function buildCitationsFromChunks(chunks) {
  return (Array.isArray(chunks) ? chunks : []).map((chunk) => ({
    documentId: chunk.documentId,
    documentTitle: chunk.documentTitle,
    originalFilename: chunk.originalFilename,
    pageNumber: chunk.pageNumber,
    chunkIndex: chunk.chunkIndex,
    snippet: buildSnippet(chunk.chunkText),
  }));
}

/** Cite the retrieved chunks whose text contains one of the grounded terms. */
function citationsForTerms(chunks, terms) {
  if (!terms.length) {
    return [];
  }

  const lowerTerms = terms.map((term) => term.toLowerCase());

  return buildCitationsFromChunks(
    chunks.filter((chunk) => {
      const text = (chunk.chunkText || "").toLowerCase();
      return lowerTerms.some((term) => text.includes(term));
    })
  );
}

function scoreCandidate({ queryTokens, chunkTokenSet, symptomSystem, procedure }) {
  const procedureTokens = new Set(tokenizeQuestion(procedureText(procedure)));
  const sharedTerms = queryTokens.filter((term) => procedureTokens.has(term));
  const groundedTerms = sharedTerms.filter((term) => chunkTokenSet.has(term));
  const systemMatch =
    Boolean(symptomSystem) &&
    Boolean(procedure.system) &&
    symptomSystem.toLowerCase() === procedure.system.toLowerCase();

  const score =
    sharedTerms.length * 3 + groundedTerms.length * 2 + (systemMatch ? 5 : 0);

  return { score, sharedTerms, groundedTerms, systemMatch };
}

function buildDeterministicReason({ sharedTerms, groundedTerms, systemMatch, procedure }) {
  const parts = [];

  if (systemMatch) {
    parts.push(`same system (${procedure.system})`);
  }

  if (sharedTerms.length) {
    parts.push(`shares terms: ${sharedTerms.slice(0, 5).join(", ")}`);
  }

  if (groundedTerms.length) {
    parts.push("found in retrieved manual text");
  }

  if (!parts.length) {
    return "Related to this symptom.";
  }

  const reason = parts.join("; ");
  return `${reason.charAt(0).toUpperCase()}${reason.slice(1)}.`;
}

function deterministicSuggestions({ symptom, candidates, chunks, queryTokens, limit }) {
  const chunkTokenSet = buildChunkTokenSet(chunks);
  const symptomSystem = symptom?.system || "";

  return candidates
    .map((procedure) => ({
      procedure,
      ...scoreCandidate({ queryTokens, chunkTokenSet, symptomSystem, procedure }),
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.procedure.id - right.procedure.id)
    .slice(0, limit)
    .map((item) => ({
      procedureId: item.procedure.id,
      title: item.procedure.title,
      system: item.procedure.system || "",
      difficulty: item.procedure.difficulty || "intermediate",
      reason: buildDeterministicReason({
        sharedTerms: item.sharedTerms,
        groundedTerms: item.groundedTerms,
        systemMatch: item.systemMatch,
        procedure: item.procedure,
      }),
      source: "keyword",
      citations: citationsForTerms(chunks, item.groundedTerms),
    }));
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
 * Turn a model reply into grounded suggestions, or null when nothing usable is
 * found. Each kept item must reference a real candidate id and a real chunk.
 */
function parseLlmSuggestions(rawText, { candidates, chunks, limit }) {
  const parsedArray = extractJsonArray(rawText);

  if (!parsedArray) {
    return null;
  }

  const candidateById = new Map(candidates.map((candidate) => [Number(candidate.id), candidate]));
  const suggestions = [];
  const usedIds = new Set();

  for (const item of parsedArray) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const procedureId = Number(item.procedureId);

    if (!candidateById.has(procedureId) || usedIds.has(procedureId)) {
      continue;
    }

    const chunkNumber = Number(item.chunkNumber);
    const chunk = Number.isInteger(chunkNumber) ? chunks[chunkNumber - 1] : undefined;

    if (!chunk) {
      // A suggestion that cannot point at a retrieved chunk is dropped.
      continue;
    }

    const candidate = candidateById.get(procedureId);
    const reason =
      typeof item.reason === "string" && item.reason.trim()
        ? item.reason.trim()
        : "Supported by the retrieved manual text.";

    suggestions.push({
      procedureId,
      title: candidate.title,
      system: candidate.system || "",
      difficulty: candidate.difficulty || "intermediate",
      reason,
      source: "llm",
      citations: buildCitationsFromChunks([chunk]),
    });
    usedIds.add(procedureId);

    if (suggestions.length >= limit) {
      break;
    }
  }

  return suggestions;
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
 * Ask OpenAI to rank candidate procedures using the retrieved chunks. Returns
 * the raw model text; the caller parses and grounds it defensively.
 *
 * @param {{ symptomSummary: string, chunks: any[], candidates: any[] }} params
 * @returns {Promise<string>}
 */
export async function generateProcedureSuggestionsFromOpenAi({
  symptomSummary,
  chunks,
  candidates,
}) {
  const contextText = chunks
    .map(
      (chunk, index) =>
        `[${index + 1}] ${chunk.documentTitle} (${chunk.originalFilename}) page ${
          chunk.pageNumber
        }: ${chunk.chunkText}`
    )
    .join("\n\n");

  const candidateText = candidates
    .map(
      (candidate) =>
        `#${candidate.id} ${candidate.title}${
          candidate.system ? ` (system: ${candidate.system})` : ""
        }`
    )
    .join("\n");

  const prompt = [
    "You match a Toyota Corolla symptom to existing saved repair procedures.",
    "Only choose from the candidate procedures listed by id. Never invent a procedure or an id.",
    "Only suggest a procedure when the numbered manual chunks support it being relevant to the symptom.",
    'Return ONLY a JSON array. Each item: {"procedureId": <id>, "reason": <one short sentence>, "chunkNumber": <number of the supporting chunk>}.',
    "Rank the most relevant procedure first. Return at most 5 items.",
    "If no candidate procedure is supported by the chunks, return [].",
    "",
    `Symptom: ${symptomSummary}`,
    "",
    "Candidate procedures:",
    candidateText,
    "",
    "Manual chunks:",
    contextText,
  ].join("\n");

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.openAiApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.openAiAnswerModel,
      input: prompt,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `OpenAI procedure suggestion failed (${response.status}): ${errorText}`
    );
  }

  return parseOpenAiOutputText(await response.json());
}

/**
 * Suggest existing procedures for one symptom.
 *
 * @param {any} symptom - mapped symptom (title/description/suspectedCauses/system)
 * @param {any[]} candidates - mapped candidate procedures for the same vehicle
 * @param {{
 *   isAiConfigured?: boolean,
 *   retrieveChunks?: Function,
 *   generateSuggestions?: Function,
 *   chunkLimit?: number,
 *   suggestionLimit?: number,
 * }} [options]
 */
export async function suggestProceduresForSymptom(
  symptom,
  candidates,
  {
    isAiConfigured = Boolean(config.openAiApiKey),
    retrieveChunks = retrieveRelevantChunks,
    generateSuggestions = generateProcedureSuggestionsFromOpenAi,
    chunkLimit = DEFAULT_CHUNK_LIMIT,
    suggestionLimit = DEFAULT_SUGGESTION_LIMIT,
  } = {}
) {
  const query = buildSuggestionQuery(symptom);
  const safeCandidates = Array.isArray(candidates) ? candidates : [];

  if (!query || !safeCandidates.length) {
    return {
      status: "not_found",
      mode: "deterministic",
      aiConfigured: isAiConfigured,
      query,
      suggestions: [],
      citations: [],
    };
  }

  // Keyword retrieval grounds both modes and needs no API key.
  const chunks = await retrieveChunks(query, { limit: chunkLimit, mode: "keyword" });
  const queryTokens = tokenizeQuestion(query);
  const citations = buildCitationsFromChunks(chunks);

  const fallback = () => {
    const suggestions = deterministicSuggestions({
      symptom,
      candidates: safeCandidates,
      chunks,
      queryTokens,
      limit: suggestionLimit,
    });

    return {
      status: suggestions.length ? "answered" : "not_found",
      mode: "deterministic",
      aiConfigured: isAiConfigured,
      query,
      suggestions,
      citations,
    };
  };

  // Without a key, or without any chunk context to ground against, stay
  // deterministic.
  if (!isAiConfigured || !chunks.length) {
    return fallback();
  }

  let rawText;

  try {
    rawText = await generateSuggestions({
      symptomSummary: query,
      chunks,
      candidates: safeCandidates,
    });
  } catch {
    return fallback();
  }

  const llmSuggestions = parseLlmSuggestions(rawText, {
    candidates: safeCandidates,
    chunks,
    limit: suggestionLimit,
  });

  if (!llmSuggestions || !llmSuggestions.length) {
    return fallback();
  }

  return {
    status: "answered",
    mode: "llm",
    aiConfigured: isAiConfigured,
    query,
    suggestions: llmSuggestions,
    citations,
  };
}
