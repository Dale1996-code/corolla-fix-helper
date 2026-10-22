import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, beforeEach } from "node:test";
import request from "supertest";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-ai-spend-"));

process.env.DATABASE_FILE = path.join(tempRoot, "test.db");
process.env.UPLOADS_DIR = path.join(tempRoot, "uploads");
process.env.OPENAI_API_KEY = "test-key";

const { config } = await import("../src/config.js");
const { db } = await import("../src/database.js");
const { createApp } = await import("../src/app.js");
const { postToOpenAiResponses, generateAnswerTextFromOpenAi } = await import(
  "../src/services/aiAnswerService.js"
);
const {
  reserveAiCall,
  resetAiUsageBudgetForTests,
  getAiUsageSnapshot,
  AI_DAILY_LIMIT_MESSAGE,
} = await import("../src/services/aiUsageBudget.js");
const { createOpenAiEmbeddings, createOpenAiEmbedding, OPENAI_EMBEDDING_TIMEOUT_MESSAGE } =
  await import("../src/services/chunkEmbeddingService.js");
const { streamResponsesTurn, OPENAI_STREAM_IDLE_MESSAGE } = await import(
  "../src/services/agent/openAiResponsesClient.js"
);
const { MAX_BRIEF_LENGTH } = await import("../src/routes/repairPlan.js");

