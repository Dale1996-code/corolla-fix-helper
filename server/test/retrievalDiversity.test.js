import assert from "node:assert/strict";
import test from "node:test";

// Pure policy logic: no database, no network, no API key.
import {
  DEFAULT_MAX_CHUNKS_PER_SOURCE,
  diversifyRankedChunks,
  measureRetrievalDiversity,
} from "../src/services/retrievalDiversity.js";

/**
 * Ranked candidate in the shape chunkRetrievalService produces. `rank` is only
 * a readable identity for assertions -- the policy never reads it.
 */
function chunk(rank, documentId, chunkText, overrides = {}) {
  return {
    chunkId: rank,
    rank,
    documentId,
    pageNumber: 1,
    chunkIndex: 0,
    chunkText,
    documentTitle: `Document ${documentId}`,
    retrievalMode: "hybrid",
    ...overrides,
  };
}

const ranks = (chunks) => chunks.map((entry) => entry.rank);

// Content-group resolver used by the duplicate-document cases: documents whose
// text is identical share one logical source. Mirrors what the database-backed
// resolver derives from documents.extracted_text.
function resolveByGroupTable(table) {
  return (candidate) => table.get(candidate.documentId) || `document:${candidate.documentId}`;
}

// ---- 1. Single-document monopolization ----

test("one document cannot consume nearly every slot when other documents are relevant", () => {
  const ranked = [
    chunk(1, 100, "wiring diagram interior light page one"),
    chunk(2, 100, "wiring diagram interior light page two"),
    chunk(3, 100, "wiring diagram interior light page three"),
    chunk(4, 100, "wiring diagram interior light page four"),
    chunk(5, 100, "wiring diagram interior light page five"),
    chunk(6, 200, "interior light bulb replacement procedure"),
    chunk(7, 300, "interior light fuse location"),
    chunk(8, 400, "interior light switch continuity check"),
  ];

  const result = diversifyRankedChunks(ranked, { limit: 4 });

  assert.equal(result.length, 4, "the slots must still be filled");
  const fromMonopolist = result.filter((entry) => entry.documentId === 100).length;
  assert.equal(
    fromMonopolist,
    DEFAULT_MAX_CHUNKS_PER_SOURCE,
    "the dominant document is capped at the per-source limit"
  );
  assert.deepEqual(ranks(result), [1, 2, 3, 6], "capped slots go to the next-best other document");
});

// ---- 2. Exact duplicate documents ----

test("different document ids carrying identical text cannot bypass the cap", () => {
  // Four documents, one logical source: this is the #835/#836/#837 shape, where
  // file-level dedup cannot help because the PDFs differ byte for byte.
  const duplicateGroup = new Map([
    [835, "text:smart-key"],
    [836, "text:smart-key"],
    [837, "text:smart-key"],
    [838, "text:smart-key"],
  ]);

  const ranked = [
    chunk(1, 835, "smart key system immobiliser page one"),
    chunk(2, 836, "smart key system immobiliser page two"),
    chunk(3, 837, "smart key system immobiliser page three"),
    chunk(4, 838, "smart key system immobiliser page four"),
    chunk(5, 900, "engine immobiliser ECU reset procedure"),
    chunk(6, 901, "transponder key registration steps"),
  ];

  const result = diversifyRankedChunks(ranked, {
    limit: 4,
    resolveSourceKey: resolveByGroupTable(duplicateGroup),
  });

  const fromDuplicateGroup = result.filter((entry) => duplicateGroup.has(entry.documentId));
  assert.equal(
    fromDuplicateGroup.length,
    DEFAULT_MAX_CHUNKS_PER_SOURCE,
    "four document ids sharing one text count as one source"
  );
  assert.deepEqual(ranks(result), [1, 2, 3, 5]);
});

test("byte-identical evidence is returned once even across different documents", () => {
  // The pages themselves are identical, not merely the parent documents, so the
  // second copy adds no evidence at all and is dropped rather than deferred.
  const ranked = [
    chunk(1, 331, "OVERALL ELECTRICAL WIRING DIAGRAM INTERIOR LIGHT"),
    chunk(2, 332, "overall electrical wiring diagram   interior light"),
    chunk(3, 333, "interior light relay ground point IG1"),
    chunk(4, 334, "interior light dome lamp connector pinout"),
  ];

  const result = diversifyRankedChunks(ranked, { limit: 4 });

  assert.deepEqual(ranks(result), [1, 3, 4], "the identical second copy is dropped");
  assert.equal(
    result.length,
    3,
    "an exact duplicate is never re-added as filler -- repeating the same words is not evidence"
  );
});

// ---- 3. Relevance preservation ----

