import { formatDate } from "../../lib/formatDate";
import { getDocumentTags, normalizeExtractionStatus } from "./documentDisplay";
import { TagChips } from "./TagChips";

export function DocumentsList({
  documents,
  selectedDocumentId,
  onSelectDocument,
  onToggleFavorite,
  favoriteUpdateState,
}) {
  const listGridClass =
    "grid grid-cols-[minmax(15rem,2.8fr)_minmax(8rem,1.1fr)_minmax(9rem,1.2fr)_minmax(7.25rem,0.9fr)_minmax(9rem,1.1fr)_minmax(9.5rem,1.1fr)] gap-3";

  return (
    <section className="overflow-hidden rounded-lg border border-slate-300 bg-white shadow-sm">
      <div className="overflow-x-auto">
        <div className="min-w-[820px]">
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

          {documents.length === 0 ? (
            <div className="px-4 py-6 text-sm text-slate-600">
              No documents match these filters.
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
                <div>
                  <span
                    className={`rounded-full px-2 py-1 text-xs font-semibold ${extraction.className}`}
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
