import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, afterEach } from "node:test";

// Isolate the database/uploads to a scratch dir BEFORE importing the service.
// aiAnswerService -> chunkRetrievalService -> database.js opens
// config.databaseFile at import time; without this override it would open the
// shared on-disk dev DB and race other parallel test processes on the WAL
// pragma ("database is locked").
const tempRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "corolla-fix-helper-ai-answer-")
);
process.env.DATABASE_FILE = path.join(tempRoot, "ai-answer.db");
process.env.UPLOADS_DIR = path.join(tempRoot, "uploads");

// Distinct answer/vision models let the model-selection assertions tell the two
// requests apart (when OPENAI_VISION_MODEL is unset they would be identical).
process.env.OPENAI_API_KEY = "test-key";
process.env.OPENAI_ANSWER_MODEL = "answer-model-test";
process.env.OPENAI_VISION_MODEL = "vision-model-test";

const { db } = await import("../src/database.js");
const { askQuestionUsingDocuments, generateAnswerTextFromOpenAi, NOT_FOUND_MESSAGE } =
  await import("../src/services/aiAnswerService.js");

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

after(() => {
  if (typeof db.close === "function") {
    db.close();
  }

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function stubFetch(outputText = "The oil drain plug torque is 27 ft-lb.") {
  const calls = [];
  // Cast through any: this stub only needs the ok/json shape the service reads.
  globalThis.fetch = /** @type {any} */ (
    async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return {
        ok: true,
        json: async () => ({ output_text: outputText }),
      };
    }
  );
  return calls;
}

const sampleChunk = {
  documentId: 7,
  documentTitle: "Engine Manual",
  originalFilename: "engine-manual.pdf",
  pageNumber: 3,
  chunkIndex: 0,
  chunkText: "Oil drain plug torque is 27 ft-lb.",
};

function strongChunk(overrides = {}) {
  return {
    ...sampleChunk,
    retrievalMode: "hybrid",
    semanticScore: 0.9,
    totalQueryTerms: 4,
    chunkMatchedTerms: 4,
    ...overrides,
  };
}

const dataUri = "data:image/png;base64,QUJD";

test("no-image answer sends plain-string Responses input and uses the answer model", async () => {
  const calls = stubFetch();

  await generateAnswerTextFromOpenAi({
    question: "What is the oil drain plug torque?",
    chunks: [sampleChunk],
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.model, "answer-model-test");
  assert.equal(typeof calls[0].body.input, "string");
  assert.ok(calls[0].body.input.includes("Oil drain plug torque is 27 ft-lb."));
});

test("answer prompt asks for beginner-safe document-grounded structure", async () => {
  const calls = stubFetch();

  await generateAnswerTextFromOpenAi({
    question: "What should I check for a P0301 cylinder 1 misfire?",
    chunks: [sampleChunk],
  });

  const prompt = calls[0].body.input;

  assert.ok(prompt.includes("Write for a beginner DIY mechanic"));
  assert.ok(
    prompt.includes(
      "Clearly separate document-supported facts from general safety reminders"
    )
  );
  assert.ok(
    prompt.includes(
      "If a safety reminder is not stated in the chunks, label it as general safety guidance"
    )
  );
});

test("image answer sends structured Responses input and uses the vision model", async () => {
  const calls = stubFetch();

  await generateAnswerTextFromOpenAi({
    question: "What is the oil drain plug torque?",
    chunks: [sampleChunk],
    image: dataUri,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.model, "vision-model-test");
  assert.ok(Array.isArray(calls[0].body.input));

  const message = calls[0].body.input[0];
  assert.equal(message.role, "user");

  const textPart = message.content.find((part) => part.type === "input_text");
  const imagePart = message.content.find((part) => part.type === "input_image");
  assert.ok(textPart && typeof textPart.text === "string");
  assert.equal(imagePart.image_url, dataUri);
});

test("askQuestionUsingDocuments forwards the image data URI to answer generation", async () => {
  let seenImage = "unset";

  await askQuestionUsingDocuments("What is the oil drain plug torque?", {
    isAiConfigured: true,
    image: dataUri,
    retrieveChunks: async () => [strongChunk()],
    generateAnswerText: async ({ image }) => {
      seenImage = image;
      return "The oil drain plug torque is 27 ft-lb.";
    },
  });

  assert.equal(seenImage, dataUri);
});

test("an unsupported answer still returns the not-found message", async () => {
  let modelCalls = 0;

  const result = await askQuestionUsingDocuments("water pump torque", {
    isAiConfigured: true,
    retrieveChunks: async () => [strongChunk()],
    generateAnswerText: async () => {
      modelCalls += 1;
      return NOT_FOUND_MESSAGE;
    },
  });

  assert.equal(modelCalls, 1);
  assert.equal(result.status, "not_found");
  assert.equal(result.answer, NOT_FOUND_MESSAGE);
  assert.deepEqual(result.citations, []);
});

test("an attached image does not bypass the not-found gate when no chunks match", async () => {
  let modelCalls = 0;

  const result = await askQuestionUsingDocuments("anything the documents never mention", {
    isAiConfigured: true,
    image: dataUri,
    retrieveChunks: async () => [],
    generateAnswerText: async () => {
      modelCalls += 1;
      return "An invented answer derived from the photo.";
    },
  });

  assert.equal(modelCalls, 0);
  assert.equal(result.status, "not_found");
  assert.equal(result.answer, NOT_FOUND_MESSAGE);
});

test("an attached image cannot turn an unsupported answer into a claim", async () => {
  const result = await askQuestionUsingDocuments("water pump torque", {
    isAiConfigured: true,
    image: dataUri,
    retrieveChunks: async () => [strongChunk()],
    generateAnswerText: async () => NOT_FOUND_MESSAGE,
  });

  assert.equal(result.status, "not_found");
  assert.equal(result.answer, NOT_FOUND_MESSAGE);
  assert.deepEqual(result.citations, []);
});
