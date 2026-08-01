import assert from "node:assert/strict";
import test from "node:test";

// Pure filter logic: no database, no network.
import { applyRelevanceFloor, sweepThresholds } from "../src/services/relevanceFloor.js";

const chunk = (overrides = {}) => ({
  documentId: 1,
  pageNumber: 1,
  chunkIndex: 0,
  retrievalMode: "hybrid",
  semanticScore: 0.5,
  keywordScore: 0,
  chunkText: "text",
  ...overrides,
});

// ---- Shadow mode is the default ----

test("shadow mode reports what it would drop but changes nothing", () => {
  const chunks = [chunk({ semanticScore: 0.5 }), chunk({ chunkIndex: 1, semanticScore: 0.05 })];
  const result = applyRelevanceFloor(chunks, { threshold: 0.2 });

  assert.equal(result.enforced, false);
  assert.equal(result.chunks.length, 2, "shadow mode must not filter");
  assert.equal(result.droppedCount, 1);
  assert.equal(result.dropped[0].semanticScore, 0.05);
});

test("enforcing actually removes the below-floor chunks", () => {
  const chunks = [chunk({ semanticScore: 0.5 }), chunk({ chunkIndex: 1, semanticScore: 0.05 })];
  const result = applyRelevanceFloor(chunks, { threshold: 0.2, enforce: true });

  assert.equal(result.enforced, true);
  assert.equal(result.chunks.length, 1);
  assert.equal(result.chunks[0].semanticScore, 0.5);
});

// ---- What the floor must never do ----

test("a chunk whose own TEXT matched is never dropped", () => {
  // The floor is a semantic-noise filter. A chunk that literally contains the
  // query terms has its own evidence and must survive a low cosine score.
  const result = applyRelevanceFloor(
    [chunk({ semanticScore: 0.01, keywordScore: 6, chunkMatchedTerms: 1 })],
    { threshold: 0.2, enforce: true }
  );

  assert.equal(result.droppedCount, 0);
  assert.equal(result.chunks.length, 1);
});

test("a keywordScore earned only from the title/filename does NOT exempt a chunk", () => {
  // Contract change, made during Milestone 3 calibration and documented in the
  // eval log. scoreChunkForTerms awards +2 title / +1 filename / +1 system, so
  // keywordScore > 0 can mean "this document is named after your question" while
  // the chunk body matched nothing. Exempting on keywordScore made the floor
  // completely inert; exempting on chunkMatchedTerms targets real evidence.
  const result = applyRelevanceFloor(
    [
      chunk({ semanticScore: 0.01, keywordScore: 3, chunkMatchedTerms: 0 }),
      chunk({ chunkIndex: 1, semanticScore: 0.9, chunkMatchedTerms: 0 }),
    ],
    { threshold: 0.2, enforce: true }
  );

  assert.equal(result.droppedCount, 1);
  assert.equal(result.chunks.length, 1);
  assert.equal(result.chunks[0].semanticScore, 0.9);
});

test("a chunk with no semantic score is never dropped", () => {
  // Unembedded or stale-version chunks rank by keyword only. Dropping them would
  // make a newly uploaded document vanish from Ask -- the exact failure the
  // embedding-version degradation logic prevents.
  for (const overrides of [
    { semanticScore: 0 },
    { semanticScore: null },
    { semanticScore: undefined },
    { retrievalMode: "keyword", semanticScore: 0.01 },
  ]) {
    const result = applyRelevanceFloor([chunk(overrides)], { threshold: 0.2, enforce: true });
    assert.equal(result.droppedCount, 0, `should not drop ${JSON.stringify(overrides)}`);
  }
});

test("the floor never empties the context", () => {
  // Dropping everything would turn a weak-but-real answer into a not_found with
  // no evidence to show, which is worse than letting the relevance gate decide.
  const chunks = [chunk({ semanticScore: 0.01 }), chunk({ chunkIndex: 1, semanticScore: 0.02 })];
  const result = applyRelevanceFloor(chunks, { threshold: 0.2, enforce: true });

  assert.equal(result.enforced, false, "must refuse to enforce an empty result");
  assert.equal(result.chunks.length, 2);
  // It still REPORTS what it would have dropped.
  assert.equal(result.droppedCount, 2);
});

test("malformed rows are ignored rather than dropped or crashed on", () => {
  const result = applyRelevanceFloor(
    [null, undefined, "text", chunk({ semanticScore: 0.5 })],
    { threshold: 0.2, enforce: true }
  );

  assert.equal(result.chunks.length, 4);
  assert.equal(result.droppedCount, 0);
});

test("a non-array input is handled safely", () => {
  const result = applyRelevanceFloor(/** @type {any} */ (null), { threshold: 0.2 });
  assert.deepEqual(result.chunks, []);
});

test("the dropped report carries no document text", () => {
  const result = applyRelevanceFloor(
    [chunk({ semanticScore: 0.01, chunkText: "SECRET DOCUMENT TEXT", documentTitle: "Secret" })],
    { threshold: 0.2 }
  );

  const serialized = JSON.stringify(result.dropped);
  assert.ok(!serialized.includes("SECRET"), "the shadow report must stay log-safe");
  assert.ok(!serialized.includes("Secret"));
});

// ---- Calibration sweep ----

test("the sweep reports dropped positives, which is the number that matters", () => {
  const samples = [
    {
      chunks: [
        chunk({ semanticScore: 0.45, chunkText: "good" }),
        chunk({ chunkIndex: 1, semanticScore: 0.08, chunkText: "noise" }),
      ],
      isPositive: (candidate) => candidate.chunkText === "good",
    },
  ];

  const [low, high] = sweepThresholds(samples, [0.1, 0.5]);

  assert.equal(low.droppedPositive, 0);
  assert.equal(low.droppedNegative, 1);
  assert.equal(low.safe, true);

  // 0.5 would take the good chunk with it.
  assert.equal(high.droppedPositive, 1);
  assert.equal(high.safe, false);
});

test("a threshold of 0 drops nothing", () => {
  const samples = [
    {
      chunks: [chunk({ semanticScore: 0.01 })],
      isPositive: () => false,
    },
  ];

  const [row] = sweepThresholds(samples, [0]);

  assert.equal(row.droppedNegative, 0);
  assert.equal(row.droppedPositive, 0);
});
