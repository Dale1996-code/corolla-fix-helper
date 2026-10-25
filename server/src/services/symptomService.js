import { db, withTransaction } from "../database.js";
import { clearNoteLinksTo } from "./noteService.js";
import { buildSymptomProcedureLinksMap } from "./symptomProcedureService.js";
import { normalizeText } from "../utils/text.js";

const allowedConfidenceValues = new Set(["low", "medium", "high"]);
const allowedStatusValues = new Set(["open", "monitoring", "resolved"]);

export function normalizeConfidence(value) {
  const normalized = normalizeText(value).toLowerCase();

  if (!normalized) {
    return "medium";
  }

  if (!allowedConfidenceValues.has(normalized)) {
    throw new Error("Confidence must be low, medium, or high.");
  }

  return normalized;
}

export function normalizeStatus(value) {
  const normalized = normalizeText(value).toLowerCase();

  if (!normalized) {
    return "open";
  }

  if (!allowedStatusValues.has(normalized)) {
    throw new Error("Status must be open, monitoring, or resolved.");
  }

  return normalized;
}

// The symptom fields shared by the full API view (mapSymptomRow) and the search
// view (searchService.mapSymptomRow): the core columns plus the linked-document
// projection. Extracted so the two views cannot silently drift apart. The search
// view stops here; the full view augments it with linked procedures.
// `linkedDocuments` is the already-built array of linked documents for this row.
export function mapSymptomCore(row, linkedDocuments) {
  return {
    id: row.id,
    title: row.title,
    description: row.description || "",
    system: row.system || "",
    suspectedCauses: row.suspected_causes || "",
    confidence: row.confidence || "medium",
    status: row.status || "open",
    notes: row.notes || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    linkedDocumentIds: linkedDocuments.map((document) => document.id),
    linkedDocuments,
  };
}

export function mapSymptomRow(row, documentLinksMap, procedureLinksMap) {
  const linkedProcedures = procedureLinksMap.get(row.id) || [];

  return {
    ...mapSymptomCore(row, documentLinksMap.get(row.id) || []),
    linkedProcedureIds: linkedProcedures.map((procedure) => procedure.id),
    linkedProcedures,
  };
}

// Full mapped symptoms, in the list's legacy order (latest update first). With
// `symptomIds` the rows AND both link maps are read for those symptoms alone, so
// one page or one record never costs a scan of every link the vehicle has.
function loadMappedSymptoms(vehicleId, symptomIds = null) {
  const narrowed = Array.isArray(symptomIds);

  if (narrowed && symptomIds.length === 0) {
    return [];
  }

  // One bound parameter however many ids there are, rather than one `?` each.
  const idFilterSql = (column) =>
    narrowed ? `AND ${column} IN (SELECT value FROM json_each(?))` : "";
  const idParams = narrowed ? [JSON.stringify(symptomIds)] : [];

  const symptomRows = db
    .prepare(`
      SELECT
        id,
        title,
        description,
        system,
        suspected_causes,
        confidence,
        status,
        notes,
        created_at,
        updated_at
      FROM symptoms
      WHERE vehicle_id = ?
      ${idFilterSql("id")}
      ORDER BY updated_at DESC, id DESC
    `)
    .all(vehicleId, ...idParams);

  const linkRows = db
    .prepare(`
      SELECT
        symptom_documents.symptom_id,
        documents.id AS document_id,
        documents.title AS document_title,
        documents.system AS document_system,
        documents.document_type AS document_type
      FROM symptom_documents
      JOIN symptoms ON symptoms.id = symptom_documents.symptom_id
      JOIN documents ON documents.id = symptom_documents.document_id
      WHERE symptoms.vehicle_id = ?
      ${idFilterSql("symptom_documents.symptom_id")}
      ORDER BY documents.title COLLATE NOCASE ASC
    `)
    .all(vehicleId, ...idParams);

  const documentLinksMap = new Map();

  for (const linkRow of linkRows) {
    if (!documentLinksMap.has(linkRow.symptom_id)) {
      documentLinksMap.set(linkRow.symptom_id, []);
    }

    documentLinksMap.get(linkRow.symptom_id).push({
      id: linkRow.document_id,
      title: linkRow.document_title,
      system: linkRow.document_system || "",
      documentType: linkRow.document_type || "",
    });
  }

  const procedureLinksMap = buildSymptomProcedureLinksMap(
    vehicleId,
    narrowed ? symptomIds : null
  );

  return symptomRows.map((row) =>
    mapSymptomRow(row, documentLinksMap, procedureLinksMap)
  );
}

export function listSymptoms(vehicleId) {
  return loadMappedSymptoms(vehicleId);
}

// A single mapped symptom, or undefined when it does not belong to the vehicle.
// Same mapping and link maps as the list view, read for this one symptom only.
export function getSymptom(vehicleId, symptomId) {
  return loadMappedSymptoms(vehicleId, [symptomId])[0];
}

