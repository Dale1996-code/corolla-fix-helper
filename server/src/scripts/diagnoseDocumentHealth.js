// Read-only document-health report (roadmap N8, first slice).
//
//   npm run diagnose:document-health
//   npm run diagnose:document-health -- --show 25 --output-dir <folder>
//
// Lists the documents that need attention: stored PDF missing, zero chunks,
// extraction failed, OCR needed or used, or chunks missing the current
// embedding version. Prints a count per problem and a short list per problem,
// and writes the full list as JSON + CSV (default: server/data/diagnostics/,
// gitignored, next to the database).
//
// STRICTLY READ-ONLY. The database is opened with { readOnly: true }, so a
// stray write throws instead of changing anything; `database.js` is NOT
// imported, because it opens the file read-write and switches journal mode.
// Each PDF is only stat()ed, never opened or parsed. No re-extraction, no
// re-embedding, no OpenAI call, no network. Only the two report files are
// written. Run it against a `VACUUM INTO` snapshot through DATABASE_FILE.
//
// The rules live in `services/documentHealth.js`.

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { config } from "../config.js";
import {
  classifyDocumentHealth,
  resolveStoredPdfName,
  summarizeDocumentHealth,
} from "../services/documentHealth.js";

const DEFAULT_SHOW = 10;
const DETAIL_LIMIT = 160;

/**
 * @param {string[]} argv
 * @returns {{ outputDir: string, show: number }}
 */
export function parseArguments(argv = []) {
  const options = { outputDir: "", show: DEFAULT_SHOW };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--output-dir") {
      options.outputDir = String(argv[index + 1] || "");
      index += 1;
    } else if (argument === "--show") {
      const value = Number(argv[index + 1]);
      options.show = Number.isInteger(value) && value >= 0 ? value : DEFAULT_SHOW;
      index += 1;
    }
  }

  return options;
}

/**
 * Is there a regular file with this name in the uploads folder? stat only.
 *
 * @param {string} uploadsDir
 * @param {string} name
 */
function storedPdfExists(uploadsDir, name) {
  if (!name) {
    return false;
  }

  try {
    return fs.statSync(path.join(uploadsDir, name)).isFile();
  } catch {
    return false;
  }
}

/**
 * Build the report from a read-only connection.
 *
 * @param {DatabaseSync} db  opened with { readOnly: true }
 * @param {{ uploadsDir: string, embeddingVersion: string }} options
 */
export function buildDocumentHealthReport(db, { uploadsDir, embeddingVersion }) {
  const documents = /** @type {any[]} */ (
    db
      .prepare(`
        SELECT id, title, original_filename, stored_filename, file_path, extraction_status
        FROM documents
        ORDER BY id ASC
      `)
      .all()
  );

  // One pass over the chunks for every document: how many it has, and how many
  // are not embedded under the current version (never embedded counts too), the
  // same test as documentService's "embedding pending" hint.
  const chunkRows = /** @type {any[]} */ (
    db
      .prepare(`
        SELECT
          document_id,
          COUNT(*) AS chunk_count,
          SUM(CASE WHEN COALESCE(embedding_version, '') <> ? THEN 1 ELSE 0 END) AS pending
        FROM document_chunks
        GROUP BY document_id
      `)
      .all(embeddingVersion)
  );
  const chunksByDocument = new Map(
    chunkRows.map((row) => [
      Number(row.document_id),
      { chunkCount: Number(row.chunk_count) || 0, pending: Number(row.pending) || 0 },
    ])
  );

  const flagged = [];
  let totalChunks = 0;
  let pendingEmbeddingChunks = 0;

  for (const row of documents) {
    const chunks = chunksByDocument.get(Number(row.id)) || { chunkCount: 0, pending: 0 };
    const storedPdfName = resolveStoredPdfName(row);
    const fileFound = storedPdfExists(uploadsDir, storedPdfName);
    totalChunks += chunks.chunkCount;
    pendingEmbeddingChunks += chunks.pending;

    const problems = classifyDocumentHealth({
      fileFound,
      storedPdfName,
      extractionStatus: row.extraction_status,
      chunkCount: chunks.chunkCount,
      pendingEmbeddingChunks: chunks.pending,
    });

    if (problems.length) {
      flagged.push({
        documentId: Number(row.id),
        title: row.title,
        originalFilename: row.original_filename,
        storedFilename: storedPdfName,
        fileFound,
        extractionStatus: row.extraction_status,
        chunkCount: chunks.chunkCount,
        pendingEmbeddingChunks: chunks.pending,
        problems,
      });
    }
  }

  return {
    readOnly: true,
    uploadsDir,
    embeddingVersion,
    totalDocuments: documents.length,
    totalChunks,
    pendingEmbeddingChunks,
    documentsNeedingAttention: flagged.length,
    healthyDocuments: documents.length - flagged.length,
    summary: summarizeDocumentHealth(flagged),
    documents: flagged,
  };
}

/**
 * One CSV cell. A leading = + - @ (or tab/CR) is prefixed with ' so a
 * spreadsheet shows a title like "=HYPERLINK(…)" as text, not a formula.
 *
 * @param {unknown} value
 */
