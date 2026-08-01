// Shared, FAIL-CLOSED parsing for OpenAI Responses API payloads.
//
// This is deliberately a LEAF module: it imports nothing, so aiAnswerService,
// chunkRerankService, and procedureSuggestionService can all share it without
// deepening the existing aiAnswerService -> chunkRetrievalService ->
// chunkRerankService -> aiAnswerService import cycle. Before this module the
// same extraction body was copy-pasted into all three services, so a truncation
// or usage fix had to be made in three places or not at all.
//
// Fail-closed contract: a payload yields text ONLY when the provider says the
// response finished (`status: "completed"`) AND at least one well-formed,
// non-empty output_text string is present. Anything else -- an unfinished or
// cancelled response, a refusal, malformed content, or no usable text -- is
// classified as a typed failure and yields NO text. Half a repair procedure
// reads exactly like a whole one, so partial output must never reach the user.
//
// Two channels, deliberately separated:
//   failure.message    -- SAFE, user-facing. Never contains provider internals.
//   failure.diagnostic -- internal detail for a developer. Never sent to the
//                         client and never logged by this module.
// Nothing here logs; no model payload, prompt, retrieved chunk, or document text
// is ever emitted.

const SUCCESS_STATUS = "completed";

// Cap anything provider-supplied that we retain, so a diagnostic can never grow
// into a dump of echoed request content.
const MAX_DIAGNOSTIC_LENGTH = 200;

const SAFE_MESSAGES = {
  truncated:
    "The AI reply was cut off before it finished, so it was not shown. Please try again or ask a narrower question.",
  content_filter:
    "The AI stopped this reply partway through. Please rephrase the question and try again.",
  incomplete: "The AI did not finish this reply. Please try again.",
  in_progress: "The AI reply is still being generated. Please try again.",
  queued: "The AI request has not started yet. Please try again.",
  cancelled: "The AI request was cancelled before it finished. Please try again.",
  failed: "The AI request failed before completing. Please try again.",
  unknown_status: "The AI reply could not be confirmed as complete, so it was not shown.",
  refusal: "The AI declined to answer this question.",
  empty_output: "The AI returned no usable answer text. Please try again.",
  malformed_output: "The AI reply was not in a readable format, so it was not shown.",
  http_error: "The AI service rejected the request. Please try again.",
};

/**
 * Build a redacted Error for a non-2xx OpenAI HTTP response.
 *
 * The provider body can echo the prompt -- which here means the user's question
 * and retrieved document passages -- and ask.js serializes `error.message`
 * straight to the browser. So the message is a fixed generic string, and the
 * body is retained only as a bounded diagnostic on `error.failure`, which the
 * route never reads. Nothing here logs.
 *
 * @param {number|string} status HTTP status code
 * @param {string} body Raw provider response body (never surfaced)
 * @returns {Error}
 */
export function createRedactedOpenAiHttpError(status, body) {
  const error = new Error(SAFE_MESSAGES.http_error);
  // @ts-expect-error -- diagnostic detail intentionally attached to the Error
  error.failure = {
    kind: "http_error",
    reason: `http_${status}`,
    message: SAFE_MESSAGES.http_error,
    // Bounded, and never returned to the client.
    diagnostic: truncateDiagnostic(body),
    httpStatus: Number(status) || 0,
    usage: null,
  };

  return error;
}

function truncateDiagnostic(value) {
  const text = typeof value === "string" ? value.trim() : "";

  if (!text) {
    return "";
  }

  return text.length > MAX_DIAGNOSTIC_LENGTH
    ? `${text.slice(0, MAX_DIAGNOSTIC_LENGTH)}...`
    : text;
}

function fail(kind, { reason = kind, diagnostic = "", usage = null } = {}) {
  return {
    ok: false,
    text: "",
    usage,
    failure: {
      kind,
      reason,
      // Safe by construction: chosen from a fixed table, never provider text.
      message: SAFE_MESSAGES[kind] || SAFE_MESSAGES.unknown_status,
      diagnostic,
      usage,
    },
  };
}

