import { db } from "../database.js";
import { normalizeText } from "../utils/text.js";

const allowedNoteTypes = new Set(["general", "observation", "repair_log", "reminder"]);
const allowedRelatedEntityTypes = new Set(["none", "document", "symptom", "procedure"]);

export function normalizeNoteType(value) {
  const normalized = normalizeText(value).toLowerCase();

  if (!normalized) {
    return "general";
  }

  if (!allowedNoteTypes.has(normalized)) {
    throw new Error("Note type must be general, observation, repair_log, or reminder.");
  }

  return normalized;
}

export function normalizeRelatedEntityType(value) {
  const normalized = normalizeText(value).toLowerCase();

  if (!normalized) {
    return "none";
  }

  if (!allowedRelatedEntityTypes.has(normalized)) {
    throw new Error("Related entity type must be none, document, symptom, or procedure.");
  }

  return normalized;
}

export function normalizeRelatedEntityId(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const id = Number(value);

  if (!Number.isInteger(id) || id <= 0) {
    throw new Error("Related entity ID must be a positive number.");
  }

  return id;
}

function getDocumentForVehicle(vehicleId, documentId) {
  return db
    .prepare(`
      SELECT
        id,
        title,
        system,
        document_type
      FROM documents
      WHERE id = ?
      AND vehicle_id = ?
    `)
    .get(documentId, vehicleId);
}

function getSymptomForVehicle(vehicleId, symptomId) {
  return db
    .prepare(`
      SELECT
        id,
        title,
        system,
        status
      FROM symptoms
      WHERE id = ?
      AND vehicle_id = ?
    `)
    .get(symptomId, vehicleId);
}

function getProcedureForVehicle(vehicleId, procedureId) {
  return db
    .prepare(`
      SELECT
        id,
        title,
        system,
        difficulty
      FROM procedures
      WHERE id = ?
      AND vehicle_id = ?
    `)
    .get(procedureId, vehicleId);
}

// Look up the linked entity a note points at, dispatched by type. Returns the
// row when it exists and belongs to the vehicle, or null/undefined otherwise —
// the caller decides how to react (the route turns a miss into a 400).
export function getRelatedEntityForVehicle(vehicleId, relatedEntityType, relatedEntityId) {
  if (relatedEntityType === "document") {
    return getDocumentForVehicle(vehicleId, relatedEntityId);
  }

  if (relatedEntityType === "symptom") {
    return getSymptomForVehicle(vehicleId, relatedEntityId);
  }

  if (relatedEntityType === "procedure") {
    return getProcedureForVehicle(vehicleId, relatedEntityId);
  }

  return null;
}

