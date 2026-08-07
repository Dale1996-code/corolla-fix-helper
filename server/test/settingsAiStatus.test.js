// GET /api/settings -> `ai`: the safe AI status block behind the Settings page.
//
// Two things are load-bearing here: the raw OPENAI_API_KEY must never leave the
// server, and "AI calls today" must count the real provider choke points (and
// only those) so the number on screen matches what the daily spend ceiling
// counts.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, beforeEach } from "node:test";
import request from "supertest";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-settings-ai-"));

// A value distinctive enough that a substring search over the whole response
// body is a meaningful leak check.
const SECRET_API_KEY = "sk-test-DO-NOT-LEAK-4f8c2a";

process.env.DATABASE_FILE = path.join(tempRoot, "test.db");
process.env.UPLOADS_DIR = path.join(tempRoot, "uploads");
process.env.OPENAI_API_KEY = SECRET_API_KEY;
process.env.OPENAI_ANSWER_MODEL = "gpt-test-answer-model";
// The ceiling disabled is the owner's documented posture (see
// docs/evals/ask-rag-iteration-log.md). Counting must still work here, or the
// Settings page would permanently read zero.
process.env.AI_DAILY_CALL_LIMIT = "0";
process.env.ASK_EVIDENCE_CONTRACT = "false";
process.env.OCR_ENABLED = "false";

const { config } = await import("../src/config.js");
const { db } = await import("../src/database.js");
const { createApp } = await import("../src/app.js");
const { postToOpenAiResponses } = await import("../src/services/aiAnswerService.js");
const { streamResponsesTurn } = await import(
  "../src/services/agent/openAiResponsesClient.js"
);
const { getAiUsageSnapshot, reserveAiCall, resetAiUsageBudgetForTests } = await import(
  "../src/services/aiUsageBudget.js"
);

const app = createApp();

