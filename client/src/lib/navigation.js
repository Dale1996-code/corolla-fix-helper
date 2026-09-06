// Desktop sidebar and mobile header both render this one list, so the two can
// never label the same destination differently.
//
// Each label must match the `<h1>` of the page it routes to -- PageHeader also
// builds the browser tab title from that heading, so a label that drifts from
// its page shows up three times over (nav item, heading, tab). "Checklists"
// pointing at a page headed "Repair Checklists" was exactly that bug.
export const navigationItems = [
  { label: "Dashboard", to: "/dashboard" },
  { label: "Documents", to: "/documents" },
  { label: "Ask AI", to: "/search" },
  { label: "Repair Planner", to: "/repair-planner" },
  { label: "Symptoms", to: "/symptoms" },
  { label: "Procedures", to: "/procedures" },
  { label: "Notes", to: "/notes" },
  { label: "Repair Checklists", to: "/repair-checklists" },
  { label: "Repair History", to: "/repair-history" },
  { label: "Settings", to: "/settings" },
];

export function buildEntityLink(entityType, entityId) {
  if (!entityId) {
    return "/dashboard";
  }

  if (entityType === "document") {
    return `/documents?documentId=${entityId}#document-library`;
  }

  if (entityType === "symptom") {
    return `/symptoms?symptomId=${entityId}#symptom-library`;
  }

  if (entityType === "procedure") {
    return `/procedures?procedureId=${entityId}#procedure-library`;
  }

  if (entityType === "note") {
    return `/notes?noteId=${entityId}#note-library`;
  }

  if (entityType === "checklist") {
    return `/repair-checklists?checklistId=${entityId}#checklist-library`;
  }

  if (entityType === "repairHistory") {
    return `/repair-history?repairHistoryId=${entityId}#repair-history-library`;
  }

  return "/dashboard";
}

/**
 * Direct link to a document's stored PDF, optionally at a cited page.
 *
 * Built from the SERVER-VALIDATED numeric document id only. Nothing the model
 * produced — a title, a filename, a source label, a URL — ever reaches this
 * string, so a source action cannot be pointed anywhere the server did not
 * already authorize, and a title full of quotes, slashes, or `#` cannot corrupt
 * the href.
 *
 * `/api/documents/:id/file` is served with `Content-Disposition: inline`, so
 * browsers hand it to their built-in PDF viewer and the `#page=` fragment jumps
 * to the cited page. A viewer that ignores the fragment still opens the correct
 * document — which is why the page number stays visible on the card.
 *
 * @param {unknown} documentId
 * @param {unknown} [pageNumber]
 * @returns {string|null} null when there is no usable document identity
 */
export function buildDocumentFileLink(documentId, pageNumber = null) {
  if (!Number.isInteger(documentId) || documentId <= 0) {
    return null;
  }

  const fileUrl = `/api/documents/${documentId}/file`;

  return Number.isInteger(pageNumber) && pageNumber > 0
    ? `${fileUrl}#page=${pageNumber}`
    : fileUrl;
}

/**
 * The name to show for a source document.
 *
 * Trusted server fields only, in descending order of how much they mean to the
 * owner: the document's own title, then the filename they uploaded it under,
 * then a neutral label. A chunk id or other retrieval-internal identifier is
 * never a candidate — it names a slice of extracted text, not a document.
 *
 * @param {{ documentTitle?: unknown, originalFilename?: unknown }} [source]
 * @returns {string}
 */
export function documentSourceName(source) {
  const title = typeof source?.documentTitle === "string" ? source.documentTitle.trim() : "";
  const filename =
    typeof source?.originalFilename === "string" ? source.originalFilename.trim() : "";

  return title || filename || "Source document";
}