function toCsvValue(value) {
  if (value === null || value === undefined) {
    return "";
  }

  let text = String(value).replace(/\r?\n/g, " ");

  if (/^[=+\-@\t\r]/.test(text)) {
    text = `'${text}`;
  }

  return /[",']/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const CSV_COLUMNS = [
  "documentId",
  "title",
  "originalFilename",
  "storedFilename",
  "problems",
  "extractionStatus",
  "chunkCount",
  "pendingEmbeddingChunks",
  "fileFound",
];

/** @param {any[]} documents */
export function buildCsvReport(documents = []) {
  return [
    CSV_COLUMNS.join(","),
    ...documents.map((document) =>
      CSV_COLUMNS.map((column) =>
        toCsvValue(
          column === "problems"
            ? (document.problems || []).map((/** @type {{ code: string }} */ entry) => entry.code).join(";")
            : document[column]
        )
      ).join(",")
    ),
  ].join("\n");
}

/** @param {string} text */
function shorten(text) {
  const value = String(text || "");
  return value.length > DETAIL_LIMIT ? `${value.slice(0, DETAIL_LIMIT - 1)}…` : value;
}

/**
 * @param {ReturnType<typeof buildDocumentHealthReport> & { databaseFile?: string }} report
 * @param {{ show?: number }} [options]
 */
export function formatConsoleReport(report, { show = DEFAULT_SHOW } = {}) {
  const lines = [
    "Document health report (read-only)",
    ...(report.databaseFile ? [`Database:  ${report.databaseFile}`] : []),
    `Uploads:   ${report.uploadsDir}`,
    `Embedding: ${report.embeddingVersion} (current version)`,
    "",
    `Documents:                    ${report.totalDocuments}`,
    `Chunks:                       ${report.totalChunks}`,
    `Documents needing attention:  ${report.documentsNeedingAttention} of ${report.totalDocuments}`,
    "",
    "Documents per problem (one document can have several):",
  ];

  for (const entry of report.summary) {
    lines.push(`  ${String(entry.count).padStart(5)}  ${entry.label}`);
  }

  if (!report.documentsNeedingAttention) {
    lines.push("", "No documents need attention.");
    return lines.join("\n");
  }

  for (const entry of report.summary) {
    if (!entry.count || show === 0) {
      continue;
    }

    const rows = report.documents.filter((document) =>
      document.problems.some((found) => found.code === entry.code)
    );

    lines.push("", `${entry.label} (${entry.count}) - ${entry.hint}`);

    for (const document of rows.slice(0, show)) {
      const found = document.problems.find((candidate) => candidate.code === entry.code);
      lines.push(`  #${document.documentId} ${shorten(document.title)}`);
      lines.push(`      ${shorten(found?.detail || "")}`);
    }

    if (rows.length > show) {
      lines.push(`  ... and ${rows.length - show} more (see the CSV)`);
    }
  }

  return lines.join("\n");
}

/**
 * @param {object} report
 * @param {string} outputDir
 */
function writeReports(report, outputDir) {
  fs.mkdirSync(outputDir, { recursive: true });
  const jsonPath = path.join(outputDir, "document-health-report.json");
  const csvPath = path.join(outputDir, "document-health-report.csv");
  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  fs.writeFileSync(
    csvPath,
    `${buildCsvReport(/** @type {{ documents: any[] }} */ (report).documents)}\n`,
    "utf8"
  );
  return { jsonPath, csvPath };
}

/**
 * @param {string[]} [argv]
 * @param {{ databaseFile?: string, uploadsDir?: string, embeddingVersion?: string }} [overrides]
 *   tests point the CLI at an invented library; normal runs use config (env vars)
 */
export async function runCli(argv = process.argv.slice(2), overrides = {}) {
  const databaseFile = overrides.databaseFile || config.databaseFile;
  const uploadsDir = overrides.uploadsDir || config.uploadsDir;
  const embeddingVersion = overrides.embeddingVersion || config.openAiEmbeddingVersion;
  let db;

  try {
    const options = parseArguments(argv);

    // Checked first so a mistyped DATABASE_FILE is an error, never a new file.
    if (!fs.existsSync(databaseFile)) {
      throw new Error(`Database file not found: ${databaseFile}`);
    }

    db = new DatabaseSync(databaseFile, { readOnly: true });
    const report = {
      databaseFile,
      ...buildDocumentHealthReport(db, { uploadsDir, embeddingVersion }),
    };
    db.close();
    db = undefined;

    console.log(formatConsoleReport(report, { show: options.show }));
    const outputDir = options.outputDir || path.join(path.dirname(databaseFile), "diagnostics");
    const { jsonPath, csvPath } = writeReports(report, outputDir);
    console.log(`\nJSON report: ${jsonPath}\nCSV report:  ${csvPath}`);
  } catch (error) {
    console.error(/** @type {Error} */ (error)?.message || String(error));
    process.exitCode = 1;
  } finally {
    db?.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCli();
}
