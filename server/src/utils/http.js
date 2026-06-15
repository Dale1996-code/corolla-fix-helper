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
