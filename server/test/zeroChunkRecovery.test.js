import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-n0-recovery-test-"));

process.env.DATABASE_FILE = path.join(tempRoot, "test.db");
process.env.UPLOADS_DIR = path.join(tempRoot, "uploads");
process.env.ASK_EVIDENCE_CONTRACT = "false";
process.env.OPENAI_API_KEY = "";

const { db } = await import("../src/database.js");
const { initializeDatabase } = await import("../src/initDatabase.js");
const {
  isAlreadyComplete,
  readCorpusHealth,
  readProgress,
  rebuildPagesFromStoredText,
  recoverDocument,
  resolveProgressFile,
  selectRecoveryStrategy,
  summarizeEntries,
  verifyExtraction,
  writeProgress,
} = await import("../src/services/zeroChunkRecovery.js");
const { buildChunksFromPages } = await import("../src/services/documentChunkService.js");

initializeDatabase();

after(() => {
  if (typeof db.close === "function") {
    db.close();
  }

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function extraction(overrides = {}) {
  return {
    extractedText: "x".repeat(500),
    extractionStatus: "completed_with_ocr",
    pageCount: 2,
    pages: [
      { pageNumber: 1, text: "x".repeat(250) },
      { pageNumber: 2, text: "x".repeat(250) },
    ],
    ocrWarnings: [],
    ...overrides,
  };
}

test("only the two recoverable diagnostic verdicts get a strategy", () => {
  assert.equal(
    selectRecoveryStrategy("text-present-no-chunks"),
    "rechunk-from-stored-text"
  );
  assert.equal(selectRecoveryStrategy("ocr-candidate"), "ocr-reextract");

  for (const category of [
    "title-only-or-near-empty",
    "malformed-or-missing-file",
    "unknown-manual-review",
  ]) {
    assert.equal(selectRecoveryStrategy(category), null, category);
  }
});

test("dev/test leftovers and malformed files are skipped, never rewritten", async () => {
  const entry = await recoverDocument({
    documentId: 3,
    title: "valid-test",
    originalFilename: "valid-test.pdf",
    category: "title-only-or-near-empty",
    storedExtractionStatus: "completed",
    storedTextLength: 14,
    chunkCount: 0,
  });

  assert.equal(entry.result, "skipped");
  assert.match(entry.detail, /Not an N0 recovery target/);
});

test("stored text splits back into pages only when the count matches exactly", () => {
  const pages = rebuildPagesFromStoredText("page one\n\npage two\n\npage three", 3);

  assert.deepEqual(pages, [
    { pageNumber: 1, text: "page one" },
    { pageNumber: 2, text: "page two" },
    { pageNumber: 3, text: "page three" },
  ]);

  // A page that extracted to nothing was never stored, so the blocks no longer
  // line up with the recorded page count and every later page number would be
  // wrong. Refuse rather than mislabel citations.
  assert.equal(rebuildPagesFromStoredText("page one\n\npage two", 3), null);
  assert.equal(rebuildPagesFromStoredText("", 1), null);
  assert.equal(rebuildPagesFromStoredText("a\n\n\n\nb", 3), null);
});

test("verifyExtraction refuses a failed extraction", () => {
  const verdict = verifyExtraction(extraction({ extractionStatus: "failed: bad xref" }));

  assert.equal(verdict.ok, false);
  assert.equal(verdict.result, "failed");
});

test("verifyExtraction refuses an extraction with no pages", () => {
  const verdict = verifyExtraction(extraction({ pages: [] }));

  assert.equal(verdict.ok, false);
  assert.equal(verdict.result, "failed");
});

test("verifyExtraction refuses to write text below the image-only threshold", () => {
  const verdict = verifyExtraction(
    extraction({ extractedText: "tiny", pages: [{ pageNumber: 1, text: "tiny" }] })
  );

  assert.equal(verdict.ok, false);
  assert.equal(verdict.result, "needs-review");
  assert.match(verdict.detail, /image-only threshold/);
});

test("text appearing without OCR contradicts the diagnostic and is held back", () => {
  // The diagnostic saw no text layer, so text can only come from OCR. A plain
  // "completed" means something disagrees; do not silently write it.
  const verdict = verifyExtraction(extraction({ extractionStatus: "completed" }), {
    expectOcr: true,
  });

  assert.equal(verdict.ok, false);
  assert.equal(verdict.result, "needs-review");
  assert.match(verdict.detail, /disagreement/);
});

test("a thin OCR result is held back, not written", () => {
  // 80 characters clears the image-only floor but is far too little to trust as
  // a whole document. Writing it would report the document as recovered while
  // Ask embeds and cites a fraction of it.
  const text = "y".repeat(80);
  const verdict = verifyExtraction(
    extraction({ extractedText: text, pages: [{ pageNumber: 1, text }] }),
    { expectOcr: true }
  );

  assert.equal(verdict.ok, false, "a thin yield must not be persisted");
  assert.equal(verdict.result, "needs-review");
  assert.match(verdict.detail, /held back for review/);
});

test("only `recovered` may persist -- every other verdict blocks the write", () => {
  // The resume journal treats exactly `recovered` as done, so a verdict that
  // said "needs-review" while still writing would make an interrupted run
  // silently skip or rewrite documents. Pin the mapping over every branch.
  const thin = "y".repeat(80);
  const branches = [
    verifyExtraction(extraction({ extractionStatus: "failed: bad xref" })),
    verifyExtraction(extraction({ pages: [] })),
    verifyExtraction(
      extraction({ extractedText: "tiny", pages: [{ pageNumber: 1, text: "tiny" }] })
    ),
    verifyExtraction(extraction({ extractionStatus: "completed" }), { expectOcr: true }),
    verifyExtraction(extraction({ extractedText: thin, pages: [{ pageNumber: 1, text: thin }] }), {
      expectOcr: true,
    }),
    verifyExtraction(extraction(), { expectOcr: true }),
  ];

  for (const verdict of branches) {
    assert.equal(
      verdict.ok,
      verdict.result === "recovered",
      `verdict "${verdict.result}" must persist only when it is "recovered": ${verdict.detail}`
    );
  }

  assert.equal(
    branches.filter((verdict) => verdict.ok).length,
    1,
    "exactly one branch above is a genuine recovery"
  );
});

test("a substantive OCR result is accepted", () => {
  const verdict = verifyExtraction(extraction(), { expectOcr: true });

  assert.equal(verdict.ok, true);
  assert.equal(verdict.result, "recovered");
});

test("a dry run reports chunk counts without touching the database", async () => {
  const vehicleId = db.prepare("SELECT id FROM vehicles LIMIT 1").get()?.id;
  const inserted = db
    .prepare(`
      INSERT INTO documents (
        vehicle_id, title, original_filename, stored_filename, system,
        document_type, extracted_text, extraction_status, page_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      vehicleId,
      "dry run doc",
      "dry-run.pdf",
      "dry-run.pdf",
      "Imported Documents",
      "Repair Manual",
      "alpha beta gamma\n\ndelta epsilon zeta",
      "completed",
      2
    );
  const documentId = Number(inserted.lastInsertRowid);

  const entry = await recoverDocument(
    {
      documentId,
      title: "dry run doc",
      originalFilename: "dry-run.pdf",
      category: "text-present-no-chunks",
      storedExtractionStatus: "completed",
      storedTextLength: 36,
      storedPageCount: 2,
      chunkCount: 0,
      extractedText: "alpha beta gamma\n\ndelta epsilon zeta",
    },
    { apply: false }
  );

  assert.equal(entry.result, "recovered");
  assert.equal(entry.newChunkCount, 2);

  const chunkCount = db
    .prepare("SELECT COUNT(*) AS total FROM document_chunks WHERE document_id = ?")
    .get(documentId).total;

  assert.equal(chunkCount, 0, "dry run must not write chunks");
});

test("apply re-chunks from stored text through the production chunker", async () => {
  const vehicleId = db.prepare("SELECT id FROM vehicles LIMIT 1").get()?.id;
  const storedText = "alpha beta gamma\n\ndelta epsilon zeta";
  const inserted = db
    .prepare(`
      INSERT INTO documents (
        vehicle_id, title, original_filename, stored_filename, system,
        document_type, extracted_text, extraction_status, page_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      vehicleId,
      "apply doc",
      "apply.pdf",
      "apply.pdf",
      "Imported Documents",
      "Repair Manual",
      storedText,
      "completed",
      2
    );
  const documentId = Number(inserted.lastInsertRowid);

  const entry = await recoverDocument(
    {
      documentId,
      title: "apply doc",
      originalFilename: "apply.pdf",
      category: "text-present-no-chunks",
      storedExtractionStatus: "completed",
      storedTextLength: storedText.length,
      storedPageCount: 2,
      chunkCount: 0,
      extractedText: storedText,
    },
    { apply: true }
  );

  assert.equal(entry.result, "recovered");
  assert.equal(entry.newChunkCount, 2);

  const chunks = db
    .prepare(`
      SELECT page_number, chunk_index, chunk_text
      FROM document_chunks WHERE document_id = ?
      ORDER BY page_number, chunk_index
    `)
    .all(documentId);

  assert.equal(chunks.length, 2);
  assert.deepEqual(
    chunks.map((chunk) => [chunk.page_number, chunk.chunk_text]),
    [
      [1, "alpha beta gamma"],
      [2, "delta epsilon zeta"],
    ]
  );

  // The document's own text and metadata must be untouched by a re-chunk.
  const row = db
    .prepare("SELECT extracted_text, extraction_status, page_count FROM documents WHERE id = ?")
    .get(documentId);

  assert.equal(row.extracted_text, storedText);
  assert.equal(row.extraction_status, "completed");
  assert.equal(row.page_count, 2);
});

test("a needs-review document is left completely untouched, even under --apply", async () => {
  const vehicleId = db.prepare("SELECT id FROM vehicles LIMIT 1").get()?.id;
  // page_count 5 but only two stored blocks: page numbers cannot be rebuilt, so
  // this must come back needs-review with nothing written.
  const storedText = "alpha beta gamma\n\ndelta epsilon zeta";
  const inserted = db
    .prepare(`
      INSERT INTO documents (
        vehicle_id, title, original_filename, stored_filename, system,
        document_type, extracted_text, extraction_status, page_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      vehicleId,
      "mismatched doc",
      "mismatch.pdf",
      "mismatch.pdf",
      "Imported Documents",
      "Repair Manual",
      storedText,
      "completed",
      5
    );
  const documentId = Number(inserted.lastInsertRowid);
  const chunksBefore = db.prepare("SELECT COUNT(*) AS total FROM document_chunks").get().total;

  const entry = await recoverDocument(
    {
      documentId,
      title: "mismatched doc",
      originalFilename: "mismatch.pdf",
      category: "text-present-no-chunks",
      storedExtractionStatus: "completed",
      storedTextLength: storedText.length,
      storedPageCount: 5,
      chunkCount: 0,
      extractedText: storedText,
    },
    { apply: true }
  );

  assert.equal(entry.result, "needs-review");

  const row = db
    .prepare("SELECT extracted_text, extraction_status, page_count FROM documents WHERE id = ?")
    .get(documentId);

  assert.equal(row.extracted_text, storedText, "text must be untouched");
  assert.equal(row.extraction_status, "completed", "status must be untouched");
  assert.equal(row.page_count, 5, "page count must be untouched");
  assert.equal(
    db.prepare("SELECT COUNT(*) AS total FROM document_chunks WHERE document_id = ?").get(documentId)
      .total,
    0,
    "needs-review must create no chunks"
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS total FROM document_chunks").get().total,
    chunksBefore,
    "no other document's chunks may change either"
  );
});

// --- the pre-persistence chunkability gate ---------------------------------
//
// Verification proves an extraction carries enough text; it does not prove that
// text will chunk. Everything below covers that gap: an extraction that passes
// verification but produces no chunks must come back `failed` with the document
// exactly as it was, because the alternative is a `failed` label describing a
// document recovery had already overwritten.

/** An OCR candidate with a real file on disk for the extractor to be handed. */
function insertOcrCandidate(title) {
  const vehicleId = db.prepare("SELECT id FROM vehicles LIMIT 1").get()?.id;
  const storedFilename = `${title.replace(/\W+/g, "-")}.pdf`;

  fs.mkdirSync(process.env.UPLOADS_DIR, { recursive: true });
  fs.writeFileSync(path.join(process.env.UPLOADS_DIR, storedFilename), "stand-in bytes");

  const inserted = db
    .prepare(`
      INSERT INTO documents (
        vehicle_id, title, original_filename, stored_filename, system,
        document_type, extracted_text, extraction_status, page_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      vehicleId,
      title,
      `${storedFilename}`,
      storedFilename,
      "Imported Documents",
      "Repair Manual",
      "",
      "no_text_found",
      3
    );

  return {
    documentId: Number(inserted.lastInsertRowid),
    candidate: {
      documentId: Number(inserted.lastInsertRowid),
      title,
      originalFilename: storedFilename,
      storedFilename,
      filePath: storedFilename,
      category: "ocr-candidate",
      storedExtractionStatus: "no_text_found",
      storedTextLength: 0,
      storedPageCount: 3,
      textLayerCharacters: 0,
      chunkCount: 0,
    },
  };
}

/** Verifies (500 characters, OCR status, one page) but chunks to nothing. */
const CHUNKS_TO_NOTHING = {
  extractedText: "x".repeat(500),
  extractionStatus: "completed_with_ocr",
  pageCount: 1,
  pages: [{ pageNumber: 1, text: "   " }],
  ocrWarnings: [],
};

function snapshotDocument(documentId) {
  return db
    .prepare(`
      SELECT title, extracted_text, extraction_status, page_count, updated_at
      FROM documents WHERE id = ?
    `)
    .get(documentId);
}

test("an extraction that verifies but chunks to nothing writes nothing under --apply", async () => {
  const { documentId, candidate } = insertOcrCandidate("chunks to nothing");
  const before = snapshotDocument(documentId);
  const globalChunksBefore = db
    .prepare("SELECT COUNT(*) AS total FROM document_chunks")
    .get().total;

  // The verdict itself passes -- this is precisely the case the old code let
  // through to persistence and only then labelled `failed`.
  assert.equal(verifyExtraction(CHUNKS_TO_NOTHING, { expectOcr: true }).ok, true);

  const entry = await recoverDocument(candidate, {
    apply: true,
    extractPdf: async () => CHUNKS_TO_NOTHING,
  });

  assert.equal(entry.result, "failed");
  assert.notEqual(entry.result, "recovered");

  assert.deepEqual(
    snapshotDocument(documentId),
    before,
    "text, status, page count and metadata must all be untouched"
  );
  assert.equal(
    db
      .prepare("SELECT COUNT(*) AS total FROM document_chunks WHERE document_id = ?")
      .get(documentId).total,
    0,
    "a failed recovery must create no chunks"
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS total FROM document_chunks").get().total,
    globalChunksBefore,
    "no other document's chunks may change either"
  );
});

test("pages the production chunker rejects are caught before the write too", async () => {
  const { documentId, candidate } = insertOcrCandidate("unusable page numbers");
  const before = snapshotDocument(documentId);
  // Real words, but page 0 is not a page the chunker will accept, so the
  // document would end up with text and still no chunks.
  const unusablePages = {
    ...CHUNKS_TO_NOTHING,
    pages: [{ pageNumber: 0, text: "brake actuator assembly torque specification" }],
  };

  assert.equal(verifyExtraction(unusablePages, { expectOcr: true }).ok, true);

  const entry = await recoverDocument(candidate, {
    apply: true,
    extractPdf: async () => unusablePages,
  });

  assert.equal(entry.result, "failed");
  assert.deepEqual(snapshotDocument(documentId), before, "document must be untouched");
  assert.equal(
    db
      .prepare("SELECT COUNT(*) AS total FROM document_chunks WHERE document_id = ?")
      .get(documentId).total,
    0
  );
});

test("the chunkability gate reports the same verdict on a dry run", async () => {
  const { documentId, candidate } = insertOcrCandidate("dry run chunks to nothing");
  const before = snapshotDocument(documentId);

  const entry = await recoverDocument(candidate, {
    apply: false,
    extractPdf: async () => CHUNKS_TO_NOTHING,
  });

  assert.equal(entry.result, "failed");
  assert.deepEqual(snapshotDocument(documentId), before);
});

test("a chunk-gate failure stays retryable in the journal, never complete", async () => {
  const { documentId, candidate } = insertOcrCandidate("gate failure journal");
  const entry = await recoverDocument(candidate, {
    apply: true,
    extractPdf: async () => CHUNKS_TO_NOTHING,
  });

  const progress = { entries: { [String(documentId)]: { result: entry.result } } };

  assert.equal(entry.result, "failed");
  assert.equal(
    isAlreadyComplete(progress, documentId),
    false,
    "only `recovered` may count as complete, so this must be retried"
  );
});

test("a chunkable OCR extraction still persists normally under --apply", async () => {
  const { documentId, candidate } = insertOcrCandidate("normal ocr recovery");
  const globalChunksBefore = db
    .prepare("SELECT COUNT(*) AS total FROM document_chunks")
    .get().total;
  const good = {
    extractedText: "brake actuator assembly ".repeat(30),
    extractionStatus: "completed_with_ocr",
    pageCount: 2,
    pages: [
      { pageNumber: 1, text: "brake actuator assembly torque specification" },
      { pageNumber: 2, text: "connector A51 signal CANH ground" },
    ],
    ocrWarnings: [],
  };

  const entry = await recoverDocument(candidate, {
    apply: true,
    extractPdf: async () => good,
  });

  assert.equal(entry.result, "recovered");
  assert.equal(entry.newChunkCount, 2);

  const row = snapshotDocument(documentId);
  assert.equal(row.extracted_text, good.extractedText, "text must be written");
  assert.equal(row.extraction_status, "completed_with_ocr");
  assert.equal(row.page_count, 2);
  assert.equal(
    db
      .prepare("SELECT COUNT(*) AS total FROM document_chunks WHERE document_id = ?")
      .get(documentId).total,
    2,
    "a recovered document must gain its chunks"
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS total FROM document_chunks").get().total,
    globalChunksBefore + 2
  );
});

test("a dry run reports the production chunker's real count, not an estimate", async () => {
  const { documentId, candidate } = insertOcrCandidate("dry run real count");
  const before = snapshotDocument(documentId);
  const good = {
    extractedText: "word ".repeat(500),
    extractionStatus: "completed_with_ocr",
    pageCount: 2,
    pages: [
      { pageNumber: 1, text: Array(360).fill("alpha").join(" ") },
      { pageNumber: 2, text: "beta gamma delta" },
    ],
    ocrWarnings: [],
  };

  const entry = await recoverDocument(candidate, {
    apply: false,
    extractPdf: async () => good,
  });

  assert.equal(entry.result, "recovered");
  assert.equal(
    entry.newChunkCount,
    buildChunksFromPages(good.pages).length,
    "the dry-run count is the chunker's own count"
  );
  assert.deepEqual(snapshotDocument(documentId), before, "a dry run still writes nothing");
});

test("readCorpusHealth reports the counters the run compares before and after", () => {
  const health = readCorpusHealth(db);

  for (const field of [
    "totalDocuments",
    "documentsWithChunks",
    "zeroChunkDocuments",
    "totalChunks",
    "completedWithOcrDocuments",
    "ocrWarningDocuments",
    "extractionFailedDocuments",
    "chunksMissingCurrentEmbedding",
  ]) {
    assert.equal(typeof health[field], "number", field);
  }

  assert.equal(
    health.documentsWithChunks + health.zeroChunkDocuments,
    health.totalDocuments
  );
});

test("the progress journal only treats a recovered document as complete", async () => {
  const progressFile = resolveProgressFile(tempRoot);

  await writeProgress(progressFile, {
    entries: {
      9: { result: "recovered" },
      10: { result: "failed" },
      11: { result: "needs-review" },
    },
  });

  const progress = await readProgress(progressFile);

  assert.equal(isAlreadyComplete(progress, 9), true);
  // Failures and review cases wrote nothing, so a resume must retry them.
  assert.equal(isAlreadyComplete(progress, 10), false);
  assert.equal(isAlreadyComplete(progress, 11), false);
  assert.equal(isAlreadyComplete(progress, 999), false);
});

test("a missing or corrupt journal resumes from scratch instead of throwing", async () => {
  const missing = await readProgress(path.join(tempRoot, "nope.json"));
  assert.deepEqual(missing.entries, {});

  const corruptPath = path.join(tempRoot, "corrupt.json");
  fs.writeFileSync(corruptPath, "{not json");
  const corrupt = await readProgress(corruptPath);
  assert.deepEqual(corrupt.entries, {});
});

// The chunk count a dry run reports is now the production chunker's own count,
// not an approximation of it, so there is no separate estimator to keep in step.

test("summarizeEntries counts each result bucket", () => {
  assert.deepEqual(
    summarizeEntries([
      { result: "recovered" },
      { result: "recovered" },
      { result: "failed" },
      { result: "needs-review" },
      { result: "skipped" },
      { result: "bogus" },
    ]),
    { recovered: 2, skipped: 1, failed: 1, "needs-review": 1 }
  );
});
