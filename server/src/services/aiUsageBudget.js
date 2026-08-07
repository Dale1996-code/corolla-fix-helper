// A coarse daily ceiling on OpenAI model calls, plus the daily call count the
// Settings page reads back.
//
// This is accidental-spend insurance for a single-user, local-first app — a
// backstop against a runaway agent loop or a stuck retry burning credit, NOT an
// abuse/authentication control. It counts actual Responses API calls (the
// choke points postToOpenAiResponses and streamResponsesTurn), resets each
// local day, and stops *enforcing* when config.openAiDailyCallLimit <= 0.
//
// Counting and enforcing are deliberately separate. Counting always happens, so
// "AI calls today" stays truthful for the owner who disables the ceiling with
// AI_DAILY_CALL_LIMIT=0 (the documented default posture in
// docs/evals/ask-rag-iteration-log.md). Enforcement only happens when a limit is
// configured.
//
// The counter is in module memory and is NOT persisted: a restart resets it.
// That is an explicit prior owner decision (a SQLite-backed counter was removed
// before merge), so the count is "since the server started, today" — not an
// all-time ledger.

import { config } from "../config.js";

export const AI_DAILY_LIMIT_MESSAGE =
  "Daily AI usage limit reached. This is a safety cap to prevent accidental OpenAI spend — try again tomorrow or raise AI_DAILY_CALL_LIMIT.";

// The day boundary is the host machine's LOCAL midnight, matching how a
// single-user local-first app is actually used ("today" is the owner's today).
export const AI_USAGE_DAY_BOUNDARY = "local";

let currentDayKey = null;
let callCount = 0;

function dayKeyFor(timestamp) {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

/**
 * Reserve one model call against today's budget, or throw when the ceiling is
 * reached. The thrown error carries `status = 429` so routes can answer with a
 * "too many requests" status instead of a 500. `now` is injectable for tests.
 *
 * A rejected call is not counted: no provider request is made for it.
 */
export function reserveAiCall({ now = Date.now(), limit = config.openAiDailyCallLimit } = {}) {
  const today = dayKeyFor(now);

  if (today !== currentDayKey) {
    currentDayKey = today;
    callCount = 0;
  }

  if (limit > 0 && callCount >= limit) {
    const error = new Error(AI_DAILY_LIMIT_MESSAGE);
    /** @type {any} */ (error).status = 429;
    throw error;
  }

  callCount += 1;
}

/**
 * Read-only view of today's model-call usage. Never increments — Settings polls
 * this, and a status check must not look like AI activity.
 *
 * Returns 0 when nothing has been counted yet, and when the stored count
 * belongs to an earlier day (the counter is rolled lazily by reserveAiCall, so
 * a server that sat idle overnight still reports today's zero rather than
 * yesterday's total).
 */
export function getAiUsageSnapshot({ now = Date.now() } = {}) {
  const today = dayKeyFor(now);

  return {
    callsToday: today === currentDayKey ? callCount : 0,
  };
}

// Test-only: clear the in-memory counter between cases.
export function resetAiUsageBudgetForTests() {
  currentDayKey = null;
  callCount = 0;
}
