import { Router } from "express";
import { deleteAttachmentsForEntity } from "../services/attachmentService.js";
import { getVehicleId } from "../services/vehicleService.js";
import {
  createNote,
  deleteNote,
  getNote,
  getNoteRecord,
  getRelatedEntityForVehicle,
  listNotes,
  normalizeNoteType,
  normalizeRelatedEntityId,
  normalizeRelatedEntityType,
  updateNoteFields,
} from "../services/noteService.js";
import { hasOwnField, normalizeText } from "../utils/text.js";
import { parsePositiveInt } from "../utils/http.js";

export const notesRouter = Router();

notesRouter.get("/", (_request, response) => {
  try {
    const vehicleId = getVehicleId();
    const notes = listNotes(vehicleId);

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

  let noteType;
  let relatedEntityType;
  let relatedEntityId;

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

    const createdNote = createNote(vehicleId, {
      title,
      content,
      noteType,
      relatedEntityType,
      relatedEntityId,
    });

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
  const noteId = parsePositiveInt(request.params.id);

  if (noteId === null) {
    response.status(400).json({
      error: "Note ID must be a positive number.",
    });
    return;
  }

  try {
    const vehicleId = getVehicleId();
    const existingNote = getNoteRecord(vehicleId, noteId);

    if (!existingNote) {
      response.status(404).json({
        error: "Note not found.",
      });
      return;
    }

    const legacyDocumentId =
      Number.isInteger(existingNote.document_id) && Number(existingNote.document_id) > 0
        ? existingNote.document_id
        : null;
    const existingTypeRaw = normalizeText(existingNote.related_entity_type).toLowerCase();
    const existingRelatedEntityType = existingTypeRaw || (legacyDocumentId ? "document" : "none");
    const existingRelatedEntityId =
      Number.isInteger(existingNote.related_entity_id) && Number(existingNote.related_entity_id) > 0
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

    updateNoteFields(vehicleId, noteId, {
      title,
      content,
      noteType,
      relatedEntityType,
      relatedEntityId,
    });

    const updatedNote = getNote(vehicleId, noteId);

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

notesRouter.delete("/:id", async (request, response) => {
  const noteId = parsePositiveInt(request.params.id);

  if (noteId === null) {
    response.status(400).json({
      error: "Note ID must be a positive number.",
    });
    return;
  }

  try {
    const vehicleId = getVehicleId();
    const removed = deleteNote(vehicleId, noteId);

    if (removed === 0) {
      response.status(404).json({
        error: "Note not found.",
      });
      return;
    }

    await deleteAttachmentsForEntity("note", noteId);

    response.json({
      message: "Note deleted.",
    });
  } catch (error) {
    response.status(500).json({
      error: error.message || "Could not delete note.",
    });
  }
});
