import { config } from "../../config.js";
import { retrieveRelevantChunks } from "../chunkRetrievalService.js";
import { createToolRegistry, extractRepairTasks, repairToolSchemas } from "./repairTools.js";
import { streamResponsesTurn } from "./openAiResponsesClient.js";
import { createTracer } from "./tracing.js";

export const AI_NOT_CONFIGURED_MESSAGE =
  "AI is not configured yet. Set OPENAI_API_KEY in the server environment to enable the Repair Planner.";

export const SKILL_LEVELS = ["beginner", "intermediate", "advanced"];

// Fixed, safe user-facing text. A failure never echoes model output back to the
// owner, so nothing unvalidated can reach the page through an error frame.
export const PLANNER_FAILURE_MESSAGES = {
  no_canonical_task:
    "That brief is too vague to plan. Name the part or the symptom — for example \"replace the front brake pads\" or \"grinding noise when braking\".",
  turn_limit:
    "The planner ran out of steps before finishing a plan. Narrow the brief to fewer repairs and try again.",
  empty_output: "The planner stopped before writing a plan. Please try again.",
  provider_incomplete: "The AI model stopped early and the plan is incomplete. Please try again.",
  missing_terminal_event: "The AI model's response ended unexpectedly. Please try again.",
  malformed_tool_arguments: "The AI model sent an unreadable tool request. Please try again.",
};

const AGENT_INSTRUCTIONS = [
  "You are the Repair Planner agent for a 2009 Toyota Corolla LE 1.8L repair workspace.",
  "Turn the owner's repair brief into an actionable plan. Work in this order using the tools:",
  "1. Call extract_repair_tasks (no arguments) to read the canonical task list for this run.",
  "2. For each task, call search_repair_docs with that task's id and keywords to ground steps and torque specs in the owner's uploaded manuals.",
  "3. Call check_repair_readiness (no arguments) for the readiness score.",
  "4. Call build_owner_checklist and draft_handoff_notes to produce the checklist and copy.",
  "The task list, the owner's skill level, tool and part inventories, and the safety-acknowledgment state are fixed by the server. You cannot set them; arguments attempting to do so are ignored.",
  "Then write a concise, prioritized plan as plain text. Cite document facts only from search_repair_docs results; never invent torque specs or capacities.",
  "End with a short 'Follow-up questions:' section listing what is missing when key details (symptoms, mileage, tools, parts, budget) are absent.",
  "Keep the narrative tight and skimmable. The structured checklist, readiness, and notes are shown separately, so do not repeat them verbatim.",
].join("\n");

function buildInitialInput(trusted) {
  const lines = [
    `Vehicle: ${trusted.vehicle}`,
    `Repair brief: ${trusted.brief}`,
    `Skill level: ${trusted.skillLevel}`,
    `Available tools: ${trusted.availableTools || "not specified"}`,
    `Available parts: ${trusted.availableParts || "not specified"}`,
    `Constraints (budget/time/etc.): ${trusted.constraints || "not specified"}`,
    "",
    "Canonical tasks (server-derived, fixed for this run):",
    ...trusted.tasks.map(
      (task) =>
        `- id ${task.id}: ${task.title} [system: ${task.system}, difficulty: ${task.difficulty}${
          task.compound ? ", covers multiple clauses" : ""
        }]`
    ),
  ];

  return [
    {
      role: "user",
      content: lines.join("\n"),
    },
  ];
}

/**
 * The server-owned planning context.
 *
 * Frozen because every readiness-relevant value in it is an OWNER fact, not a
 * model opinion: the brief, the canonical tasks derived from it, the stated
 * inventories and skill, and the safety-acknowledgment state. The tool registry
 * reads these instead of the model's arguments, so a model that sends
 * `ackSafety: true` or a replacement task list changes nothing.
 */
function buildTrustedContext(request, { brief, vehicle, tasks }) {
  return Object.freeze({
    brief,
    vehicle,
    // An unrecognized skill level is rejected at the route; defaulting here is
    // the belt-and-braces path for direct agent callers.
    skillLevel: SKILL_LEVELS.includes(request?.skillLevel) ? request.skillLevel : "beginner",
    availableTools: typeof request?.availableTools === "string" ? request.availableTools : "",
    availableParts: typeof request?.availableParts === "string" ? request.availableParts : "",
    constraints: typeof request?.constraints === "string" ? request.constraints : "",
    tasks: Object.freeze(tasks.map((task) => Object.freeze({ ...task }))),
    // Server-owned and always false in this milestone. There is no request
    // field and no model-facing schema that can set it, so safety-critical work
    // stays Shop Recommended until an informed-consent flow is designed.
    safetyAcknowledged: false,
  });
}

