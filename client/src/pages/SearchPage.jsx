import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { PageHeader } from "../components/PageHeader";
import { buildEntityLink } from "../lib/navigation";

const defaultDocumentsForm = {
  q: "",
  system: "",
  documentType: "",
  favorite: "",
  sort: "relevance",
};

const defaultSymptomsForm = {
  q: "",
  system: "",
  status: "",
  sort: "newest",
};

const defaultProceduresForm = {
  q: "",
  system: "",
  difficulty: "",
  sort: "newest",
};

const defaultNotesForm = {
  q: "",
  noteType: "",
  relatedEntityType: "",
  sort: "newest",
};

const defaultDocumentsFilters = {
  systems: [],
  documentTypes: [],
};

const defaultSymptomsFilters = {
  systems: [],
  statuses: [],
};

const defaultProceduresFilters = {
  systems: [],
  difficulties: [],
};

const defaultNotesFilters = {
  noteTypes: [],
  relatedEntityTypes: [],
};

function createSectionState(filters) {
  return {
    loading: true,
    error: "",
    results: [],
    total: 0,
    filters,
  };
}

function labelize(value) {
  if (!value) {
    return "Not set";
  }

  return value
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function buildQueryString(form) {
  const searchParams = new URLSearchParams();

  Object.entries(form).forEach(([key, value]) => {
    if (typeof value !== "string") {
      return;
    }

    const trimmedValue = value.trim();

    if (trimmedValue) {
      searchParams.set(key, trimmedValue);
    }
  });

  return searchParams.toString();
}

async function fetchSearchSection(endpoint, form, setState, fallbackFilters) {
  setState((currentState) => ({
    ...currentState,
    loading: true,
    error: "",
  }));

  try {
    const queryString = buildQueryString(form);
    const response = await fetch(
      queryString ? `${endpoint}?${queryString}` : endpoint
    );
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || "Could not load search results.");
    }

    setState({
      loading: false,
      error: "",
      results: Array.isArray(payload.results) ? payload.results : [],
      total:
        typeof payload.total === "number"
          ? payload.total
          : Array.isArray(payload.results)
            ? payload.results.length
            : 0,
      filters: payload.filters || fallbackFilters,
    });
  } catch (error) {
    setState((currentState) => ({
      ...currentState,
      loading: false,
      error: error.message || "Could not load search results.",
    }));
  }
}

function SectionShell({ title, children }) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
      <div className="mt-4 space-y-4">{children}</div>
    </section>
  );
}

function SectionActions({ loading, onClear }) {
  return (
    <div className="flex flex-wrap gap-3">
      <button
        type="submit"
        disabled={loading}
        className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-400"
      >
        {loading ? "Searching..." : "Search"}
      </button>
      <button
        type="button"
        onClick={onClear}
        className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-100"
      >
        Clear
      </button>
    </div>
  );
}

function KeywordField({ value, onChange, placeholder }) {
  return (
    <label className="grid gap-2 text-sm text-slate-700">
      <span className="font-medium text-slate-900">Keyword</span>
      <input
        className="rounded-xl border border-slate-300 px-3 py-2 outline-none transition focus:border-sky-500"
        value={value}
        onChange={onChange}
        placeholder={placeholder}
      />
    </label>
  );
}

function SelectField({ label, value, onChange, emptyLabel, options }) {
  return (
    <label className="grid gap-2 text-sm text-slate-700">
      <span className="font-medium text-slate-900">{label}</span>
      <select
        className="rounded-xl border border-slate-300 px-3 py-2 outline-none transition focus:border-sky-500"
        value={value}
        onChange={onChange}
      >
        <option value="">{emptyLabel}</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {labelize(option)}
          </option>
        ))}
      </select>
    </label>
  );
}

function ResultSummary({ total, label }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
      Found <span className="font-semibold text-slate-900">{total}</span> {label}
      {total === 1 ? "" : "s"}.
    </section>
  );
}

function SectionStatus({ loading, error, total, label, emptyMessage }) {
  if (loading) {
    return (
      <section className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
        Loading {label}...
      </section>
    );
  }

  if (error) {
    return (
      <section className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
        {error}
      </section>
    );
  }

  if (total === 0) {
    return (
      <section className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-3 text-sm text-slate-600">
        {emptyMessage}
      </section>
    );
  }

  return null;
}

