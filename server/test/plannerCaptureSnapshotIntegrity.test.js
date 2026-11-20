import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// The 6-pilot found that loading the real agent opened the evaluation snapshot
// WRITABLE (database.js) and set journal_mode = WAL, which rewrote the file's
// header: the snapshot a baseline names in Table 0 was no longer the file on
// disk, so a second session against it could not match. These tests pin the
// fix: a paid capture reads the snapshot only, runs the agent against a
// throwaway copy, and checks the original is byte-identical when it ends.
//
// NO paid call is made. The child process gets a fake key, and a preload makes
// every network call throw, so the first model turn fails before anything
// leaves the machine; the agent's import (which opens the database) still runs.

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, "..");
const SCRIPT = path.join(serverRoot, "src", "scripts", "capturePlanner.js");
const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-planner-snapshot-integrity-"));

after(() => {
  fs.rmSync(scratchRoot, { recursive: true, force: true });
});

const sha256 = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const md5 = (file) => createHash("md5").update(fs.readFileSync(file)).digest("hex");

/** A real, tiny VACUUM INTO snapshot: rollback-journal mode, no sidecar, invented text only. */
function makeSnapshot(folder) {
  fs.mkdirSync(folder, { recursive: true });
  const source = path.join(folder, "source.db");
  const snapshot = path.join(folder, "snapshot.db");
  const database = new DatabaseSync(source);

  database.exec(`
    CREATE TABLE documents (id INTEGER PRIMARY KEY, title TEXT, extracted_text TEXT);
    CREATE TABLE document_chunks (id INTEGER PRIMARY KEY, document_id INTEGER, page_number INTEGER, chunk_text TEXT);
    CREATE TABLE vehicles (id INTEGER PRIMARY KEY, engine_code TEXT, build_plant TEXT);
    INSERT INTO documents (id, title, extracted_text) VALUES (1, 'Invented service note', 'Invented text for a test.');
    INSERT INTO document_chunks (document_id, page_number, chunk_text) VALUES (1, 1, 'Invented text for a test.');
    INSERT INTO vehicles (id, engine_code, build_plant) VALUES (1, NULL, NULL);
  `);
  database.exec(`VACUUM INTO '${snapshot.replace(/'/g, "''")}'`);
  database.close();
  fs.rmSync(source);
  return snapshot;
}

const siblings = (file) => fs.readdirSync(path.dirname(file)).sort();

test("a real paid-mode capture leaves the snapshot byte-identical, with no sidecar beside it", () => {
  const folder = path.join(scratchRoot, "child");
  const snapshot = makeSnapshot(path.join(folder, "snapshot-folder"));
  const before = { sha: sha256(snapshot), md5: md5(snapshot), siblings: siblings(snapshot) };
  const preload = path.join(folder, "no-network.mjs");
  const outputDir = path.join(folder, "captures");
  const workingRoot = path.join(folder, "working");

  fs.writeFileSync(preload, 'globalThis.fetch = () => { throw new Error("no network in this test"); };\n');
  fs.mkdirSync(workingRoot, { recursive: true });

  const run = spawnSync(
    process.execPath,
    [
      "--import",
      pathToFileURL(preload).href,
      SCRIPT,
      "--no-dry-run",
      "--yes",
      "--scenario",
      "S1-oil-and-filter",
      "--max-provider-requests",
      "5",
      "--output-dir",
      outputDir,
      "--working-dir",
      workingRoot,
    ],
    {
      // cwd is the scratch folder, so no server/.env can be found; NODE_TEST_CONTEXT
      // (inherited) also stops config.js from loading one.
      cwd: folder,
      env: {
        ...process.env,
        DATABASE_FILE: snapshot,
        UPLOADS_DIR: path.join(folder, "uploads"),
        OPENAI_API_KEY: "test-key-not-real",
        NETWORK_MODE: "0",
        EVAL_CASE_DELAY_MS: "0",
      },
      encoding: "utf8",
    }
  );
  const output = `${run.stdout}\n${run.stderr}`;

  assert.match(run.stdout, /Writing /, `the run got past every guard and loaded the real agent:\n${output}`);
  assert.equal(sha256(snapshot), before.sha, `the snapshot's bytes changed:\n${output}`);
  assert.deepEqual(siblings(snapshot), before.siblings, "nothing (no -wal, no -shm) appeared beside the snapshot");

  const [captureName] = fs.readdirSync(outputDir).filter((name) => name.endsWith(".jsonl") && !name.includes(".rejected."));
  const header = JSON.parse(fs.readFileSync(path.join(outputDir, captureName), "utf8").split("\n")[0]);

  assert.equal(header.corpus.dbSnapshotMd5, before.md5, "Table 0's MD5 is the snapshot as it is on disk");
  assert.match(run.stdout, /snapshot unchanged/i, "the tool says it checked the original afterwards");
  assert.deepEqual(fs.readdirSync(workingRoot), [], "the working copy was removed");
});
