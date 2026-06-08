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

    // Stop the agent if the client disconnects mid-stream.
    const abortController = new AbortController();
    request.on("close", () => abortController.abort());

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
      send({ type: "error", message: error.message || "The repair planner failed." });
    } finally {
      response.end();
    }
  });

  return router;
}

export const repairPlanRouter = createRepairPlanRouter();
