// The Procedures page asks the server for one page at a time (N7). This is the
// one place that turns the page's view state (the URL's keyword, filters, sort,
// and page) into that request, so the query string is also the sole dependency
// of the fetch: one view change is one request, and the same view is always the
// same string.

// The same page size as the Documents and Symptoms pages, so the lists read alike.
export const PROCEDURES_PER_PAGE = 25;

/**
 * @param {object} view
 * @param {string} view.q the committed keyword (not the box's draft)
 * @param {string} view.system `all` or a system name
 * @param {string} view.difficulty `all`, `beginner`, `intermediate`, or `advanced`
 * @param {string} view.confidence `all`, `high`, `medium`, or `low`
 * @param {string} view.sort `newest`, `oldest`, or `title`
 * @param {number} view.page 1-based page number
 * @returns {string} a query string without the leading `?`
 */
export function buildProceduresListQuery({ q, system, difficulty, confidence, sort, page }) {
  const params = new URLSearchParams();
  const safePage = Number.isSafeInteger(page) && page > 1 ? page : 1;
  const keyword = typeof q === "string" ? q.trim() : "";

  params.set("limit", String(PROCEDURES_PER_PAGE));
  params.set("offset", String((safePage - 1) * PROCEDURES_PER_PAGE));
  params.set("sort", sort);

  if (keyword) {
    params.set("q", keyword);
  }

  if (system !== "all") {
    params.set("system", system);
  }

  if (difficulty !== "all") {
    params.set("difficulty", difficulty);
  }

  if (confidence !== "all") {
    params.set("confidence", confidence);
  }

  return params.toString();
}

/**
 * How many pages `matched` procedures make. Never below 1, so an empty result
 * still reads "Page 1 of 1" rather than "Page 1 of 0".
 *
 * @param {number} matched
 * @returns {number}
 */
export function countProcedurePages(matched) {
  return Math.max(1, Math.ceil((Number.isFinite(matched) ? matched : 0) / PROCEDURES_PER_PAGE));
}
