// Rules for the document-health report (roadmap N8, first slice).
//
// "Why didn't Ask find that?" usually has a boring answer: the PDF behind a
// document is gone, it never became chunks, its extraction failed, its text
// came from OCR (or OCR was needed and did not succeed), or some of its chunks
// are not embedded under the current model yet. This module turns evidence the
// caller already gathered into a list of those problems for one document.
//
// Pure module: no database, no filesystem, no network. The script
// (`scripts/diagnoseDocumentHealth.js`) gathers the evidence read-only; this
// decides what it means, so the rules are testable on invented rows.
//
// What a flag does and does not mean:
//   - `zero-chunks` is the one that makes a document invisible to Ask.
//     `npm run diagnose:zero-chunks` explains WHY, from the source file.
//   - `extraction-failed` and `ocr-gap` read `extraction_status`, which is a
//     snapshot of one past run, not proof about the file today (see
//     `zeroChunkDiagnostics.js`). `no_text_found` and `not_attempted` are
//     deliberately not flagged on their own for the same reason.
//   - `ocr-used` is a caution, not a fault: the text came from OCR, whose
//     accuracy nothing here measures (`npm run analyze:ocr-quality`).
//   - `embedding-pending` chunks are still found by keyword ranking; they only
//     lack semantic ranking until `npm run embed:backfill` runs.

import path from "node:path";

/**
 * Every problem the report knows, in the fixed order it prints them: the ones
 * that hide a document from Ask first, cautions last.
 */
export const DOCUMENT_HEALTH_PROBLEMS = [
  {
    code: "missing-file",
    label: "Stored PDF missing",
    hint: "The row names a PDF that is not in the uploads folder (or names none).",
  },
  {
    code: "extraction-failed",
    label: "Extraction failed",
    hint: "The last extraction recorded a hard failure (status starts with \"failed:\").",
  },
  {
    code: "zero-chunks",
    label: "Zero chunks",
    hint: "No chunks, so Ask can never find it. Run npm run diagnose:zero-chunks for why.",
  },
  {
    code: "ocr-gap",
    label: "OCR needed but did not succeed",
    hint: "At least one page needed OCR and it failed or was unavailable.",
  },
  {
    code: "embedding-pending",
    label: "Chunks missing the current embedding",
    hint: "Keyword search still finds them; run npm run embed:backfill for semantic ranking.",
  },
  {
    code: "ocr-used",
    label: "Text came from OCR",
    hint: "Caution only: OCR accuracy is not measured here.",
  },
];

const PROBLEM_BY_CODE = new Map(DOCUMENT_HEALTH_PROBLEMS.map((problem) => [problem.code, problem]));

/**
 * The file name a document's PDF is stored under, using the same rule as
 * `documentService.resolveStoredFilePath`: `stored_filename`, else the last
 * part of `file_path`, always reduced to a bare name so a stored value can
 * never point outside the uploads folder. "" when the row names no file.
 *
 * @param {{ stored_filename?: string | null, file_path?: string | null }} row
 * @returns {string}
 */
export function resolveStoredPdfName(row) {
  const raw = row?.stored_filename || path.basename(String(row?.file_path || "").replace(/\\/g, "/"));
  return raw ? path.basename(String(raw).replace(/\\/g, "/")) : "";
}

/**
 * @param {string} code
 * @param {string} detail
 */
function problem(code, detail) {
  const known = PROBLEM_BY_CODE.get(code);
  return { code, label: known?.label || code, detail };
}

/**
 * Decide which problems one document has.
 *
 * @param {{
 *   fileFound?: boolean,
 *   storedPdfName?: string,
 *   extractionStatus?: string | null,
 *   chunkCount?: number,
 *   pendingEmbeddingChunks?: number,
 * }} evidence
 * @returns {{ code: string, label: string, detail: string }[]} in DOCUMENT_HEALTH_PROBLEMS order
 */
export function classifyDocumentHealth(evidence = {}) {
  const status = String(evidence.extractionStatus || "");
  const chunkCount = Number(evidence.chunkCount) || 0;
  const pending = Number(evidence.pendingEmbeddingChunks) || 0;
  const found = [];

  if (!evidence.fileFound) {
    found.push(
      problem(
        "missing-file",
        evidence.storedPdfName
          ? `${evidence.storedPdfName} is not in the uploads folder.`
          : "The row names no stored PDF."
      )
    );
  }

  if (status.startsWith("failed:")) {
    found.push(problem("extraction-failed", status));
  }

  if (chunkCount === 0) {
    found.push(problem("zero-chunks", `Status "${status || "unknown"}", 0 chunks.`));
  }

  // Anywhere in the status: the extractor joins per-page warnings into
  // "completed_with_warning: …" and "completed_with_ocr_warning: …" too.
  if (/(^|[\s|:])ocr_(failed|unavailable):/.test(status)) {
    found.push(problem("ocr-gap", status));
  }

  if (pending > 0) {
    found.push(
      problem("embedding-pending", `${pending} of ${chunkCount} chunks lack the current embedding.`)
    );
  }

  if (status.startsWith("completed_with_ocr")) {
    found.push(problem("ocr-used", status));
  }

  return found;
}

/**
 * Count documents per problem. Every problem appears, zero included, so a
 * healthy library prints an explicit 0 rather than an empty table.
 *
 * @param {{ problems: { code: string }[] }[]} documents
 */
export function summarizeDocumentHealth(documents = []) {
  const counts = new Map(DOCUMENT_HEALTH_PROBLEMS.map((entry) => [entry.code, 0]));

  for (const document of documents) {
    for (const { code } of document.problems || []) {
      counts.set(code, (counts.get(code) || 0) + 1);
    }
  }

  return DOCUMENT_HEALTH_PROBLEMS.map(({ code, label, hint }) => ({
    code,
    label,
    hint,
    count: counts.get(code) || 0,
  }));
}
