// Shared date helpers used across the page components. These were previously
// copy-pasted (byte-identical) into every page; keeping one copy avoids drift.

/**
 * Format a timestamp for display, e.g. "Jun 15, 2026, 5:22 AM".
 * Returns "Not available" for empty or unparseable values.
 */
export function formatDate(value) {
  if (!value) {
    return "Not available";
  }

  const date = new Date(value);

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
  const time = new Date(dateValue || "").getTime();
  return Number.isNaN(time) ? 0 : time;
}