export const SYMPTOM_LIST_SORT_KEYS = ["newest", "oldest", "title"];
export const SYMPTOM_LIST_STATUS_FILTERS = ["active", "open", "monitoring", "resolved"];

// Title A-Z the way the Symptoms page ordered it in the browser: a plain
// `localeCompare`. SQLite's NOCASE compares bytes after folding ASCII case, so
// it would put accented and symbol-led titles somewhere else. The locale is
// pinned so the order does not depend on the server's settings.
const symptomTextCollator = new Intl.Collator("en-US");

function updatedAtTime(value) {
  const time = new Date(value || 0).getTime();
  return Number.isNaN(time) ? 0 : time;
}

// The comparisons the page's own sort used. Ties fall back to the legacy list
// order the rows arrive in (latest update, then highest id), exactly what the
// browser's stable sort left behind -- and since ids are unique, the order is
// total, so a page boundary can never repeat or skip a symptom.
const SYMPTOM_COMPARATORS = {
  newest: (first, second) => updatedAtTime(second.updatedAt) - updatedAtTime(first.updatedAt),
  oldest: (first, second) => updatedAtTime(first.updatedAt) - updatedAtTime(second.updatedAt),
  title: (first, second) => symptomTextCollator.compare(first.title, second.title),
};

function matchesSymptomStatus(status, statusFilter) {
  if (!statusFilter) {
    return true;
  }

  if (statusFilter === "active") {
    return status === "open" || status === "monitoring";
  }

  return status === statusFilter;
}

/**
 * One page of the Symptoms page's list, filtered and ordered over every symptom
 * the vehicle has.
 *
 * The filters are the ones the page used to apply in the browser, applied here
 * with the same rules: `query` is a case-insensitive substring of the title,
 * system, suspected causes, or notes; `status` is a status or `active` (open or
 * monitoring); `system` and `confidence` are exact. Empty means "no filter".
 *
 * Only the sort key columns are read for every symptom; full rows and their
 * links are loaded for the requested slice alone.
 *
 * `total` and `statusCounts` describe the whole list, not the filtered one, so
 * the page's summary cards never shrink with a filter. Anything that is not
 * monitoring or resolved counts as open, as the page always counted it.
 *
 * @returns {{
 *   symptoms: object[],
 *   matched: number,
 *   total: number,
 *   statusCounts: { open: number, monitoring: number, resolved: number },
 * }}
 */
export function listSymptomPage(
  vehicleId,
  { query = "", status = "", system = "", confidence = "", sort = "newest", limit, offset = 0 }
) {
  const keys = db
    .prepare(`
      SELECT id, title, system, suspected_causes, notes, confidence, status, updated_at
      FROM symptoms
      WHERE vehicle_id = ?
      ORDER BY updated_at DESC, id DESC
    `)
    .all(vehicleId)
    .map((row, index) => ({
      index,
      id: Number(row.id),
      title: String(row.title || ""),
      system: String(row.system || ""),
      suspectedCauses: String(row.suspected_causes || ""),
      notes: String(row.notes || ""),
      confidence: String(row.confidence || "medium"),
      status: String(row.status || "open"),
      updatedAt: row.updated_at,
    }));

  const statusCounts = { open: 0, monitoring: 0, resolved: 0 };

  for (const key of keys) {
    if (key.status === "monitoring") {
      statusCounts.monitoring += 1;
    } else if (key.status === "resolved") {
      statusCounts.resolved += 1;
    } else {
      statusCounts.open += 1;
    }
  }

  const normalizedQuery = normalizeText(query).toLowerCase();
  const compare = SYMPTOM_COMPARATORS[sort] || SYMPTOM_COMPARATORS.newest;

  const matching = keys
    .filter(
      (key) =>
        matchesSymptomStatus(key.status, status) &&
        (!system || key.system === system) &&
        (!confidence || key.confidence === confidence) &&
        (!normalizedQuery ||
          [key.title, key.system, key.suspectedCauses, key.notes].some((value) =>
            value.toLowerCase().includes(normalizedQuery)
          ))
    )
    .sort((first, second) => compare(first, second) || first.index - second.index);

  const sliceIds = matching.slice(offset, offset + limit).map((key) => key.id);
  const rowsById = new Map(
    loadMappedSymptoms(vehicleId, sliceIds).map((symptom) => [symptom.id, symptom])
  );

  return {
    symptoms: sliceIds.map((id) => rowsById.get(id)).filter(Boolean),
    matched: matching.length,
    total: keys.length,
    statusCounts,
  };
}

// Every system name the vehicle's symptoms use, for the page's System filter.
// Built from the whole list so a filtered or paged view never shrinks its own
// choices; ordered as the page ordered them.
export function listSymptomSystems(vehicleId) {
  return db
    .prepare(`
      SELECT DISTINCT system
      FROM symptoms
      WHERE vehicle_id = ?
      AND system IS NOT NULL
      AND system <> ''
    `)
    .all(vehicleId)
    .map((row) => String(row.system))
    .sort((first, second) => symptomTextCollator.compare(first, second));
}

