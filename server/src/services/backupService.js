// Backup export + restore for the single-vehicle workspace.
//
// A backup is one `.tar.gz` whose root holds two entries:
//
//   database/<name>.db   the SQLite database file (config.databaseFile)
//   uploads/...          a copy of the uploaded PDFs (config.uploadsDir)
//   manifest.json        optional; written by createBackupArchive, ignored
//                        gracefully when an older archive omits it.
//
// Restore is deliberately fail-closed: it extracts and validates the archive
// first, snapshots the live database + uploads, and only then swaps the new
// data into place. Any failure during the swap rolls the snapshot back, so a
// bad or incompatible archive can never leave a half-written install behind.
//
// Every external dependency (extract, archive, filesystem, clock) is
// injectable so the logic is testable without a real tar binary or on-disk
// install, matching the DI convention used elsewhere in the server.

import fsDefault from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { resolveTarExecutable } from "./tarExecutable.js";
import { snapshotDatabase } from "./databaseSnapshot.js";

// First 16 bytes of every SQLite database file (the header string plus its
// terminating NUL). See https://www.sqlite.org/fileformat2.html#the_database_header
export const SQLITE_HEADER = "SQLite format 3\u0000";

export const BACKUP_DATABASE_DIRNAME = "database";
export const BACKUP_UPLOADS_DIRNAME = "uploads";
export const BACKUP_MANIFEST_FILENAME = "manifest.json";

// Bumped only when the on-disk archive layout changes in a breaking way.
export const BACKUP_FORMAT_VERSION = 1;

class BackupValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "BackupValidationError";
  }
}

export { BackupValidationError };

function timestampSlug(date) {
  return date.toISOString().replace(/[:.]/g, "-");
}

// Tables every Corolla Fix Helper workspace database must contain. A file that
// opens as SQLite but lacks these is not a real backup of this app and must be
// rejected before it can replace the live data.
export const REQUIRED_BACKUP_TABLES = ["documents", "symptoms", "procedures"];

/**
 * Deeply validate a SQLite database file.
 *
 * A 16-byte header check is not enough: any file beginning with the SQLite
 * magic string would pass. Instead, open the database read-only, run SQLite's
 * own `PRAGMA quick_check` integrity scan, and confirm the application's
 * required tables exist. Throws BackupValidationError on any failure.
 */
function assertValidApplicationDatabase(databaseFile) {
  let connection;

  try {
    connection = new DatabaseSync(databaseFile, { readOnly: true });
  } catch {
    throw new BackupValidationError(
      "Backup database file is not a valid SQLite database."
    );
  }

  try {
    let integrity;

    try {
      integrity = connection.prepare("PRAGMA quick_check").get();
    } catch {
      throw new BackupValidationError(
        "Backup database file is not a valid SQLite database."
      );
    }

    const status = integrity ? integrity.quick_check : null;

    if (status !== "ok") {
      throw new BackupValidationError(
        `Backup database failed its integrity check: ${status ?? "unknown"}.`
      );
    }

    const tableNames = new Set(
      connection
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => row.name)
    );

    const missing = REQUIRED_BACKUP_TABLES.filter(
      (table) => !tableNames.has(table)
    );

    if (missing.length > 0) {
      throw new BackupValidationError(
        `Backup database is missing required tables: ${missing.join(", ")}.`
      );
    }
  } finally {
    connection.close();
  }
}

function findDatabaseFile(databaseDir, fs) {
  const entries = fs
    .readdirSync(databaseDir, { withFileTypes: true })
    .filter((entry) => entry.isFile());

  if (entries.length === 0) {
    throw new BackupValidationError(
      `Backup archive ${BACKUP_DATABASE_DIRNAME}/ directory is empty.`
    );
  }

  const databaseFiles = entries.filter((entry) =>
    entry.name.toLowerCase().endsWith(".db")
  );
  const candidates = databaseFiles.length ? databaseFiles : entries;

  if (candidates.length > 1) {
    throw new BackupValidationError(
      `Backup archive ${BACKUP_DATABASE_DIRNAME}/ directory must contain exactly one database file.`
    );
  }

  return path.join(databaseDir, candidates[0].name);
}

function readManifest(rootDir, fs) {
  const manifestPath = path.join(rootDir, BACKUP_MANIFEST_FILENAME);

  if (!fs.existsSync(manifestPath)) {
    return null;
  }

  let manifest;

  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    throw new BackupValidationError("Backup manifest.json is not valid JSON.");
  }

  const version = Number(manifest?.formatVersion);

  if (Number.isInteger(version) && version > BACKUP_FORMAT_VERSION) {
    throw new BackupValidationError(
      `Backup format version ${version} is newer than this app supports (${BACKUP_FORMAT_VERSION}).`
    );
  }

  return manifest;
}

/**
 * Validate an already-extracted backup directory.
 *
 * Throws BackupValidationError when the structure is wrong, the database fails
 * its integrity check, a required table is missing, or the manifest version is
 * unsupported. Returns the resolved paths and parsed manifest on success.
 */