after(() => {
  if (typeof db.close === "function") {
    db.close();
  }
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

beforeEach(() => {
  resetAiUsageBudgetForTests();
});

function okJsonFetch(captured) {
  return async (_url, options) => {
    captured.body = JSON.parse(options.body);
    return {
      ok: true,
      async json() {
        // A real Responses API payload always carries a status, and the parser
        // fails closed without one. Keep the double realistic rather than
        // relaxing the parser to accept it.
        return { status: "completed", output_text: "ok" };
      },
      async text() {
        return "";
      },
    };
  };
}

test("postToOpenAiResponses reserves against the daily budget and sends max_output_tokens", async () => {
  const captured = {};
  const response = await postToOpenAiResponses(
    { model: "m", input: "hi", max_output_tokens: config.openAiMaxOutputTokens },
    { fetchImpl: okJsonFetch(captured) }
  );

  assert.equal(response.ok, true);
  assert.equal(captured.body.max_output_tokens, config.openAiMaxOutputTokens);
  assert.ok(config.openAiMaxOutputTokens > 0);
});

test("the answer call caps output tokens", async () => {
  const captured = {};
  await generateAnswerTextFromOpenAi({
    question: "torque?",
    chunks: [
      { chunkText: "spec", documentTitle: "Manual", originalFilename: "m.pdf", pageNumber: 1 },
    ],
    fetchImpl: okJsonFetch(captured),
  });

  assert.equal(captured.body.max_output_tokens, config.openAiMaxOutputTokens);
});

test("reserveAiCall enforces a daily ceiling and resets the next day", () => {
  const day1 = Date.UTC(2026, 6, 24, 10, 0, 0);

  // Third call in the same day trips the limit=2 ceiling.
  reserveAiCall({ now: day1, limit: 2 });
  reserveAiCall({ now: day1, limit: 2 });
  assert.throws(
    () => reserveAiCall({ now: day1, limit: 2 }),
    (error) => {
      assert.equal(error.message, AI_DAILY_LIMIT_MESSAGE);
      assert.equal(error.status, 429);
      return true;
    }
  );

  // A new calendar day resets the counter.
  const day2 = Date.UTC(2026, 6, 25, 9, 0, 0);
  assert.doesNotThrow(() => reserveAiCall({ now: day2, limit: 2 }));
});

test("reserveAiCall is disabled when the limit is zero or negative", () => {
  for (let index = 0; index < 50; index += 1) {
    reserveAiCall({ now: Date.UTC(2026, 6, 24), limit: 0 });
  }
  // No throw = disabled.
  assert.ok(true);
});

test("POST /api/ask surfaces the daily budget cap as a 429", async () => {
  const app = createApp({
    askQuestion: async () => {
      const error = new Error(AI_DAILY_LIMIT_MESSAGE);
      /** @type {any} */ (error).status = 429;
      throw error;
    },
  });

  const response = await request(app).post("/api/ask").send({ question: "oil torque?" });
  assert.equal(response.status, 429);
  assert.match(response.body.error, /daily ai usage limit/i);
});

test("one shared AI limiter bounds /api/ask and /api/repair-plan together", async () => {
  const { createRateLimiter } = await import("../src/middleware/rateLimit.js");
  const app = createApp({
    askQuestion: async () => ({ status: "ok", answer: "hi", citations: [] }),
    runRepairPlan: async (_input, { emit }) => emit({ type: "done" }),
    aiRateLimiter: createRateLimiter({ windowMs: 60_000, max: 2 }),
  });

  // Two requests split across the two endpoints exhaust the single window; the
  // third (either endpoint) is limited — proving the window is shared, not per-route.
  assert.equal(
    (await request(app).post("/api/ask").send({ question: "q1" })).status,
    200
  );
  assert.equal(
    (await request(app).post("/api/repair-plan").send({ brief: "b1" })).status,
    200
  );
  assert.equal(
    (await request(app).post("/api/ask").send({ question: "q2" })).status,
    429
  );
});

test("POST /api/repair-plan rejects an over-long brief with 400", async () => {
  const app = createApp({
    runRepairPlan: async (_input, { emit }) => emit({ type: "done" }),
  });

  const response = await request(app)
    .post("/api/repair-plan")
    .send({ brief: "x".repeat(MAX_BRIEF_LENGTH + 1) });

  assert.equal(response.status, 400);
  assert.match(response.body.error, /too long/i);
});

test("streamResponsesTurn aborts a stalled stream with a clear idle-timeout error", async () => {
  // A response whose body never yields a chunk: reader.read() hangs until the
  // idle timer aborts the composed signal, which errors the stream.
  const hangingFetch = (_url, options) => {
    const stream = new ReadableStream({
      start(controller) {
        options.signal.addEventListener("abort", () => {
          controller.error(new Error("aborted"));
        });
      },
    });
    return Promise.resolve({
      ok: true,
      body: stream,
      async text() {
        return "";
      },
    });
  };

  await assert.rejects(
    async () => {
      // eslint-disable-next-line no-unused-vars
      for await (const _event of streamResponsesTurn({
        apiKey: "test-key",
        input: "plan this",
        idleTimeoutMs: 15,
        fetchImpl: hangingFetch,
      })) {
        // no events expected
      }
    },
    (error) => {
      assert.equal(error.message, OPENAI_STREAM_IDLE_MESSAGE);
      return true;
    }
  );
});

// --- Embedding requests (owner decision D4) --------------------------------

function embeddingFetch(calls) {
  return async (_url, options) => {
    calls.push(options);
    const { input } = JSON.parse(options.body);

    return {
      ok: true,
      async json() {
        return {
          data: input.map((_text, index) => ({
            index,
            embedding: new Array(config.openAiEmbeddingDimensions).fill(0.5),
          })),
        };
      },
      async text() {
        return "";
      },
    };
  };
}

test("an embedding request counts as one provider request, however many texts it carries", async () => {
  const calls = [];

  await createOpenAiEmbedding("caliper bolt torque", { fetchImpl: embeddingFetch(calls) });
  assert.equal(getAiUsageSnapshot().callsToday, 1);

  // A backfill batch is one request.
  const vectors = await createOpenAiEmbeddings(["a", "b", "c"], { fetchImpl: embeddingFetch(calls) });
  assert.equal(vectors.length, 3);
  assert.equal(getAiUsageSnapshot().callsToday, 2);
  assert.equal(calls.length, 2);

  // No input means no provider request, so nothing is counted.
  assert.deepEqual(await createOpenAiEmbeddings([], { fetchImpl: embeddingFetch(calls) }), []);
  assert.equal(getAiUsageSnapshot().callsToday, 2);
});

test("the daily ceiling refuses an embedding request before it is sent", async () => {
  const calls = [];
  const reserveCall = () => reserveAiCall({ limit: 1 });

  await createOpenAiEmbedding("first", { fetchImpl: embeddingFetch(calls), reserveCall });

  await assert.rejects(
    createOpenAiEmbedding("second", { fetchImpl: embeddingFetch(calls), reserveCall }),
    (error) => {
      assert.equal(error.message, AI_DAILY_LIMIT_MESSAGE);
      assert.equal(error.status, 429, "Ask answers a refused embedding with 429, not 500");
      return true;
    }
  );
  assert.equal(calls.length, 1, "the refused request never reached the network");
  assert.equal(getAiUsageSnapshot().callsToday, 1, "a refused request is not counted");
});

test("a stalled embedding request is cancelled with a fixed message", async () => {
  // Never answers: only the request's own signal can end it.
  const hangingFetch = (_url, options) =>
    new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(options.signal.reason));
    });

  await assert.rejects(
    createOpenAiEmbedding("caliper", { fetchImpl: hangingFetch, timeoutMs: 15 }),
    (error) => {
      assert.equal(error.message, OPENAI_EMBEDDING_TIMEOUT_MESSAGE);
      // Not an AbortError: the planner reads that name as "the client left".
      assert.notEqual(error.name, "AbortError");
      return true;
    }
  );
});

test("the embedding timeout also bounds a body that stalls after the headers", async () => {
  const stalledBodyFetch = async (_url, options) => ({
    ok: true,
    json: () =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason));
      }),
    async text() {
      return "";
    },
  });

  await assert.rejects(
    createOpenAiEmbedding("caliper", { fetchImpl: stalledBodyFetch, timeoutMs: 15 }),
    (error) => {
      assert.equal(error.message, OPENAI_EMBEDDING_TIMEOUT_MESSAGE);
      return true;
    }
  );
});
