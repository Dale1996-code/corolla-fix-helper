// The evidence bridge between a repair checklist and a completed repair
// (roadmap N3.2).
//
// This module owns both halves of one chain, because they are the same fact at
// two moments and splitting them would let the halves drift:
//
//   1. WRITING durable provenance onto a checklist, from trusted planner output
//      (`repair_checklist_documents`).
//   2. COMPLETING that checklist into repair history, copying the provenance
//      into `repair_history_documents`.
//
// THE PROBLEM IT SOLVES. Before N3.2 the chain ran:
//
//   planner citations (documentId + pageNumber)
//     -> buildPlannerChecklistDraft
//     -> rendered into prose: "Brake Service Guide, page 4"
//     -> checklist saved
//     -> structured provenance GONE
//
// N3.1 built the destination and left the middle missing. The chain now runs
// end to end, and the evidence survives every one of the four things that used
// to destroy it: the plan run expiring, the server restarting, the document
// being renamed, and the document being deleted.
//
// THE SNAPSHOT RULE, inherited from N3.1 and applied identically here:
// LIVE FOREIGN KEY + HISTORICAL SNAPSHOT. `document_id` points at the live row
// while it exists and goes NULL when it is deleted; `document_title` and
// `page_number` are frozen at write time and always survive. A completed repair
// must never silently change because a current record changed.
//
// WHAT IS NOT DURABLE PROVENANCE, and is deliberately never written here:
// planner `sourceId` values (`S1`, `S2`, ...), chunk ids, embedding ids, and the
// plan run id. Source ids are scoped to the run that minted them -- request-local
// for Ask, run-wide for the planner -- chunk rows are rebuilt whenever a PDF is
// re-extracted, and a plan run is an in-memory record that expires in hours.
// None of the three can be resolved by a reader weeks later, which is precisely
// when a repair history is read.

import { db } from "../database.js";
import {
  captureChecklistTitle,
  captureSymptomTitle,
  findDocumentForVehicle,
  findRepairHistoryIdForChecklist,
  getRepairHistory,
  insertRepairHistoryRow,
  insertRepairHistorySourceSnapshots,
  MAX_SOURCES_PER_RECORD,
} from "./repairHistoryService.js";

/**
 * Normalize the server-built draft's `sources` into rows ready to insert.
 *
 * The input comes from `buildPlannerChecklistDraft`, never from a request body
 * -- see the trust boundary note on `POST /api/repair-checklists/from-planner`.
 * It is still normalized rather than trusted blindly: this is the last point
 * before evidence becomes permanent, and a malformed entry silently written is
 * exactly the failure the feature exists to prevent.
 *
 * Deduplication is first-seen order on `documentId:pageNumber`, matching
 * `normalizeSourceInputs` in repairHistoryService. Two accepted claims citing
 * one page is the ordinary case and must produce one row -- and the partial
 * unique index cannot do this job, because SQLite treats NULLs as distinct, so
 * two page-less citations of one document would both slip past it.
 *
 * @param {unknown} value
 * @returns {{ documentId: number, documentTitle: string, pageNumber: number|null }[]}
 */
