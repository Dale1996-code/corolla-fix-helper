import fs from "node:fs/promises";
import path from "node:path";
import multer from "multer";
import { Router } from "express";
import { config } from "../config.js";
import { db } from "../database.js";
import { listDocuments } from "../services/documentService.js";
import { extractPdfData } from "../services/pdfService.js";
import {
  createStoredFilename,
  deriveTitleFromFilename,
} from "../utils/sanitizeFilename.js";

export const documentsRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: config.maxUploadSizeMb * 1024 * 1024,
  },
  fileFilter: (_request, file, callback) => {
    const isPdf =
      file.mimetype === "application/pdf" ||
      path.extname(file.originalname || "").toLowerCase() === ".pdf";

    if (!isPdf) {
      callback(new Error("Only PDF files are allowed right now."));
      return;
    }

    callback(null, true);
  },
});

function runUploadMiddleware(request, response) {
  return new Promise((resolve, reject) => {
    upload.single("pdfFile")(request, response, (error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
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

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function hasOwnField(object, fieldName) {
  return Object.prototype.hasOwnProperty.call(object, fieldName);
}

documentsRouter.get("/", (_request, response) => {
  const documents = listDocuments();

  response.json({
    documents,
    total: documents.length,
  });
});

documentsRouter.get("/:id/file", async (request, response) => {
  const documentId = Number(request.params.id);

  if (!Number.isInteger(documentId) || documentId <= 0) {
    response.status(400).json({
      error: "Document ID must be a positive number.",
    });
    return;
  }

  const document = db
    .prepare(`
      SELECT
        id,
        original_filename,
        stored_filename,
        file_path,
        file_type
      FROM documents
      WHERE id = ?
    `)
    .get(documentId);

  if (!document) {
    response.status(404).json({
      error: "Document not found.",
    });
    return;
  }

  const fileName =
    document.stored_filename ||
    path.basename(document.file_path || "");

  if (!fileName) {
    response.status(404).json({
      error: "Uploaded file reference is missing for this document.",
    });
    return;
  }

  const safeFileName = path.basename(fileName);
  const absoluteFilePath = path.join(config.uploadsDir, safeFileName);

  try {
    await fs.access(absoluteFilePath);
  } catch {
    response.status(404).json({
      error: "Uploaded file was not found on disk.",
    });
    return;
  }

  const originalFileName = document.original_filename || safeFileName;
  const encodedOriginalName = encodeURIComponent(originalFileName);

  response.setHeader("Content-Type", document.file_type || "application/pdf");
  response.setHeader(
    "Content-Disposition",
    `inline; filename="${safeFileName}"; filename*=UTF-8''${encodedOriginalName}`
  );

  response.sendFile(absoluteFilePath);
});

documentsRouter.post("/upload", async (request, response) => {
  const rows = db
    .prepare("SELECT COUNT(*) AS total FROM documents")
    .get();

  try {
    await runUploadMiddleware(request, response);
  } catch (error) {
    if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
      response.status(400).json({
        error: `PDF is too large. The limit is ${config.maxUploadSizeMb} MB.`,
      });
      return;
    }

    response.status(400).json({
      error: error.message || "Could not upload the PDF.",
    });
    return;
  }

  if (!request.file) {
    response.status(400).json({
      error: "Please choose a PDF file to upload.",
    });
    return;
  }

  const system = normalizeText(request.body.system);
  const documentType = normalizeText(request.body.documentType);

  if (!system || !documentType) {
    response.status(400).json({
      error: "System and document type are required.",
    });
    return;
  }

  const originalFilename = request.file.originalname;
  const storedFilename = createStoredFilename(originalFilename);
  const absoluteFilePath = path.join(config.uploadsDir, storedFilename);
  const relativeFilePath = `server/uploads/${storedFilename}`.replace(/\\/g, "/");
  const fileType =
    path.extname(originalFilename).toLowerCase() === ".pdf"
      ? "application/pdf"
      : request.file.mimetype || "application/octet-stream";

  const titleInput = normalizeText(request.body.title);
  const title = titleInput || deriveTitleFromFilename(originalFilename);
  const subsystem = normalizeText(request.body.subsystem);
  const source = normalizeText(request.body.source);
  const notes = normalizeText(request.body.notes);

  try {
    await fs.writeFile(absoluteFilePath, request.file.buffer);

    const extractionResult = await extractPdfData(request.file.buffer);
    const vehicleId = getVehicleId();

    const result = db
      .prepare(`
        INSERT INTO documents (
          vehicle_id,
          title,
          original_filename,
          stored_filename,
          file_path,
          file_type,
          system,
          subsystem,
          document_type,
          source,
          extracted_text,
          extraction_status,
          page_count,
          notes,
          is_favorite
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        vehicleId,
        title,
        originalFilename,
        storedFilename,
        relativeFilePath,
        fileType,
        system,
        subsystem,
        documentType,
        source,
        extractionResult.extractedText,
        extractionResult.extractionStatus,
        extractionResult.pageCount,
        notes,
        0
      );

    const documents = listDocuments();
    const newDocument = documents.find(
      (document) => document.id === Number(result.lastInsertRowid)
    );

    response.status(201).json({
      message: `Uploaded ${originalFilename} successfully.`,
      document: newDocument,
      totalDocuments: rows.total + 1,
    });
  } catch (error) {
    await fs.rm(absoluteFilePath, { force: true });

    response.status(500).json({
      error: error.message || "Could not save the uploaded document.",
    });
  }
});

documentsRouter.post("/:id/extract", async (request, response) => {
  const documentId = Number(request.params.id);

  if (!Number.isInteger(documentId) || documentId <= 0) {
    response.status(400).json({
      error: "Document ID must be a positive number.",
    });
    return;
  }

  const existingDocument = db
    .prepare(`
      SELECT id, stored_filename, file_path
      FROM documents
      WHERE id = ?
    `)
    .get(documentId);

  if (!existingDocument) {
    response.status(404).json({
      error: "Document not found.",
    });
    return;
  }

  const fileName =
    existingDocument.stored_filename ||
    path.basename(existingDocument.file_path || "");

  if (!fileName) {
    response.status(404).json({
      error: "Uploaded file reference is missing for this document.",
    });
    return;
  }

  const safeFileName = path.basename(fileName);
  const absoluteFilePath = path.join(config.uploadsDir, safeFileName);

  let fileBuffer;

  try {
    fileBuffer = await fs.readFile(absoluteFilePath);
  } catch {
    response.status(404).json({
      error: "Uploaded file was not found on disk.",
    });
    return;
  }

  const extractionResult = await extractPdfData(fileBuffer);

  db.prepare(`
    UPDATE documents
    SET
      extracted_text = ?,
      extraction_status = ?,
      page_count = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    extractionResult.extractedText,
    extractionResult.extractionStatus,
    extractionResult.pageCount,
    documentId
  );

  const documents = listDocuments();
  const updatedDocument = documents.find((entry) => entry.id === documentId);

  response.json({
    message: "Extraction re-run complete.",
    document: updatedDocument,
  });
});

documentsRouter.delete("/:id", async (request, response) => {
  const documentId = Number(request.params.id);

  if (!Number.isInteger(documentId) || documentId <= 0) {
    response.status(400).json({
      error: "Document ID must be a positive number.",
    });
    return;
  }

  const existingDocument = db
    .prepare(`
      SELECT id, stored_filename, file_path
      FROM documents
      WHERE id = ?
    `)
    .get(documentId);

  if (!existingDocument) {
    response.status(404).json({
      error: "Document not found.",
    });
    return;
  }

  const linkedCounts = db
    .prepare(`
      SELECT
        (SELECT COUNT(*) FROM symptom_documents WHERE document_id = ?) AS symptom_count,
        (SELECT COUNT(*) FROM procedure_documents WHERE document_id = ?) AS procedure_count,
        (SELECT COUNT(*) FROM notes WHERE related_entity_type = 'document' AND related_entity_id = ?) AS note_count
    `)
    .get(documentId, documentId, documentId);

  const storedFileName = existingDocument.stored_filename || path.basename(existingDocument.file_path || "");
  const safeStoredFileName = storedFileName ? path.basename(storedFileName) : "";
  const absoluteFilePath = safeStoredFileName
    ? path.join(config.uploadsDir, safeStoredFileName)
    : null;

  try {
    db.prepare(`
      UPDATE notes
      SET related_entity_type = 'none',
          related_entity_id = NULL,
          document_id = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE related_entity_type = 'document' AND related_entity_id = ?
    `).run(documentId);

    db.prepare("DELETE FROM documents WHERE id = ?").run(documentId);

    if (absoluteFilePath) {
      await fs.rm(absoluteFilePath, { force: true });
    }

    response.json({
      message: "Document deleted.",
      cleanup: {
        symptomLinksRemoved: linkedCounts.symptom_count,
        procedureLinksRemoved: linkedCounts.procedure_count,
        noteLinksCleared: linkedCounts.note_count,
        fileRemoved: Boolean(absoluteFilePath),
      },
    });
  } catch (error) {
    response.status(500).json({
      error: error.message || "Could not delete document.",
    });
  }
});

documentsRouter.put("/:id", (request, response) => {
  const documentId = Number(request.params.id);

  if (!Number.isInteger(documentId) || documentId <= 0) {
    response.status(400).json({
      error: "Document ID must be a positive number.",
    });
    return;
  }

  const existingDocument = db
    .prepare(`
      SELECT
        id,
        title,
        system,
        subsystem,
        document_type,
        source,
        notes,
        is_favorite
      FROM documents
      WHERE id = ?
    `)
    .get(documentId);

  if (!existingDocument) {
    response.status(404).json({
      error: "Document not found.",
    });
    return;
  }

  const title = hasOwnField(request.body, "title")
    ? normalizeText(request.body.title)
    : existingDocument.title;
  const system = hasOwnField(request.body, "system")
    ? normalizeText(request.body.system)
    : existingDocument.system;
  const subsystem = hasOwnField(request.body, "subsystem")
    ? normalizeText(request.body.subsystem)
    : existingDocument.subsystem || "";
  const documentType = hasOwnField(request.body, "documentType")
    ? normalizeText(request.body.documentType)
    : existingDocument.document_type;
  const source = hasOwnField(request.body, "source")
    ? normalizeText(request.body.source)
    : existingDocument.source || "";
  const notes = hasOwnField(request.body, "notes")
    ? normalizeText(request.body.notes)
    : existingDocument.notes || "";
  const isFavorite =
    typeof request.body.isFavorite === "boolean"
      ? request.body.isFavorite
      : Boolean(existingDocument.is_favorite);

  if (!title || !system || !documentType) {
    response.status(400).json({
      error: "Title, system, and document type are required.",
    });
    return;
  }

  db.prepare(`
    UPDATE documents
    SET
      title = ?,
      system = ?,
      subsystem = ?,
      document_type = ?,
      source = ?,
      notes = ?,
      is_favorite = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    title,
    system,
    subsystem,
    documentType,
    source,
    notes,
    isFavorite ? 1 : 0,
    documentId
  );

  const documents = listDocuments();
  const updatedDocument = documents.find((document) => document.id === documentId);

  response.json({
    message: "Document metadata updated.",
    document: updatedDocument,
  });
});
