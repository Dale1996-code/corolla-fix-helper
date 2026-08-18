// Read-only diagnosis of documents that hold zero `document_chunks`.
//
//   npm run diagnose:zero-chunks
//   npm run diagnose:zero-chunks -- --ocr-probe            (adds a real OCR read)
//   npm run diagnose:zero-chunks -- --ocr-probe --limit 20
//
// A document with no chunks is invisible to Ask regardless of how good its PDF
// is, so this answers "why is each one empty, and which are recoverable?".
//
// STRICTLY READ-ONLY. The database is opened with readOnly:true (so a stray
// write throws instead of corrupting anything), `database.js` is deliberately
// NOT imported because it opens read-write and switches journal mode, and no
// re-extraction path that persists is called. The optional OCR probe copies a
// PDF into a temp directory before rendering, so `pdftoppm` never writes its
// page images into the uploads folder; the temp directory is always removed.
//
// See `services/zeroChunkDiagnostics.js` for what each category means and why
// `extraction_status` alone is not evidence.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { config } from "../config.js";
import { ocrPdfPageWithLocalTools } from "../services/pdfService.js";
import {
  classifyZeroChunkDocument,
  countTextCharacters,
  summarizeClassifications,
} from "../services/zeroChunkDiagnostics.js";

const OCR_TEMP_PREFIX = path.join(os.tmpdir(), "corolla-fix-helper-zero-chunk-");
const SAMPLE_TEXT_LIMIT = 120;

// Every operator that paints raster pixels. A scanned page is typically a single
// paintImageXObject covering the sheet; the mask variants catch bitonal scans.
const IMAGE_OPERATORS = new Set([
  pdfjs.OPS.paintImageXObject,
  pdfjs.OPS.paintImageXObjectRepeat,
  pdfjs.OPS.paintInlineImageXObject,
  pdfjs.OPS.paintInlineImageXObjectGroup,
  pdfjs.OPS.paintImageMaskXObject,
  pdfjs.OPS.paintImageMaskXObjectGroup,
  pdfjs.OPS.paintImageMaskXObjectRepeat,
]);

// Line art (wiring diagrams, exploded views). Present without images or text it
// means the page has content that OCR may still not be able to read.
const VECTOR_OPERATORS = new Set([
  pdfjs.OPS.constructPath,
  pdfjs.OPS.stroke,
  pdfjs.OPS.fill,
  pdfjs.OPS.eoFill,
]);

export function parseArguments(argv = []) {
  const options = { ocrProbe: false, limit: 0, outputDir: "" };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--ocr-probe") {
      options.ocrProbe = true;
    } else if (argument === "--limit") {
      options.limit = Math.max(0, Number(argv[index + 1]) || 0);
      index += 1;
    } else if (argument === "--out") {
      options.outputDir = String(argv[index + 1] || "");
      index += 1;
    }
  }

  return options;
}

function openDatabaseReadOnly() {
  return new DatabaseSync(config.databaseFile, { readOnly: true });
}

function readZeroChunkDocuments(db) {
  return db
    .prepare(`
      SELECT
        d.id,
        d.title,
        d.original_filename,
        d.stored_filename,
        d.page_count,
        d.extraction_status,
        LENGTH(COALESCE(d.extracted_text, '')) AS extracted_text_length,
        COALESCE(d.extracted_text, '') AS extracted_text,
        d.created_at
      FROM documents d
      WHERE NOT EXISTS (
        SELECT 1 FROM document_chunks c WHERE c.document_id = d.id
      )
      ORDER BY d.id ASC
    `)
    .all();
}

function readCorpusTotals(db) {
  const documents = db.prepare("SELECT COUNT(*) AS total FROM documents").get();
  const chunks = db.prepare("SELECT COUNT(*) AS total FROM document_chunks").get();

  return {
    totalDocuments: Number(documents?.total) || 0,
    totalChunks: Number(chunks?.total) || 0,
  };
}

