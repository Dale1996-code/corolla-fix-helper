// Repair history: the durable record that a repair was actually carried out.
//
// This is the persistence half of roadmap N3. It owns every query against
// `repair_history` / `repair_history_documents` and the canonical row shape the
// API returns; routes own HTTP parsing, status codes, and error messages.
//
// The organizing rule, and the reason several functions below look more careful
// than ordinary CRUD, is LIVE FOREIGN KEY + HISTORICAL SNAPSHOT:
//
//   - The foreign keys (`symptom_id`, `checklist_id`, `document_id`) point at
//     the live record for as long as it exists, and are ON DELETE SET NULL so a
//     deletion never takes the history record with it.
//   - The `*_title` columns are snapshots taken at write time. They are what
//     makes a completed repair still readable once a symptom is renamed, a
//     checklist edited, or a document removed from the library.
//
// The snapshot is therefore only ever (re)written by the code path that
// explicitly changes the relationship it belongs to. Editing a summary, an
// outcome, a follow-up, or an odometer reading must NOT refresh a snapshot from
// its live row -- that would let a rename silently rewrite history, which is the
// exact failure this design exists to prevent.

import { db } from "../database.js";
import { normalizeText } from "../utils/text.js";

/**
 * Schema ceiling for a recorded odometer reading, mirrored from the CHECK
 * constraint in migration 004 so the route can reject out-of-range input with a
 * clean 400 instead of letting it become a database 500.
 *
 * Loose on purpose. It is a typo guard -- it catches a pasted VIN or a slipped
 * digit -- not a claim about how far a Corolla can travel.
 */
export const MAX_ODOMETER_MILES = 2000000;

/**
 * Cap on how many source citations one history record may carry, so a single
 * request cannot drive an unbounded insert loop. Consistent with the payload
 * caps the AI routes already apply; a real repair cites a handful of pages.
 */
export const MAX_SOURCES_PER_RECORD = 100;

export const REPAIR_OUTCOMES = ["fixed", "partial", "not_fixed", "unknown"];

const allowedOutcomes = new Set(REPAIR_OUTCOMES);

const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Parse a `YYYY-MM-DD` calendar date, strictly.
 *
 * Deliberately NOT `new Date(value)`: that parser is permissive in exactly the
 * ways that matter here. It accepts `08/29/2026`, silently rolls `2026-02-30`
 * forward to 2 March, and applies a local-timezone offset to a bare date. A
 * repair date is a calendar fact the owner typed, so it is validated as text
 * (shape) and then round-tripped through `Date.UTC` (real calendar day). The
 * round trip is what rejects 31 February and month/day `00`.
 *
 * No "cannot be in the future" rule: nothing else in this product has one, and
 * recording work you have already scheduled is a legitimate thing to do.
 *
 * @param {unknown} value
 * @returns {string} the date, unchanged, in `YYYY-MM-DD`
 */
export function normalizePerformedOn(value) {
  const text = normalizeText(value);

  if (!text) {
    throw new Error("Repair date is required, in YYYY-MM-DD format.");
  }

  const match = ISO_DATE_PATTERN.exec(text);

  if (!match) {
    throw new Error("Repair date must be a calendar date in YYYY-MM-DD format.");
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));

  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new Error("Repair date must be a real calendar date in YYYY-MM-DD format.");
  }

  return text;
}

/**
 * Parse an odometer reading: `null` (not recorded) or a whole number of miles
 * within the schema range.
 *
 * A real JSON number is required; a numeric STRING is rejected. That is a
 * deliberate departure from `parsePositiveInt` and the note service's id
 * parsing, which coerce with `Number()` -- those read path parameters, which are
 * always strings, so they have no choice. This reads a JSON body field, where a
 * number is directly representable, and coercion here would be actively harmful:
 * `Number("")` and `Number(" ")` are both `0`, so a blank field would silently
 * become a legitimate-looking reading of zero miles.
 *
 * `null` and a genuine zero are different facts and stay different: `null` means
 * "I did not write it down", `0` is a reading.
 *
 * Unit is miles, fixed, and named in the column. There is no unit column: this
 * is a single US-market vehicle, and a unit field would be multi-vehicle-shaped
 * generality with no consumer.
 *
 * @param {unknown} value
 * @returns {number|null}
 */
