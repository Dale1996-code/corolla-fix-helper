// The Notes page asks the server for one page at a time (N7). This is the one
// place that turns the page's view state (the URL's filters, sort, and page)
// into that request, so the query string is also the sole dependency of the
// fetch: one view change is one request, and the same view is always the same
// string.

// The same page size as the other paged lists, so they read alike.
export const NOTES_PER_PAGE = 25;

/**
 * @param {object} view
 * @param {string} view.noteType `all` or a note type
 * @param {string} view.relatedEntityType `all`, `none`, `document`, `symptom`, or `procedure`
 * @param {string} view.sort `newest` or `oldest`
 * @param {number} view.page 1-based page number
 * @returns {string} a query string without the leading `?`
 */
export function buildNotesListQuery({ noteType, relatedEntityType, sort, page }) {
  const params = new URLSearchParams();
  const safePage = Number.isSafeInteger(page) && page > 1 ? page : 1;

  params.set("limit", String(NOTES_PER_PAGE));
  params.set("offset", String((safePage - 1) * NOTES_PER_PAGE));
  params.set("sort", sort);

  if (noteType !== "all") {
    params.set("noteType", noteType);
  }

  if (relatedEntityType !== "all") {
    params.set("relatedEntityType", relatedEntityType);
  }

  return params.toString();
}

/**
 * How many pages `matched` notes make. Never below 1.
 *
 * @param {number} matched
 * @returns {number}
 */
export function countNotePages(matched) {
  return Math.max(1, Math.ceil((Number.isFinite(matched) ? matched : 0) / NOTES_PER_PAGE));
}