// Raw symptom row (snake_case) for an owned symptom, used by the partial-update
// merge in the route. Returns undefined when it is missing or owned elsewhere.
export function getSymptomRecord(vehicleId, symptomId) {
  return db
    .prepare(`
      SELECT
        id,
        title,
        description,
        system,
        suspected_causes,
        confidence,
        status,
        notes
      FROM symptoms
      WHERE id = ?
      AND vehicle_id = ?
    `)
    .get(symptomId, vehicleId);
}

function getExistingDocumentIds(vehicleId, requestedDocumentIds) {
  if (!requestedDocumentIds.length) {
    return [];
  }

  const placeholders = requestedDocumentIds.map(() => "?").join(", ");

  return db
    .prepare(`
      SELECT id
      FROM documents
      WHERE vehicle_id = ?
      AND id IN (${placeholders})
    `)
    .all(vehicleId, ...requestedDocumentIds)
    .map((row) => row.id);
}

// Replace a symptom's document links atomically: the DELETE and the re-INSERTs
// run in one transaction so a mid-replacement failure rolls back and leaves the
// original links intact (never a half-cleared set). Exported for testing.
export function replaceSymptomDocumentLinks(symptomId, vehicleId, requestedDocumentIds) {
  db.exec("BEGIN IMMEDIATE TRANSACTION");

  try {
    db.prepare("DELETE FROM symptom_documents WHERE symptom_id = ?").run(symptomId);

    const validDocumentIds = getExistingDocumentIds(vehicleId, requestedDocumentIds);

    if (validDocumentIds.length) {
      const insertLink = db.prepare(`
        INSERT INTO symptom_documents (symptom_id, document_id)
        VALUES (?, ?)
      `);

      for (const documentId of validDocumentIds) {
        insertLink.run(symptomId, documentId);
      }
    }

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

// Insert a symptom (fields already parsed + normalized by the caller), replace
// its document links, and return the freshly mapped symptom.
export function createSymptom(vehicleId, fields) {
  const insertResult = db
    .prepare(`
      INSERT INTO symptoms (
        vehicle_id,
        title,
        description,
        system,
        suspected_causes,
        confidence,
        status,
        notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      vehicleId,
      fields.title,
      fields.description,
      fields.system,
      fields.suspectedCauses,
      fields.confidence,
      fields.status,
      fields.notes
    );

  const symptomId = Number(insertResult.lastInsertRowid);
  replaceSymptomDocumentLinks(symptomId, vehicleId, fields.linkedDocumentIds);

  return getSymptom(vehicleId, symptomId);
}

// Update an owned symptom's core fields (fields already merged + normalized by
// the caller). Document-link replacement is a separate, caller-driven step.
export function updateSymptomFields(vehicleId, symptomId, fields) {
  db.prepare(`
    UPDATE symptoms
    SET
      title = ?,
      description = ?,
      system = ?,
      suspected_causes = ?,
      confidence = ?,
      status = ?,
      notes = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
    AND vehicle_id = ?
  `).run(
    fields.title,
    fields.description,
    fields.system,
    fields.suspectedCauses,
    fields.confidence,
    fields.status,
    fields.notes,
    symptomId,
    vehicleId
  );
}

// Delete an owned symptom row and unlink the notes that pointed at it, as one
// unit (audit 1B-05). Returns the number of symptom rows removed so the caller
// can distinguish "not found" (0) from a successful delete. Attachment cleanup
// is a separate, caller-driven step.
export function deleteSymptom(vehicleId, symptomId) {
  return withTransaction(() => {
    const removed = db
      .prepare(`
        DELETE FROM symptoms
        WHERE id = ?
        AND vehicle_id = ?
      `)
      .run(symptomId, vehicleId).changes;

    if (removed > 0) {
      clearNoteLinksTo(vehicleId, "symptom", symptomId);
    }

    return removed;
  });
}

// Stored procedures for one vehicle, shaped for the suggestion service's keyword
// overlap and for the suggestion response.
export function listCandidateProcedures(vehicleId) {
  return db
    .prepare(`
      SELECT
        id,
        title,
        system,
        difficulty,
        tools_needed,
        parts_needed,
        safety_notes,
        steps,
        notes
      FROM procedures
      WHERE vehicle_id = ?
      ORDER BY updated_at DESC, id DESC
    `)
    .all(vehicleId)
    .map((row) => ({
      id: row.id,
      title: row.title,
      system: row.system || "",
      difficulty: row.difficulty || "intermediate",
      toolsNeeded: row.tools_needed || "",
      partsNeeded: row.parts_needed || "",
      safetyNotes: row.safety_notes || "",
      steps: row.steps || "",
      notes: row.notes || "",
    }));
}
