import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

// Cost bounds on the Repair Planner's tool loop (audit Stage 5-E1). The model
// chooses how many chunks a search returns and how many tools it calls at
// once; each of those is a retrieval, an embedding request, and tool output
// that rides back into the next turn's input. These tests pin the ceilings.
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-fix-helper-planner-bounds-"));

process.env.DATABASE_FILE = path.join(tempRoot, "planner-bounds.db");
process.env.UPLOADS_DIR = path.join(tempRoot, "uploads");
process.env.OPENAI_API_KEY = "";
process.env.NETWORK_MODE = "0";

fs.mkdirSync(process.env.UPLOADS_DIR, { recursive: true });

const { db } = await import("../src/database.js");
const {
  clampSearchLimit,
  DEFAULT_SEARCH_RESULTS,
  MAX_SEARCH_RESULTS,
  repairToolSchemas,
  searchRepairDocs,
} = await import("../src/services/agent/repairTools.js");
const { runRepairPlannerAgent } = await import("../src/services/agent/repairPlannerAgent.js");

after(() => {
  if (typeof db.close === "function") {
    db.close();
  }

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("the search schema tells the model the result bound (1A-20)", () => {
  const search = repairToolSchemas.find((schema) => schema.name === "search_repair_docs");
  const { limit } = search.parameters.properties;

  assert.equal(MAX_SEARCH_RESULTS, 8);
  assert.equal(limit.type, "integer");
  assert.equal(limit.minimum, 1);
  assert.equal(limit.maximum, MAX_SEARCH_RESULTS);
  assert.match(
    limit.description,
    new RegExp(`default ${DEFAULT_SEARCH_RESULTS}, at most ${MAX_SEARCH_RESULTS}`)
  );
});

test("the search limit is clamped in code, whatever the model sends (2B-03)", () => {
  const cases = [
    [1, 1],
    [4, 4],
    [8, 8],
    [9, MAX_SEARCH_RESULTS],
    [500, MAX_SEARCH_RESULTS],
    [1e9, MAX_SEARCH_RESULTS],
    ["6", 6],
    [2.7, 2],
    // Not a usable count: the default, never the retriever's own default of 8.
    [0, DEFAULT_SEARCH_RESULTS],
    [-3, DEFAULT_SEARCH_RESULTS],
    [undefined, DEFAULT_SEARCH_RESULTS],
    [null, DEFAULT_SEARCH_RESULTS],
    ["many", DEFAULT_SEARCH_RESULTS],
    [Number.NaN, DEFAULT_SEARCH_RESULTS],
    [Number.POSITIVE_INFINITY, DEFAULT_SEARCH_RESULTS],
  ];

  for (const [requested, expected] of cases) {
    assert.equal(clampSearchLimit(requested), expected, `limit ${String(requested)}`);
  }
});

test("searchRepairDocs hands the retriever the clamped limit", async () => {
  const seen = [];
  const retrieve = async (_query, options) => {
    seen.push(options.limit);
    return [];
  };

  await searchRepairDocs({ query: "caliper torque", limit: 500 }, { retrieve });
  await searchRepairDocs({ query: "caliper torque" }, { retrieve });
  await searchRepairDocs({ query: "caliper torque", limit: 0 }, { retrieve });

  assert.deepEqual(seen, [MAX_SEARCH_RESULTS, DEFAULT_SEARCH_RESULTS, DEFAULT_SEARCH_RESULTS]);
});

test("a planner run never retrieves more than the bound per search", async () => {
  const seen = [];
  let turn = 0;

  async function* streamTurn() {
    turn += 1;

    if (turn === 1) {
      yield {
        type: "function_call",
        callId: "c1",
        name: "search_repair_docs",
        arguments: { taskId: 1, query: "front brake pads", limit: 500 },
      };
      return;
    }

    yield {
      type: "function_call",
      callId: "c2",
      name: "finalize_repair_plan",
      arguments: { claims: [] },
    };
  }

  const result = await runRepairPlannerAgent(
    { brief: "Replace the front brake pads." },
    {
      streamTurn,
      retrieve: async (_query, options) => {
        seen.push(options.limit);
        return [];
      },
      isAiConfigured: true,
    }
  );

  assert.equal(result.status, "completed");
  assert.deepEqual(seen, [MAX_SEARCH_RESULTS]);
});
