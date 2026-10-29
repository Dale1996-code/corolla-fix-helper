// The ordering and slicing rules the Procedures and Notes pages used to apply in
// the browser, applied on the server so those pages can ask for one page at a
// time (N7). Kept identical to the client's `getSortTimestamp` and
// `localeCompare` sort, so moving the work to the server reorders nothing.

// Bare "YYYY-MM-DD HH:MM:SS": SQLite's CURRENT_TIMESTAMP, always UTC. The client
// reads it as UTC (`normalizeSqliteTimestamp`), so the server must too.
const BARE_SQLITE_TIMESTAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

/** A record's last-change time in ms: `updatedAt`, else `createdAt`, else 0. */
export function sortTimestamp(record) {
  const value = String(record?.updatedAt || record?.createdAt || "").trim();
  const time = new Date(BARE_SQLITE_TIMESTAMP.test(value) ? `${value.replace(" ", "T")}Z` : value).getTime();

  return Number.isNaN(time) ? 0 : time;
}

// Titles in a person's order. The locale is pinned so the order does not depend
// on the server's settings.
export const listTextCollator = new Intl.Collator("en-US");

export const LIST_COMPARATORS = {
  newest: (first, second) => sortTimestamp(second) - sortTimestamp(first),
  oldest: (first, second) => sortTimestamp(first) - sortTimestamp(second),
  title: (first, second) => listTextCollator.compare(first.title || "", second.title || ""),
};

/**
 * The records `keep` accepts, ordered by `compare`, and the slice
 * [offset, offset + limit). `records` arrive in the list's base order (latest
 * update, then highest id), and a tie keeps that order -- what the browser's
 * stable sort did -- so the order is total and a page boundary can never repeat
 * or skip a record.
 *
 * @template T
 * @param {T[]} records
 * @param {{ keep: (record: T) => boolean, compare: (a: T, b: T) => number, limit: number, offset: number }} options
 * @returns {{ page: T[], matched: number }}
 */
export function sliceInOrder(records, { keep, compare, limit, offset }) {
  const matching = records
    .map((record, index) => ({ record, index }))
    .filter(({ record }) => keep(record))
    .sort((first, second) => compare(first.record, second.record) || first.index - second.index)
    .map(({ record }) => record);

  return { page: matching.slice(offset, offset + limit), matched: matching.length };
}

/** Distinct non-empty values of one field, in a person's order. */
export function distinctSorted(records, field) {
  return Array.from(new Set(records.map((record) => record[field]).filter(Boolean))).sort(
    (first, second) => listTextCollator.compare(first, second)
  );
}