function SnippetBlock({ snippet, snippetField, showSnippetReason }) {
  if (!snippet) {
    return null;
  }

  return (
    <div className="mt-4 rounded-xl bg-slate-50 p-4">
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
        {showSnippetReason && snippetField ? `Matched in ${snippetField}` : "Preview"}
      </p>
      <p className="mt-2 text-sm leading-6 text-slate-700">{snippet}</p>
    </div>
  );
}

function DocumentResultCard({ result, showSnippetReason }) {
  return (
    <article className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-slate-900">{result.title}</h3>
          <p className="mt-1 text-sm text-slate-500">
            {result.originalFilename || "No original filename"}
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          {result.isFavorite ? (
            <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-800">
              Favorite
            </span>
          ) : null}
          <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700">
            {result.documentType || "No type"}
          </span>
        </div>
      </div>

      <div className="mt-4 grid gap-3 text-sm text-slate-700 md:grid-cols-2">
        <p>
          <span className="font-semibold text-slate-900">System:</span>{" "}
          {result.system || "Not set"}
        </p>
        <p>
          <span className="font-semibold text-slate-900">Source:</span>{" "}
          {result.source || "Not set"}
        </p>
        <p>
          <span className="font-semibold text-slate-900">Pages:</span>{" "}
          {result.pageCount ?? "Unknown"}
        </p>
        <p>
          <span className="font-semibold text-slate-900">Extraction:</span>{" "}
          {result.extractionStatus || "Unknown"}
        </p>
      </div>

      <SnippetBlock
        snippet={result.snippet}
        snippetField={result.snippetField}
        showSnippetReason={showSnippetReason}
      />

      <Link
        to={buildEntityLink("document", result.id)}
        aria-label={`Open document ${result.title}`}
        className="mt-4 inline-flex text-sm font-medium text-sky-700 underline decoration-sky-200 underline-offset-2 hover:text-sky-900"
      >
        Open document
      </Link>
    </article>
  );
}

function SymptomResultCard({ result, showSnippetReason }) {
  const linkedDocumentCount =
    typeof result.linkedDocumentCount === "number"
      ? result.linkedDocumentCount
      : Array.isArray(result.linkedDocuments)
        ? result.linkedDocuments.length
        : 0;

  return (
    <article className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-slate-900">{result.title}</h3>
          <p className="mt-1 text-sm text-slate-500">
            {result.system || "No system"} - {labelize(result.status)}
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700">
            {labelize(result.confidence)}
          </span>
          <span className="rounded-full bg-sky-100 px-3 py-1 text-xs font-semibold text-sky-800">
            {linkedDocumentCount} linked docs
          </span>
        </div>
      </div>

      <SnippetBlock
        snippet={result.snippet}
        snippetField={result.snippetField}
        showSnippetReason={showSnippetReason}
      />

      <Link
        to={buildEntityLink("symptom", result.id)}
        aria-label={`Open symptom ${result.title}`}
        className="mt-4 inline-flex text-sm font-medium text-sky-700 underline decoration-sky-200 underline-offset-2 hover:text-sky-900"
      >
        Open symptom
      </Link>
    </article>
  );
}

function ProcedureResultCard({ result, showSnippetReason }) {
  const linkedDocumentCount =
    typeof result.linkedDocumentCount === "number"
      ? result.linkedDocumentCount
      : Array.isArray(result.linkedDocuments)
        ? result.linkedDocuments.length
        : 0;

  return (
    <article className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-slate-900">{result.title}</h3>
          <p className="mt-1 text-sm text-slate-500">
            {result.system || "No system"} - {labelize(result.difficulty)}
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700">
            {labelize(result.confidence)}
          </span>
          <span className="rounded-full bg-sky-100 px-3 py-1 text-xs font-semibold text-sky-800">
            {linkedDocumentCount} linked docs
          </span>
        </div>
      </div>

      <SnippetBlock
        snippet={result.snippet}
        snippetField={result.snippetField}
        showSnippetReason={showSnippetReason}
      />

      <Link
        to={buildEntityLink("procedure", result.id)}
        aria-label={`Open procedure ${result.title}`}
        className="mt-4 inline-flex text-sm font-medium text-sky-700 underline decoration-sky-200 underline-offset-2 hover:text-sky-900"
      >
        Open procedure
      </Link>
    </article>
  );
}

