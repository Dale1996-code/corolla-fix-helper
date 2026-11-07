// Records ONE Repair Planner run at its seams (docs/planner-eval-spec.md, Phase 2a).
//
// The agent is injected, never imported: repairPlannerAgent.js opens the real
// database at load, and this module must stay loadable by anything that has
// neither a database nor a key. It imports only Ask's snapshotChunk, which is
// documented to touch neither config nor a database.
//
// WHAT IT SEES. Only the three options the agent already exposes:
//   streamTurn  every function call the model yields,
//   emit        every frame the agent shows the browser,
//   retrieve    every retrieval.
// It edits nothing in the agent and changes nothing the agent returns.
//
// HOW A RETRIEVAL IS TIED TO A TASK. The retrieve seam carries a query and never
// a task, and two searches can share a query. The join is made by SEQUENCE, not
// by matching text. The agent emits one `tool_call` frame for each call it runs,
// in order, BEFORE executing it, and only a `search_repair_docs` execution calls
// the retriever; a `tool_result` frame closes it. So a retrieval belongs to the
// frame that is open, and the k-th frame of a turn belongs to the k-th call the
// model yielded that turn. A call with no frame was not run: past the per-turn
// cap if its stream finished, or never reached if its stream failed. The cap is
// read from how many frames the agent actually emitted, not from a constant.
//
// FAIL CLOSED. If that sequence is ever not what the recorder assumes (a
// retrieval outside a frame, a frame that names a different tool than the model
// called, more frames than calls), the run is recorded but then rejected with
// RecorderOutOfSync, because every task attribution after the break would be a
// guess. The recorder cannot throw from inside the seams: the agent turns an
// error thrown there into a tool error or a failed run, which would hide the
// break. It notes the problem, delegates exactly as before, and throws at the end.

import { snapshotChunk } from "./answerCapture.js";

export class RecorderOutOfSync extends Error {
  /**
   * @param {string} message
   * @param {any} [record]
   * @param {string[]} [problems]
   */
  constructor(message, record = null, problems = []) {
    super(message);
    this.name = "RecorderOutOfSync";
    this.record = record;
    this.problems = problems;
  }
}

const SEARCH_TOOL = "search_repair_docs";
const FINALIZE_TOOL = "finalize_repair_plan";
const UNKNOWN_TOOL = "unknown_tool";

const text = (value) => (typeof value === "string" ? value : "");

/** A failure from the stream, described without its message or any provider body. */
function describeProviderError(turn, error) {
  const status = Number(error?.failure?.httpStatus);
  const httpStatus = Number.isInteger(status) ? status : null;

  return {
    turn,
    httpStatus,
    kind: httpStatus !== null ? "http" : error?.code && error?.reason ? "typed_stream" : "unknown",
    code: error?.code ?? null,
    reason: error?.reason ?? null,
    name: error?.name ?? null,
  };
}

/** Everything the owner reads or saves, as content: no random capability ids. */
function buildOutputs(result) {
  if (result?.status !== "completed") {
    return null;
  }
  const artifacts = result.artifacts ?? {};

  return structuredClone({
    text: result.text,
    checklistDraft: artifacts.checklistDraft ?? null,
    checklist: artifacts.checklist ?? null,
    handoffNotes: artifacts.handoffNotes ?? null,
    readiness: artifacts.readiness ?? null,
    requirements: artifacts.requirements ?? null,
    citations: artifacts.citations ?? [],
    evidence: {
      verifiedClaims: artifacts.evidence?.verifiedClaims ?? [],
      gaps: artifacts.evidence?.gaps ?? [],
    },
    // Presence only. The ids themselves are random, and would make two
    // identical runs differ.
    hasPlanRunId: typeof artifacts.planRunId === "string",
    hasChecklistDraftId: typeof artifacts.checklistDraftId === "string",
  });
}

/**
 * Run the planner once and return what happened.
 *
 * @param {{ scenarioId?: string | null, repeat?: number, request: any }} run
 * @param {{
 *   runAgent: (request: any, options: any) => Promise<any>,
 *   extractTasks: (input: { brief: string }) => { tasks: any[] },
 *   streamTurn: (params: any) => AsyncIterable<any>,
 *   retrieve: (query: string, options?: any) => Promise<any>,
 *   createPlanRuns?: () => any,
 *   agentOptions?: any,
 *   onEvent?: ((event: any) => void) | null,
 * }} deps
 */
