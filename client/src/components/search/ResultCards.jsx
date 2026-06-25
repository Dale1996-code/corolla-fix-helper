import { Link } from "react-router-dom";
import { buildEntityLink } from "../../lib/navigation";
import { labelize } from "./searchDisplay";

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

export function DocumentResultCard({ result, showSnippetReason }) {
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
          {result.isBookmarked ? (
            <span className="rounded-full bg-sky-100 px-3 py-1 text-xs font-semibold text-sky-800">
              Bookmarked
            </span>
          ) : null}
          <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700">
            {result.documentType || "No type"}
          </span>
        </div>
      </div>

      {Array.isArray(result.tags) && result.tags.length ? (
        <div className="mt-3 flex flex-wrap gap-1">
          {result.tags.map((tag) => (
            <span
              key={tag}
              className="rounded-full bg-sky-50 px-2 py-0.5 text-xs font-medium text-sky-700"
            >
              #{tag}
            </span>
          ))}
        </div>
      ) : null}

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

export function SymptomResultCard({ result, showSnippetReason }) {
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

export function ProcedureResultCard({ result, showSnippetReason }) {
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

export function NoteResultCard({ result, showSnippetReason }) {
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
