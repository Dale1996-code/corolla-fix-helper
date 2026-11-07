import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after } from "node:test";

import { MINI_CORPORA, createKeywordRetriever } from "../src/evals/fixtures/plannerMiniCorpora.js";
import { RecorderOutOfSync, recordPlannerRun, runPlannerCase } from "../src/evals/plannerCaseRunner.js";
import { getPlannerScenario } from "../src/evals/plannerScenarios.js";
import {
  createScriptedModel,
  finalizeCall,
  providerHttpError,
  searchCall,
  sourceIdFor,
  toolCall,
  typedStreamError,
} from "../src/evals/plannerScriptedModel.js";
import { createPlanRunStore } from "../src/services/agent/planRunStore.js";

// Phase 2a: the injected runner that records one planner run at the seams.
//
// The recorder sees three things and nothing else: every call the model yields
// (streamTurn), every frame the agent emits (emit), and every retrieval (retrieve).
// The retrieve seam carries a query but never a task, so the join from a
// retrieval to the task it was for is made by SEQUENCE: the agent emits one
// tool_call frame per call it runs, in order, before executing it, and the
// retriever is only called inside that execution. These tests pin that join and
// the fail-closed behavior when the sequence is ever not what it assumes.

// The real agent imports the database at load, so the scratch paths come first
// (databaseIsolation.test.js enforces this order for every suite).
const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-planner-runner-"));
process.env.DATABASE_FILE = path.join(scratchRoot, "runner.db");
process.env.UPLOADS_DIR = path.join(scratchRoot, "uploads");
process.env.OPENAI_API_KEY = "";
process.env.NETWORK_MODE = "0";
fs.mkdirSync(process.env.UPLOADS_DIR, { recursive: true });

const { db } = await import("../src/database.js");
const { MAX_TOOL_CALLS_PER_TURN, runRepairPlannerAgent } = await import(
  "../src/services/agent/repairPlannerAgent.js"
);
const { extractRepairTasks } = await import("../src/services/agent/repairTools.js");

after(() => {
  if (typeof db.close === "function") {
    db.close();
  }
  fs.rmSync(scratchRoot, { recursive: true, force: true });
});

// ---- Helpers --------------------------------------------------------------------

const S1 = getPlannerScenario("S1-oil-and-filter");
const S2 = getPlannerScenario("S2-spark-plugs");
const S8 = getPlannerScenario("S8-timing-belt");

/** A retriever that remembers what it was asked. */
function spyOn(retrieve) {
  const calls = [];
  const spy = async (query, options) => {
    calls.push({ query, options });
    return retrieve(query, options);
  };
  spy.calls = calls;
  return spy;
}

const baseDeps = () => ({
  runAgent: runRepairPlannerAgent,
  extractTasks: extractRepairTasks,
  createPlanRuns: () => createPlanRunStore(),
});

const S2_RANGE = "Spark plug electrode gap for a new plug: 1.0 to 1.1 mm (0.0394 to 0.0433 in)";

const s2Claim = (input) => ({
  taskId: 1,
  kind: "numeric_spec",
  claim: S2_RANGE,
  sourceId: sourceIdFor(input, /Service Data/),
  evidenceQuote: `${S2_RANGE}.`,
});

/** The run every happy-path assertion starts from: search once, finalize one claim. */
const s2Happy = () => [[searchCall(1, "spark plug electrode gap")], ({ input }) => [finalizeCall([s2Claim(input)])]];

async function recordS2(steps = s2Happy(), extra = {}) {
  const model = createScriptedModel(steps);
  const retrieve = spyOn(createKeywordRetriever(MINI_CORPORA.S2));
  const record = await runPlannerCase(S2, {
    ...baseDeps(),
    streamTurn: model.streamTurn,
    retrieve,
    ...extra,
  });

  return { record, model, retrieve };
}

// ---- 1. A normal run -----------------------------------------------------------

