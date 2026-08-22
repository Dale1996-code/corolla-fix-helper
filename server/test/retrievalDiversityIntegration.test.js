import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

// Isolate the database/uploads to a scratch dir BEFORE importing anything that
// pulls in database.js. No API key: every case here is keyword/fusion ranking
// over unembedded chunks, so the diversity step is exercised without a model.
const tempRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "corolla-fix-helper-retrieval-diversity-")
);
process.env.DATABASE_FILE = path.join(tempRoot, "diversity.db");
process.env.UPLOADS_DIR = path.join(tempRoot, "uploads");
process.env.OPENAI_API_KEY = "";

const { db } = await import("../src/database.js");
const { initializeDatabase } = await import("../src/initDatabase.js");
const { retrieveKeywordChunks, retrieveRelevantChunks } = await import(
  "../src/services/chunkRetrievalService.js"
);
const { getDocumentContentGroupKey } = await import(
  "../src/services/documentContentIdentity.js"
);
const { measureRetrievalDiversity } = await import(
  "../src/services/retrievalDiversity.js"
);
const { rebuildDocumentChunksFromPages } = await import(
  "../src/services/documentChunkService.js"
);

initializeDatabase();

after(() => {
  if (typeof db.close === "function") {
    db.close();
  }

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

let uniqueCounter = 0;

function nextTag() {
  uniqueCounter += 1;
  return `divtag${uniqueCounter}`;
}

/**
 * Insert a document carrying `extractedText`, which is the signal the content
 * group is derived from. Two documents with the same text are one logical
 * source even though their ids, filenames, and stored PDFs all differ -- the
 * real #835/#836/#837 shape.
 */
function insertDocument(title, extractedText) {
  const vehicle = db.prepare("SELECT id FROM vehicles ORDER BY id ASC LIMIT 1").get();
  uniqueCounter += 1;
  const filename = `diversity-${uniqueCounter}.pdf`;

  return Number(
    db
      .prepare(`
        INSERT INTO documents (
          vehicle_id, title, original_filename, stored_filename, file_path,
          file_type, system, document_type, extracted_text, extraction_status, page_count
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        vehicle.id,
        title,
        filename,
        filename,
        `server/uploads/${filename}`,
        "application/pdf",
        "Electrical",
        "Wiring Diagram",
        extractedText,
        "completed",
        null
      ).lastInsertRowid
  );
}

/** One chunk per page, each page's text supplied by the caller. */
function seedDocument(title, pageTexts, { extractedText = pageTexts.join("\n") } = {}) {
  const documentId = insertDocument(title, extractedText);

  rebuildDocumentChunksFromPages(
    documentId,
    pageTexts.map((text, index) => ({ pageNumber: index + 1, text }))
  );

  return documentId;
}

function resetCorpus() {
  db.exec("DELETE FROM document_chunks");
  db.exec("DELETE FROM documents");
}

const measure = (results) =>
  measureRetrievalDiversity(results, {
    resolveSourceKey: (chunk) => getDocumentContentGroupKey(chunk.documentId),
  });

// ---- Single-document monopolization ----

test("one document's pages cannot fill every slot when other documents match", async () => {
  resetCorpus();
  const tag = nextTag();

  // Neutral titles, so every chunk scores on its body text alone and the ties
  // break on document id -- which is precisely how a multi-page diagram sheet
  // ends up holding the whole result set on the real corpus.
  const monopolist = seedDocument(
    "Sheet one",
    Array.from({ length: 6 }, (_, page) => `${tag} interior light wiring sheet ${page + 1}`)
  );
  const second = seedDocument("Sheet two", [`${tag} interior light bulb removal steps`]);
  const third = seedDocument("Sheet three", [`${tag} interior light fuse box location`]);

  const before = retrieveKeywordChunks(`${tag} interior light`, {
    limit: 4,
    maxChunksPerSource: 0,
  });
  const after = retrieveKeywordChunks(`${tag} interior light`, { limit: 4 });

  assert.equal(
    before.filter((chunk) => chunk.documentId === monopolist).length,
    4,
    "precondition: without the safeguard one document takes every slot"
  );

  assert.equal(after.length, 4, "the slots stay full");
  assert.equal(
    after.filter((chunk) => chunk.documentId === monopolist).length,
    3,
    "the dominant document is capped"
  );
  assert.ok(
    after.some((chunk) => chunk.documentId === second) ||
      after.some((chunk) => chunk.documentId === third),
    "a freed slot goes to another document"
  );
  assert.equal(measure(before).distinctSourceCount, 1);
  assert.equal(measure(after).distinctSourceCount, 2);

  // The same policy applies on the default hybrid path, not just keyword mode.
  const hybrid = await retrieveRelevantChunks(`${tag} interior light`, { limit: 4 });
  assert.equal(
    hybrid.filter((chunk) => chunk.documentId === monopolist).length,
    3,
    "hybrid retrieval is diversified too"
  );
});

// ---- Exact duplicate documents ----

test("documents with identical extracted text count as one source", async () => {
  resetCorpus();
  const tag = nextTag();

  // Identical extracted text, four separate documents. Each contributes a
  // DIFFERENT chunk, so only the content-group rule can catch this -- chunk-text
  // deduplication alone would let all four through.
  const duplicateText = `${tag} smart key system immobiliser wiring`;
  const duplicates = [1, 2, 3, 4].map((copy) =>
    seedDocument(`Smart key system copy ${copy} ${tag}`, [`${tag} smart key page ${copy}`], {
      extractedText: duplicateText,
    })
  );
  const independent = seedDocument(`Transponder registration ${tag}`, [
    `${tag} smart key transponder registration`,
  ]);

  const groupKeys = new Set(duplicates.map((id) => getDocumentContentGroupKey(id)));
  assert.equal(groupKeys.size, 1, "identical text must resolve to one content group");
  assert.notEqual(
    getDocumentContentGroupKey(independent),
    [...groupKeys][0],
    "different text must resolve to a different content group"
  );

  const results = retrieveKeywordChunks(`${tag} smart key`, { limit: 4 });

  assert.equal(
    results.filter((chunk) => duplicates.includes(chunk.documentId)).length,
    3,
    "four document ids sharing one text still get one source's budget"
  );
  assert.ok(
    results.some((chunk) => chunk.documentId === independent),
    "the genuinely different document reaches the result set"
  );
  assert.equal(measure(results).distinctDocumentCount, 4);
  assert.equal(
    measure(results).distinctSourceCount,
    2,
    "distinct document count overstates diversity; distinct source count does not"
  );
});

test("byte-identical pages from different documents are returned once", () => {
  resetCorpus();
  const tag = nextTag();

  // Same page text, and the parent documents also differ in overall text, so the
  // duplicate is caught by the evidence fingerprint rather than the group rule.
  const pageText = `${tag} interior light ground point diagram`;
  const first = seedDocument(`Diagram sheet A ${tag}`, [pageText], {
    extractedText: `${tag} sheet a unique trailing text`,
  });
  seedDocument(`Diagram sheet B ${tag}`, [pageText], {
    extractedText: `${tag} sheet b unique trailing text`,
  });
  const other = seedDocument(`Interior light switch ${tag}`, [
    `${tag} interior light switch continuity test`,
  ]);

  const results = retrieveKeywordChunks(`${tag} interior light`, { limit: 4 });

  assert.equal(
    results.filter((chunk) => chunk.chunkText === pageText).length,
    1,
    "the same words are returned once, not once per document"
  );
  assert.ok(results.some((chunk) => chunk.documentId === first));
  assert.ok(results.some((chunk) => chunk.documentId === other));
});

// ---- Relevance preservation ----

test("the best chunk stays first after diversification", () => {
  resetCorpus();
  const tag = nextTag();

  const best = seedDocument(`Torque specifications ${tag}`, [
    `${tag} front brake caliper bolt torque specification 79 ft-lb`,
  ]);
  seedDocument(`General brake notes ${tag}`, [
    `${tag} brake service general notes`,
    `${tag} brake service general notes page two`,
    `${tag} brake service general notes page three`,
  ]);

  const results = retrieveKeywordChunks(`${tag} front brake caliper bolt torque`, {
    limit: 4,
  });

  assert.equal(results[0].documentId, best, "the strongest evidence is still rank 1");
});

// ---- Wiring-specific query: recovered diagrams stay eligible to win ----

test("a recovered wiring diagram still ranks first when it is the best evidence", () => {
  resetCorpus();
  const tag = nextTag();

  const diagram = seedDocument(`Overall electrical wiring diagram ${tag}`, [
    `${tag} interior light wiring diagram connector A51 CANH ground point IG1`,
  ]);
  seedDocument(`Maintenance schedule ${tag}`, [
    `${tag} maintenance schedule mentions the interior light bulb once`,
  ]);
  seedDocument(`Owner handbook ${tag}`, [`${tag} interior light courtesy lamp overview`]);

  const results = retrieveKeywordChunks(`${tag} interior light wiring diagram connector`, {
    limit: 4,
  });

  assert.equal(
    results[0].documentId,
    diagram,
    "diversification must not demote a diagram that genuinely wins the query"
  );
});

// ---- General diagnostic query: normal ranking is undisturbed ----

test("an already-diverse prose result set is returned unchanged", () => {
  resetCorpus();
  const tag = nextTag();

  const documents = [
    seedDocument(`Brake bleeding procedure ${tag}`, [`${tag} brake bleeding procedure steps`]),
    seedDocument(`Brake fluid specification ${tag}`, [`${tag} brake fluid type specification`]),
    seedDocument(`Brake warning lamp ${tag}`, [`${tag} brake warning lamp diagnosis`]),
    seedDocument(`Brake pedal free play ${tag}`, [`${tag} brake pedal free play adjustment`]),
  ];

  const before = retrieveKeywordChunks(`${tag} brake`, { limit: 4, maxChunksPerSource: 0 });
  const after = retrieveKeywordChunks(`${tag} brake`, { limit: 4 });

  assert.deepEqual(
    after.map((chunk) => chunk.chunkId),
    before.map((chunk) => chunk.chunkId),
    "nothing to deduplicate means nothing changes"
  );
  assert.equal(measure(after).distinctSourceCount, documents.length);
});

// ---- Insufficient alternatives ----

test("a single-source question keeps all of its slots", () => {
  resetCorpus();
  const tag = nextTag();

  seedDocument(
    `Brake bleeding ${tag}`,
    Array.from({ length: 5 }, (_, page) => `${tag} brake bleeding step ${page + 1}`)
  );

  const before = retrieveKeywordChunks(`${tag} brake bleeding`, {
    limit: 5,
    maxChunksPerSource: 0,
  });
  const after = retrieveKeywordChunks(`${tag} brake bleeding`, { limit: 5 });

  assert.equal(after.length, 5, "slots are not left empty for the sake of variety");
  assert.deepEqual(
    after.map((chunk) => chunk.chunkId).sort(),
    before.map((chunk) => chunk.chunkId).sort(),
    "with one source available the same evidence is returned"
  );
});

// ---- Measurement: the reported defect, reproduced and measured ----

test("diversity measurement: eight slots stop collapsing onto four sources", () => {
  resetCorpus();
  const tag = nextTag();

  // The shape measured on the real corpus for "interior light wiring": eight
  // results from eight different document ids, but only four logically distinct
  // sources, because the sheets are stored as identical-text pairs (#331/#332,
  // #333/#334, ...). Identical text means the pages are identical too, so the
  // second copy of each pair repeats words the first already supplied.
  for (const pair of ["a", "b", "c", "d"]) {
    const sheetText = `${tag} interior light wiring diagram sheet ${pair}`;

    for (const copy of [1, 2]) {
      seedDocument(`Sheet ${pair}${copy}`, [sheetText], { extractedText: sheetText });
    }
  }

  // Genuinely different documents that match the query less strongly, so they
  // sit below the duplicates in the ranking and are only reached if the
  // duplicates stop consuming every slot.
  for (const extra of ["e", "f", "g", "h"]) {
    seedDocument(`Other ${extra}`, [`${tag} interior light note ${extra}`]);
  }

  const before = measure(
    retrieveKeywordChunks(`${tag} interior light wiring`, { limit: 8, maxChunksPerSource: 0 })
  );
  const after = measure(retrieveKeywordChunks(`${tag} interior light wiring`, { limit: 8 }));

  assert.deepEqual(
    before,
    {
      slotCount: 8,
      distinctDocumentCount: 8,
      distinctSourceCount: 4,
      distinctEvidenceCount: 4,
    },
    "the reported defect: eight documents, but half the slots repeat the other half"
  );
  assert.deepEqual(
    after,
    {
      slotCount: 8,
      distinctDocumentCount: 8,
      distinctSourceCount: 8,
      distinctEvidenceCount: 8,
    },
    "the same eight slots now say eight different things"
  );
  assert.ok(
    after.distinctEvidenceCount > before.distinctEvidenceCount,
    "the safeguard exists to raise this number"
  );
});

// ---- Content identity tracks re-extraction ----

test("re-extracting a document updates its content group", () => {
  resetCorpus();
  const tag = nextTag();

  const original = seedDocument(`Copy one ${tag}`, [`${tag} page`], {
    extractedText: `${tag} shared text`,
  });
  const copy = seedDocument(`Copy two ${tag}`, [`${tag} page two`], {
    extractedText: `${tag} shared text`,
  });

  assert.equal(
    getDocumentContentGroupKey(original),
    getDocumentContentGroupKey(copy),
    "precondition: the two documents start out identical"
  );

  db.prepare(`
    UPDATE documents
    SET extracted_text = ?, updated_at = ?
    WHERE id = ?
  `).run(`${tag} corrected text after re-extraction`, "2026-08-18 09:00:00", copy);

  assert.notEqual(
    getDocumentContentGroupKey(original),
    getDocumentContentGroupKey(copy),
    "a cached group key must not survive a text change"
  );
});
