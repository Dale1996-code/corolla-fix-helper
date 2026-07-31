// Shared parsing for OpenAI Responses API payloads.
//
// This is deliberately a LEAF module: it imports nothing, so aiAnswerService,
// chunkRerankService, and procedureSuggestionService can all share it without
// deepening the existing aiAnswerService -> chunkRetrievalService ->
// chunkRerankService -> aiAnswerService import cycle. Before this module the
// same parseOpenAiOutputText body was copy-pasted into all three services, so a
// truncation or usage fix had to be made in three places or not at all.

// Module-local on purpose: callers branch on `failure.kind` (the stable typed
// discriminator) and read `failure.message` for the user-facing text, so there
// is nothing to gain from exporting these strings as well.
const OPENAI_TRUNCATED_MESSAGE =
  "The AI reply was cut off before it finished, so it was not shown. Please try again or ask a narrower question.";

const OPENAI_CONTENT_FILTER_MESSAGE =
  "The AI stopped this reply partway through. Please rephrase the question and try again.";

const OPENAI_INCOMPLETE_MESSAGE = "The AI did not finish this reply. Please try again.";

const OPENAI_REFUSED_MESSAGE = "The AI declined to answer this question.";

/**
 * Extract the assistant text from a Responses API payload.
 *
 * Behavior is unchanged from the three copies this replaces: prefer the
 * flattened `output_text`, otherwise walk `output[].content[]` for
 * `output_text` parts. It does NOT inspect status — callers that must not show
 * a half-finished reply should use parseCompleteOpenAiOutputText instead.
 *
 * @param {any} payload
 * @returns {string}
 */
export function parseOpenAiOutputText(payload) {
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
 * First refusal string in the payload, or "" when the model did not refuse.
 * A refusal part carries no output_text, so without this a refusal would look
 * identical to an empty answer.
 *
 * @param {any} payload
 * @returns {string}
 */
export function parseOpenAiRefusal(payload) {
  if (!Array.isArray(payload?.output)) {
    return "";
  }

  for (const item of payload.output) {
    if (!Array.isArray(item?.content)) {
      continue;
    }

    for (const content of item.content) {
      if (content?.type === "refusal" && typeof content.refusal === "string") {
        const refusal = content.refusal.trim();

        if (refusal) {
          return refusal;
        }
      }
    }
  }

  return "";
}

/**
 * Log-safe token counts. Never contains document text.
 *
 * @param {any} payload
 * @returns {{ inputTokens: number, outputTokens: number, totalTokens: number } | null}
 */
export function readOpenAiUsage(payload) {
  const usage = payload?.usage;

  if (!usage || typeof usage !== "object") {
    return null;
  }

  const toCount = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

  return {
    inputTokens: toCount(usage.input_tokens),
    outputTokens: toCount(usage.output_tokens),
    totalTokens: toCount(usage.total_tokens),
  };
}

/**
 * Classify a payload that must not be treated as a finished answer.
 *
 * Returns null when the response completed normally. A payload with no `status`
 * field is treated as complete, which keeps every existing stubbed test payload
 * (`{ output_text: "..." }`) on exactly the path it took before.
 *
 * @param {any} payload
 * @returns {{ kind: string, reason: string, message: string, usage: any } | null}
 */
export function describeOpenAiFailure(payload) {
  const status = typeof payload?.status === "string" ? payload.status : "";
  const usage = readOpenAiUsage(payload);

  if (status === "incomplete") {
    const reason =
      typeof payload?.incomplete_details?.reason === "string"
        ? payload.incomplete_details.reason
        : "unknown";

    if (reason === "max_output_tokens") {
      return { kind: "truncated", reason, message: OPENAI_TRUNCATED_MESSAGE, usage };
    }

    if (reason === "content_filter") {
      return { kind: "content_filter", reason, message: OPENAI_CONTENT_FILTER_MESSAGE, usage };
    }

    return { kind: "incomplete", reason, message: OPENAI_INCOMPLETE_MESSAGE, usage };
  }

  if (status === "failed") {
    const reason =
      typeof payload?.error?.message === "string" && payload.error.message.trim()
        ? payload.error.message.trim()
        : "unknown";

    return {
      kind: "failed",
      reason,
      message: `The AI request failed before completing: ${reason}`,
      usage,
    };
  }

  const refusal = parseOpenAiRefusal(payload);

  if (refusal) {
    return { kind: "refusal", reason: refusal, message: OPENAI_REFUSED_MESSAGE, usage };
  }

  return null;
}

/**
 * Extract assistant text, but throw when the reply did not actually finish.
 *
 * A truncated repair answer is the dangerous case this exists for: half a
 * procedure reads exactly like a whole one, so it must never be presented as
 * complete. The thrown Error carries `.failure` (kind/reason/usage) for callers
 * that want to distinguish causes; the reranker and the suggestion service both
 * already catch and fall back, so throwing degrades them safely.
 *
 * @param {any} payload
 * @returns {string}
 */
export function parseCompleteOpenAiOutputText(payload) {
  const failure = describeOpenAiFailure(payload);

  if (failure) {
    const error = new Error(failure.message);
    // @ts-expect-error -- diagnostic detail intentionally attached to the Error
    error.failure = failure;
    throw error;
  }

  return parseOpenAiOutputText(payload);
}
