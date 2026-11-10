import assert from "node:assert/strict";
import test from "node:test";

import {
  createScriptedModel,
  finalizeCall,
  providerHttpError,
  searchCall,
  sourceIdFor,
  toolCall,
  typedStreamError,
} from "../src/evals/plannerScriptedModel.js";

// The scripted model stands in for the OpenAI stream so a whole planner run can
// be driven with no key and no network. It must be boring and loud: the same
// script gives the same calls, and a script that runs out of turns is a test
// bug, never a model that quietly stops.

const drain = async (stream) => {
  const events = [];
  for await (const event of stream) events.push(event);
  return events;
};

test("a step of calls yields function_call events with deterministic ids", async () => {
  const model = createScriptedModel([[searchCall(1, "oil drain plug torque"), toolCall("check_repair_readiness")]]);
  const events = await drain(model.streamTurn({ input: [] }));

  assert.deepEqual(events, [
    {
      type: "function_call",
      callId: "call_1_1",
      name: "search_repair_docs",
      arguments: { taskId: 1, query: "oil drain plug torque" },
    },
    { type: "function_call", callId: "call_1_2", name: "check_repair_readiness", arguments: {} },
  ]);
});

test("an explicit call id is kept and the helpers build the documented shapes", () => {
  assert.deepEqual(searchCall(2, "q", { limit: 3 }), {
    name: "search_repair_docs",
    arguments: { taskId: 2, query: "q", limit: 3 },
  });
  assert.deepEqual(finalizeCall([{ a: 1 }]), { name: "finalize_repair_plan", arguments: { claims: [{ a: 1 }] } });
  assert.deepEqual(toolCall("x", { y: 1 }, "my-id"), { name: "x", arguments: { y: 1 }, callId: "my-id" });
});

test("a step may be a function of the turn and the input the model was just given", async () => {
  const seen = [];
  const model = createScriptedModel([
    ({ turn, input }) => {
      seen.push([turn, input.length]);
      return [toolCall("a")];
    },
  ]);

  await drain(model.streamTurn({ input: [{ role: "user" }] }));

  assert.deepEqual(seen, [[1, 1]]);
});

test("every turn's input and tool names are recorded for the test to inspect", async () => {
  const model = createScriptedModel([[], []]);
  const input = [{ role: "user", content: "hello" }];

  await drain(model.streamTurn({ input, instructions: "be brief", tools: [{ name: "t1" }, { name: "t2" }] }));
  await drain(model.streamTurn({ input: [], instructions: "be brief", tools: [] }));

  assert.equal(model.inputs.length, 2);
  assert.deepEqual(model.inputs[0], { turn: 1, input, instructions: "be brief", toolNames: ["t1", "t2"] });
  assert.equal(model.turnsStarted, 2);
});

test("an empty step is a model that stopped calling tools", async () => {
  const model = createScriptedModel([[]]);

  assert.deepEqual(await drain(model.streamTurn({ input: [] })), []);
});

test("a script that runs out of turns fails loudly instead of ending the run quietly", async () => {
  const model = createScriptedModel([[]]);

  await drain(model.streamTurn({ input: [] }));

  await assert.rejects(drain(model.streamTurn({ input: [] })), /no step for turn 2/);
});

test("a failing step throws before yielding anything", async () => {
  const error = providerHttpError(429);
  const model = createScriptedModel([{ fail: error }]);
  const events = [];

  await assert.rejects(
    (async () => {
      for await (const event of model.streamTurn({ input: [] })) events.push(event);
    })(),
    error
  );
  assert.deepEqual(events, []);
});

test("a truncated stream yields its calls and then throws", async () => {
  const error = typedStreamError("planner_incomplete", "provider_incomplete");
  const model = createScriptedModel([{ calls: [toolCall("a")], failAfter: error }]);
  const events = [];

  await assert.rejects(
    (async () => {
      for await (const event of model.streamTurn({ input: [] })) events.push(event);
    })(),
    error
  );
  assert.equal(events.length, 1);
});

test("provider errors carry a status or a typed code and never a response body", () => {
  const http = providerHttpError(429);
  const typed = typedStreamError("planner_incomplete", "provider_incomplete");

  assert.ok(http instanceof Error && typed instanceof Error);
  assert.equal(http.failure.httpStatus, 429);
  assert.equal("diagnostic" in http.failure, false, "the scripted error holds no provider body");
  assert.equal(typed.code, "planner_incomplete");
  assert.equal(typed.reason, "provider_incomplete");
  assert.equal(typed.failure, undefined);
});

// ---- sourceIdFor: finding the id the run assigned to a retrieved chunk --------

const searchOutput = (context) => ({
  type: "function_call_output",
  call_id: "c",
  output: JSON.stringify({ query: "q", taskId: 1, citations: [], context }),
});

test("sourceIdFor reads the run-assigned id from a search result's context", () => {
  const input = [
    { role: "user", content: "[S9] this is the brief, not a search result" },
    searchOutput("[S1] Alpha Guide (page 1): first text\n\n[S2] Beta Guide (page 4): second text"),
  ];

  assert.equal(sourceIdFor(input, /second text/), "S2");
  assert.equal(sourceIdFor(input, /Alpha Guide/), "S1");
});

test("sourceIdFor refuses to guess when nothing or more than one source matches", () => {
  const input = [searchOutput("[S1] Alpha (page 1): shared words\n\n[S2] Beta (page 2): shared words")];

  assert.throws(() => sourceIdFor(input, /no such text/), /no retrieved source matched/);
  assert.throws(() => sourceIdFor(input, /shared words/), /matched 2 sources/);
});

test("sourceIdFor ignores tool outputs that are not search results", () => {
  const input = [
    { type: "function_call_output", call_id: "x", output: JSON.stringify({ tasks: [{ id: 1 }] }) },
    { type: "function_call_output", call_id: "y", output: "not json at all" },
    searchOutput("[S3] Gamma (page 2): wanted text"),
  ];

  assert.equal(sourceIdFor(input, /wanted text/), "S3");
});