export function normalizeOdometerMiles(value) {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(
      "Odometer reading must be a whole number of miles, or null when it was not recorded."
    );
  }

  if (value < 0 || value > MAX_ODOMETER_MILES) {
    throw new Error(`Odometer reading must be between 0 and ${MAX_ODOMETER_MILES} miles.`);
  }

  return value;
}

/** Parse the repair outcome. Blank means the owner has not said yet. */
export function normalizeOutcome(value) {
  const normalized = normalizeText(value).toLowerCase();

  if (!normalized) {
    return "unknown";
  }

  if (!allowedOutcomes.has(normalized)) {
    throw new Error(`Outcome must be ${REPAIR_OUTCOMES.join(", ")}.`);
  }

  return normalized;
}

/**
 * Parse an optional link id. Mirrors `noteService.normalizeRelatedEntityId`,
 * including its `Number()` coercion, because linked-entity ids are the one place
 * this repository already established that convention.
 *
 * @param {unknown} value
 * @param {string} label used in the error message
 * @returns {number|null}
 */
export function normalizeOptionalEntityId(value, label) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const id = Number(value);

  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(`${label} must be a positive number.`);
  }

  return id;
}

/**
 * Parse the `sources` body field into a deduplicated, ordered list of
 * `{ documentId, pageNumber }` citations.
 *
 * Deduplication is done HERE rather than by letting the unique index raise a
 * constraint error, for two reasons. Ordinary duplicate input (the same page
 * cited twice) is not an error worth failing a whole save over; and the index
 * cannot do the job anyway, because SQLite treats NULLs as distinct, so two
 * page-less citations of one document would both slip past it. First-seen order
 * wins, so the result is deterministic.
 *
 * A non-array `sources` is rejected rather than treated as empty: silently
 * dropping evidence is the one failure mode this whole feature exists to avoid.
 *
 * @param {unknown} value
 * @returns {{ documentId: number, pageNumber: number|null }[]}
 */
