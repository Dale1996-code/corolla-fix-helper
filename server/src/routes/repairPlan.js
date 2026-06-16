import { Router } from "express";
import { runRepairPlannerAgent } from "../services/agent/repairPlannerAgent.js";

// Streaming repair-plan endpoint.
//
// POST /api/repair-plan responds with Server-Sent Events. Each agent event is
// written as a single `data: <json>\n\n` frame, so the frontend can show tool
// progress and model text deltas as they happen. `runAgent` is injectable so
// the route can be tested end-to-end with a mock model client.

export function createRepairPlanRouter({ runAgent = runRepairPlannerAgent } = {}) {
  const router = Router();

  router.post("/", async (request, response) => {
    const brief = typeof request.body?.brief === "string" ? request.body.brief.trim() : "";

    if (!brief) {
      response.status(400).json({ error: "A repair brief is required." });
      return;
    }

    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const send = (event) => {
      response.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    // Stop the agent only when the client actually disconnects mid-stream.
    //
    // Do NOT wire abort to the *request*'s "close" event: Node emits that as
    // soon as the request body has been read (right after `express.json()`
    // parses the POST), which is not a disconnect. Aborting there cancels the
    // in-flight OpenAI request the moment the SSE response starts streaming,
    // which surfaces as a spurious "This operation was aborted" error.
    //
    // The *response* stream instead stays open for the whole SSE session and
    // only closes when the client genuinely goes away. Guard on
    // `writableFinished` so a normal end (we called `response.end()`) never
    // triggers an abort.
    const abortController = new AbortController();
    response.on("close", () => {
      if (!response.writableFinished) {
        abortController.abort();
      }
    });

    try {
      await runAgent(
        {
          brief,
          constraints: request.body?.constraints,
          availableTools: request.body?.availableTools,
          availableParts: request.body?.availableParts,
          skillLevel: request.body?.skillLevel,
        },
        { emit: send, signal: abortController.signal }
      );
    } catch (error) {
      // A genuine client disconnect aborts the in-flight request; there is no
      // longer anyone to receive a frame, so end quietly instead of writing a
      // user-facing error to a dead socket. Real model/network failures still
      // surface verbatim.
      if (error?.name !== "AbortError") {
        send({ type: "error", message: error.message || "The repair planner failed." });
      }
    } finally {
      response.end();
    }
  });

  return router;
}

export const repairPlanRouter = createRepairPlanRouter();