test("a normal run records what the model asked for, what came back, and how it ended", async () => {
  const { record } = await recordS2();

  assert.equal(record.scenarioId, "S2-spark-plugs");
  assert.equal(record.repeat, 1);
  assert.deepEqual(record.request, {
    brief: S2.brief,
    skillLevel: "beginner",
    availableTools: S2.availableTools,
    availableParts: "spark plugs",
    constraints: "",
  });
  assert.deepEqual(record.outcome, { status: "completed", code: null, reason: null, evidenceStatus: "partial" });
  assert.deepEqual(record.providerErrors, []);

  assert.equal(record.turns.length, 2);
  assert.deepEqual(
    record.turns.map((turn) => turn.calls.map((call) => [call.ordinal, call.name, call.disposition])),
    [[[0, "search_repair_docs", "retrieved"]], [[0, "finalize_repair_plan", "executed"]]]
  );

  assert.equal(record.retrievals.length, 1);
  const [retrieval] = record.retrievals;
  assert.deepEqual(
    { turn: retrieval.turn, callOrdinal: retrieval.callOrdinal, callId: retrieval.callId, taskId: retrieval.taskId },
    { turn: 1, callOrdinal: 0, callId: "call_1_1", taskId: 1 }
  );
  assert.equal(retrieval.query, "spark plug electrode gap");
  assert.equal(retrieval.results.length, 3);
  assert.match(retrieval.results[0].chunkText, /1\.0 to 1\.1 mm/, "the full chunk text is recorded, not a snippet");

  assert.equal(record.finalizers.length, 1);
  assert.deepEqual(
    { turn: record.finalizers[0].turn, callOrdinal: record.finalizers[0].callOrdinal },
    { turn: 2, callOrdinal: 0 }
  );
  assert.equal(record.finalizers[0].arguments.claims[0].claim, S2_RANGE);
});

test("the tasks recorded are the canonical tasks the model was given", async () => {
  const model = createScriptedModel(s2Happy());
  const result = await runRepairPlannerAgent(
    { brief: S2.brief, skillLevel: "beginner", availableTools: S2.availableTools, availableParts: "spark plugs", constraints: "" },
    {
      streamTurn: model.streamTurn,
      retrieve: createKeywordRetriever(MINI_CORPORA.S2),
      isAiConfigured: true,
      planRuns: createPlanRunStore(),
    }
  );
  const { record } = await recordS2();

  assert.deepEqual(record.tasks, JSON.parse(JSON.stringify(result.artifacts.tasks)));
});

test("recording a run changes nothing the agent returns", async () => {
  const request = { brief: S2.brief, skillLevel: "beginner", availableTools: S2.availableTools, availableParts: "spark plugs", constraints: "" };
  const plainModel = createScriptedModel(s2Happy());
  const plain = await runRepairPlannerAgent(request, {
    streamTurn: plainModel.streamTurn,
    retrieve: createKeywordRetriever(MINI_CORPORA.S2),
    isAiConfigured: true,
    planRuns: createPlanRunStore(),
  });
  const { record } = await recordS2();

  assert.equal(record.outcome.status, plain.status);
  assert.equal(record.outcome.evidenceStatus, plain.evidenceStatus);
  assert.equal(record.outputs.text, plain.text);
  assert.deepEqual(record.outputs.evidence.verifiedClaims, JSON.parse(JSON.stringify(plain.artifacts.evidence.verifiedClaims)));
  assert.deepEqual(record.outputs.evidence.gaps, plain.artifacts.evidence.gaps);
});

test("two identical runs record identical data", async () => {
  const first = (await recordS2()).record;
  const second = (await recordS2()).record;

  assert.deepEqual(first, second);
});

test("the run passes the repeat number and scenario id through, and runs one request per call", async () => {
  const model = createScriptedModel(s2Happy());
  const record = await runPlannerCase(
    S2,
    { ...baseDeps(), streamTurn: model.streamTurn, retrieve: createKeywordRetriever(MINI_CORPORA.S2) },
    { repeat: 3 }
  );

  assert.equal(record.repeat, 3);
  assert.equal(model.turnsStarted, 2);
});

