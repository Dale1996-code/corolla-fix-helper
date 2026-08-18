// N0 recovery batch: make zero-chunk documents retrievable again.
//
//   npm run recover:zero-chunks -- --dry-run
//   npm run recover:zero-chunks -- --dry-run --document-id 9
//   npm run recover:zero-chunks -- --apply --document-id 9
//   npm run recover:zero-chunks -- --apply --limit 1
//   npm run recover:zero-chunks -- --apply --resume
//
// --dry-run is the default; --apply is the only thing that writes. Candidates
// are chosen by re-running the read-only diagnostic and acting on its verdicts,
// never from a hard-coded id list, so a document that has since been fixed,
// deleted, or reclassified is handled correctly on every run.
//
// Before the first write the database is snapshotted through the project's own
// `snapshotDatabase` (VACUUM INTO -- WAL-safe, unlike a file copy) and the
// snapshot is verified to exist and be non-empty. Every processed document is
// journalled, so --resume can continue an interrupted 688-page OCR run without
// redoing work that already succeeded.

import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { config } from "../config.js";
import { db } from "../database.js";
import { snapshotDatabase } from "../services/databaseSnapshot.js";
import {
  isAlreadyComplete,
  readCorpusHealth,
  readProgress,
  recoverDocument,
  resolveProgressFile,
  selectRecoveryStrategy,
  summarizeEntries,
  writeProgress,
} from "../services/zeroChunkRecovery.js";
import { diagnoseZeroChunkDocuments } from "./diagnoseZeroChunkDocuments.js";

