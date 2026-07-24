import { Router } from "express";
import { deleteAttachmentsForEntity } from "../services/attachmentService.js";
import { setProcedureSymptoms } from "../services/symptomProcedureService.js";
import { getVehicleId } from "../services/vehicleService.js";
import {
  createProcedure,
  deleteProcedure,
  getProcedure,
  getProcedureRecord,
  listProcedures,
  normalizeConfidence,
  normalizeDifficulty,
  replaceProcedureDocumentLinks,
  updateProcedureFields,
} from "../services/procedureService.js";
import { hasOwnField, normalizeText } from "../utils/text.js";
import { parsePositiveInt, parsePositiveIntArray } from "../utils/http.js";

export const proceduresRouter = Router();

proceduresRouter.get("/", (_request, response) => {
  try {
    const vehicleId = getVehicleId();
    const procedures = listProcedures(vehicleId);

    response.json({
      procedures,
      total: procedures.length,
    });
  } catch (error) {
    response.status(500).json({
      error: error.message || "Could not load procedures.",
    });
  }
});

proceduresRouter.get("/:id", (request, response) => {
  const procedureId = parsePositiveInt(request.params.id);

  if (procedureId === null) {
    response.status(400).json({
      error: "Procedure ID must be a positive number.",
    });
    return;
  }

  try {
    const vehicleId = getVehicleId();
    const procedure = getProcedure(vehicleId, procedureId);

    if (!procedure) {
      response.status(404).json({
        error: "Procedure not found.",
      });
      return;
    }

    response.json({ procedure });
  } catch (error) {
    response.status(500).json({
      error: error.message || "Could not load procedure.",
    });
  }
});

proceduresRouter.post("/", (request, response) => {
  const title = normalizeText(request.body.title);
  const system = normalizeText(request.body.system);
  const toolsNeeded = normalizeText(request.body.toolsNeeded);
  const partsNeeded = normalizeText(request.body.partsNeeded);
  const safetyNotes = normalizeText(request.body.safetyNotes);
  const steps = normalizeText(request.body.steps);
  const notes = normalizeText(request.body.notes);
  const linkedDocumentIds = parsePositiveIntArray(request.body.linkedDocumentIds);

  if (!title) {
    response.status(400).json({
      error: "Title is required.",
    });
    return;
  }

  let difficulty;
  let confidence;

  try {
    difficulty = normalizeDifficulty(request.body.difficulty);
    confidence = normalizeConfidence(request.body.confidence);
  } catch (error) {
    response.status(400).json({
      error: error.message || "Invalid procedure values.",
    });
    return;
  }

  try {
    const vehicleId = getVehicleId();
    const createdProcedure = createProcedure(vehicleId, {
      title,
      system,
      difficulty,
      toolsNeeded,
      partsNeeded,
      safetyNotes,
      steps,
      notes,
      confidence,
      linkedDocumentIds,
    });

    response.status(201).json({
      message: "Procedure created.",
      procedure: createdProcedure,
    });
  } catch (error) {
    response.status(500).json({
      error: error.message || "Could not create procedure.",
    });
  }
});

