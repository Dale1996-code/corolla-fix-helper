import fs from "node:fs/promises";
import path from "node:path";
import multer from "multer";
import { Router } from "express";
import { config } from "../config.js";
import {
  countDocuments,
  createDocument,
  deleteDocument,
  getDocument,
  getDocumentFileLocation,
  getDocumentFileRecord,
  getDocumentMetadataRecord,
  listDocuments,
  reextractDocument,
  resolveStoredFilePath,
  updateDocumentMetadata,
} from "../services/documentService.js";
import { setDocumentTags } from "../services/documentTagService.js";
import { hasOwnField, normalizeText } from "../utils/text.js";
import { parsePositiveInt } from "../utils/http.js";

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

documentsRouter.get("/", (request, response) => {
  const total = countDocuments();

  // Backward compatible: with no `limit` query, return every document (the
  // current Documents page relies on this). When `limit` is supplied, page
  // through with a sane cap so a huge library cannot be pulled at once.
  if (request.query.limit === undefined) {
    const documents = listDocuments();
    response.json({ documents, total });
    return;
  }

  const limit = Math.min(200, parsePositiveInt(request.query.limit) || 50);
  const offset = parsePositiveInt(request.query.offset) || 0;
  const documents = listDocuments({ limit, offset });

  response.json({ documents, total, limit, offset });
});

documentsRouter.get("/:id/file", async (request, response) => {
  const documentId = parsePositiveInt(request.params.id);

  if (documentId === null) {
    response.status(400).json({
      error: "Document ID must be a positive number.",
    });
    return;
  }

  const document = getDocumentFileRecord(documentId);

  if (!document) {
    response.status(404).json({
      error: "Document not found.",
    });
    return;
  }

  const resolvedFile = resolveStoredFilePath(document);

  if (!resolvedFile) {
    response.status(404).json({
      error: "Uploaded file reference is missing for this document.",
    });
    return;
  }

  const { safeFileName, absoluteFilePath } = resolvedFile;

  try {
    await fs.access(absoluteFilePath);
  } catch {
    response.status(404).json({
      error: "Uploaded file was not found on disk.",
    });
    return;
  }

  const originalFileName = document.original_filename || safeFileName;
  const encodedOriginalName = encodeURIComponent(String(originalFileName));

  response.setHeader("Content-Type", document.file_type || "application/pdf");
  response.setHeader(
    "Content-Disposition",
    `inline; filename="${safeFileName}"; filename*=UTF-8''${encodedOriginalName}`
  );

  response.sendFile(absoluteFilePath);
});

documentsRouter.post("/upload", async (request, response) => {
  const totalBeforeUpload = countDocuments();

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
  const titleInput = normalizeText(request.body.title);
  const subsystem = normalizeText(request.body.subsystem);
  const source = normalizeText(request.body.source);
  const notes = normalizeText(request.body.notes);
  // Multipart form fields arrive as strings, so accept "true" (or a real boolean).
  const isBookmarked =
    request.body.isBookmarked === "true" || request.body.isBookmarked === true;

  try {
    const newDocument = await createDocument({
      fileBuffer: request.file.buffer,
      originalFilename,
      mimetype: request.file.mimetype,
      titleInput,
      system,
      subsystem,
      documentType,
      source,
      notes,
      isBookmarked,
      tags: request.body.tags,
      hasTags: hasOwnField(request.body, "tags"),
    });

    response.status(201).json({
      message: `Uploaded ${originalFilename} successfully.`,
      document: newDocument,
      totalDocuments: totalBeforeUpload + 1,
    });
  } catch (error) {
    response.status(500).json({
      error: error.message || "Could not save the uploaded document.",
    });
  }
});

documentsRouter.post("/:id/extract", async (request, response) => {
  const documentId = parsePositiveInt(request.params.id);

  if (documentId === null) {
    response.status(400).json({
      error: "Document ID must be a positive number.",
    });
    return;
  }

  const existingDocument = getDocumentFileLocation(documentId);

  if (!existingDocument) {
    response.status(404).json({
      error: "Document not found.",
    });
    return;
  }

  const resolvedFile = resolveStoredFilePath(existingDocument);

  if (!resolvedFile) {
    response.status(404).json({
      error: "Uploaded file reference is missing for this document.",
    });
    return;
  }

  const { absoluteFilePath } = resolvedFile;

  let fileBuffer;

  try {
    fileBuffer = await fs.readFile(absoluteFilePath);
  } catch {
    response.status(404).json({
      error: "Uploaded file was not found on disk.",
    });
    return;
  }

  const updatedDocument = await reextractDocument(documentId, fileBuffer);

  response.json({
    message: "Extraction re-run complete.",
    document: updatedDocument,
  });
});

documentsRouter.delete("/:id", async (request, response) => {
  const documentId = parsePositiveInt(request.params.id);

  if (documentId === null) {
    response.status(400).json({
      error: "Document ID must be a positive number.",
    });
    return;
  }

  const existingDocument = getDocumentFileLocation(documentId);

  if (!existingDocument) {
    response.status(404).json({
      error: "Document not found.",
    });
    return;
  }

  try {
    const cleanup = await deleteDocument(existingDocument);

    response.json({
      message: "Document deleted.",
      cleanup,
    });
  } catch (error) {
    response.status(500).json({
      error: error.message || "Could not delete document.",
    });
  }
});

documentsRouter.put("/:id", (request, response) => {
  const documentId = parsePositiveInt(request.params.id);

  if (documentId === null) {
    response.status(400).json({
      error: "Document ID must be a positive number.",
    });
    return;
  }

  const existingDocument = getDocumentMetadataRecord(documentId);

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
  const isBookmarked =
    typeof request.body.isBookmarked === "boolean"
      ? request.body.isBookmarked
      : Boolean(existingDocument.is_bookmarked);

  if (!title || !system || !documentType) {
    response.status(400).json({
      error: "Title, system, and document type are required.",
    });
    return;
  }

  updateDocumentMetadata(documentId, {
    title,
    system,
    subsystem,
    documentType,
    source,
    notes,
    isFavorite,
    isBookmarked,
  });

  if (hasOwnField(request.body, "tags")) {
    setDocumentTags(documentId, request.body.tags);
  }

  const updatedDocument = getDocument(documentId);

  response.json({
    message: "Document metadata updated.",
    document: updatedDocument,
  });
});