/**
 * Log-safe token counts, or null when the provider omitted usage.
 * Missing/!partial usage must never throw -- it is metadata, not a gate.
 *
 * @param {any} payload
 * @returns {{ inputTokens: number, outputTokens: number, totalTokens: number } | null}
 */
export function readOpenAiUsage(payload) {
  const usage = payload?.usage;

  if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
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
 * First refusal string in the payload, or "" when the model did not refuse.
 * A refusal part carries no output_text, so without this a refusal would be
 * indistinguishable from an empty answer.
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

// An `incomplete` response explains itself via incomplete_details.reason. Match
// defensively: the documented values are max_output_tokens and content_filter,
// but treat any token/length-shaped reason as truncation rather than falling
// through to a vaguer classification.
function classifyIncompleteReason(reason) {
  const normalized = typeof reason === "string" ? reason.trim().toLowerCase() : "";

  if (!normalized) {
    return { kind: "incomplete", reason: "unknown" };
  }

  if (/token|length|limit|truncat/.test(normalized)) {
    return { kind: "truncated", reason: normalized };
  }

  if (/filter|policy|moderat/.test(normalized)) {
    return { kind: "content_filter", reason: normalized };
  }

  return { kind: "incomplete", reason: normalized };
}

/**
 * Collect well-formed output_text strings from `output[].content[]`.
 *
 * Returns { malformed: true } when a part CLAIMS to be output_text but carries a
 * non-string `text` (object, array, number, ...). That is a payload we do not
 * understand, and coercing it with String() would render "[object Object]" as if
 * it were an answer -- so it fails closed instead. Parts of other types
 * (refusal, reasoning, ...) are simply not text and are skipped, not treated as
 * malformed. Multiple output items are flattened in order.
 *
 * @param {any} payload
 * @returns {{ malformed: boolean, unfinished: string, parts: string[] }}
 */
function collectNestedOutputText(payload) {
  const parts = [];

  if (!Array.isArray(payload?.output)) {
    return { malformed: false, unfinished: "", parts };
  }

  for (const item of payload.output) {
    // An output MESSAGE carries its own status. A top-level "completed" only
    // means the response object finished; an individual message inside it can
    // still be incomplete or cancelled, and its text would then be partial.
    // Trusting the outer status alone would render half a procedure.
    const itemStatus = typeof item?.status === "string" ? item.status.trim() : "";

    if (itemStatus && itemStatus !== SUCCESS_STATUS) {
      return { malformed: false, unfinished: itemStatus, parts: [] };
    }

    if (!Array.isArray(item?.content)) {
      continue;
    }

    for (const content of item.content) {
      if (content?.type !== "output_text") {
        continue;
      }

      if (typeof content.text !== "string") {
        return { malformed: true, unfinished: "", parts: [] };
      }

      const text = content.text.trim();

      if (text) {
        parts.push(text);
      }
    }
  }

  return { malformed: false, unfinished: "", parts };
}

/**
 * Do the flattened and nested representations tell the same story?
 *
 * `output_text` is a convenience flattening of the nested output. When both are
 * present they must agree; if they do not, we cannot tell which one reflects
 * what the model actually produced, so we fail closed rather than picking the
 * more convenient one. Comparison is whitespace-insensitive because the
 * flattening joins parts with its own separators.
 */
function flattenedAgreesWithNested(flattened, parts) {
  const normalize = (value) => value.replace(/\s+/g, " ").trim();
  const flat = normalize(flattened);
  const joined = normalize(parts.join(" "));

  if (!joined) {
    return true;
  }

  return flat === joined || normalize(flat).includes(joined) || joined.includes(flat);
}

/**
 * Fail-closed read of a Responses API payload.
 *
 * @param {any} payload
 * @returns {{ ok: boolean, text: string, usage: any, failure?: any }}
 */
export function readOpenAiResponse(payload) {
  const usage = readOpenAiUsage(payload);
  const status = typeof payload?.status === "string" ? payload.status.trim() : "";

  // 1. Status gate FIRST, so partial text from an unfinished response is never
  //    even considered, let alone returned.
  if (status === "incomplete") {
    const { kind, reason } = classifyIncompleteReason(payload?.incomplete_details?.reason);
    return fail(kind, { reason, usage });
  }

  if (status === "failed") {
    // The provider message can echo request content, so it is retained only as a
    // bounded internal diagnostic. The client sees SAFE_MESSAGES.failed.
    const providerCode = truncateDiagnostic(payload?.error?.code || payload?.error?.type);
    const providerMessage = truncateDiagnostic(payload?.error?.message);

    return fail("failed", {
      reason: providerCode || "unknown",
      diagnostic: providerMessage,
      usage,
    });
  }

  if (status === "in_progress" || status === "queued" || status === "cancelled") {
    return fail(status, { usage });
  }

  if (status !== SUCCESS_STATUS) {
    // Includes an absent status. We cannot confirm the reply finished, so we do
    // not show it.
    return fail("unknown_status", { reason: status || "absent", usage });
  }

  // 2. A completed response may still be a refusal, which carries no text.
  const refusal = parseOpenAiRefusal(payload);

  if (refusal) {
    return fail("refusal", { reason: "refusal", diagnostic: truncateDiagnostic(refusal), usage });
  }

  // 3. Validate the NESTED output first, always. A nonblank top-level
  //    output_text must not be able to paper over nested output that is
  //    incomplete, cancelled, or malformed.
  const { malformed, unfinished, parts } = collectNestedOutputText(payload);

  if (malformed) {
    return fail("malformed_output", { reason: "output_text_part_not_a_string", usage });
  }

  if (unfinished) {
    // The response object finished, but one of its messages did not.
    return fail("incomplete", { reason: `output_message_${unfinished}`, usage });
  }

  if (payload?.output_text !== undefined && typeof payload.output_text !== "string") {
    // Present but not a string: malformed rather than absent.
    return fail("malformed_output", { reason: "output_text_not_a_string", usage });
  }

  // A blank output_text is treated as ABSENT so valid nested text can serve.
  const flattened = typeof payload?.output_text === "string" ? payload.output_text.trim() : "";

  if (flattened) {
    if (!flattenedAgreesWithNested(flattened, parts)) {
      return fail("malformed_output", { reason: "flattened_nested_mismatch", usage });
    }

    return { ok: true, text: flattened, usage };
  }

  if (!parts.length) {
    return fail("empty_output", { usage });
  }

  return { ok: true, text: parts.join("\n"), usage };
}

/**
 * Classify a payload that must not be treated as a finished answer.
 * Returns null when the response completed with usable text.
 *
 * @param {any} payload
 * @returns {{ kind: string, reason: string, message: string, diagnostic: string, usage: any } | null}
 */
export function describeOpenAiFailure(payload) {
  const result = readOpenAiResponse(payload);
  return result.ok ? null : result.failure;
}

/**
 * Extract assistant text, or throw when the reply did not finish cleanly.
 *
 * The thrown Error's `message` is the SAFE user-facing string (ask.js returns it
 * to the client verbatim). Internal detail rides on `.failure.diagnostic` and is
 * never part of the message.
 *
 * The reranker and the suggestion service both already catch and fall back, so
 * throwing degrades them safely to their deterministic paths.
 *
 * @param {any} payload
 * @returns {string}
 */
export function parseCompleteOpenAiOutputText(payload) {
  const result = readOpenAiResponse(payload);

  if (!result.ok) {
    const error = new Error(result.failure.message);
    // @ts-expect-error -- diagnostic detail intentionally attached to the Error
    error.failure = result.failure;
    throw error;
  }

  return result.text;
}
