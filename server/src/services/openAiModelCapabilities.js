// Per-model request tuning for the Responses API.
//
// Different OpenAI model families accept different sampling controls, and
// sending an unsupported one is a hard 400 that fails the whole request. This
// module is the ONE place that decides which controls a given model gets, so
// the five call sites do not each grow their own string check.
//
// The rules below were derived from live probes against this account, not from
// assumption:
//
//   gpt-4.1-2025-04-14   temperature: 0        accepted
//   gpt-5.6-luna         temperature: 0        400 "Unsupported parameter:
//                                              'temperature' is not supported
//                                              with this model"
//   gpt-5.6-luna         reasoning.effort      accepted; supported values are
//                                              none, low, medium, high, xhigh, max
//                                              ('minimal' is rejected)
//
// A leaf module: it imports nothing.

/**
 * Reasoning-family models. These reject `temperature` outright and instead
 * expose `reasoning.effort`.
 *
 * Matched by family prefix rather than an exhaustive ID list, so a new snapshot
 * (gpt-5.6-luna, gpt-5.5-2026-04-23, ...) is handled without a code change. A
 * wrong guess here is self-correcting in the safe direction for classic models
 * and surfaces immediately as a 400 for new families, which is far better than
 * silently degrading answer quality.
 */
const REASONING_MODEL_PATTERN = /^(gpt-5|o[1-9])/i;

/**
 * Default reasoning effort for document-grounded answering.
 *
 * "low", deliberately. This app quotes and checks source text rather than
 * solving problems, so deep reasoning buys little -- and reasoning tokens are
 * billed against `max_output_tokens`, so a high effort can consume the budget
 * and truncate the actual answer. Truncation is handled correctly (it fails
 * closed) but it would surface to the owner as "the reply was cut off" rather
 * than an answer.
 */
export const DEFAULT_REASONING_EFFORT =
  process.env.OPENAI_REASONING_EFFORT || "low";

/** @param {string} model */
export function isReasoningModel(model) {
  return REASONING_MODEL_PATTERN.test(String(model || ""));
}

/** @param {string} model */
export function supportsTemperature(model) {
  return !isReasoningModel(model);
}

/**
 * Request fields that tune sampling for this model. Spread into the request
 * body; returns `{}` rather than throwing for an unknown model.
 *
 * Determinism note: on a classic model we pin `temperature: 0`, which makes
 * repeated identical questions return identical text. Reasoning models expose
 * no equivalent control -- temperature cannot be set at all -- so run-to-run
 * output is NOT byte-stable there. Fixing the reasoning effort is the closest
 * available control and keeps behavior bounded, but the eval suite should be
 * read accordingly: a wording change between runs is expected, a changed
 * specification value is not (and the evidence contract catches that).
 *
 * @param {string} model
 * @param {{ reasoningEffort?: string }} [options]
 * @returns {{ temperature?: number, reasoning?: { effort: string } }}
 */
export function buildModelTuning(model, { reasoningEffort = DEFAULT_REASONING_EFFORT } = {}) {
  if (!model) {
    return {};
  }

  if (isReasoningModel(model)) {
    return { reasoning: { effort: reasoningEffort } };
  }

  return { temperature: 0 };
}