function NoteResultCard({ result, showSnippetReason }) {
  const linkedTitle =
    result.linkedTitle ||
    result.linkedDocument?.title ||
    result.linkedSymptom?.title ||
    result.linkedProcedure?.title ||
    "";

  return (
    <article className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-slate-900">{result.title}</h3>
          <p className="mt-1 text-sm text-slate-500">
            {labelize(result.noteType)} note
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700">
            {labelize(result.relatedEntityType)}
          </span>
        </div>
      </div>

      {linkedTitle ? (
        <p className="mt-4 text-sm text-slate-700">
          <span className="font-semibold text-slate-900">Linked item:</span>{" "}
          {linkedTitle}
        </p>
      ) : null}

      <SnippetBlock
        snippet={result.snippet}
        snippetField={result.snippetField}
        showSnippetReason={showSnippetReason}
      />

      <Link
        to={buildEntityLink("note", result.id)}
        aria-label={`Open note ${result.title}`}
        className="mt-4 inline-flex text-sm font-medium text-sky-700 underline decoration-sky-200 underline-offset-2 hover:text-sky-900"
      >
        Open note
      </Link>
    </article>
  );
}

function DocumentsSection() {
  const [form, setForm] = useState(defaultDocumentsForm);
  const [state, setState] = useState(createSectionState(defaultDocumentsFilters));
  const hasKeyword = form.q.trim().length > 0;

  async function runSearch(nextForm = form) {
    await fetchSearchSection(
      "/api/search/documents",
      nextForm,
      setState,
      defaultDocumentsFilters
    );
  }

  useEffect(() => {
    runSearch(defaultDocumentsForm);
  }, []);

  function handleSubmit(event) {
    event.preventDefault();
    runSearch();
  }

  function handleClear() {
    setForm(defaultDocumentsForm);
    runSearch(defaultDocumentsForm);
  }

  return (
    <SectionShell title="Documents">
      <form className="space-y-4" onSubmit={handleSubmit}>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
          <KeywordField
            value={form.q}
            onChange={(event) =>
              setForm((currentForm) => ({ ...currentForm, q: event.target.value }))
            }
            placeholder="spark plug, wiring, torque specs"
          />

          <SelectField
            label="System"
            value={form.system}
            onChange={(event) =>
              setForm((currentForm) => ({ ...currentForm, system: event.target.value }))
            }
            emptyLabel="All systems"
            options={state.filters.systems || []}
          />

          <SelectField
            label="Document type"
            value={form.documentType}
            onChange={(event) =>
              setForm((currentForm) => ({
                ...currentForm,
                documentType: event.target.value,
              }))
            }
            emptyLabel="All document types"
            options={state.filters.documentTypes || []}
          />

          <label className="grid gap-2 text-sm text-slate-700">
            <span className="font-medium text-slate-900">Favorite filter</span>
            <select
              className="rounded-xl border border-slate-300 px-3 py-2 outline-none transition focus:border-sky-500"
              value={form.favorite}
              onChange={(event) =>
                setForm((currentForm) => ({
                  ...currentForm,
                  favorite: event.target.value,
                }))
              }
            >
              <option value="">All documents</option>
              <option value="true">Favorites only</option>
            </select>
          </label>

          <label className="grid gap-2 text-sm text-slate-700">
            <span className="font-medium text-slate-900">Sort</span>
            <select
              className="rounded-xl border border-slate-300 px-3 py-2 outline-none transition focus:border-sky-500"
              value={form.sort}
              onChange={(event) =>
                setForm((currentForm) => ({ ...currentForm, sort: event.target.value }))
              }
            >
              <option value="relevance">Relevance</option>
              <option value="newest">Newest</option>
              <option value="title">Title</option>
            </select>
          </label>
        </div>

        <SectionActions loading={state.loading} onClear={handleClear} />
      </form>

      {!state.loading && !state.error ? (
        <ResultSummary total={state.total} label="document result" />
      ) : null}

      <SectionStatus
        loading={state.loading}
        error={state.error}
        total={state.total}
        label="documents"
        emptyMessage="No documents matched this search."
      />

      {!state.loading && !state.error && state.results.length
        ? state.results.map((result) => (
            <DocumentResultCard
              key={result.id}
              result={result}
              showSnippetReason={hasKeyword}
            />
          ))
        : null}
    </SectionShell>
  );
}