function mergeCitations(existing, incoming) {
  const seen = new Set(
    existing.map((citation) => `${citation.documentId}-${citation.pageNumber}-${citation.chunkIndex}`)
  );
  const merged = [...existing];

  for (const citation of incoming) {
    const key = `${citation.documentId}-${citation.pageNumber}-${citation.chunkIndex}`;
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(citation);
    }
  }

  return merged;
}

/**
 * Runs the repair-planning agent loop.
 *
 * Emits ordered events via `emit(event)`:
 *   { type: "status", message }
 *   { type: "tool_call", name, arguments }
 *   { type: "tool_result", name, summary }
 *   { type: "text_delta", text }
 *   { type: "trace", span }
 *   { type: "done", text, artifacts }
 *   { type: "ai_not_configured", message }
 *   { type: "error", message }
 *
 * `streamTurn` and `retrieve` are injectable so the whole loop is testable
 * without a live model or database.
 */
export async function runRepairPlannerAgent(request, options = {}) {
  const {
    emit = () => {},
    streamTurn = streamResponsesTurn,
    retrieve = retrieveRelevantChunks,
    isAiConfigured = Boolean(config.openAiApiKey),
    vehicleLabel = "2009 Toyota Corolla LE 1.8L",
    // Raised from 6: the loop must now END in a usable plan rather than silently
    // reporting success when the budget runs out, so the budget has to be big
    // enough for a multi-task brief to search and still write its narrative.
    maxTurns = 8,
    signal,
  } = options;

  const brief = typeof request?.brief === "string" ? request.brief.trim() : "";

  const failRun = (code, reason, artifacts = {}) => {
    emit({ type: "error", code, reason, message: PLANNER_FAILURE_MESSAGES[reason] });
    return { status: "error", code, reason, text: "", artifacts };
  };

  if (!brief) {
    emit({ type: "error", message: "A repair brief is required." });
    return { status: "error", text: "", artifacts: {} };
  }

  if (!isAiConfigured) {
    emit({ type: "ai_not_configured", message: AI_NOT_CONFIGURED_MESSAGE });
    emit({ type: "done", status: "ai_not_configured", text: "", artifacts: {} });
    return { status: "ai_not_configured", text: "", artifacts: {} };
  }

  // Canonical tasks are derived from the TRUSTED brief before the model runs,
  // so the task list the plan is built on can never be replaced by tool
  // arguments. A brief too vague to yield one is a failure, not a plan built on
  // a placeholder task.
  const { tasks: canonicalTasks } = extractRepairTasks({ brief });

  if (!canonicalTasks.length) {
    return failRun("planner_invalid_output", "no_canonical_task");
  }

  const trusted = buildTrustedContext(request, {
    brief,
    vehicle: vehicleLabel,
    tasks: canonicalTasks,
  });

  const tracer = createTracer({ onSpan: (span) => emit({ type: "trace", span }) });
  const registry = createToolRegistry({ retrieve, trusted });

  const artifacts = {
    // Canonical from the start: the UI shows the server's task list whether or
    // not the model ever calls extract_repair_tasks.
    tasks: trusted.tasks,
    citations: [],
    readiness: null,
    checklist: [],
    handoffNotes: null,
  };

  /** @type {any[]} */
  let inputItems = buildInitialInput(trusted);

  let finalText = "";
  let modelFinishedWriting = false;

  try {
    emit({ type: "status", message: "Analyzing repair brief..." });

    for (let turn = 0; turn < maxTurns; turn += 1) {
      const turnSpan = tracer.startSpan("model_turn", { turn: turn + 1 });
      const pendingToolCalls = [];

      const stream = streamTurn({
        model: config.openAiAnswerModel,
        instructions: AGENT_INSTRUCTIONS,
        input: inputItems,
        tools: repairToolSchemas,
        signal,
      });

      for await (const event of stream) {
        if (event.type === "text_delta") {
          finalText += event.text;
          emit({ type: "text_delta", text: event.text });
        } else if (event.type === "function_call") {
          pendingToolCalls.push(event);
        }
      }

      turnSpan.end({ toolCalls: pendingToolCalls.length });

      if (!pendingToolCalls.length) {
        // The model stopped calling tools: this turn was its final answer.
        modelFinishedWriting = true;
        break;
      }

      for (const toolCall of pendingToolCalls) {
        const executor = registry[toolCall.name];
        emit({ type: "tool_call", name: toolCall.name, arguments: toolCall.arguments });

        const toolSpan = tracer.startSpan("tool_call", { tool: toolCall.name });
        let result;

        if (!executor) {
          result = { error: `Unknown tool: ${toolCall.name}` };
        } else {
          try {
            result = await executor(toolCall.arguments || {});
          } catch (error) {
            result = {
              error: `Tool execution failed: ${error.message || error}`,
            };
          }
        }

        // Accumulate structured artifacts for the UI. `tasks` is deliberately
        // absent: the canonical list is set before the loop and the model
        // cannot replace it.
        if (toolCall.name === "search_repair_docs" && Array.isArray(result.citations)) {
          artifacts.citations = mergeCitations(artifacts.citations, result.citations);
        } else if (toolCall.name === "check_repair_readiness") {
          artifacts.readiness = result;
        } else if (toolCall.name === "build_owner_checklist" && Array.isArray(result.checklist)) {
          artifacts.checklist = result.checklist;
        } else if (toolCall.name === "draft_handoff_notes") {
          artifacts.handoffNotes = result;
        }

        toolSpan.end();
        emit({
          type: "tool_result",
          name: toolCall.name,
          summary: summarizeToolResult(toolCall.name, result),
        });

        inputItems = inputItems.concat(
          {
            type: "function_call",
            call_id: toolCall.callId,
            name: toolCall.name,
            arguments: JSON.stringify(toolCall.arguments || {}),
          },
          {
            type: "function_call_output",
            call_id: toolCall.callId,
            output: JSON.stringify(result),
          }
        );
      }
    }

    const trimmedFinal = finalText.trim();

    // A run that spends its whole budget on tool calls, or stops without
    // writing anything, produced no plan. It used to emit
    // `done.status: "completed"` with an advisory status frame, so the browser
    // rendered a readiness score and checklist as if the run had succeeded.
    // Incomplete generation is a failure: no `done`, no artifacts.
    if (!modelFinishedWriting) {
      return failRun("planner_incomplete", "turn_limit");
    }

    if (!trimmedFinal) {
      return failRun("planner_incomplete", "empty_output");
    }

    emit({ type: "done", status: "completed", text: trimmedFinal, artifacts });
    return { status: "completed", text: trimmedFinal, artifacts };
  } catch (error) {
    // An AbortError means the client disconnected mid-stream (see the route's
    // response "close" handling). There is no client left to receive a frame,
    // so end quietly rather than emitting a user-facing error. Real model and
    // network failures (4xx/5xx, parse errors) keep surfacing via `error`.
    if (error?.name === "AbortError") {
      return { status: "aborted", text: finalText.trim(), artifacts };
    }

    // Typed provider failures (truncated response, missing terminal event,
    // unparseable tool arguments) carry a code/reason so the browser can tell
    // an incomplete run from a completed one. No artifacts are returned.
    if (error?.code && error?.reason) {
      return failRun(error.code, error.reason);
    }

    emit({ type: "error", message: error.message || "The repair planner failed." });
    return { status: "error", text: finalText.trim(), artifacts };
  }
}

function summarizeToolResult(name, result) {
  if (result?.error) {
    return result.error;
  }
  if (name === "extract_repair_tasks") {
    return `Found ${result.tasks?.length || 0} task(s).`;
  }
  if (name === "search_repair_docs") {
    return `Retrieved ${result.citations?.length || 0} document chunk(s) for "${result.query || ""}".`;
  }
  if (name === "check_repair_readiness") {
    return `Readiness ${result.score ?? 0}/100 (${result.level || "unknown"}).`;
  }
  if (name === "build_owner_checklist") {
    return `Built ${result.checklist?.length || 0} checklist item(s).`;
  }
  if (name === "draft_handoff_notes") {
    return "Drafted parts list, mechanic handoff, and log entry.";
  }
  return "Done.";
}
