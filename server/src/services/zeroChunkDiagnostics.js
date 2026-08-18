// Classification rules for documents that hold zero `document_chunks`.
//
// A chunk-less document is invisible to Ask: `chunkRetrievalService` ranks
// chunks, so a document with none can never be retrieved no matter how good
// its PDF is. This module answers "why is this one empty?" from evidence, and
// deliberately keeps two things apart:
//
//   A. what the database currently stores (extraction_status, extracted_text)
//   B. what inspecting the source PDF right now actually shows
//
// They disagree more often than you would expect. `extraction_status` is a
// snapshot of one past run under whatever tools were installed that day, so it
// is a hint, never proof. Two concrete traps this module refuses to fall into:
//
//   - `no_text_found` does NOT mean "OCR failed" and does not even mean "no
//     text". The bulk importer rewrites `completed` to `no_text_found` whenever
//     extraction yields fewer than IMAGE_ONLY_TEXT_CHARACTER_LIMIT characters,
//     so a genuinely title-only page lands in the same bucket as a scanned one.
//   - `completed_with_ocr` does NOT mean OCR recovered anything useful. The
//     extractor sets it whenever OCR contributed any text at all.
//
// So recoverability is decided by looking at the file: does it carry a text
// layer, raster images, or nothing? An optional OCR probe upgrades a structural
// guess ("has images, might hold text") into a measured fact ("OCR read 1,842
// characters"). When the evidence does not settle it, the answer is
// `unknown-manual-review` rather than a guess.
//
// Pure module: no database, no filesystem. The caller gathers evidence; this
// decides what it means, which is what makes the rules testable.

/** Character count ignoring whitespace, matching how the extractor measures text. */
export function countTextCharacters(text) {
  return typeof text === "string" ? text.replace(/\s+/g, "").length : 0;
}

// Mirrors OCR_MIN_TEXT_CHARACTERS / the importer's IMAGE_ONLY_TEXT_CHARACTER_LIMIT:
// below this a page is treated as carrying no usable text.
export const DEFAULT_MEANINGFUL_TEXT_CHARACTERS = 20;

export const ZERO_CHUNK_CATEGORIES = [
  "text-present-no-chunks",
  "extraction-error",
  "malformed-or-missing-file",
  "ocr-candidate",
  "title-only-or-near-empty",
  "unknown-manual-review",
];

export const ZERO_CHUNK_CATEGORY_LABELS = {
  "text-present-no-chunks": "Meaningful stored text but no chunks",
  "extraction-error": "Extraction failure or error",
  "malformed-or-missing-file": "Malformed, unreadable, or missing source file",
  "ocr-candidate": "Image/scanned document that may benefit from OCR",
  "title-only-or-near-empty": "Title-only or nearly empty source document",
  "unknown-manual-review": "Unknown - manual review required",
};

function isHardFailureStatus(status) {
  return String(status || "").startsWith("failed:");
}

function isOcrGapStatus(status) {
  const normalizedStatus = String(status || "");

  return (
    normalizedStatus.startsWith("ocr_unavailable:") ||
    normalizedStatus.startsWith("ocr_failed:")
  );
}

function describeGraphics({ pagesWithImages, inspectedPageCount, vectorOperations }) {
  if (pagesWithImages > 0) {
    return `${pagesWithImages}/${inspectedPageCount} pages carry raster images`;
  }

  if (vectorOperations > 0) {
    return `no raster images but ${vectorOperations} vector drawing operations`;
  }

  return "no raster images and no vector drawing operations";
}

/**
 * Decide why one document has no chunks.
 *
 * @param {object} evidence  Merged stored + inspected evidence for one document.
 * @param {object} [options]
 * @param {number} [options.meaningfulTextCharacters]
 * @returns {{ category: string, reason: string }}
 */
