// CLI: write a backup archive into a folder you choose.
//
// Usage:
//   npm run backup -- "D:\Backups"
//   npm run backup -- "D:\Backups" --no-verify
//
// The archive is the same one Settings -> Export backup downloads (database +
// uploads + manifest), named corolla-fix-helper-backup-<timestamp>.tar.gz. It is
// safe to run while the app is running: the database is read through SQLite's
// VACUUM INTO, which includes everything committed so far.
//
// Safety rules, each pinned by test/createBackup.test.js:
//   - It never overwrites or deletes an existing file. A name collision stops it.
//   - The archive is written as <name>.partial and renamed into place only once
//     it is complete (and, unless --no-verify, once a test restore of it passed),
//     so a .tar.gz in your folder is never half-written.
//   - A failed run removes only the .partial it created and leaves the "last
//     backup" record (backup-status.json) exactly as it was.
//   - It refuses a folder inside the uploads folder, which would make each
//     backup contain the one before it.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { config } from "../config.js";
import {
  createBackupArchive,
  isSameOrInside,
  verifyBackupArchive,
} from "../services/backupService.js";
import { backupStatusFileFor, recordSuccessfulBackup } from "../services/backupStatusService.js";

const USAGE = 'Usage: npm run backup -- "<folder>" [--no-verify]';

/**
 * Split the command line into the destination folder and whether to verify.
 * Returns `{ error }` for anything that is not one folder plus the optional
 * --no-verify, so a typo such as `--force` is refused rather than ignored.
 */
export function parseBackupArgs(argv) {
  let destination = null;
  let verify = true;

  for (const arg of argv) {
    if (arg === "--no-verify") {
      verify = false;
    } else if (arg.startsWith("--")) {
      return { error: `Unknown option ${arg}.\n${USAGE}` };
    } else if (destination === null) {
      destination = arg;
    } else {
      return { error: `Give one backup folder only.\n${USAGE}` };
    }
  }

  return destination === null ? { error: USAGE } : { destination, verify };
}

/**
 * Make one backup. Resolves with `{ archivePath, archiveBytes, verification,
 * statusRecorded }`, where `verification` is "passed" or "not_run"; rejects
 * with the reason otherwise, having left every existing file untouched.
 */
export async function runBackup({
  destinationDir,
  verify = true,
  databaseFile = config.databaseFile,
  uploadsDir = config.uploadsDir,
  statusFile = backupStatusFileFor(databaseFile),
  now = () => new Date(),
  logger = console,
}) {
  const destination = path.resolve(destinationDir);

  if (isSameOrInside(uploadsDir, destination)) {
    throw new Error(
      `The backup folder ${destination} is inside your uploads folder (${uploadsDir}), ` +
        "so every backup would contain the one before it. Choose a folder outside it."
    );
  }

  const stamp = now().toISOString().replace(/[:.]/g, "-");
  const archivePath = path.join(destination, `corolla-fix-helper-backup-${stamp}.tar.gz`);
  const partialPath = `${archivePath}.partial`;
  const alreadyExists = (target) =>
    new Error(`${target} already exists, so nothing was written. Nothing was overwritten.`);

  for (const target of [archivePath, partialPath]) {
    if (fs.existsSync(target)) {
      throw alreadyExists(target);
    }
  }

  fs.mkdirSync(destination, { recursive: true });

  let manifest;
  let verification = { state: "not_run", checkedAt: null };

  try {
    logger.log(`Creating the backup in ${destination} ...`);
    ({ manifest } = await createBackupArchive({
      databaseFile,
      uploadsDir,
      outFile: partialPath,
      now,
    }));

    if (verify) {
      logger.log("Verifying: unpacking the archive in a scratch folder and checking its database ...");
      await verifyBackupArchive({ archivePath: partialPath });
      verification = { state: "passed", checkedAt: now().toISOString() };
    }

    // The last look before the file takes its real name.
    if (fs.existsSync(archivePath)) {
      throw alreadyExists(archivePath);
    }

    fs.renameSync(partialPath, archivePath);
  } catch (error) {
    // Only the file this run created: its existence was ruled out above.
    fs.rmSync(partialPath, { force: true });
    throw error;
  }

  const archiveBytes = fs.statSync(archivePath).size;
  let statusRecorded = true;

  try {
    recordSuccessfulBackup({
      statusFile,
      backup: {
        createdAt: manifest.createdAt,
        source: "cli",
        archivePath,
        archiveBytes,
        verification,
      },
    });
  } catch (error) {
    // The archive is good; a note about it that cannot be saved must not turn a
    // finished backup into a failure.
    statusRecorded = false;
    logger.warn(
      `The backup was made, but the "last backup" note could not be saved: ${error.message}`
    );
  }

  return { archivePath, archiveBytes, verification: verification.state, statusRecorded };
}

function formatSize(bytes) {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.ceil(bytes / 1024))} KB`;
}

/** The lines to print after a successful backup. */
export function describeBackupSuccess({ archivePath, archiveBytes, verification, statusRecorded }) {
  const lines = [`Backup created: ${archivePath}`, `Size: ${formatSize(archiveBytes)}`];

  lines.push(
    verification === "passed"
      ? "Verified: the archive passed a test restore (it unpacked and its database passed SQLite's integrity check)."
      : "Not verified: no test restore was run (--no-verify). The file exists but has not been checked."
  );
  lines.push(
    statusRecorded
      ? "Settings will show this as the last backup."
      : "Settings will NOT show this backup, because its note could not be saved (see the warning above)."
  );
  lines.push("Keep a copy somewhere other than this computer.");

  return lines;
}

async function runCli() {
  const parsed = parseBackupArgs(process.argv.slice(2));

  if (parsed.error) {
    console.error(parsed.error);
    process.exitCode = 1;
    return;
  }

  try {
    const result = await runBackup({ destinationDir: parsed.destination, verify: parsed.verify });

    console.log("");

    for (const line of describeBackupSuccess(result)) {
      console.log(line);
    }
  } catch (error) {
    console.error("");
    console.error(`Backup failed: ${error?.message || String(error)}`);
    console.error("No existing file was changed, and the last-backup record was not updated.");
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCli();
}
