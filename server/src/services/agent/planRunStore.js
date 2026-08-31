// Server-held outputs of completed plan runs.
//
// Two kinds of record live here, each behind its own id:
//
//   1. READINESS INPUTS, under a `planRunId`. A safety acknowledgment is a
//      decision about ONE specific generated plan, and re-scoring that plan
//      afterwards needs the same inputs it was scored with: the canonical
//      tasks, the owner's skill level, the validated requirement groups, and
//      the evidence status. Accepting those back from the browser would hand
//      the client the readiness dial -- a request could post a task list with
//      no brake work, or requirement groups reporting every tool satisfied,
//      and buy the points that way. Only a safety-critical plan gets one,
//      because only a safety-critical plan has anything to acknowledge.
//
//   2. CHECKLIST DRAFTS, under a `checklistDraftId`. Saving a plan as a repair
//      checklist writes durable SQLite rows, so the text being written must be
//      the server's own -- see plannerChecklistDraft.js. Every completed run
//      gets one, whatever its evidence status.
//
// The two ids are deliberately separate rather than one id doing both jobs:
// they are minted under different conditions and authorize different things,
// and a single id would quietly let a non-safety-critical plan (which has no
// run record) lose its ability to be saved.
//
// Both requests carry an id and nothing else of consequence.
//
// In memory and bounded on purpose. An acknowledgment is tied to the plan in
// front of the owner, not stored as a standing consent: a server restart, a TTL
// expiry, or enough newer runs retires an old record, and the owner
// acknowledges the plan they are actually looking at. A draft expires the same
// way; saving it is what makes it durable. Nothing here reaches SQLite until
// the owner asks for it.

import { randomUUID } from "node:crypto";

// A single-user workspace generates plans one at a time; 20 is generous headroom
// for a few browser tabs, and the eviction below keeps the maps from growing
// without bound. Applied to each map separately: a workspace that plans 20
// non-safety-critical repairs holds 20 drafts and no run records.
export const DEFAULT_MAX_RUNS = 20;

// Long enough to read a plan and think about it, short enough that a stale tab
// cannot acknowledge a plan from days ago.
export const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;

// How many times a colliding id is regenerated before the store gives up. Five
// is already unreachable with a real UUID source; the loop exists so a broken
// injected generator fails loudly instead of overwriting a live record.
export const MAX_ID_ATTEMPTS = 5;

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

/**
 * @typedef {{
 *   draftId: string,
 *   draft: any,
 *   savedChecklistId: number | null,
 *   createdAt: number,
 * }} ChecklistDraftRecord
 */

/**
 * Detaches server-owned JSON-like data from its caller and freezes it all the
 * way down.
 *
 * Both halves matter, and a shallow freeze delivers neither. The clone breaks
 * every reference the caller still holds -- the same `requirements` object and
 * the same task list are also emitted as run artifacts, so without it a later
 * edit to either would silently change what a re-score reads back. The
 * recursion covers the nested groups and arrays a shallow freeze leaves
 * writable: `requirements.tools.missing` and a task's `safetyFlags` are both
 * read when readiness is recomputed, and emptying a task's `safetyFlags` array
 * is enough to turn safety-critical work non-critical.
 *
 * Throws on anything `structuredClone` cannot copy. Everything stored here is
 * plain JSON, so that is a loud failure for a real mistake, not a live path.
 */
function cloneAndDeepFreeze(value) {
  function deepFreeze(current) {
    if (current === null || typeof current !== "object" || Object.isFrozen(current)) {
      return current;
    }

    Object.freeze(current);
    Object.values(current).forEach(deepFreeze);
    return current;
  }

  return deepFreeze(structuredClone(value));
}

/**
 * Deep-freezes a draft so no later caller can edit what will be written to
 * SQLite.
 *
 * `sources` is frozen element-by-element for the same reason `items` is, and the
 * reason is sharper for provenance than for text: these entries carry the
 * `documentId` and `pageNumber` that become durable checklist evidence and are
 * later copied into a repair-history record. A shallow freeze would leave every
 * entry writable, so anything holding the draft could repoint a citation at a
 * different document between the plan being built and the checklist being saved.
 */
function freezeDraft(draft) {
  const items = Object.freeze(
    (Array.isArray(draft?.items) ? draft.items : []).map((item) => Object.freeze({ ...item }))
  );

  const sources = Object.freeze(
    (Array.isArray(draft?.sources) ? draft.sources : []).map((source) => Object.freeze({ ...source }))
  );

  return Object.freeze({ ...draft, items, sources });
}

