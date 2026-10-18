// CLI: restore a corolla-fix-helper-backup-*.tar.gz into the configured
// database file and uploads directory.
//
// Usage:
//   npm run restore -- "/path/to/corolla-fix-helper-backup-....tar.gz"
//
// The restore validates the archive, copies it beside the current data, then
// swaps it in with renames. If anything goes wrong it moves the previous data
// back, and this script reports exactly which of those happened.
//
// Stop the dev/prod server before running this (or restart it afterward): the
// live SQLite connection holds a handle on the database file being replaced.

import path from "node:path";
import { pathToFileURL } from "node:url";
import { config } from "../config.js";
import { RESTORE_OUTCOMES, restoreBackup } from "../services/backupService.js";

const LOCKED_FILE_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

function lockedFileHint(error) {
  const code = error?.cause?.code ?? error?.code;

  return LOCKED_FILE_CODES.has(code)
    ? [
        "A file was locked or in use. Stop the app and close any program that has one of",
        "your uploaded PDFs or the database open, then run the restore again.",
      ]
    : [];
}

/**
 * The lines to print after a successful restore.
 */
export function describeRestoreSuccess(result) {
  const lines = [
    "Restore succeeded.",
    `Database file: ${result.databaseFile}`,
    `Uploads dir:   ${result.uploadsDir}`,
  ];

  if (result.snapshotDir) {
    lines.push(`Previous database kept at: ${result.snapshotDir}`);
  }

  if (result.previousUploadsDir) {
    lines.push(`Previous uploads kept at:  ${result.previousUploadsDir}`);
  }

  if (result.snapshotDir || result.previousUploadsDir) {
    lines.push("Delete the previous data once you have confirmed the restore.");
  }

  return lines;
}

/**
 * The lines to print after a failed restore. They state only what the
 * RestoreError's outcome proves; an error without an outcome claims nothing.
 */
export function describeRestoreFailure(error, { databaseFile, uploadsDir }) {
  const lines = [`Restore failed: ${error?.message || String(error)}`];

  switch (error?.outcome) {
    case RESTORE_OUTCOMES.FAILED_BEFORE_CHANGE:
      lines.push("Nothing was changed: your database and uploads are exactly as they were.");
      lines.push(...lockedFileHint(error));
      return lines;

    case RESTORE_OUTCOMES.ROLLED_BACK:
      lines.push(
        "The restore was rolled back: your previous database and uploads were moved back into place,",
        "and nothing was deleted.",
        `  Database file: ${databaseFile}`,
        `  Uploads dir:   ${uploadsDir}`,
        ...lockedFileHint(error)
      );
      return lines;

    case RESTORE_OUTCOMES.ROLLBACK_FAILED: {
      const rollbackMessages = (error.rollbackErrors || []).map(
        (rollbackError) => rollbackError?.message || String(rollbackError)
      );
      lines.push(
        `The rollback also failed: ${rollbackMessages.join("; ") || "unknown error"}`,
        "Your data is NOT fully back in place, but nothing was deleted. It is here:"
      );

      if (error.snapshotDir) {
        lines.push(`  Previous database: ${error.snapshotDir}`);
      }

      if (error.previousUploadsDir) {
        lines.push(`  Previous uploads:  ${error.previousUploadsDir}`);
      }

      // Clear the restored copies out of the way first, then put each
      // original back where the app looks for it.
      const moves = error.unrestoredMoves || [];
      const steps = [
        ...moves
          .filter((move) => move.holds === "restored")
          .map(
            (move) =>
              `${move.to} holds the restored backup, not your data: rename it or move it out of the way.`
          ),
        ...moves
          .filter((move) => move.holds === "previous")
          .map((move) => `Move ${move.to} back to ${move.from}`),
      ];

      lines.push("To recover, stop the app, then:");
      steps.forEach((step, index) => lines.push(`  ${index + 1}. ${step}`));
      lines.push(
        `  ${steps.length + 1}. Start the app and check that your documents and PDFs are back.`,
        "Do not delete any pre-restore folder until the app shows your data again."
      );
      return lines;
    }

    default:
      lines.push(
        "The restore could not tell whether your data was changed. Stop the app and, before",
        "doing anything else, look for a pre-restore-<timestamp> folder in",
        `  ${path.dirname(databaseFile)}`,
        "and an uploads.pre-restore-<timestamp> folder in",
        `  ${path.dirname(uploadsDir)}`
      );
      return lines;
  }
}

async function runCli() {
  const archiveArg = process.argv[2];

  if (!archiveArg) {
    console.error(
      'Usage: npm run restore -- "/path/to/corolla-fix-helper-backup-....tar.gz"'
    );
    process.exitCode = 1;
    return;
  }

  const archivePath = path.resolve(archiveArg);
  const live = { databaseFile: config.databaseFile, uploadsDir: config.uploadsDir };

  try {
    const result = await restoreBackup({ archivePath, ...live, logger: console });

    console.log("");

    for (const line of describeRestoreSuccess(result)) {
      console.log(line);
    }
  } catch (error) {
    console.error("");

    for (const line of describeRestoreFailure(error, live)) {
      console.error(line);
    }

    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCli();
}
