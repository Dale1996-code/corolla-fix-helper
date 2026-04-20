import { Router } from "express";
import { db } from "../database.js";

export const symptomsRouter = Router();

const allowedConfidenceValues = new Set(["low", "medium", "high"]);
const allowedStatusValues = new Set(["open", "monitoring", "resolved"]);

function hasOwnField(object, fieldName) {
  return Object.prototype.hasOwnProperty.call(object, fieldName);
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

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

function getVehicleId() {
  const vehicle = db
    .prepare("SELECT id FROM vehicles ORDER BY id ASC LIMIT 1")
    .get();

  if (!vehicle) {
    throw new Error("No vehicle record exists yet.");
  }

  return vehicle.id;
}

function mapSymptomRow(row, linksMap) {
  const linkedDocuments = linksMap.get(row.id) || [];

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

  const linksMap = new Map();

  for (const linkRow of linkRows) {
    if (!linksMap.has(linkRow.symptom_id)) {
      linksMap.set(linkRow.symptom_id, []);
    }

    linksMap.get(linkRow.symptom_id).push({
      id: linkRow.document_id,
      title: linkRow.document_title,
      system: linkRow.document_system || "",
      documentType: linkRow.document_type || "",
    });
  }

  return symptomRows.map((row) => mapSymptomRow(row, linksMap));
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

function replaceSymptomDocumentLinks(symptomId, vehicleId, requestedDocumentIds) {
  db.prepare("DELETE FROM symptom_documents WHERE symptom_id = ?").run(symptomId);

  const validDocumentIds = getExistingDocumentIds(vehicleId, requestedDocumentIds);

  if (!validDocumentIds.length) {
    return;
  }

  const insertLink = db.prepare(`
    INSERT INTO symptom_documents (symptom_id, document_id)
    VALUES (?, ?)
  `);

  for (const documentId of validDocumentIds) {
    insertLink.run(symptomId, documentId);
  }
}

symptomsRouter.get("/", (_request, response) => {
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

symptomsRouter.post("/", (request, response) => {
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

  let confidence = "medium";
  let status = "open";

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

symptomsRouter.put("/:id", (request, response) => {
  const symptomId = Number(request.params.id);

  if (!Number.isInteger(symptomId) || symptomId <= 0) {
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

symptomsRouter.delete("/:id", (request, response) => {
  const symptomId = Number(request.params.id);

  if (!Number.isInteger(symptomId) || symptomId <= 0) {
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

    response.json({
      message: "Symptom deleted.",
    });
  } catch (error) {
    response.status(500).json({
      error: error.message || "Could not delete symptom.",
    });
  }
});
