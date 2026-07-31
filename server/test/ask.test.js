import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import express from "express";
import request from "supertest";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-fix-helper-ask-route-"));

process.env.DATABASE_FILE = path.join(tempRoot, "ask.db");
process.env.UPLOADS_DIR = path.join(tempRoot, "uploads");
process.env.OPENAI_API_KEY = "";

const { db } = await import("../src/database.js");
const { initializeDatabase } = await import("../src/initDatabase.js");
const { createAskRouter, loadAttachmentImageFromStorage } = await import(
  "../src/routes/ask.js"
);

initializeDatabase();

after(() => {
  if (typeof db.close === "function") {
    db.close();
  }

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

/** Read the HTTP status off a thrown attachment error (typed as unknown). */
function statusOf(error) {
  return /** @type {any} */ (error).status;
}

function answeredResult(question) {
  return {
    status: "answered",
    answer: "ok",
    standaloneQuestion: question,
    citations: [],
  };
}

function makeApp(options) {
  const app = express();
  app.use(express.json());
  app.use("/api/ask", createAskRouter(options));
  return app;
}

test("POST /api/ask with attachmentId loads the saved image and passes it to the answerer", async () => {
  const seen = {};
  const app = makeApp({
    askQuestion: async (question, opts) => {
      seen.question = question;
      seen.image = opts.image;
      return answeredResult(question);
    },
    loadAttachmentImage: async (attachmentId) => {
      seen.attachmentId = attachmentId;
      return "data:image/png;base64,QUJD";
    },
  });

  const response = await request(app)
    .post("/api/ask")
    .send({ question: "What is this part?", attachmentId: 12 });

  assert.equal(response.status, 200);
  assert.equal(seen.attachmentId, 12);
  assert.equal(seen.image, "data:image/png;base64,QUJD");
});

test("POST /api/ask without attachmentId keeps old behavior and sends image=null", async () => {
  let loadCalls = 0;
  const seen = {};
  const app = makeApp({
    askQuestion: async (question, opts) => {
      seen.image = opts.image;
      seen.history = opts.history;
      return answeredResult(question);
    },
    loadAttachmentImage: async () => {
      loadCalls += 1;
      return "data:image/png;base64,QUJD";
    },
  });

  const response = await request(app)
    .post("/api/ask")
    .send({ question: "What is the oil drain plug torque?" });

  assert.equal(response.status, 200);
  assert.equal(loadCalls, 0);
  assert.equal(seen.image, null);
  assert.deepEqual(seen.history, []);
});

test("POST /api/ask includes metrics when the router has includeMetrics on", async () => {
  const app = makeApp({
    includeMetrics: true,
    askQuestion: async (question) => ({
      ...answeredResult(question),
      metrics: { retrievalMs: 5, answerMs: 10, totalMs: 20, chunkCount: 2 },
    }),
  });

  const response = await request(app)
    .post("/api/ask")
    .send({ question: "What is the oil drain plug torque?" });

  assert.equal(response.status, 200);
  assert.ok(response.body.metrics, "expected metrics in the response");
  assert.equal(response.body.metrics.chunkCount, 2);
});

test("POST /api/ask omits metrics by default even if the service returns them", async () => {
  const app = makeApp({
    askQuestion: async (question) => ({
      ...answeredResult(question),
      metrics: { retrievalMs: 5, answerMs: 10, totalMs: 20, chunkCount: 2 },
    }),
  });

  const response = await request(app)
    .post("/api/ask")
    .send({ question: "What is the oil drain plug torque?" });

  assert.equal(response.status, 200);
  assert.ok(!("metrics" in response.body), "metrics must be absent unless the dev flag is on");
});

test("POST /api/ask with an invalid attachmentId returns 400 and never calls the answerer", async () => {
  let askCalls = 0;
  const app = makeApp({
    askQuestion: async () => {
      askCalls += 1;
      return answeredResult("x");
    },
    // Uses the default disk-backed loader, which validates the id first.
  });

  const response = await request(app)
    .post("/api/ask")
    .send({ question: "What is this?", attachmentId: "not-a-number" });

  assert.equal(response.status, 400);
  assert.equal(askCalls, 0);
  assert.match(response.body.error, /positive number/i);
});

test("POST /api/ask with a missing attachment returns 404 and never calls the answerer", async () => {
  let askCalls = 0;
  const app = makeApp({
    askQuestion: async () => {
      askCalls += 1;
      return answeredResult("x");
    },
  });

  const response = await request(app)
    .post("/api/ask")
    .send({ question: "What is this?", attachmentId: 999999 });

  assert.equal(response.status, 404);
  assert.equal(askCalls, 0);
  assert.match(response.body.error, /not found/i);
});

test("POST /api/ask rejects a non-image attachment without calling the answerer", async () => {
  let askCalls = 0;
  const app = makeApp({
    askQuestion: async () => {
      askCalls += 1;
      return answeredResult("x");
    },
    loadAttachmentImage: async () => {
      const error = new Error("Attachment must be a JPEG, PNG, or WebP image.");
      /** @type {any} */ (error).status = 415;
      throw error;
    },
  });

  const response = await request(app)
    .post("/api/ask")
    .send({ question: "What is this?", attachmentId: 5 });

  assert.equal(response.status, 415);
  assert.equal(askCalls, 0);
  assert.match(response.body.error, /image/i);
});

test("POST /api/ask still requires a question even when an attachmentId is provided", async () => {
  let loadCalls = 0;
  let askCalls = 0;
  const app = makeApp({
    askQuestion: async () => {
      askCalls += 1;
      return answeredResult("x");
    },
    loadAttachmentImage: async () => {
      loadCalls += 1;
      return "data:image/png;base64,QUJD";
    },
  });

  const response = await request(app)
    .post("/api/ask")
    .send({ question: "   ", attachmentId: 5 });

  assert.equal(response.status, 400);
  assert.equal(loadCalls, 0);
  assert.equal(askCalls, 0);
});

test("loadAttachmentImageFromStorage rejects a non-positive id with a 400", async () => {
  await assert.rejects(
    () =>
      loadAttachmentImageFromStorage("abc", {
        getAttachment: () => {
          throw new Error("should not query the database for an invalid id");
        },
      }),
    (error) => {
      assert.equal(statusOf(error), 400);
      return true;
    }
  );
});

test("loadAttachmentImageFromStorage returns 404 when the record is missing", async () => {
  await assert.rejects(
    () =>
      loadAttachmentImageFromStorage(7, {
        getAttachment: () => null,
        readImageFile: async () => Buffer.from("never reached"),
      }),
    (error) => {
      assert.equal(statusOf(error), 404);
      return true;
    }
  );
});

test("loadAttachmentImageFromStorage returns 415 for a non-image record", async () => {
  await assert.rejects(
    () =>
      loadAttachmentImageFromStorage(7, {
        getAttachment: () => ({ mimeType: "application/pdf", storedFilename: "x.pdf" }),
        readImageFile: async () => Buffer.from("never reached"),
      }),
    (error) => {
      assert.equal(statusOf(error), 415);
      return true;
    }
  );
});

test("loadAttachmentImageFromStorage returns 404 when the file is missing on disk", async () => {
  await assert.rejects(
    () =>
      loadAttachmentImageFromStorage(7, {
        getAttachment: () => ({ mimeType: "image/png", storedFilename: "gone.png" }),
        readImageFile: async () => {
          throw new Error("ENOENT");
        },
      }),
    (error) => {
      assert.equal(statusOf(error), 404);
      return true;
    }
  );
});

test("loadAttachmentImageFromStorage returns a base64 data URI for a stored image", async () => {
  const bytes = Buffer.from("hello-image-bytes");
  const uri = await loadAttachmentImageFromStorage(7, {
    getAttachment: () => ({ mimeType: "image/jpeg", storedFilename: "photo.jpg" }),
    readImageFile: async () => bytes,
  });

  assert.equal(uri, `data:image/jpeg;base64,${bytes.toString("base64")}`);
});

// ---- retrievedContext: service -> route integration ----
//
// These use the REAL askQuestionUsingDocuments behind the route (only retrieval
// and the model are faked), so they prove the field survives the route's
// explicit response allowlist. A hand-built payload could not prove that -- and
// did not: the field was originally dropped here.

const { askQuestionUsingDocuments } = await import("../src/services/aiAnswerService.js");

const routeChunk = {
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

function realServiceApp({ chunks, answerText }) {
  return makeApp({
    askQuestion: (question, options) =>
      askQuestionUsingDocuments(question, {
        ...options,
        isAiConfigured: true,
        retrieveChunks: async () => chunks,
        generateAnswerText: async () => answerText,
      }),
  });
}

test("POST /api/ask emits retrievedContext on a real not-found response", async () => {
  const app = realServiceApp({ chunks: [routeChunk], answerText: "not in documents" });

  const response = await request(app)
    .post("/api/ask")
    .send({ question: "What is the water pump torque?" });

  assert.equal(response.status, 200);
  assert.equal(response.body.status, "not_found");
  // Unchanged contract.
  assert.deepEqual(response.body.citations, []);
  // Added contract, proven through the real route.
  assert.equal(response.body.retrievedContext.length, 1);
  assert.equal(response.body.retrievedContext[0].documentTitle, "Engine Manual");
  assert.equal(response.body.retrievedContext[0].pageNumber, 3);
  assert.match(response.body.retrievedContext[0].snippet, /Oil drain plug torque/);
});

test("POST /api/ask omits retrievedContext on an answered response", async () => {
  const app = realServiceApp({
    chunks: [routeChunk],
    answerText: "The oil drain plug torque is 27 ft-lb.",
  });

  const response = await request(app)
    .post("/api/ask")
    .send({ question: "What is the oil drain plug torque?" });

  assert.equal(response.status, 200);
  assert.equal(response.body.status, "answered");
  assert.equal(response.body.citations.length, 1);
  assert.ok(
    !("retrievedContext" in response.body),
    "an answered reply already cites its sources"
  );
});

test("POST /api/ask omits retrievedContext when nothing was retrieved", async () => {
  const app = realServiceApp({ chunks: [], answerText: "not in documents" });

  const response = await request(app)
    .post("/api/ask")
    .send({ question: "something the documents never mention" });

  assert.equal(response.status, 200);
  assert.equal(response.body.status, "not_found");
  assert.deepEqual(response.body.citations, []);
  assert.ok(!("retrievedContext" in response.body));
});

test("the route response shape stays an explicit allowlist", async () => {
  // Guards against a future "just spread the service result" refactor: the
  // service's internal fields must not leak into the HTTP contract.
  const app = realServiceApp({ chunks: [routeChunk], answerText: "not in documents" });

  const response = await request(app)
    .post("/api/ask")
    .send({ question: "What is the water pump torque?" });

  assert.deepEqual(
    Object.keys(response.body).sort(),
    ["answer", "citations", "question", "retrievedContext", "standaloneQuestion", "status"]
  );
});