export function createPlanRunStore({
  maxRuns = DEFAULT_MAX_RUNS,
  ttlMs = DEFAULT_TTL_MS,
  now = () => Date.now(),
  createId = randomUUID,
} = {}) {
  /** @type {Map<string, PlanRunRecord>} */
  const runs = new Map();
  /** @type {Map<string, ChecklistDraftRecord>} */
  const checklistDrafts = new Map();

  // Both maps age out and evict identically; only the record shape differs.
  function evictExpiredFrom(store) {
    const cutoff = now() - ttlMs;

    for (const [key, record] of store) {
      if (record.createdAt <= cutoff) {
        store.delete(key);
      }
    }
  }

  // Map iteration is insertion-ordered, so the first key is the oldest record.
  function makeRoomIn(store) {
    while (store.size >= maxRuns) {
      const oldest = store.keys().next();

      if (oldest.done) {
        break;
      }

      store.delete(oldest.value);
    }
  }

  function evictExpired() {
    evictExpiredFrom(runs);
  }

  // Never reuse a live key. `randomUUID` makes a collision effectively
  // impossible, but `createId` is injectable, and the failure mode if one ever
  // landed is the worst kind: `Map.set` would silently overwrite the earlier
  // record, so one owner's save or acknowledgment would resolve against a
  // DIFFERENT plan's stored tasks. Refusing to mint is a loud, harmless failure;
  // overwriting is a quiet, harmful one.
  function mintUniqueId(store) {
    for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt += 1) {
      const id = createId();

      if (!store.has(id)) {
        return id;
      }
    }

    throw new Error("Could not mint a unique plan run id.");
  }

  return {
    /**
     * Stores the server-owned readiness inputs for a completed run and returns
     * its id. Both readiness inputs are cloned and deep-frozen, so neither the
     * caller's copy nor the record handed back by `get` can change the tasks the
     * safety classifier will be re-run against or the requirement groups the
     * rubric will be re-scored from.
     */
    save({ tasks = [], skillLevel = "beginner", requirements = null, evidenceStatus = null } = {}) {
      evictExpired();
      makeRoomIn(runs);

      const runId = mintUniqueId(runs);

      runs.set(
        runId,
        Object.freeze({
          runId,
          tasks: cloneAndDeepFreeze(tasks),
          skillLevel,
          requirements: cloneAndDeepFreeze(requirements),
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

    /**
     * Stores the server-built checklist draft for a completed run and returns
     * its id. The draft is deep-frozen: whatever is written to SQLite later is
     * exactly what the planner produced here.
     */
    saveChecklistDraft(draft) {
      evictExpiredFrom(checklistDrafts);
      makeRoomIn(checklistDrafts);

      const draftId = mintUniqueId(checklistDrafts);

      checklistDrafts.set(draftId, {
        draftId,
        draft: freezeDraft(draft),
        // Set once the draft has actually been written, so a repeated save
        // returns the existing checklist instead of creating a duplicate.
        savedChecklistId: null,
        createdAt: now(),
      });

      return draftId;
    },

    /**
     * Returns a read-only view of the draft record, or `null` when the draft is
     * unknown or expired. Frozen for the same reason the run record is: the
     * route must not be able to edit the text it is about to persist.
     */
    getChecklistDraft(draftId) {
      evictExpiredFrom(checklistDrafts);

      const record = checklistDrafts.get(draftId);

      if (!record) {
        return null;
      }

      return Object.freeze({
        draftId: record.draftId,
        draft: record.draft,
        savedChecklistId: record.savedChecklistId,
        createdAt: record.createdAt,
      });
    },

    /**
     * Records which checklist a draft became. Returns `false` when the draft has
     * already expired, so a save that raced the TTL does not resurrect it.
     */
    markChecklistDraftSaved(draftId, checklistId) {
      evictExpiredFrom(checklistDrafts);

      const record = checklistDrafts.get(draftId);

      if (!record) {
        return false;
      }

      record.savedChecklistId = checklistId;
      return true;
    },

    get checklistDraftSize() {
      return checklistDrafts.size;
    },
  };
}

// Shared default instance: the agent writes completed runs here and the
// acknowledgment route reads them back.
export const planRunStore = createPlanRunStore();
