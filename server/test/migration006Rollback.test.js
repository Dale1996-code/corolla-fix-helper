import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

// Migration 006 adds five columns one ALTER at a time. If one of them fails,
// the ones before it must not survive: a half-applied profile would leave the
// app reading a schema no migration describes. runMigration wraps the body and
// its bookkeeping row in one transaction, and SQLite DDL is transactional, so a
// failure rolls ALL of it back. This proves that through the real code path.
//
// The failure is real, not mocked: a pre-existing column whose name differs from
// `transmission_code` only by case. ensureColumn compares names exactly, so it
// tries the ADD, and SQLite -- whose column names are case-insensitive -- refuses
// it as a duplicate. That happens on the THIRD column, after engine_code and
// build_plant were already added inside the transaction.

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-fix-helper-migration006-"));

process.env.DATABASE_FILE = path.join(tempRoot, "rollback.db");
process.env.UPLOADS_DIR = path.join(tempRoot, "uploads");

const { db } = await import("../src/database.js");
const { initializeDatabase } = await import("../src/initDatabase.js");

after(() => {
  if (typeof db.close === "function") {
    db.close();
  }

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function vehicleColumns() {
  return db.prepare("PRAGMA table_info(vehicles)").all().map((column) => column.name);
}

function migrationNames() {
  return db.prepare("SELECT name FROM schema_migrations ORDER BY name").all().map((row) => row.name);
}

test("a failure partway through migration 006 rolls every column back and records nothing", () => {
  db.exec(`
    CREATE TABLE vehicles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      year INTEGER NOT NULL,
      make TEXT NOT NULL,
      model TEXT NOT NULL,
      trim TEXT,
      engine TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      Transmission_Code TEXT
    );
    INSERT INTO vehicles (year, make, model, trim, engine, Transmission_Code)
    VALUES (2009, 'Toyota', 'Corolla', 'LE', '1.8L', 'keep-me');
  `);

  assert.throws(() => initializeDatabase(), /duplicate column name/i);

  const columns = vehicleColumns();
  assert.ok(!columns.includes("engine_code"), "engine_code survived a rolled-back migration");
  assert.ok(!columns.includes("build_plant"), "build_plant survived a rolled-back migration");
  assert.ok(!columns.includes("has_vsc"));
  assert.ok(!migrationNames().includes("006_vehicle_applicability_profile"));
  assert.ok(migrationNames().includes("005_repair_checklist_provenance"), "earlier migrations stay applied");

  const row = db.prepare("SELECT * FROM vehicles").get();
  assert.equal(row.engine, "1.8L");
  assert.equal(row.Transmission_Code, "keep-me");
});

test("once the conflict is removed, migration 006 applies cleanly on the same database", () => {
  db.exec("ALTER TABLE vehicles DROP COLUMN Transmission_Code");

  assert.doesNotThrow(() => initializeDatabase());

  assert.ok(migrationNames().includes("006_vehicle_applicability_profile"));
  const row = db.prepare("SELECT * FROM vehicles").get();
  assert.equal(row.engine, "1.8L");
  assert.equal(row.engine_code, null);
  assert.equal(row.build_plant, null);
  assert.equal(row.transmission_code, null);
  assert.equal(row.has_vsc, null);
  assert.equal(row.has_smart_key, null);
});
