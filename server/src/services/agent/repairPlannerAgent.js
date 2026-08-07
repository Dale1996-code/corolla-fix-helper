import { config } from "../../config.js";
import { retrieveRelevantChunks } from "../chunkRetrievalService.js";
import {
  buildOwnerChecklist,
  checkRepairReadiness,
  createSourceRegistry,
  createToolRegistry,
  draftHandoffNotes,
  extractRepairTasks,
  parseInventory,
  repairToolSchemas,
} from "./repairTools.js";
import { buildRepairPlanEvidence } from "./repairPlanEvidenceContract.js";
import { buildPlannerChecklistDraft } from "./plannerChecklistDraft.js";
import { streamResponsesTurn } from "./openAiResponsesClient.js";
import { planRunStore } from "./planRunStore.js";
import { createTracer } from "./tracing.js";

export const AI_NOT_CONFIGURED_MESSAGE =
  "AI is not configured yet. Set OPENAI_API_KEY in the server environment to enable the Repair Planner.";

export const SKILL_LEVELS = ["beginner", "intermediate", "advanced"];

// How many times a structurally invalid finalizer is handed back for repair.
// Bounded because an unbounded correction loop is how one request becomes
// runaway model spend.
export const MAX_FINALIZER_CORRECTIONS = 2;

// Fixed, safe user-facing text. A failure never echoes model output back to the
// owner, so nothing unvalidated can reach the page through an error frame.
export const PLANNER_FAILURE_MESSAGES = {
  no_canonical_task:
    "That brief is too vague to plan. Name the part or the symptom — for example \"replace the front brake pads\" or \"grinding noise when braking\".",
  turn_limit:
    "The planner ran out of steps before finishing a plan. Narrow the brief to fewer repairs and try again.",
  empty_output: "The planner stopped before writing a plan. Please try again.",
  invalid_final_contract:
    "The planner could not produce a plan backed by your documents. Please try again.",
  provider_incomplete: "The AI model stopped early and the plan is incomplete. Please try again.",
  missing_terminal_event: "The AI model's response ended unexpectedly. Please try again.",
  malformed_tool_arguments: "The AI model sent an unreadable tool request. Please try again.",
};

const AGENT_INSTRUCTIONS = [
  "You are the Repair Planner agent for a 2009 Toyota Corolla LE 1.8L repair workspace.",
  "Turn the owner's repair brief into an actionable plan. Work in this order using the tools:",
  "1. Call extract_repair_tasks (no arguments) to read the canonical task list for this run.",
  "2. For each task, call search_repair_docs with that task's id and keywords to ground steps and torque specs in the owner's uploaded manuals.",
  "3. Call check_repair_readiness (no arguments) to see the skill and safety picture.",
  "4. Call draft_handoff_notes for the parts and mechanic copy.",
  "5. Call finalize_repair_plan with one atomic claim per grounded statement.",
  "The task list, the owner's skill level, tool and part inventories, and the safety-acknowledgment state are fixed by the server. You cannot set them; arguments attempting to do so are ignored.",
  "Your prose is NOT shown to the owner. The plan they read is rendered by the server from your validated claims, so anything you do not submit through finalize_repair_plan is discarded.",
  "Every claim must quote its source verbatim. The server checks that the quote appears in the retrieved text, that your claim appears word-for-word inside your own quote, and that every number in the claim is present in the quote. Paraphrased claims and unsupported numbers are dropped and reported as gaps.",
  "Name required tools and parts as required_tool / required_part claims with an itemName, or state no_required_tools / no_required_parts when a cited procedure says none are needed. Readiness cannot credit tools or parts you do not ground this way.",
  "If nothing can be grounded, call finalize_repair_plan with an empty claims array. That is an honest result; inventing support is not.",
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
    ...trusted.tasks.flatMap((task) => {
      const header = `- id ${task.id}: ${task.title} [system: ${task.system}, difficulty: ${task.difficulty}]`;

      if (!task.compound) {
        return [header];
      }

      // A compound task covers more than one thing, so evidence for one clause
      // does not cover the others. The model must say which clause each claim
      // supports, so it needs to see them numbered.
      return [
        `${header} — covers ${task.clauses.length} clauses; every claim for this task needs a clauseIndex:`,
        ...task.clauses.map((clause, index) => `    clauseIndex ${index}: ${clause}`),
      ];
    }),
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
    // Always false while the plan is being generated, and there is no request
    // field or model-facing schema that can set it. Acknowledgment is a
    // decision the owner makes about a plan they have already read, so it
    // arrives afterwards through POST /api/repair-plan/:runId/safety-
    // acknowledgment, which re-scores this run from the server's own copy of
    // these inputs. Nothing the model or the browser sends during generation
    // can pre-acknowledge anything.
    safetyAcknowledged: false,
  });
}