proceduresRouter.put("/:id", (request, response) => {
  const procedureId = parsePositiveInt(request.params.id);

  if (procedureId === null) {
    response.status(400).json({
      error: "Procedure ID must be a positive number.",
    });
    return;
  }

  try {
    const vehicleId = getVehicleId();
    const existingProcedure = getProcedureRecord(vehicleId, procedureId);

    if (!existingProcedure) {
      response.status(404).json({
        error: "Procedure not found.",
      });
      return;
    }

    const title = hasOwnField(request.body, "title")
      ? normalizeText(request.body.title)
      : existingProcedure.title;
    const system = hasOwnField(request.body, "system")
      ? normalizeText(request.body.system)
      : existingProcedure.system || "";
    const toolsNeeded = hasOwnField(request.body, "toolsNeeded")
      ? normalizeText(request.body.toolsNeeded)
      : existingProcedure.tools_needed || "";
    const partsNeeded = hasOwnField(request.body, "partsNeeded")
      ? normalizeText(request.body.partsNeeded)
      : existingProcedure.parts_needed || "";
    const safetyNotes = hasOwnField(request.body, "safetyNotes")
      ? normalizeText(request.body.safetyNotes)
      : existingProcedure.safety_notes || "";
    const steps = hasOwnField(request.body, "steps")
      ? normalizeText(request.body.steps)
      : existingProcedure.steps || "";
    const notes = hasOwnField(request.body, "notes")
      ? normalizeText(request.body.notes)
      : existingProcedure.notes || "";

    if (!title) {
      response.status(400).json({
        error: "Title is required.",
      });
      return;
    }

    let difficulty = existingProcedure.difficulty || "intermediate";
    let confidence = existingProcedure.confidence || "medium";

    try {
      difficulty = hasOwnField(request.body, "difficulty")
        ? normalizeDifficulty(request.body.difficulty)
        : normalizeDifficulty(existingProcedure.difficulty);

      confidence = hasOwnField(request.body, "confidence")
        ? normalizeConfidence(request.body.confidence)
        : normalizeConfidence(existingProcedure.confidence);
    } catch (error) {
      response.status(400).json({
        error: error.message || "Invalid procedure values.",
      });
      return;
    }

    updateProcedureFields(vehicleId, procedureId, {
      title,
      system,
      difficulty,
      toolsNeeded,
      partsNeeded,
      safetyNotes,
      steps,
      notes,
      confidence,
    });

    if (hasOwnField(request.body, "linkedDocumentIds")) {
      const linkedDocumentIds = parsePositiveIntArray(request.body.linkedDocumentIds);
      replaceProcedureDocumentLinks(procedureId, vehicleId, linkedDocumentIds);
    }

    const updatedProcedure = getProcedure(vehicleId, procedureId);

    response.json({
      message: "Procedure updated.",
      procedure: updatedProcedure,
    });
  } catch (error) {
    response.status(500).json({
      error: error.message || "Could not update procedure.",
    });
  }
});

// Replace the set of symptoms linked to one procedure (manual linking).
proceduresRouter.put("/:id/symptoms", (request, response) => {
  const procedureId = parsePositiveInt(request.params.id);

  if (procedureId === null) {
    response.status(400).json({
      error: "Procedure ID must be a positive number.",
    });
    return;
  }

  try {
    const vehicleId = getVehicleId();
    const existingProcedure = getProcedureRecord(vehicleId, procedureId);

    if (!existingProcedure) {
      response.status(404).json({
        error: "Procedure not found.",
      });
      return;
    }

    const symptomIds = parsePositiveIntArray(request.body.symptomIds);
    setProcedureSymptoms(procedureId, symptomIds);

    const updatedProcedure = getProcedure(vehicleId, procedureId);

    response.json({
      message: "Linked symptoms updated.",
      procedure: updatedProcedure,
    });
  } catch (error) {
    response.status(500).json({
      error: error.message || "Could not update linked symptoms.",
    });
  }
});

proceduresRouter.delete("/:id", async (request, response) => {
  const procedureId = parsePositiveInt(request.params.id);

  if (procedureId === null) {
    response.status(400).json({
      error: "Procedure ID must be a positive number.",
    });
    return;
  }

  try {
    const vehicleId = getVehicleId();

    // Remove attachments before the entity row so a cleanup failure can't strand
    // attachment rows/files after the owning procedure is already gone.
    await deleteAttachmentsForEntity("procedure", procedureId);

    const removed = deleteProcedure(vehicleId, procedureId);

    if (removed === 0) {
      response.status(404).json({
        error: "Procedure not found.",
      });
      return;
    }

    response.json({
      message: "Procedure deleted.",
    });
  } catch (error) {
    response.status(500).json({
      error: error.message || "Could not delete procedure.",
    });
  }
});
