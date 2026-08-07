import { Router } from "express";
import { runRepairPlannerAgent, SKILL_LEVELS } from "../services/agent/repairPlannerAgent.js";
import { planRunStore } from "../services/agent/planRunStore.js";
import { buildOwnerChecklist, checkRepairReadiness } from "../services/agent/repairTools.js";

// Cap the brief (and each optional field) so a giant pasted payload cannot be
// forwarded to the model. Briefs are longer-form than an Ask question, hence the
// higher limit.
export const MAX_BRIEF_LENGTH = 4000;
export const MAX_PLAN_FIELD_LENGTH = 2000;

// Streaming repair-plan endpoint.
//
// POST /api/repair-plan responds with Server-Sent Events. Each agent event is
// written as a single `data: <json>\n\n` frame, so the frontend can show tool
// progress and model text deltas as they happen. `runAgent` is injectable so
// the route can be tested end-to-end with a mock model client.

export const PLAN_RUN_EXPIRED_MESSAGE =
  "That plan is no longer available to acknowledge. Build the plan again and acknowledge the warning on the new plan.";

export function createRepairPlanRouter({
  runAgent = runRepairPlannerAgent,
  planRuns = planRunStore,
  // The shared AI rate limiter guards plan GENERATION only. It caps accidental
  // OpenAI spend, and the acknowledgment route below spends nothing -- letting a
  // checkbox toggle consume slots out of the window shared with /api/ask would
  // charge the owner AI budget for reading a safety warning.
  aiRateLimiter = (_request, _response, next) => next(),
} = {}) {
  const router = Router();

  router.post("/", aiRateLimiter, async (request, response) => {
    const brief = typeof request.body?.brief === "string" ? request.body.brief.trim() : "";

    if (!brief) {
      response.status(400).json({ error: "A repair brief is required." });
      return;
    }

    if (brief.length > MAX_BRIEF_LENGTH) {
      response.status(400).json({
        error: `Repair brief is too long. Keep it under ${MAX_BRIEF_LENGTH} characters.`,
      });
      return;
    }

    // Guard the optional free-text fields too, so none of them can smuggle a huge
    // payload past the brief cap.
    const oversizedField = ["constraints", "availableTools", "availableParts"].find(
      (field) =>
        typeof request.body?.[field] === "string" &&
        request.body[field].length > MAX_PLAN_FIELD_LENGTH
    );

    if (oversizedField) {
      response.status(400).json({
        error: `Field "${oversizedField}" is too long. Keep it under ${MAX_PLAN_FIELD_LENGTH} characters.`,
      });
      return;
    }

    // Reject an unrecognized skill level instead of silently treating it as
    // "beginner". Skill drives 30 of the 100 readiness points and the DIY vs
    // shop split, so quietly substituting a value hides a real mismatch between
    // what the owner selected and what they were scored against.
    const skillLevel = request.body?.skillLevel;

    if (skillLevel !== undefined && !SKILL_LEVELS.includes(skillLevel)) {
      response.status(400).json({
        error: `Field "skillLevel" must be one of: ${SKILL_LEVELS.join(", ")}.`,
      });
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
          skillLevel,
        },
        { emit: send, signal: abortController.signal }
      );
    } catch (error) {
      // A genuine client disconnect aborts the in-flight request; there is no
      // longer anyone to receive a frame, so end quietly instead of writing a
      // user-facing error to a dead socket. Real model/network failures still
      // surface verbatim.
      // Typed planner failures keep their code/reason so the browser can tell
      // an incomplete run from a completed one. `send` serializes the whole
      // event, so agent-emitted frames already carry these through untouched.
      if (error?.name !== "AbortError") {
        send({
          type: "error",
          ...(error?.code ? { code: error.code } : {}),
          ...(error?.reason ? { reason: error.reason } : {}),
          message: error.message || "The Repair Planner failed.",
        });
      }
    } finally {
      response.end();
    }
  });

  // Records the owner's safety acknowledgment for one already-generated plan and
  // returns the re-scored readiness and checklist.
  //
  // The request body carries a boolean and nothing else. Everything readiness is
  // computed from -- the canonical tasks, the skill level, the validated
  // requirement groups, the evidence status -- comes back out of the server's own
  // record of that run, and the safety classifier is re-run over those stored
  // tasks here. So a client cannot re-label brake work as non-critical, cannot
  // hand itself satisfied requirement groups, and cannot acknowledge a plan the
  // server never produced. It is a plain JSON route, not an SSE one, and it
  // makes no model call.
  router.post("/:runId/safety-acknowledgment", (request, response) => {
    const acknowledged = request.body?.acknowledged;

    if (typeof acknowledged !== "boolean") {
      response.status(400).json({ error: 'Field "acknowledged" must be true or false.' });
      return;
    }

    const record = planRuns.get(request.params.runId);

    if (!record) {
      response.status(404).json({ error: PLAN_RUN_EXPIRED_MESSAGE });
      return;
    }

    const readiness = checkRepairReadiness({
      tasks: record.tasks,
      skillLevel: record.skillLevel,
      ackSafety: acknowledged,
      requirements: record.requirements,
      evidenceStatus: record.evidenceStatus,
    });

    const { checklist } = buildOwnerChecklist({
      tasks: record.tasks,
      skillLevel: record.skillLevel,
      ackSafety: acknowledged,
    });

    response.json({
      planRunId: record.runId,
      // Echoed from the recomputed readiness, not from the request: a plan with
      // no safety-critical work reports `true` because the requirement does not
      // apply, and `acknowledged: true` on such a plan changes no score.
      safetyAcknowledged: readiness.safetyAcknowledged,
      readiness,
      checklist,
    });
  });

  return router;
}

export const repairPlanRouter = createRepairPlanRouter();
