// Shared date helpers used across the page components. These were previously
// copy-pasted (byte-identical) into every page; keeping one copy avoids drift.

// Bare "YYYY-MM-DD HH:MM:SS" with no timezone — the shape SQLite CURRENT_TIMESTAMP
// stores (always UTC).
const BARE_SQLITE_TIMESTAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

/**
 * Mark a bare SQLite UTC timestamp as explicit UTC.
 *
 * SQLite's CURRENT_TIMESTAMP is UTC but has no zone suffix, and JavaScript parses
 * that space-separated form as LOCAL time — so a stored time renders shifted by
 * the viewer's offset. Converting it to `...THH:MM:SSZ` makes `new Date` treat it
 * as UTC (then Intl still displays it in the viewer's local zone, correctly).
 * Values that already carry a zone, or aren't timestamps, pass through unchanged.
 */
export function normalizeSqliteTimestamp(value) {
  if (typeof value === "string" && BARE_SQLITE_TIMESTAMP.test(value.trim())) {
    return `${value.trim().replace(" ", "T")}Z`;
  }

  return value;
}

/**
 * Format a timestamp for display, e.g. "Jun 15, 2026, 5:22 AM".
 * Returns "Not available" for empty or unparseable values.
 */
export function formatDate(value) {
  if (!value) {
    return "Not available";
  }

  const date = new Date(normalizeSqliteTimestamp(value));

  if (Number.isNaN(date.getTime())) {
    return "Not available";
  }

  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

/**
 * Numeric sort key (epoch ms) for an entity, preferring `updatedAt` and
 * falling back to `createdAt`. Returns 0 when neither is a valid date so
 * entities without timestamps sort last under descending order.
 */
export function getSortTimestamp(entity) {
  const dateValue = entity.updatedAt || entity.createdAt;
  const time = new Date(normalizeSqliteTimestamp(dateValue || "")).getTime();
  return Number.isNaN(time) ? 0 : time;
}