function SymptomsSection() {
  const [form, setForm] = useState(defaultSymptomsForm);
  const [state, setState] = useState(createSectionState(defaultSymptomsFilters));
  const hasKeyword = form.q.trim().length > 0;

  async function runSearch(nextForm = form) {
    await fetchSearchSection(
      "/api/search/symptoms",
      nextForm,
      setState,
      defaultSymptomsFilters
    );
  }

  useEffect(() => {
    runSearch(defaultSymptomsForm);
  }, []);

  function handleSubmit(event) {
    event.preventDefault();
    runSearch();
  }

  function handleClear() {
    setForm(defaultSymptomsForm);
    runSearch(defaultSymptomsForm);
  }

  return (
    <SectionShell title="Symptoms">
      <form className="space-y-4" onSubmit={handleSubmit}>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <KeywordField
            value={form.q}
            onChange={(event) =>
              setForm((currentForm) => ({ ...currentForm, q: event.target.value }))
            }
            placeholder="idle, vibration, leak"
          />

          <SelectField
            label="System"
            value={form.system}
            onChange={(event) =>
              setForm((currentForm) => ({ ...currentForm, system: event.target.value }))
            }
            emptyLabel="All systems"
            options={state.filters.systems || []}
          />

          <SelectField
            label="Status"
            value={form.status}
            onChange={(event) =>
              setForm((currentForm) => ({ ...currentForm, status: event.target.value }))
            }
            emptyLabel="All statuses"
            options={state.filters.statuses || []}
          />

          <label className="grid gap-2 text-sm text-slate-700">
            <span className="font-medium text-slate-900">Sort</span>
            <select
              className="rounded-xl border border-slate-300 px-3 py-2 outline-none transition focus:border-sky-500"
              value={form.sort}
              onChange={(event) =>
                setForm((currentForm) => ({ ...currentForm, sort: event.target.value }))
              }
            >
              <option value="newest">Newest</option>
              <option value="oldest">Oldest</option>
              <option value="title">Title</option>
            </select>
          </label>
        </div>

        <SectionActions loading={state.loading} onClear={handleClear} />
      </form>

      {!state.loading && !state.error ? (
        <ResultSummary total={state.total} label="symptom result" />
      ) : null}

      <SectionStatus
        loading={state.loading}
        error={state.error}
        total={state.total}
        label="symptoms"
        emptyMessage="No symptoms matched this search."
      />

      {!state.loading && !state.error && state.results.length
        ? state.results.map((result) => (
            <SymptomResultCard
              key={result.id}
              result={result}
              showSnippetReason={hasKeyword}
            />
          ))
        : null}
    </SectionShell>
  );
}

function ProceduresSection() {
  const [form, setForm] = useState(defaultProceduresForm);
  const [state, setState] = useState(createSectionState(defaultProceduresFilters));
  const hasKeyword = form.q.trim().length > 0;

  async function runSearch(nextForm = form) {
    await fetchSearchSection(
      "/api/search/procedures",
      nextForm,
      setState,
      defaultProceduresFilters
    );
  }

  useEffect(() => {
    runSearch(defaultProceduresForm);
  }, []);

  function handleSubmit(event) {
    event.preventDefault();
    runSearch();
  }

  function handleClear() {
    setForm(defaultProceduresForm);
    runSearch(defaultProceduresForm);
  }

  return (
    <SectionShell title="Procedures">
      <form className="space-y-4" onSubmit={handleSubmit}>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <KeywordField
            value={form.q}
            onChange={(event) =>
              setForm((currentForm) => ({ ...currentForm, q: event.target.value }))
            }
            placeholder="cleaning, inspection, replacement"
          />

          <SelectField
            label="System"
            value={form.system}
            onChange={(event) =>
              setForm((currentForm) => ({ ...currentForm, system: event.target.value }))
            }
            emptyLabel="All systems"
            options={state.filters.systems || []}
          />

          <SelectField
            label="Difficulty"
            value={form.difficulty}
            onChange={(event) =>
              setForm((currentForm) => ({
                ...currentForm,
                difficulty: event.target.value,
              }))
            }
            emptyLabel="All difficulties"
            options={state.filters.difficulties || []}
          />

          <label className="grid gap-2 text-sm text-slate-700">
            <span className="font-medium text-slate-900">Sort</span>
            <select
              className="rounded-xl border border-slate-300 px-3 py-2 outline-none transition focus:border-sky-500"
              value={form.sort}
              onChange={(event) =>
                setForm((currentForm) => ({ ...currentForm, sort: event.target.value }))
              }
            >
              <option value="newest">Newest</option>
              <option value="oldest">Oldest</option>
              <option value="title">Title</option>
            </select>
          </label>
        </div>

        <SectionActions loading={state.loading} onClear={handleClear} />
      </form>

      {!state.loading && !state.error ? (
        <ResultSummary total={state.total} label="procedure result" />
      ) : null}

      <SectionStatus
        loading={state.loading}
        error={state.error}
        total={state.total}
        label="procedures"
        emptyMessage="No procedures matched this search."
      />

      {!state.loading && !state.error && state.results.length
        ? state.results.map((result) => (
            <ProcedureResultCard
              key={result.id}
              result={result}
              showSnippetReason={hasKeyword}
            />
          ))
        : null}
    </SectionShell>
  );
}

