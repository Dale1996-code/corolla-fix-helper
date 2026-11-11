// npm run backfill:applicability -- [--dry-run | --apply] [--document-id N] [--limit N]
//
// Store each chunk's applicability scope (N5 P2, docs/n5-applicability-design.md
// §7) for the library already saved. New and re-extracted documents get theirs
// from the chunk rebuild; this fills in the rest, and re-tags chunks whose scope
// came from older tagger rules.
//
// --dry-run is the default and writes nothing: the database is opened
// read-only, so not even migration 008 is applied. --apply is the only thing
// that writes. It initializes the database the way starting the app does
// (applying migration 008 if it is pending), then writes one document per
// transaction. Run it again after an interruption; it continues with the
// documents still to do. Stop the app first.
//
// Offline: it reads stored chunks only. No PDF, no model, no network, no
// OPENAI_API_KEY needed. Only the two scope columns are written; chunk text,
// embeddings, and embedding versions are left exactly as they are. Nothing in
// Ask, the planner, or retrieval reads the scope yet.

import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { config } from "../config.js";
import { runApplicabilityBackfill } from "../services/applicabilityBackfill.js";

const USAGE = "Use --dry-run (the default), --apply, --document-id N, --limit N.";

/**
 * @param {string[]} argv
 * @returns {{ apply: boolean, documentId: number, limit: number }}
 */
export function parseArguments(argv = []) {
  let sawApply = false;
  let sawDryRun = false;
  const options = { apply: false, documentId: 0, limit: 0 };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--apply") {
      sawApply = true;
    } else if (argument === "--dry-run") {
      sawDryRun = true;
    } else if (argument === "--document-id" || argument === "--limit") {
      const value = Number(argv[index + 1]);
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`${argument} needs a positive whole number.`);
      }
      options[argument === "--limit" ? "limit" : "documentId"] = value;
      index += 1;
    } else {
      throw new Error(`Unknown option ${argument}. ${USAGE}`);
    }
  }

  // Asked for both? Do the one that cannot write.
  options.apply = sawApply && !sawDryRun;
  return options;
}

const count = (value) => Number(value).toLocaleString("en-US");
const plural = (value, noun) => `${count(value)} ${noun}${value === 1 ? "" : "s"}`;

/** @param {ReturnType<typeof runApplicabilityBackfill>} summary */
export function formatSummary(summary) {
  const lines = [
    summary.applied
      ? "Applicability scope backfill (N5 P2): APPLIED."
      : "Applicability scope backfill (N5 P2): DRY RUN: nothing was written.",
    `Database: ${config.databaseFile}`,
    `Scope version: ${summary.scopeVersion}`,
    `Chunks in the library: ${count(summary.totalChunks)}`,
    `Already tagged at ${summary.scopeVersion}: ${count(summary.currentBefore)}`,
  ];
  if (summary.migrationPending) {
    lines.push("Note: migration 008 has not run yet, so no chunk has a scope. --apply applies it first.");
  }

  const documentNoun = (value) => plural(value, "document");
  if (summary.applied) {
    lines.push(`Tagged: ${plural(summary.taggedChunks, "chunk")} in ${documentNoun(summary.taggedDocuments)}`);
    lines.push(
      `Tagged at ${summary.scopeVersion} now: ${count(summary.currentAfter ?? 0)} of ${plural(summary.totalChunks, "chunk")}`
    );
  } else {
    const documentsWritable =
      summary.documentsToTag -
      summary.skipped.window_mismatch.length -
      summary.skipped.tagger_failed.length;
    lines.push(`Would tag: ${plural(summary.chunksToTag, "chunk")} in ${documentNoun(documentsWritable)}`);
  }

  const engines = Object.entries(summary.engineAtStart)
    .sort(([, left], [, right]) => right - left)
    .map(([label, value]) => `${label} ${count(value)}`);
  if (engines.length) {
    lines.push(`Engine scope at each chunk's first word: ${engines.join(", ")}`);
  }

  const { window_mismatch: windowMismatch, tagger_failed: taggerFailed, changed_during_run: changed } = summary.skipped;
  lines.push(
    `Left untouched: ${windowMismatch.length} (chunks do not follow the 200/40 word window), ` +
      `${taggerFailed.length} (tagger error), ${changed.length} (rebuilt during the run)`
  );
  for (const [label, ids] of /** @type {Array<[string, number[]]>} */ ([
    ["window mismatch", windowMismatch],
    ["tagger error", taggerFailed],
    ["rebuilt during the run", changed],
  ])) {
    if (ids.length) {
      lines.push(`  ${label}: document ${ids.join(", ")}`);
    }
  }

  lines.push(`Documents still to tag: ${count(summary.remainingDocuments)}`);
  if (!summary.applied && summary.chunksToTag > 0) {
    lines.push("Run again with --apply to write.");
  }
  return lines.join("\n");
}

/** @param {string[]} argv */
export async function runCli(argv = process.argv.slice(2)) {
  /** @type {DatabaseSync | undefined} */
  let readOnly;
  /** @type {(() => void) | undefined} */
  let close;

  try {
    const options = parseArguments(argv);

    // Opening a missing path would create an empty database there; a typo in
    // DATABASE_FILE must not quietly "succeed" against nothing.
    if (!fs.existsSync(config.databaseFile)) {
      throw new Error(`No database at ${config.databaseFile}. Check DATABASE_FILE.`);
    }

    let summary;
    if (options.apply) {
      // Loaded only here: importing the app's database module opens the file
      // read-write, which a dry run must never do.
      const database = await import("../database.js");
      const { initializeDatabase } = await import("../initDatabase.js");
      close = database.closeDatabase;
      initializeDatabase();
      summary = runApplicabilityBackfill(database.db, { ...options, withTransaction: database.withTransaction });
    } else {
      readOnly = new DatabaseSync(config.databaseFile, { readOnly: true });
      summary = runApplicabilityBackfill(readOnly, options);
    }

    console.log(formatSummary(summary));
  } catch (error) {
    console.error(error?.message || String(error));
    process.exitCode = 1;
  } finally {
    readOnly?.close();
    close?.();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCli();
}