// ---- 2. Retrieval-to-task joins (the sequence the recorder relies on) -------------

test("two identical queries in one turn stay two retrievals, each tied to its own task", async () => {
  const model = createScriptedModel([
    [searchCall(1, "oil drain plug torque"), searchCall(2, "oil drain plug torque")],
    [finalizeCall([])],
  ]);
  const record = await runPlannerCase(S1, {
    ...baseDeps(),
    streamTurn: model.streamTurn,
    retrieve: createKeywordRetriever(MINI_CORPORA.S1),
  });

  assert.deepEqual(
    record.retrievals.map((retrieval) => [retrieval.turn, retrieval.callOrdinal, retrieval.callId, retrieval.taskId, retrieval.query]),
    [
      [1, 0, "call_1_1", 1, "oil drain plug torque"],
      [1, 1, "call_1_2", 2, "oil drain plug torque"],
    ]
  );
  assert.deepEqual(record.turns[0].calls.map((call) => call.taskId), [1, 2]);
});

test("the same query in different turns is a separate retrieval each time", async () => {
  const model = createScriptedModel([
    [searchCall(1, "oil drain plug torque")],
    [searchCall(1, "oil drain plug torque")],
    [finalizeCall([])],
  ]);
  const record = await runPlannerCase(S1, {
    ...baseDeps(),
    streamTurn: model.streamTurn,
    retrieve: createKeywordRetriever(MINI_CORPORA.S1),
  });

  assert.deepEqual(record.retrievals.map((retrieval) => [retrieval.turn, retrieval.callOrdinal]), [[1, 0], [2, 0]]);
});

test("a search for a task that does not exist is recorded as invalid and retrieves nothing", async () => {
  const bad = [99, "x", Number.NaN, null, 0, -1];
  const model = createScriptedModel([
    [...bad.map((taskId) => searchCall(taskId, "oil drain plug torque")), searchCall(1, "oil drain plug torque")],
    [finalizeCall([])],
  ]);
  const retrieve = spyOn(createKeywordRetriever(MINI_CORPORA.S1));
  const record = await runPlannerCase(S1, { ...baseDeps(), streamTurn: model.streamTurn, retrieve });

  const dispositions = record.turns[0].calls.map((call) => call.disposition);

  assert.deepEqual(dispositions, [...bad.map(() => "invalid_task"), "retrieved"]);
  assert.deepEqual(record.turns[0].calls.slice(0, bad.length).map((call) => call.taskId), bad.map(() => null));
  assert.equal(retrieve.calls.length, 1, "the real retriever was reached only by the valid search");
  assert.equal(record.retrievals.length, 1);
  assert.deepEqual(
    { ordinal: record.retrievals[0].callOrdinal, taskId: record.retrievals[0].taskId },
    { ordinal: bad.length, taskId: 1 },
    "the valid search after six invalid ones is still attributed to itself"
  );
});

test("an empty or whitespace query is a skipped search: it retrieves nothing and says why", async () => {
  const model = createScriptedModel([
    [searchCall(1, ""), searchCall(1, "   "), searchCall(1, "oil drain plug torque")],
    [finalizeCall([])],
  ]);
  const retrieve = spyOn(createKeywordRetriever(MINI_CORPORA.S1));
  const record = await runPlannerCase(S1, { ...baseDeps(), streamTurn: model.streamTurn, retrieve });

  assert.deepEqual(
    record.turns[0].calls.map((call) => [call.disposition, call.taskId]),
    [["empty_query", 1], ["empty_query", 1], ["retrieved", 1]]
  );
  assert.equal(retrieve.calls.length, 1);
  assert.equal(record.retrievals[0].callOrdinal, 2);
});

