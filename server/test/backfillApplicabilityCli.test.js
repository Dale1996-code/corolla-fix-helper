import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";

// The `npm run backfill:applicability` command itself, run as a child process
// against throwaway database files -- the way the owner runs it. The dry run
// opens the database read-only, so it cannot migrate or write anything; only
// --apply initializes the database (applying migration 008) and tags chunks.

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(serverRoot, "src", "scripts", "backfillApplicability.js");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-fix-helper-backfill-cli-"));
process.env.DATABASE_FILE = path.join(tempRoot, "source.db");
process.env.UPLOADS_DIR = path.join(tempRoot, "uploads");

const { db } = await import("../src/database.js");
const { initializeDatabase } = await import("../src/initDatabase.js");
const { rebuildDocumentChunksFromPages } = await import("../src/services/documentChunkService.js");
const { parseArguments } = await import("../src/scripts/backfillApplicability.js");

initializeDatabase();
const vehicleId = db.prepare("SELECT id FROM vehicles LIMIT 1").get()?.id;
const documentId = Number(
  db
    .prepare(
      `INSERT INTO documents (vehicle_id, title, original_filename, stored_filename, system, document_type)
       VALUES (?, 'Specs', 'specs.pdf', 'specs-stored.pdf', 'Engine', 'Repair Manual')`
    )
    .run(vehicleId).lastInsertRowid
);
rebuildDocumentChunksFromPages(documentId, [
  { pageNumber: 1, text: "Vehicle > Engine > Torque Specifications (2AZ-FE) NOTICE: bolt 30 N*m" },
  { pageNumber: 2, text: "Bolt 40 N*m" },
]);
db.prepare("UPDATE document_chunks SET embedding = ?, embedding_version = 'model@3'").run(
  Buffer.from(new Float32Array([1, 0, -1]).buffer)
);

/** A copy of the source database as it was before migration 008. */
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

function runScript(databaseFile, args = []) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: serverRoot,
    encoding: "utf8",
    // NODE_TEST_CONTEXT rides along in process.env, so the child never loads
    // a local .env; the key is blanked anyway.
    env: { ...process.env, DATABASE_FILE: databaseFile, UPLOADS_DIR: process.env.UPLOADS_DIR, OPENAI_API_KEY: "" },
  });
}

function inspect(file) {
  const reader = new DatabaseSync(file, { readOnly: true });
  try {
    const columns = reader.prepare("PRAGMA table_info(document_chunks)").all().map((column) => column.name);
    return {
      hasScopeColumns: columns.includes("scope_at_start") && columns.includes("scope_version"),
      migrated: Boolean(
        reader.prepare("SELECT 1 FROM schema_migrations WHERE name = '008_document_chunk_applicability_scope'").get()
      ),
      tagged: columns.includes("scope_version")
        ? Number(reader.prepare("SELECT COUNT(*) AS c FROM document_chunks WHERE scope_version IS NOT NULL").get().c)
        : 0,
      embeddings: reader
        .prepare("SELECT id, embedding, embedding_version FROM document_chunks ORDER BY id")
        .all()
        .map((row) => ({ ...row })),
    };
  } finally {
    reader.close();
  }
}

after(() => {
  if (typeof db.close === "function") {
    db.close();
  }

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("parseArguments: dry run by default, --apply to write, --dry-run always wins", () => {
  assert.deepEqual(parseArguments([]), { apply: false, documentId: 0, limit: 0 });
  assert.deepEqual(parseArguments(["--apply", "--document-id", "7", "--limit", "3"]), {
    apply: true,
    documentId: 7,
    limit: 3,
  });
  assert.equal(parseArguments(["--apply", "--dry-run"]).apply, false);
  assert.equal(parseArguments(["--dry-run", "--apply"]).apply, false);
  assert.throws(() => parseArguments(["--aply"]), /Unknown option --aply/);
  assert.throws(() => parseArguments(["--limit", "0"]), /--limit needs a positive whole number/);
  assert.throws(() => parseArguments(["--document-id"]), /--document-id needs a positive whole number/);
});

test("the dry run reads a pre-008 database and changes nothing in it", () => {
  const file = preMigrationCopy("dry-run.db");
  const before = fs.readFileSync(file);

  const result = runScript(file);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /DRY RUN: nothing was written/);
  assert.match(result.stdout, /Would tag: 2 chunks in 1 document/);
  assert.match(result.stdout, /migration 008 has not run yet/);
  const after = inspect(file);
  assert.equal(after.hasScopeColumns, false);
  assert.equal(after.migrated, false);
  assert.ok(fs.readFileSync(file).equals(before), "the database file must be byte-identical");
});

test("--apply migrates the database, tags every chunk, and keeps the embeddings", () => {
  const file = preMigrationCopy("apply.db");
  const embeddingsBefore = inspect(file).embeddings;

  const result = runScript(file, ["--apply"]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Tagged: 2 chunks in 1 document/);
  assert.match(result.stdout, /Tagged at scope-v1 now: 2 of 2 chunks/);
  const after = inspect(file);
  assert.equal(after.migrated, true);
  assert.equal(after.tagged, 2);
  assert.deepEqual(after.embeddings, embeddingsBefore);

  const again = runScript(file, ["--apply"]);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /Tagged: 0 chunks in 0 documents/);
});

test("a database path that does not exist is refused, not created", () => {
  const missing = path.join(tempRoot, "no-such-folder", "typo.db");

  for (const args of [[], ["--apply"]]) {
    const result = runScript(missing, args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /No database at/);
  }
  assert.equal(fs.existsSync(path.dirname(missing)), false);
});

test("an unknown option stops the command before it opens the database", () => {
  const result = runScript(path.join(tempRoot, "never-opened.db"), ["--aply"]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown option --aply/);
});
