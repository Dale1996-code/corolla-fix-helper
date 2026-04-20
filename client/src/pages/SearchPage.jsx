import { useEffect, useState } from "react";
import { PageHeader } from "../components/PageHeader";

const defaultSearchForm = {
  q: "",
  system: "",
  documentType: "",
  favorite: "",
  sort: "relevance",
};

function SearchFilters({
  form,
  filters,
  searching,
  onChange,
  onSubmit,
  onReset,
}) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <form className="grid gap-4" onSubmit={onSubmit}>
        <label className="grid gap-2 text-sm text-slate-700">
          <span className="font-medium text-slate-900">Search documents</span>
          <input
            className="rounded-xl border border-slate-300 px-3 py-2 outline-none transition focus:border-sky-500"
            name="q"
            value={form.q}
            onChange={onChange}
            placeholder="Try: spark plug, wiring, torque specs"
          />
        </label>

        <div className="grid gap-4 md:grid-cols-4">
          <label className="grid gap-2 text-sm text-slate-700">
            <span className="font-medium text-slate-900">System</span>
            <select
              className="rounded-xl border border-slate-300 px-3 py-2 outline-none transition focus:border-sky-500"
              name="system"
              value={form.system}
              onChange={onChange}
            >
              <option value="">All systems</option>
              {filters.systems.map((system) => (
                <option key={system} value={system}>
                  {system}
                </option>
              ))}
            </select>
          </label>

          <label className="grid gap-2 text-sm text-slate-700">
            <span className="font-medium text-slate-900">Document type</span>
            <select
              className="rounded-xl border border-slate-300 px-3 py-2 outline-none transition focus:border-sky-500"
              name="documentType"
              value={form.documentType}
              onChange={onChange}
            >
              <option value="">All document types</option>
              {filters.documentTypes.map((documentType) => (
                <option key={documentType} value={documentType}>
                  {documentType}
                </option>
              ))}
            </select>
          </label>

          <label className="grid gap-2 text-sm text-slate-700">
            <span className="font-medium text-slate-900">Favorite filter</span>
            <select
              className="rounded-xl border border-slate-300 px-3 py-2 outline-none transition focus:border-sky-500"
              name="favorite"
              value={form.favorite}
              onChange={onChange}
            >
              <option value="">All documents</option>
              <option value="true">Favorites only</option>
            </select>
          </label>

          <label className="grid gap-2 text-sm text-slate-700">
            <span className="font-medium text-slate-900">Sort by</span>
            <select
              className="rounded-xl border border-slate-300 px-3 py-2 outline-none transition focus:border-sky-500"
              name="sort"
              value={form.sort}
              onChange={onChange}
            >
              <option value="relevance">Relevance</option>
              <option value="newest">Newest</option>
              <option value="title">Title</option>
            </select>
          </label>
        </div>

        <div className="flex flex-wrap gap-3">
          <button
            type="submit"
            disabled={searching}
            className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-400"
          >
            {searching ? "Searching..." : "Run search"}
          </button>
          <button
            type="button"
            onClick={onReset}
            className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-100"
          >
            Clear filters
          </button>
        </div>
      </form>
    </section>
  );
}

function SearchResultCard({ result, showSnippetReason }) {
  return (
    <article className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold text-slate-900">{result.title}</h3>
          <p className="mt-1 text-sm text-slate-500">{result.originalFilename}</p>
        </div>

        <div className="flex flex-wrap gap-2">
          {result.isFavorite ? (
            <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-800">
              Favorite
            </span>
          ) : null}
          <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700">
            {result.documentType}
          </span>
        </div>
      </div>

      <div className="mt-4 grid gap-3 text-sm text-slate-700 md:grid-cols-2">
        <p>
          <span className="font-semibold text-slate-900">System:</span> {result.system}
        </p>
        <p>
          <span className="font-semibold text-slate-900">Source:</span>{" "}
          {result.source || "Not set yet"}
        </p>
        <p>
          <span className="font-semibold text-slate-900">Pages:</span>{" "}
          {result.pageCount ?? "Unknown"}
        </p>
        <p>
          <span className="font-semibold text-slate-900">Extraction:</span>{" "}
          {result.extractionStatus}
        </p>
        <p>
          <span className="font-semibold text-slate-900">Stored file:</span>{" "}
          {result.storedFilename}
        </p>
        <p>
          <span className="font-semibold text-slate-900">Vehicle:</span> {result.vehicleLabel}
        </p>
      </div>

      {result.snippet ? (
        <div className="mt-4 rounded-2xl bg-slate-50 p-4">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">
            {showSnippetReason && result.snippetField
              ? `Matched in ${result.snippetField}`
              : "Preview"}
          </p>
          <p className="mt-2 text-sm leading-6 text-slate-700">{result.snippet}</p>
        </div>
      ) : null}
    </article>
  );
}

