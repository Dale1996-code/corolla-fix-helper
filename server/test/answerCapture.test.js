import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

// eval:capture's recording path (audit Stage 1b, 4B-11), run through the REAL
// Ask pipeline and the REAL OpenAI evidence generator. Only the provider fetch,
// retrieval, and the follow-up rewrite are injected, so nothing here needs a key
// or reaches the network -- and what gets recorded is exactly what the pipeline
// judged. All passage text is invented.

// aiAnswerService -> chunkRetrievalService -> database.js opens
// config.databaseFile at import time, so isolate it before importing.
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-answer-capture-"));
process.env.DATABASE_FILE = path.join(tempRoot, "capture.db");
process.env.UPLOADS_DIR = path.join(tempRoot, "uploads");

const { db } = await import("../src/database.js");
const { askQuestionUsingDocuments, generateEvidenceAnswerFromOpenAi } = await import(
  "../src/services/aiAnswerService.js"
);
const { captureAnswerCases, parseCaptureText, snapshotChunk } = await import(
  "../src/evals/answerCapture.js"
);
const { replayRecords } = await import("../src/evals/answerReplay.js");
const { askWithRetry, runAnswerCase } = await import("../src/evals/answerCaseRunner.js");

after(() => {
  if (typeof db.close === "function") {
    db.close();
  }
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

const widgetPage = {
  documentId: 9001,
  documentTitle: "Synthetic Widget Manual (invented text)",
  originalFilename: "synthetic-widget-manual.pdf",
  pageNumber: 3,
  chunkIndex: 0,
  chunkText:
    "Widget Housing Installation. Replace the frobnicator gasket whenever the cover is removed. " +
    "Torque: Widget housing bolt 23 N*m. Check that the sprocket turns freely by hand.",
  retrievalMode: "hybrid",
  semanticScore: 0.6,
  chunkMatchedTerms: 3,
  totalQueryTerms: 4,
  embedding: new Float32Array([0.1, 0.2, 0.3]),
};
const fluidPage = {
  ...widgetPage,
  pageNumber: 7,
  chunkText: "Frobnicator Fluid. Frobnicator fluid capacity 1.6 L. Do not overfill the reservoir.",
};

const QUESTIONS = {
  torque: "What is the widget housing bolt torque?",
  fluid: "What is the frobnicator fluid capacity?",
  invalid: "Which way does the sprocket turn?",
  nothing: "Is there anything about the nothing gauge?",
  probe: "What is the widget housing bolt torque for the probe?",
};

/** What the "model" says, keyed by the question it was asked. */
const REPLIES = {
  [QUESTIONS.torque]: {
    documentSupported: [
      {
        claim: "The widget housing bolt torque is 23 N*m.",
        sourceId: "S1",
        evidenceQuote: "Widget housing bolt 23 N*m",
      },
      {
        claim: "Replace the frobnicator gasket whenever the cover is removed.",
        sourceId: "S1",
        evidenceQuote: "Replace the frobnicator gasket whenever the cover is removed",
      },
    ],
    generalGuidance: ["Clean the threads before installing the bolts."],
    // The blank gap is dropped by the validator; the capture must keep it.
    gaps: ["The sources do not give a tightening sequence.", "   "],
  },
  [QUESTIONS.fluid]: {
    documentSupported: [
      {
        claim: "The frobnicator fluid capacity is 1.8 L.",
        sourceId: "S1",
        evidenceQuote: "Frobnicator fluid capacity 1.6 L",
      },
    ],
    generalGuidance: [],
    gaps: [],
  },
  [QUESTIONS.invalid]: { documentSupported: "Clockwise.", generalGuidance: [], gaps: [] },
};

const providerRequests = [];

/** A Responses API stand-in: answers by the question line in the prompt. */
async function fakeFetch(url, init) {
  const body = JSON.parse(init.body);
  const question = /^Question: (.*)$/m.exec(body.input)?.[1];
  providerRequests.push(question);

  // A real Response, so the recorder's clone() tee runs as it does in production.
  return new globalThis.Response(
    JSON.stringify({ status: "completed", output_text: JSON.stringify(REPLIES[question]) }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

function askQuestion(question, options) {
  return askQuestionUsingDocuments(question, {
    ...options,
    isAiConfigured: true,
    isSourceAvailable: () => true,
    retrieveChunks: async (retrievalQuestion) => {
      if (retrievalQuestion.includes("nothing")) return [];
      return retrievalQuestion.includes("fluid") ? [fluidPage, widgetPage] : [widgetPage, fluidPage];
    },
    rewriteQuestion: async () => QUESTIONS.fluid,
  });
}

test("a chunk snapshot keeps JSON values and drops vectors and objects", () => {
  const snapshot = snapshotChunk({
    ...widgetPage,
    scopeAtStart: null,
    matchedTerms: ["widget", "bolt"],
    nested: { a: 1 },
    notANumber: Number.NaN,
    buffer: Buffer.from("x"),
  });

  assert.equal(snapshot.chunkText, widgetPage.chunkText);
  assert.equal(snapshot.semanticScore, 0.6);
  assert.equal(snapshot.scopeAtStart, null);
  assert.deepEqual(snapshot.matchedTerms, ["widget", "bolt"]);

  for (const dropped of ["embedding", "nested", "notANumber", "buffer"]) {
    assert.equal(dropped in snapshot, false, `${dropped} should be dropped`);
  }
});

test("a capture records each raw reply as the pipeline judged it, and replays with 0 changes", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("the capture test must not reach the network");
  };

  const lines = [];
  const log = [];
  let summary;

  try {
    summary = await captureAnswerCases({
      cases: [
        { id: "synthetic-torque", question: QUESTIONS.torque, followUp: { question: "And the fluid?" } },
        { id: "synthetic-probe", question: QUESTIONS.probe, rejectionProbe: "numeric_anomaly" },
        { id: "synthetic-nothing", question: QUESTIONS.nothing },
        { id: "synthetic-invalid", question: QUESTIONS.invalid },
      ],
      askQuestion,
      generateEvidenceAnswer: generateEvidenceAnswerFromOpenAi,
      fetchImpl: fakeFetch,
      writeLine: (line) => lines.push(line),
      log: (line) => log.push(line),
      sleep: async () => {},
    });
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.deepEqual(summary, { records: 4, noReply: 1, failedCases: 1, statusMismatches: 0 });
  // The probe answers without a request; "nothing" never reaches the model.
  assert.deepEqual(providerRequests, [QUESTIONS.torque, QUESTIONS.fluid, QUESTIONS.invalid]);

  const parsed = parseCaptureText(lines.join("\n"));
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.header.caseCount, 4);

  const byTurn = Object.fromEntries(
    parsed.records.map((record) => [`${record.caseId}/${record.turn}`, record])
  );
  assert.deepEqual(Object.keys(byTurn), [
    "synthetic-torque/primary",
    "synthetic-torque/followUp",
    "synthetic-probe/primary",
    "synthetic-invalid/primary",
  ]);

  const torque = byTurn["synthetic-torque/primary"];
  assert.equal(torque.replySource, "model");
  // The reply before validation: the blank gap the validator drops is kept...
  assert.deepEqual(torque.reply, REPLIES[QUESTIONS.torque]);
  // ...while the verdicts cover the validated reply, as the pipeline saw it.
  assert.deepEqual(
    torque.captured.verdicts.map((entry) => `${entry.channel}[${entry.itemIndex}]=${entry.verdict}`),
    [
      "documentSupported[0]=accepted",
      "documentSupported[1]=accepted",
      "generalGuidance[0]=accepted",
      "gaps[0]=accepted",
    ]
  );
  assert.equal(torque.captured.status, "partial");
  assert.equal(torque.captured.pipelineStatus, "partial");
  assert.equal("embedding" in torque.chunks[0], false);
  assert.equal(torque.chunks[0].chunkText, widgetPage.chunkText);

  const followUp = byTurn["synthetic-torque/followUp"];
  assert.equal(followUp.question, "And the fluid?");
  assert.equal(followUp.standaloneQuestion, QUESTIONS.fluid);
  assert.equal(followUp.captured.verdicts[0].verdict, "numeric_anomaly");
  assert.equal(followUp.captured.pipelineStatus, "not_found");

  const probe = byTurn["synthetic-probe/primary"];
  assert.equal(probe.replySource, "rejection_probe");
  assert.equal(probe.captured.verdicts[0].verdict, "numeric_anomaly");

  // The validator refused this reply, so the pipeline threw -- but the reply is
  // still recorded, to be judged again by a later validator.
  const invalid = byTurn["synthetic-invalid/primary"];
  assert.equal(invalid.captured.status, "invalid_reply");
  assert.equal(invalid.captured.invalidReason, "documentSupported_not_an_array");
  assert.equal(invalid.captured.pipelineStatus, null);

  assert.ok(log.some((line) => line.startsWith("synthetic-nothing (primary): no model reply")));
  assert.ok(log.some((line) => line.startsWith("synthetic-invalid: failed")));

  const replay = replayRecords(parsed.records);
  assert.deepEqual(replay.verdictChanges, []);
  assert.deepEqual(replay.statusChanges, []);
  assert.equal(replay.verdictTotal, 4 + 1 + 1 + 0);
});

test("runAnswerCase asks the follow-up with the first answer as history", async () => {
  const calls = [];
  const turns = [];

  const { primary, followUp } = await runAnswerCase(
    { id: "c", question: "First?", image: null, followUp: { question: "Second?" } },
    {
      askQuestion: async (question, options) => {
        calls.push({ question, options });
        return { status: "answered", answer: `answer to ${question}` };
      },
      adjustOptions: (options, turn) => {
        turns.push(turn);
        return { ...options, marker: turn };
      },
    }
  );

  assert.deepEqual(turns, ["primary", "followUp"]);
  assert.equal(primary.answer, "answer to First?");
  assert.equal(followUp.answer, "answer to Second?");
  assert.deepEqual(calls[0].options, { image: null, includeMetrics: true, marker: "primary" });
  assert.deepEqual(calls[1].options, {
    history: [
      { role: "user", content: "First?" },
      { role: "assistant", content: "answer to First?" },
    ],
    marker: "followUp",
  });
});

test("askWithRetry retries a rate limit and nothing else", async () => {
  const waits = [];
  let attempts = 0;
  const rateLimited = Object.assign(new Error("slow down"), { failure: { httpStatus: 429 } });

  const result = await askWithRetry(
    async () => {
      attempts += 1;
      if (attempts < 3) throw rateLimited;
      return "ok";
    },
    "q",
    {},
    { sleep: async (ms) => waits.push(ms), log: () => {} }
  );

  assert.equal(result, "ok");
  assert.deepEqual(waits, [5000, 10000]);

  await assert.rejects(
    askWithRetry(async () => {
      throw new Error("boom");
    }, "q", {}, { sleep: async () => assert.fail("must not wait"), log: () => {} }),
    /boom/
  );
});
