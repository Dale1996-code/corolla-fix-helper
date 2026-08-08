import { formatResultRange } from "../../lib/resultRange";

export function ProceduresListControls({
  searchValue,
  onSearchChange,
  systemFilter,
  onSystemFilterChange,
  difficultyFilter,
  onDifficultyFilterChange,
  confidenceFilter,
  onConfidenceFilterChange,
  sortBy,
  onSortByChange,
  systems,
  totalCount,
  visibleCount,
  hasActiveFilters,
  onClearFilters,
}) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
        <label className="grid gap-1 text-xs font-medium text-slate-700">
          <span>Search</span>
          <input
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none transition focus:border-sky-500"
            value={searchValue}
            onChange={onSearchChange}
            placeholder="Search title, system, tools, parts, steps, or notes"
          />
        </label>

        <label className="grid gap-1 text-xs font-medium text-slate-700">
          <span>System filter</span>
          <select
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            value={systemFilter}
            onChange={onSystemFilterChange}
          >
            <option value="all">All systems</option>
            {systems.map((system) => (
              <option key={system} value={system}>
                {system}
              </option>
            ))}
          </select>
        </label>

        <label className="grid gap-1 text-xs font-medium text-slate-700">
          <span>Difficulty filter</span>
          <select
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            value={difficultyFilter}
            onChange={onDifficultyFilterChange}
          >
            <option value="all">All difficulty levels</option>
            <option value="beginner">Beginner</option>
            <option value="intermediate">Intermediate</option>
            <option value="advanced">Advanced</option>
          </select>
        </label>

        <label className="grid gap-1 text-xs font-medium text-slate-700">
          <span>Confidence filter</span>
          <select
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            value={confidenceFilter}
            onChange={onConfidenceFilterChange}
          >
            <option value="all">All confidence levels</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
        </label>

        <label className="grid gap-1 text-xs font-medium text-slate-700">
          <span>Sort</span>
          <select
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            value={sortBy}
            onChange={onSortByChange}
          >
            <option value="newest">Newest updates first</option>
            <option value="oldest">Oldest updates first</option>
            <option value="title">Title A-Z</option>
          </select>
        </label>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 pt-4">
        {/* The whole filtered list is on screen (procedures do not page), so
            the range runs first row to last. The library total lives in the
            banner above this card, so it is not restated here. */}
        <p className="text-sm text-slate-600">
          {formatResultRange({
            from: 1,
            to: visibleCount,
            total: visibleCount,
            noun: "procedure",
            nounPlural: "procedures",
            emptyText: totalCount
              ? "No procedures match these filters."
              : "No procedures yet.",
          })}
        </p>

        {hasActiveFilters ? (
          <button
            type="button"
            onClick={onClearFilters}
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-100"
          >
            Clear filters
          </button>
        ) : null}
      </div>
    </section>
  );
}