test("calls past the per-turn cap are recorded as skipped and never retrieve", async () => {
  const requested = MAX_TOOL_CALLS_PER_TURN + 2;
  const model = createScriptedModel([
    Array.from({ length: requested }, () => searchCall(1, "oil drain plug torque")),
    [finalizeCall([])],
  ]);
  const retrieve = spyOn(createKeywordRetriever(MINI_CORPORA.S1));
  const record = await runPlannerCase(S1, { ...baseDeps(), streamTurn: model.streamTurn, retrieve });
  const [turn] = record.turns;

  assert.equal(turn.calls.length, requested);
  assert.equal(turn.frameCount, MAX_TOOL_CALLS_PER_TURN, "the cap is read from what the agent actually ran");
  assert.deepEqual(
    turn.calls.map((call) => call.disposition),
    [
      ...Array(MAX_TOOL_CALLS_PER_TURN).fill("retrieved"),
      "skipped_by_cap",
      "skipped_by_cap",
    ]
  );
  assert.equal(retrieve.calls.length, MAX_TOOL_CALLS_PER_TURN);
  assert.deepEqual(
    record.retrievals.map((retrieval) => retrieval.callOrdinal),
    Array.from({ length: MAX_TOOL_CALLS_PER_TURN }, (_, index) => index)
  );
});

test("an unknown tool name is recorded as the model sent it, with the frame the agent showed", async () => {
  const model = createScriptedModel([[toolCall("rm_rf", { path: "/" }), searchCall(1, "oil drain plug torque")], [finalizeCall([])]]);
  const record = await runPlannerCase(S1, {
    ...baseDeps(),
    streamTurn: model.streamTurn,
    retrieve: createKeywordRetriever(MINI_CORPORA.S1),
  });

  assert.equal(record.turns[0].calls[0].name, "rm_rf");
  assert.equal(record.turns[0].calls[0].frameName, "unknown_tool");
  assert.equal(record.turns[0].calls[0].disposition, "executed");
  assert.equal(record.retrievals[0].callOrdinal, 1);
});

test("a retriever that throws is recorded, and the run carries on", async () => {
  const model = createScriptedModel([[searchCall(1, "oil drain plug torque")], [finalizeCall([])]]);
  const record = await runPlannerCase(S1, {
    ...baseDeps(),
    streamTurn: model.streamTurn,
    retrieve: async () => {
      throw new Error("index unavailable");
    },
  });

  assert.equal(record.turns[0].calls[0].disposition, "retriever_error");
  assert.deepEqual(record.retrievals[0].error, { name: "Error", message: "index unavailable" });
  assert.equal(record.retrievals[0].results, null);
  assert.equal(record.outcome.status, "completed", "the agent turns a tool error into a result, not a failed run");
});

test("every finalizer call is recorded, the structurally invalid ones too", async () => {
  const { record } = await recordS2([
    [searchCall(1, "spark plug electrode gap")],
    [finalizeCall("not an array")],
    ({ input }) => [finalizeCall([s2Claim(input)])],
  ]);

  assert.deepEqual(record.finalizers.map((finalizer) => finalizer.turn), [2, 3]);
  assert.equal(record.finalizers[0].arguments.claims, "not an array");
  assert.equal(record.outcome.status, "completed", "one correction is within the bound");
});

// ---- 3. Runs that end early --------------------------------------------------------

test("a refused brief records zero model turns, zero retrievals and the refusal", async () => {
  const model = createScriptedModel([]);
  const retrieve = spyOn(createKeywordRetriever(MINI_CORPORA.S2));
  const record = await recordPlannerRun(
    { scenarioId: "refusal", request: { brief: "How can I bypass the brake fluid level sensor so the dash warning stops?", skillLevel: "beginner" } },
    { ...baseDeps(), streamTurn: model.streamTurn, retrieve }
  );

  assert.deepEqual(record.outcome, { status: "error", code: "planner_refused", reason: "defeat_request", evidenceStatus: null });
  assert.deepEqual(record.turns, []);
  assert.deepEqual(record.retrievals, []);
  assert.equal(model.turnsStarted, 0);
  assert.equal(retrieve.calls.length, 0);
  assert.equal(record.outputs, null);
});

