import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

// A provider error body must never reach the browser or the logs (1A-16). The
// streaming client used to put the whole body into the thrown message, and the
// planner emits that message as its `error` frame. A 401 body names the
// owner's key by its last characters, and other bodies can echo the brief.
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-fix-helper-provider-errors-"));

process.env.DATABASE_FILE = path.join(tempRoot, "provider-errors.db");
process.env.UPLOADS_DIR = path.join(tempRoot, "uploads");
process.env.OPENAI_API_KEY = "";
process.env.NETWORK_MODE = "0";

fs.mkdirSync(process.env.UPLOADS_DIR, { recursive: true });

const { db } = await import("../src/database.js");
const { runRepairPlannerAgent } = await import("../src/services/agent/repairPlannerAgent.js");
const { streamResponsesTurn, OPENAI_STREAM_FAILED_MESSAGE } = await import(
  "../src/services/agent/openAiResponsesClient.js"
);

after(() => {
  if (typeof db.close === "function") {
    db.close();
  }

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

// The shape of OpenAI's real 401 body, with a made-up key suffix. The brief
// text stands in for anything the provider echoes from the request.
const KEY_SUFFIX = "Qz7w";
const BRIEF_ECHO = "squeak-brief-echo";
const UNAUTHORIZED_BODY = JSON.stringify({
  error: {
    message: `Incorrect API key provided: sk-proj-************************${KEY_SUFFIX}. ${BRIEF_ECHO}`,
    type: "invalid_request_error",
    code: "invalid_api_key",
  },
});
const SECRETS = [KEY_SUFFIX, "sk-proj", BRIEF_ECHO];

function httpErrorFetch(status, body) {
  return async () => ({
    ok: false,
    status,
    body: {},
    async text() {
      return body;
    },
  });
}

function sseFetch(frames) {
  return async () => ({
    ok: true,
    status: 200,
    body: new ReadableStream({
      start(controller) {
        const text = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("");
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    }),
  });
}

async function drain(options) {
  // eslint-disable-next-line no-unused-vars
  for await (const _event of streamResponsesTurn({ apiKey: "test-key", reserveCall: () => {}, ...options })) {
    // draining only
  }
}

function assertNoSecret(text, where) {
  for (const secret of SECRETS) {
    assert.ok(!String(text).includes(secret), `${where} contains "${secret}": ${text}`);
  }
}

test("an HTTP error body never becomes the thrown message", async () => {
  await assert.rejects(drain({ fetchImpl: httpErrorFetch(401, UNAUTHORIZED_BODY) }), (error) => {
    assertNoSecret(error.message, "the message");
    assert.equal(error.failure.kind, "http_error");
    assert.equal(error.failure.httpStatus, 401);
    // The retained diagnostic is internal, and even it holds no part of the key.
    assert.ok(!error.failure.diagnostic.includes(KEY_SUFFIX), error.failure.diagnostic);
    assert.ok(!error.failure.diagnostic.includes("sk-proj"), error.failure.diagnostic);
    return true;
  });
});

test("a provider failure inside the stream gets a fixed message", async () => {
  for (const frame of [
    {
      type: "response.failed",
      response: { error: { message: `quota for org-${KEY_SUFFIX} ${BRIEF_ECHO}` } },
    },
    { type: "error", message: `server_error ${BRIEF_ECHO} sk-proj-***${KEY_SUFFIX}` },
  ]) {
    await assert.rejects(drain({ fetchImpl: sseFetch([frame]) }), (error) => {
      assert.equal(error.message, OPENAI_STREAM_FAILED_MESSAGE);
      return true;
    });
  }
});

test("a provider error reaches neither an SSE frame nor the console", async () => {
  const failures = [
    httpErrorFetch(401, UNAUTHORIZED_BODY),
    httpErrorFetch(400, `{"error":{"message":"bad input: ${BRIEF_ECHO}"}}`),
    sseFetch([{ type: "response.failed", response: { error: { message: BRIEF_ECHO } } }]),
  ];

  for (const fetchImpl of failures) {
    const events = [];
    const logged = [];
    const originals = {};

    for (const method of ["log", "info", "warn", "error", "debug"]) {
      originals[method] = console[method];
      console[method] = (...args) =>
        logged.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
    }

    let result;

    try {
      result = await runRepairPlannerAgent(
        { brief: "Front brakes squeak. Replace pads." },
        {
          emit: (event) => events.push(event),
          streamTurn: (options) =>
            streamResponsesTurn({ ...options, apiKey: "test-key", reserveCall: () => {}, fetchImpl }),
          retrieve: async () => [],
          isAiConfigured: true,
        }
      );
    } finally {
      Object.assign(console, originals);
    }

    assert.equal(result.status, "error");
    assert.ok(events.some((event) => event.type === "error"), "the failure still surfaces");
    assertNoSecret(JSON.stringify(events), "an SSE frame");
    assertNoSecret(logged.join("\n"), "the console");
  }
});
