import assert from "node:assert/strict";
import test from "node:test";

// The reranker is a pure-logic + raw-fetch service. It imports only config (no
// database), so no scratch DB isolation is needed. A blank key keeps the
// no-key branch honest; every test that needs a "configured" path injects it.
process.env.OPENAI_API_KEY = "";

const {
  applyRanking,
  parseRerankedOrder,
  rerankChunks,
} = await import("../src/services/chunkRerankService.js");

function candidate(id) {
  return {
    chunkId: id,
    documentId: id,
    pageNumber: id,
    chunkIndex: 0,
    chunkText: `Chunk number ${id} text.`,
    documentTitle: `Doc ${id}`,
    originalFilename: `doc-${id}.pdf`,
  };
}

const threeCandidates = [candidate(1), candidate(2), candidate(3)];

test("parseRerankedOrder reads a valid best-first JSON array", () => {
  assert.deepEqual(parseRerankedOrder("[3, 1, 2]", 3), [3, 1, 2]);
});

test("parseRerankedOrder tolerates code fences and surrounding prose", () => {
  const reply = "Here is the ranking:\n```json\n[2, 3, 1]\n```\nDone.";
  assert.deepEqual(parseRerankedOrder(reply, 3), [2, 3, 1]);
});

test("parseRerankedOrder accepts a useful subset of the candidates", () => {
  // The model is allowed to rank only the chunks it finds useful.
  assert.deepEqual(parseRerankedOrder("[2]", 3), [2]);
});

test("parseRerankedOrder rejects malformed JSON", () => {
  assert.equal(parseRerankedOrder("not json at all", 3), null);
  assert.equal(parseRerankedOrder("[1, 2", 3), null);
});

test("parseRerankedOrder rejects unknown / out-of-range indexes", () => {
  assert.equal(parseRerankedOrder("[1, 4]", 3), null);
  assert.equal(parseRerankedOrder("[0, 1]", 3), null);
});

test("parseRerankedOrder rejects duplicate indexes", () => {
  assert.equal(parseRerankedOrder("[1, 1, 2]", 3), null);
});

test("parseRerankedOrder rejects an empty array", () => {
  assert.equal(parseRerankedOrder("[]", 3), null);
});

test("applyRanking reorders by index and appends any omitted candidates", () => {
  const ranked = applyRanking(threeCandidates, [3, 1]);

  assert.equal(ranked.length, 3);
  assert.deepEqual(
    ranked.map((chunk) => chunk.chunkId),
    [3, 1, 2]
  );
});

test("rerankChunks reorders candidates when the model returns a valid order", async () => {
  const reranked = await rerankChunks("oil drain plug torque", threeCandidates, {
    isAiConfigured: true,
    generateRanking: async () => "[3, 2, 1]",
  });

  assert.deepEqual(
    reranked.map((chunk) => chunk.chunkId),
    [3, 2, 1]
  );
});

test("rerankChunks falls back to the original order on malformed model output", async () => {
  const reranked = await rerankChunks("oil drain plug torque", threeCandidates, {
    isAiConfigured: true,
    generateRanking: async () => "garbage, not json",
  });

  assert.deepEqual(
    reranked.map((chunk) => chunk.chunkId),
    [1, 2, 3]
  );
});

test("rerankChunks falls back to the original order when the model rejects unknown ids", async () => {
  const reranked = await rerankChunks("oil drain plug torque", threeCandidates, {
    isAiConfigured: true,
    generateRanking: async () => "[1, 9]",
  });

  assert.deepEqual(
    reranked.map((chunk) => chunk.chunkId),
    [1, 2, 3]
  );
});

test("rerankChunks falls back to the original order when the model call throws", async () => {
  const reranked = await rerankChunks("oil drain plug torque", threeCandidates, {
    isAiConfigured: true,
    generateRanking: async () => {
      throw new Error("network down");
    },
  });

  assert.deepEqual(
    reranked.map((chunk) => chunk.chunkId),
    [1, 2, 3]
  );
});

test("rerankChunks does not call the model when AI is not configured", async () => {
  let calls = 0;
  const reranked = await rerankChunks("oil drain plug torque", threeCandidates, {
    isAiConfigured: false,
    generateRanking: async () => {
      calls += 1;
      return "[3, 2, 1]";
    },
  });

  assert.equal(calls, 0);
  assert.deepEqual(
    reranked.map((chunk) => chunk.chunkId),
    [1, 2, 3]
  );
});

test("rerankChunks skips the model for a pool too small to reorder", async () => {
  let calls = 0;
  const reranked = await rerankChunks("oil drain plug torque", [candidate(1)], {
    isAiConfigured: true,
    generateRanking: async () => {
      calls += 1;
      return "[1]";
    },
  });

  assert.equal(calls, 0);
  assert.deepEqual(
    reranked.map((chunk) => chunk.chunkId),
    [1]
  );
});
