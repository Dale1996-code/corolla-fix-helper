import { Router } from "express";
import { db } from "../database.js";
import { deleteAttachmentsForEntity } from "../services/attachmentService.js";
import {
  buildSymptomProcedureLinksMap,
  setSymptomProcedures,
} from "../services/symptomProcedureService.js";
import { suggestProceduresForSymptom } from "../services/procedureSuggestionService.js";
import { getVehicleId } from "../services/vehicleService.js";
import { hasOwnField, normalizeText } from "../utils/text.js";
import { parsePositiveInt } from "../utils/http.js";

const allowedConfidenceValues = new Set(["low", "medium", "high"]);
const allowedStatusValues = new Set(["open", "monitoring", "resolved"]);

function normalizeConfidence(value) {
  const normalized = normalizeText(value).toLowerCase();

  if (!normalized) {
    return "medium";
  }

  if (!allowedConfidenceValues.has(normalized)) {
    throw new Error("Confidence must be low, medium, or high.");
  }

  return normalized;
}

function normalizeStatus(value) {
  const normalized = normalizeText(value).toLowerCase();

  if (!normalized) {
    return "open";
  }

  if (!allowedStatusValues.has(normalized)) {
    throw new Error("Status must be open, monitoring, or resolved.");
  }

  return normalized;
}

function parseLinkedDocumentIds(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  const uniqueIds = new Set();

  for (const item of value) {
    const id = Number(item);

    if (Number.isInteger(id) && id > 0) {
      uniqueIds.add(id);
    }
  }

  return Array.from(uniqueIds);
}

// Procedure-link bodies use the same "array of positive integer ids" shape as
// the document-link bodies above.
function parseLinkedProcedureIds(value) {
  return parseLinkedDocumentIds(value);
}

function mapSymptomRow(row, documentLinksMap, procedureLinksMap) {
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

function listSymptomsForVehicle(vehicleId) {
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

// Stored procedures for one vehicle, shaped for the suggestion service's keyword
// overlap and for the suggestion response.
function listCandidateProceduresForVehicle(vehicleId) {
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

export function createSymptomsRouter({
  suggestProcedures = suggestProceduresForSymptom,
} = {}) {
  const router = Router();

  router.get("/", (_request, response) => {
    try {
      const vehicleId = getVehicleId();
      const symptoms = listSymptomsForVehicle(vehicleId);

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
      const symptom = listSymptomsForVehicle(vehicleId).find(
        (candidate) => candidate.id === symptomId
      );

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
    const linkedDocumentIds = parseLinkedDocumentIds(request.body.linkedDocumentIds);

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
          title,
          description,
          system,
          suspectedCauses,
          confidence,
          status,
          notes
        );

      const symptomId = Number(insertResult.lastInsertRowid);
      replaceSymptomDocumentLinks(symptomId, vehicleId, linkedDocumentIds);

      const symptoms = listSymptomsForVehicle(vehicleId);
      const createdSymptom = symptoms.find((symptom) => symptom.id === symptomId);

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
      const existingSymptom = db
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
        title,
        description,
        system,
        suspectedCauses,
        confidence,
        status,
        notes,
        symptomId,
        vehicleId
      );

      if (hasOwnField(request.body, "linkedDocumentIds")) {
        const linkedDocumentIds = parseLinkedDocumentIds(request.body.linkedDocumentIds);
        replaceSymptomDocumentLinks(symptomId, vehicleId, linkedDocumentIds);
      }

      const symptoms = listSymptomsForVehicle(vehicleId);
      const updatedSymptom = symptoms.find((symptom) => symptom.id === symptomId);

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
      const existingSymptom = db
        .prepare("SELECT id FROM symptoms WHERE id = ? AND vehicle_id = ?")
        .get(symptomId, vehicleId);

      if (!existingSymptom) {
        response.status(404).json({
          error: "Symptom not found.",
        });
        return;
      }

      const procedureIds = parseLinkedProcedureIds(request.body.procedureIds);
      setSymptomProcedures(symptomId, procedureIds);

      const symptoms = listSymptomsForVehicle(vehicleId);
      const updatedSymptom = symptoms.find((symptom) => symptom.id === symptomId);

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
      const symptom = listSymptomsForVehicle(vehicleId).find(
        (candidate) => candidate.id === symptomId
      );

      if (!symptom) {
        response.status(404).json({
          error: "Symptom not found.",
        });
        return;
      }

      const candidates = listCandidateProceduresForVehicle(vehicleId).filter(
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
      const deleteResult = db
        .prepare(`
          DELETE FROM symptoms
          WHERE id = ?
          AND vehicle_id = ?
        `)
        .run(symptomId, vehicleId);

      if (deleteResult.changes === 0) {
        response.status(404).json({
          error: "Symptom not found.",
        });
        return;
      }

      await deleteAttachmentsForEntity("symptom", symptomId);

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
