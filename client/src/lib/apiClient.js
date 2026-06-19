// Thin wrapper around fetch for JSON endpoints.
//
// Collapses the boilerplate that was repeated across pages:
//   const response = await fetch(url, options);
//   const payload = await response.json();
//   if (!response.ok) throw new Error(payload.error || "...");
//
// Use this only for endpoints that always return a JSON body (success and
// error alike). Endpoints that return a non-JSON success payload (e.g. file
// downloads) should keep calling fetch directly.

/**
 * Fetch a URL expecting a JSON response, returning the parsed body.
 *
 * Pass `errorMessage` for the fallback thrown when the response is not ok and
 * the server did not include an `error` field. Any other option is forwarded
 * to `fetch` unchanged (method, headers, body, ...).
 *
 * @param {string} url
 * @param {RequestInit & { errorMessage?: string }} [options]
 */
export async function requestJson(url, options = {}) {
  const { errorMessage = "Request failed.", ...fetchOptions } = options;

  const response = await fetch(url, fetchOptions);
  const payload = await response.json();

  if (!response.ok) {
    throw new Error((payload && payload.error) || errorMessage);
  }

  return payload;
}

// ---------------------------------------------------------------------------
// Attachment helpers
//
// Image attachments hang off a symptom, procedure, or note (the entity type +
// id). Uploads are multipart, so they go through requestJson with a FormData
// body (fetch sets the multipart boundary itself — do not set Content-Type).
// ---------------------------------------------------------------------------

/** Inline URL the browser uses to load a stored attachment image. */
export function attachmentFileUrl(attachmentId) {
  return `/api/attachments/${attachmentId}/file`;
}

/** List the attachments for one entity. Returns an array (possibly empty). */
export async function fetchAttachments(entityType, entityId) {
  const params = new URLSearchParams({
    entityType,
    entityId: String(entityId),
  });

  const payload = await requestJson(`/api/attachments?${params.toString()}`, {
    errorMessage: "Could not load attachments.",
  });

  return Array.isArray(payload.attachments) ? payload.attachments : [];
}

/**
 * List every saved image attachment, newest first. Returns an array (possibly
 * empty). Vision Ask uses this to let the user pick an already-saved image.
 */
export async function fetchAllImageAttachments() {
  const payload = await requestJson("/api/attachments/all", {
    errorMessage: "Could not load saved photos.",
  });

  return Array.isArray(payload.attachments) ? payload.attachments : [];
}

/** Upload one image for an entity and return the created attachment. */
export async function uploadAttachment({
  entityType,
  entityId,
  file,
  caption = "",
}) {
  const formData = new FormData();
  formData.append("entityType", entityType);
  formData.append("entityId", String(entityId));

  if (caption) {
    formData.append("caption", caption);
  }

  formData.append("image", file);

  const payload = await requestJson("/api/attachments", {
    method: "POST",
    body: formData,
    errorMessage: "Could not upload the image.",
  });

  return payload.attachment;
}

/** Delete one attachment by id. */
export async function deleteAttachment(attachmentId) {
  return requestJson(`/api/attachments/${attachmentId}`, {
    method: "DELETE",
    errorMessage: "Could not delete the attachment.",
  });
}
