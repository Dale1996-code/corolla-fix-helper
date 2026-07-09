import { db } from "../database.js";
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

export function mapSymptomRow(row, documentLinksMap, procedureLinksMap) {
  const linkedDocuments = documentLinksMap.get(row.id) || [];
  const linkedProcedures = procedureLinksMap.get(row.id) || [];

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
    linkedProcedureIds: linkedProcedures.map((procedure) => procedure.id),
    linkedProcedures,
  };
}

export function listSymptoms(vehicleId) {
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
      ORDER BY updated_at DESC, id DESC
    `)
    .all(vehicleId);

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
      ORDER BY documents.title COLLATE NOCASE ASC
    `)
    .all(vehicleId);

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

  const procedureLinksMap = buildSymptomProcedureLinksMap(vehicleId);

  return symptomRows.map((row) =>
    mapSymptomRow(row, documentLinksMap, procedureLinksMap)
  );
}

// A single mapped symptom, or undefined when it does not belong to the vehicle.
// Derived from listSymptoms so the link maps are built exactly as in the list
// view (behavior-preserving; callers relied on this whole-list-then-find shape).
export function getSymptom(vehicleId, symptomId) {
  return listSymptoms(vehicleId).find((symptom) => symptom.id === symptomId);
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

// Delete an owned symptom row. Returns the number of rows removed so the caller
// can distinguish "not found" (0) from a successful delete. Attachment cleanup
// is a separate, caller-driven step.
export function deleteSymptom(vehicleId, symptomId) {
  return db
    .prepare(`
      DELETE FROM symptoms
      WHERE id = ?
      AND vehicle_id = ?
    `)
    .run(symptomId, vehicleId).changes;
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
