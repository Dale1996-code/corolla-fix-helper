import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-fix-helper-init-"));

process.env.DATABASE_FILE = path.join(tempRoot, "init.db");
process.env.UPLOADS_DIR = path.join(tempRoot, "uploads");
// Start with demo seeding off so the tests exercise the real production startup.
delete process.env.SEED_DEMO;

const { db } = await import("../src/database.js");
const { initializeDatabase } = await import("../src/initDatabase.js");

after(() => {
  if (typeof db.close === "function") {
    db.close();
  }

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("re-running init after the vehicle is renamed keeps exactly one vehicle", () => {
  initializeDatabase();

  // Simulate the user editing their vehicle details in Settings.
  db.prepare("UPDATE vehicles SET make = ?, trim = ?").run("Toyota (edited)", "Custom");

  // A second startup must not insert a duplicate "hidden" vehicle row.
  initializeDatabase();

  const vehicleCount = db.prepare("SELECT COUNT(*) AS count FROM vehicles").get().count;
  assert.equal(vehicleCount, 1);
});

test("production startup seeds no demo documents", () => {
  // SEED_DEMO is unset, so a fresh workspace must contain no sample documents.
  initializeDatabase();

  const documentCount = db
    .prepare("SELECT COUNT(*) AS count FROM documents")
    .get().count;
  assert.equal(documentCount, 0);
});

test("demo seeding creates a sample document whose file exists on disk", () => {
  process.env.SEED_DEMO = "true";

  try {
    initializeDatabase();
  } finally {
    delete process.env.SEED_DEMO;
  }

  const documents = db
    .prepare("SELECT stored_filename, file_path FROM documents")
    .all();

  assert.ok(documents.length >= 1, "demo seeding should create at least one document");

  for (const document of documents) {
    const fileName = path.basename(document.stored_filename || document.file_path || "");
    assert.ok(fileName, "document must reference a filename");

    const absolutePath = path.join(process.env.UPLOADS_DIR, fileName);
    assert.ok(
      fs.existsSync(absolutePath),
      `seeded document file should exist on disk: ${absolutePath}`
    );
  }
});

test("schema migrations are recorded once and not re-applied on repeated init", () => {
  initializeDatabase();
  initializeDatabase();

  const migrations = db
    .prepare("SELECT name FROM schema_migrations ORDER BY id")
    .all()
    .map((row) => row.name);

  assert.ok(
    migrations.includes("001_initial_schema"),
    "the initial schema migration should be recorded"
  );
  // Re-running init must not duplicate the migration row.
  assert.equal(
    migrations.filter((name) => name === "001_initial_schema").length,
    1
  );
});
