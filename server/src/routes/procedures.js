import { Router } from "express";
import { db } from "../database.js";

export const proceduresRouter = Router();

const allowedConfidenceValues = new Set(["low", "medium", "high"]);
const allowedDifficultyValues = new Set(["beginner", "intermediate", "advanced"]);

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

function normalizeDifficulty(value) {
  const normalized = normalizeText(value).toLowerCase();

  if (!normalized) {
    return "intermediate";
  }

  if (!allowedDifficultyValues.has(normalized)) {
    throw new Error("Difficulty must be beginner, intermediate, or advanced.");
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

function mapProcedureRow(row, linksMap) {
  const linkedDocuments = linksMap.get(row.id) || [];

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

function listProceduresForVehicle(vehicleId) {
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

  const linksMap = new Map();

  for (const linkRow of linkRows) {
    if (!linksMap.has(linkRow.procedure_id)) {
      linksMap.set(linkRow.procedure_id, []);
    }

    linksMap.get(linkRow.procedure_id).push({
      id: linkRow.document_id,
      title: linkRow.document_title,
      system: linkRow.document_system || "",
      documentType: linkRow.document_type || "",
    });
  }

  return procedureRows.map((row) => mapProcedureRow(row, linksMap));
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

function replaceProcedureDocumentLinks(procedureId, vehicleId, requestedDocumentIds) {
  db.prepare("DELETE FROM procedure_documents WHERE procedure_id = ?").run(procedureId);

  const validDocumentIds = getExistingDocumentIds(vehicleId, requestedDocumentIds);

  if (!validDocumentIds.length) {
    return;
  }

  const insertLink = db.prepare(`
    INSERT INTO procedure_documents (procedure_id, document_id)
    VALUES (?, ?)
  `);

  for (const documentId of validDocumentIds) {
    insertLink.run(procedureId, documentId);
  }
}

proceduresRouter.get("/", (_request, response) => {
  try {
    const vehicleId = getVehicleId();
    const procedures = listProceduresForVehicle(vehicleId);

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

proceduresRouter.post("/", (request, response) => {
  const title = normalizeText(request.body.title);
  const system = normalizeText(request.body.system);
  const toolsNeeded = normalizeText(request.body.toolsNeeded);
  const partsNeeded = normalizeText(request.body.partsNeeded);
  const safetyNotes = normalizeText(request.body.safetyNotes);
  const steps = normalizeText(request.body.steps);
  const notes = normalizeText(request.body.notes);
  const linkedDocumentIds = parseLinkedDocumentIds(request.body.linkedDocumentIds);

  if (!title) {
    response.status(400).json({
      error: "Title is required.",
    });
    return;
  }

  let difficulty = "intermediate";
  let confidence = "medium";

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
        title,
        system,
        difficulty,
        toolsNeeded,
        partsNeeded,
        safetyNotes,
        steps,
        notes,
        confidence
      );

    const procedureId = Number(insertResult.lastInsertRowid);
    replaceProcedureDocumentLinks(procedureId, vehicleId, linkedDocumentIds);

    const procedures = listProceduresForVehicle(vehicleId);
    const createdProcedure = procedures.find((procedure) => procedure.id === procedureId);

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
  const procedureId = Number(request.params.id);

  if (!Number.isInteger(procedureId) || procedureId <= 0) {
    response.status(400).json({
      error: "Procedure ID must be a positive number.",
    });
    return;
  }

  try {
    const vehicleId = getVehicleId();
    const existingProcedure = db
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
      title,
      system,
      difficulty,
      toolsNeeded,
      partsNeeded,
      safetyNotes,
      steps,
      notes,
      confidence,
      procedureId,
      vehicleId
    );

    if (hasOwnField(request.body, "linkedDocumentIds")) {
      const linkedDocumentIds = parseLinkedDocumentIds(request.body.linkedDocumentIds);
      replaceProcedureDocumentLinks(procedureId, vehicleId, linkedDocumentIds);
    }

    const procedures = listProceduresForVehicle(vehicleId);
    const updatedProcedure = procedures.find((procedure) => procedure.id === procedureId);

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

proceduresRouter.delete("/:id", (request, response) => {
  const procedureId = Number(request.params.id);

  if (!Number.isInteger(procedureId) || procedureId <= 0) {
    response.status(400).json({
      error: "Procedure ID must be a positive number.",
    });
    return;
  }

  try {
    const vehicleId = getVehicleId();
    const deleteResult = db
      .prepare(`
        DELETE FROM procedures
        WHERE id = ?
        AND vehicle_id = ?
      `)
      .run(procedureId, vehicleId);

    if (deleteResult.changes === 0) {
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