test("a brief too vague to plan records no tasks and no model turn", async () => {
  const model = createScriptedModel([]);
  const record = await recordPlannerRun(
    { scenarioId: "vague", request: { brief: "help", skillLevel: "beginner" } },
    { ...baseDeps(), streamTurn: model.streamTurn, retrieve: createKeywordRetriever(MINI_CORPORA.S2) }
  );

  assert.deepEqual(record.tasks, []);
  assert.deepEqual(record.outcome, { status: "error", code: "planner_invalid_output", reason: "no_canonical_task", evidenceStatus: null });
  assert.equal(model.turnsStarted, 0);
});

test("a 429 mid-run is recorded with its status, and the run is still returned", async () => {
  const { record } = await recordS2([[searchCall(1, "spark plug electrode gap")], { fail: providerHttpError(429) }]);

  assert.deepEqual(record.providerErrors, [
    { turn: 2, httpStatus: 429, kind: "http", code: null, reason: null, name: "ScriptedProviderError" },
  ]);
  assert.equal(record.outcome.status, "error");
  assert.equal(record.outcome.code, null, "the agent's generic error drops the status; the recorder keeps it");
  assert.equal(record.retrievals.length, 1, "what happened before the failure is kept");
});

test("a truncated stream is recorded as a typed failure, and its unrun calls are not mistaken for capped ones", async () => {
  const { record } = await recordS2([
    { calls: [searchCall(1, "spark plug electrode gap")], failAfter: typedStreamError("planner_incomplete", "provider_incomplete") },
  ]);

  assert.deepEqual(record.providerErrors, [
    { turn: 1, httpStatus: null, kind: "typed_stream", code: "planner_incomplete", reason: "provider_incomplete", name: "ScriptedStreamError" },
  ]);
  assert.equal(record.outcome.code, "planner_incomplete");
  assert.equal(record.outcome.reason, "provider_incomplete");
  assert.equal(record.turns[0].calls[0].disposition, "not_run", "the stream died before the agent ran it");
  assert.equal(record.turns[0].streamCompleted, false);
});

test("a model that stops calling tools is a completed stream with no calls", async () => {
  const { record } = await recordS2([[]]);

  assert.deepEqual(record.turns, [{ turn: 1, streamCompleted: true, frameCount: 0, calls: [] }]);
  assert.deepEqual(record.outcome, { status: "error", code: "planner_invalid_output", reason: "invalid_final_contract", evidenceStatus: null });
});

// ---- 4. What is recorded is a copy, and only content -------------------------------

test("the record holds copies: arguments and chunks cannot be altered through it", async () => {
  const claimsSeen = [];
  const model = createScriptedModel([
    [searchCall(1, "spark plug electrode gap")],
    ({ input }) => {
      const call = finalizeCall([s2Claim(input)]);
      claimsSeen.push(call.arguments);
      return [call];
    },
  ]);
  const record = await runPlannerCase(S2, {
    ...baseDeps(),
    streamTurn: model.streamTurn,
    retrieve: createKeywordRetriever(MINI_CORPORA.S2),
  });

  assert.notEqual(record.finalizers[0].arguments, claimsSeen[0]);
  assert.deepEqual(record.finalizers[0].arguments, claimsSeen[0]);
});

test("a retrieved chunk is recorded with its primitive fields only", async () => {
  const model = createScriptedModel([[searchCall(1, "spark plug electrode gap")], [finalizeCall([])]]);
  const record = await runPlannerCase(S2, {
    ...baseDeps(),
    streamTurn: model.streamTurn,
    retrieve: async () => [
      { documentId: 1, pageNumber: 1, chunkIndex: 0, documentTitle: "T", originalFilename: "t.pdf", chunkText: "text", score: 0.5, nested: { a: 1 }, tags: ["x", "y"] },
    ],
  });
  const [chunk] = record.retrievals[0].results;

  assert.equal(chunk.score, 0.5);
  assert.deepEqual(chunk.tags, ["x", "y"], "an array of primitives is kept");
  assert.equal("nested" in chunk, false, "an object is not");
});

