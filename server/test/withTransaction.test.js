import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, beforeEach } from "node:test";

// withTransaction (audit 1B-04) is the one way to make several writes
// all-or-nothing. Its contract: the outermost call commits or rolls back as a
// whole; a nested call is a savepoint whose failure undoes only its own writes
// and then reaches the enclosing call; a promise-returning function is refused.
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-fix-helper-with-transaction-"));
process.env.DATABASE_FILE = path.join(tempRoot, "tx.db");
process.env.UPLOADS_DIR = path.join(tempRoot, "uploads");

const { db, withTransaction } = await import("../src/database.js");

db.exec("CREATE TABLE IF NOT EXISTS tx_probe (value TEXT NOT NULL UNIQUE)");

after(() => {
  if (typeof db.close === "function") {
    db.close();
  }

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

beforeEach(() => {
  db.exec("DELETE FROM tx_probe");
});

const insert = (value) => db.prepare("INSERT INTO tx_probe (value) VALUES (?)").run(value);
const values = () =>
  db.prepare("SELECT value FROM tx_probe ORDER BY value").all().map((row) => row.value);

test("the outermost call commits and returns the function's result", () => {
  const result = withTransaction(() => {
    insert("a");
    insert("b");
    return "done";
  });

  assert.equal(result, "done");
  assert.deepEqual(values(), ["a", "b"]);
  assert.equal(db.isTransaction, false);
});

test("a throw rolls every write back and rethrows the original error", () => {
  const failure = new Error("boom");

  assert.throws(
    () =>
      withTransaction(() => {
        insert("a");
        throw failure;
      }),
    (error) => error === failure
  );

  assert.deepEqual(values(), []);
  assert.equal(db.isTransaction, false);
});

test("a nested failure caught by the caller undoes only the nested writes", () => {
  withTransaction(() => {
    insert("outer");

    assert.throws(() =>
      withTransaction(() => {
        insert("inner");
        insert("inner"); // UNIQUE violation inside the savepoint
      })
    );

    insert("after");
  });

  assert.deepEqual(values(), ["after", "outer"]);
  assert.equal(db.isTransaction, false);
});

test("a nested failure left to propagate rolls back the whole outer unit", () => {
  assert.throws(() =>
    withTransaction(() => {
      insert("outer");
      withTransaction(() => {
        insert("inner");
        throw new Error("inner step failed");
      });
    })
  );

  assert.deepEqual(values(), []);
  assert.equal(db.isTransaction, false);
});

test("a nested success commits only when the outer call does", () => {
  assert.throws(() =>
    withTransaction(() => {
      withTransaction(() => insert("inner"));
      throw new Error("outer step failed after the savepoint was released");
    })
  );

  assert.deepEqual(values(), []);
});

test("a function that returns a promise is refused and rolled back", async () => {
  assert.throws(
    () =>
      withTransaction(async () => {
        insert("a");
      }),
    TypeError
  );

  assert.deepEqual(values(), []);
  assert.equal(db.isTransaction, false);
});