/**
 * Runs the repair-planning agent loop.
 *
 * Emits ordered events via `emit(event)`:
 *   { type: "status", message }
 *   { type: "tool_call", name, arguments }
 *   { type: "tool_result", name, summary }
 *   { type: "trace", span }
 *   { type: "done", status, evidenceStatus, text, artifacts }
 *   { type: "ai_not_configured", message }
 *   { type: "error", code, reason, message }
 *
 * `text_delta` is NOT emitted. Model prose is discarded; the plan the owner
 * reads is rendered by the server from validated claims.
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
    // Injectable so a test can observe what the acknowledgment route would later
    // be re-scoring from, without reaching into module state.
    planRuns = planRunStore,
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
  // Run-wide so one chunk keeps one id across every search: a torque table
  // cited for the front brakes is the same evidence for the rear brakes.
  const sources = createSourceRegistry();
  const registry = createToolRegistry({ retrieve, trusted, sources });

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

  let modelStoppedCallingTools = false;
  /** @type {any} */
  let finalizedPlan = null;
  let correctionsUsed = 0;

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
        // Model prose is DISCARDED, including prose emitted before a tool call.
        // It used to stream straight to the browser, where an invented torque
        // value rendered exactly like a sourced one. The only text the owner
        // sees is rendered by the server from validated claims.
        if (event.type === "function_call") {
          pendingToolCalls.push(event);
        }
      }

      turnSpan.end({ toolCalls: pendingToolCalls.length });

      if (!pendingToolCalls.length) {
        // The model stopped calling tools without submitting a finalizer.
        modelStoppedCallingTools = true;
        break;
      }

      for (const toolCall of pendingToolCalls) {
        const executor = registry[toolCall.name];
        emit({ type: "tool_call", name: toolCall.name, arguments: toolCall.arguments });

        const toolSpan = tracer.startSpan("tool_call", { tool: toolCall.name });
        let result;

        if (toolCall.name === "finalize_repair_plan") {
          const evidence = buildRepairPlanEvidence(toolCall.arguments || {}, {
            tasks: trusted.tasks,
            sources: sources.list(),
            availableTools: parseInventory(trusted.availableTools),
            availableParts: parseInventory(trusted.availableParts),
          });

          if (evidence.valid) {
            finalizedPlan = evidence;
            result = {
              accepted: true,
              evidenceStatus: evidence.evidenceStatus,
              verifiedClaims: evidence.verifiedClaims.length,
              droppedClaims: evidence.rejectedCount,
            };
          } else {
            // Structural problems go back to the model so it can correct them,
            // but only a bounded number of times -- an unbounded repair loop is
            // how a single request turns into runaway model spend.
            correctionsUsed += 1;
            result = {
              error: "finalize_repair_plan was rejected. Fix these problems and call it again.",
              problems: evidence.errors,
            };
          }
        } else if (!executor) {
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

        // Nothing is accumulated into artifacts here any more. Readiness, the
        // checklist, handoff notes, and citations are all rebuilt after the
        // finalizer validates, from validated data only -- a mid-run readiness
        // score has no requirement groups, and a chunk that was retrieved but
        // never cited is not evidence for anything.
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

      if (finalizedPlan) {
        break;
      }

      if (correctionsUsed > MAX_FINALIZER_CORRECTIONS) {
        return failRun("planner_invalid_output", "invalid_final_contract");
      }
    }

    // A run without a validated finalizer produced no plan. It used to emit
    // `done.status: "completed"` with an advisory status frame, so the browser
    // rendered a readiness score and checklist as if the run had succeeded.
    // Incomplete generation is a failure: no `done`, no artifacts.
    if (!finalizedPlan) {
      return failRun(
        modelStoppedCallingTools ? "planner_invalid_output" : "planner_incomplete",
        modelStoppedCallingTools ? "invalid_final_contract" : "turn_limit"
      );
    }

    // Every artifact the owner sees is rebuilt here from validated data. The
    // readiness the model saw mid-run had no requirement groups; this is the
    // authoritative copy, and the only one that reaches the browser.
    const readiness = checkRepairReadiness({
      tasks: trusted.tasks,
      skillLevel: trusted.skillLevel,
      ackSafety: trusted.safetyAcknowledged,
      requirements: finalizedPlan.requirements,
      evidenceStatus: finalizedPlan.evidenceStatus,
    });

    artifacts.readiness = readiness;
    artifacts.checklist = buildOwnerChecklist({
      tasks: trusted.tasks,
      skillLevel: trusted.skillLevel,
      ackSafety: trusted.safetyAcknowledged,
    }).checklist;
    artifacts.handoffNotes = draftHandoffNotes({
      tasks: trusted.tasks,
      vehicle: trusted.vehicle,
      // Parts copy comes from VERIFIED part requirements, not from whatever the
      // model typed into draft_handoff_notes.
      partsNeeded: finalizedPlan.requirements.parts.required.join(", "),
    });
    artifacts.citations = finalizedPlan.citations;
    artifacts.requirements = finalizedPlan.requirements;
    artifacts.evidence = {
      verifiedClaims: finalizedPlan.verifiedClaims,
      gaps: finalizedPlan.gaps,
    };

    // Only a plan with safety-critical work has anything to acknowledge, so only
    // that plan gets a run id. A plan without it never shows the control and can
    // never be blocked by it -- and the store stays small.
    if (readiness.safetyCritical) {
      artifacts.planRunId = planRuns.save({
        tasks: trusted.tasks,
        skillLevel: trusted.skillLevel,
        requirements: finalizedPlan.requirements,
        evidenceStatus: finalizedPlan.evidenceStatus,
      });
    }

    // EVERY completed run can be saved as a checklist, including `not_found`:
    // the canonical task list and the safety warnings are real work worth
    // keeping even when nothing could be grounded, and the draft's notes say so
    // in as many words. The draft is built and held server-side; the browser
    // gets a copy to preview and an id to save it by, and sends back only the
    // id. `checklistDraftId` is separate from `planRunId` on purpose -- a plan
    // with no safety-critical work has no run record and would otherwise be
    // unsaveable.
    artifacts.checklistDraft = buildPlannerChecklistDraft({
      tasks: trusted.tasks,
      evidenceStatus: finalizedPlan.evidenceStatus,
      verifiedClaims: finalizedPlan.verifiedClaims,
      citations: finalizedPlan.citations,
      requirements: finalizedPlan.requirements,
    });
    artifacts.checklistDraftId = planRuns.saveChecklistDraft(artifacts.checklistDraft);

    const done = {
      type: "done",
      status: "completed",
      evidenceStatus: finalizedPlan.evidenceStatus,
      text: finalizedPlan.text,
      artifacts,
    };

    emit(done);
    return {
      status: "completed",
      evidenceStatus: finalizedPlan.evidenceStatus,
      text: finalizedPlan.text,
      artifacts,
    };
  } catch (error) {
    // An AbortError means the client disconnected mid-stream (see the route's
    // response "close" handling). There is no client left to receive a frame,
    // so end quietly rather than emitting a user-facing error. Real model and
    // network failures (4xx/5xx, parse errors) keep surfacing via `error`.
    if (error?.name === "AbortError") {
      return { status: "aborted", text: "", artifacts };
    }

    // Typed provider failures (truncated response, missing terminal event,
    // unparseable tool arguments) carry a code/reason so the browser can tell
    // an incomplete run from a completed one. No artifacts are returned.
    if (error?.code && error?.reason) {
      return failRun(error.code, error.reason);
    }

    emit({ type: "error", message: error.message || "The Repair Planner failed." });
    return { status: "error", text: "", artifacts };
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
