import { ASK_REJECTION_CHANNELS, ASK_REJECTION_REASONS } from "./askEvidenceContract.js";

// The machine-readable contract for a SUCCESSFUL /api/ask response.
//
// Before this module there were two partial contracts and no shared one:
// EVIDENCE_RESPONSE_SCHEMA describes what the MODEL returns, and SearchPage.jsx
// independently maintained its own status set and normalization rules. Nothing
// described the payload the route actually sends, so the route, the client, and
// eval:answers each encoded their own idea of it.
//
// Scope, deliberately: this validates SHAPE and ENUM MEMBERSHIP. It is not the
// evidence-integrity check. The client still binds each claim to a citation by
// evidenceId and exact quote (normalizeAskEvidence in SearchPage.jsx), which is
// a strictly stronger guarantee than any shape schema can make, and it stays
// where it is. Passing validation here does NOT mean an answer is grounded.
//
// Error reporting is log-safe by construction: every entry is a field path plus
// a reason code. No field VALUE is ever copied into an error, because the
// payload being validated contains document text and citation snippets.

/** Statuses a successful Ask response may carry. */
export const ASK_RESPONSE_STATUSES = Object.freeze([
  "answered",
  "partial",
  "unverified",
  "not_found",
  "ai_not_configured",
]);

export { ASK_REJECTION_REASONS };

/** Server-assigned evidence identifier; the model cannot choose it. */
const EVIDENCE_ID_PATTERN = /^ask_ev_v1_[a-f0-9]{24}$/;

/** Prompt-local source label (S1..Sn). Model-supplied, so shape-checked. */
const SOURCE_LABEL_PATTERN = /^S\d{1,4}$/;

/**
 * Declarative description of the response, kept beside the validator so the two
 * cannot drift. This is documentation that a machine can read (docs/api.md
 * renders the same contract for humans); the validator below is the enforcement.
 */
export const ASK_RESPONSE_SCHEMA = Object.freeze({
  name: "ask_response",
  type: "object",
  additionalProperties: false,
  required: ["question", "standaloneQuestion", "status", "answer", "citations"],
  properties: {
    question: { type: "string", minLength: 1 },
    standaloneQuestion: { type: "string", minLength: 1 },
    status: { type: "string", enum: [...ASK_RESPONSE_STATUSES] },
    answer: { type: "string" },
    citations: { type: "array", items: { $ref: "#/definitions/source" } },
    retrievedContext: { type: "array", items: { $ref: "#/definitions/source" } },
    evidence: {
      type: "object",
      additionalProperties: false,
      required: ["documentSupported", "generalGuidance", "gaps"],
      properties: {
        documentSupported: { type: "array", items: { $ref: "#/definitions/evidenceSource" } },
        generalGuidance: { type: "array", items: { type: "string" } },
        gaps: { type: "array", items: { type: "string" } },
      },
    },
    // Development-only (ASK_DEBUG_METRICS). Open-ended on purpose: buildAskMetrics
    // adds measurement fields over time and a strict list here would reject a
    // new timing the moment it is introduced. `rejected` IS pinned, because it
    // is the one metrics field carrying per-item detail about model output.
    metrics: {
      type: "object",
      properties: {
        rejectedCount: { type: "integer", minimum: 0 },
        rejected: { type: "array", items: { $ref: "#/definitions/rejection" } },
      },
    },
  },
  definitions: {
    source: {
      type: "object",
      required: [
        "documentId",
        "pageNumber",
        "chunkIndex",
        "snippet",
        "documentAvailable",
      ],
      properties: {
        documentId: { type: "integer", minimum: 1 },
        documentTitle: { type: "string" },
        originalFilename: { type: "string" },
        pageNumber: { type: "integer", minimum: 1 },
        chunkIndex: { type: "integer", minimum: 0 },
        snippet: { type: "string", minLength: 1 },
        documentAvailable: { type: "boolean" },
        evidenceQuote: { type: "string" },
        evidenceId: { type: "string", pattern: EVIDENCE_ID_PATTERN.source },
      },
    },
    evidenceSource: {
      type: "object",
      required: ["claim", "evidenceQuote", "documentId", "pageNumber", "chunkIndex"],
      properties: {
        claim: { type: "string", minLength: 1 },
        evidenceQuote: { type: "string", minLength: 1 },
        evidenceId: { type: "string", pattern: EVIDENCE_ID_PATTERN.source },
        documentId: { type: "integer", minimum: 1 },
        documentTitle: { type: "string" },
        originalFilename: { type: "string" },
        pageNumber: { type: "integer", minimum: 1 },
        chunkIndex: { type: "integer", minimum: 0 },
      },
    },
    // The sanitized rejection record. Exactly these five fields: the verifier's
    // internal `claim`, `unsupported`, and `subject` carry document text and the
    // unverified specification values themselves, and must never appear here.
    rejection: {
      type: "object",
      additionalProperties: false,
      required: ["channel", "itemIndex", "reason", "sourceId", "unsupportedSpecCount"],
      properties: {
        channel: { type: "string", enum: [...ASK_REJECTION_CHANNELS] },
        itemIndex: { type: "integer", minimum: 0 },
        reason: { type: "string", enum: [...ASK_REJECTION_REASONS] },
        sourceId: { type: ["string", "null"], pattern: SOURCE_LABEL_PATTERN.source },
        unsupportedSpecCount: { type: "integer", minimum: 0 },
      },
    },
  },
});

