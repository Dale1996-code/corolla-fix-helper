// The Documents page asks the server for one page at a time. This is the one
// place that turns the page's view state (the URL's filters, sort, and page)
// into that request, so the query string is also the sole dependency of the
// fetch: one view change is one request, and the same view is always the same
// string.

// Fixed-size pages keep a large library scannable and every response bounded.
export const DOCUMENTS_PER_PAGE = 25;

// The page's tri-state selects map onto the API's `true` / `false` flags; "all"
// sends nothing at all.
const FLAG_VALUES = {
  favorites_only: "true",
  not_favorites: "false",
  bookmarked_only: "true",
  not_bookmarked: "false",
};

/**
 * @param {object} view
 * @param {string} view.sort `newest`, `oldest`, or `title_asc`
 * @param {string} view.system `all` or a system name
 * @param {string} view.documentType `all` or a document type
 * @param {string} view.favorite `all`, `favorites_only`, or `not_favorites`
 * @param {string} view.bookmark `all`, `bookmarked_only`, or `not_bookmarked`
 * @param {string} view.tag `all` or a tag name
 * @param {number} view.page 1-based page number
 * @returns {string} a query string without the leading `?`
 */
export function buildDocumentsListQuery({
  sort,
  system,
  documentType,
  favorite,
  bookmark,
  tag,
  page,
}) {
  const params = new URLSearchParams();
  const safePage = Number.isSafeInteger(page) && page > 1 ? page : 1;

  params.set("limit", String(DOCUMENTS_PER_PAGE));
  params.set("offset", String((safePage - 1) * DOCUMENTS_PER_PAGE));
  // Always sent, even for the default: the page's "newest" orders by last
  // update, which is not the API's unsorted order.
  params.set("sort", sort);

  if (system !== "all") {
    params.set("system", system);
  }

  if (documentType !== "all") {
    params.set("documentType", documentType);
  }

  if (FLAG_VALUES[favorite]) {
    params.set("favorite", FLAG_VALUES[favorite]);
  }

  if (FLAG_VALUES[bookmark]) {
    params.set("bookmarked", FLAG_VALUES[bookmark]);
  }

  if (tag !== "all") {
    params.set("tag", tag);
  }

  return params.toString();
}

/**
 * How many pages `matched` documents make. Never below 1, so an empty result
 * still reads "Page 1 of 1" rather than "Page 1 of 0".
 *
 * @param {number} matched
 * @returns {number}
 */
export function countDocumentPages(matched) {
  return Math.max(1, Math.ceil((Number.isFinite(matched) ? matched : 0) / DOCUMENTS_PER_PAGE));
}
