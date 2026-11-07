// A scripted stand-in for the OpenAI stream, so a whole Repair Planner run can be
// driven with no key and no network (docs/planner-eval-spec.md, Phase 2a).
//
// It imports nothing: the provider errors it builds are duck-typed the way the
// agent reads them (`failure.httpStatus`, or `code` + `reason`), so this module
// can be loaded by a test that has neither a database nor the OpenAI client.
//
// Precedent: answerRejectionProbes.js already puts a scripted model reply in
// src/evals/. Like that one, this is evaluation tooling, not application code.

/**
 * @typedef {{ name: string, arguments?: any, callId?: string }} CallSpec
 * @typedef {CallSpec[] | { calls?: CallSpec[], fail?: Error, failAfter?: Error }} Step
 */

/** @param {string} name @param {any} [args] @param {string} [callId] @returns {CallSpec} */
export function toolCall(name, args = {}, callId) {
  return callId === undefined ? { name, arguments: args } : { name, arguments: args, callId };
}

/** @param {number} taskId @param {string} query @param {any} [extra] @returns {CallSpec} */
export function searchCall(taskId, query, extra = {}) {
  return toolCall("search_repair_docs", { taskId, query, ...extra });
}

/** @param {any[]} claims @returns {CallSpec} */
export function finalizeCall(claims) {
  return toolCall("finalize_repair_plan", { claims });
}

/**
 * An HTTP-level provider failure as the agent's wrapper sees it. It carries a
 * status and no response body: a provider body never leaves the client.
 *
 * @param {number} httpStatus
 */
export function providerHttpError(httpStatus) {
  return Object.assign(new Error("Scripted provider error."), {
    name: "ScriptedProviderError",
    failure: { httpStatus },
  });
}

/**
 * A typed stream failure, shaped like the client's ResponsesStreamError.
 *
 * @param {string} code
 * @param {string} reason
 */
export function typedStreamError(code, reason) {
  return Object.assign(new Error(`Scripted stream failure: ${reason}.`), { name: "ScriptedStreamError", code, reason });
}

/**
 * The run-assigned source id of the one retrieved chunk whose line matches.
 *
 * A scripted model that cites a chunk should find its id the way a real model
 * does -- from the context the search returned -- so the script keeps working
 * if retrieval order changes. It refuses to guess: no match, or more than one,
 * is a bug in the script.
 *
 * @param {any[]} input  The turn's input items.
 * @param {RegExp} pattern
 * @returns {string}
 */
export function sourceIdFor(input, pattern) {
  const ids = new Set();

  for (const item of input ?? []) {
    if (item?.type !== "function_call_output" || typeof item.output !== "string") {
      continue;
    }
    let parsed;

    try {
      parsed = JSON.parse(item.output);
    } catch {
      continue;
    }
    if (typeof parsed?.context !== "string") {
      continue;
    }
    for (const entry of parsed.context.split("\n\n")) {
      const id = /^\[(S\d+)\] /.exec(entry)?.[1];

      if (id && pattern.test(entry)) {
        ids.add(id);
      }
    }
  }

  if (ids.size === 0) {
    throw new Error(`no retrieved source matched ${pattern}`);
  }
  if (ids.size > 1) {
    throw new Error(`${pattern} matched ${ids.size} sources (${[...ids].join(", ")}); make the pattern specific`);
  }

  return [...ids][0];
}

/**
 * @param {Array<Step | ((context: { turn: number, input: any[] }) => Step)>} steps
 *   One step per model turn. An array is that turn's tool calls (empty means the
 *   model stopped calling tools). `{ calls, failAfter }` yields then throws, as
 *   a truncated stream does; `{ fail }` throws before yielding.
 */
export function createScriptedModel(steps) {
  /** @type {Array<{ turn: number, input: any, instructions: any, toolNames: string[] }>} */
  const inputs = [];
  let turnsStarted = 0;

  /** @param {any} params */
  async function* streamTurn(params) {
    turnsStarted += 1;
    const turn = turnsStarted;
    inputs.push({
      turn,
      input: params?.input,
      instructions: params?.instructions,
      toolNames: (params?.tools ?? []).map((/** @type {any} */ tool) => tool.name),
    });

    if (turn > steps.length) {
      throw new Error(`The scripted model has no step for turn ${turn}.`);
    }

    const planned = steps[turn - 1];
    const step = typeof planned === "function" ? planned({ turn, input: params?.input ?? [] }) : planned;
    const spec = Array.isArray(step) ? { calls: step } : step;

    if (spec.fail) {
      throw spec.fail;
    }

    for (const [index, call] of (spec.calls ?? []).entries()) {
      yield {
        type: "function_call",
        callId: call.callId ?? `call_${turn}_${index + 1}`,
        name: call.name,
        arguments: call.arguments ?? {},
      };
    }

    if (spec.failAfter) {
      throw spec.failAfter;
    }
  }

  return {
    streamTurn,
    inputs,
    get turnsStarted() {
      return turnsStarted;
    },
  };
}
