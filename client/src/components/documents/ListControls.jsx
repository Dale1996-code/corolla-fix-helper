export function ListControls({
  sortBy,
  onSortChange,
  systemFilter,
  onSystemFilterChange,
  documentTypeFilter,
  onDocumentTypeFilterChange,
  favoriteFilter,
  onFavoriteFilterChange,
  bookmarkFilter,
  onBookmarkFilterChange,
  tagFilter,
  onTagFilterChange,
  systems,
  documentTypes,
  tags,
}) {
  return (
    <section className="rounded-lg border border-slate-300 bg-white p-4 shadow-sm">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold uppercase tracking-[0.18em] text-slate-500">
          Library controls
        </h3>
      </div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <label className="grid gap-1 text-xs font-medium text-slate-700">
          <span>Sort</span>
          <select
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
            value={sortBy}
            onChange={onSortChange}
          >
            <option value="newest">Newest</option>
            <option value="oldest">Oldest</option>
            <option value="title_asc">Title A-Z</option>
          </select>
        </label>

        <label className="grid gap-1 text-xs font-medium text-slate-700">
          <span>System</span>
          <select
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
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
          <span>Document type</span>
          <select
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
            value={documentTypeFilter}
            onChange={onDocumentTypeFilterChange}
          >
            <option value="all">All types</option>
            {documentTypes.map((documentType) => (
              <option key={documentType} value={documentType}>
                {documentType}
              </option>
            ))}
          </select>
        </label>

        <label className="grid gap-1 text-xs font-medium text-slate-700">
          <span>Favorite</span>
          <select
            className="min-w-[10.5rem] w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
            value={favoriteFilter}
            onChange={onFavoriteFilterChange}
          >
            <option value="all">All</option>
            <option value="favorites_only">Favorites only</option>
            <option value="not_favorites">Not favorites</option>
          </select>
        </label>

        <label className="grid gap-1 text-xs font-medium text-slate-700">
          <span>Bookmark</span>
          <select
            className="min-w-[10.5rem] w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
            value={bookmarkFilter}
            onChange={onBookmarkFilterChange}
          >
            <option value="all">All</option>
            <option value="bookmarked_only">Bookmarked only</option>
            <option value="not_bookmarked">Not bookmarked</option>
          </select>
        </label>

        <label className="grid gap-1 text-xs font-medium text-slate-700">
          <span>Tag</span>
          <select
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
            value={tagFilter}
            onChange={onTagFilterChange}
          >
            <option value="all">All tags</option>
            {tags.map((tag) => (
              <option key={tag} value={tag}>
                #{tag}
              </option>
            ))}
          </select>
        </label>

      </div>
    </section>
  );
}