/** Structural read of the stored PDF: text layer size and what is drawn on each page. */
async function inspectStoredPdf(storedFilename) {
  const inspection = {
    filePath: "",
    fileFound: false,
    fileBytes: 0,
    fileError: null,
    parseError: null,
    inspectedPageCount: 0,
    textLayerCharacters: 0,
    pagesWithImages: 0,
    imageOperations: 0,
    vectorOperations: 0,
    densestImagePageNumber: 1,
  };

  const safeFilename = path.basename(String(storedFilename || ""));

  if (!safeFilename) {
    inspection.fileError = "document row has no stored filename";
    return inspection;
  }

  inspection.filePath = path.join(config.uploadsDir, safeFilename);

  let fileBuffer;

  try {
    fileBuffer = await fs.readFile(inspection.filePath);
    inspection.fileFound = true;
    inspection.fileBytes = fileBuffer.length;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return inspection;
    }

    inspection.fileFound = true;
    inspection.fileError = error?.message || String(error);
    return inspection;
  }

  if (!fileBuffer.length) {
    return inspection;
  }

  let pdfDocument;

  try {
    pdfDocument = await pdfjs.getDocument({
      data: new Uint8Array(fileBuffer),
      useSystemFonts: true,
      isEvalSupported: false,
    }).promise;
    inspection.inspectedPageCount = pdfDocument.numPages;
  } catch (error) {
    inspection.parseError = error?.message || String(error);
    return inspection;
  }

  let mostImageOperations = 0;

  for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
    try {
      const page = await pdfDocument.getPage(pageNumber);
      const textContent = await page.getTextContent();

      inspection.textLayerCharacters += countTextCharacters(
        textContent.items.map((item) => ("str" in item ? item.str : "")).join(" ")
      );

      const operatorList = await page.getOperatorList();
      let pageImageOperations = 0;

      for (const operator of operatorList.fnArray) {
        if (IMAGE_OPERATORS.has(operator)) {
          pageImageOperations += 1;
        } else if (VECTOR_OPERATORS.has(operator)) {
          inspection.vectorOperations += 1;
        }
      }

      inspection.imageOperations += pageImageOperations;

      if (pageImageOperations > 0) {
        inspection.pagesWithImages += 1;
      }

      if (pageImageOperations > mostImageOperations) {
        mostImageOperations = pageImageOperations;
        inspection.densestImagePageNumber = pageNumber;
      }
    } catch (error) {
      inspection.parseError = `page ${pageNumber}: ${error?.message || String(error)}`;
      break;
    }
  }

  return inspection;
}

/**
 * Render one page to a temp directory and OCR it, to turn "has images, might
 * hold text" into a measured character count. Never touches the uploads folder.
 */
async function probePageWithOcr(sourceFilePath, pageNumber) {
  let temporaryDirectory = "";

  try {
    temporaryDirectory = await fs.mkdtemp(OCR_TEMP_PREFIX);
    const temporaryPdfPath = path.join(temporaryDirectory, "source.pdf");
    await fs.copyFile(sourceFilePath, temporaryPdfPath);

    const result = await ocrPdfPageWithLocalTools({
      pdfPath: temporaryPdfPath,
      pageNumber,
    });
    const text = String(result?.text || "").trim();

    return {
      pageNumber,
      characters: countTextCharacters(text),
      sampleText: text.slice(0, SAMPLE_TEXT_LIMIT),
      error: null,
    };
  } catch (error) {
    return {
      pageNumber,
      characters: 0,
      sampleText: "",
      error: error?.message || String(error),
    };
  } finally {
    if (temporaryDirectory) {
      await fs.rm(temporaryDirectory, { recursive: true, force: true });
    }
  }
}

// Only probe where the answer is still open: a readable file that neither the
// stored row nor its text layer already explains. Probing the rest would burn
// ~3s a page to confirm something the cheap evidence already settled.
function shouldProbe(inspection, storedTextCharacters) {
  return (
    inspection.fileFound &&
    !inspection.fileError &&
    !inspection.parseError &&
    inspection.inspectedPageCount > 0 &&
    inspection.textLayerCharacters < config.ocrMinTextCharacters &&
    storedTextCharacters < config.ocrMinTextCharacters
  );
}

