import { config } from "../../config.js";

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

export async function* streamResponsesTurn({
  model = config.openAiModel,
  instructions,
  input,
  tools,
  apiKey = config.openAiApiKey,
  signal,
  fetchImpl = fetch,
} = {}) {
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not configured.");
  }

  const response = await fetchImpl("https://api.openai.com/v1/responses", {
    method: "POST",
    signal,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      instructions,
      input,
      tools,
      stream: true,
    }),
  });

  if (!response.ok || !response.body) {
    const errorText = response.body ? await response.text() : "";
    throw new Error(`OpenAI request failed (${response.status}): ${errorText}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();

      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const { events, rest } = parseSseBuffer(buffer);
      buffer = rest;

      for (const event of events) {
        if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
          yield { type: "text_delta", text: event.delta };
          continue;
        }

        if (event.type === "response.output_item.done" && event.item?.type === "function_call") {
          let parsedArguments = {};

          try {
            parsedArguments = event.item.arguments ? JSON.parse(event.item.arguments) : {};
          } catch {
            parsedArguments = {};
          }

          yield {
            type: "function_call",
            callId: event.item.call_id,
            name: event.item.name,
            arguments: parsedArguments,
          };
          continue;
        }

        if (event.type === "response.failed" || event.type === "error") {
          throw new Error(event.response?.error?.message || event.message || "OpenAI stream failed.");
        }
      }
    }
  } finally {
    reader.releaseLock?.();
  }
}