export function validateExtractedBackup(rootDir, { fs = fsDefault } = {}) {
  const databaseDir = path.join(rootDir, BACKUP_DATABASE_DIRNAME);
  const uploadsDir = path.join(rootDir, BACKUP_UPLOADS_DIRNAME);

  if (!fs.existsSync(databaseDir) || !fs.statSync(databaseDir).isDirectory()) {
    throw new BackupValidationError(
      `Backup archive is missing its ${BACKUP_DATABASE_DIRNAME}/ directory.`
    );
  }

  if (!fs.existsSync(uploadsDir) || !fs.statSync(uploadsDir).isDirectory()) {
    throw new BackupValidationError(
      `Backup archive is missing its ${BACKUP_UPLOADS_DIRNAME}/ directory.`
    );
  }

  const databaseFile = findDatabaseFile(databaseDir, fs);

  assertValidApplicationDatabase(databaseFile);

  const manifest = readManifest(rootDir, fs);

  return { databaseFile, uploadsDir, manifest };
}

function runTar(args) {
  return new Promise((resolve, reject) => {
    const tarProcess = spawn(resolveTarExecutable(), args, { shell: false });
    let stderr = "";

    tarProcess.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    tarProcess.on("error", () => {
      reject(new Error("tar is not available on this system."));
    });

    tarProcess.on("close", (exitCode) => {
      if (exitCode === 0) {
        resolve();
        return;
      }

      reject(new Error(`tar exited with code ${exitCode}: ${stderr.trim()}`));
    });
  });
}

async function defaultExtractArchive(archivePath, destDir) {
  await runTar(["-xzf", archivePath, "-C", destDir]);
}

async function defaultCreateArchive(stagingDir, outFile, entries) {
  await runTar(["-czf", outFile, "-C", stagingDir, ...entries]);
}

const SQLITE_SIDECAR_SUFFIXES = ["-wal", "-shm", "-journal"];

function removeSqliteSidecars(databaseFile, fs) {
  for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
    fs.rmSync(`${databaseFile}${suffix}`, { force: true });
  }
}

function copyTree(source, destination, fs) {
  fs.mkdirSync(destination, { recursive: true });
  fs.cpSync(source, destination, { recursive: true });
}

/**
 * Build a backup archive on disk from the live database + uploads.
 *
 * Mirrors the streaming export in routes/settings.js but writes a file, which
 * the CLI and the backup drill need. Adds an optional manifest.json.
 */
export async function createBackupArchive({
  databaseFile,
  uploadsDir,
  outFile,
  fs = fsDefault,
  createArchive = defaultCreateArchive,
  snapshot = snapshotDatabase,
  db = null,
  now = () => new Date(),
}) {
  if (!fs.existsSync(databaseFile)) {
    throw new Error(`Database file not found: ${databaseFile}`);
  }

  const stagingRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "corolla-fix-helper-backup-")
  );

  try {
    const stagedDatabaseDir = path.join(stagingRoot, BACKUP_DATABASE_DIRNAME);
    const stagedUploadsDir = path.join(stagingRoot, BACKUP_UPLOADS_DIRNAME);

    fs.mkdirSync(stagedDatabaseDir, { recursive: true });
    fs.mkdirSync(stagedUploadsDir, { recursive: true });

    const databaseFilename = path.basename(databaseFile);
    // Use a consistent SQLite snapshot rather than a raw file copy so committed
    // rows that still live in the WAL sidecar are never dropped from the backup.
    snapshot({
      sourceFile: databaseFile,
      destinationFile: path.join(stagedDatabaseDir, databaseFilename),
      db,
      fs,
    });

    if (fs.existsSync(uploadsDir)) {
      fs.cpSync(uploadsDir, stagedUploadsDir, { recursive: true });
    }

    const manifest = {
      formatVersion: BACKUP_FORMAT_VERSION,
      app: "corolla-fix-helper",
      createdAt: now().toISOString(),
      databaseFilename,
    };
    fs.writeFileSync(
      path.join(stagingRoot, BACKUP_MANIFEST_FILENAME),
      `${JSON.stringify(manifest, null, 2)}\n`
    );

    await createArchive(stagingRoot, outFile, [
      BACKUP_DATABASE_DIRNAME,
      BACKUP_UPLOADS_DIRNAME,
      BACKUP_MANIFEST_FILENAME,
    ]);

    return { outFile, manifest };
  } finally {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
  }
}