export function normalizeSourceInputs(value) {
  if (value === null || value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new Error('Field "sources" must be an array of { documentId, pageNumber } entries.');
  }

  if (value.length > MAX_SOURCES_PER_RECORD) {
    throw new Error(`A repair record can cite at most ${MAX_SOURCES_PER_RECORD} document pages.`);
  }

  const seen = new Set();
  const sources = [];

  for (const entry of value) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("Each source must be an object with a documentId.");
    }

    const documentId = Number(entry.documentId);

    if (!Number.isInteger(documentId) || documentId <= 0) {
      throw new Error("Each source needs a documentId that is a positive number.");
    }

    let pageNumber = null;

    if (entry.pageNumber !== null && entry.pageNumber !== undefined && entry.pageNumber !== "") {
      const parsedPage = Number(entry.pageNumber);

      if (!Number.isInteger(parsedPage) || parsedPage <= 0) {
        throw new Error("A source pageNumber must be a positive number, or null.");
      }

      pageNumber = parsedPage;
    }

    const key = `${documentId}:${pageNumber === null ? "" : pageNumber}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    sources.push({ documentId, pageNumber });
  }

  return sources;
}

// --- Linked-record lookups -------------------------------------------------
//
// Exported so a route can check existence and return an entity-specific 400
// before any write is attempted, the same way notesRouter uses
// getRelatedEntityForVehicle. The write paths below re-read the title inside
// their transaction, so the snapshot and the row it was taken from are committed
// together.

/** The symptom with this id, when it belongs to the vehicle. */
export function findSymptomForVehicle(vehicleId, symptomId) {
  return db
    .prepare("SELECT id, title FROM symptoms WHERE id = ? AND vehicle_id = ?")
    .get(symptomId, vehicleId);
}

/** The repair checklist with this id, when it belongs to the vehicle. */
export function findChecklistForVehicle(vehicleId, checklistId) {
  return db
    .prepare("SELECT id, title FROM repair_checklists WHERE id = ? AND vehicle_id = ?")
    .get(checklistId, vehicleId);
}

/** The document with this id, when it belongs to the vehicle. */
export function findDocumentForVehicle(vehicleId, documentId) {
  return db
    .prepare("SELECT id, title FROM documents WHERE id = ? AND vehicle_id = ?")
    .get(documentId, vehicleId);
}

/**
 * The ids in `documentIds` that do not name a document belonging to the vehicle,
 * in the order they were supplied. Lets a route reject the whole request once,
 * naming what was wrong, instead of failing on the first bad id mid-write.
 */
export function findMissingDocumentIds(vehicleId, documentIds) {
  return documentIds.filter((documentId) => !findDocumentForVehicle(vehicleId, documentId));
}

// --- Row mapping -----------------------------------------------------------

/**
 * One provenance row.
 *
 * `documentId` is the LIVE link and is `null` once that document has been
 * deleted; `documentTitle` and `pageNumber` are the snapshot and always survive.
 * The current title of a still-existing document is deliberately NOT joined in:
 * exposing it would invite a caller to display a live title over a historical
 * record, which is the drift this table is built to prevent.
 */
export function mapRepairHistorySourceRow(row) {
  return {
    id: row.id,
    documentId: Number.isInteger(row.document_id) && row.document_id > 0 ? row.document_id : null,
    documentTitle: row.document_title || "",
    pageNumber: Number.isInteger(row.page_number) && row.page_number > 0 ? row.page_number : null,
  };
}

/**
 * The canonical repair-history shape returned by every endpoint.
 *
 * `sources` is passed in rather than read here so the list view can group one
 * batched child query across many parents instead of fanning out per row.
 */
export function mapRepairHistoryCore(row, sources) {
  return {
    id: row.id,
    performedOn: row.performed_on,
    odometerMiles: Number.isInteger(row.odometer_miles) ? row.odometer_miles : null,
    title: row.title || "",
    outcome: row.outcome || "unknown",
    summary: row.summary || "",
    followUp: row.follow_up || "",
    symptomId: Number.isInteger(row.symptom_id) && row.symptom_id > 0 ? row.symptom_id : null,
    symptomTitle: row.symptom_title || "",
    checklistId:
      Number.isInteger(row.checklist_id) && row.checklist_id > 0 ? row.checklist_id : null,
    checklistTitle: row.checklist_title || "",
    sources,
    sourceCount: sources.length,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const REPAIR_HISTORY_COLUMNS = `
  id,
  performed_on,
  odometer_miles,
  title,
  outcome,
  summary,
  follow_up,
  symptom_id,
  symptom_title,
  checklist_id,
  checklist_title,
  created_at,
  updated_at
