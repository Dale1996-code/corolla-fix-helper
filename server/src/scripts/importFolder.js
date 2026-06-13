import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { config } from "../config.js";
import { db } from "../database.js";
import { initializeDatabase } from "../initDatabase.js";
import { rebuildDocumentChunksFromPages } from "../services/documentChunkService.js";
import { extractPdfData } from "../services/pdfService.js";
import {
  deriveTitleFromFilename,
  sanitizeFilename,
} from "../utils/sanitizeFilename.js";

const IMAGE_ONLY_TEXT_CHARACTER_LIMIT = 20;

function normalizeText(value, fallback = "") {
  const text = typeof value === "string" ? value.trim() : "";
  return text || fallback;
}

function countTextCharacters(text) {
  return typeof text === "string" ? text.replace(/\s+/g, "").length : 0;
}

function isImageOnlyExtraction(extractionResult) {
  if (!extractionResult || String(extractionResult.extractionStatus).startsWith("failed:")) {
    return false;
  }

  if (isNoTextStatus(extractionResult.extractionStatus)) {
    return true;
  }

  return countTextCharacters(extractionResult.extractedText) < IMAGE_ONLY_TEXT_CHARACTER_LIMIT;
}

function md5Hex(buffer) {
  return crypto.createHash("md5").update(buffer).digest("hex");
}

function getVehicleId() {
  const vehicle = db
    .prepare("SELECT id FROM vehicles ORDER BY id ASC LIMIT 1")
    .get();

  if (!vehicle) {
    throw new Error("No vehicle record exists yet.");
  }

  return vehicle.id;
}

async function findPdfFiles(directoryPath) {
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  const pdfFiles = [];

  for (const entry of entries) {
    const entryPath = path.join(directoryPath, entry.name);

    if (entry.isDirectory()) {
      pdfFiles.push(...await findPdfFiles(entryPath));
      continue;
    }

    if (entry.isFile() && path.extname(entry.name).toLowerCase() === ".pdf") {
      pdfFiles.push(entryPath);
    }
  }

  return pdfFiles.sort((left, right) => left.localeCompare(right));
}

function getExistingDocumentByHash(fileMd5) {
  if (!fileMd5) {
    return null;
  }

  return db
    .prepare(`
      SELECT id, original_filename, stored_filename, extraction_status
      FROM documents
      WHERE file_md5 = ?
      LIMIT 1
    `)
    .get(fileMd5) || null;
}

function getExistingDocumentByFilename(filename) {
  return db
    .prepare(`
      SELECT id, original_filename, stored_filename, extraction_status
      FROM documents
      WHERE lower(original_filename) = lower(?)
      LIMIT 1
    `)
    .get(filename) || null;
}

function isNoTextStatus(status) {
  const normalizedStatus = String(status || "");

  return (
    normalizedStatus === "no_text_found" ||
    normalizedStatus.startsWith("ocr_unavailable:") ||
    normalizedStatus.startsWith("ocr_failed:")
  );
}

function existingDocumentIsImageOnly(documentRow) {
  return isNoTextStatus(documentRow?.extraction_status);
}

function buildStoredFilename(originalFilename, fileMd5) {
  const safeFilename = sanitizeFilename(originalFilename);
  const extension = path.extname(safeFilename) || ".pdf";
  const baseName = path.basename(safeFilename, extension);
  const hashSuffix = fileMd5.slice(0, 8);
  let candidate = `${baseName}-${hashSuffix}${extension}`;
  let counter = 1;

  while (db.prepare("SELECT id FROM documents WHERE stored_filename = ?").get(candidate)) {
    candidate = `${baseName}-${hashSuffix}-${counter}${extension}`;
    counter += 1;
  }

  return candidate;
}

function createEmptyReport(sourceFolder) {
  return {
    sourceFolder,
    uploadsDir: config.uploadsDir,
    totalPdfFiles: 0,
    imported: 0,
    skipped: 0,
    failed: 0,
    imageOnly: 0,
    results: {
      imported: [],
      skipped: [],
      failed: [],
    },
  };
}

function recordSkipped(report, entry) {
  report.skipped += 1;
  report.results.skipped.push(entry);

  if (entry.imageOnly) {
    report.imageOnly += 1;
  }
}

function recordFailed(report, entry) {
  report.failed += 1;
  report.results.failed.push(entry);
}

function recordImported(report, entry) {
  report.imported += 1;
  report.results.imported.push(entry);

  if (entry.imageOnly) {
    report.imageOnly += 1;
  }
}

