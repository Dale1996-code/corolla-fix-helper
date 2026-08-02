import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import express from "express";
import request from "supertest";

// Route-level safety guarantees for POST /api/ask, exercised through the REAL
// service behind the real route:
//   1. A provider HTTP error body can never reach the browser.
//   2. retrievedContext is bounded, de-duplicated, and metadata-safe.
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-fix-helper-ask-safety-"));

process.env.DATABASE_FILE = path.join(tempRoot, "ask-safety.db");
process.env.UPLOADS_DIR = path.join(tempRoot, "uploads");
// Pin the AI feature flags too. config.js calls dotenv.config() at import,
// so without this a developer's local server/.env leaks into the suite --
// setting ASK_EVIDENCE_CONTRACT=true there made these tests take the
// evidence path and attempt REAL API calls. Cases that want the contract
// enable it explicitly via the evidenceContract option.
process.env.ASK_EVIDENCE_CONTRACT = "false";

process.env.OPENAI_API_KEY = "";

const { db } = await import("../src/database.js");
const { initializeDatabase } = await import("../src/initDatabase.js");
const { createAskRouter } = await import("../src/routes/ask.js");
const { askQuestionUsingDocuments, generateAnswerTextFromOpenAi, rewriteQuestionFromOpenAi } =
  await import("../src/services/aiAnswerService.js");

initializeDatabase();

const realFetch = globalThis.fetch;

