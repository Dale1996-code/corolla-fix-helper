import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

// Scratch DB before importing: procedureSuggestionService imports
// chunkRetrievalService -> database.js, which opens config.databaseFile at
// import time.
const tempRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "corolla-fix-helper-suggestion-service-")
);
process.env.DATABASE_FILE = path.join(tempRoot, "suggestion-service.db");
process.env.UPLOADS_DIR = path.join(tempRoot, "uploads");
process.env.OPENAI_API_KEY = "";

const { db } = await import("../src/database.js");
const { suggestProceduresForSymptom, buildSuggestionQuery } = await import(
  "../src/services/procedureSuggestionService.js"
);

after(() => {
  if (typeof db.close === "function") {
    db.close();
  }

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

const symptom = {
  id: 1,
  title: "Rough idle",
  description: "Idle surges then stalls",
  suspectedCauses: "dirty throttle body",
  system: "Engine",
};

const candidates = [
  {
    id: 10,
    title: "Clean the throttle body",
    system: "Engine",
    toolsNeeded: "",
    partsNeeded: "",
    safetyNotes: "",
    steps: "Remove the intake tube and clean the throttle body, then idle relearn.",
    notes: "",
  },
  {
    id: 11,
    title: "Rotate the tires",
    system: "Wheels",
    toolsNeeded: "",
    partsNeeded: "",
    safetyNotes: "",
    steps: "Rotate the tires front to back.",
    notes: "",
  },
];

const chunks = [
  {
    documentId: 7,
    documentTitle: "Idle service",
    originalFilename: "idle-service.pdf",
    pageNumber: 2,
    chunkIndex: 0,
    chunkText:
      "Rough idle is often caused by a dirty throttle body. Clean the throttle body and perform idle relearn.",
  },
];

test("deterministic mode ranks overlapping procedures and needs no key", async () => {
  const result = await suggestProceduresForSymptom(symptom, candidates, {
    isAiConfigured: false,
    retrieveChunks: async (query, options) => {
      assert.equal(options.mode, "keyword");
      assert.ok(query.includes("idle"));
      return chunks;
    },
    generateSuggestions: async () => {
      throw new Error("model must not be called without a key");
    },
  });

  assert.equal(result.status, "answered");
  assert.equal(result.mode, "deterministic");
  assert.equal(result.aiConfigured, false);
  assert.equal(result.suggestions[0].procedureId, 10);
  assert.ok(result.suggestions[0].citations.length >= 1);
  assert.ok(!result.suggestions.some((suggestion) => suggestion.procedureId === 11));
});

test("returns not_found when there are no candidate procedures", async () => {
  const result = await suggestProceduresForSymptom(symptom, [], {
    isAiConfigured: false,
    retrieveChunks: async () => chunks,
  });

  assert.equal(result.status, "not_found");
  assert.deepEqual(result.suggestions, []);
});

test("LLM mode uses grounded model output when it is valid", async () => {
  let modelCalls = 0;

  const result = await suggestProceduresForSymptom(symptom, candidates, {
    isAiConfigured: true,
    retrieveChunks: async () => chunks,
    generateSuggestions: async ({ candidates: passedCandidates, chunks: passedChunks }) => {
      modelCalls += 1;
      assert.ok(passedCandidates.some((candidate) => candidate.id === 10));
      assert.equal(passedChunks.length, 1);
      return JSON.stringify([
        {
          procedureId: 10,
          reason: "Throttle body cleaning addresses rough idle.",
          chunkNumber: 1,
        },
      ]);
    },
  });

  assert.equal(modelCalls, 1);
  assert.equal(result.status, "answered");
  assert.equal(result.mode, "llm");
  assert.equal(result.suggestions[0].procedureId, 10);
  assert.equal(result.suggestions[0].source, "llm");
  assert.ok(result.suggestions[0].citations.length >= 1);
  assert.match(result.suggestions[0].reason, /idle/i);
});

test("malformed model output falls back to deterministic suggestions", async () => {
  const result = await suggestProceduresForSymptom(symptom, candidates, {
    isAiConfigured: true,
    retrieveChunks: async () => chunks,
    generateSuggestions: async () => "Sure! Here are some ideas: not json at all {{{",
  });

  assert.equal(result.status, "answered");
  assert.equal(result.mode, "deterministic");
  assert.equal(result.suggestions[0].procedureId, 10);
});

test("ungrounded or unknown model items are dropped, then it falls back", async () => {
  const result = await suggestProceduresForSymptom(symptom, candidates, {
    isAiConfigured: true,
    retrieveChunks: async () => chunks,
    // id 999 is not a candidate; chunkNumber 9 is out of range -> no grounded item.
    generateSuggestions: async () =>
      JSON.stringify([
        { procedureId: 999, reason: "invented", chunkNumber: 1 },
        { procedureId: 10, reason: "no real chunk", chunkNumber: 9 },
      ]),
  });

  assert.equal(result.mode, "deterministic");
  assert.equal(result.status, "answered");
});

test("a model error falls back to deterministic suggestions", async () => {
  const result = await suggestProceduresForSymptom(symptom, candidates, {
    isAiConfigured: true,
    retrieveChunks: async () => chunks,
    generateSuggestions: async () => {
      throw new Error("network down");
    },
  });

  assert.equal(result.mode, "deterministic");
  assert.equal(result.status, "answered");
});

test("buildSuggestionQuery combines the symptom fields", () => {
  assert.equal(
    buildSuggestionQuery({
      title: "Rough idle",
      description: "surges",
      suspectedCauses: "vacuum leak",
      system: "Engine",
    }),
    "Rough idle surges vacuum leak Engine"
  );
});
