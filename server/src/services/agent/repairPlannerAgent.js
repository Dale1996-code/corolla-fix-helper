import { config } from "../../config.js";
import { retrieveRelevantChunks } from "../chunkRetrievalService.js";
import { createToolRegistry, repairToolSchemas } from "./repairTools.js";
import { streamResponsesTurn } from "./openAiResponsesClient.js";
import { createTracer } from "./tracing.js";

export const AI_NOT_CONFIGURED_MESSAGE =
  "AI is not configured yet. Set OPENAI_API_KEY in the server environment to enable the Repair Planner.";

const AGENT_INSTRUCTIONS = [
  "You are the Repair Planner agent for a 2009 Toyota Corolla LE 1.8L repair workspace.",
  "Turn the owner's rough repair brief into an actionable plan. Work in this order using the tools:",
  "1. Call extract_repair_tasks on the full brief to break it into tasks.",
  "2. For each task, call search_repair_docs with its keywords to ground steps and torque specs in the owner's uploaded manuals.",
  "3. Call check_repair_readiness with the tasks, available tools, available parts, and skill level.",
  "4. Call build_owner_checklist and draft_handoff_notes to produce the checklist and copy.",
  "Then write a concise, prioritized plan as plain text. Cite document facts only from search_repair_docs results; never invent torque specs or capacities.",
  "End with a short 'Follow-up questions:' section listing what is missing when key details (symptoms, mileage, tools, parts, budget) are absent.",
  "Keep the narrative tight and skimmable. The structured checklist, readiness, and notes are shown separately, so do not repeat them verbatim.",
].join("\n");

function buildInitialInput({ brief, vehicle, constraints, availableTools, availableParts, skillLevel }) {
  const lines = [
    `Vehicle: ${vehicle}`,
    `Repair brief: ${brief}`,
    `Skill level: ${skillLevel || "not specified"}`,
    `Available tools: ${availableTools || "not specified"}`,
    `Available parts: ${availableParts || "not specified"}`,
    `Constraints (budget/time/etc.): ${constraints || "not specified"}`,
  ];

  return [
    {
      role: "user",
      content: lines.join("\n"),
    },
  ];
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
    maxTurns = 6,
    signal,
  } = options;

  const brief = typeof request?.brief === "string" ? request.brief.trim() : "";

  if (!brief) {
    emit({ type: "error", message: "A repair brief is required." });
    return { status: "error", text: "", artifacts: {} };
  }

  if (!isAiConfigured) {
    emit({ type: "ai_not_configured", message: AI_NOT_CONFIGURED_MESSAGE });
    emit({ type: "done", status: "ai_not_configured", text: "", artifacts: {} });
    return { status: "ai_not_configured", text: "", artifacts: {} };
  }

  const tracer = createTracer({ onSpan: (span) => emit({ type: "trace", span }) });
  const registry = createToolRegistry({ retrieve });
  const vehicle = vehicleLabel;

  const artifacts = {
    tasks: [],
    citations: [],
    readiness: null,
    checklist: [],
    handoffNotes: null,
  };

  let inputItems = buildInitialInput({
    brief,
    vehicle,
    constraints: request.constraints,
    availableTools: request.availableTools,
    availableParts: request.availableParts,
    skillLevel: request.skillLevel,
  });

  let finalText = "";

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
          result = await executor(toolCall.arguments || {});
        }

        // Accumulate structured artifacts for the UI.
        if (toolCall.name === "extract_repair_tasks" && Array.isArray(result.tasks)) {
          artifacts.tasks = result.tasks;
        } else if (toolCall.name === "search_repair_docs" && Array.isArray(result.citations)) {
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

    emit({ type: "done", status: "completed", text: finalText.trim(), artifacts });
    return { status: "completed", text: finalText.trim(), artifacts };
  } catch (error) {
    emit({ type: "error", message: error.message || "The repair planner failed." });
    return { status: "error", text: finalText.trim(), artifacts };
  }
}

function summarizeToolResult(name, result) {
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
