import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-fix-helper-workspace-"));

process.env.DATABASE_FILE = path.join(tempRoot, "workspace.db");
process.env.UPLOADS_DIR = path.join(tempRoot, "uploads");
// Deliberately leave SEED_DEMO unset: this suite verifies the default,
// empty-workspace startup (no demo/sample documents).
delete process.env.SEED_DEMO;

const { db } = await import("../src/database.js");
const { initializeDatabase } = await import("../src/initDatabase.js");

function countVehicles() {
  return db.prepare("SELECT COUNT(*) AS n FROM vehicles").get().n;
}

function countDocuments() {
  return db.prepare("SELECT COUNT(*) AS n FROM documents").get().n;
}

after(() => {
  if (typeof db.close === "function") {
    db.close();
  }

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("a fresh install starts empty: one vehicle, no documents", () => {
  initializeDatabase();

  assert.equal(countDocuments(), 0, "fresh install must not seed any documents");
  assert.equal(countVehicles(), 1, "fresh install seeds exactly one vehicle");
});

test("editing the vehicle does not spawn a duplicate on restart", () => {
  initializeDatabase();

  const vehicle = db.prepare("SELECT id FROM vehicles ORDER BY id ASC LIMIT 1").get();
  db.prepare("UPDATE vehicles SET trim = ? WHERE id = ?").run("XLE", vehicle.id);

  // Restart: re-running init must reuse the existing (edited) vehicle rather
  // than matching on exact attributes and inserting a second one.
  initializeDatabase();

  assert.equal(countVehicles(), 1, "re-running init must not add a second vehicle");
});
