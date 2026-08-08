import { formatDate } from "../../lib/formatDate";
import { getDocumentTags, normalizeExtractionStatus } from "./documentDisplay";
import { TagChips } from "./TagChips";

// Column minimums are what actually set this table's width -- the wrapper's
// minWidthClass only has to match them so row backgrounds and borders paint
// across the full scroll width. They are sized against measured content:
// System needs 73px, the Favorite button 77px, an extraction badge ~110px,
// and a formatted date 102px, against the 128/116/144/152px they used to
// reserve. Reclaiming that padding is what lets the whole table fit beside a
// detail panel instead of hiding three columns inside the scroller.
// Title keeps the largest minimum: it stacks the title, the original
// filename, and the tag chips.
// Tracks 240+96+136+88+120+120 = 800px, +5x12px gap +32px padding = 892px.
//
// Exported as one named definition so `listTableWidths.test.js` reads the two
// halves of this table's width from here, instead of scanning the file for its
// first arbitrary `grid-cols-[...]` / `min-w-[...]` and hoping it belongs to
// the list.
export const documentsListTable = {
  name: "Documents",
  gridClass:
    "grid grid-cols-[minmax(15rem,2.8fr)_minmax(6rem,1.1fr)_minmax(8.5rem,1.2fr)_minmax(5.5rem,0.9fr)_minmax(7.5rem,1.1fr)_minmax(7.5rem,1.1fr)] gap-3",
  minWidthClass: "min-w-[56rem]",
};

export function DocumentsList({
  documents,
  totalDocuments = 0,
  hasActiveFilters = false,
  selectedDocumentId,
  onSelectDocument,
  onToggleFavorite,
  favoriteUpdateState,
}) {
  const listGridClass = documentsListTable.gridClass;

  return (
    <section className="overflow-hidden rounded-lg border border-slate-300 bg-white shadow-sm">
      <div className="overflow-x-auto">
        <div className={documentsListTable.minWidthClass}>
          <div
            className={`${listGridClass} border-b border-slate-800 bg-slate-950 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-200`}
          >
            <span>Title</span>
            <span>System</span>
            <span>Type</span>
            <span>Favorite</span>
            <span>Extraction</span>
            <span>Updated</span>
          </div>

          {/* An empty library and a filter that hides everything are different
              problems, so they get different next steps. The upload panel this
              points at sits directly above the list on the Documents page. */}
          {documents.length === 0 ? (
            <div className="px-4 py-8 text-sm text-slate-600">
              {totalDocuments === 0 ? (
                <div className="space-y-2">
                  <p className="font-semibold text-slate-900">No documents yet.</p>
                  <p>Upload your first PDF above to start your library.</p>
                </div>
              ) : hasActiveFilters ? (
                <div className="space-y-2">
                  <p className="font-semibold text-slate-900">
                    No documents match these filters.
                  </p>
                  <p>Change the filters above to see more of your library.</p>
                </div>
              ) : (
                <p>No documents are available right now.</p>
              )}
            </div>
          ) : null}

          {documents.map((document) => {
            const extraction = normalizeExtractionStatus(document.extractionStatus);
            const isSelected = selectedDocumentId === document.id;
            const favoriteLabel = document.isFavorite ? "Yes" : "No";

            return (
              // Row stays a <div> because the favorite toggle is a nested <button>
              // (buttons cannot nest). The title cell holds an invisible full-row
              // "stretched link" button instead: clicking anywhere on the row hits
              // it (via after:absolute after:inset-0), while the favorite button's
              // own z-index keeps it independently clickable and keyboard-reachable.
              <div
                key={document.id}
                className={`${listGridClass} relative items-center border-b border-slate-100 px-4 py-3 text-sm transition-colors has-[button:focus-visible]:ring-2 has-[button:focus-visible]:ring-inset has-[button:focus-visible]:ring-sky-500 ${
                  isSelected ? "bg-sky-50 ring-1 ring-inset ring-sky-200" : "hover:bg-slate-50"
                }`}
              >
                <div className="min-w-0">
                  <p className="flex items-center gap-1.5 font-medium text-slate-900">
                    <button
                      type="button"
                      aria-label={`Select document: ${document.title}`}
                      className="truncate text-left after:absolute after:inset-0 focus:outline-none"
                      onClick={() => onSelectDocument(document.id)}
                    >
                      {document.title}
                    </button>
                    {document.isBookmarked ? (
                      <span
                        title="Bookmarked"
                        aria-label="Bookmarked"
                        className="shrink-0 text-amber-500"
                      >
                        ★
                      </span>
                    ) : null}
                  </p>
                  <p className="truncate text-xs text-slate-500">{document.originalFilename}</p>
                  {document.embeddingPending ? (
                    <p
                      className="mt-1 inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800"
                      title="This document is searchable by keyword now. Run npm run embed:backfill to add semantic ranking."
                    >
                      Embedding pending
                    </p>
                  ) : null}
                  <div className="mt-1">
                    <TagChips tags={getDocumentTags(document)} size="xs" />
                  </div>
                </div>
                <span className="truncate text-slate-700">{document.system}</span>
                <span className="truncate text-slate-700">{document.documentType}</span>
                <div className="relative z-10">
                  <button
                    type="button"
                    disabled={
                      favoriteUpdateState.documentId === document.id &&
                      !favoriteUpdateState.error
                    }
                    className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
                    onClick={() => onToggleFavorite(document)}
                    aria-label={`Favorite: ${document.title}`}
                    aria-pressed={document.isFavorite}
                  >
                    {favoriteLabel}
                  </button>
                  {favoriteUpdateState.documentId === document.id && favoriteUpdateState.error ? (
                    <p className="mt-1 text-xs text-red-700">Failed</p>
                  ) : null}
                </div>
                <div className="min-w-0">
                  {/* normalizeExtractionStatus falls through to the raw status
                      string for anything it does not recognise, and those can be
                      a full sentence ("completed_with_warning: ocr_unavailable:
                      OCR needs Tesseract and Poppler..."). Left to wrap, one such
                      row measured 932px of content in a 144px column and grew
                      several lines tall, wrecking the density of every other row.
                      Truncating keeps rows scannable; the untruncated status
                      stays on the row's `title` and in the detail panel. */}
                  <span
                    title={extraction.label}
                    className={`block max-w-full truncate rounded-full px-2 py-1 text-xs font-semibold ${extraction.className}`}
                  >
                    {extraction.label}
                  </span>
                </div>
                <span className="truncate text-xs text-slate-600">
                  {formatDate(document.updatedAt || document.createdAt)}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
