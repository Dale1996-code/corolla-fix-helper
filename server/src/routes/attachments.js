import fs from "node:fs/promises";
import path from "node:path";
import multer from "multer";
import { Router } from "express";
import { config } from "../config.js";
import {
  createAttachment,
  deleteAttachment,
  getAttachmentById,
  getAttachmentsImageDir,
  isAllowedEntityType,
  isAllowedImageMimeType,
  listAllAttachments,
  listAttachments,
} from "../services/attachmentService.js";
import { normalizeText } from "../utils/text.js";
import { parsePositiveInt } from "../utils/http.js";

export const attachmentsRouter = Router();

const ALLOWED_IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: config.maxUploadSizeMb * 1024 * 1024,
  },
  fileFilter: (_request, file, callback) => {
    const extension = path.extname(file.originalname || "").toLowerCase();
    const isImage =
      isAllowedImageMimeType(file.mimetype) ||
      ALLOWED_IMAGE_EXTENSIONS.has(extension);

    if (!isImage) {
      callback(new Error("Only JPEG, PNG, or WebP image files are allowed."));
      return;
    }

    callback(null, true);
  },
});

function runUploadMiddleware(request, response) {
  return new Promise((resolve, reject) => {
    upload.single("image")(request, response, (error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

attachmentsRouter.get("/", (request, response) => {
  const entityType = normalizeText(request.query.entityType);
  const entityId = parsePositiveInt(request.query.entityId);

  if (!isAllowedEntityType(entityType)) {
    response.status(400).json({
      error: "Attachment entity type must be symptom, procedure, or note.",
    });
    return;
  }

  if (entityId === null) {
    response.status(400).json({
      error: "Attachment entity ID must be a positive number.",
    });
    return;
  }

  const attachments = listAttachments(entityType, entityId);

  response.json({
    attachments,
    total: attachments.length,
  });
});

// List every saved image across all entities. Added for Vision Ask, whose
// picker has no owning symptom/procedure/note, so the entity-scoped `GET /`
// cannot serve it. A distinct path keeps the existing entity-scoped contract
// unchanged. Registered before `/:id/file` so the static segment wins.
attachmentsRouter.get("/all", (_request, response) => {
  const attachments = listAllAttachments();

  response.json({
    attachments,
    total: attachments.length,
  });
});

attachmentsRouter.get("/:id/file", async (request, response) => {
  const attachmentId = parsePositiveInt(request.params.id);

  if (attachmentId === null) {
    response.status(400).json({
      error: "Attachment ID must be a positive number.",
    });
    return;
  }

  const attachment = getAttachmentById(attachmentId);

  if (!attachment) {
    response.status(404).json({
      error: "Attachment not found.",
    });
    return;
  }

  const safeFileName = path.basename(attachment.storedFilename || "");

  if (!safeFileName) {
    response.status(404).json({
      error: "Stored image reference is missing for this attachment.",
    });
    return;
  }

  const absoluteFilePath = path.join(getAttachmentsImageDir(), safeFileName);

  try {
    await fs.access(absoluteFilePath);
  } catch {
    response.status(404).json({
      error: "Attachment image was not found on disk.",
    });
    return;
  }

  const originalFileName = attachment.originalFilename || safeFileName;
  const encodedOriginalName = encodeURIComponent(originalFileName);

  response.setHeader("Content-Type", attachment.mimeType || "image/jpeg");
  response.setHeader(
    "Content-Disposition",
    `inline; filename="${safeFileName}"; filename*=UTF-8''${encodedOriginalName}`
  );

  response.sendFile(absoluteFilePath);
});

attachmentsRouter.post("/", async (request, response) => {
  try {
    await runUploadMiddleware(request, response);
  } catch (error) {
    if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
      response.status(400).json({
        error: `Image is too large. The limit is ${config.maxUploadSizeMb} MB.`,
      });
      return;
    }

    response.status(400).json({
      error: error.message || "Could not upload the image.",
    });
    return;
  }

  if (!request.file) {
    response.status(400).json({
      error: "Please choose an image file to upload.",
    });
    return;
  }

  const entityType = normalizeText(request.body.entityType);
  const entityId = parsePositiveInt(request.body.entityId);
  const caption = normalizeText(request.body.caption);

  if (!isAllowedEntityType(entityType)) {
    response.status(400).json({
      error: "Attachment entity type must be symptom, procedure, or note.",
    });
    return;
  }

  if (entityId === null) {
    response.status(400).json({
      error: "Attachment entity ID must be a positive number.",
    });
    return;
  }

  try {
    const attachment = await createAttachment({
      entityType,
      entityId,
      originalFilename: request.file.originalname,
      mimeType: request.file.mimetype,
      buffer: request.file.buffer,
      caption,
    });

    response.status(201).json({
      message: "Attachment saved.",
      attachment,
    });
  } catch (error) {
    response.status(400).json({
      error: error.message || "Could not save the attachment.",
    });
  }
});

attachmentsRouter.delete("/:id", async (request, response) => {
  const attachmentId = parsePositiveInt(request.params.id);

  if (attachmentId === null) {
    response.status(400).json({
      error: "Attachment ID must be a positive number.",
    });
    return;
  }

  try {
    const removed = await deleteAttachment(attachmentId);

    if (!removed) {
      response.status(404).json({
        error: "Attachment not found.",
      });
      return;
    }

    response.json({
      message: "Attachment deleted.",
    });
  } catch (error) {
    response.status(500).json({
      error: error.message || "Could not delete attachment.",
    });
  }
});