after(() => {
  if (typeof db.close === "function") {
    db.close();
  }
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

beforeEach(() => {
  resetAiUsageBudgetForTests();
  config.openAiApiKey = SECRET_API_KEY;
});

// Build the `ai` block in a fresh process with the given environment, so
// default resolution is exercised without this suite's own env leaking in.
function probeAiSettings(overrides) {
  const probe = `
    const { getAiSettings } = await import("./src/routes/settings.js");
    console.log(JSON.stringify(getAiSettings()));
  `;

  return JSON.parse(
    execFileSync(process.execPath, ["--input-type=module", "--eval", probe], {
      cwd: new URL("..", import.meta.url),
      encoding: "utf8",
      env: {
        ...process.env,
        DATABASE_FILE: path.join(tempRoot, "probe.db"),
        UPLOADS_DIR: path.join(tempRoot, "probe-uploads"),
        ...overrides,
      },
    })
  );
}

// Minimal stand-in for a completed non-streaming Responses call.
async function fakeOkFetch() {
  return {
    ok: true,
    async json() {
      return { status: "completed", output_text: "ok" };
    },
    async text() {
      return "";
    },
  };
}

// Minimal stand-in for a completed SSE stream (the planner's choke point).
function fakeStreamFetch() {
  return async () => {
    const encoder = new TextEncoder();
    const frames = [encoder.encode(`data: ${JSON.stringify({ type: "response.completed" })}\n\n`)];
    let index = 0;

    return {
      ok: true,
      body: {
        getReader() {
          return {
            async read() {
              if (index >= frames.length) {
                return { done: true, value: undefined };
              }

              return { done: false, value: frames[index++] };
            },
            releaseLock() {},
          };
        },
      },
    };
  };
}

test("reports a configured API key without revealing it", async () => {
  const response = await request(app).get("/api/settings");

  assert.equal(response.status, 200);
  assert.equal(response.body.ai.apiKeyConfigured, true);

  // The key must not appear anywhere in the payload -- not as a field, not
  // partially, not as a masked prefix.
  const serialized = JSON.stringify(response.body);
  assert.ok(!serialized.includes(SECRET_API_KEY));
  assert.ok(!serialized.includes(SECRET_API_KEY.slice(0, 8)));
  assert.equal(Object.hasOwn(response.body.ai, "apiKey"), false);
  assert.deepEqual(Object.keys(response.body.ai).sort(), [
    "apiKeyConfigured",
    "callsToday",
    "countPersistsAcrossRestart",
    "countingBasis",
    "dailyCallLimit",
    "dayBoundary",
    "model",
  ]);
});

test("reports a missing API key as not configured", async () => {
  config.openAiApiKey = "";

  const response = await request(app).get("/api/settings");

  assert.equal(response.status, 200);
  assert.equal(response.body.ai.apiKeyConfigured, false);
});

test("returns the effective answer model from server config", async () => {
  const response = await request(app).get("/api/settings");

  assert.equal(response.body.ai.model, "gpt-test-answer-model");
  assert.equal(response.body.ai.model, config.openAiAnswerModel);
});

test("falls back to the pinned default model when no override is configured", () => {
  // A fresh process with no OPENAI_ANSWER_MODEL / OPENAI_API_KEY, so the block
  // is built from the config module's own defaults rather than this suite's env.
  const probed = probeAiSettings({ OPENAI_ANSWER_MODEL: "", OPENAI_MODEL: "", OPENAI_API_KEY: "" });

  assert.equal(probed.model, "gpt-5.5-2026-04-23");
  assert.equal(probed.apiKeyConfigured, false);
  assert.equal(probed.callsToday, 0);
});

test("with no AI activity the daily count is zero, not missing", async () => {
  const response = await request(app).get("/api/settings");

  assert.equal(response.body.ai.callsToday, 0);
  assert.equal(response.body.ai.countingBasis, "provider requests");
  assert.equal(response.body.ai.dayBoundary, "local");
  assert.equal(response.body.ai.countPersistsAcrossRestart, false);
});

test("counts provider requests from both the Ask and planner choke points", async () => {
  // Ask side: the shared non-streaming poster.
  await postToOpenAiResponses({ model: "m", input: "hi" }, { fetchImpl: fakeOkFetch });

  // Planner side: one streamed agent turn.
  const turn = streamResponsesTurn({
    apiKey: "test-key",
    model: "m",
    input: "hi",
    fetchImpl: fakeStreamFetch(),
  });
  // Drain the generator so the turn actually runs.
  await Array.fromAsync(turn);

  const response = await request(app).get("/api/settings");

  assert.equal(response.body.ai.callsToday, 2);
});

test("counting continues while the daily ceiling is disabled", () => {
  assert.equal(config.openAiDailyCallLimit, 0);

  reserveAiCall();
  reserveAiCall();

  assert.equal(getAiUsageSnapshot().callsToday, 2);
});

test("requests that never reach the provider do not count", async () => {
  // A status check is not AI activity.
  await request(app).get("/api/settings");
  await request(app).get("/api/settings");
  assert.equal(getAiUsageSnapshot().callsToday, 0);

  // Neither is a request rejected by route validation before any model call.
  const rejected = await request(app).post("/api/ask").send({ question: "   " });
  assert.equal(rejected.status, 400);
  assert.equal(getAiUsageSnapshot().callsToday, 0);

  const stillZero = await request(app).get("/api/settings");
  assert.equal(stillZero.body.ai.callsToday, 0);
});

test("a call refused by the daily ceiling is not counted", () => {
  reserveAiCall({ limit: 1 });
  assert.throws(() => reserveAiCall({ limit: 1 }));

  assert.equal(getAiUsageSnapshot().callsToday, 1);
});

test("the day boundary filters and resets the count", () => {
  const morning = new Date(2026, 6, 24, 9, 0, 0).getTime();
  const lateNight = new Date(2026, 6, 24, 23, 59, 59).getTime();
  const nextDay = new Date(2026, 6, 25, 0, 0, 1).getTime();

  reserveAiCall({ now: morning });
  reserveAiCall({ now: lateNight });
  assert.equal(getAiUsageSnapshot({ now: lateNight }).callsToday, 2);

  // Reading on a later day reports zero even before any call rolls the counter,
  // so an idle server never shows yesterday's total as today's.
  assert.equal(getAiUsageSnapshot({ now: nextDay }).callsToday, 0);

  reserveAiCall({ now: nextDay });
  assert.equal(getAiUsageSnapshot({ now: nextDay }).callsToday, 1);
});

test("the backup block advertises the CLI restore command", async () => {
  const response = await request(app).get("/api/settings");

  assert.equal(response.body.backupExport.restore.method, "cli");
  assert.equal(
    response.body.backupExport.restore.command,
    'npm run restore -- "/path/to/corolla-fix-helper-backup-....tar.gz"'
  );
  assert.equal(response.body.backupExport.restore.documentation, "docs/backup-restore.md");
});
