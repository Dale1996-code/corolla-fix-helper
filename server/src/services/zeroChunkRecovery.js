// N0 recovery: turn zero-chunk documents back into retrievable ones.
//
// A document with no `document_chunks` is invisible to Ask no matter how good
// its PDF is. `zeroChunkDiagnostics.js` says WHY each one is empty; this module
// acts on that verdict, and only on the two verdicts that are actually
// recoverable:
//
//   text-present-no-chunks -> re-chunk from the text already in the row.
//                             No PDF read, no OCR: the text is already correct,
//                             chunking simply never ran for it.
//   ocr-candidate          -> re-extract the PDF through the production
//                             extractor with OCR enabled, then chunk.
//
// Everything else (title-only fixtures, malformed files, unknown) is skipped
// rather than "fixed". Those are not N0 documents and quietly rewriting them
// would destroy the evidence the diagnostic collected.
//
// Nothing here re-implements extraction or chunking. `extractPdfData` and
// `persistExtractionResult` / `rebuildDocumentChunksFromPages` are the same
// functions the upload and re-extract routes use. What this module adds is the
// part a batch needs and a single upload does not: a verification gate that
// runs BEFORE anything is written, so a failed or empty OCR pass can never
// overwrite a document with something worse than it already had.
//
// RESULT CONTRACT -- one result label, one persistence outcome, no exceptions:
//
//   recovered    -> the document was written (text, status, page count, chunks)
//   needs-review -> NOTHING was written; a human decides
//   failed       -> NOTHING was written
//   skipped      -> NOTHING was written; not an N0 target at all
//
// Only `recovered` touches the database. This is load-bearing for the resume
// journal: `isAlreadyComplete` treats exactly `recovered` as done, so any label
// that could also mean "written" would make an interrupted run either skip a
// document it never finished or rewrite one it did. An earlier revision let a
// thin-but-valid OCR yield persist while still reporting `needs-review`, which
// broke that mapping -- `verifyExtraction` must therefore never return
// `ok: true` alongside any result other than `recovered`, and a test pins it.
//
// Passing verification is necessary but not sufficient: text long enough to
// verify can still chunk to nothing when a document's page list disagrees with
// its joined text. So both strategies run the production chunker
// (`buildChunksFromPages`, the same pure function the persistent rebuild uses
// internally) over the pages BEFORE any write, and bail out with `failed` while
// the document is still untouched. Deciding after the write is what would let a
// `failed` label describe a document this module had already emptied. The
// chunking cost is paid twice on the success path, deliberately: reusing the
// production chunker is worth more than saving one in-memory pass, and it means
// a dry run reports the real chunk count rather than an approximation.

import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import {
  persistExtractionResult,
  resolveStoredFilePath,
} from "./documentService.js";
import {
  buildChunksFromPages,
  rebuildDocumentChunksFromPages,
} from "./documentChunkService.js";
import { extractPdfData } from "./pdfService.js";
import { countTextCharacters } from "./zeroChunkDiagnostics.js";

/** Diagnostic verdicts this module will act on, and how. */
export const RECOVERY_STRATEGIES = {
  "text-present-no-chunks": "rechunk-from-stored-text",
  "ocr-candidate": "ocr-reextract",
};

// Below this a recovered document is not worth calling recovered -- it is the
// same threshold the importer uses to decide a PDF is image-only, so clearing
// it is the minimum bar for "this document now has text".
const MINIMUM_RECOVERED_CHARACTERS = config.ocrMinTextCharacters;

// Above the hard floor but below this, the yield is too thin to assume the
// whole document came through, so it is held back rather than written. Partial
// text written over an empty document is the worse outcome: the corpus then
// reports the document as recovered, and Ask will embed and cite a fraction of
// it as though it were the whole thing.
const CONFIDENT_RECOVERY_CHARACTERS = 200;

export function selectRecoveryStrategy(category) {
  return RECOVERY_STRATEGIES[category] || null;
}

/**
 * Rebuild the page list from a document's stored `extracted_text`.
 *
 * `extractPdfData` joins page texts with a blank line and normalizes each page's
 * whitespace to single spaces, so a blank line can only ever be a page break.
 * That makes the split lossless -- but only when the number of blocks matches
 * the recorded page count, because pages that extracted to nothing were never
 * added to the list and would silently shift every page number after them.
 * A mismatch returns null so the caller skips rather than mislabels citations.
 */
export function rebuildPagesFromStoredText(extractedText, pageCount) {
  const text = typeof extractedText === "string" ? extractedText : "";
  const blocks = text.split("\n\n").map((block) => block.trim());

  if (!blocks.length || blocks.some((block) => !block)) {
    return null;
  }

  if (!Number.isInteger(pageCount) || blocks.length !== pageCount) {
    return null;
  }

  return blocks.map((block, index) => ({ pageNumber: index + 1, text: block }));
}

