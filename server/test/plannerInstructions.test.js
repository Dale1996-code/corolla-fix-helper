import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import { MINI_CORPORA, createKeywordRetriever } from "../src/evals/fixtures/plannerMiniCorpora.js";
import { scriptedRun } from "../src/evals/fixtures/plannerScriptedRuns.js";
import { createPlanRunStore } from "../src/services/agent/planRunStore.js";

// Planner eval Phase 3, P-2 (docs/planner-eval-spec.md, section 3).
//
// A capture header records WHICH PROMPT produced a run, as a hash of the
// planner's instruction text. For that hash to mean anything, the text it is
// taken from must be the very string the agent hands the model: not a copy that
// could drift, not a reconstruction. So repairPlannerAgent.js exports the
// constant it passes to streamTurn, and these tests pin both halves:
//
//   1. what the agent actually sends as `instructions`, on every turn, is the
//      exported string;
//   2. the string itself is the one this work was built against (its hash).
//
// The second pin is deliberate friction. Phase 3 may not change any prompt, and
// the hash makes a prompt edit a visible, conscious act instead of a quiet one.

// The real agent opens the database when it loads, so the scratch paths come
// first (databaseIsolation.test.js enforces this order for every suite).
const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-planner-instructions-"));
process.env.DATABASE_FILE = path.join(scratchRoot, "instructions.db");
process.env.UPLOADS_DIR = path.join(scratchRoot, "uploads");
process.env.OPENAI_API_KEY = "";
process.env.NETWORK_MODE = "0";
fs.mkdirSync(process.env.UPLOADS_DIR, { recursive: true });

const { db } = await import("../src/database.js");
const agentModule = await import("../src/services/agent/repairPlannerAgent.js");

after(() => {
  if (typeof db.close === "function") {
    db.close();
  }
  fs.rmSync(scratchRoot, { recursive: true, force: true });
});

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

// sha256 of the instruction text as of this work. Update it only when the
// planner prompt is changed ON PURPOSE, and say so in the PR that changes it.
const PINNED_INSTRUCTIONS_SHA256 = "c44aeb62ccb6e475ce2670820a332e22c81602339a8220e5b88ac2716454b666";

test("the agent hands the model exactly the exported instruction text, on every turn", async () => {
  const exported = agentModule.AGENT_INSTRUCTIONS;

  assert.equal(typeof exported, "string", "repairPlannerAgent.js must export AGENT_INSTRUCTIONS");
  assert.ok(exported.length > 0);

  // Two model turns (search, then finalize), so a prompt that changed between
  // turns would be caught too.
  const run = scriptedRun("S1-correct-only");
  const result = await agentModule.runRepairPlannerAgent(
    { brief: "Change the engine oil and replace the oil filter." },
    {
      isAiConfigured: true,
      streamTurn: run.model.streamTurn,
      retrieve: createKeywordRetriever(MINI_CORPORA[run.corpus]),
      planRuns: createPlanRunStore(),
    }
  );

  assert.equal(result.status, "completed", JSON.stringify(result));
  assert.equal(run.model.inputs.length, 2, "the script plays two turns");

  for (const { turn, instructions } of run.model.inputs) {
    assert.equal(instructions, exported, `turn ${turn} sent instructions other than the exported text`);
  }
});

test("the instruction text is the one this work was built against", () => {
  assert.equal(
    sha256(agentModule.AGENT_INSTRUCTIONS),
    PINNED_INSTRUCTIONS_SHA256,
    "The planner prompt changed. Prompt edits are outside the eval work: if this one is intended, " +
      "update PINNED_INSTRUCTIONS_SHA256 here (and in plannerCapture.test.js) and say so in the PR."
  );
});

test("the hash is stable: the same text always hashes the same", () => {
  assert.equal(sha256(agentModule.AGENT_INSTRUCTIONS), sha256(String(agentModule.AGENT_INSTRUCTIONS)));
  assert.match(sha256(agentModule.AGENT_INSTRUCTIONS), /^[0-9a-f]{64}$/);
});