test("the best result stays the best result", () => {
  const ranked = [
    chunk(1, 100, "front brake pad minimum thickness 1.0 mm"),
    chunk(2, 100, "front brake pad standard thickness 11.0 mm"),
    chunk(3, 100, "front brake disc runout limit"),
    chunk(4, 100, "front brake caliper bolt torque"),
    chunk(5, 200, "brake fluid replacement interval"),
  ];

  const result = diversifyRankedChunks(ranked, { limit: 5 });

  assert.equal(result[0].rank, 1, "rank 1 is never displaced by diversification");
  assert.deepEqual(
    ranks(result),
    [1, 2, 3, 5, 4],
    "the strongest evidence keeps its place; the capped chunk is moved to the end, never dropped"
  );
  assert.equal(result.length, ranked.length, "no candidate is lost when the slots allow it");
  assert.equal(
    result[0],
    ranked[0],
    "results are passed through by reference -- diversification rewrites no row"
  );
});

// ---- 4. Legitimate multiple chunks ----

test("several chunks from one document still appear when they carry distinct evidence", () => {
  const ranked = [
    chunk(1, 748, "drain plug tightening torque 27 ft-lb"),
    chunk(2, 748, "oil filter cap torque 18 ft-lb"),
    chunk(3, 200, "engine oil capacity with filter"),
  ];

  const result = diversifyRankedChunks(ranked, { limit: 3 });

  assert.deepEqual(ranks(result), [1, 2, 3]);
  assert.equal(
    result.filter((entry) => entry.documentId === 748).length,
    2,
    "this is not a one-result-per-document rule"
  );
});

test("a source sitting exactly on the cap is left alone", () => {
  // The shape of the query that motivated this work on the hybrid path: two
  // documents contributing three pages each. Three is AT the cap, not over it,
  // so this result set is returned untouched. Pinned because it is the case
  // most likely to be misread as the safeguard failing.
  const ranked = [
    chunk(1, 637, "interior light except TMC made page five"),
    chunk(2, 637, "interior light except TMC made page eight"),
    chunk(3, 637, "interior light except TMC made page one"),
    chunk(4, 638, "interior light TMC made page four"),
    chunk(5, 638, "interior light TMC made page one"),
    chunk(6, 638, "interior light TMC made page nine"),
    chunk(7, 189, "interior lights door locks instrument cluster"),
    chunk(8, 479, "diagrams electrical overall wiring"),
    // Further relevant candidates exist below the slot cut, as they do on the
    // real corpus. Nothing reaches them while the first eight are all admitted.
    chunk(9, 737, "ILL- ILL+ RH LH IG 15A hot in on or start"),
    chunk(10, 309, "hot in on or start 10A interior light circuit"),
  ];

  const result = diversifyRankedChunks(ranked, { limit: 8 });

  assert.deepEqual(
    ranks(result),
    [1, 2, 3, 4, 5, 6, 7, 8],
    "at the cap, not over it: this result set is returned exactly as ranked"
  );

  // Lowering the cap by one is what would change it. Recorded so the difference
  // between the two settings is visible evidence rather than folklore, and so a
  // future decision to move the default has a test that shows what it buys.
  const stricter = diversifyRankedChunks(ranked, { limit: 8, maxPerSource: 2 });
  assert.deepEqual(
    ranks(stricter),
    [1, 2, 4, 5, 7, 8, 9, 10],
    "a cap of 2 trades the third page of each diagram for two further documents"
  );
});

// ---- 5. Insufficient alternatives ----

test("slots are still filled when one source is the only relevant source", () => {
  const ranked = [
    chunk(1, 172, "brake bleeding step one"),
    chunk(2, 172, "brake bleeding step two"),
    chunk(3, 172, "brake bleeding step three"),
    chunk(4, 172, "brake bleeding step four"),
    chunk(5, 172, "brake bleeding step five"),
  ];

  const result = diversifyRankedChunks(ranked, { limit: 5 });

  assert.deepEqual(
    ranks(result),
    [1, 2, 3, 4, 5],
    "with nothing else to offer, the original ranking is returned untouched"
  );
});

test("deferred chunks backfill in rank order, not in cap order", () => {
  const ranked = [
    chunk(1, 100, "alpha"),
    chunk(2, 100, "bravo"),
    chunk(3, 100, "charlie"),
    chunk(4, 100, "delta"),
    chunk(5, 100, "echo"),
    chunk(6, 200, "foxtrot"),
  ];

  const result = diversifyRankedChunks(ranked, { limit: 5 });

  assert.deepEqual(
    ranks(result),
    [1, 2, 3, 6, 4],
    "the other source takes the fourth slot, then the best deferred chunk fills the rest"
  );
});