function NotesSection() {
  const [form, setForm] = useState(defaultNotesForm);
  const [state, setState] = useState(createSectionState(defaultNotesFilters));
  const hasKeyword = form.q.trim().length > 0;

  async function runSearch(nextForm = form) {
    await fetchSearchSection("/api/search/notes", nextForm, setState, defaultNotesFilters);
  }

  useEffect(() => {
    runSearch(defaultNotesForm);
  }, []);

  function handleSubmit(event) {
    event.preventDefault();
    runSearch();
  }

  function handleClear() {
    setForm(defaultNotesForm);
    runSearch(defaultNotesForm);
  }

  return (
    <SectionShell title="Notes">
      <form className="space-y-4" onSubmit={handleSubmit}>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <KeywordField
            value={form.q}
            onChange={(event) =>
              setForm((currentForm) => ({ ...currentForm, q: event.target.value }))
            }
            placeholder="observation, reminder, repair log"
          />

          <SelectField
            label="Note type"
            value={form.noteType}
            onChange={(event) =>
              setForm((currentForm) => ({ ...currentForm, noteType: event.target.value }))
            }
            emptyLabel="All note types"
            options={state.filters.noteTypes || []}
          />

          <SelectField
            label="Linked item type"
            value={form.relatedEntityType}
            onChange={(event) =>
              setForm((currentForm) => ({
                ...currentForm,
                relatedEntityType: event.target.value,
              }))
            }
            emptyLabel="All link types"
            options={state.filters.relatedEntityTypes || []}
          />

          <label className="grid gap-2 text-sm text-slate-700">
            <span className="font-medium text-slate-900">Sort</span>
            <select
              className="rounded-xl border border-slate-300 px-3 py-2 outline-none transition focus:border-sky-500"
              value={form.sort}
              onChange={(event) =>
                setForm((currentForm) => ({ ...currentForm, sort: event.target.value }))
              }
            >
              <option value="newest">Newest</option>
              <option value="oldest">Oldest</option>
            </select>
          </label>
        </div>

        <SectionActions loading={state.loading} onClear={handleClear} />
      </form>

      {!state.loading && !state.error ? (
        <ResultSummary total={state.total} label="note result" />
      ) : null}

      <SectionStatus
        loading={state.loading}
        error={state.error}
        total={state.total}
        label="notes"
        emptyMessage="No notes matched this search."
      />

      {!state.loading && !state.error && state.results.length
        ? state.results.map((result) => (
            <NoteResultCard
              key={result.id}
              result={result}
              showSnippetReason={hasKeyword}
            />
          ))
        : null}
    </SectionShell>
  );
}

export function SearchPage() {
  return (
    <>
      <PageHeader
        eyebrow="Working Feature"
        title="Search"
        description="Search documents, symptoms, procedures, and notes from one page while keeping each search area separate and easy to understand."
      />

      <div className="space-y-6">
        <DocumentsSection />
        <SymptomsSection />
        <ProceduresSection />
        <NotesSection />
      </div>
    </>
  );
}