export function SearchPage() {
  const [form, setForm] = useState(defaultSearchForm);
  const [results, setResults] = useState([]);
  const [filters, setFilters] = useState({ systems: [], documentTypes: [] });
  const [loading, setLoading] = useState(true);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState("");

  async function loadResults(nextForm) {
    try {
      setError("");
      setSearching(true);

      const searchParams = new URLSearchParams();

      if (nextForm.q.trim()) {
        searchParams.set("q", nextForm.q.trim());
      }

      if (nextForm.system) {
        searchParams.set("system", nextForm.system);
      }

      if (nextForm.documentType) {
        searchParams.set("documentType", nextForm.documentType);
      }

      if (nextForm.favorite) {
        searchParams.set("favorite", nextForm.favorite);
      }

      searchParams.set("sort", nextForm.sort);

      const response = await fetch(`/api/search?${searchParams.toString()}`);
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Could not load search results.");
      }

      setResults(data.results || []);
      setFilters(data.filters || { systems: [], documentTypes: [] });
    } catch (requestError) {
      setError(requestError.message || "Could not load search results.");
    } finally {
      setSearching(false);
      setLoading(false);
    }
  }

  useEffect(() => {
    loadResults(defaultSearchForm);
  }, []);

  function handleChange(event) {
    const { name, value } = event.target;
    setForm((currentForm) => ({
      ...currentForm,
      [name]: value,
    }));
  }

  function handleSubmit(event) {
    event.preventDefault();
    loadResults(form);
  }

  function handleReset() {
    setForm(defaultSearchForm);
    loadResults(defaultSearchForm);
  }

  const hasActiveQuery = form.q.trim().length > 0;

  return (
    <>
      <PageHeader
        eyebrow="Working Feature"
        title="Document Search"
        description="Search only your imported repair documents by title, filename, notes, and extracted text. This page does not search symptoms, procedures, or notes yet."
      />

      <div className="space-y-6">
        <section className="rounded-2xl border border-sky-200 bg-sky-50 p-4 shadow-sm">
          <p className="text-sm text-sky-900">
            This page searches imported documents only. Symptoms, procedures, and notes are
            still managed on their own pages.
          </p>
        </section>

        <SearchFilters
          form={form}
          filters={filters}
          searching={searching}
          onChange={handleChange}
          onSubmit={handleSubmit}
          onReset={handleReset}
        />

        {loading ? (
          <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <p className="text-sm text-slate-600">Loading search data...</p>
          </section>
        ) : null}

        {error ? (
          <section className="rounded-2xl border border-red-200 bg-red-50 p-6 shadow-sm">
            <p className="font-semibold text-red-800">Search failed.</p>
            <p className="mt-2 text-sm text-red-700">{error}</p>
          </section>
        ) : null}

        {!loading && !error ? (
          <div className="space-y-4">
            <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <p className="text-sm text-slate-600">
                Found <span className="font-semibold text-slate-900">{results.length}</span>{" "}
                matching document{results.length === 1 ? "" : "s"}.
              </p>
            </section>

            {results.length ? (
              results.map((result) => (
                <SearchResultCard
                  key={result.id}
                  result={result}
                  showSnippetReason={hasActiveQuery}
                />
              ))
            ) : (
              <section className="rounded-2xl border border-dashed border-slate-300 bg-white p-6 text-sm text-slate-600 shadow-sm">
                No documents matched this search yet. Try a broader keyword or clear one of the filters.
              </section>
            )}
          </div>
        ) : null}
      </div>
    </>
  );
}