const RESPONSE_FIELDS = new Set(Object.keys(ASK_RESPONSE_SCHEMA.properties));
const STATUSES = new Set(ASK_RESPONSE_STATUSES);
const REJECTION_CHANNELS = new Set(ASK_REJECTION_CHANNELS);
const REJECTION_REASONS = new Set(ASK_REJECTION_REASONS);
const REJECTION_FIELDS = new Set(Object.keys(ASK_RESPONSE_SCHEMA.definitions.rejection.properties));

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function checkSource(source, path, errors) {
  if (!isPlainObject(source)) {
    errors.push(`${path}: not_an_object`);
    return;
  }

  if (!isPositiveInteger(source.documentId)) {
    errors.push(`${path}.documentId: not_a_positive_integer`);
  }

  if (!isPositiveInteger(source.pageNumber)) {
    errors.push(`${path}.pageNumber: not_a_positive_integer`);
  }

  if (!Number.isInteger(source.chunkIndex) || source.chunkIndex < 0) {
    errors.push(`${path}.chunkIndex: not_a_non_negative_integer`);
  }

  // A passage with no name cannot be attributed, and one with no text cannot be
  // checked by the owner — both are what makes a citation a citation.
  if (!isNonEmptyString(source.documentTitle) && !isNonEmptyString(source.originalFilename)) {
    errors.push(`${path}: missing_document_name`);
  }

  if (!isNonEmptyString(source.snippet)) {
    errors.push(`${path}.snippet: empty`);
  }

  if (typeof source.documentAvailable !== "boolean") {
    errors.push(`${path}.documentAvailable: not_a_boolean`);
  }

  if (source.evidenceId !== undefined && !EVIDENCE_ID_PATTERN.test(String(source.evidenceId))) {
    errors.push(`${path}.evidenceId: malformed`);
  }
}

function checkSourceArray(value, path, errors) {
  if (!Array.isArray(value)) {
    errors.push(`${path}: not_an_array`);
    return;
  }

  value.forEach((source, index) => checkSource(source, `${path}[${index}]`, errors));
}