after(() => {
  globalThis.fetch = realFetch;

  if (typeof db.close === "function") {
    db.close();
  }

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function makeApp(options) {
  const app = express();
  app.use(express.json());
  app.use("/api/ask", createAskRouter(options));
  return app;
}

const baseChunk = {
  documentId: 7,
  documentTitle: "Engine Manual",
  originalFilename: "engine-manual.pdf",
  pageNumber: 3,
  chunkIndex: 0,
  chunkText: "Oil drain plug torque is 27 ft-lb.",
  retrievalMode: "hybrid",
  semanticScore: 0.9,
  totalQueryTerms: 4,
  chunkMatchedTerms: 4,
};

const chunk = (overrides = {}) => ({ ...baseChunk, ...overrides });

/** Wire the real service behind the route with injected retrieval/model. */
function realServiceApp(serviceOptions, routerOptions = {}) {
  return makeApp({
    askQuestion: (question, options) =>
      askQuestionUsingDocuments(question, {
        ...options,
        isAiConfigured: true,
        ...serviceOptions,
      }),
    ...routerOptions,
  });
}

// ---- Provider HTTP bodies must never reach the client ----
//
// ask.js serializes error.message straight to the browser, and the OpenAI prompt
// contains the user's question and retrieved document passages. Echoing a raw
// provider body back would leak exactly that.

const LEAK_MARKER = "echoed-private-prompt";

function providerErrorFetch(status) {
  return async () => ({
    ok: false,
    status,
    text: async () => `{"error":{"message":"${LEAK_MARKER} plus document passage text"}}`,
    json: async () => ({}),
  });
}

function assertNoLeak(response) {
  const serialized = JSON.stringify(response.body);

  assert.ok(!serialized.includes(LEAK_MARKER), `provider body leaked: ${serialized}`);
  assert.ok(!serialized.includes("document passage"), `provider body leaked: ${serialized}`);
}

test("a non-2xx answer-generation body does not reach the client", async () => {
  const app = realServiceApp({
    retrieveChunks: async () => [chunk()],
    generateAnswerText: (params) =>
      generateAnswerTextFromOpenAi({ ...params, fetchImpl: providerErrorFetch(400) }),
  });

  const response = await request(app)
    .post("/api/ask")
    .send({ question: "What is the oil drain plug torque?" });

  assert.equal(response.status, 500);
  assertNoLeak(response);
  assert.ok(response.body.error, "expected a generic error string");
  // An infrastructure failure must stay distinguishable from an honest refusal.
  assert.notEqual(response.body.status, "not_found");
});

test("a non-2xx vision answer body does not reach the client", async () => {
  // Vision shares the answer request path; only the model and input shape differ.
  const app = realServiceApp(
    {
      image: "data:image/png;base64,QUJD",
      retrieveChunks: async () => [chunk()],
      generateAnswerText: (params) =>
        generateAnswerTextFromOpenAi({ ...params, fetchImpl: providerErrorFetch(422) }),
    },
    { loadAttachmentImage: async () => "data:image/png;base64,QUJD" }
  );

  const response = await request(app)
    .post("/api/ask")
    .send({ question: "What is this part?", attachmentId: 12 });

  assert.equal(response.status, 500);
  assertNoLeak(response);
});

test("a non-2xx question-rewrite body does not reach the client, and falls back", async () => {
  globalThis.fetch = /** @type {any} */ (providerErrorFetch(429));

  try {
    const seen = {};
    const app = realServiceApp({
      retrieveChunks: async (query) => {
        seen.query = query;
        return [chunk()];
      },
      rewriteQuestion: rewriteQuestionFromOpenAi,
      generateAnswerText: async () => "The oil drain plug torque is 27 ft-lb.",
    });

    const response = await request(app)
      .post("/api/ask")
      .send({
        question: "what about the rear?",
        history: [{ role: "user", content: "front brake caliper torque" }],
      });

    // Rewrite failure is SOFT: the request still succeeds using the user's own
    // wording rather than failing the whole Ask.
    assert.equal(response.status, 200);
    assert.equal(response.body.status, "unverified");
    assert.equal(seen.query, "what about the rear?");
    assertNoLeak(response);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ---- retrievedContext hardening ----

test("retrievedContext de-duplicates by chunk id and preserves retrieval order", async () => {
  const app = realServiceApp({
    retrieveChunks: async () => [
      chunk({ id: 1, chunkText: "first" }),
      chunk({ id: 2, chunkText: "second" }),
      chunk({ id: 1, chunkText: "first duplicate" }),
    ],
    generateAnswerText: async () => "not in documents",
  });

  const response = await request(app).post("/api/ask").send({ question: "anything" });

  assert.equal(response.body.retrievedContext.length, 2);
  assert.equal(response.body.retrievedContext[0].snippet, "first");
  assert.equal(response.body.retrievedContext[1].snippet, "second");
});

test("retrievedContext falls back to document+page+index identity when ids are absent", async () => {
  const app = realServiceApp({
    retrieveChunks: async () => [
      chunk({ pageNumber: 3, chunkIndex: 0, chunkText: "same page chunk" }),
      chunk({ pageNumber: 3, chunkIndex: 0, chunkText: "same page chunk repeated" }),
      chunk({ pageNumber: 4, chunkIndex: 0, chunkText: "different page" }),
    ],
    generateAnswerText: async () => "not in documents",
  });

  const response = await request(app).post("/api/ask").send({ question: "anything" });

  assert.equal(response.body.retrievedContext.length, 2);
  assert.equal(response.body.retrievedContext[0].pageNumber, 3);
  assert.equal(response.body.retrievedContext[1].pageNumber, 4);
});

test("retrievedContext is capped at the configured chunk limit", async () => {
  const oversized = Array.from({ length: 25 }, (_, index) =>
    chunk({ id: index + 1, chunkIndex: index, chunkText: `chunk ${index}` })
  );

  const app = realServiceApp({
    chunkLimit: 8,
    retrieveChunks: async () => oversized,
    generateAnswerText: async () => "not in documents",
  });

  const response = await request(app).post("/api/ask").send({ question: "anything" });

  assert.equal(response.body.retrievedContext.length, 8);
  assert.equal(response.body.retrievedContext[0].snippet, "chunk 0");
});

test("malformed chunk metadata does not crash or emit unusable context", async () => {
  const app = realServiceApp({
    retrieveChunks: async () => [
      null,
      undefined,
      {},
      "not an object",
      chunk({ id: 9, documentTitle: undefined, chunkText: "usable text" }),
    ],
    generateAnswerText: async () => "not in documents",
  });

  const response = await request(app).post("/api/ask").send({ question: "anything" });

  assert.equal(response.status, 200);
  // Only rows that can actually point the owner somewhere survive.
  assert.equal(response.body.retrievedContext.length, 1);
  assert.equal(response.body.retrievedContext[0].snippet, "usable text");
});

test("retrieved chunks with no source and no text produce not_found with no citations", async () => {
  // The reachable contract behind the empty-citations guard: retrieval returned
  // rows, but none of them are citable, so answering would be ungrounded.
  const app = realServiceApp({
    retrieveChunks: async () => [
      {
        retrievalMode: "hybrid",
        semanticScore: 0.9,
        totalQueryTerms: 4,
        chunkMatchedTerms: 4,
        chunkText: "   ",
      },
    ],
    generateAnswerText: async () => {
      throw new Error("the model must not be called when nothing is citable");
    },
  });

  const response = await request(app).post("/api/ask").send({ question: "anything" });

  assert.equal(response.status, 200);
  assert.equal(response.body.status, "not_found");
  assert.deepEqual(response.body.citations, []);
});

test("the legacy Ask path cannot label retrieved passages as answer citations", async () => {
  const app = realServiceApp({
    evidenceContract: false,
    retrieveChunks: async () => [chunk({ id: 1 })],
    generateAnswerText: async () => "The oil filter cap torque is 27 ft-lb.",
  });

  const response = await request(app)
    .post("/api/ask")
    .send({ question: "What is the oil filter cap torque?" });

  assert.equal(response.status, 200);
  assert.equal(response.body.status, "unverified");
  assert.deepEqual(response.body.citations, []);
  assert.equal(response.body.retrievedContext.length, 1);
  assert.equal(response.body.retrievedContext[0].documentTitle, "Engine Manual");
  assert.ok(!("evidence" in response.body));
});

test("a partial response without a verified evidence envelope is also unverified", async () => {
  const app = makeApp({
    askQuestion: async () => ({
      status: "partial",
      answer: "One claim was allegedly supported.",
      standaloneQuestion: "question",
      citations: [
        {
          documentId: 7,
          documentTitle: "Engine Manual",
          originalFilename: "engine-manual.pdf",
          pageNumber: 3,
          chunkIndex: 0,
          snippet: "A retrieved passage.",
        },
      ],
    }),
  });

  const response = await request(app).post("/api/ask").send({ question: "question" });

  assert.equal(response.status, 200);
  assert.equal(response.body.status, "unverified");
  assert.deepEqual(response.body.citations, []);
  assert.equal(response.body.retrievedContext.length, 1);
});

// ---- Evidence-contract HTTP boundary ----

test("POST /api/ask returns only verified claims and citations for passages actually used", async () => {
  const unusedChunk = chunk({
    id: 2,
    documentId: 12,
    documentTitle: "Transmission Manual",
    originalFilename: "transmission.pdf",
    pageNumber: 88,
    chunkIndex: 4,
    chunkText: "Tighten the transaxle case bolts to 37 Nm.",
  });
  const app = realServiceApp({
    evidenceContract: true,
    retrieveChunks: async () => [chunk({ id: 1 }), unusedChunk],
    generateEvidenceAnswer: async () => ({
      documentSupported: [
        {
          claim: "The oil drain plug torque is 27 ft-lb.",
          sourceId: "S1",
          evidenceQuote: "Oil drain plug torque is 27 ft-lb.",
        },
        {
          claim: "The filter cap torque is 54 Nm.",
          sourceId: "S999",
          evidenceQuote: "Tighten the transaxle case bolts to 37 Nm.",
        },
      ],
      generalGuidance: ["Let the engine cool before working near hot oil."],
      gaps: [],
    }),
  });

  const response = await request(app)
    .post("/api/ask")
    .send({ question: "What is the oil drain plug torque?" });

  assert.equal(response.status, 200);
  assert.equal(response.body.status, "partial");
  assert.equal(response.body.evidence.documentSupported.length, 1);
  assert.deepEqual(response.body.evidence.generalGuidance, [
    "Let the engine cool before working near hot oil.",
  ]);
  assert.equal(response.body.citations.length, 1);
  assert.equal(response.body.citations[0].documentTitle, "Engine Manual");
  assert.match(response.body.citations[0].evidenceId, /^ask_ev_v1_[a-f0-9]{24}$/);
  assert.equal(
    response.body.citations[0].evidenceId,
    response.body.evidence.documentSupported[0].evidenceId
  );
  assert.ok(!JSON.stringify(response.body.citations).includes("Transmission Manual"));
  assert.ok(!JSON.stringify(response.body).includes("54 Nm"));
  assert.ok(!("retrievedContext" in response.body));
});

test("POST /api/ask returns not_found with no citations when structured evidence is empty", async () => {
  const app = realServiceApp({
    evidenceContract: true,
    retrieveChunks: async () => [chunk({ id: 1 })],
    generateEvidenceAnswer: async () => ({
      documentSupported: [],
      generalGuidance: [],
      gaps: [],
    }),
  });

  const response = await request(app)
    .post("/api/ask")
    .send({ question: "What is the oil drain plug torque?" });

  assert.equal(response.status, 200);
  assert.equal(response.body.status, "not_found");
  assert.equal(response.body.answer, "not in documents");
  assert.deepEqual(response.body.citations, []);
  assert.deepEqual(response.body.evidence, {
    documentSupported: [],
    generalGuidance: [],
    gaps: [],
  });
  assert.equal(response.body.retrievedContext.length, 1);
});