`;

function listSourcesForRepairHistory(repairHistoryId) {
  return db
    .prepare(`
      SELECT id, document_id, document_title, page_number
      FROM repair_history_documents
      WHERE repair_history_id = ?
      ORDER BY id ASC
    `)
    .all(repairHistoryId)
    .map((row) => mapRepairHistorySourceRow(row));
}

// --- Reads -----------------------------------------------------------------

/**
 * Every repair recorded for the vehicle, newest work first.
 *
 * Ordered by `performed_on` rather than by `updated_at` -- unlike the other lists
 * in this app, which order by recent activity. History is read chronologically by
 * when the work happened; correcting a typo in a five-year-old record should not
 * move it to the top of the log.
 */
export function listRepairHistory(vehicleId) {
  const historyRows = db
    .prepare(`
      SELECT ${REPAIR_HISTORY_COLUMNS}
      FROM repair_history
      WHERE vehicle_id = ?
      ORDER BY performed_on DESC, id DESC
    `)
    .all(vehicleId);

  // One query for every child row, grouped back onto its parent below, so the
  // list does not fan out into a read per record.
  const sourceRows = db
    .prepare(`
      SELECT
        sources.id,
        sources.repair_history_id,
        sources.document_id,
        sources.document_title,
        sources.page_number
      FROM repair_history_documents AS sources
      JOIN repair_history ON repair_history.id = sources.repair_history_id
      WHERE repair_history.vehicle_id = ?
      ORDER BY sources.id ASC
    `)
    .all(vehicleId);

  const sourcesByHistory = new Map();

  for (const sourceRow of sourceRows) {
    if (!sourcesByHistory.has(sourceRow.repair_history_id)) {
      sourcesByHistory.set(sourceRow.repair_history_id, []);
    }

    sourcesByHistory.get(sourceRow.repair_history_id).push(mapRepairHistorySourceRow(sourceRow));
  }

  return historyRows.map((row) => mapRepairHistoryCore(row, sourcesByHistory.get(row.id) || []));
}

/** One repair record, or `null` when it is missing or owned by another vehicle. */
export function getRepairHistory(vehicleId, repairHistoryId) {
  const row = db
    .prepare(`
      SELECT ${REPAIR_HISTORY_COLUMNS}
      FROM repair_history
      WHERE id = ? AND vehicle_id = ?
    `)
    .get(repairHistoryId, vehicleId);

  if (!row) {
    return null;
  }

  return mapRepairHistoryCore(row, listSourcesForRepairHistory(row.id));
}

/** Raw scalar columns for an owned record, for the partial-update merge. */
export function getRepairHistoryRecord(vehicleId, repairHistoryId) {
  return db
    .prepare(`
      SELECT ${REPAIR_HISTORY_COLUMNS}
      FROM repair_history
      WHERE id = ? AND vehicle_id = ?
    `)
    .get(repairHistoryId, vehicleId);
}

// --- Snapshot capture ------------------------------------------------------
//
// Each of these reads the CURRENT title of a linked record and returns it to be
// frozen into the history row. They are called only from the create path and
// from the update branches that were explicitly asked to change that
// relationship -- never from a plain field edit.

function captureSymptomTitle(vehicleId, symptomId) {
  if (symptomId === null) {
    return "";
  }

  const symptom = findSymptomForVehicle(vehicleId, symptomId);

  if (!symptom) {
    throw new Error("Linked symptom does not exist.");
  }

  return symptom.title || "";
}

function captureChecklistTitle(vehicleId, checklistId) {
  if (checklistId === null) {
    return "";
  }

  const checklist = findChecklistForVehicle(vehicleId, checklistId);

  if (!checklist) {
    throw new Error("Linked checklist does not exist.");
  }

  return checklist.title || "";
}

/**
 * Write the provenance rows for a record, snapshotting each document's current
 * title. Callers must already be inside a transaction.
 */
function insertSources(vehicleId, repairHistoryId, sources) {
  if (!sources.length) {
    return;
  }

  const insertSource = db.prepare(`
    INSERT INTO repair_history_documents (
      repair_history_id,
      document_id,
      document_title,
      page_number
    ) VALUES (?, ?, ?, ?)
  `);

  for (const source of sources) {
    const document = findDocumentForVehicle(vehicleId, source.documentId);

    if (!document) {
      throw new Error(`Linked document ${source.documentId} does not exist.`);
    }

    insertSource.run(repairHistoryId, source.documentId, document.title || "", source.pageNumber);
  }
}

// --- Writes ----------------------------------------------------------------

/**
 * Create a repair record and its provenance rows in ONE transaction.
 *
 * All-or-nothing is the point: a history record that committed its header and
 * then lost its citations looks exactly like a repair that was never grounded in
 * anything, and there is no way to tell the two apart afterwards.
 *
 * Field values are expected to be already parsed and normalized by the caller
 * (the route). What is re-read here, inside the transaction, is the snapshot
 * titles -- so what was written is what was true at the moment of the write.
 *
 * @param {*} vehicleId the id from vehicleService, which reads it untyped from SQLite
 * @param {{
 *   performedOn: string,
 *   odometerMiles: number|null,
 *   title: string,
 *   outcome: string,
 *   summary: string,
 *   followUp: string,
 *   symptomId: number|null,
 *   checklistId: number|null,
 *   sources?: { documentId: number, pageNumber: number|null }[],
 * }} fields
 */
export function createRepairHistory(vehicleId, fields) {
  db.exec("BEGIN IMMEDIATE TRANSACTION");

  try {
    const symptomTitle = captureSymptomTitle(vehicleId, fields.symptomId);
    const checklistTitle = captureChecklistTitle(vehicleId, fields.checklistId);

    const insertResult = db
      .prepare(`
        INSERT INTO repair_history (
          vehicle_id,
          performed_on,
          odometer_miles,
          title,
          outcome,
          summary,
          follow_up,
          symptom_id,
          symptom_title,
          checklist_id,
          checklist_title
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        vehicleId,
        fields.performedOn,
        fields.odometerMiles,
        fields.title,
        fields.outcome,
        fields.summary,
        fields.followUp,
        fields.symptomId,
        symptomTitle,
        fields.checklistId,
        checklistTitle
      );

    const repairHistoryId = Number(insertResult.lastInsertRowid);

    insertSources(vehicleId, repairHistoryId, fields.sources || []);

    db.exec("COMMIT");

    return getRepairHistory(vehicleId, repairHistoryId);
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/**
 * Update an owned repair record in ONE transaction.
 *
 * The three optional relationship inputs are what encode the snapshot rule, and
 * their being `undefined` is meaningful:
 *
 *   - `symptomChange` / `checklistChange` undefined -> that relationship and its
 *     snapshot are not touched at all. Passing `{ symptomId }` means the caller
 *     explicitly changed the link, so the snapshot is retaken from the newly
 *     selected record (or cleared, when the link is set to null -- an owner
 *     saying "this was not for that symptom" is correcting the record, and a
 *     title left behind a null id would be indistinguishable from a symptom that
 *     had been deleted).
 *   - `sources` undefined -> the provenance rows are not read or written.
 *     Passing an array replaces the whole set, snapshotting the titles of the
 *     newly supplied documents; passing `[]` removes them all.
 *
 * The scalar fields (date, odometer, title, outcome, summary, follow-up) are
 * written by their own statement, which never touches a `*_title` column. That is
 * deliberately visible in the code rather than implied: editing a summary must
 * not be able to refresh a snapshot.
 *
 * @param {*} vehicleId the id from vehicleService, which reads it untyped from SQLite
 * @param {number} repairHistoryId
 * @param {{
 *   performedOn: string,
 *   odometerMiles: number|null,
 *   title: string,
 *   outcome: string,
 *   summary: string,
 *   followUp: string,
 *   symptomChange?: { symptomId: number|null },
 *   checklistChange?: { checklistId: number|null },
 *   sources?: { documentId: number, pageNumber: number|null }[],
 * }} changes
 */