function checkEvidence(evidence, errors) {
  if (!isPlainObject(evidence)) {
    errors.push("evidence: not_an_object");
    return;
  }

  for (const field of ["documentSupported", "generalGuidance", "gaps"]) {
    if (!Array.isArray(evidence[field])) {
      errors.push(`evidence.${field}: not_an_array`);
    }
  }

  if (Array.isArray(evidence.documentSupported)) {
    evidence.documentSupported.forEach((item, index) => {
      const path = `evidence.documentSupported[${index}]`;

      if (!isPlainObject(item)) {
        errors.push(`${path}: not_an_object`);
        return;
      }

      if (!isNonEmptyString(item.claim)) {
        errors.push(`${path}.claim: empty`);
      }

      if (!isNonEmptyString(item.evidenceQuote)) {
        errors.push(`${path}.evidenceQuote: empty`);
      }

      if (!isPositiveInteger(item.documentId)) {
        errors.push(`${path}.documentId: not_a_positive_integer`);
      }

      if (!isPositiveInteger(item.pageNumber)) {
        errors.push(`${path}.pageNumber: not_a_positive_integer`);
      }

      if (!Number.isInteger(item.chunkIndex) || item.chunkIndex < 0) {
        errors.push(`${path}.chunkIndex: not_a_non_negative_integer`);
      }

      if (item.evidenceId !== undefined && !EVIDENCE_ID_PATTERN.test(String(item.evidenceId))) {
        errors.push(`${path}.evidenceId: malformed`);
      }
    });
  }

  for (const field of ["generalGuidance", "gaps"]) {
    if (Array.isArray(evidence[field]) && evidence[field].some((item) => typeof item !== "string")) {
      errors.push(`evidence.${field}: item_not_a_string`);
    }
  }
}

function checkRejections(rejected, errors) {
  if (!Array.isArray(rejected)) {
    errors.push("metrics.rejected: not_an_array");
    return;
  }

  rejected.forEach((entry, index) => {
    const path = `metrics.rejected[${index}]`;

    if (!isPlainObject(entry)) {
      errors.push(`${path}: not_an_object`);
      return;
    }

    // Unknown fields are an error, not a warning: this array exists precisely
    // to carry a bounded, reviewed set of fields off the server, so anything
    // extra is by definition unreviewed. The field NAME is reported; its value
    // never is.
    for (const field of Object.keys(entry)) {
      if (!REJECTION_FIELDS.has(field)) {
        errors.push(`${path}.${field}: unexpected_field`);
      }
    }

    if (!REJECTION_CHANNELS.has(entry.channel)) {
      errors.push(`${path}.channel: unknown_channel`);
    }

    if (!REJECTION_REASONS.has(entry.reason)) {
      errors.push(`${path}.reason: unknown_reason`);
    }

    if (!Number.isInteger(entry.itemIndex) || entry.itemIndex < 0) {
      errors.push(`${path}.itemIndex: not_a_non_negative_integer`);
    }

    if (entry.sourceId !== null && !SOURCE_LABEL_PATTERN.test(String(entry.sourceId))) {
      errors.push(`${path}.sourceId: malformed`);
    }

    if (!Number.isInteger(entry.unsupportedSpecCount) || entry.unsupportedSpecCount < 0) {
      errors.push(`${path}.unsupportedSpecCount: not_a_non_negative_integer`);
    }
  });
}

/**
 * Validate a successful /api/ask response payload.
 *
 * @param {any} payload
 * @returns {{ ok: boolean, errors: string[] }} errors are `path: reason_code`
 *   strings containing no field values, so a caller may log them directly.
 */
export function validateAskResponse(payload) {
  const errors = [];

  if (!isPlainObject(payload)) {
    return { ok: false, errors: ["response: not_an_object"] };
  }

  for (const field of Object.keys(payload)) {
    if (!RESPONSE_FIELDS.has(field)) {
      errors.push(`${field}: unexpected_field`);
    }
  }

  if (!isNonEmptyString(payload.question)) {
    errors.push("question: empty");
  }

  if (!isNonEmptyString(payload.standaloneQuestion)) {
    errors.push("standaloneQuestion: empty");
  }

  if (!STATUSES.has(payload.status)) {
    errors.push("status: unknown_status");
  }

  // An empty answer string is allowed only in principle; every current path
  // renders either text or the not-found message. A non-string is not.
  if (typeof payload.answer !== "string") {
    errors.push("answer: not_a_string");
  }

  checkSourceArray(payload.citations, "citations", errors);

  if (payload.retrievedContext !== undefined) {
    checkSourceArray(payload.retrievedContext, "retrievedContext", errors);
  }

  if (payload.evidence !== undefined) {
    checkEvidence(payload.evidence, errors);
  }

  if (payload.metrics !== undefined) {
    if (!isPlainObject(payload.metrics)) {
      errors.push("metrics: not_an_object");
    } else if (payload.metrics.rejected !== undefined) {
      checkRejections(payload.metrics.rejected, errors);
    }
  }

  return { ok: errors.length === 0, errors };
}
