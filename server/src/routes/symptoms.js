import { Router } from "express";
import { deleteAttachmentsForEntity } from "../services/attachmentService.js";
import { setSymptomProcedures } from "../services/symptomProcedureService.js";
import { suggestProceduresForSymptom } from "../services/procedureSuggestionService.js";
import { getVehicleId } from "../services/vehicleService.js";
import {
  createSymptom,
  deleteSymptom,
  getSymptom,
  getSymptomRecord,
  listCandidateProcedures,
  listSymptoms,
  normalizeConfidence,
  normalizeStatus,
  replaceSymptomDocumentLinks,
  updateSymptomFields,
} from "../services/symptomService.js";
import { hasOwnField, normalizeText } from "../utils/text.js";
import { parsePositiveInt, parsePositiveIntArray } from "../utils/http.js";

export function createSymptomsRouter({
  suggestProcedures = suggestProceduresForSymptom,
} = {}) {
  const router = Router();

  router.get("/", (_request, response) => {
    try {
      const vehicleId = getVehicleId();
      const symptoms = listSymptoms(vehicleId);

      response.json({
        symptoms,
        total: symptoms.length,
      });
    } catch (error) {
      response.status(500).json({
        error: error.message || "Could not load symptoms.",
      });
    }
  });

  router.get("/:id", (request, response) => {
    const symptomId = parsePositiveInt(request.params.id);

    if (symptomId === null) {
      response.status(400).json({
        error: "Symptom ID must be a positive number.",
      });
      return;
    }

    try {
      const vehicleId = getVehicleId();
      const symptom = getSymptom(vehicleId, symptomId);

      if (!symptom) {
        response.status(404).json({
          error: "Symptom not found.",
        });
        return;
      }

      response.json({ symptom });
    } catch (error) {
      response.status(500).json({
        error: error.message || "Could not load symptom.",
      });
    }
  });

  router.post("/", (request, response) => {
    const title = normalizeText(request.body.title);
    const description = normalizeText(request.body.description);
    const system = normalizeText(request.body.system);
    const suspectedCauses = normalizeText(request.body.suspectedCauses);
    const notes = normalizeText(request.body.notes);
    const linkedDocumentIds = parsePositiveIntArray(request.body.linkedDocumentIds);

    if (!title) {
      response.status(400).json({
        error: "Title is required.",
      });
      return;
    }

    let confidence;
    let status;

    try {
      confidence = normalizeConfidence(request.body.confidence);
      status = normalizeStatus(request.body.status);
    } catch (error) {
      response.status(400).json({
        error: error.message || "Invalid symptom values.",
      });
      return;
    }

    try {
      const vehicleId = getVehicleId();
      const createdSymptom = createSymptom(vehicleId, {
        title,
        description,
        system,
        suspectedCauses,
        confidence,
        status,
        notes,
        linkedDocumentIds,
      });

      response.status(201).json({
        message: "Symptom created.",
        symptom: createdSymptom,
      });
    } catch (error) {
      response.status(500).json({
        error: error.message || "Could not create symptom.",
      });
    }
  });

  router.put("/:id", (request, response) => {
    const symptomId = parsePositiveInt(request.params.id);

    if (symptomId === null) {
      response.status(400).json({
        error: "Symptom ID must be a positive number.",
      });
      return;
    }

    try {
      const vehicleId = getVehicleId();
      const existingSymptom = getSymptomRecord(vehicleId, symptomId);

      if (!existingSymptom) {
        response.status(404).json({
          error: "Symptom not found.",
        });
        return;
      }

      const title = hasOwnField(request.body, "title")
        ? normalizeText(request.body.title)
        : existingSymptom.title;
      const description = hasOwnField(request.body, "description")
        ? normalizeText(request.body.description)
        : existingSymptom.description || "";
      const system = hasOwnField(request.body, "system")
        ? normalizeText(request.body.system)
        : existingSymptom.system || "";
      const suspectedCauses = hasOwnField(request.body, "suspectedCauses")
        ? normalizeText(request.body.suspectedCauses)
        : existingSymptom.suspected_causes || "";
      const notes = hasOwnField(request.body, "notes")
        ? normalizeText(request.body.notes)
        : existingSymptom.notes || "";

      if (!title) {
        response.status(400).json({
          error: "Title is required.",
        });
        return;
      }

      let confidence = existingSymptom.confidence || "medium";
      let status = existingSymptom.status || "open";

      try {
        confidence = hasOwnField(request.body, "confidence")
          ? normalizeConfidence(request.body.confidence)
          : normalizeConfidence(existingSymptom.confidence);

        status = hasOwnField(request.body, "status")
          ? normalizeStatus(request.body.status)
          : normalizeStatus(existingSymptom.status);
      } catch (error) {
        response.status(400).json({
          error: error.message || "Invalid symptom values.",
        });
        return;
      }

      updateSymptomFields(vehicleId, symptomId, {
        title,
        description,
        system,
        suspectedCauses,
        confidence,
        status,
        notes,
      });

      if (hasOwnField(request.body, "linkedDocumentIds")) {
        const linkedDocumentIds = parsePositiveIntArray(request.body.linkedDocumentIds);
        replaceSymptomDocumentLinks(symptomId, vehicleId, linkedDocumentIds);
      }

      const updatedSymptom = getSymptom(vehicleId, symptomId);

      response.json({
        message: "Symptom updated.",
        symptom: updatedSymptom,
      });
    } catch (error) {
      response.status(500).json({
        error: error.message || "Could not update symptom.",
      });
    }
  });

  // Replace the set of procedures linked to one symptom (manual linking).
  router.put("/:id/procedures", (request, response) => {
    const symptomId = parsePositiveInt(request.params.id);

    if (symptomId === null) {
      response.status(400).json({
        error: "Symptom ID must be a positive number.",
      });
      return;
    }

    try {
      const vehicleId = getVehicleId();
      const existingSymptom = getSymptomRecord(vehicleId, symptomId);

      if (!existingSymptom) {
        response.status(404).json({
          error: "Symptom not found.",
        });
        return;
      }

      const procedureIds = parsePositiveIntArray(request.body.procedureIds);
      setSymptomProcedures(symptomId, procedureIds);

      const updatedSymptom = getSymptom(vehicleId, symptomId);

      response.json({
        message: "Linked procedures updated.",
        symptom: updatedSymptom,
      });
    } catch (error) {
      response.status(500).json({
        error: error.message || "Could not update linked procedures.",
      });
    }
  });

  // Suggest existing procedures for one symptom (AI-assisted, with a
  // deterministic fallback that needs no API key).
  router.get("/:id/suggested-procedures", async (request, response) => {
    const symptomId = parsePositiveInt(request.params.id);

    if (symptomId === null) {
      response.status(400).json({
        error: "Symptom ID must be a positive number.",
      });
      return;
    }

    try {
      const vehicleId = getVehicleId();
      const symptom = getSymptom(vehicleId, symptomId);

      if (!symptom) {
        response.status(404).json({
          error: "Symptom not found.",
        });
        return;
      }

      const candidates = listCandidateProcedures(vehicleId).filter(
        (procedure) => !symptom.linkedProcedureIds.includes(procedure.id)
      );

      const result = await suggestProcedures(symptom, candidates);

      response.json({
        symptomId,
        status: result.status,
        mode: result.mode,
        aiConfigured: result.aiConfigured,
        query: result.query,
        suggestions: result.suggestions,
        citations: result.citations,
      });
    } catch (error) {
      response.status(500).json({
        error: error.message || "Could not suggest procedures.",
      });
    }
  });

  router.delete("/:id", async (request, response) => {
    const symptomId = parsePositiveInt(request.params.id);

    if (symptomId === null) {
      response.status(400).json({
        error: "Symptom ID must be a positive number.",
      });
      return;
    }

    try {
      const vehicleId = getVehicleId();

      // Remove attachments before the entity row. If this cleanup throws, the
      // symptom is still present, so the (entity_type, entity_id) rows and their
      // image files are never stranded after the owner is gone (which would
      // otherwise persist in every backup).
      await deleteAttachmentsForEntity("symptom", symptomId);

      const removed = deleteSymptom(vehicleId, symptomId);

      if (removed === 0) {
        response.status(404).json({
          error: "Symptom not found.",
        });
        return;
      }

      response.json({
        message: "Symptom deleted.",
      });
    } catch (error) {
      response.status(500).json({
        error: error.message || "Could not delete symptom.",
      });
    }
  });

  return router;
}

export const symptomsRouter = createSymptomsRouter();
