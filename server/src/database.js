import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.js";

fs.mkdirSync(path.dirname(config.databaseFile), { recursive: true });
fs.mkdirSync(config.uploadsDir, { recursive: true });

export const db = new DatabaseSync(config.databaseFile);

db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");
// Wait briefly for a competing writer instead of failing immediately with
// SQLITE_BUSY (e.g. an import/backfill script running alongside the server).
db.exec("PRAGMA busy_timeout = 5000;");

/**
 * Fold the write-ahead log into the main .db file, then close the connection.
 *
 * In WAL mode, committed rows can live only in the `-wal` sidecar until a
 * checkpoint. A process that exits without this leaves the .db file alone
 * incomplete, and anything that copies just that file loses data. After a
 * clean close SQLite also deletes the -wal/-shm files. Safe to call twice.
 */
export function closeDatabase() {
  if (!db.isOpen) {
    return;
  }

  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  } finally {
    db.close();
  }
}