export async function diagnoseZeroChunkDocuments(options = {}) {
  const db = openDatabaseReadOnly();

  try {
    const totals = readCorpusTotals(db);
    const allZeroChunkRows = readZeroChunkDocuments(db);
    const zeroChunkTotal = allZeroChunkRows.length;
    const documentRows = options.limit
      ? allZeroChunkRows.slice(0, options.limit)
      : allZeroChunkRows;
    const reports = [];

    for (const row of documentRows) {
      const inspection = await inspectStoredPdf(row.stored_filename);
      const storedTextCharacters = countTextCharacters(row.extracted_text);
      let ocrProbe = null;

      if (options.ocrProbe && shouldProbe(inspection, storedTextCharacters)) {
        ocrProbe = await probePageWithOcr(
          inspection.filePath,
          inspection.densestImagePageNumber
        );
      }

      const evidence = {
        storedExtractionStatus: row.extraction_status,
        storedTextCharacters,
        fileFound: inspection.fileFound,
        fileBytes: inspection.fileBytes,
        fileError: inspection.fileError,
        parseError: inspection.parseError,
        inspectedPageCount: inspection.inspectedPageCount,
        textLayerCharacters: inspection.textLayerCharacters,
        pagesWithImages: inspection.pagesWithImages,
        vectorOperations: inspection.vectorOperations,
        ocrProbe,
      };

      const { category, reason } = classifyZeroChunkDocument(evidence, {
        meaningfulTextCharacters: config.ocrMinTextCharacters,
      });

      reports.push({
        documentId: row.id,
        title: row.title,
        originalFilename: row.original_filename,
        storedFilename: row.stored_filename,
        createdAt: row.created_at,
        // A: what the database stores.
        storedPageCount: row.page_count,
        storedExtractionStatus: row.extraction_status,
        storedTextLength: row.extracted_text_length,
        storedTextCharacters,
        chunkCount: 0,
        // B: what inspecting the source file shows.
        fileFound: inspection.fileFound,
        fileBytes: inspection.fileBytes,
        fileError: inspection.fileError,
        parseError: inspection.parseError,
        inspectedPageCount: inspection.inspectedPageCount,
        textLayerCharacters: inspection.textLayerCharacters,
        pagesWithImages: inspection.pagesWithImages,
        imageOperations: inspection.imageOperations,
        vectorOperations: inspection.vectorOperations,
        ocrProbePage: ocrProbe?.pageNumber ?? null,
        ocrProbeCharacters: ocrProbe ? ocrProbe.characters : null,
        ocrProbeSample: ocrProbe ? ocrProbe.sampleText : "",
        ocrProbeError: ocrProbe?.error ?? null,
        // Verdict.
        category,
        reason,
      });
    }

    return {
      databaseFile: config.databaseFile,
      uploadsDir: config.uploadsDir,
      ocrProbeRun: Boolean(options.ocrProbe),
      meaningfulTextCharacters: config.ocrMinTextCharacters,
      ...totals,
      // `--limit` truncates the set, so keep the real total separate: a sample
      // labelled as the corpus figure is how a partial run gets quoted later as
      // if it were the whole picture.
      zeroChunkDocumentsTotal: zeroChunkTotal,
      zeroChunkDocuments: reports.length,
      limited: reports.length < zeroChunkTotal,
      summary: summarizeClassifications(reports),
      documents: reports,
    };
  } finally {
    db.close();
  }
}