export function normalizeChecklistSources(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set();
  const sources = [];

  for (const entry of value) {
    if (sources.length >= MAX_SOURCES_PER_RECORD) {
      break;
    }

    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }

    const documentId = Number(entry.documentId);

    if (!Number.isInteger(documentId) || documentId <= 0) {
      continue;
    }

    const rawPage = Number(entry.pageNumber);
    const pageNumber = Number.isInteger(rawPage) && rawPage > 0 ? rawPage : null;
    const key = `${documentId}:${pageNumber === null ? "" : pageNumber}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    sources.push({
      documentId,
      documentTitle: String(entry.documentTitle || "").trim(),
      pageNumber,
    });
  }

  return sources;
}

/** One checklist provenance row, in the shape the API returns. */
export function mapChecklistSourceRow(row) {
  return {
    id: row.id,
    documentId: Number.isInteger(row.document_id) && row.document_id > 0 ? row.document_id : null,
    documentTitle: row.document_title || "",
    pageNumber: Number.isInteger(row.page_number) && row.page_number > 0 ? row.page_number : null,
  };
}

/** Every provenance row for one checklist, oldest first. */
export function listChecklistSources(checklistId) {
  return db
    .prepare(`
      SELECT id, document_id, document_title, page_number
      FROM repair_checklist_documents
      WHERE repair_checklist_id = ?
      ORDER BY id ASC
    `)
    .all(checklistId)
    .map((row) => mapChecklistSourceRow(row));
}

/**
 * Every provenance row for a set of checklists, grouped by checklist id.
 *
 * One query for the whole list rather than one per checklist, matching how the
 * checklists router already batches its items.
 *
 * @param {*} vehicleId
 * @returns {Map<*, ReturnType<typeof mapChecklistSourceRow>[]>} keyed by checklist id,
 *   left untyped because SQLite hands back untyped row values
 */
export function listChecklistSourcesForVehicle(vehicleId) {
  const rows = db
    .prepare(`
      SELECT
        sources.id,
        sources.repair_checklist_id,
        sources.document_id,
        sources.document_title,
        sources.page_number
      FROM repair_checklist_documents AS sources
      JOIN repair_checklists ON repair_checklists.id = sources.repair_checklist_id
      WHERE repair_checklists.vehicle_id = ?
      ORDER BY sources.id ASC
    `)
    .all(vehicleId);

  const byChecklist = new Map();

  for (const row of rows) {
    if (!byChecklist.has(row.repair_checklist_id)) {
      byChecklist.set(row.repair_checklist_id, []);
    }

    byChecklist.get(row.repair_checklist_id).push(mapChecklistSourceRow(row));
  }

  return byChecklist;
}

/**
 * Write a checklist's provenance rows. Callers must already be inside a
 * transaction -- the checklist, its items, and these rows commit together or not
 * at all.
 *
 * A document that still exists contributes its LIVE id and its CURRENT title, so
 * the snapshot is true at the moment of the write. A document that has been
 * deleted between building the plan and saving the checklist contributes
 * `document_id = NULL` and the title the planner recorded when it cited the page.
 *
 * That second branch is a deliberate departure from `insertSources` in
 * repairHistoryService, which throws on an unresolvable id. The difference is in
 * where the input comes from. There, an unknown id is a caller MISTAKE -- someone
 * asked to cite a document that does not exist, and refusing is right. Here the
 * ids are the server's own, already resolved by the evidence contract, and an id
 * that no longer resolves means only that the library changed while the owner
 * read the plan. Failing the whole save then would discard verified evidence to
 * punish a race, and would leave the owner with no checklist at all. Keeping the
 * snapshot lands on exactly the state a post-save deletion produces, which is
 * the state the rest of this feature is already built to handle.
 *
 * @param {*} vehicleId
 * @param {number} checklistId
 * @param {{ documentId: number, documentTitle: string, pageNumber: number|null }[]} sources
 */
export function insertChecklistSources(vehicleId, checklistId, sources) {
  if (!sources.length) {
    return;
  }

  const insertSource = db.prepare(`
    INSERT INTO repair_checklist_documents (
      repair_checklist_id,
      document_id,
      document_title,
      page_number
    ) VALUES (?, ?, ?, ?)
  `);

  for (const source of sources) {
    const document = findDocumentForVehicle(vehicleId, source.documentId);

    if (document) {
      insertSource.run(checklistId, source.documentId, document.title || "", source.pageNumber);
      continue;
    }

    insertSource.run(checklistId, null, source.documentTitle || "", source.pageNumber);
  }
}

/**
 * Complete a checklist into a durable repair-history record, in ONE transaction.
 *
 * WHAT IS COPIED VERSUS WHAT IS SUPPLIED, and why the split matters:
 *
 *   - Historical FACTS that cannot be derived come from the caller: the date the
 *     work happened, the odometer reading, the outcome, the summary, the
 *     follow-up, and an optional symptom link. Nothing on the server knows these.
 *   - The TITLE comes from the checklist itself, so a completed repair is named
 *     by the work that was planned. The caller passes a checklist ID, never a
 *     title or a checklist row: this function re-reads the authoritative row
 *     INSIDE its transaction, so a caller cannot supply a title as historical
 *     truth and a row read before the lock cannot go stale underneath it. The
 *     optional symptom's title is captured the same way, through the same N3.1
 *     helpers the CRUD path uses. Any pre-check a route performs is for a clean
 *     4xx response only -- it is never the source of what gets written.
 *   - The PROVENANCE comes from `repair_checklist_documents` and nowhere else. A
 *     caller cannot supply, extend, or override it; the whole point of storing
 *     it at save time is that completion has an authority to read rather than a
 *     claim to trust. This is what makes completion independent of the plan run:
 *     `planRunStore` is not consulted here, and by the time a repair is completed
 *     -- days or weeks later, after any number of restarts -- the run that
 *     produced the evidence is long gone.
 *
 * PROVENANCE IS COPIED, NOT REFERENCED. The history record gets its own rows,
 * snapshotted from the checklist's. So deleting the completed checklist
 * afterwards cascades away the checklist's provenance and leaves the history
 * copy whole, with `repair_history.checklist_id` set to NULL by the foreign key
 * and `checklist_title` still readable.
 *
 * EXACTLY ONCE. One checklist records one repair. The check below is inside the
 * IMMEDIATE transaction, and the guarantee behind it is the partial unique index
 * `idx_repair_history_checklist_unique` from migration 005 -- so a repeated
 * request cannot create a second historical repair even if it slipped past the
 * check. Callers get `created: false` and the existing record back, which is what
 * makes a retried or double-clicked completion safe.
 *
 * The checklist is also moved to `status = 'done'`, in the same transaction.
 * Completion implies done; done does NOT imply completion -- see the note on the
 * completion route.
 *
 * @param {*} vehicleId the id from vehicleService, which reads it untyped from SQLite
 * @param {*} checklistId the id of the `repair_checklists` row being completed,
 *   likewise untyped. The ID, not the row -- the row is re-read under the lock.
 * @param {{
 *   performedOn: string,
 *   odometerMiles: number|null,
 *   outcome: string,
 *   summary: string,
 *   followUp: string,
 *   symptomId: number|null,
 * }} fields
 * @returns {{ created: boolean, repairHistory: any }}
 */
export function completeChecklistIntoHistory(vehicleId, checklistId, fields) {
  db.exec("BEGIN IMMEDIATE TRANSACTION");

  try {
    const existingId = findRepairHistoryIdForChecklist(vehicleId, checklistId);

    if (existingId !== null) {
      // Nothing was written, so there is nothing to roll back -- but the
      // transaction still has to be closed before reading the record back.
      db.exec("COMMIT");

      return {
        created: false,
        repairHistory: getRepairHistory(vehicleId, existingId),
      };
    }

    // Both snapshots are captured HERE, under the IMMEDIATE lock, through the
    // same N3.1 helpers the repair-history CRUD path uses. `captureChecklistTitle`
    // throws if the checklist has gone -- deleted between a route's pre-check and
    // this transaction -- and that throw rolls the whole completion back rather
    // than recording a repair for a checklist that no longer exists.
    const checklistTitle = captureChecklistTitle(vehicleId, checklistId);
    const symptomTitle = captureSymptomTitle(vehicleId, fields.symptomId);

    const repairHistoryId = insertRepairHistoryRow(
      vehicleId,
      {
        performedOn: fields.performedOn,
        odometerMiles: fields.odometerMiles,
        // The checklist names the work; the caller does not get to rename it.
        title: checklistTitle,
        outcome: fields.outcome,
        summary: fields.summary,
        followUp: fields.followUp,
        symptomId: fields.symptomId,
        checklistId,
      },
      symptomTitle,
      // Snapshot of the checklist's title AS IT IS NOW, which is also the
      // history record's own title. Renaming the checklist afterwards must not
      // rewrite either.
      checklistTitle
    );

    insertRepairHistorySourceSnapshots(repairHistoryId, listChecklistSources(checklistId));

    db.prepare(`
      UPDATE repair_checklists
      SET status = 'done', updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND vehicle_id = ?
    `).run(checklistId, vehicleId);

    db.exec("COMMIT");

    return {
      created: true,
      repairHistory: getRepairHistory(vehicleId, repairHistoryId),
    };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
