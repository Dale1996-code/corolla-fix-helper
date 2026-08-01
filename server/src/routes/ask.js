import fs from "node:fs/promises";
import path from "node:path";
import { Router } from "express";
import { config } from "../config.js";
import { askQuestionUsingDocuments } from "../services/aiAnswerService.js";
import {
  getAttachmentById,
  getAttachmentsImageDir,
  isAllowedImageMimeType,
} from "../services/attachmentService.js";
import { parsePositiveInt } from "../utils/http.js";

// Cap the question length so a giant payload cannot be forwarded to OpenAI.
export const MAX_QUESTION_LENGTH = 2000;

function attachmentError(status, message) {
  const error = new Error(message);
  /** @type {any} */ (error).status = status;
  return error;
}

/**
 * Resolve a saved Phase 1 attachment into a base64 data URI for Vision Ask.
 *
 * Ask references an already-saved image by id only; this loads that record and
 * its stored file from attachment storage. `getAttachment`/`readImageFile` are
 * injectable so tests can exercise every branch without touching the database
 * or disk. Errors carry an HTTP `status` so the route can answer 400/404/415
 * without calling OpenAI.
 *
 * @param {number|string} attachmentId
 * @param {{ getAttachment?: Function, readImageFile?: Function }} [deps]
 * @returns {Promise<string>} a `data:<mime>;base64,...` URI
 */
export async function loadAttachmentImageFromStorage(
  attachmentId,
  { getAttachment = getAttachmentById, readImageFile = fs.readFile } = {}
) {
  const numericId = parsePositiveInt(attachmentId);

  if (numericId === null) {
    throw attachmentError(400, "Attachment ID must be a positive number.");
  }

  const attachment = getAttachment(numericId);

  if (!attachment) {
    throw attachmentError(404, "Attachment not found.");
  }

  if (!isAllowedImageMimeType(attachment.mimeType)) {
    throw attachmentError(
      415,
      "Attachment must be a JPEG, PNG, or WebP image."
    );
  }

  // path.basename guards against directory traversal from the stored value, the
  // same way attachmentService resolves its files.
  const safeFileName = path.basename(attachment.storedFilename || "");

  if (!safeFileName) {
    throw attachmentError(404, "Attachment image was not found on disk.");
  }

  const absoluteFilePath = path.join(getAttachmentsImageDir(), safeFileName);

  let buffer;
  try {
    buffer = await readImageFile(absoluteFilePath);
  } catch {
    throw attachmentError(404, "Attachment image was not found on disk.");
  }

  return `data:${attachment.mimeType};base64,${buffer.toString("base64")}`;
}

export function createAskRouter({
  askQuestion = askQuestionUsingDocuments,
  loadAttachmentImage = loadAttachmentImageFromStorage,
  includeMetrics = config.askDebugMetrics,
} = {}) {
  const router = Router();

  router.post("/", async (request, response) => {
    const question = typeof request.body?.question === "string" ? request.body.question.trim() : "";
    const history = Array.isArray(request.body?.history) ? request.body.history : [];
    const rawAttachmentId = request.body?.attachmentId;
    const hasAttachmentId = rawAttachmentId !== undefined && rawAttachmentId !== null;

    if (!question) {
      response.status(400).json({
        error: "Question is required.",
      });
      return;
    }

    if (question.length > MAX_QUESTION_LENGTH) {
      response.status(400).json({
        error: `Question is too long. Keep it under ${MAX_QUESTION_LENGTH} characters.`,
      });
      return;
    }

    let image = null;

    if (hasAttachmentId) {
      try {
        image = await loadAttachmentImage(rawAttachmentId);
      } catch (error) {
        // A bad attachment never reaches the model: fail before calling OpenAI.
        response.status(error.status || 400).json({
          error: error.message || "Could not load the attachment image.",
        });
        return;
      }
    }

    try {
      const result = await askQuestion(question, { history, image, includeMetrics });

      const payload = {
        question,
        standaloneQuestion: result.standaloneQuestion || question,
        status: result.status,
        answer: result.answer,
        citations: result.citations,
      };

      // Additive: on a not-found reply the service recovers the passages
      // retrieval actually found, which `citations: []` would otherwise discard.
      // Kept behind an explicit allowlist check (not a spread of `result`) so
      // the response shape stays deliberate, and attached only when there is
      // something to show. Answered replies already cite their sources and are
      // left byte-identical.
      if (
        result.status === "not_found" &&
        Array.isArray(result.retrievedContext) &&
        result.retrievedContext.length > 0
      ) {
        payload.retrievedContext = result.retrievedContext;
      }

      // Evidence contract (ASK_EVIDENCE_CONTRACT). Additive and allowlisted like
      // retrievedContext: absent entirely with the flag off, so the default
      // response shape is unchanged.
      if (result.evidence && typeof result.evidence === "object") {
        payload.evidence = {
          documentSupported: result.evidence.documentSupported || [],
          generalGuidance: result.evidence.generalGuidance || [],
          gaps: result.evidence.gaps || [],
        };
      }

      // Dev-only: surface the log-safe timing/size metrics over HTTP when the
      // flag is on. Off by default, so the response shape is unchanged.
      if (includeMetrics && result.metrics) {
        payload.metrics = result.metrics;
      }

      response.json(payload);
    } catch (error) {
      // Honor an error-carried status (e.g. the daily-budget cap sets 429) so the
      // spend backstop reads as "too many requests", not a generic server error.
      response.status(error.status || 500).json({
        error: error.message || "Could not answer this question.",
      });
    }
  });

  return router;
}

export const askRouter = createAskRouter();