export function mapNoteRow(row) {
  const legacyDocumentId =
    Number.isInteger(row.document_id) && row.document_id > 0 ? row.document_id : null;
  const rawRelatedEntityType = normalizeText(row.related_entity_type).toLowerCase();
  const relatedEntityType = rawRelatedEntityType || (legacyDocumentId ? "document" : "none");
  let relatedEntityId =
    Number.isInteger(row.related_entity_id) && row.related_entity_id > 0
      ? row.related_entity_id
      : null;

  if (relatedEntityType === "document" && !relatedEntityId) {
    relatedEntityId = legacyDocumentId;
  }

  const linkedDocument = row.linked_document_id
    ? {
        id: row.linked_document_id,
        title: row.linked_document_title,
        system: row.linked_document_system || "",
        documentType: row.linked_document_type || "",
      }
    : null;
  const linkedSymptom = row.linked_symptom_id
    ? {
        id: row.linked_symptom_id,
        title: row.linked_symptom_title,
        system: row.linked_symptom_system || "",
        status: row.linked_symptom_status || "open",
      }
    : null;
  const linkedProcedure = row.linked_procedure_id
    ? {
        id: row.linked_procedure_id,
        title: row.linked_procedure_title,
        system: row.linked_procedure_system || "",
        difficulty: row.linked_procedure_difficulty || "intermediate",
      }
    : null;

  return {
    id: row.id,
    title: row.title || "",
    content: row.content || row.body || "",
    noteType: row.note_type || "general",
    relatedEntityType,
    relatedEntityId,
    linkedDocument,
    linkedSymptom,
    linkedProcedure,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listNotes(vehicleId) {
  const noteRows = db
    .prepare(`
      SELECT
        notes.id,
        notes.title,
        notes.body,
        notes.content,
        notes.note_type,
        notes.related_entity_type,
        notes.related_entity_id,
        notes.document_id,
        notes.created_at,
        notes.updated_at,
        documents.id AS linked_document_id,
        documents.title AS linked_document_title,
        documents.system AS linked_document_system,
        documents.document_type AS linked_document_type,
        symptoms.id AS linked_symptom_id,
        symptoms.title AS linked_symptom_title,
        symptoms.system AS linked_symptom_system,
        symptoms.status AS linked_symptom_status,
        procedures.id AS linked_procedure_id,
        procedures.title AS linked_procedure_title,
        procedures.system AS linked_procedure_system,
        procedures.difficulty AS linked_procedure_difficulty
      FROM notes
      LEFT JOIN documents ON documents.vehicle_id = notes.vehicle_id
        AND (
          (notes.related_entity_type = 'document' AND notes.related_entity_id = documents.id)
          OR (
            (notes.related_entity_type IS NULL OR TRIM(notes.related_entity_type) = '')
            AND notes.document_id = documents.id
          )
        )
      LEFT JOIN symptoms ON symptoms.vehicle_id = notes.vehicle_id
        AND notes.related_entity_type = 'symptom'
        AND notes.related_entity_id = symptoms.id
      LEFT JOIN procedures ON procedures.vehicle_id = notes.vehicle_id
        AND notes.related_entity_type = 'procedure'
        AND notes.related_entity_id = procedures.id
      WHERE notes.vehicle_id = ?
      ORDER BY notes.updated_at DESC, notes.id DESC
    `)
    .all(vehicleId);

  return noteRows.map((row) => mapNoteRow(row));
}

// A single mapped note, or undefined when it does not belong to the vehicle.
// Derived from listNotes so the linked-entity joins are built exactly as in the
// list view (behavior-preserving; callers relied on this
// whole-list-then-find shape).
export function getNote(vehicleId, noteId) {
  return listNotes(vehicleId).find((note) => note.id === noteId);
}

// Raw note row (snake_case, both legacy body + content columns) for an owned
// note, used by the partial-update merge in the route. Returns undefined when
// it is missing or owned elsewhere.
export function getNoteRecord(vehicleId, noteId) {
  return db
    .prepare(`
      SELECT
        id,
        title,
        body,
        content,
        note_type,
        related_entity_type,
        related_entity_id,
        document_id
      FROM notes
      WHERE id = ?
      AND vehicle_id = ?
    `)
    .get(noteId, vehicleId);
}

// Insert a note (fields already parsed + normalized by the caller) and return
// the freshly mapped note. The legacy document_id column is derived here so the
// route does not need to know about it.
export function createNote(vehicleId, fields) {
  const documentId = fields.relatedEntityType === "document" ? fields.relatedEntityId : null;

  const insertResult = db
    .prepare(`
      INSERT INTO notes (
        vehicle_id,
        title,
        body,
        content,
        note_type,
        related_entity_type,
        related_entity_id,
        document_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      vehicleId,
      fields.title,
      fields.content,
      fields.content,
      fields.noteType,
      fields.relatedEntityType,
      fields.relatedEntityId,
      documentId
    );

  const noteId = Number(insertResult.lastInsertRowid);

  return getNote(vehicleId, noteId);
}

// Update an owned note's fields (fields already merged + normalized by the
// caller). The legacy document_id column is kept in sync with the related-entity
// link here, mirroring createNote.
export function updateNoteFields(vehicleId, noteId, fields) {
  const documentId = fields.relatedEntityType === "document" ? fields.relatedEntityId : null;

  db.prepare(`
    UPDATE notes
    SET
      title = ?,
      body = ?,
      content = ?,
      note_type = ?,
      related_entity_type = ?,
      related_entity_id = ?,
      document_id = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
    AND vehicle_id = ?
  `).run(
    fields.title,
    fields.content,
    fields.content,
    fields.noteType,
    fields.relatedEntityType,
    fields.relatedEntityId,
    documentId,
    noteId,
    vehicleId
  );
}

// Delete an owned note row. Returns the number of rows removed so the caller can
// distinguish "not found" (0) from a successful delete. Attachment cleanup is a
// separate, caller-driven step.
export function deleteNote(vehicleId, noteId) {
  return db
    .prepare(`
      DELETE FROM notes
      WHERE id = ?
      AND vehicle_id = ?
    `)
    .run(noteId, vehicleId).changes;
}
