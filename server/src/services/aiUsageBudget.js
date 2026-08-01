// A coarse daily ceiling on OpenAI model calls.
//
// This is accidental-spend insurance for a single-user, local-first app — a
// backstop against a runaway agent loop or a stuck retry burning credit, NOT an
// abuse/authentication control. It counts actual Responses API calls (the
// choke points postToOpenAiResponses and streamResponsesTurn), resets each
// local day, and is disabled when config.openAiDailyCallLimit <= 0.

import { config } from "../config.js";

export const AI_DAILY_LIMIT_MESSAGE =
  "Daily AI usage limit reached. This is a safety cap to prevent accidental OpenAI spend — try again tomorrow or raise AI_DAILY_CALL_LIMIT.";

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
 */
export function reserveAiCall({ now = Date.now(), limit = config.openAiDailyCallLimit } = {}) {
  if (!limit || limit <= 0) {
    return; // ceiling disabled
  }

  const today = dayKeyFor(now);

  if (today !== currentDayKey) {
    currentDayKey = today;
    callCount = 0;
  }

  if (callCount >= limit) {
    const error = new Error(AI_DAILY_LIMIT_MESSAGE);
    /** @type {any} */ (error).status = 429;
    throw error;
  }

  callCount += 1;
}

// Test-only: clear the in-memory counter between cases.
export function resetAiUsageBudgetForTests() {
  currentDayKey = null;
  callCount = 0;
}
