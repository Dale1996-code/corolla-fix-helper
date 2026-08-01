import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, beforeEach } from "node:test";

// The daily AI ceiling must survive a restart. It used to live in module memory,
// so a crash-restart loop -- the exact failure the cap exists to stop -- reset
// the counter every time and could spend straight past it.
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-fix-helper-budget-"));
process.env.DATABASE_FILE = path.join(tempRoot, "budget.db");
process.env.UPLOADS_DIR = path.join(tempRoot, "uploads");

const { db } = await import("../src/database.js");
const { initializeDatabase } = await import("../src/initDatabase.js");
const { reserveAiCall, readAiUsage, resetAiUsageBudgetForTests, AI_DAILY_LIMIT_MESSAGE } =
  await import("../src/services/aiUsageBudget.js");

initializeDatabase();

beforeEach(() => {
  resetAiUsageBudgetForTests();
});

after(() => {
  if (typeof db.close === "function") {
    db.close();
  }

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

const DAY = Date.UTC(2026, 6, 24, 10, 0, 0);
const NEXT_DAY = Date.UTC(2026, 6, 25, 10, 0, 0);

test("migration 004 creates the counter table", () => {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ai_usage_daily'")
    .get();

  assert.ok(row, "ai_usage_daily must exist");

  const applied = db
    .prepare("SELECT 1 FROM schema_migrations WHERE name = ?")
    .get("004_ai_usage_daily");

  assert.ok(applied, "the migration must be recorded");
});

test("the count is written to the database, not just memory", () => {
  reserveAiCall({ now: DAY, limit: 5 });
  reserveAiCall({ now: DAY, limit: 5 });

  const row = db.prepare("SELECT call_count FROM ai_usage_daily").get();

  assert.equal(row.call_count, 2);
});

test("a simulated restart does NOT reset the counter", () => {
  // Two calls against a limit of 2 exhausts the budget...
  reserveAiCall({ now: DAY, limit: 2 });
  reserveAiCall({ now: DAY, limit: 2 });

  // ...and a restart cannot clear it, because the count lives in SQLite. There
  // is no in-memory state to lose, which is the whole point: re-reading is what
  // a fresh process would do.
  assert.throws(
    () => reserveAiCall({ now: DAY, limit: 2 }),
    (error) => {
      assert.equal(error.message, AI_DAILY_LIMIT_MESSAGE);
      assert.equal(/** @type {any} */ (error).status, 429);
      return true;
    }
  );
});

test("a new calendar day starts a fresh row", () => {
  reserveAiCall({ now: DAY, limit: 1 });
  assert.throws(() => reserveAiCall({ now: DAY, limit: 1 }));

  assert.doesNotThrow(() => reserveAiCall({ now: NEXT_DAY, limit: 1 }));
  assert.equal(readAiUsage({ now: NEXT_DAY }).callCount, 1);
  // Yesterday's row is kept, so usage history is not silently destroyed.
  assert.equal(readAiUsage({ now: DAY }).callCount, 1);
});

test("a disabled ceiling writes nothing at all", () => {
  for (let index = 0; index < 20; index += 1) {
    reserveAiCall({ now: DAY, limit: 0 });
  }

  const row = db.prepare("SELECT count(*) c FROM ai_usage_daily").get();
  assert.equal(row.c, 0, "a disabled ceiling must not accumulate rows");
});

test("readAiUsage reports the current day's usage", () => {
  reserveAiCall({ now: DAY, limit: 10 });
  reserveAiCall({ now: DAY, limit: 10 });

  const usage = readAiUsage({ now: DAY });

  assert.equal(usage.callCount, 2);
  assert.equal(usage.dayKey, "2026-6-24");
});
