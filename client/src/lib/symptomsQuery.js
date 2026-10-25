// The Symptoms page asks the server for one page at a time. This is the one
// place that turns the page's view state (the URL's keyword, filters, sort, and
// page) into that request, so the query string is also the sole dependency of
// the fetch: one view change is one request, and the same view is always the
// same string.

// The same page size as the Documents page, so the two lists read alike.
export const SYMPTOMS_PER_PAGE = 25;

/**
 * @param {object} view
 * @param {string} view.q the committed keyword (not the box's draft)
 * @param {string} view.status `all`, `active`, `open`, `monitoring`, or `resolved`
 * @param {string} view.system `all` or a system name
 * @param {string} view.confidence `all`, `high`, `medium`, or `low`
 * @param {string} view.sort `newest`, `oldest`, or `title`
 * @param {number} view.page 1-based page number
 * @returns {string} a query string without the leading `?`
 */
export function buildSymptomsListQuery({ q, status, system, confidence, sort, page }) {
  const params = new URLSearchParams();
  const safePage = Number.isSafeInteger(page) && page > 1 ? page : 1;
  const keyword = typeof q === "string" ? q.trim() : "";

  params.set("limit", String(SYMPTOMS_PER_PAGE));
  params.set("offset", String((safePage - 1) * SYMPTOMS_PER_PAGE));
  params.set("sort", sort);

  if (keyword) {
    params.set("q", keyword);
  }

  if (status !== "all") {
    params.set("status", status);
  }

  if (system !== "all") {
    params.set("system", system);
  }

  if (confidence !== "all") {
    params.set("confidence", confidence);
  }

  return params.toString();
}

/**
 * How many pages `matched` symptoms make. Never below 1, so an empty result
 * still reads "Page 1 of 1" rather than "Page 1 of 0".
 *
 * @param {number} matched
 * @returns {number}
 */
export function countSymptomPages(matched) {
  return Math.max(1, Math.ceil((Number.isFinite(matched) ? matched : 0) / SYMPTOMS_PER_PAGE));
}