function toCsvValue(value) {
  if (value === null || value === undefined) {
    return "";
  }

  const text = String(value).replace(/\r?\n/g, " ");
  return /[",]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function buildCsvReport(documents = []) {
  const columns = [
    "documentId",
    "originalFilename",
    "storedFilename",
    "storedPageCount",
    "inspectedPageCount",
    "storedExtractionStatus",
    "storedTextLength",
    "textLayerCharacters",
    "pagesWithImages",
    "vectorOperations",
    "ocrProbeCharacters",
    "ocrProbeSample",
    "chunkCount",
    "category",
    "reason",
  ];

  return [
    columns.join(","),
    ...documents.map((document) =>
      columns.map((column) => toCsvValue(document[column])).join(",")
    ),
  ].join("\n");
}

function formatUnusualCases(report) {
  const buckets = [
    {
      heading: "Meaningful stored text but zero chunks (pipeline gap)",
      rows: report.documents.filter((row) => row.category === "text-present-no-chunks"),
    },
    {
      heading: "Extraction errors",
      rows: report.documents.filter((row) => row.category === "extraction-error"),
    },
    {
      heading: "Missing / malformed source files",
      rows: report.documents.filter(
        (row) => row.category === "malformed-or-missing-file"
      ),
    },
    {
      heading: "Unknown - manual review required",
      rows: report.documents.filter((row) => row.category === "unknown-manual-review"),
    },
  ];

  const lines = [];

  for (const bucket of buckets) {
    if (!bucket.rows.length) {
      continue;
    }

    lines.push("", `${bucket.heading} (${bucket.rows.length}):`);

    for (const row of bucket.rows) {
      lines.push(`  #${row.documentId} ${row.originalFilename}`);
      lines.push(`      ${row.reason}`);
    }
  }

  return lines;
}

export function formatConsoleReport(report) {
  const lines = [
    "Zero-chunk document diagnosis (read-only)",
    `Database: ${report.databaseFile}`,
    `Uploads:  ${report.uploadsDir}`,
    "",
    `Documents in corpus:       ${report.totalDocuments}`,
    `Chunks in corpus:          ${report.totalChunks}`,
    `Documents with 0 chunks:   ${report.zeroChunkDocumentsTotal}` +
      (report.totalDocuments
        ? ` (${Math.round((report.zeroChunkDocumentsTotal / report.totalDocuments) * 1000) / 10}% of corpus)`
        : ""),
    `Classified in this run:    ${report.zeroChunkDocuments}` +
      (report.limited ? " (--limit sample, NOT the whole set)" : ""),
    `OCR probe:                 ${report.ocrProbeRun ? "yes (measured)" : "no (structural evidence only)"}`,
    "",
    "By category:",
  ];

  for (const entry of report.summary) {
    const count = String(entry.count).padStart(4);
    const percentage = `${entry.percentage}%`.padStart(6);
    lines.push(`  ${count}  ${percentage}  ${entry.label}`);
  }

  lines.push(...formatUnusualCases(report));

  const ocrCandidates = report.documents.filter((row) => row.category === "ocr-candidate");

  if (ocrCandidates.length) {
    const pages = ocrCandidates.reduce(
      (total, row) => total + (row.inspectedPageCount || 0),
      0
    );
    lines.push(
      "",
      `OCR candidates: ${ocrCandidates.length} documents / ${pages} pages` +
        (report.ocrProbeRun ? " (confirmed by probe)" : " (unconfirmed - run with --ocr-probe)")
    );
  }

  return lines.join("\n");
}

async function writeReports(report, outputDir) {
  const targetDir =
    outputDir || path.join(path.dirname(config.databaseFile), "diagnostics");

  await fs.mkdir(targetDir, { recursive: true });

  const jsonPath = path.join(targetDir, "zero-chunk-report.json");
  const csvPath = path.join(targetDir, "zero-chunk-report.csv");

  await fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await fs.writeFile(csvPath, `${buildCsvReport(report.documents)}\n`, "utf8");

  return { jsonPath, csvPath };
}

async function runCli() {
  const options = parseArguments(process.argv.slice(2));

  try {
    const report = await diagnoseZeroChunkDocuments(options);
    console.log(formatConsoleReport(report));

    const { jsonPath, csvPath } = await writeReports(report, options.outputDir);
    console.log(`\nJSON report: ${jsonPath}\nCSV report:  ${csvPath}`);
  } catch (error) {
    console.error(error?.message || String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCli();
}