/**
 * Decide whether an extraction result is safe to write over a document.
 *
 * `expectOcr` is true when the diagnostic found no text layer at all: any text
 * in the result can then only have come from OCR, so a status that does not say
 * OCR ran contradicts the diagnostic and is held back for review instead of
 * being written silently.
 */
export function verifyExtraction(extractionResult, { expectOcr = false } = {}) {
  const status = String(extractionResult?.extractionStatus || "");
  const characters = countTextCharacters(extractionResult?.extractedText);
  const pages = Array.isArray(extractionResult?.pages) ? extractionResult.pages : [];

  if (status.startsWith("failed:")) {
    return { ok: false, result: "failed", detail: `Extraction failed: ${status}` };
  }

  if (!pages.length) {
    return { ok: false, result: "failed", detail: "Extraction produced no pages." };
  }

  if (characters < MINIMUM_RECOVERED_CHARACTERS) {
    return {
      ok: false,
      result: "needs-review",
      detail:
        `Extraction produced only ${characters} characters ` +
        `(under the ${MINIMUM_RECOVERED_CHARACTERS}-character image-only threshold).`,
    };
  }

  if (expectOcr && !status.startsWith("completed_with_ocr")) {
    return {
      ok: false,
      result: "needs-review",
      detail:
        `Expected OCR to supply the text but status is "${status}"; ` +
        "the diagnostic saw no text layer, so this disagreement needs a look.",
    };
  }

  if (characters < CONFIDENT_RECOVERY_CHARACTERS) {
    return {
      ok: false,
      result: "needs-review",
      detail:
        `Only ${characters} characters recovered, under the ` +
        `${CONFIDENT_RECOVERY_CHARACTERS}-character confidence bar; held back for review.`,
    };
  }

  return { ok: true, result: "recovered", detail: "" };
}

function baseEntry(document, strategy) {
  return {
    documentId: document.documentId,
    title: document.title,
    originalFilename: document.originalFilename,
    strategy,
    previousStatus: document.storedExtractionStatus,
    previousTextLength: document.storedTextLength,
    previousChunkCount: document.chunkCount,
    newStatus: null,
    newTextLength: null,
    newChunkCount: null,
    ocrWarnings: [],
    durationMs: 0,
    result: "skipped",
    detail: "",
  };
}

/**
 * Recover one document. `apply: false` performs every read and check but writes
 * nothing, so a dry run exercises the same decisions the real run will make.
 *
 * `extractPdf` follows the project's injection convention so the verification
 * and persistence decisions can be tested against a chosen extraction result
 * without a fixture PDF for every case. Production always passes the real
 * extractor.
 *
 * @param {object} document  One entry from the diagnostic report.
 * @param {{ apply?: boolean, now?: () => number, extractPdf?: typeof extractPdfData }} [options]
 */
export async function recoverDocument(document, options = {}) {
  const {
    apply = false,
    now = () => performance.now(),
    extractPdf = extractPdfData,
  } = options;
  const startedAt = now();
  const strategy = selectRecoveryStrategy(document.category);
  const entry = baseEntry(document, strategy);

  if (!strategy) {
    entry.result = "skipped";
    entry.detail = `Not an N0 recovery target (${document.category}).`;
    entry.durationMs = Math.round(now() - startedAt);
    return entry;
  }

  try {
    if (strategy === "rechunk-from-stored-text") {
      const pages = rebuildPagesFromStoredText(
        document.extractedText,
        document.storedPageCount
      );

      if (!pages) {
        entry.result = "needs-review";
        entry.detail =
          "Stored text does not split cleanly into the recorded page count, " +
          "so page numbers cannot be reconstructed safely.";
        entry.durationMs = Math.round(now() - startedAt);
        return entry;
      }

      entry.newStatus = document.storedExtractionStatus;
      entry.newTextLength = document.storedTextLength;

      // Chunk in memory with the production chunker BEFORE writing. A rebuild
      // that would produce nothing has to be caught here, while the document is
      // still untouched -- deciding afterwards would mean labelling a document
      // `failed` that this function had already emptied.
      const plannedChunks = buildChunksFromPages(pages);

      if (!plannedChunks.length) {
        entry.result = "failed";
        entry.detail = "Stored text produced no chunks.";
        entry.newChunkCount = document.chunkCount;
        entry.durationMs = Math.round(now() - startedAt);
        return entry;
      }

      if (apply) {
        const summary = rebuildDocumentChunksFromPages(document.documentId, pages);
        entry.newChunkCount = summary.chunkCount;
      } else {
        entry.newChunkCount = plannedChunks.length;
      }

      entry.result = "recovered";
      entry.detail = `Re-chunked ${pages.length} pages from stored text; no OCR, text unchanged.`;
      entry.durationMs = Math.round(now() - startedAt);
      return entry;
    }

    // ocr-reextract
    const location = resolveStoredFilePath({
      stored_filename: document.storedFilename,
      file_path: document.filePath,
    });

    if (!location) {
      entry.result = "failed";
      entry.detail = "Document row has no usable stored file path.";
      entry.durationMs = Math.round(now() - startedAt);
      return entry;
    }

    const fileBuffer = await fs.readFile(location.absoluteFilePath);
    const extractionResult = await extractPdf(fileBuffer);

    entry.ocrWarnings = Array.isArray(extractionResult.ocrWarnings)
      ? extractionResult.ocrWarnings
      : [];
    entry.newStatus = extractionResult.extractionStatus;
    entry.newTextLength = String(extractionResult.extractedText || "").length;

    const verdict = verifyExtraction(extractionResult, {
      expectOcr: document.textLayerCharacters === 0,
    });

    if (!verdict.ok) {
      entry.result = verdict.result;
      entry.detail = verdict.detail;
      entry.newChunkCount = document.chunkCount;
      entry.durationMs = Math.round(now() - startedAt);
      return entry;
    }

    // Same pre-persistence gate as the re-chunk path: text long enough to pass
    // verification can still chunk to nothing (a page list that disagrees with
    // the joined text), and that has to be known before the write, not after.
    const plannedChunks = buildChunksFromPages(extractionResult.pages);

    if (!plannedChunks.length) {
      entry.result = "failed";
      entry.detail = "Extraction produced text but no chunks.";
      entry.newChunkCount = document.chunkCount;
      entry.durationMs = Math.round(now() - startedAt);
      return entry;
    }

    if (apply) {
      const summary = persistExtractionResult(document.documentId, extractionResult);
      entry.newChunkCount = summary.chunkCount;
    } else {
      entry.newChunkCount = plannedChunks.length;
    }

    entry.result = verdict.result;
    entry.detail = verdict.detail || `OCR recovered ${entry.newTextLength} characters.`;
  } catch (error) {
    entry.result = "failed";
    entry.detail = error?.message || String(error);
  }

  entry.durationMs = Math.round(now() - startedAt);
  return entry;
}