export function updateRepairHistory(vehicleId, repairHistoryId, changes) {
  db.exec("BEGIN IMMEDIATE TRANSACTION");

  try {
    db.prepare(`
      UPDATE repair_history
      SET
        performed_on = ?,
        odometer_miles = ?,
        title = ?,
        outcome = ?,
        summary = ?,
        follow_up = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND vehicle_id = ?
    `).run(
      changes.performedOn,
      changes.odometerMiles,
      changes.title,
      changes.outcome,
      changes.summary,
      changes.followUp,
      repairHistoryId,
      vehicleId
    );

    if (changes.symptomChange) {
      const symptomId = changes.symptomChange.symptomId;

      db.prepare(`
        UPDATE repair_history
        SET symptom_id = ?, symptom_title = ?
        WHERE id = ? AND vehicle_id = ?
      `).run(symptomId, captureSymptomTitle(vehicleId, symptomId), repairHistoryId, vehicleId);
    }

    if (changes.checklistChange) {
      const checklistId = changes.checklistChange.checklistId;

      db.prepare(`
        UPDATE repair_history
        SET checklist_id = ?, checklist_title = ?
        WHERE id = ? AND vehicle_id = ?
      `).run(
        checklistId,
        captureChecklistTitle(vehicleId, checklistId),
        repairHistoryId,
        vehicleId
      );
    }

    if (changes.sources) {
      db.prepare("DELETE FROM repair_history_documents WHERE repair_history_id = ?").run(
        repairHistoryId
      );
      insertSources(vehicleId, repairHistoryId, changes.sources);
    }

    db.exec("COMMIT");

    return getRepairHistory(vehicleId, repairHistoryId);
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/**
 * Delete an owned repair record. Its provenance rows are removed by the
 * `ON DELETE CASCADE` foreign key. Returns the number of rows removed so the
 * caller can tell "not found" (0) from a successful delete.
 */
export function deleteRepairHistory(vehicleId, repairHistoryId) {
  return db
    .prepare("DELETE FROM repair_history WHERE id = ? AND vehicle_id = ?")
    .run(repairHistoryId, vehicleId).changes;
}