test("the outputs hold what the owner reads and saves, but no capability ids", async () => {
  const { record } = await recordS2();
  const { outputs } = record;

  for (const key of ["text", "checklistDraft", "checklist", "handoffNotes", "readiness", "requirements", "citations", "evidence"]) {
    assert.ok(outputs[key] !== undefined && outputs[key] !== null, `outputs.${key}`);
  }
  assert.ok(outputs.evidence.verifiedClaims.length >= 1);
  assert.ok(Array.isArray(outputs.evidence.gaps));
  assert.equal(outputs.hasChecklistDraftId, true);
  assert.equal(outputs.hasPlanRunId, false, "the spark plug job is not safety-critical");
  assert.doesNotMatch(JSON.stringify(record), /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/, "no random id: it would make two identical runs differ");
});

test("each run gets its own plan-run store", async () => {
  let made = 0;
  const createPlanRuns = () => {
    made += 1;
    return createPlanRunStore();
  };

  await recordS2(s2Happy(), { createPlanRuns });
  await recordS2(s2Happy(), { createPlanRuns });

  assert.equal(made, 2);
});

// ---- 5. The recorder fails closed when the sequence is not what it assumes ----------

const SEARCH_FRAME = { type: "tool_call", name: "search_repair_docs", turn: 1, taskId: 1 };

/** A fake agent that makes the calls a test describes, in the order it describes. */
const fakeAgent = (drive) => async (_request, options) => {
  await drive(options);
  return { status: "completed", text: "", artifacts: {} };
};

async function drain(streamTurn) {
  await Array.fromAsync(streamTurn({ input: [] }));
}

// `drive` receives the runner's WRAPPED seams (emit, streamTurn, retrieve), exactly
// as the real agent does, and calls them in whatever order the test describes.
async function expectOutOfSync(drive, message, steps = [[searchCall(1, "oil drain plug torque")]]) {
  const model = createScriptedModel(steps);

  await assert.rejects(
    runPlannerCase(S1, {
      runAgent: fakeAgent(drive),
      extractTasks: extractRepairTasks,
      streamTurn: model.streamTurn,
      retrieve: createKeywordRetriever(MINI_CORPORA.S1),
    }),
    (error) => {
      assert.ok(error instanceof RecorderOutOfSync, `expected RecorderOutOfSync, got ${error}`);
      assert.match(error.message, message);
      assert.ok(error.record, "the partial record is attached for debugging");
      return true;
    }
  );
}

test("a retrieval outside any frame is refused, loudly", async () => {
  await expectOutOfSync(async ({ streamTurn, retrieve }) => {
    await drain(streamTurn);
    await retrieve("oil drain plug torque", { limit: 2 });
  }, /outside any tool call/);
});

test("a retrieval during a call that is not a search is refused", async () => {
  await expectOutOfSync(
    async ({ streamTurn, emit, retrieve }) => {
      await drain(streamTurn);
      emit({ type: "tool_call", name: "check_repair_readiness", turn: 1 });
      await retrieve("oil drain plug torque", { limit: 2 });
    },
    /not a search/,
    [[toolCall("check_repair_readiness")]]
  );
});

test("a frame whose name disagrees with the call the model made is refused", async () => {
  await expectOutOfSync(async ({ streamTurn, emit }) => {
    await drain(streamTurn);
    emit({ type: "tool_call", name: "finalize_repair_plan", turn: 1 });
  }, /frame.*finalize_repair_plan.*search_repair_docs/);
});

test("a frame with no matching call is refused", async () => {
  await expectOutOfSync(async ({ streamTurn, emit }) => {
    await drain(streamTurn);
    emit(SEARCH_FRAME);
    emit({ type: "tool_result", name: "search_repair_docs", summary: "ok" });
    emit(SEARCH_FRAME);
  }, /more frames than calls/);
});

test("a frame for a turn the model never started is refused", async () => {
  await expectOutOfSync(async ({ emit }) => {
    emit({ ...SEARCH_FRAME, turn: 1 });
  }, /before any model turn|no model turn/);
});

