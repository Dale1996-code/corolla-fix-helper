// A coarse daily ceiling on OpenAI model calls.
//
// This is accidental-spend insurance for a single-user, local-first app — a
// backstop against a runaway agent loop or a stuck retry burning credit, NOT an
// abuse/authentication control. It counts actual Responses API calls (the
// choke points postToOpenAiResponses and streamResponsesTurn), resets each
// local day, and is disabled when config.openAiDailyCallLimit <= 0.
//
// PERSISTENT (migration 004_ai_usage_daily). The counter used to live in module
// memory, so every server restart reset it -- meaning the exact failure the cap
// exists to stop, a crash-restart loop, could spend straight past it. One row
// per local day in SQLite: the database is already the app's only durable store,
// so this adds no second persistence mechanism.

import { config } from "../config.js";
import { db } from "../database.js";

export const AI_DAILY_LIMIT_MESSAGE =
  "Daily AI usage limit reached. This is a safety cap to prevent accidental OpenAI spend — try again tomorrow or raise AI_DAILY_CALL_LIMIT.";

function dayKeyFor(timestamp) {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

let tableReady = false;

/**
 * Make sure the counter table exists before using it.
 *
 * Migration 004 creates it, but aiUsageBudget is reachable from services that
 * can be imported before initializeDatabase() runs (eval scripts, focused
 * tests). Relying on the migration alone made the ceiling silently fail open in
 * exactly those paths -- which defeats the guard rather than degrading it. The
 * statement is idempotent, so this costs one no-op per process.
 */
function ensureTable() {
  if (tableReady) {
    return true;
  }

  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ai_usage_daily (
        day_key TEXT PRIMARY KEY,
        call_count INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    tableReady = true;
  } catch {
    tableReady = false;
  }

  return tableReady;
}

/** Today's count, or 0 when the counter is unavailable. */
function readCount(dayKey) {
  if (!ensureTable()) {
    return 0;
  }

  try {
    const row = db
      .prepare("SELECT call_count FROM ai_usage_daily WHERE day_key = ?")
      .get(dayKey);

    return row ? Number(row.call_count) || 0 : 0;
  } catch {
    // Fail OPEN rather than blocking the app: this ceiling is spend insurance,
    // not a correctness gate.
    return 0;
  }
}

/**
 * Reserve one model call against today's budget, or throw when the ceiling is
 * reached. The thrown error carries `status = 429` so routes can answer with a
 * "too many requests" status instead of a 500. `now` is injectable for tests.
 */
export function reserveAiCall({ now = Date.now(), limit = config.openAiDailyCallLimit } = {}) {
  if (!limit || limit <= 0) {
    return; // ceiling disabled
  }

  const dayKey = dayKeyFor(now);

  if (readCount(dayKey) >= limit) {
    const error = new Error(AI_DAILY_LIMIT_MESSAGE);
    /** @type {any} */ (error).status = 429;
    throw error;
  }

  try {
    // Atomic increment. A read-then-write would let two concurrent Ask requests
    // both observe the same count and slip past the ceiling together.
    db.prepare(
      `INSERT INTO ai_usage_daily (day_key, call_count, updated_at)
       VALUES (?, 1, CURRENT_TIMESTAMP)
       ON CONFLICT(day_key) DO UPDATE SET
         call_count = call_count + 1,
         updated_at = CURRENT_TIMESTAMP`
    ).run(dayKey);
  } catch {
    // See readCount: never block a request because the counter could not be
    // written.
  }
}

/** Today's usage, for diagnostics. */
export function readAiUsage({ now = Date.now() } = {}) {
  const dayKey = dayKeyFor(now);

  return {
    dayKey,
    callCount: readCount(dayKey),
    limit: config.openAiDailyCallLimit,
  };
}

// Test-only: clear the persisted counter between cases.
export function resetAiUsageBudgetForTests() {
  if (!ensureTable()) {
    return;
  }

  try {
    db.prepare("DELETE FROM ai_usage_daily").run();
  } catch {
    // Nothing to reset.
  }
}
