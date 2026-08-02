import { config } from "../../config.js";
import { buildModelTuning } from "../openAiModelCapabilities.js";
import { reserveAiCall } from "../aiUsageBudget.js";

export const OPENAI_STREAM_IDLE_MESSAGE =
  "The AI model stopped responding and the request was cancelled. Please try again.";

/**
 * A provider-side failure the planner can classify rather than guess at.
 *
 * Carries the `code`/`reason` pair the agent forwards to the browser, so an
 * incomplete or unparseable turn is reported as a failed run instead of being
 * silently absorbed into a "completed" plan.
 */
export class ResponsesStreamError extends Error {
  /**
   * @param {string} message
   * @param {{ code: string, reason: string }} classification
   */
  constructor(message, { code, reason }) {
    super(message);
    this.name = "ResponsesStreamError";
    this.code = code;
    this.reason = reason;
  }
}

// Streaming client for the OpenAI Responses API (current, non-deprecated API).
//
// We talk to the Responses endpoint directly with `fetch`, matching this repo's
// existing convention in aiAnswerService.js (no heavy SDK dependency). The only
// difference is we set `stream: true` and parse the Server-Sent-Events body so
// the agent can emit progressive text deltas and detect function (tool) calls.
//
// The agent runtime depends only on the small async-generator interface
// `streamTurn(...)` exported here, so it can be swapped for a mock in tests.

function parseSseBuffer(buffer) {
  // Returns { events, rest } where events is an array of parsed JSON data
  // objects and rest is the unconsumed tail of the buffer.
  const events = [];
  let working = buffer;
  let separatorIndex = working.indexOf("\n\n");

  while (separatorIndex !== -1) {
    const rawEvent = working.slice(0, separatorIndex);
    working = working.slice(separatorIndex + 2);

    const dataLines = rawEvent
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim());

    if (dataLines.length) {
      const dataText = dataLines.join("\n");

      if (dataText && dataText !== "[DONE]") {
        try {
          events.push(JSON.parse(dataText));
        } catch {
          // Ignore partial / non-JSON keep-alive payloads.
        }
      }
    }

    separatorIndex = working.indexOf("\n\n");
  }

  return { events, rest: working };
}

/**
 * @param {{
 *   model?: string,
 *   instructions?: string,
 *   input?: any,
 *   tools?: any,
 *   apiKey?: string,
 *   signal?: AbortSignal,
 *   idleTimeoutMs?: number,
 *   reserveCall?: () => void,
 *   fetchImpl?: typeof fetch,
 * }} [options]
 */
export async function* streamResponsesTurn({
  model = config.openAiAnswerModel,
  instructions,
  input,
  tools,
  apiKey = config.openAiApiKey,
  signal,
  idleTimeoutMs = config.openAiStreamIdleTimeoutMs,
  reserveCall = reserveAiCall,
  fetchImpl = fetch,
} = {}) {
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not configured.");
  }

  // Count this streamed turn against the daily ceiling before spending on it.
  reserveCall();

  // Abort a stalled stream: an internal controller fires if no bytes arrive for
  // idleTimeoutMs. It is composed with the caller's signal (client disconnect)
  // so either can cancel the request. An idle abort surfaces as a clear error;
  // a caller abort still surfaces as AbortError (a normal disconnect).
  const idleController = new AbortController();
  let idledOut = false;
  let idleTimer = null;
  const armIdleTimer = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
    }
    idleTimer = setTimeout(() => {
      idledOut = true;
      idleController.abort();
    }, idleTimeoutMs);
  };

  const combinedSignal = signal
    ? AbortSignal.any([signal, idleController.signal])
    : idleController.signal;

  try {
    armIdleTimer();

    const response = await fetchImpl("https://api.openai.com/v1/responses", {
      method: "POST",
      signal: combinedSignal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        instructions,
        input,
        tools,
        // Same model-aware rule as the non-streaming paths. This request never
        // sent temperature, so on a classic model this is a no-op beyond making
        // the omission explicit.
        ...buildModelTuning(model),
        stream: true,
        max_output_tokens: config.openAiMaxOutputTokens,
      }),
    });

    if (!response.ok || !response.body) {
      const errorText = response.body ? await response.text() : "";
      throw new Error(`OpenAI request failed (${response.status}): ${errorText}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    // Function calls are held back until the provider says the response is
    // complete.
    //
    // A truncated response can still contain a syntactically valid function
    // call -- the model was cut off mid-plan, but the call it had already
    // emitted looks fine. Executing it would apply half a plan and then report
    // the run as finished. Buffering means a turn that never completes executes
    // nothing. Text deltas still stream as they arrive; they are display-only.
    const pendingCalls = [];
    let sawCompleted = false;

    try {
      reading: while (true) {
        const { value, done } = await reader.read();

        if (done) {
          break;
        }

        // Bytes arrived: restart the idle window.
        armIdleTimer();

        buffer += decoder.decode(value, { stream: true });
        const { events, rest } = parseSseBuffer(buffer);
        buffer = rest;

        for (const event of events) {
          if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
            yield { type: "text_delta", text: event.delta };
            continue;
          }

          if (event.type === "response.output_item.done" && event.item?.type === "function_call") {
            let parsedArguments;

            try {
              parsedArguments = event.item.arguments ? JSON.parse(event.item.arguments) : {};
            } catch {
              // Previously this became `{}` and the tool ran with no arguments,
              // turning a garbled request into a silently wrong result.
              throw new ResponsesStreamError(
                `Could not parse arguments for tool "${event.item.name}".`,
                { code: "planner_invalid_output", reason: "malformed_tool_arguments" }
              );
            }

            pendingCalls.push({
              type: "function_call",
              callId: event.item.call_id,
              name: event.item.name,
              arguments: parsedArguments,
            });
            continue;
          }

          if (event.type === "response.completed") {
            sawCompleted = true;
            break reading;
          }

          if (event.type === "response.incomplete") {
            throw new ResponsesStreamError(
              event.response?.incomplete_details?.reason
                ? `OpenAI response incomplete: ${event.response.incomplete_details.reason}`
                : "OpenAI response incomplete.",
              { code: "planner_incomplete", reason: "provider_incomplete" }
            );
          }

          if (event.type === "response.failed" || event.type === "error") {
            throw new Error(event.response?.error?.message || event.message || "OpenAI stream failed.");
          }
        }
      }
    } finally {
      reader.releaseLock?.();
    }

    // The stream ended without the provider ever confirming the response was
    // complete. Treat it as truncation rather than as a finished turn.
    if (!sawCompleted) {
      throw new ResponsesStreamError("OpenAI stream ended without a completion event.", {
        code: "planner_incomplete",
        reason: "missing_terminal_event",
      });
    }

    yield* pendingCalls;
  } catch (error) {
    // An idle-timeout abort is a stalled stream, not a client disconnect: surface
    // a clear message. A caller-initiated abort keeps its AbortError so the route
    // can treat it as a normal disconnect.
    if (idledOut) {
      throw new Error(OPENAI_STREAM_IDLE_MESSAGE, { cause: error });
    }

    throw error;
  } finally {
    if (idleTimer) {
      clearTimeout(idleTimer);
    }
  }
}
