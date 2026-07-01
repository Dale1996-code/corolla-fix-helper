// Consistent SQLite snapshots for backups.
//
// The database runs in WAL mode (see database.js), which means recently
// committed rows can live only in the `-wal` sidecar until a checkpoint folds
// them back into the main `.db` file. A plain file copy of the `.db` therefore
// risks silently omitting the newest committed data.
//
// `VACUUM INTO` reads the database through SQLite itself and writes a single,
// fully-checkpointed copy that includes everything committed at the moment it
// runs — WAL contents included — without modifying or locking out the live
// database. Both backup export paths funnel through here so a backup can never
// miss committed changes.

import fsDefault from "node:fs";
import { DatabaseSync } from "node:sqlite";

function escapeSqlitePath(filePath) {
  // VACUUM INTO takes a string literal, so single quotes must be doubled.
  return filePath.replace(/'/g, "''");
}

/**
 * Write a consistent snapshot of a SQLite database to `destinationFile`.
 *
 * Pass the live `db` connection when the server is running so the snapshot is
 * taken through the same connection that owns the WAL; otherwise a fresh
 * read connection is opened against `sourceFile` and closed afterward.
 *
 * `VACUUM INTO` requires the destination not to exist, so any stale file at
 * `destinationFile` is removed first.
 *
 * @param {{
 *   sourceFile?: string,
 *   destinationFile?: string,
 *   db?: import("node:sqlite").DatabaseSync | null,
 *   fs?: typeof import("node:fs"),
 * }} [options]
 */
export function snapshotDatabase({
  sourceFile,
  destinationFile,
  db = null,
  fs = fsDefault,
} = {}) {
  if (!destinationFile) {
    throw new Error("snapshotDatabase requires a destinationFile.");
  }

  if (!db && !sourceFile) {
    throw new Error("snapshotDatabase requires a sourceFile or a db connection.");
  }

  fs.rmSync(destinationFile, { force: true });

  const sql = `VACUUM INTO '${escapeSqlitePath(destinationFile)}'`;

  if (db) {
    db.exec(sql);
    return destinationFile;
  }

  const connection = new DatabaseSync(sourceFile);

  try {
    connection.exec(sql);
  } finally {
    connection.close();
  }

  return destinationFile;
}
