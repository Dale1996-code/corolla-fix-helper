// "Last backup" bookkeeping for Settings.
//
// One small JSON file, `backup-status.json`, sits in the same folder as the
// SQLite database. It is deliberately NOT a database table and NOT inside the
// uploads folder: a restore swaps the database file (with its sidecars) and the
// uploads folder, and it is never part of a backup archive, so restoring an
// older backup cannot rewind it into claiming a backup that never happened.
//
// It holds only the most recent successful backup. What Settings shows is not
// copied from the file but re-derived each time it is read: whether the archive
// is still on disk, whether it passed a test restore, and how old it is. The
// file never contains a verdict like "safe"; `assurance` is computed from what
// the app can actually see.
//
// Every filesystem call goes through an injectable `fs`, matching the other
// backup modules.

import fsDefault from "node:fs";
import path from "node:path";

export const BACKUP_STATUS_FILENAME = "backup-status.json";

// A backup older than this is flagged. Strictly greater: exactly seven days old
// is still current.
export const BACKUP_STALE_AFTER_DAYS = 7;

const STATUS_FORMAT_VERSION = 1;
const DAY_MS = 24 * 60 * 60 * 1000;
const SOURCES = new Set(["cli", "settings"]);
const VERIFICATION_STATES = new Set(["passed", "not_run"]);

/** Where the status file lives for a given database file. */
export function backupStatusFileFor(databaseFile) {
  return path.join(path.dirname(databaseFile), BACKUP_STATUS_FILENAME);
}

/**
 * Remember a backup that actually completed, replacing the previous record.
 *
 * `backup` is `{ createdAt, source, archivePath, archiveBytes, verification }`:
 * `source` is "cli" or "settings"; `archivePath` and `archiveBytes` are null
 * when the app cannot know where the file went (a browser download);
 * `verification` is `{ state: "passed" | "not_run", checkedAt }`.
 *
 * Written to a temporary file and renamed, so a crash mid-write leaves the old
 * record rather than a half-written one.
 */
export function recordSuccessfulBackup({ statusFile, backup, fs = fsDefault }) {
  fs.mkdirSync(path.dirname(statusFile), { recursive: true });

  const tempFile = `${statusFile}.${process.pid}.tmp`;
  const contents = { version: STATUS_FORMAT_VERSION, lastBackup: backup };

  try {
    fs.writeFileSync(tempFile, `${JSON.stringify(contents, null, 2)}\n`);
    fs.renameSync(tempFile, statusFile);
  } catch (error) {
    fs.rmSync(tempFile, { force: true });
    throw error;
  }
}

// The stored record, or null when there is none worth trusting. A missing,
// unreadable, or malformed file all mean "no backup recorded": Settings must
// never fail to load, or report a recent backup, because of a damaged note.
function readLastBackup(statusFile, fs) {
  let parsed;

  try {
    parsed = JSON.parse(fs.readFileSync(statusFile, "utf8"));
  } catch {
    return null;
  }

  const backup = parsed?.lastBackup;

  if (
    !backup ||
    typeof backup.createdAt !== "string" ||
    !Number.isFinite(Date.parse(backup.createdAt)) ||
    !SOURCES.has(backup.source) ||
    !VERIFICATION_STATES.has(backup.verification?.state)
  ) {
    return null;
  }

  return backup;
}

// What the app can see of the archive right now. "found" means a file of the
// recorded size exists; it is not a re-read of the contents.
function checkArchiveFile(backup, fs) {
  if (typeof backup.archivePath !== "string" || backup.archivePath === "") {
    return "not_checkable";
  }

  let stats;

  try {
    stats = fs.statSync(backup.archivePath);
  } catch {
    return "missing";
  }

  if (!stats.isFile()) {
    return "missing";
  }

  return stats.size === backup.archiveBytes ? "found" : "changed";
}

/**
 * The payload Settings shows for "Last backup".
 *
 * `assurance` is the one word the page leans on:
 *   verified  the file is still there AND it passed a test restore
 *   created   the file is still there but no test restore was run
 *   unknown   the file is missing or changed, or the app cannot see where it went
 */
export function describeLastBackup({
  statusFile,
  now = () => new Date(),
  fs = fsDefault,
}) {
  const backup = readLastBackup(statusFile, fs);

  if (!backup) {
    return { recorded: false, stale: true, staleAfterDays: BACKUP_STALE_AFTER_DAYS };
  }

  const file = checkArchiveFile(backup, fs);
  const verification = backup.verification.state;
  const ageMs = now().getTime() - Date.parse(backup.createdAt);

  let assurance = "unknown";

  if (file === "found") {
    assurance = verification === "passed" ? "verified" : "created";
  }

  return {
    recorded: true,
    createdAt: backup.createdAt,
    source: backup.source,
    destination: file === "not_checkable" ? null : backup.archivePath,
    archiveBytes: backup.archiveBytes ?? null,
    file,
    verification,
    verifiedAt: verification === "passed" ? (backup.verification.checkedAt ?? null) : null,
    assurance,
    ageDays: Math.max(0, Math.floor(ageMs / DAY_MS)),
    stale: ageMs > BACKUP_STALE_AFTER_DAYS * DAY_MS,
    staleAfterDays: BACKUP_STALE_AFTER_DAYS,
  };
}