export function classifyZeroChunkDocument(evidence = {}, options = {}) {
  const minimumCharacters =
    Number(options.meaningfulTextCharacters) || DEFAULT_MEANINGFUL_TEXT_CHARACTERS;

  const {
    storedExtractionStatus = "",
    storedTextCharacters = 0,
    fileFound = false,
    fileBytes = 0,
    fileError = null,
    parseError = null,
    inspectedPageCount = 0,
    textLayerCharacters = 0,
    pagesWithImages = 0,
    vectorOperations = 0,
    ocrProbe = null,
  } = evidence;

  // 5. The file itself cannot be used. Nothing downstream can be trusted.
  if (!fileFound) {
    return {
      category: "malformed-or-missing-file",
      reason: "Stored PDF is missing from the uploads folder.",
    };
  }

  if (fileError) {
    return {
      category: "malformed-or-missing-file",
      reason: `Stored PDF could not be read: ${fileError}`,
    };
  }

  if (fileBytes === 0) {
    return {
      category: "malformed-or-missing-file",
      reason: "Stored PDF is a zero-byte file.",
    };
  }

  if (parseError) {
    return {
      category: "malformed-or-missing-file",
      reason: `Stored PDF does not parse: ${parseError}`,
    };
  }

  if (inspectedPageCount === 0) {
    return {
      category: "malformed-or-missing-file",
      reason: "Stored PDF parses but reports zero pages.",
    };
  }

  // 4. Text survived into the row but never became chunks. This is the only
  // category that indicates a pipeline gap rather than a bad source document.
  if (storedTextCharacters >= minimumCharacters) {
    return {
      category: "text-present-no-chunks",
      reason:
        `Row stores ${storedTextCharacters} text characters yet has no chunks; ` +
        "chunking never ran for this document.",
    };
  }

  // The file has real text the stored row does not. Re-extraction recovers it
  // without any OCR at all.
  if (textLayerCharacters >= minimumCharacters) {
    return {
      category: "extraction-error",
      reason:
        `Source PDF has a ${textLayerCharacters}-character text layer but the row ` +
        `stored only ${storedTextCharacters}; extraction under-read this file.`,
    };
  }

  // 3. A recorded hard failure, on a file that parses now.
  if (isHardFailureStatus(storedExtractionStatus)) {
    return {
      category: "extraction-error",
      reason:
        `Stored status is "${storedExtractionStatus}" but the file parses now ` +
        `(${inspectedPageCount} pages, ${describeGraphics({ pagesWithImages, inspectedPageCount, vectorOperations })}).`,
    };
  }

  const graphics = describeGraphics({
    pagesWithImages,
    inspectedPageCount,
    vectorOperations,
  });
  const ocrGapNote = isOcrGapStatus(storedExtractionStatus)
    ? ` Stored status "${storedExtractionStatus}" shows OCR did not run.`
    : "";

  // A measured OCR result beats every structural guess below.
  if (ocrProbe) {
    if (ocrProbe.error) {
      return {
        category: "unknown-manual-review",
        reason: `OCR probe failed (${ocrProbe.error}); recoverability unproven. ${graphics}.`,
      };
    }

    const probedCharacters = Number(ocrProbe.characters) || 0;

    if (probedCharacters >= minimumCharacters) {
      return {
        category: "ocr-candidate",
        reason:
          `OCR probe read ${probedCharacters} characters from page ` +
          `${ocrProbe.pageNumber}; text layer is empty and ${graphics}.${ocrGapNote}`,
      };
    }

    if (probedCharacters > 0) {
      return {
        category: "title-only-or-near-empty",
        reason:
          `OCR probe read only ${probedCharacters} characters ("${ocrProbe.sampleText}") ` +
          `from page ${ocrProbe.pageNumber}; the page really is near-empty.`,
      };
    }

    if (pagesWithImages > 0 || vectorOperations > 0) {
      return {
        category: "unknown-manual-review",
        reason:
          `OCR probe read no characters from page ${ocrProbe.pageNumber} even though ` +
          `${graphics}; may be a text-free diagram rather than a recoverable scan.`,
      };
    }

    return {
      category: "title-only-or-near-empty",
      reason: `OCR probe read no characters and ${graphics}; the page is blank.`,
    };
  }

  // 2. Structural-only signal: images with no text layer usually means a scan.
  // Flagged as unconfirmed because only an OCR probe can prove text is there.
  if (pagesWithImages > 0) {
    return {
      category: "ocr-candidate",
      reason:
        `Text layer holds ${textLayerCharacters} characters while ${graphics} ` +
        `(unconfirmed - no OCR probe run).${ocrGapNote}`,
    };
  }

  // 1. Some text, no images: what the manually-verified Alarm_Module page looks
  // like - a title and nothing else.
  if (textLayerCharacters > 0) {
    return {
      category: "title-only-or-near-empty",
      reason:
        `Text layer holds only ${textLayerCharacters} characters and ${graphics}; ` +
        "the source document is near-empty.",
    };
  }

  if (vectorOperations > 0) {
    return {
      category: "unknown-manual-review",
      reason:
        `No text layer and ${graphics}; vector-only content cannot be classified ` +
        "without an OCR probe.",
    };
  }

  return {
    category: "title-only-or-near-empty",
    reason: `No text layer and ${graphics}; the pages are blank.`,
  };
}

/**
 * Aggregate classified rows into counts and percentages per category.
 * Categories that matched nothing are omitted so the summary stays readable.
 */
export function summarizeClassifications(rows = []) {
  const total = rows.length;
  const counts = new Map();

  for (const row of rows) {
    const category = row?.category || "unknown-manual-review";
    counts.set(category, (counts.get(category) || 0) + 1);
  }

  return ZERO_CHUNK_CATEGORIES.filter((category) => counts.has(category)).map(
    (category) => {
      const count = counts.get(category);

      return {
        category,
        label: ZERO_CHUNK_CATEGORY_LABELS[category],
        count,
        percentage: total ? Math.round((count / total) * 1000) / 10 : 0,
      };
    }
  );
}
