// The one visible format for "how much of this list am I looking at".
//
// Six pages had each grown their own counter -- "Showing 25 of 143 matching
// (200 total)", "Found 40 document results.", "Showing all 3 symptoms",
// "5 checklists." -- so the same question was answered in a different shape on
// every screen. Everything visible goes through here instead.
//
// Two forms, and the difference is load-bearing:
//
//   formatResultRange  -- a SUBSET is on screen (a page of results, a filtered
//                         list). Always a range: "Showing 1-25 of 1,443 documents."
//   formatLibraryTotal -- the WHOLE list is on screen and there is nothing to
//                         range over: "5 checklists in your library."
//
// A page picks one. Showing both for the same list is how the old duplicate
// counters happened.

const NUMBER_LOCALE = "en-US";

// En dash, not a hyphen: this is a numeric range, and the hyphen form was one
// of the patterns the counters used to disagree about.
const RANGE_DASH = "–";

function toWholeCount(value) {
  const numericValue = Number(value);

  return Number.isFinite(numericValue) ? Math.max(0, Math.trunc(numericValue)) : 0;
}

/**
 * A count as the owner should read it: thousands separated, never raw.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function formatCount(value) {
  return toWholeCount(value).toLocaleString(NUMBER_LOCALE);
}

/**
 * "Showing 1-25 of 1,443 documents."
 *
 * The end index is clamped to the total and the start to the end, so a stale
 * page size or an over-long slice can never render an impossible range like
 * "Showing 26-50 of 33" or "Showing 1-0 of 0". An empty result set never gets a
 * range at all -- it gets `emptyText`, which is a sentence rather than a
 * degenerate range.
 *
 * @param {{
 *   from?: unknown,
 *   to?: unknown,
 *   total?: unknown,
 *   noun: string,
 *   nounPlural: string,
 *   suffix?: string,
 *   emptyText?: string,
 * }} options
 * @returns {string}
 */
export function formatResultRange({
  from,
  to,
  total,
  noun,
  nounPlural,
  suffix = "",
  emptyText = "",
}) {
  const totalCount = toWholeCount(total);

  if (totalCount === 0) {
    return emptyText || `No ${nounPlural}.`;
  }

  const lastItem = Math.min(Math.max(toWholeCount(to), 1), totalCount);
  const firstItem = Math.min(Math.max(toWholeCount(from), 1), lastItem);
  // The noun agrees with the total, so a single record reads
  // "Showing 1-1 of 1 document." rather than "1 documents".
  const nounText = totalCount === 1 ? noun : nounPlural;
  const suffixText = suffix ? ` ${suffix}` : "";

  return `Showing ${formatCount(firstItem)}${RANGE_DASH}${formatCount(lastItem)} of ${formatCount(
    totalCount
  )} ${nounText}${suffixText}.`;
}

/**
 * "5 checklists in your library."
 *
 * For a list that is always shown whole, where a range would only ever restate
 * its own total.
 *
 * @param {{ total?: unknown, noun: string, nounPlural: string, emptyText?: string }} options
 * @returns {string}
 */
export function formatLibraryTotal({ total, noun, nounPlural, emptyText = "" }) {
  const totalCount = toWholeCount(total);

  if (totalCount === 0) {
    return emptyText || `No ${nounPlural} yet.`;
  }

  return `${formatCount(totalCount)} ${
    totalCount === 1 ? noun : nounPlural
  } in your library.`;
}
