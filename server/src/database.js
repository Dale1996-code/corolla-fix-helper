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

let savepointSequence = 0;

/**
 * Run `fn` as one all-or-nothing unit of writes and return its result.
 *
 * The outermost call opens `BEGIN IMMEDIATE` and commits only if `fn` returns;
 * any throw rolls everything back and is rethrown. A call made while a
 * transaction is already open (`db.isTransaction`) nests as a SAVEPOINT instead:
 * its failure undoes only its own writes, and the rethrown error then reaches
 * the enclosing call, which decides whether the whole unit fails. That is what
 * lets a helper such as the chunk rebuild be atomic on its own and also be one
 * step of a larger write (persisting an extraction) without either knowing
 * about the other.
 *
 * `fn` must be synchronous. node:sqlite is synchronous, so a synchronous `fn`
 * cannot interleave with another request; an `await` inside would let other
 * writes land inside this transaction and the commit would run before `fn`
 * finished. A returned promise is therefore refused and rolled back.
 *
 * @template T
 * @param {() => T} fn
 * @returns {T}
 */
export function withTransaction(fn) {
  const nested = db.isTransaction;
  const savepoint = nested ? `with_transaction_${(savepointSequence += 1)}` : null;

  db.exec(nested ? `SAVEPOINT ${savepoint}` : "BEGIN IMMEDIATE TRANSACTION");

  try {
    const result = fn();

    if (result && typeof (/** @type {any} */ (result).then) === "function") {
      throw new TypeError("withTransaction needs a synchronous function; it returned a promise.");
    }

    db.exec(nested ? `RELEASE ${savepoint}` : "COMMIT");
    return result;
  } catch (error) {
    // SQLite rolls a transaction back by itself on some errors (SQLITE_FULL,
    // SQLITE_IOERR). Rolling back again would throw "no transaction is active"
    // and hide the error that actually explains the failure.
    if (db.isTransaction) {
      if (nested) {
        db.exec(`ROLLBACK TO ${savepoint}`);
        db.exec(`RELEASE ${savepoint}`);
      } else {
        db.exec("ROLLBACK");
      }
    }

    throw error;
  }
}

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