async function importSinglePdf(filePath, options, report) {
  const originalFilename = path.basename(filePath);
  let fileBuffer;

  try {
    fileBuffer = await fs.readFile(filePath);
  } catch (error) {
    recordFailed(report, {
      filePath,
      originalFilename,
      reason: "read_failed",
      message: error.message,
    });
    return;
  }

  const fileMd5 = md5Hex(fileBuffer);
  const duplicateByHash = getExistingDocumentByHash(fileMd5);

  if (duplicateByHash) {
    recordSkipped(report, {
      filePath,
      originalFilename,
      reason: "duplicate_md5",
      existingDocumentId: duplicateByHash.id,
      existingFilename: duplicateByHash.original_filename,
      imageOnly: existingDocumentIsImageOnly(duplicateByHash),
    });
    return;
  }

  const duplicateByFilename = getExistingDocumentByFilename(originalFilename);

  if (duplicateByFilename) {
    recordSkipped(report, {
      filePath,
      originalFilename,
      reason: "duplicate_filename",
      existingDocumentId: duplicateByFilename.id,
      existingFilename: duplicateByFilename.original_filename,
      imageOnly: existingDocumentIsImageOnly(duplicateByFilename),
    });
    return;
  }

  const extractionResult = await extractPdfData(fileBuffer);

  if (String(extractionResult.extractionStatus).startsWith("failed:")) {
    recordFailed(report, {
      filePath,
      originalFilename,
      reason: "extraction_failed",
      message: extractionResult.extractionStatus,
    });
    return;
  }

  const imageOnly = isImageOnlyExtraction(extractionResult);
  const storedFilename = buildStoredFilename(originalFilename, fileMd5);
  const absoluteFilePath = path.join(config.uploadsDir, storedFilename);
  const relativeFilePath = `server/uploads/${storedFilename}`.replace(/\\/g, "/");
  const vehicleId = getVehicleId();
  const title = normalizeText(options.title, deriveTitleFromFilename(originalFilename));
  const system = normalizeText(options.system, "Imported Documents");
  const documentType = normalizeText(options.documentType, "Repair Manual");
  const source = normalizeText(options.source, "Bulk Folder Import");
  const subsystem = normalizeText(options.subsystem);
  const notes = normalizeText(options.notes);
  const extractionStatus =
    imageOnly && extractionResult.extractionStatus === "completed"
      ? "no_text_found"
      : extractionResult.extractionStatus;

  try {
    await fs.mkdir(config.uploadsDir, { recursive: true });
    await fs.writeFile(absoluteFilePath, fileBuffer);

    const result = db
      .prepare(`
        INSERT INTO documents (
          vehicle_id,
          title,
          original_filename,
          stored_filename,
          file_path,
          file_type,
          system,
          subsystem,
          document_type,
          source,
          notes,
          file_md5,
          extracted_text,
          extraction_status,
          page_count,
          is_favorite
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        vehicleId,
        title,
        originalFilename,
        storedFilename,
        relativeFilePath,
        "application/pdf",
        system,
        subsystem,
        documentType,
        source,
        notes,
        fileMd5,
        extractionResult.extractedText,
        extractionStatus,
        extractionResult.pageCount,
        0
      );

    const documentId = Number(result.lastInsertRowid);
    const chunkSummary = rebuildDocumentChunksFromPages(documentId, extractionResult.pages);

    recordImported(report, {
      filePath,
      originalFilename,
      documentId,
      storedFilename,
      fileMd5,
      pageCount: extractionResult.pageCount,
      chunkCount: chunkSummary.chunkCount,
      imageOnly,
    });
  } catch (error) {
    await fs.rm(absoluteFilePath, { force: true });

    recordFailed(report, {
      filePath,
      originalFilename,
      reason: "import_failed",
      message: error.message,
    });
  }
}

export async function importPdfFolder(sourceFolder, options = {}) {
  const resolvedSourceFolder = path.resolve(sourceFolder || "");
  const report = createEmptyReport(resolvedSourceFolder);
  const sourceStats = await fs.stat(resolvedSourceFolder);

  if (!sourceStats.isDirectory()) {
    throw new Error(`Import path is not a folder: ${resolvedSourceFolder}`);
  }

  const pdfFiles = await findPdfFiles(resolvedSourceFolder);
  report.totalPdfFiles = pdfFiles.length;

  for (const pdfFile of pdfFiles) {
    await importSinglePdf(pdfFile, options, report);
  }

  return report;
}

export function formatImportReport(report) {
  const lines = [
    "Bulk PDF import report",
    `Source folder: ${report.sourceFolder}`,
    `Uploads folder: ${report.uploadsDir}`,
    `PDF files found: ${report.totalPdfFiles}`,
    `Imported: ${report.imported}`,
    `Skipped: ${report.skipped}`,
    `Failed: ${report.failed}`,
    `IMAGE-ONLY: ${report.imageOnly}`,
  ];

  if (report.results.failed.length) {
    lines.push("", "Failed files:");

    for (const failure of report.results.failed) {
      lines.push(`- ${failure.filePath} (${failure.reason}: ${failure.message})`);
    }
  }

  return lines.join("\n");
}

async function runCli() {
  const sourceFolder = process.argv[2];

  if (!sourceFolder) {
    console.error('Usage: npm run import -- "C:\\path\\to\\pdfs"');
    process.exitCode = 1;
    return;
  }

  try {
    initializeDatabase();
    const report = await importPdfFolder(sourceFolder);
    console.log(formatImportReport(report));
  } catch (error) {
    console.error(error.message || String(error));
    process.exitCode = 1;
  } finally {
    if (typeof db.close === "function") {
      db.close();
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCli();
}
