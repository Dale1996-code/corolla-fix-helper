import { ErrorBanner } from "../feedback/Banner";
import { formatResultRange } from "../../lib/resultRange";
import { useRecordSearch } from "../../lib/useRecordSearch";

// Checkbox list for linking records (a symptom's documents or procedures) that
// never holds the whole library: it shows one bounded, searchable page from an
// `/api/search/*` endpoint, plus "Show more".
//
// What is already selected is listed first whether or not it is in the current
// results, so a link can always be seen and unticked -- the selection is the
// caller's (`selected`), not whatever page happens to be loaded.
export function RecordPicker({
  legend,
  endpoint,
  cache = null,
  selected,
  onToggle,
  describe,
  noun,
  nounPlural,
  searchLabel,
  searchPlaceholder,
  emptyLibraryText,
  disabled = false,
  footer = null,
}) {
  const search = useRecordSearch(endpoint, { cache });
  const selectedIds = new Set(selected.map((record) => record.id));
  const shownIds = new Set(search.results.map((record) => record.id));
  const rows = [
    ...selected.filter((record) => !shownIds.has(record.id)),
    ...search.results,
  ];
  const noMatches =
    search.settledQuery !== null && search.settledQuery !== "" && search.results.length === 0;

  if (search.libraryIsEmpty && selected.length === 0) {
    return (
      <fieldset className="grid gap-2 text-sm text-slate-700">
        <legend className="font-medium text-slate-900">{legend}</legend>
        <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
          {emptyLibraryText}
        </p>
      </fieldset>
    );
  }

  const statusText =
    search.settledQuery === null
      ? `Loading ${nounPlural}...`
      : formatResultRange({
          from: 1,
          to: search.results.length,
          total: search.total,
          noun,
          nounPlural,
          emptyText: noMatches ? `No ${nounPlural} match "${search.settledQuery}".` : "",
        });

  return (
    <fieldset className="grid gap-2 text-sm text-slate-700">
      <legend className="font-medium text-slate-900">{legend}</legend>

      <label className="grid gap-1 text-xs font-medium text-slate-700">
        <span>{searchLabel}</span>
        <input
          type="search"
          className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none transition focus:border-sky-500"
          value={search.draftQuery}
          onChange={(event) => search.setDraftQuery(event.target.value)}
          placeholder={searchPlaceholder}
        />
      </label>

      <div
        className="max-h-48 space-y-2 overflow-y-auto rounded-xl border border-slate-200 bg-slate-50 p-3"
        aria-busy={search.loading}
      >
        {rows.map((record) => (
          <label key={record.id} className="flex items-start gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={selectedIds.has(record.id)}
              disabled={disabled}
              onChange={() => onToggle(record)}
            />
            <span>
              <span className="font-medium text-slate-900">{record.title}</span>
              <span className="block text-xs text-slate-500">{describe(record)}</span>
            </span>
          </label>
        ))}

        {search.hasMore ? (
          <button
            type="button"
            onClick={search.loadMore}
            disabled={search.loading}
            className="min-h-11 rounded-lg border border-slate-300 bg-white px-3 text-xs font-semibold text-slate-700 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {search.loading ? "Loading..." : `Show more ${nounPlural}`}
          </button>
        ) : null}
      </div>

      <p className="text-xs text-slate-500" role="status">
        {statusText}
        {selected.length ? ` ${selected.length} selected.` : ""}
      </p>

      {search.error ? (
        <ErrorBanner title={`Could not load ${nounPlural}.`}>
          {search.error}
          <button
            type="button"
            className="mt-3 block min-h-11 rounded-md border border-red-300 bg-white px-4 text-sm font-medium text-red-800 hover:bg-red-100"
            onClick={search.retry}
          >
            Try again
          </button>
        </ErrorBanner>
      ) : null}

      {footer}
    </fieldset>
  );
}
