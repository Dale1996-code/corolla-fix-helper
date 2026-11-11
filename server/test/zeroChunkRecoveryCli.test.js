import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";

// `npm run recover:zero-chunks -- --apply` rebuilds chunks, and since N5 P2 the
// rebuild writes document_chunks.scope_at_start / scope_version. On a database
// that has not yet run migration 008 (say, a backup restored before the app was
// started again) that write would fail on the missing columns, so --apply must
// bring the schema up to date first, as `npm run import` and startup do. A dry
// run must not: it writes nothing, schema included.

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(serverRoot, "src", "scripts", "recoverZeroChunkDocuments.js");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-fix-helper-recover-cli-"));
process.env.DATABASE_FILE = path.join(tempRoot, "source.db");
process.env.UPLOADS_DIR = path.join(tempRoot, "uploads");

const { db } = await import("../src/database.js");
const { initializeDatabase } = await import("../src/initDatabase.js");

initializeDatabase();

after(() => {
  if (typeof db.close === "function") {
    db.close();
  }

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function preMigrationCopy(name) {
  const file = path.join(tempRoot, name);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const copy = new DatabaseSync(file);
  copy.exec("ALTER TABLE document_chunks DROP COLUMN scope_at_start");
  copy.exec("ALTER TABLE document_chunks DROP COLUMN scope_version");
  copy.prepare("DELETE FROM schema_migrations WHERE name = '008_document_chunk_applicability_scope'").run();
  copy.close();
  return file;
}

function hasMigration008(file) {
  const reader = new DatabaseSync(file, { readOnly: true });
  try {
    return Boolean(
      reader.prepare("SELECT 1 FROM schema_migrations WHERE name = '008_document_chunk_applicability_scope'").get()
    );
  } finally {
    reader.close();
  }
}

function runRecovery(databaseFile, args) {
  return spawnSync(process.execPath, [script, ...args, "--out", path.join(tempRoot, "out")], {
    cwd: serverRoot,
    encoding: "utf8",
    env: { ...process.env, DATABASE_FILE: databaseFile, OPENAI_API_KEY: "" },
  });
}

test("--apply brings a pre-008 database up to date before it can rebuild chunks", () => {
  const file = preMigrationCopy("apply.db");

  const result = runRecovery(file, ["--apply"]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(hasMigration008(file), true);
});

test("a dry run leaves a pre-008 database unmigrated", () => {
  const file = preMigrationCopy("dry-run.db");

  const result = runRecovery(file, ["--dry-run"]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(hasMigration008(file), false);
});