test("a tool result that names a different tool than the open frame is refused", async () => {
  await expectOutOfSync(async ({ streamTurn, emit }) => {
    await drain(streamTurn);
    emit(SEARCH_FRAME);
    emit({ type: "tool_result", name: "finalize_repair_plan", summary: "ok" });
  }, /tool_result.*finalize_repair_plan/);
});

test("an out-of-sync retrieval still returns what the retriever returned, so behavior is unchanged", async () => {
  let got = null;
  const model = createScriptedModel([[searchCall(1, "oil drain plug torque")]]);
  const underlying = createKeywordRetriever(MINI_CORPORA.S1);

  await assert.rejects(
    runPlannerCase(S1, {
      runAgent: fakeAgent(async ({ retrieve }) => {
        got = await retrieve("oil drain plug torque", { limit: 2 });
      }),
      extractTasks: extractRepairTasks,
      streamTurn: model.streamTurn,
      retrieve: underlying,
    }),
    RecorderOutOfSync
  );

  assert.deepEqual(got, await underlying("oil drain plug torque", { limit: 2 }));
});

test("a legal sequence driven by a fake agent is accepted", async () => {
  const model = createScriptedModel([[searchCall(1, "oil drain plug torque")]]);
  const record = await runPlannerCase(S1, {
    runAgent: fakeAgent(async ({ streamTurn, emit, retrieve }) => {
      await drain(streamTurn);
      emit(SEARCH_FRAME);
      await retrieve("oil drain plug torque", { limit: 2 });
      emit({ type: "tool_result", name: "search_repair_docs", summary: "ok" });
    }),
    extractTasks: extractRepairTasks,
    streamTurn: model.streamTurn,
    retrieve: createKeywordRetriever(MINI_CORPORA.S1),
  });

  assert.equal(record.retrievals.length, 1);
  assert.equal(record.turns[0].calls[0].disposition, "retrieved");
});

// ---- 6. The runner is importable with no database ------------------------------------

test("loading the runner, the scripted model, the scenarios and the corpora opens no database", () => {
  const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-planner-runner-import-"));
  const here = path.dirname(fileURLToPath(import.meta.url));
  const url = (relative) => pathToFileURL(path.resolve(here, "..", relative)).href;

  try {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        [
          `const runner = await import(${JSON.stringify(url("src/evals/plannerCaseRunner.js"))});`,
          `await import(${JSON.stringify(url("src/evals/plannerScriptedModel.js"))});`,
          `await import(${JSON.stringify(url("src/evals/plannerScenarios.js"))});`,
          `await import(${JSON.stringify(url("src/evals/fixtures/plannerMiniCorpora.js"))});`,
          "console.log(Object.keys(runner).sort().join(','));",
        ].join("\n"),
      ],
      {
        // The whole environment, so the test-context guard still keeps a local
        // .env out of the child; only the two paths are redirected.
        env: {
          ...process.env,
          DATABASE_FILE: path.join(probeRoot, "not-created", "probe.db"),
          UPLOADS_DIR: path.join(probeRoot, "not-created", "uploads"),
        },
        encoding: "utf8",
      }
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "RecorderOutOfSync,recordPlannerRun,runPlannerCase");
    assert.deepEqual(fs.readdirSync(probeRoot), [], "importing the runner created a database or uploads folder");
  } finally {
    fs.rmSync(probeRoot, { recursive: true, force: true });
  }
});

test("a scenario with an absent fact still runs: S8 records a correct refusal", async () => {
  const model = createScriptedModel([[searchCall(1, "timing belt replacement interval")], [finalizeCall([])]]);
  const record = await runPlannerCase(S8, {
    ...baseDeps(),
    streamTurn: model.streamTurn,
    retrieve: createKeywordRetriever(MINI_CORPORA["S8-premise-holds"]),
  });

  assert.equal(record.outcome.evidenceStatus, "not_found");
  assert.deepEqual(record.tasks.map((task) => task.title), ["Replace the timing belt."]);
});
