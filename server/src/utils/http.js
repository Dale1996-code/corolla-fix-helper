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
 * Parse a `limit` query value into a bounded page size.
 *
 * Missing, non-numeric, fractional, zero, negative, and unsafely large values
 * all fall back to `defaultLimit`; anything larger than `maxLimit` is clamped
 * down to it. Callers therefore always receive a page size they can hand
 * straight to a parameterized `LIMIT ?`.
 */
export function parsePageLimit(value, { defaultLimit, maxLimit }) {
  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return defaultLimit;
  }

  return Math.min(parsed, maxLimit);
}

/**
 * Parse an `offset` query value into a non-negative row offset.
 *
 * Missing, non-numeric, fractional, negative, and unsafely large values all
 * become 0 (the first page). A large-but-safe offset is kept as-is so paging
 * past the end returns an empty page rather than silently restarting at page 1.
 */
export function parsePageOffset(value) {
  const parsed = Number(value);

  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
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

const EXACT_LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * True when `address` is an IPv4/IPv6 loopback address.
 *
 * Covers the whole 127.0.0.0/8 range and its IPv4-mapped IPv6 form, plus `::1`.
 * Used to keep host-only routes (backup export) reachable from the machine
 * itself but not from other devices when the app is run in network mode.
 */
export function isLoopbackAddress(address) {
  if (typeof address !== "string" || !address) {
    return false;
  }

  if (EXACT_LOOPBACK_ADDRESSES.has(address)) {
    return true;
  }

  return /^127\.\d+\.\d+\.\d+$/.test(address) || /^::ffff:127\./.test(address);
}

/**
 * True when the request originates from the host machine itself. Reads the raw
 * socket peer address (not a client-supplied header) so it cannot be spoofed by
 * a proxy header — this app does not run behind a trusted proxy.
 */
export function isLoopbackRequest(request) {
  return isLoopbackAddress(
    request?.socket?.remoteAddress || request?.connection?.remoteAddress || ""
  );
}
