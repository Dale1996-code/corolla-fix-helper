import { Router } from "express";
import { db } from "../database.js";

export const notesRouter = Router();

const allowedNoteTypes = new Set(["general", "observation", "repair_log", "reminder"]);
const allowedRelatedEntityTypes = new Set(["none", "document", "symptom", "procedure"]);

function hasOwnField(object, fieldName) {
  return Object.prototype.hasOwnProperty.call(object, fieldName);
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeNoteType(value) {
  const normalized = normalizeText(value).toLowerCase();

  if (!normalized) {
    return "general";
  }

  if (!allowedNoteTypes.has(normalized)) {
    throw new Error("Note type must be general, observation, repair_log, or reminder.");
  }

  return normalized;
}

function normalizeRelatedEntityType(value) {
  const normalized = normalizeText(value).toLowerCase();

  if (!normalized) {
    return "none";
  }

  if (!allowedRelatedEntityTypes.has(normalized)) {
    throw new Error("Related entity type must be none, document, symptom, or procedure.");
  }

  return normalized;
}

function normalizeRelatedEntityId(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const id = Number(value);

  if (!Number.isInteger(id) || id <= 0) {
    throw new Error("Related entity ID must be a positive number.");
  }

  return id;
}

function getVehicleId() {
  const vehicle = db
    .prepare("SELECT id FROM vehicles ORDER BY id ASC LIMIT 1")
    .get();

  if (!vehicle) {
    throw new Error("No vehicle record exists yet.");
  }

  return vehicle.id;
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

function getRelatedEntityForVehicle(vehicleId, relatedEntityType, relatedEntityId) {
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

function mapNoteRow(row) {
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

function listNotesForVehicle(vehicleId) {
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

notesRouter.get("/", (_request, response) => {
  try {
    const vehicleId = getVehicleId();
    const notes = listNotesForVehicle(vehicleId);

    response.json({
      notes,
      total: notes.length,
    });
  } catch (error) {
    response.status(500).json({
      error: error.message || "Could not load notes.",
    });
  }
});

notesRouter.post("/", (request, response) => {
  const title = normalizeText(request.body.title);
  const content = normalizeText(request.body.content);

  if (!title) {
    response.status(400).json({
      error: "Title is required.",
    });
    return;
  }

  let noteType = "general";
  let relatedEntityType = "none";
  let relatedEntityId = null;

  try {
    noteType = normalizeNoteType(request.body.noteType);
    relatedEntityType = normalizeRelatedEntityType(request.body.relatedEntityType);
    relatedEntityId = normalizeRelatedEntityId(request.body.relatedEntityId);
  } catch (error) {
    response.status(400).json({
      error: error.message || "Invalid note values.",
    });
    return;
  }

  if (relatedEntityType === "none") {
    relatedEntityId = null;
  } else if (!relatedEntityId) {
    response.status(400).json({
      error: "Related entity ID is required when entity type is not none.",
    });
    return;
  }

  try {
    const vehicleId = getVehicleId();

    if (relatedEntityType !== "none") {
      const linkedEntity = getRelatedEntityForVehicle(
        vehicleId,
        relatedEntityType,
        relatedEntityId
      );

      if (!linkedEntity) {
        response.status(400).json({
          error: `Linked ${relatedEntityType} does not exist.`,
        });
        return;
      }
    }

    const documentId = relatedEntityType === "document" ? relatedEntityId : null;

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
        title,
        content,
        content,
        noteType,
        relatedEntityType,
        relatedEntityId,
        documentId
      );

    const noteId = Number(insertResult.lastInsertRowid);
    const notes = listNotesForVehicle(vehicleId);
    const createdNote = notes.find((note) => note.id === noteId);

    response.status(201).json({
      message: "Note created.",
      note: createdNote,
    });
  } catch (error) {
    response.status(500).json({
      error: error.message || "Could not create note.",
    });
  }
});

notesRouter.put("/:id", (request, response) => {
  const noteId = Number(request.params.id);

  if (!Number.isInteger(noteId) || noteId <= 0) {
    response.status(400).json({
      error: "Note ID must be a positive number.",
    });
    return;
  }

  try {
    const vehicleId = getVehicleId();
    const existingNote = db
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

    if (!existingNote) {
      response.status(404).json({
        error: "Note not found.",
      });
      return;
    }

    const legacyDocumentId =
      Number.isInteger(existingNote.document_id) && existingNote.document_id > 0
        ? existingNote.document_id
        : null;
    const existingTypeRaw = normalizeText(existingNote.related_entity_type).toLowerCase();
    const existingRelatedEntityType = existingTypeRaw || (legacyDocumentId ? "document" : "none");
    const existingRelatedEntityId =
      Number.isInteger(existingNote.related_entity_id) && existingNote.related_entity_id > 0
        ? existingNote.related_entity_id
        : legacyDocumentId;

    const title = hasOwnField(request.body, "title")
      ? normalizeText(request.body.title)
      : existingNote.title || "";
    const content = hasOwnField(request.body, "content")
      ? normalizeText(request.body.content)
      : existingNote.content || existingNote.body || "";

    if (!title) {
      response.status(400).json({
        error: "Title is required.",
      });
      return;
    }

    let noteType = existingNote.note_type || "general";
    let relatedEntityType = existingRelatedEntityType;
    let relatedEntityId = existingRelatedEntityId;

    try {
      noteType = hasOwnField(request.body, "noteType")
        ? normalizeNoteType(request.body.noteType)
        : normalizeNoteType(existingNote.note_type);

      relatedEntityType = hasOwnField(request.body, "relatedEntityType")
        ? normalizeRelatedEntityType(request.body.relatedEntityType)
        : normalizeRelatedEntityType(existingRelatedEntityType);

      relatedEntityId = hasOwnField(request.body, "relatedEntityId")
        ? normalizeRelatedEntityId(request.body.relatedEntityId)
        : normalizeRelatedEntityId(existingRelatedEntityId);
    } catch (error) {
      response.status(400).json({
        error: error.message || "Invalid note values.",
      });
      return;
    }

    if (relatedEntityType === "none") {
      relatedEntityId = null;
    } else if (!relatedEntityId) {
      response.status(400).json({
        error: "Related entity ID is required when entity type is not none.",
      });
      return;
    }

    if (relatedEntityType !== "none") {
      const linkedEntity = getRelatedEntityForVehicle(
        vehicleId,
        relatedEntityType,
        relatedEntityId
      );

      if (!linkedEntity) {
        response.status(400).json({
          error: `Linked ${relatedEntityType} does not exist.`,
        });
        return;
      }
    }

    const documentId = relatedEntityType === "document" ? relatedEntityId : null;

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
      title,
      content,
      content,
      noteType,
      relatedEntityType,
      relatedEntityId,
      documentId,
      noteId,
      vehicleId
    );

    const notes = listNotesForVehicle(vehicleId);
    const updatedNote = notes.find((note) => note.id === noteId);

    response.json({
      message: "Note updated.",
      note: updatedNote,
    });
  } catch (error) {
    response.status(500).json({
      error: error.message || "Could not update note.",
    });
  }
});

notesRouter.delete("/:id", (request, response) => {
  const noteId = Number(request.params.id);

  if (!Number.isInteger(noteId) || noteId <= 0) {
    response.status(400).json({
      error: "Note ID must be a positive number.",
    });
    return;
  }

  try {
    const vehicleId = getVehicleId();
    const deleteResult = db
      .prepare(`
        DELETE FROM notes
        WHERE id = ?
        AND vehicle_id = ?
      `)
      .run(noteId, vehicleId);

    if (deleteResult.changes === 0) {
      response.status(404).json({
        error: "Note not found.",
      });
      return;
    }

    response.json({
      message: "Note deleted.",
    });
  } catch (error) {
    response.status(500).json({
      error: error.message || "Could not delete note.",
    });
  }
});
