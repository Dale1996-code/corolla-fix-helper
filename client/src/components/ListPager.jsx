// Previous / "Page 2 of 3" / Next for a list the server pages. The page numbers
// are the ones the rows on screen belong to, so the caller passes the settled
// page, not the one the URL is still loading. Renders nothing for one page.
//
// The markup matches the Documents page's pager, so the lists read alike; 44px
// buttons keep it usable with a thumb.
export function ListPager({ label, currentPage, totalPages, onGoToPage }) {
  if (totalPages <= 1) {
    return null;
  }

  return (
    <nav aria-label={label} className="flex items-center justify-between gap-3 sm:justify-end">
      <button
        type="button"
        className="min-h-11 rounded-md border border-slate-300 bg-white px-4 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
        onClick={() => onGoToPage(Math.max(1, currentPage - 1))}
        disabled={currentPage <= 1}
      >
        Previous
      </button>
      <span className="text-xs text-slate-600">
        Page <span className="font-semibold text-slate-900">{currentPage}</span> of{" "}
        <span className="font-semibold text-slate-900">{totalPages}</span>
      </span>
      <button
        type="button"
        className="min-h-11 rounded-md border border-slate-300 bg-white px-4 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
        onClick={() => onGoToPage(Math.min(totalPages, currentPage + 1))}
        disabled={currentPage >= totalPages}
      >
        Next
      </button>
    </nav>
  );
}
