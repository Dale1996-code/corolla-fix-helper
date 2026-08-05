// Server-held readiness inputs for completed plan runs.
//
// A safety acknowledgment is a decision about ONE specific generated plan, and
// re-scoring that plan afterwards needs the same inputs it was scored with:
// the canonical tasks, the owner's skill level, the validated requirement
// groups, and the evidence status. Accepting those back from the browser would
// hand the client the readiness dial -- a request could post a task list with
// no brake work, or requirement groups reporting every tool satisfied, and buy
// the points that way. So the server keeps them and the acknowledgment request
// carries nothing but a run id and a boolean.
//
// In memory and bounded on purpose. The acknowledgment is tied to the plan in
// front of the owner, not stored as a standing consent: a server restart, a TTL
// expiry, or enough newer runs retires an old record, and the owner
// acknowledges the plan they are actually looking at. Nothing here reaches
// SQLite.

import { randomUUID } from "node:crypto";

// A single-user workspace generates plans one at a time; 20 is generous headroom
// for a few browser tabs, and the eviction below keeps the map from growing
// without bound.
export const DEFAULT_MAX_RUNS = 20;

// Long enough to read a plan and think about it, short enough that a stale tab
// cannot acknowledge a plan from days ago.
export const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * @typedef {{
 *   runId: string,
 *   tasks: readonly any[],
 *   skillLevel: string,
 *   requirements: { tools: any, parts: any } | null,
 *   evidenceStatus: string | null,
 *   createdAt: number,
 * }} PlanRunRecord
 */

export function createPlanRunStore({
  maxRuns = DEFAULT_MAX_RUNS,
  ttlMs = DEFAULT_TTL_MS,
  now = () => Date.now(),
  createId = randomUUID,
} = {}) {
  /** @type {Map<string, PlanRunRecord>} */
  const runs = new Map();

  function evictExpired() {
    const cutoff = now() - ttlMs;

    for (const [runId, record] of runs) {
      if (record.createdAt <= cutoff) {
        runs.delete(runId);
      }
    }
  }

  return {
    /**
     * Stores the server-owned readiness inputs for a completed run and returns
     * its id. The record is frozen so a later caller cannot mutate the tasks the
     * safety classifier will be re-run against.
     */
    save({ tasks = [], skillLevel = "beginner", requirements = null, evidenceStatus = null } = {}) {
      evictExpired();

      // Map iteration is insertion-ordered, so the first key is the oldest run.
      while (runs.size >= maxRuns) {
        const oldest = runs.keys().next();

        if (oldest.done) {
          break;
        }

        runs.delete(oldest.value);
      }

      const runId = createId();

      runs.set(
        runId,
        Object.freeze({
          runId,
          tasks: Object.freeze(tasks.map((task) => Object.freeze({ ...task }))),
          skillLevel,
          requirements,
          evidenceStatus,
          createdAt: now(),
        })
      );

      return runId;
    },

    /** Returns the stored record, or `null` when the run is unknown or expired. */
    get(runId) {
      evictExpired();
      return runs.get(runId) || null;
    },

    get size() {
      return runs.size;
    },
  };
}

// Shared default instance: the agent writes completed runs here and the
// acknowledgment route reads them back.
export const planRunStore = createPlanRunStore();
