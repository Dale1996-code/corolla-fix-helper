import assert from "node:assert/strict";
import test from "node:test";

const {
  DEFAULT_MEANINGFUL_TEXT_CHARACTERS,
  ZERO_CHUNK_CATEGORIES,
  classifyZeroChunkDocument,
  countTextCharacters,
  summarizeClassifications,
} = await import("../src/services/zeroChunkDiagnostics.js");

// A file that reads and parses cleanly, with nothing on the pages. Individual
// cases override only the evidence they are actually about.
function evidence(overrides = {}) {
  return {
    storedExtractionStatus: "no_text_found",
    storedTextCharacters: 0,
    fileFound: true,
    fileBytes: 4096,
    fileError: null,
    parseError: null,
    inspectedPageCount: 1,
    textLayerCharacters: 0,
    pagesWithImages: 0,
    vectorOperations: 0,
    ocrProbe: null,
    ...overrides,
  };
}

test("countTextCharacters ignores whitespace", () => {
  assert.equal(countTextCharacters("Alarm Module"), 11);
  assert.equal(countTextCharacters("  \n\t "), 0);
  assert.equal(countTextCharacters(null), 0);
});

test("a missing stored file is reported as missing, not as an empty document", () => {
  const result = classifyZeroChunkDocument(evidence({ fileFound: false }));

  assert.equal(result.category, "malformed-or-missing-file");
  assert.match(result.reason, /missing from the uploads folder/i);
});

test("an unparseable or zero-page file is malformed", () => {
  assert.equal(
    classifyZeroChunkDocument(evidence({ parseError: "bad xref" })).category,
    "malformed-or-missing-file"
  );
  assert.equal(
    classifyZeroChunkDocument(evidence({ fileBytes: 0 })).category,
    "malformed-or-missing-file"
  );
  assert.equal(
    classifyZeroChunkDocument(evidence({ inspectedPageCount: 0 })).category,
    "malformed-or-missing-file"
  );
});

test("stored text with no chunks is a pipeline gap, not a bad document", () => {
  const result = classifyZeroChunkDocument(
    evidence({ storedExtractionStatus: "completed", storedTextCharacters: 48073 })
  );

  assert.equal(result.category, "text-present-no-chunks");
  assert.match(result.reason, /chunking never ran/i);
});

test("a text layer the stored row missed is an extraction error", () => {
  const result = classifyZeroChunkDocument(
    evidence({ textLayerCharacters: 5000, pagesWithImages: 1 })
  );

  assert.equal(result.category, "extraction-error");
  assert.match(result.reason, /under-read/i);
});

test("a recorded hard failure on a file that parses now is an extraction error", () => {
  const result = classifyZeroChunkDocument(
    evidence({ storedExtractionStatus: "failed: Page dictionary kid reference" })
  );

  assert.equal(result.category, "extraction-error");
  assert.match(result.reason, /parses now/i);
});

test("images with no text layer are an OCR candidate, flagged unconfirmed", () => {
  const result = classifyZeroChunkDocument(
    evidence({ pagesWithImages: 8, inspectedPageCount: 8 })
  );

  assert.equal(result.category, "ocr-candidate");
  assert.match(result.reason, /unconfirmed/i);
});

test("no_text_found alone never implies OCR failure - the page content decides", () => {
  // Same stored status, three different verdicts. This is the trap the module exists for.
  const blank = classifyZeroChunkDocument(evidence());
  const scanned = classifyZeroChunkDocument(evidence({ pagesWithImages: 3, inspectedPageCount: 3 }));
  const titleOnly = classifyZeroChunkDocument(evidence({ textLayerCharacters: 11 }));

  assert.equal(blank.category, "title-only-or-near-empty");
  assert.equal(scanned.category, "ocr-candidate");
  assert.equal(titleOnly.category, "title-only-or-near-empty");
});

test("an OCR probe that reads real text confirms the OCR candidate", () => {
  const result = classifyZeroChunkDocument(
    evidence({
      pagesWithImages: 4,
      inspectedPageCount: 4,
      ocrProbe: { pageNumber: 2, characters: 1842, sampleText: "TORQUE 25 Nm", error: null },
    })
  );

  assert.equal(result.category, "ocr-candidate");
  assert.match(result.reason, /1842 characters/);
  assert.doesNotMatch(result.reason, /unconfirmed/i);
});

test("the Alarm_Module case: an image page whose OCR yields only a title is near-empty", () => {
  // Verified by hand: one page, 300 DPI render shows only "Alarm Module",
  // Tesseract 5.4.0 returns the same. An image on the page is NOT evidence of a
  // failed OCR run when OCR itself reports the page is near-empty.
  const result = classifyZeroChunkDocument(
    evidence({
      pagesWithImages: 1,
      ocrProbe: { pageNumber: 1, characters: 11, sampleText: "Alarm Module", error: null },
    })
  );

  assert.equal(result.category, "title-only-or-near-empty");
  assert.match(result.reason, /Alarm Module/);
});

test("graphics that yield no OCR text need manual review rather than a guess", () => {
  const result = classifyZeroChunkDocument(
    evidence({
      pagesWithImages: 2,
      inspectedPageCount: 2,
      ocrProbe: { pageNumber: 1, characters: 0, sampleText: "", error: null },
    })
  );

  assert.equal(result.category, "unknown-manual-review");
  assert.match(result.reason, /text-free diagram/i);
});

test("a failed OCR probe proves nothing and stays unknown", () => {
  const result = classifyZeroChunkDocument(
    evidence({
      pagesWithImages: 2,
      ocrProbe: { pageNumber: 1, characters: 0, sampleText: "", error: "tesseract missing" },
    })
  );

  assert.equal(result.category, "unknown-manual-review");
  assert.match(result.reason, /recoverability unproven/i);
});

test("vector-only pages are not silently called blank", () => {
  const result = classifyZeroChunkDocument(evidence({ vectorOperations: 240 }));

  assert.equal(result.category, "unknown-manual-review");
});

test("the meaningful-text threshold is configurable and defaults to the extractor's", () => {
  const nearlyEmpty = evidence({
    storedExtractionStatus: "completed",
    storedTextCharacters: 14,
  });

  assert.equal(DEFAULT_MEANINGFUL_TEXT_CHARACTERS, 20);
  assert.equal(classifyZeroChunkDocument(nearlyEmpty).category, "title-only-or-near-empty");
  assert.equal(
    classifyZeroChunkDocument(nearlyEmpty, { meaningfulTextCharacters: 10 }).category,
    "text-present-no-chunks"
  );
});

test("every classification returns a known category with a reason", () => {
  const cases = [
    evidence({ fileFound: false }),
    evidence({ storedTextCharacters: 500 }),
    evidence({ pagesWithImages: 1 }),
    evidence({ vectorOperations: 5 }),
    evidence(),
  ];

  for (const testCase of cases) {
    const result = classifyZeroChunkDocument(testCase);

    assert.ok(ZERO_CHUNK_CATEGORIES.includes(result.category), result.category);
    assert.ok(result.reason.length > 0);
  }
});

test("summarizeClassifications counts and omits empty categories", () => {
  const summary = summarizeClassifications([
    { category: "ocr-candidate" },
    { category: "ocr-candidate" },
    { category: "ocr-candidate" },
    { category: "title-only-or-near-empty" },
  ]);

  assert.deepEqual(
    summary.map((entry) => [entry.category, entry.count, entry.percentage]),
    [
      ["ocr-candidate", 3, 75],
      ["title-only-or-near-empty", 1, 25],
    ]
  );
});