// ---- 6. General diagnostic query: an already-diverse result set is untouched ----

test("an already-diverse ranking is returned exactly as it arrived", () => {
  const ranked = [
    chunk(1, 10, "coolant capacity 6.4 quarts"),
    chunk(2, 20, "thermostat opening temperature"),
    chunk(3, 30, "radiator cap pressure rating"),
    chunk(4, 40, "water pump replacement procedure"),
  ];

  const result = diversifyRankedChunks(ranked, { limit: 4 });

  assert.deepEqual(ranks(result), [1, 2, 3, 4]);
  assert.deepEqual(result, ranked, "no promotion, no demotion, no rewriting of rows");
});

test("the safeguard never promotes a lower-ranked source above a higher-ranked one", () => {
  // A prose manual outranks a diagram here; diversification must not reorder
  // them just because the diagram is a different kind of document.
  const ranked = [
    chunk(1, 500, "prose manual: measure pad thickness with a caliper"),
    chunk(2, 600, "diagram sheet: brake circuit"),
    chunk(3, 500, "prose manual: replace pads in axle sets"),
  ];

  const result = diversifyRankedChunks(ranked, { limit: 3 });

  assert.deepEqual(ranks(result), [1, 2, 3]);
});

// ---- Configuration and defensive behavior ----

test("a per-source cap of zero disables diversification entirely", () => {
  const ranked = [
    chunk(1, 100, "one"),
    chunk(2, 100, "two"),
    chunk(3, 100, "three"),
    chunk(4, 200, "four"),
  ];

  const result = diversifyRankedChunks(ranked, { limit: 3, maxPerSource: 0 });

  assert.deepEqual(ranks(result), [1, 2, 3], "disabled means the plain ranked slice");
});

test("a cap of one gives one result per source", () => {
  const ranked = [
    chunk(1, 100, "one"),
    chunk(2, 100, "two"),
    chunk(3, 200, "three"),
    chunk(4, 300, "four"),
  ];

  const result = diversifyRankedChunks(ranked, { limit: 3, maxPerSource: 1 });

  assert.deepEqual(ranks(result), [1, 3, 4]);
});

test("rows that are not chunk objects are skipped instead of throwing", () => {
  const ranked = [null, chunk(1, 100, "real"), undefined, chunk(2, 200, "also real")];

  const result = diversifyRankedChunks(ranked, { limit: 4 });

  assert.deepEqual(ranks(result), [1, 2]);
});

test("a chunk with no text is kept -- blankness is not evidence of duplication", () => {
  const ranked = [chunk(1, 100, ""), chunk(2, 200, "   "), chunk(3, 300, "real text")];

  const result = diversifyRankedChunks(ranked, { limit: 3 });

  assert.deepEqual(ranks(result), [1, 2, 3]);
});

// ---- Measurement ----

test("the diversity measurement counts slots, documents, and logical sources", () => {
  const duplicateGroup = new Map([
    [331, "text:a"],
    [332, "text:a"],
    [333, "text:b"],
    [334, "text:b"],
  ]);

  const measured = measureRetrievalDiversity(
    [
      chunk(1, 331, "one"),
      chunk(2, 332, "two"),
      chunk(3, 333, "three"),
      chunk(4, 334, "four"),
    ],
    { resolveSourceKey: resolveByGroupTable(duplicateGroup) }
  );

  assert.deepEqual(measured, {
    slotCount: 4,
    distinctDocumentCount: 4,
    distinctSourceCount: 2,
    distinctEvidenceCount: 4,
  });
});

test("distinct evidence counts the words, not the documents that carry them", () => {
  // Three documents, one paragraph. Distinct source count says three; only one
  // of those slots is telling the reader anything the others did not.
  const measured = measureRetrievalDiversity([
    chunk(1, 657, "8. ENGINE OIL LEVEL check that the level is between the marks"),
    chunk(2, 737, "8.  engine oil level   CHECK THAT THE LEVEL IS BETWEEN THE MARKS"),
    chunk(3, 740, "8. ENGINE OIL LEVEL check that the level is between the marks"),
  ]);

  assert.equal(measured.slotCount, 3);
  assert.equal(measured.distinctSourceCount, 3);
  assert.equal(
    measured.distinctEvidenceCount,
    1,
    "repeating one paragraph three times is one piece of evidence"
  );
});

test("the measurement falls back to per-document counting with no resolver", () => {
  const measured = measureRetrievalDiversity([chunk(1, 10, "a"), chunk(2, 10, "b")]);

  assert.deepEqual(measured, {
    slotCount: 2,
    distinctDocumentCount: 1,
    distinctSourceCount: 1,
    distinctEvidenceCount: 2,
  });
});