function snapshotLiveData({ databaseFile, uploadsDir, snapshotDir, fs }) {
  fs.mkdirSync(snapshotDir, { recursive: true });

  const snapshot = { dir: snapshotDir, databaseFile: null, uploadsDir: null };

  if (fs.existsSync(databaseFile)) {
    const snapshotDatabaseDir = path.join(snapshotDir, BACKUP_DATABASE_DIRNAME);
    fs.mkdirSync(snapshotDatabaseDir, { recursive: true });

    const snapshotDatabaseFile = path.join(
      snapshotDatabaseDir,
      path.basename(databaseFile)
    );
    fs.copyFileSync(databaseFile, snapshotDatabaseFile);
    snapshot.databaseFile = snapshotDatabaseFile;

    for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
      const sidecar = `${databaseFile}${suffix}`;

      if (fs.existsSync(sidecar)) {
        fs.copyFileSync(sidecar, `${snapshotDatabaseFile}${suffix}`);
      }
    }
  }

  if (fs.existsSync(uploadsDir)) {
    const snapshotUploadsDir = path.join(snapshotDir, BACKUP_UPLOADS_DIRNAME);
    copyTree(uploadsDir, snapshotUploadsDir, fs);
    snapshot.uploadsDir = snapshotUploadsDir;
  }

  return snapshot;
}

function rollbackFromSnapshot({ databaseFile, uploadsDir, snapshot, fs }) {
  removeSqliteSidecars(databaseFile, fs);

  if (snapshot.databaseFile) {
    fs.mkdirSync(path.dirname(databaseFile), { recursive: true });
    fs.copyFileSync(snapshot.databaseFile, databaseFile);

    for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
      const sidecar = `${snapshot.databaseFile}${suffix}`;

      if (fs.existsSync(sidecar)) {
        fs.copyFileSync(sidecar, `${databaseFile}${suffix}`);
      }
    }
  } else {
    fs.rmSync(databaseFile, { force: true });
  }

  fs.rmSync(uploadsDir, { recursive: true, force: true });

  if (snapshot.uploadsDir) {
    copyTree(snapshot.uploadsDir, uploadsDir, fs);
  }
}

function swapInRestoredData({ source, databaseFile, uploadsDir, fs }) {
  // Database: copy to a temp path on the target filesystem, then rename over
  // the live file (atomic within a directory). Drop stale WAL/SHM first so the
  // restored database is not reinterpreted through an old write-ahead log.
  fs.mkdirSync(path.dirname(databaseFile), { recursive: true });
  removeSqliteSidecars(databaseFile, fs);

  const tempDatabaseFile = `${databaseFile}.restore-${process.pid}`;
  fs.copyFileSync(source.databaseFile, tempDatabaseFile);
  fs.renameSync(tempDatabaseFile, databaseFile);

  // Uploads: replace the directory contents. The snapshot is the safety net,
  // so a clean wipe-then-copy is acceptable here.
  fs.rmSync(uploadsDir, { recursive: true, force: true });
  copyTree(source.uploadsDir, uploadsDir, fs);
}

/**
 * Restore a backup archive into the configured database file and uploads dir.
 *
 * Steps: extract -> validate -> snapshot live data -> atomically swap -> on any
 * failure during the swap, roll the snapshot back and rethrow. On success the
 * snapshot is kept (unless keepSnapshot is false) so the prior state remains
 * recoverable.
 *
 * IMPORTANT: this replaces the database file on disk. Run it with the server
 * stopped, or restart the server afterward, because the live SQLite connection
 * keeps a handle on the old file.
 */
export async function restoreBackup({
  archivePath,
  databaseFile,
  uploadsDir,
  fs = fsDefault,
  extractArchive = defaultExtractArchive,
  now = () => new Date(),
  keepSnapshot = true,
  logger = null,
}) {
  if (!archivePath) {
    throw new Error("A backup archive path is required.");
  }

  if (!fs.existsSync(archivePath)) {
    throw new Error(`Backup archive not found: ${archivePath}`);
  }

  const log = (message) => {
    if (logger && typeof logger.log === "function") {
      logger.log(message);
    }
  };

  const workDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "corolla-fix-helper-restore-")
  );

  let snapshot = null;
  let swapped = false;

  try {
    log(`Extracting ${archivePath} ...`);
    await extractArchive(archivePath, workDir);

    const source = validateExtractedBackup(workDir, { fs });
    log("Backup archive validated.");

    const snapshotDir = path.join(
      path.dirname(databaseFile),
      `pre-restore-${timestampSlug(now())}`
    );
    snapshot = snapshotLiveData({ databaseFile, uploadsDir, snapshotDir, fs });
    log(`Snapshotted current data to ${snapshotDir}`);

    swapped = true;
    swapInRestoredData({ source, databaseFile, uploadsDir, fs });
    log("Restore complete.");

    if (!keepSnapshot) {
      fs.rmSync(snapshot.dir, { recursive: true, force: true });
      snapshot = null;
    }

    return {
      databaseFile,
      uploadsDir,
      snapshotDir: snapshot ? snapshot.dir : null,
      manifest: source.manifest,
    };
  } catch (error) {
    if (swapped && snapshot) {
      log("Restore failed after swap; rolling back to the snapshot.");
      rollbackFromSnapshot({ databaseFile, uploadsDir, snapshot, fs });
    }

    if (snapshot && !keepSnapshot) {
      fs.rmSync(snapshot.dir, { recursive: true, force: true });
    }

    throw error;
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}
