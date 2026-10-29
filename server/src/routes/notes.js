import { Router } from "express";
import { deleteAttachmentsForEntity } from "../services/attachmentService.js";
import { getVehicleId } from "../services/vehicleService.js";
import {
  createNote,
  deleteNote,
  getNote,
  getNoteRecord,
  getRelatedEntityForVehicle,
  listNotePage,
  listNotes,
  listNoteTypes,
  NOTE_LIST_SORT_KEYS,
  normalizeNoteType,
  normalizeRelatedEntityId,
  normalizeRelatedEntityType,
  updateNoteFields,
} from "../services/noteService.js";
import { hasOwnField, normalizeText } from "../utils/text.js";
import { parsePageLimit, parsePageOffset, parsePositiveInt } from "../utils/http.js";

export const notesRouter = Router();

const NOTE_RELATED_ENTITY_FILTERS = ["none", "document", "symptom", "procedure"];

// Only plain strings count: Express parses `?noteType=a&noteType=b` into an array.
function getQueryString(request, name) {
  return typeof request.query[name] === "string" ? request.query[name] : "";
}

notesRouter.get("/", (request, response) => {
  try {
    const vehicleId = getVehicleId();

    // Backward compatible: with no `limit` query, return every note and ignore
    // any filter. With `limit`, return one filtered, ordered page -- what the
    // Notes page asks for (N7).
    if (request.query.limit === undefined) {
      const notes = listNotes(vehicleId);

      response.json({
        notes,
        total: notes.length,
      });
      return;
    }

    const limit = parsePageLimit(request.query.limit, { defaultLimit: 25, maxLimit: 100 });
    const offset = parsePageOffset(request.query.offset);
    const relatedEntityType = getQueryString(request, "relatedEntityType");
    const sort = getQueryString(request, "sort");
    const page = listNotePage(vehicleId, {
      // A note type is free text the owner chose, so it is matched exactly.
      noteType: getQueryString(request, "noteType"),
      relatedEntityType: NOTE_RELATED_ENTITY_FILTERS.includes(relatedEntityType)
        ? relatedEntityType
        : "",
      sort: NOTE_LIST_SORT_KEYS.includes(sort) ? sort : "newest",
      limit,
      offset,
    });

    // `total` is every note; `matched` is how many the filters leave.
    response.json({ ...page, limit, offset });
  } catch (error) {
    response.status(500).json({
      error: error.message || "Could not load notes.",
    });
  }
});

// The choices the page's Note type filter offers, from every note rather than
// from the loaded page. Declared before `/:id` so it is never read as an id.
notesRouter.get("/filter-options", (_request, response) => {
  try {
    response.json({ noteTypes: listNoteTypes(getVehicleId()) });
  } catch (error) {
    response.status(500).json({
      error: error.message || "Could not load note filters.",
    });
  }
});

// One note, for a selection that is not on the page the list loaded (a deep
// link, or a note just created that the filters hide).
notesRouter.get("/:id", (request, response) => {
  const noteId = parsePositiveInt(request.params.id);

  if (noteId === null) {
    response.status(400).json({ error: "Note ID must be a positive number." });
    return;
  }

  try {
    const note = getNote(getVehicleId(), noteId);

    if (!note) {
      response.status(404).json({ error: "Note not found." });
      return;
    }

    response.json({ note });
  } catch (error) {
    response.status(500).json({
      error: error.message || "Could not load note.",
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
        const keepsExistingLink =
          relatedEntityType === existingRelatedEntityType &&
          relatedEntityId === existingRelatedEntityId;

        if (!keepsExistingLink) {
          response.status(400).json({
            error: `Linked ${relatedEntityType} does not exist.`,
          });
          return;
        }

        // The note already pointed here and the record has since been deleted
        // (before 1B-05 a symptom or procedure delete left the link behind).
        // Refusing would make the note uneditable for good, so the edit drops
        // the dead link instead. A NEW link to a missing record is still a 400.
        relatedEntityType = "none";
        relatedEntityId = null;
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

    // Remove attachments before the entity row so a cleanup failure can't strand
    // attachment rows/files after the owning note is already gone.
    await deleteAttachmentsForEntity("note", noteId);

    const removed = deleteNote(vehicleId, noteId);

    if (removed === 0) {
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
