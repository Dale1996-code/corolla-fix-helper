// Helpers for parsing/validating request values shared across routes.

/**
 * Parse a route/path value as a positive integer id.
 *
 * Returns the parsed integer, or `null` when the value is missing, non-numeric,
 * fractional, zero, or negative. Callers keep ownership of the error response so
 * each route can use its own entity-specific message.
 */
export function parsePositiveInt(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Parse a request body value as a deduplicated list of positive integer ids.
 *
 * Used by the "replace the whole set of linked ids" bodies (linked documents,
 * symptoms, procedures). A non-array value yields an empty list; within an
 * array, anything that is not a positive integer is dropped, and duplicates are
 * collapsed while preserving first-seen order.
 */
export function parsePositiveIntArray(value) {
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