export async function recordPlannerRun({ scenarioId = null, repeat = 1, request }, deps) {
  const { runAgent, extractTasks, streamTurn, retrieve, createPlanRuns, agentOptions = {}, onEvent = null } = deps ?? {};

  for (const [name, dependency] of Object.entries({ runAgent, extractTasks, streamTurn, retrieve })) {
    if (typeof dependency !== "function") {
      throw new TypeError(`recordPlannerRun needs a ${name} function`);
    }
  }

  const brief = typeof request?.brief === "string" ? request.brief.trim() : "";

  /** @type {any[]} */ const turns = [];
  /** @type {any[]} */ const retrievals = [];
  /** @type {any[]} */ const finalizers = [];
  /** @type {any[]} */ const providerErrors = [];
  /** @type {string[]} */ const problems = [];
  /** @type {any} */ let open = null;
  let turnNumber = 0;

  const problem = (message) => problems.push(message);

  /** @param {any} params */
  async function* recordedStreamTurn(params) {
    turnNumber += 1;
    const turn = { turn: turnNumber, streamCompleted: false, frameCount: 0, calls: /** @type {any[]} */ ([]) };
    turns.push(turn);

    try {
      for await (const event of streamTurn(params)) {
        if (event?.type === "function_call") {
          turn.calls.push({
            ordinal: turn.calls.length,
            callId: event.callId,
            name: event.name,
            frameName: null,
            arguments: structuredClone(event.arguments ?? {}),
            disposition: null,
            taskId: null,
            retrievalCount: 0,
          });
        }
        yield event;
      }
      turn.streamCompleted = true;
    } catch (error) {
      providerErrors.push(describeProviderError(turnNumber, error));
      throw error;
    }
  }

  function openFrame(frame) {
    if (open) {
      problem(`tool_call frame for ${frame.name} arrived while ${open.frame.name} was still open`);
      open = null;
    }
    if (turnNumber === 0) {
      problem(`tool_call frame for ${frame.name} arrived before any model turn`);
      return;
    }
    if (frame.turn !== turnNumber) {
      problem(`tool_call frame for turn ${frame.turn} arrived during turn ${turnNumber}`);
      return;
    }

    const turn = turns[turnNumber - 1];
    const ordinal = turn.frameCount;
    const call = turn.calls[ordinal];

    if (!call) {
      problem(`more frames than calls in turn ${turnNumber}: frame ${frame.name} has no call at position ${ordinal}`);
      return;
    }
    // The agent shows a name it does not know as `unknown_tool`, never the model's.
    if (frame.name !== call.name && frame.name !== UNKNOWN_TOOL) {
      problem(
        `tool_call frame ${frame.name} does not match the model's call ${call.name} at position ${ordinal} of turn ${turnNumber}`
      );
      return;
    }

    turn.frameCount += 1;
    call.frameName = frame.name;

    if (call.name === SEARCH_TOOL) {
      // The agent puts a taskId on the frame only when it names a canonical task.
      call.taskId = Number.isInteger(frame.taskId) ? frame.taskId : null;
      // Provisional: a search that reaches the retriever becomes "retrieved". One
      // that never does was refused for its task, or skipped for its query.
      call.disposition = call.taskId === null ? "invalid_task" : "empty_query";
    } else {
      call.disposition = "executed";
    }

    if (call.name === FINALIZE_TOOL) {
      finalizers.push({ turn: turnNumber, callOrdinal: ordinal, callId: call.callId, arguments: structuredClone(call.arguments) });
    }

    open = { turn, call, frame };
  }

  function closeFrame(result) {
    if (!open) {
      problem(`tool_result for ${result.name} arrived with no tool_call open`);
      return;
    }
    if (result.name !== open.frame.name) {
      problem(`tool_result for ${result.name} arrived while ${open.frame.name} was open`);
    }
    open = null;
  }

  /** @param {any} event */
  const emit = (event) => {
    if (event?.type === "tool_call") {
      openFrame(event);
    } else if (event?.type === "tool_result") {
      closeFrame(event);
    }
    if (onEvent) {
      onEvent(event);
    }
  };

  /** @param {string} query @param {any} [options] */
  const recordedRetrieve = async (query, options) => {
    const entry = {
      turn: turnNumber,
      callOrdinal: /** @type {number | null} */ (null),
      callId: /** @type {string | null} */ (null),
      taskId: /** @type {number | null} */ (null),
      query,
      limit: options?.limit ?? null,
      mode: options?.mode ?? null,
      results: /** @type {any[] | null} */ (null),
      error: /** @type {{ name: string, message: string } | null} */ (null),
    };
    const owner = open;

    if (!owner) {
      problem("retrieval outside any tool call");
    } else if (owner.call.name !== SEARCH_TOOL) {
      problem(`retrieval during ${owner.call.name}, which is not a search`);
    } else {
      entry.callOrdinal = owner.call.ordinal;
      entry.callId = owner.call.callId;
      entry.taskId = owner.call.taskId;
      owner.call.retrievalCount += 1;
    }

    retrievals.push(entry);

    try {
      const results = await retrieve(query, options);

      entry.results = (Array.isArray(results) ? results : []).map(snapshotChunk);
      if (owner?.call.name === SEARCH_TOOL) {
        owner.call.disposition = "retrieved";
      }
      return results;
    } catch (error) {
      entry.error = { name: text(error?.name) || "Error", message: text(error?.message).slice(0, 200) };
      if (owner?.call.name === SEARCH_TOOL) {
        owner.call.disposition = "retriever_error";
      }
      throw error;
    }
  };

  const options = {
    isAiConfigured: true,
    ...agentOptions,
    emit,
    streamTurn: recordedStreamTurn,
    retrieve: recordedRetrieve,
    ...(createPlanRuns ? { planRuns: createPlanRuns() } : {}),
  };

  const result = await runAgent(request, options);

  // A call with no frame was not run. If the stream finished, the agent's
  // per-turn cap left it out; if the stream failed, it was never reached.
  for (const turn of turns) {
    for (const call of turn.calls) {
      if (call.disposition === null) {
        call.disposition = turn.streamCompleted ? "skipped_by_cap" : "not_run";
      }
    }
  }

  const record = {
    scenarioId,
    repeat,
    request: {
      brief: text(request?.brief),
      skillLevel: request?.skillLevel ?? null,
      availableTools: text(request?.availableTools),
      availableParts: text(request?.availableParts),
      constraints: text(request?.constraints),
    },
    // What the server derives from the brief. `modelSawTasks` says whether a run
    // got far enough to hand them to the model; the derivation itself is a pure
    // function of the brief and is kept either way, for judging task derivation.
    tasks: brief ? structuredClone(extractTasks({ brief }).tasks) : [],
    modelSawTasks: turns.length > 0,
    turns,
    retrievals,
    finalizers,
    outcome: {
      status: result?.status ?? "unknown",
      code: result?.code ?? null,
      reason: result?.reason ?? null,
      evidenceStatus: result?.evidenceStatus ?? null,
    },
    providerErrors,
    outputs: buildOutputs(result),
  };

  if (problems.length > 0) {
    throw new RecorderOutOfSync(
      `The planner run did not follow the sequence the recorder relies on: ${problems[0]}`,
      record,
      problems
    );
  }

  return record;
}

/**
 * Run one scenario once.
 *
 * @param {any} scenario
 * @param {Parameters<typeof recordPlannerRun>[1]} deps
 * @param {{ repeat?: number }} [options]
 */
export function runPlannerCase(scenario, deps, { repeat = 1 } = {}) {
  return recordPlannerRun(
    {
      scenarioId: scenario.id,
      repeat,
      request: {
        brief: scenario.brief,
        skillLevel: scenario.skillLevel,
        availableTools: scenario.availableTools,
        availableParts: scenario.availableParts,
        constraints: scenario.constraints,
      },
    },
    deps
  );
}