export function parseArguments(argv = []) {
  const options = {
    apply: false,
    resume: false,
    documentId: 0,
    limit: 0,
    outputDir: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--apply") {
      options.apply = true;
    } else if (argument === "--dry-run") {
      options.apply = false;
    } else if (argument === "--resume") {
      options.resume = true;
    } else if (argument === "--document-id") {
      options.documentId = Math.max(0, Number(argv[index + 1]) || 0);
      index += 1;
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

/**
 * Snapshot the database before the first write and prove the snapshot landed.
 * Returns the path so the run can report where the safety net is.
 */
async function createPreRecoveryBackup(timestamp) {
  const dataDir = path.dirname(config.databaseFile);
  const backupFile = path.join(
    dataDir,
    `corolla-fix-helper-before-n0-recovery-${timestamp}.db`
  );

  snapshotDatabase({ destinationFile: backupFile, db });

  const stats = await fs.stat(backupFile);

  if (!stats.isFile() || stats.size === 0) {
    throw new Error(`Backup at ${backupFile} is missing or empty; refusing to continue.`);
  }

  return { backupFile, backupBytes: stats.size };
}

/** Merge the diagnostic verdict with the live row content recovery needs. */
function loadRecoveryTargets(diagnosis, options) {
  const readRow = db.prepare(`
    SELECT extracted_text, file_path, page_count
    FROM documents
    WHERE id = ?
  `);

  return diagnosis.documents
    .filter((document) => Boolean(selectRecoveryStrategy(document.category)))
    .filter(
      (document) => !options.documentId || document.documentId === options.documentId
    )
    .map((document) => {
      const row = readRow.get(document.documentId);

      return {
        ...document,
        extractedText: row?.extracted_text || "",
        filePath: row?.file_path || "",
        storedPageCount: row?.page_count ?? document.storedPageCount,
      };
    });
}

function formatEntry(entry) {
  const marks = {
    recovered: "OK  ",
    "needs-review": "REV ",
    failed: "FAIL",
    skipped: "SKIP",
  };
  const mark = marks[entry.result] || "????";
  const chunks = `${entry.previousChunkCount} -> ${entry.newChunkCount ?? "-"} chunks`;
  const text = `${entry.previousTextLength} -> ${entry.newTextLength ?? "-"} chars`;

  return (
    `${mark} #${entry.documentId} ${String(entry.originalFilename).slice(0, 58)}\n` +
    `       ${entry.strategy} | ${chunks} | ${text} | ${entry.durationMs}ms\n` +
    `       ${entry.newStatus || entry.previousStatus}${entry.detail ? ` | ${entry.detail}` : ""}` +
    (entry.ocrWarnings.length ? `\n       warnings: ${entry.ocrWarnings.join(" | ")}` : "")
  );
}

function formatHealth(label, health) {
  return [
    `${label}:`,
    `  Documents:                    ${health.totalDocuments}`,
    `  With chunks:                  ${health.documentsWithChunks}`,
    `  Zero-chunk:                   ${health.zeroChunkDocuments}`,
    `  Total chunks:                 ${health.totalChunks}`,
    `  completed_with_ocr documents: ${health.completedWithOcrDocuments}`,
    `  OCR warning documents:        ${health.ocrWarningDocuments}`,
    `  Extraction-failed documents:  ${health.extractionFailedDocuments}`,
    `  Chunks missing embeddings:    ${health.chunksMissingCurrentEmbedding}`,
  ].join("\n");
}

export async function runRecovery(options, { log = console.log } = {}) {
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..+$/, "")
    .replace("T", "-");

  log(options.apply ? "N0 recovery -- APPLY (writes)" : "N0 recovery -- DRY RUN (no writes)");
  log("Classifying zero-chunk documents (read-only diagnostic, no OCR probe)...");

  const diagnosis = await diagnoseZeroChunkDocuments({ ocrProbe: false });
  const before = readCorpusHealth(db);
  const allTargets = loadRecoveryTargets(diagnosis, options);
  const progressFile = resolveProgressFile(options.outputDir);
  const progress = options.resume
    ? await readProgress(progressFile)
    : { entries: {} };

  const pending = allTargets.filter(
    (document) => !options.resume || !isAlreadyComplete(progress, document.documentId)
  );
  const targets = options.limit ? pending.slice(0, options.limit) : pending;
  const alreadyDone = allTargets.length - pending.length;

  log("");
  log(formatHealth("BEFORE", before));
  log("");
  log(`Recovery targets: ${allTargets.length}` + (alreadyDone ? ` (${alreadyDone} already complete)` : ""));
  log(`Processing this run: ${targets.length}`);
  log("");

  let backup = null;

  if (options.apply && targets.length) {
    backup = await createPreRecoveryBackup(timestamp);
    log(`Backup: ${backup.backupFile} (${backup.backupBytes.toLocaleString()} bytes)`);
    log("");
  }

  const entries = [];

  for (const document of targets) {
    const entry = await recoverDocument(document, { apply: options.apply });
    entries.push(entry);
    log(formatEntry(entry));

    if (options.apply) {
      progress.entries[String(entry.documentId)] = {
        result: entry.result,
        newChunkCount: entry.newChunkCount,
        newTextLength: entry.newTextLength,
        newStatus: entry.newStatus,
        detail: entry.detail,
      };
      await writeProgress(progressFile, progress);
    }
  }

  const after = readCorpusHealth(db);
  const summary = summarizeEntries(entries);

  log("");
  log(formatHealth("AFTER", after));
  log("");
  log(
    `Results: recovered ${summary.recovered} | needs-review ${summary["needs-review"]} | ` +
      `failed ${summary.failed} | skipped ${summary.skipped}`
  );

  if (options.apply) {
    const newChunks = after.totalChunks - before.totalChunks;
    log(
      `Chunks created: ${newChunks} | chunks missing embeddings now: ` +
        `${after.chunksMissingCurrentEmbedding}`
    );
    log(`Progress journal: ${progressFile}`);
    log("");
    log("Next: embed the new chunks with the existing backfill (PAID OpenAI calls):");
    log("  npm run embed:backfill");
  } else {
    log("");
    log("Dry run only -- nothing was written. Re-run with --apply to commit.");
  }

  return { before, after, entries, summary, backup, progressFile };
}

async function runCli() {
  const options = parseArguments(process.argv.slice(2));

  try {
    await runRecovery(options);
  } catch (error) {
    console.error(error?.message || String(error));
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
