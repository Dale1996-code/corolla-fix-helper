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

const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Format a bare `YYYY-MM-DD` calendar date, e.g. "Aug 20, 2026".
 *
 * Deliberately NOT `formatDate`, and the difference is not cosmetic. A repair's
 * `performedOn` is a calendar fact the owner typed, not a moment in time: the
 * server stores it as bare `YYYY-MM-DD` with no clock and no zone. Passing it to
 * `new Date(...)` parses it as UTC midnight, which Intl then renders in the
 * viewer's local zone -- so west of Greenwich a repair recorded on the 20th
 * displays as the 19th. Reading the three fields and formatting in UTC keeps the
 * day the owner entered the day the owner sees, at every offset.
 *
 * Returns "Not available" for empty or unparseable values, matching `formatDate`.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function formatCalendarDate(value) {
  const text = typeof value === "string" ? value.trim() : "";
  const match = CALENDAR_DATE.exec(text);

  if (!match) {
    return "Not available";
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));

  // The same round trip the server validates with, so a shape-valid but
  // impossible date (2026-02-30, month 00) is refused here rather than shown
  // silently rolled forward to a day nobody recorded.
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return "Not available";
  }

  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
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
