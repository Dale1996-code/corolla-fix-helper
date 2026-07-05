// Minimal, dependency-free tracer for the repair-planning agent.
//
// It records ordered spans (one per agent step / tool call / model turn) into an
// in-memory buffer and optionally logs them to the console when AGENT_TRACE is
// enabled. The spans are also streamed to the client as `trace` events so the UI
// can show what the agent did. This is the idiomatic, lightweight observability
// hook for this codebase, which deliberately avoids heavy SDK dependencies.

function now() {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

/**
 * @param {{ enabled?: boolean, onSpan?: (span: {
 *   id: number,
 *   name: string,
 *   durationMs: number | null,
 *   attributes: Record<string, any>,
 * }) => void }} [options]
 */
export function createTracer({ enabled = process.env.AGENT_TRACE === "1", onSpan } = {}) {
  const spans = [];
  let counter = 0;

  function startSpan(name, attributes = {}) {
    counter += 1;
    const span = {
      id: counter,
      name,
      attributes,
      startedAt: now(),
      endedAt: null,
      durationMs: null,
    };
    spans.push(span);

    if (enabled) {
      console.log(`[agent-trace] start ${name}`, attributes);
    }

    return {
      end(endAttributes = {}) {
        span.endedAt = now();
        span.durationMs = Math.round((span.endedAt - span.startedAt) * 100) / 100;
        span.attributes = { ...span.attributes, ...endAttributes };

        if (enabled) {
          console.log(`[agent-trace] end   ${name} (${span.durationMs}ms)`, endAttributes);
        }

        if (typeof onSpan === "function") {
          onSpan({
            id: span.id,
            name: span.name,
            durationMs: span.durationMs,
            attributes: span.attributes,
          });
        }

        return span;
      },
    };
  }

  return {
    startSpan,
    getSpans: () => spans.map((span) => ({ ...span })),
  };
}
