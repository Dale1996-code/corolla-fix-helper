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
// first, copies the restored data beside the live data, and only then swaps it
// in with renames. The live database (with its WAL sidecars) and the live
// uploads folder are never deleted or overwritten: each is moved aside whole,
// so a failure is undone by moving it back. Every failure reports one of three
// outcomes (RESTORE_OUTCOMES) so the caller never has to guess what happened.
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

// What a failed restore did to the live data.
export const RESTORE_OUTCOMES = Object.freeze({
  // Nothing live was moved: the database and uploads are exactly as before.
  FAILED_BEFORE_CHANGE: "failed_before_change",
  // Something was moved, and every move was undone.
  ROLLED_BACK: "rolled_back",
  // Something was moved and at least one move could not be undone. Nothing
  // was deleted: `unrestoredMoves` says where each item now sits.
  ROLLBACK_FAILED: "rollback_failed",
});

/**
 * The only error restoreBackup rejects with. `message` is the underlying
 * failure's message and `cause` the underlying error; `outcome` is one of
 * RESTORE_OUTCOMES. A move is `{ from, to, holds }`, where `holds` is
 * "previous" (the owner's data, moved aside from `from`) or "restored" (the
 * backup's copy, moved into the live path `to`).
 */
export class RestoreError extends Error {
  /**
   * @param {string} message
   * @param {{
   *   outcome: string,
   *   cause?: unknown,
   *   databaseFile?: string | null,
   *   uploadsDir?: string | null,
   *   snapshotDir?: string | null,
   *   previousUploadsDir?: string | null,
   *   unrestoredMoves?: Array<{ from: string, to: string, holds: string }>,
   *   rollbackErrors?: unknown[],
   * }} details
   */
  constructor(
    message,
    {
      outcome,
      cause,
      databaseFile = null,
      uploadsDir = null,
      snapshotDir = null,
      previousUploadsDir = null,
      unrestoredMoves = [],
      rollbackErrors = [],
    }
  ) {
    super(message, { cause });
    this.name = "RestoreError";
    this.outcome = outcome;
    this.databaseFile = databaseFile;
    this.uploadsDir = uploadsDir;
    // Where the previous database and uploads sit when they were NOT moved
    // back (rollback_failed); null otherwise.
    this.snapshotDir = snapshotDir;
    this.previousUploadsDir = previousUploadsDir;
    this.unrestoredMoves = unrestoredMoves;
    this.rollbackErrors = rollbackErrors;
  }
}

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

