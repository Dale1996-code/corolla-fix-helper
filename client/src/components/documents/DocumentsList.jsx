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
              <div
                key={document.id}
                className={`${listGridClass} cursor-pointer border-b border-slate-100 px-4 py-3 text-sm transition-colors ${
                  isSelected ? "bg-sky-50 ring-1 ring-inset ring-sky-200" : "hover:bg-slate-50"
                }`}
                onClick={() => onSelectDocument(document.id)}
              >
                <div className="min-w-0">
                  <p className="flex items-center gap-1.5 font-medium text-slate-900">
                    <span className="truncate">{document.title}</span>
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
                <div>
                  <button
                    type="button"
                    disabled={
                      favoriteUpdateState.documentId === document.id &&
                      !favoriteUpdateState.error
                    }
                    className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
                    onClick={(event) => {
                      event.stopPropagation();
                      onToggleFavorite(document);
                    }}
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
