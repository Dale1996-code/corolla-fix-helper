// CLI: restore a corolla-fix-helper-backup-*.tar.gz into the configured
// database file and uploads directory.
//
// Usage:
//   npm run restore -- "/path/to/corolla-fix-helper-backup-....tar.gz"
//
// The restore validates the archive, snapshots the current data, then swaps the
// backup in atomically. If anything goes wrong it rolls back to the snapshot.
//
// Stop the dev/prod server before running this (or restart it afterward): the
// live SQLite connection holds a handle on the database file being replaced.

import path from "node:path";
import { pathToFileURL } from "node:url";
import { config } from "../config.js";
import { restoreBackup } from "../services/backupService.js";

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

  try {
    const result = await restoreBackup({
      archivePath,
      databaseFile: config.databaseFile,
      uploadsDir: config.uploadsDir,
      logger: console,
    });

    console.log("");
    console.log("Restore succeeded.");
    console.log(`Database file: ${result.databaseFile}`);
    console.log(`Uploads dir:   ${result.uploadsDir}`);

    if (result.snapshotDir) {
      console.log(`Previous data preserved at: ${result.snapshotDir}`);
      console.log("Delete that folder once you have confirmed the restore.");
    }
  } catch (error) {
    console.error("");
    console.error(`Restore failed: ${error.message || String(error)}`);
    console.error("Your existing data was left in place.");
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCli();
}