function isSameOrInside(parentPath, childPath) {
  const relative = path.relative(path.resolve(parentPath), path.resolve(childPath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Decide every path the restore will use, refusing any that already exists.
 *
 * The restored copies are staged *beside* their live counterparts (same
 * folder, so the same volume) because the swap must be plain renames, and a
 * rename cannot cross volumes; the extracted archive itself sits under the OS
 * temp folder, which may be another drive.
 */
function planRestorePaths({ databaseFile, uploadsDir, slug, fs }) {
  if (isSameOrInside(uploadsDir, databaseFile)) {
    throw new Error(
      `The database file (${databaseFile}) is inside the uploads folder (${uploadsDir}), so restore cannot move one without the other. Point DATABASE_FILE outside UPLOADS_DIR.`
    );
  }

  const snapshotDir = path.join(path.dirname(databaseFile), `pre-restore-${slug}`);
  const plan = {
    snapshotDir,
    snapshotDatabaseFile: path.join(
      snapshotDir,
      BACKUP_DATABASE_DIRNAME,
      path.basename(databaseFile)
    ),
    previousUploadsDir: `${uploadsDir}.pre-restore-${slug}`,
    stagedDatabaseFile: `${databaseFile}.restore-${slug}`,
    stagedUploadsDir: `${uploadsDir}.restore-${slug}`,
    /** @type {Array<{ from: string, to: string, holds: string }>} */
    moves: [],
  };

  for (const target of [
    plan.snapshotDir,
    plan.previousUploadsDir,
    plan.stagedDatabaseFile,
    plan.stagedUploadsDir,
  ]) {
    if (fs.existsSync(target)) {
      throw new Error(`Restore target already exists: ${target}. Move it away and try again.`);
    }
  }

  return plan;
}

/**
 * Copy the validated backup beside the live data and list the renames that
 * swap it in. Only copies into new paths, so a failure here changes nothing
 * live.
 */
function stageRestoredData({ plan, source, databaseFile, uploadsDir, fs }) {
  fs.mkdirSync(path.dirname(databaseFile), { recursive: true });
  fs.copyFileSync(source.databaseFile, plan.stagedDatabaseFile);
  copyTree(source.uploadsDir, plan.stagedUploadsDir, fs);

  // Uploads go first. On Windows a PDF held open by a viewer makes the folder
  // rename fail (the whole rename is refused, nothing moves), and failing on
  // the very first move means the live install has not changed at all.
  if (fs.existsSync(uploadsDir)) {
    plan.moves.push({ from: uploadsDir, to: plan.previousUploadsDir, holds: "previous" });
  }

  plan.moves.push({ from: plan.stagedUploadsDir, to: uploadsDir, holds: "restored" });

  // The database moves together with its -wal/-shm/-journal sidecars: after an
  // unclean stop, committed rows can exist only in the -wal file, and a .db
  // separated from its WAL silently loses them.
  const liveDatabaseParts = ["", ...SQLITE_SIDECAR_SUFFIXES].filter((suffix) =>
    fs.existsSync(`${databaseFile}${suffix}`)
  );

  if (liveDatabaseParts.length > 0) {
    fs.mkdirSync(path.dirname(plan.snapshotDatabaseFile), { recursive: true });
  }

  for (const suffix of liveDatabaseParts) {
    plan.moves.push({
      from: `${databaseFile}${suffix}`,
      to: `${plan.snapshotDatabaseFile}${suffix}`,
      holds: "previous",
    });
  }

  plan.moves.push({ from: plan.stagedDatabaseFile, to: databaseFile, holds: "restored" });
}

function applyMoves(moves, fs) {
  const completed = [];

  try {
    for (const move of moves) {
      fs.renameSync(move.from, move.to);
      completed.push(move);
    }

    return { completed, error: null };
  } catch (error) {
    return { completed, error };
  }
}

/**
 * Undo completed moves, newest first, by renaming each item back. Never
 * deletes or overwrites anything: a move whose original path is occupied, or
 * whose rename back fails, is left where it is and reported.
 */
function undoMoves(completed, fs) {
  const unrestoredMoves = [];
  const rollbackErrors = [];

  for (const move of [...completed].reverse()) {
    try {
      if (fs.existsSync(move.from)) {
        throw new Error(`Cannot move ${move.to} back: ${move.from} is in the way.`);
      }

      fs.renameSync(move.to, move.from);
    } catch (error) {
      rollbackErrors.push(error);
      unrestoredMoves.unshift(move);
    }
  }

  return { unrestoredMoves, rollbackErrors };
}

/**
 * Remove what a failed restore created and no longer needs: the staged copies
 * of the backup (never the owner's data — "previous" moves only ever go to the
 * pre-restore paths) and the pre-restore folder if it is empty. Best effort: a
 * cleanup failure is logged and never replaces the restore's real outcome.
 */
function discardUnusedRestorePaths(plan, fs, log) {
  for (const stagedPath of [plan.stagedDatabaseFile, plan.stagedUploadsDir]) {
    try {
      fs.rmSync(stagedPath, { recursive: true, force: true });
    } catch (error) {
      log(`Could not remove the staged copy ${stagedPath}: ${errorMessage(error)}`);
    }
  }

  // rmdirSync only removes an empty folder, so this cannot delete data.
  for (const dir of [path.dirname(plan.snapshotDatabaseFile), plan.snapshotDir]) {
    try {
      fs.rmdirSync(dir);
    } catch {
      // Missing or not empty: either way, leave it.
    }
  }
}

/**
 * Restore a backup archive into the configured database file and uploads dir.
 *
 * Steps: extract -> validate -> copy the backup beside the live data -> swap
 * with renames. The live uploads folder is renamed aside to
 * `<uploadsDir>.pre-restore-<timestamp>` and the live database (with any
 * sidecars) into `pre-restore-<timestamp>/database/` next to it, then the
 * staged copies are renamed into place. No step deletes or overwrites live
 * data; on failure every completed rename is undone by renaming back.
 *
 * Resolves on success with `{ databaseFile, uploadsDir, snapshotDir,
 * previousUploadsDir, manifest }`; the two previous-data paths are null when
 * there was nothing to move aside or keepSnapshot is false. Rejects only with
 * a RestoreError whose `outcome` is one of RESTORE_OUTCOMES.
 *
 * IMPORTANT: run it only with the server stopped. Restarting afterward is not
 * a substitute: a running server keeps its handle on the database file. On
 * Windows that makes the move fail (rolled_back). On POSIX the move succeeds,
 * and every later write lands in the moved-aside previous database.
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
  const log = (message) => {
    if (logger && typeof logger.log === "function") {
      logger.log(message);
    }
  };

  const live = { databaseFile, uploadsDir };
  const failedBeforeChange = (error) =>
    new RestoreError(errorMessage(error), {
      outcome: RESTORE_OUTCOMES.FAILED_BEFORE_CHANGE,
      cause: error,
      ...live,
    });

  if (!archivePath) {
    throw failedBeforeChange(new Error("A backup archive path is required."));
  }

  if (!fs.existsSync(archivePath)) {
    throw failedBeforeChange(new Error(`Backup archive not found: ${archivePath}`));
  }

  let workDir = null;
  let plan = null;
  let manifest;

  try {
    // Phase 1: everything that can fail without touching live data.
    try {
      workDir = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-fix-helper-restore-"));
      log(`Extracting ${archivePath} ...`);
      await extractArchive(archivePath, workDir);

      const source = validateExtractedBackup(workDir, { fs });
      manifest = source.manifest;
      log("Backup archive validated.");

      plan = planRestorePaths({ databaseFile, uploadsDir, slug: timestampSlug(now()), fs });
      stageRestoredData({ plan, source, databaseFile, uploadsDir, fs });
      log("Backup copied beside the current data.");
    } catch (error) {
      if (plan) {
        discardUnusedRestorePaths(plan, fs, log);
      }

      throw failedBeforeChange(error);
    }

    // Phase 2: the swap, made only of renames.
    const { completed, error: swapError } = applyMoves(plan.moves, fs);

    if (!swapError) {
      const movedAside = (holdsPath) =>
        plan.moves.some((move) => move.holds === "previous" && isSameOrInside(holdsPath, move.to));
      const result = {
        ...live,
        snapshotDir: movedAside(plan.snapshotDir) ? plan.snapshotDir : null,
        previousUploadsDir: movedAside(plan.previousUploadsDir) ? plan.previousUploadsDir : null,
        manifest,
      };

      if (result.snapshotDir) {
        log(`Previous database moved to ${result.snapshotDir}`);
      }

      if (result.previousUploadsDir) {
        log(`Previous uploads moved to ${result.previousUploadsDir}`);
      }

      log("Restore complete.");

      if (!keepSnapshot) {
        // Success path only, and only because the caller asked for it. The
        // restore already succeeded, so a cleanup failure is logged, and the
        // path stays in the result because the folder is still there.
        for (const key of ["snapshotDir", "previousUploadsDir"]) {
          if (result[key]) {
            try {
              fs.rmSync(result[key], { recursive: true, force: true });
              result[key] = null;
            } catch (error) {
              log(`Could not remove ${result[key]}: ${errorMessage(error)}`);
            }
          }
        }
      }

      return result;
    }

    if (completed.length === 0) {
      log("Restore failed before anything was moved; nothing was changed.");
      discardUnusedRestorePaths(plan, fs, log);
      throw failedBeforeChange(swapError);
    }

    log("Restore failed partway; moving the previous data back.");
    const { unrestoredMoves, rollbackErrors } = undoMoves(completed, fs);

    if (unrestoredMoves.length === 0) {
      discardUnusedRestorePaths(plan, fs, log);
      log("Rollback complete: the previous data is back in place.");
      throw new RestoreError(errorMessage(swapError), {
        outcome: RESTORE_OUTCOMES.ROLLED_BACK,
        cause: swapError,
        ...live,
      });
    }

    log("Rollback failed. Nothing was deleted; see the recovery steps.");
    const stillAside = (holdsPath) =>
      unrestoredMoves.some(
        (move) => move.holds === "previous" && isSameOrInside(holdsPath, move.to)
      );

    throw new RestoreError(errorMessage(swapError), {
      outcome: RESTORE_OUTCOMES.ROLLBACK_FAILED,
      cause: swapError,
      ...live,
      snapshotDir: stillAside(plan.snapshotDir) ? plan.snapshotDir : null,
      previousUploadsDir: stillAside(plan.previousUploadsDir) ? plan.previousUploadsDir : null,
      unrestoredMoves,
      rollbackErrors,
    });
  } finally {
    if (workDir) {
      try {
        fs.rmSync(workDir, { recursive: true, force: true });
      } catch (error) {
        log(`Could not remove the temporary folder ${workDir}: ${errorMessage(error)}`);
      }
    }
  }
}
