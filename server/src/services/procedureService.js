import { db } from "../database.js";
import { buildProcedureSymptomLinksMap } from "./symptomProcedureService.js";
import { normalizeText } from "../utils/text.js";

const allowedConfidenceValues = new Set(["low", "medium", "high"]);
const allowedDifficultyValues = new Set(["beginner", "intermediate", "advanced"]);

// NOTE: normalizeConfidence is currently byte-identical to
// symptomService.normalizeConfidence. The duplication is intentional for this
// behavior-preserving extraction — sharing the normalize helpers is deferred to
// the later consolidation pass so this PR stays one concern.
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

export function normalizeDifficulty(value) {
  const normalized = normalizeText(value).toLowerCase();

  if (!normalized) {
    return "intermediate";
  }

  if (!allowedDifficultyValues.has(normalized)) {
    throw new Error("Difficulty must be beginner, intermediate, or advanced.");
  }

  return normalized;
}

// The procedure fields shared by the full API view (mapProcedureRow) and the
// search view (searchService.mapProcedureRow): the core columns plus the
// linked-document projection. Extracted so the two views cannot silently drift
// apart. The search view stops here; the full view augments it with linked
// symptoms. `linkedDocuments` is the already-built array for this row.
export function mapProcedureCore(row, linkedDocuments) {
  return {
    id: row.id,
    title: row.title,
    system: row.system || "",
    difficulty: row.difficulty || "intermediate",
    toolsNeeded: row.tools_needed || "",
    partsNeeded: row.parts_needed || "",
    safetyNotes: row.safety_notes || "",
    steps: row.steps || "",
    notes: row.notes || "",
    confidence: row.confidence || "medium",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    linkedDocumentIds: linkedDocuments.map((document) => document.id),
    linkedDocuments,
  };
}

export function mapProcedureRow(row, documentLinksMap, symptomLinksMap) {
  const linkedSymptoms = symptomLinksMap.get(row.id) || [];

  return {
    ...mapProcedureCore(row, documentLinksMap.get(row.id) || []),
    linkedSymptomIds: linkedSymptoms.map((symptom) => symptom.id),
    linkedSymptoms,
  };
}

export function listProcedures(vehicleId) {
  const procedureRows = db
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
        notes,
        confidence,
        created_at,
        updated_at
      FROM procedures
      WHERE vehicle_id = ?
      ORDER BY updated_at DESC, id DESC
    `)
    .all(vehicleId);

  const linkRows = db
    .prepare(`
      SELECT
        procedure_documents.procedure_id,
        documents.id AS document_id,
        documents.title AS document_title,
        documents.system AS document_system,
        documents.document_type AS document_type
      FROM procedure_documents
      JOIN procedures ON procedures.id = procedure_documents.procedure_id
      JOIN documents ON documents.id = procedure_documents.document_id
      WHERE procedures.vehicle_id = ?
      ORDER BY documents.title COLLATE NOCASE ASC
    `)
    .all(vehicleId);

  const documentLinksMap = new Map();

  for (const linkRow of linkRows) {
    if (!documentLinksMap.has(linkRow.procedure_id)) {
      documentLinksMap.set(linkRow.procedure_id, []);
    }

    documentLinksMap.get(linkRow.procedure_id).push({
      id: linkRow.document_id,
      title: linkRow.document_title,
      system: linkRow.document_system || "",
      documentType: linkRow.document_type || "",
    });
  }

  const symptomLinksMap = buildProcedureSymptomLinksMap(vehicleId);

  return procedureRows.map((row) =>
    mapProcedureRow(row, documentLinksMap, symptomLinksMap)
  );
}

// A single mapped procedure, or undefined when it does not belong to the
// vehicle. Derived from listProcedures so the link maps are built exactly as in
// the list view (behavior-preserving; callers relied on this
// whole-list-then-find shape).
export function getProcedure(vehicleId, procedureId) {
  return listProcedures(vehicleId).find((procedure) => procedure.id === procedureId);
}

// Raw procedure row (snake_case) for an owned procedure, used by the
// partial-update merge in the route. Returns undefined when it is missing or
// owned elsewhere.
export function getProcedureRecord(vehicleId, procedureId) {
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
        notes,
        confidence
      FROM procedures
      WHERE id = ?
      AND vehicle_id = ?
    `)
    .get(procedureId, vehicleId);
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

// Replace a procedure's document links atomically: the DELETE and the
// re-INSERTs run in one transaction so a mid-replacement failure rolls back and
// leaves the original links intact (never a half-cleared set). Exported for testing.
export function replaceProcedureDocumentLinks(procedureId, vehicleId, requestedDocumentIds) {
  db.exec("BEGIN IMMEDIATE TRANSACTION");

  try {
    db.prepare("DELETE FROM procedure_documents WHERE procedure_id = ?").run(procedureId);

    const validDocumentIds = getExistingDocumentIds(vehicleId, requestedDocumentIds);

    if (validDocumentIds.length) {
      const insertLink = db.prepare(`
        INSERT INTO procedure_documents (procedure_id, document_id)
        VALUES (?, ?)
      `);

      for (const documentId of validDocumentIds) {
        insertLink.run(procedureId, documentId);
      }
    }

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

// Insert a procedure (fields already parsed + normalized by the caller), replace
// its document links, and return the freshly mapped procedure.
export function createProcedure(vehicleId, fields) {
  const insertResult = db
    .prepare(`
      INSERT INTO procedures (
        vehicle_id,
        title,
        system,
        difficulty,
        tools_needed,
        parts_needed,
        safety_notes,
        steps,
        notes,
        confidence
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      vehicleId,
      fields.title,
      fields.system,
      fields.difficulty,
      fields.toolsNeeded,
      fields.partsNeeded,
      fields.safetyNotes,
      fields.steps,
      fields.notes,
      fields.confidence
    );

  const procedureId = Number(insertResult.lastInsertRowid);
  replaceProcedureDocumentLinks(procedureId, vehicleId, fields.linkedDocumentIds);

  return getProcedure(vehicleId, procedureId);
}

// Update an owned procedure's core fields (fields already merged + normalized by
// the caller). Document-link replacement is a separate, caller-driven step.
export function updateProcedureFields(vehicleId, procedureId, fields) {
  db.prepare(`
    UPDATE procedures
    SET
      title = ?,
      system = ?,
      difficulty = ?,
      tools_needed = ?,
      parts_needed = ?,
      safety_notes = ?,
      steps = ?,
      notes = ?,
      confidence = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
    AND vehicle_id = ?
  `).run(
    fields.title,
    fields.system,
    fields.difficulty,
    fields.toolsNeeded,
    fields.partsNeeded,
    fields.safetyNotes,
    fields.steps,
    fields.notes,
    fields.confidence,
    procedureId,
    vehicleId
  );
}

// Delete an owned procedure row. Returns the number of rows removed so the
// caller can distinguish "not found" (0) from a successful delete. Attachment
// cleanup is a separate, caller-driven step.
export function deleteProcedure(vehicleId, procedureId) {
  return db
    .prepare(`
      DELETE FROM procedures
      WHERE id = ?
      AND vehicle_id = ?
    `)
    .run(procedureId, vehicleId).changes;
}