/** Read corpus-health counters for BEFORE/AFTER comparison. */
export function readCorpusHealth(db) {
  const single = (sql, ...parameters) =>
    Number(db.prepare(sql).get(...parameters)?.value || 0);

  return {
    totalDocuments: single("SELECT COUNT(*) AS value FROM documents"),
    documentsWithChunks: single(`
      SELECT COUNT(*) AS value FROM documents d
      WHERE EXISTS (SELECT 1 FROM document_chunks c WHERE c.document_id = d.id)
    `),
    zeroChunkDocuments: single(`
      SELECT COUNT(*) AS value FROM documents d
      WHERE NOT EXISTS (SELECT 1 FROM document_chunks c WHERE c.document_id = d.id)
    `),
    totalChunks: single("SELECT COUNT(*) AS value FROM document_chunks"),
    completedWithOcrDocuments: single(`
      SELECT COUNT(*) AS value FROM documents
      WHERE extraction_status LIKE 'completed_with_ocr%'
    `),
    ocrWarningDocuments: single(`
      SELECT COUNT(*) AS value FROM documents
      WHERE extraction_status LIKE '%_warning:%'
         OR extraction_status LIKE 'ocr_failed:%'
         OR extraction_status LIKE 'ocr_unavailable:%'
    `),
    extractionFailedDocuments: single(`
      SELECT COUNT(*) AS value FROM documents
      WHERE extraction_status LIKE 'failed:%'
    `),
    chunksMissingCurrentEmbedding: single(
      `
      SELECT COUNT(*) AS value FROM document_chunks
      WHERE embedding_version IS NULL
         OR embedding_version <> ?
         OR embedding IS NULL
    `,
      config.openAiEmbeddingVersion
    ),
  };
}

export function summarizeEntries(entries = []) {
  const summary = { recovered: 0, skipped: 0, failed: 0, "needs-review": 0 };

  for (const entry of entries) {
    if (entry?.result in summary) {
      summary[entry.result] += 1;
    }
  }

  return summary;
}

/** Progress journal so an interrupted 688-page run resumes where it stopped. */
export function resolveProgressFile(outputDir) {
  return path.join(
    outputDir || path.join(path.dirname(config.databaseFile), "diagnostics"),
    "n0-recovery-progress.json"
  );
}

export async function readProgress(progressFile) {
  try {
    const raw = await fs.readFile(progressFile, "utf8");
    const parsed = JSON.parse(raw);

    return {
      entries: parsed && typeof parsed.entries === "object" ? parsed.entries : {},
    };
  } catch {
    return { entries: {} };
  }
}

export async function writeProgress(progressFile, progress) {
  await fs.mkdir(path.dirname(progressFile), { recursive: true });
  await fs.writeFile(progressFile, `${JSON.stringify(progress, null, 2)}\n`, "utf8");
}

/**
 * Documents already finished successfully are not worth reprocessing; anything
 * that failed or needs review is retried, because those wrote nothing.
 */
export function isAlreadyComplete(progress, documentId) {
  return progress?.entries?.[String(documentId)]?.result === "recovered";
}
