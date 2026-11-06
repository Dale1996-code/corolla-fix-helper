import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// Planner eval Phase 1a (docs/planner-eval-spec.md, section 14.2).
//
// repairTools.js holds the planner's pure tools: the task extractor, readiness,
// the owner checklist, inventory parsing. It used to import the retriever at the
// top of the file, and the retriever imports database.js, which OPENS THE REAL
// DATABASE as a side effect of being imported. So merely importing a pure
// function created (or opened) the owner's database file. That is what kept any
// offline tool -- an eval, a replay -- from using those functions "with no
// database".
//
// The fix is a lazy default retriever: loaded on first use, never at import.
// These tests pin both halves of that:
//   1. importing repairTools.js touches no database and creates no folders;
//   2. when no retriever is injected, the real one still loads and runs.
//
// Injection (the path every other planner test uses) is covered by
// repairPlanner.test.js, which must pass unchanged.

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repairToolsUrl = pathToFileURL(
  path.join(serverRoot, "src", "services", "agent", "repairTools.js")
).href;
const retrievalUrl = pathToFileURL(
  path.join(serverRoot, "src", "services", "chunkRetrievalService.js")
).href;

// The in-process half runs against a throwaway database. The environment is set
// before the dynamic imports, and the imports come before any test is
// registered, like every other database-backed test file in this folder.
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-lazy-default-"));
const extraRoots = [];

process.env.DATABASE_FILE = path.join(tempRoot, "test.db");
process.env.UPLOADS_DIR = path.join(tempRoot, "uploads");
// No key: retrieval must fall back to keyword ranking without an embedding call.
delete process.env.OPENAI_API_KEY;

const { db } = await import("../src/database.js");
const { initializeDatabase } = await import("../src/initDatabase.js");
const { createToolRegistry, searchRepairDocs } = await import(
  "../src/services/agent/repairTools.js"
);

initializeDatabase();

after(() => {
  // Close the database before deleting the folder that holds it.
  if (typeof db.close === "function") {
    db.close();
  }

  for (const target of [tempRoot, ...extraRoots]) {
    fs.rmSync(target, { recursive: true, force: true });
  }
});

/**
 * Import a module in a brand-new process whose database and uploads paths point
 * at a folder that does not exist yet, then report what appeared on disk.
 *
 * A separate process is the only honest test: this one has already imported
 * things, and a module is evaluated once per process.
 *
 * @param {string} moduleUrl
 * @param {string} [afterImport] code to run after the import; may print to stdout
 */
function importInFreshProcess(moduleUrl, afterImport = "") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-lazy-retriever-"));
  extraRoots.push(root);

  const dataDir = path.join(root, "data");
  const databaseFile = path.join(dataDir, "test.db");
  const uploadsDir = path.join(root, "uploads");

  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const loaded = await import(${JSON.stringify(moduleUrl)}); ${afterImport}`,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        DATABASE_FILE: databaseFile,
        UPLOADS_DIR: uploadsDir,
        OPENAI_API_KEY: "",
      },
    }
  );

  return {
    status: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    created: {
      dataDir: fs.existsSync(dataDir),
      databaseFile: fs.existsSync(databaseFile),
      uploadsDir: fs.existsSync(uploadsDir),
    },
  };
}

// --- Importing the pure tools touches no database ---------------------------

test("importing repairTools.js opens no database and creates no folders", () => {
  const result = importInFreshProcess(repairToolsUrl);

  assert.equal(result.status, 0, `the import itself must succeed: ${result.stderr}`);
  assert.deepEqual(
    result.created,
    { dataDir: false, databaseFile: false, uploadsDir: false },
    "importing the pure planner tools must not touch the database or uploads paths"
  );
});

test("the pure planner tools run in a process that never opens a database", () => {
  const result = importInFreshProcess(
    repairToolsUrl,
    `console.log(JSON.stringify({
       tasks: loaded.extractRepairTasks({ brief: "Replace the spark plugs" }).tasks.length,
       readiness: loaded.checkRepairReadiness({ tasks: [], skillLevel: "beginner" }).level,
     }));`
  );

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { tasks: 1, readiness: "not_ready" });
  assert.equal(result.created.databaseFile, false);
});

test("control: importing the retriever module does open the database", () => {
  // Without this, the tests above could pass because the detector sees nothing
  // at all (a wrong path, an unchanged working directory). This proves that a
  // real database import is visible to it.
  const result = importInFreshProcess(retrievalUrl);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.created.databaseFile, true);
  assert.equal(result.created.uploadsDir, true);
});

// --- The lazy default still works -------------------------------------------

function seedChunk(text) {
  const vehicle = db.prepare("SELECT id FROM vehicles ORDER BY id ASC LIMIT 1").get();
  assert.ok(vehicle);

  db.exec("DELETE FROM document_chunks");

  const documentId = Number(
    db
      .prepare(`
        INSERT INTO documents (
          vehicle_id, title, original_filename, stored_filename, file_path,
          file_type, system, document_type, extracted_text, extraction_status, page_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        vehicle.id,
        "Fixture filter notes",
        "fixture-filter.pdf",
        "fixture-filter.pdf",
        "server/uploads/fixture-filter.pdf",
        "application/pdf",
        "Engine",
        "Repair Manual",
        "",
        "completed",
        1
      ).lastInsertRowid
  );

  db.prepare(
    "INSERT INTO document_chunks (document_id, page_number, chunk_index, chunk_text) VALUES (?, 1, 0, ?)"
  ).run(documentId, text);

  return documentId;
}

test("searchRepairDocs with no injected retriever loads and runs the real one", async () => {
  const documentId = seedChunk("Fixture widget filter replacement: remove the widget cover.");

  const result = await searchRepairDocs({ query: "widget filter" });

  assert.equal(result.citations.length, 1, "the default retriever should find the seeded chunk");
  assert.equal(result.citations[0].documentId, documentId);
  assert.match(result.context, /widget filter replacement/i);
});

test("the tool registry's search tool uses the real retriever when none is injected", async () => {
  const documentId = seedChunk("Fixture gadget gasket replacement: seat the gasket evenly.");
  const registry = createToolRegistry({
    trusted: { tasks: [{ id: 1, title: "Replace the gadget gasket" }] },
  });

  const result = await registry.search_repair_docs({ taskId: 1, query: "gadget gasket" });

  assert.equal(result.citations.length, 1);
  assert.equal(result.citations[0].documentId, documentId);
});

test("an empty database yields no citations, not an error", async () => {
  db.exec("DELETE FROM document_chunks");

  const result = await searchRepairDocs({ query: "nothing is indexed" });

  assert.deepEqual(result.citations, []);
  assert.equal(result.context, "");
});
