import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import request from "supertest";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-ai-guardrails-"));

process.env.DATABASE_FILE = path.join(tempRoot, "test.db");
process.env.UPLOADS_DIR = path.join(tempRoot, "uploads");
process.env.OPENAI_API_KEY = "";

const { createApp } = await import("../src/app.js");
const { db } = await import("../src/database.js");
const { createRateLimiter } = await import("../src/middleware/rateLimit.js");
const { postToOpenAiResponses, OPENAI_TIMEOUT_MESSAGE } = await import(
  "../src/services/aiAnswerService.js"
);
const { MAX_QUESTION_LENGTH } = await import("../src/routes/ask.js");

after(() => {
  if (typeof db.close === "function") {
    db.close();
  }

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("POST /api/ask returns a generic 429 once the rate limit is exceeded", async () => {
  const app = createApp({
    askQuestion: async () => ({ status: "ok", answer: "hi", citations: [] }),
    aiRateLimiter: createRateLimiter({ windowMs: 60_000, max: 2 }),
  });

  const send = () =>
    request(app).post("/api/ask").send({ question: "How do I change the oil?" });

  assert.equal((await send()).status, 200);
  assert.equal((await send()).status, 200);

  const limited = await send();
  assert.equal(limited.status, 429);
  assert.ok(limited.body.error, "a 429 returns an error message");
  assert.ok(
    !/\bat \/|\.js:\d/.test(limited.body.error),
    "the 429 message is generic, not a stack trace"
  );
});

test("POST /api/ask rejects an over-long question with 400", async () => {
  const app = createApp({
    askQuestion: async () => ({ status: "ok", answer: "hi", citations: [] }),
  });

  const response = await request(app)
    .post("/api/ask")
    .send({ question: "x".repeat(MAX_QUESTION_LENGTH + 1) });

  assert.equal(response.status, 400);
  assert.match(response.body.error, /too long/i);
});

test("postToOpenAiResponses surfaces a friendly timeout message, not a stack trace", async () => {
  // A fetch that never resolves until the AbortController cancels it.
  const hangingFetch = (_url, options) =>
    new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      });
    });

  await assert.rejects(
    () =>
      postToOpenAiResponses(
        { model: "x", input: "y" },
        { fetchImpl: hangingFetch, timeoutMs: 10 }
      ),
    (error) => {
      assert.equal(error.message, OPENAI_TIMEOUT_MESSAGE);
      return true;
    }
  );
});
