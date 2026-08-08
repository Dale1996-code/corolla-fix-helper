import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { PageHeader } from "../components/PageHeader";
import { SectionCard } from "../components/SectionCard";
import { ErrorBanner, InfoBanner } from "../components/feedback/Banner";
import {
  AI_DISCLOSURE_ASK,
  AiSafetyNotices,
} from "../components/feedback/AiSafetyNotices";
import { SelectField, TextField } from "../components/forms/FormFields";
import { attachmentFileUrl, fetchAllImageAttachments } from "../lib/apiClient";
import { labelize } from "../lib/labelize";
import { buildDocumentFileLink, documentSourceName } from "../lib/navigation";
import {
  DocumentResultCard,
  NoteResultCard,
  ProcedureResultCard,
  SymptomResultCard,
} from "../components/search/ResultCards";
import { applyParamUpdates, pageParamValue, readPageParam } from "../lib/urlState";

// The shared SelectField takes [{ value, label }]; search filter options come
// back from the API as plain strings, so labelize them into that shape here.
function toOptions(values) {
  return values.map((value) => ({ value, label: labelize(value) }));
}

const DOCUMENTS_SORT_OPTIONS = [
  { value: "relevance", label: "Relevance" },
  { value: "newest", label: "Newest" },
  { value: "title", label: "Title" },
];

const TITLE_SORT_OPTIONS = [
  { value: "newest", label: "Newest" },
  { value: "oldest", label: "Oldest" },
  { value: "title", label: "Title" },
];

const NEWEST_OLDEST_SORT_OPTIONS = [
  { value: "newest", label: "Newest" },
  { value: "oldest", label: "Oldest" },
];

const FAVORITE_OPTIONS = [{ value: "true", label: "Favorites only" }];
const BOOKMARKED_OPTIONS = [{ value: "true", label: "Bookmarked only" }];

// Matches the server's default page size for /api/search/documents. The server
// clamps whatever it is sent, so this only decides how much we ask for.
const DOCUMENT_RESULTS_PER_PAGE = 25;

function formatCount(value) {
  return value.toLocaleString("en-US");
}

const defaultDocumentsForm = {
  q: "",
  system: "",
  documentType: "",
  favorite: "",
  bookmarked: "",
  tag: "",
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
  tags: [],
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
    // Echoed back by paginated endpoints so the counter and the Previous/Next
    // controls describe the page the server actually returned, not the one we
    // asked for.
    limit: DOCUMENT_RESULTS_PER_PAGE,
    offset: 0,
    hasMore: false,
    filters,
  };
}

// Four search cards share one page, and therefore one query string, so each
// one's parameters carry its section key: `documents.q`, `symptoms.status`,
// `documents.page`. Without the prefix the cards would silently overwrite each
// other's keyword the moment two of them were used in the same visit.
function sectionParamKey(config, field) {
  return `${config.key}.${field}`;
}

// The form the visible results actually came from, read back out of the URL.
// A field the URL does not mention is at its default, which is exactly how it
// got left out in the first place.
function readSectionForm(searchParams, config) {
  const form = {};

  Object.entries(config.defaultForm).forEach(([field, defaultValue]) => {
    const value = searchParams.get(sectionParamKey(config, field));
    form[field] = typeof value === "string" && value !== "" ? value : defaultValue;
  });

  return form;
}

// Updates that write a submitted form into the URL, leaving out every field
// still at its default so an untouched card adds nothing to the address bar.
function sectionFormUpdates(form, config) {
  const updates = {};

  Object.entries(config.defaultForm).forEach(([field, defaultValue]) => {
    const value = typeof form[field] === "string" ? form[field].trim() : "";
    updates[sectionParamKey(config, field)] = value && value !== defaultValue ? value : null;
  });

  return updates;
}

// Every parameter one card owns, cleared -- the other three cards' parameters
// (and anything else in the query string) are left alone.
function clearSectionUpdates(config) {
  const updates = { [sectionParamKey(config, "page")]: null };

  Object.keys(config.defaultForm).forEach((field) => {
    updates[sectionParamKey(config, field)] = null;
  });

  return updates;
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

// `shouldApply` guards against a stale response overwriting newer state: a slow
// older search (or one superseded by a newer search or Clear) resolves after a
// newer request, so we drop its result instead of clobbering the latest one.
async function fetchSearchSection(
  endpoint,
  form,
  setState,
  fallbackFilters,
  { shouldApply = () => true } = {}
) {
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

    if (!shouldApply()) {
      return;
    }

    const results = Array.isArray(payload.results) ? payload.results : [];
    const total = typeof payload.total === "number" ? payload.total : results.length;
    const offset = typeof payload.offset === "number" ? payload.offset : 0;

    setState({
      loading: false,
      error: "",
      results,
      total,
      limit:
        typeof payload.limit === "number" && payload.limit > 0
          ? payload.limit
          : DOCUMENT_RESULTS_PER_PAGE,
      offset,
      hasMore:
        typeof payload.hasMore === "boolean"
          ? payload.hasMore
          : offset + results.length < total,
      filters: payload.filters || fallbackFilters,
    });
  } catch (error) {
    if (!shouldApply()) {
      return;
    }

    setState((currentState) => ({
      ...currentState,
      loading: false,
      error: error.message || "Could not load search results.",
    }));
  }
}

function SectionActions({ loading, onClear }) {
  return (
    <div className="flex flex-wrap gap-3">
      <button
        type="submit"
        disabled={loading}
        className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-600"
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

// Before the user searches, the section is showing a slice of the library — not
// the outcome of a search. The two states are worded differently so a library
// listing can never read as "your search found this many".
function ResultSummary({ searched, paginated, total, offset, resultsOnPage, noun, nounPlural }) {
  if (total === 0) {
    // The empty/no-results message in SectionStatus already says everything.
    return null;
  }

  const summary = (() => {
    if (paginated) {
      const from = offset + 1;
      const to = offset + resultsOnPage;

      return searched
        ? `Showing ${formatCount(from)}–${formatCount(to)} of ${formatCount(total)} ${
            total === 1 ? `${noun} result` : `${noun} results`
          }.`
        : `Showing ${formatCount(from)}–${formatCount(to)} of ${formatCount(total)} ${
            total === 1 ? noun : nounPlural
          } in your library. Search to narrow this list.`;
    }

    return searched
      ? `Found ${formatCount(total)} ${total === 1 ? `${noun} result` : `${noun} results`}.`
      : `Showing all ${formatCount(total)} ${total === 1 ? noun : nounPlural} in your library.`;
  })();

  return (
    <section className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
      {summary}
    </section>
  );
}

// Only rendered once a page has settled, so the buttons never need a loading
// state of their own — the section swaps in its "Loading documents..." status.
function PaginationControls({ limit, offset, total, hasMore, onChangeOffset }) {
  const totalPages = Math.max(1, Math.ceil(total / limit));

  if (totalPages <= 1) {
    return null;
  }

  const currentPage = Math.floor(offset / limit) + 1;
  const hasPrevious = offset > 0;

  return (
    <nav
      aria-label="Document result pages"
      className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3"
    >
      <button
        type="button"
        onClick={() => onChangeOffset(Math.max(0, offset - limit))}
        disabled={!hasPrevious}
        className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
      >
        Previous
      </button>

      <span className="text-sm text-slate-600">
        Page <span className="font-semibold text-slate-900">{formatCount(currentPage)}</span> of{" "}
        <span className="font-semibold text-slate-900">{formatCount(totalPages)}</span>
      </span>

      <button
        type="button"
        onClick={() => onChangeOffset(offset + limit)}
        disabled={!hasMore}
        className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
      >
        Next
      </button>
    </nav>
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
    return <ErrorBanner>{error}</ErrorBanner>;
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

const ASK_RESPONSE_STATUSES = new Set([
  "answered",
  "partial",
  "unverified",
  "not_found",
  "ai_not_configured",
]);
const ASK_INTEGRITY_ERROR =
  "The answer was hidden because its document evidence was missing or inconsistent.";

function askSourceIdentity(value) {
  if (!value || typeof value !== "object") {
    return null;
  }

  const documentId = value.documentId;
  const pageNumber = value.pageNumber;
  const chunkIndex = value.chunkIndex;

  if (
    !Number.isInteger(documentId) ||
    documentId <= 0 ||
    !Number.isInteger(pageNumber) ||
    pageNumber <= 0 ||
    !Number.isInteger(chunkIndex) ||
    chunkIndex < 0
  ) {
    return null;
  }

  return [documentId, pageNumber, chunkIndex].join(":");
}

function askEvidenceId(value) {
  return typeof value?.evidenceId === "string" &&
    /^ask_ev_v1_[a-f0-9]{24}$/.test(value.evidenceId)
    ? value.evidenceId
    : null;
}

function normalizeAskPassages(value, { distinguishSnippets = false } = {}) {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set();
  const passages = [];

  for (const passage of value) {
    const identity = askSourceIdentity(passage);
    const hasName = Boolean(passage?.documentTitle || passage?.originalFilename);
    const snippet = typeof passage?.snippet === "string" ? passage.snippet.trim() : "";
    const fullEvidenceQuote =
      typeof passage?.evidenceQuote === "string" ? passage.evidenceQuote.trim() : "";
    const passageIdentity = distinguishSnippets
      ? [identity, fullEvidenceQuote || snippet].join(":quote:")
      : identity;

    if (!identity || !hasName || !snippet || seen.has(passageIdentity)) {
      continue;
    }

    seen.add(passageIdentity);
    passages.push(passage);
  }

  return passages;
}

function evidenceQuoteMatchesCitation(evidenceQuote, citation) {
  const normalizedQuote =
    typeof evidenceQuote === "string" ? evidenceQuote.replace(/\s+/g, " ").trim() : "";
  const normalizedSnippet =
    typeof citation?.snippet === "string"
      ? citation.snippet.replace(/\s+/g, " ").trim()
      : "";
  const normalizedFullQuote =
    typeof citation?.evidenceQuote === "string"
      ? citation.evidenceQuote.replace(/\s+/g, " ").trim()
      : "";

  if (!normalizedQuote || !normalizedSnippet) {
    return false;
  }

  if (normalizedFullQuote) {
    return normalizedQuote === normalizedFullQuote;
  }

  // Older/legacy responses have only the 220-character preview. It is safe to
  // compare a complete short quote, but a truncated prefix cannot authenticate
  // whatever text follows it, so long evidence without the full field fails.
  return normalizedQuote.length <= 220 && normalizedSnippet === normalizedQuote;
}

function normalizeAskEvidence(value, citations) {
  if (value === undefined || value === null) {
    return { present: false, valid: true, evidence: null };
  }

  if (
    typeof value !== "object" ||
    Array.isArray(value) ||
    !Array.isArray(value.documentSupported) ||
    !Array.isArray(value.generalGuidance) ||
    !Array.isArray(value.gaps)
  ) {
    return { present: true, valid: false, evidence: null };
  }

  const citationsBySource = new Map();

  for (const citation of citations) {
    const identity = askSourceIdentity(citation);

    if (!identity) {
      continue;
    }

    const sourceCitations = citationsBySource.get(identity) || [];
    sourceCitations.push(citation);
    citationsBySource.set(identity, sourceCitations);
  }
  const supported = [];

  for (const item of value.documentSupported) {
    const identity = askSourceIdentity(item);
    const evidenceId = askEvidenceId(item);
    const hasEvidenceId = Object.prototype.hasOwnProperty.call(item || {}, "evidenceId");
    const claim = typeof item?.claim === "string" ? item.claim.trim() : "";
    const evidenceQuote =
      typeof item?.evidenceQuote === "string" ? item.evidenceQuote.trim() : "";
    const citation = identity
      ? (citationsBySource.get(identity) || []).find((candidate) => {
          const citationEvidenceId = askEvidenceId(candidate);
          const hasCitationEvidenceId = Object.prototype.hasOwnProperty.call(
            candidate || {},
            "evidenceId"
          );
          const idsMatch = evidenceId
            ? citationEvidenceId === evidenceId
            : !hasEvidenceId && !hasCitationEvidenceId;

          return idsMatch && evidenceQuoteMatchesCitation(evidenceQuote, candidate);
        })
      : null;

    if (!citation || !claim || !evidenceQuote || (hasEvidenceId && !evidenceId)) {
      return { present: true, valid: false, evidence: null };
    }

    supported.push({
      ...item,
      ...(evidenceId ? { evidenceId } : {}),
      claim,
      evidenceQuote,
      documentId: citation.documentId,
      documentTitle: citation.documentTitle,
      originalFilename: citation.originalFilename,
      pageNumber: citation.pageNumber,
      chunkIndex: citation.chunkIndex,
    });
  }

  const guidance = value.generalGuidance.filter(
    (item) => typeof item === "string" && item.trim()
  );
  const gaps = value.gaps.filter((item) => typeof item === "string" && item.trim());

  if (
    guidance.length !== value.generalGuidance.length ||
    gaps.length !== value.gaps.length
  ) {
    return { present: true, valid: false, evidence: null };
  }

  return {
    present: true,
    valid: true,
    evidence: {
      documentSupported: supported,
      generalGuidance: guidance,
      gaps,
    },
  };
}

function buildEvidenceHistoryContent(evidence) {
  return [
    ...evidence.documentSupported.map((item) => item.claim),
    ...evidence.generalGuidance.map((item) => "General guidance: " + item),
    ...evidence.gaps.map((item) => "Not covered: " + item),
  ].join("\n");
}

// The one control that makes "check the source yourself" actionable.
//
// Every source card gets one: telling the owner to verify a passage while giving
// them no way to reach it is a broken evidence contract. The target is built
// from the server's validated numeric document id and page number only — never
// from a model-supplied title, filename, or label — so no model output can steer
// where this points.
//
// A plain anchor rather than a router Link, matching how the Documents page
// already opens a stored PDF (`window.open('/api/documents/:id/file')`): it opens
// the PDF in a new tab, so the Ask question, answer, and thread are still there
// when the owner comes back. Anchors are focusable and activatable by keyboard
// with no extra handlers.
function AskSourceAction({ source }) {
  const pageNumber =
    Number.isInteger(source?.pageNumber) && source.pageNumber > 0 ? source.pageNumber : null;
  const fileUrl = buildDocumentFileLink(source?.documentId, pageNumber);
  // A response from before this field existed carries no availability verdict;
  // treat that as available rather than hiding a source that is probably fine.
  const isAvailable = source?.documentAvailable !== false;

  if (!fileUrl || !isAvailable) {
    return (
      <p className="mt-3 text-xs font-medium text-slate-500">
        Source unavailable — the PDF for this document is not in your workspace, so it
        cannot be opened here.
      </p>
    );
  }

  const documentName = documentSourceName(source);

  return (
    <a
      href={fileUrl}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={
        pageNumber
          ? `Open ${documentName} at page ${pageNumber} (PDF opens in a new tab)`
          : `Open ${documentName} (PDF opens in a new tab)`
      }
      className="mt-3 inline-flex text-sm font-medium text-sky-700 underline decoration-sky-200 underline-offset-2 hover:text-sky-900"
    >
      {pageNumber ? "Open cited page" : "Open document"}
    </a>
  );
}

function AskCitationCard({ citation }) {
  const documentName = documentSourceName(citation);
  const pageLabel = citation.pageNumber ? `Page ${citation.pageNumber}` : "Page unknown";

  return (
    <article className="rounded-xl border border-slate-200 bg-white p-4 text-sm shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="font-semibold text-slate-900">{documentName}</p>
        {/* Kept visible even when the PDF opens at the page: a viewer that
            ignores the #page fragment leaves the owner to find it by hand. */}
        <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700">
          {pageLabel}
        </span>
      </div>
      <p className="mt-3 leading-6 text-slate-700">{citation.snippet}</p>
      <AskSourceAction source={citation} />
    </article>
  );
}

// One passage card. Shared by the answered-path "Retrieved snippets" list and
// the not-found "Retrieved context" list, which render identical cards under
// different headings.
function AskPassageCard({ passage }) {
  const documentName = documentSourceName(passage);
  const pageLabel = passage.pageNumber ? `page ${passage.pageNumber}` : "page unknown";

  return (
    <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700">
      <p className="font-semibold text-slate-900">
        {documentName}, {pageLabel}
      </p>
      <p className="mt-2 leading-6">{passage.snippet}</p>
      <AskSourceAction source={passage} />
    </div>
  );
}

function AskRetrievedSnippets({ citations }) {
  const snippets = citations.filter((citation) => citation.snippet);

  if (!snippets.length) {
    return null;
  }

  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold text-slate-900">Retrieved snippets</h3>
      <div className="space-y-2">
        {snippets.map((citation) => (
          <AskPassageCard
            key={`snippet-${citation.documentId}-${citation.pageNumber}-${citation.chunkIndex}-${citation.snippet}`}
            passage={citation}
          />
        ))}
      </div>
    </section>
  );
}

// Passages retrieval found when the answer cites nothing. Deliberately worded so
// it can never be mistaken for a sourced answer: these were NOT used to answer,
// and one of them may still be the page the owner needs.
function AskRetrievedContext({ passages }) {
  const snippets = passages.filter((passage) => passage.snippet);

  if (!snippets.length) {
    return null;
  }

  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold text-slate-900">
        Retrieved context (may include passages the answer did not use)
      </h3>
      <p className="text-sm text-slate-600">
        These pages came closest to your question. They were not used to answer it, so check
        them yourself before relying on anything here.
      </p>
      <div className="space-y-2">
        {snippets.map((passage) => (
          <AskPassageCard
            key={`context-${passage.documentId}-${passage.pageNumber}-${passage.chunkIndex}`}
            passage={passage}
          />
        ))}
      </div>
    </section>
  );
}

// Evidence contract rendering (ASK_EVIDENCE_CONTRACT). Three visually distinct
// blocks instead of one prose blob, so a document-supported spec can never be
// mistaken for general advice or vice versa.
function AskEvidence({ evidence }) {
  const supported = Array.isArray(evidence?.documentSupported)
    ? evidence.documentSupported
    : [];
  const guidance = Array.isArray(evidence?.generalGuidance) ? evidence.generalGuidance : [];
  const gaps = Array.isArray(evidence?.gaps) ? evidence.gaps : [];

  if (!supported.length && !guidance.length && !gaps.length) {
    return null;
  }

  return (
    <div className="space-y-4">
      {supported.length ? (
        <section className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-slate-800">
          <h3 className="font-semibold text-emerald-900">From your documents</h3>
          <ul className="mt-2 space-y-3">
            {supported.map((item, index) => (
              <li key={`claim-${index}`}>
                <p className="leading-6">{item.claim}</p>
                {/* The quote is the evidence, shown so the owner can check it
                    rather than trusting the claim. */}
                <p className="mt-1 border-l-2 border-emerald-300 pl-3 text-xs italic text-slate-600">
                  “{item.evidenceQuote}”
                </p>
                <p className="mt-1 text-xs font-semibold uppercase tracking-[0.14em] text-emerald-800">
                  {documentSourceName(item)}, page {item.pageNumber}
                </p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {guidance.length ? (
        <section className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-slate-800">
          <h3 className="font-semibold text-amber-900">
            General guidance — not from your documents
          </h3>
          <ul className="mt-2 list-disc space-y-1 pl-5 leading-6">
            {guidance.map((line, index) => (
              <li key={`guidance-${index}`}>{line}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {gaps.length ? (
        <section className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700">
          <h3 className="font-semibold text-slate-900">Not covered by your documents</h3>
          <ul className="mt-2 list-disc space-y-1 pl-5 leading-6">
            {gaps.map((gap, index) => (
              <li key={`gap-${index}`}>{gap}</li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function AskAssistantMessage({ message }) {
  const citations = Array.isArray(message.citations) ? message.citations : [];
  const evidence = message.evidence || null;
  const retrievedContext = Array.isArray(message.retrievedContext)
    ? message.retrievedContext
    : [];

  // Evidence contract: replaces the single prose blob with labeled channels.
  // "partial" only ever occurs on this path.
  if (evidence && (message.status === "answered" || message.status === "partial")) {
    return (
      <div className="space-y-4">
        <AskEvidence evidence={evidence} />

        {citations.length ? (
          <section className="space-y-3">
            <h3 className="text-sm font-semibold text-slate-900">Sources</h3>
            <div className="grid gap-3 md:grid-cols-2">
              {citations.map((citation) => (
                <AskCitationCard
                  key={`${citation.documentId}-${citation.pageNumber}-${citation.chunkIndex}-${citation.snippet}`}
                  citation={citation}
                />
              ))}
            </div>
          </section>
        ) : null}
      </div>
    );
  }

  if (message.status === "answered") {
    return (
      <div className="space-y-4">
        <section className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
          <p className="font-semibold text-slate-900">Answer</p>
          <p className="mt-2 whitespace-pre-line leading-6">{message.content}</p>
          {message.standaloneQuestion &&
          message.standaloneQuestion !== message.originalQuestion ? (
            <p className="mt-3 text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
              Searched as: {message.standaloneQuestion}
            </p>
          ) : null}
        </section>

        <AskRetrievedSnippets citations={citations} />

        {citations.length ? (
          <section className="space-y-3">
            <h3 className="text-sm font-semibold text-slate-900">Sources</h3>
            <div className="grid gap-3 md:grid-cols-2">
              {citations.map((citation) => (
                <AskCitationCard
                  key={`${citation.documentId}-${citation.pageNumber}-${citation.chunkIndex}-${citation.snippet}`}
                  citation={citation}
                />
              ))}
            </div>
          </section>
        ) : null}
      </div>
    );
  }

  if (message.status === "unverified") {
    return (
      <div className="space-y-4">
        <InfoBanner tone="amber" title="Unverified AI answer — not document-backed">
          This compatibility-mode answer was not checked claim by claim against your uploaded
          documents. Do not treat the retrieved passages below as proof of the answer.
        </InfoBanner>
        <section className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-slate-800">
          <p className="font-semibold text-amber-900">AI answer (not verified)</p>
          <p className="mt-2 whitespace-pre-line leading-6">{message.content}</p>
        </section>
        <AskRetrievedContext passages={retrievedContext} />
      </div>
    );
  }

  if (message.status === "ai_not_configured") {
    return (
      <InfoBanner tone="amber" title="AI not configured">
        {message.content}
      </InfoBanner>
    );
  }

  if (message.status === "not_found") {
    return (
      <div className="space-y-4">
        <InfoBanner title="No answer found">{message.content}</InfoBanner>
        <AskRetrievedContext passages={retrievedContext} />
      </div>
    );
  }

  if (message.status === "error") {
    return <ErrorBanner title="Could not ask documents">{message.content}</ErrorBanner>;
  }

  return null;
}

function AskThread({ messages }) {
  if (!messages.length) {
    return null;
  }

  return (
    // The Ask answer can take 10-30s to arrive; aria-live announces it to
    // screen-reader users instead of leaving them with silence.
    <div className="space-y-4" role="status" aria-live="polite">
      {messages.map((message, index) =>
        message.role === "user" ? (
          <section
            key={`${message.role}-${index}`}
            className="ml-auto max-w-3xl rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-slate-800"
          >
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-sky-700">
              You
            </p>
            <p className="mt-2 leading-6">{message.content}</p>
          </section>
        ) : (
          <section key={`${message.role}-${index}`} className="max-w-4xl">
            <AskAssistantMessage message={message} />
          </section>
        )
      )}
    </div>
  );
}

function AskStatusPanel({ status }) {
  if (!status.message) {
    return null;
  }

  if (status.status === "error") {
    return <ErrorBanner>{status.message}</ErrorBanner>;
  }

  return <InfoBanner announce>{status.message}</InfoBanner>;
}

function buildAskHistory(messages) {
  return messages
    .filter(
      (message) =>
        (message.role === "user" || message.role === "assistant") &&
        message.status !== "error" &&
        message.status !== "unverified" &&
        message.content
    )
    .map((message) => ({
      role: message.role,
      content: message.content,
    }));
}

function AskDocumentsSection() {
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState([]);
  const [askState, setAskState] = useState({
    status: "empty",
    message: "Type a question about your uploaded documents to begin.",
  });
  const [attachments, setAttachments] = useState([]);
  const [selectedAttachmentId, setSelectedAttachmentId] = useState("");

  // Load the saved images so the user can optionally attach one. Ask only ever
  // references an already-saved attachment by id; it never uploads here.
  useEffect(() => {
    let active = true;

    fetchAllImageAttachments()
      .then((items) => {
        if (active) {
          setAttachments(items);
        }
      })
      .catch(() => {
        if (active) {
          setAttachments([]);
        }
      });

    return () => {
      active = false;
    };
  }, []);

  const selectedAttachment = attachments.find(
    (attachment) => String(attachment.id) === selectedAttachmentId
  );

  async function handleSubmit(event) {
    event.preventDefault();

    const trimmedQuestion = question.trim();

    if (!trimmedQuestion) {
      setAskState({
        status: "empty",
        message: "Enter a question before asking.",
      });
      return;
    }

    const history = buildAskHistory(messages);
    const userMessage = {
      role: "user",
      content: trimmedQuestion,
    };

    setMessages((currentMessages) => [...currentMessages, userMessage]);
    setAskState({
      status: "loading",
      message: "Asking your documents...",
    });
    setQuestion("");

    const requestBody = { question: trimmedQuestion, history };

    if (selectedAttachmentId) {
      requestBody.attachmentId = Number(selectedAttachmentId);
    }

    try {
      const response = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || "Could not answer this question.");
      }

      const citations = normalizeAskPassages(payload.citations, {
        distinguishSnippets: true,
      });
      let retrievedContext = normalizeAskPassages(payload.retrievedContext);
      const normalizedEvidence = normalizeAskEvidence(payload.evidence, citations);
      const hasKnownStatus = ASK_RESPONSE_STATUSES.has(payload.status);
      let status = hasKnownStatus ? payload.status : "error";
      let content = hasKnownStatus ? payload.answer || "" : ASK_INTEGRITY_ERROR;
      let evidence = normalizedEvidence.evidence;
      let safeCitations = citations;
      const structuredStatus = status === "answered" || status === "partial";
      const invalidStructuredEvidence =
        !normalizedEvidence.valid ||
        (status === "partial" && !normalizedEvidence.present) ||
        (normalizedEvidence.present &&
          structuredStatus &&
          !normalizedEvidence.evidence?.documentSupported.length);
      const unsupportedLegacyAnswer =
        status === "answered" && !normalizedEvidence.present && !citations.length;
      const legacyAnswerWithRetrievedCitations =
        status === "answered" && !normalizedEvidence.present && citations.length > 0;
      const invalidUnverifiedEvidence = status === "unverified" && normalizedEvidence.present;

      if (invalidStructuredEvidence || unsupportedLegacyAnswer || invalidUnverifiedEvidence) {
        status = "error";
        content = ASK_INTEGRITY_ERROR;
        evidence = null;
        safeCitations = [];
      } else if (legacyAnswerWithRetrievedCitations || status === "unverified") {
        // Older APIs may still call this "answered" and put every retrieved
        // passage in citations. Treat those passages as context only, never as
        // evidence that backs the prose.
        status = "unverified";
        evidence = null;
        safeCitations = [];
        retrievedContext = normalizeAskPassages([...retrievedContext, ...citations]);
      } else if (normalizedEvidence.present && structuredStatus) {
        // Never keep unstructured prose beside a structured response. The safe
        // history is rebuilt from the same verified channels the page renders.
        content = buildEvidenceHistoryContent(normalizedEvidence.evidence);
      }

      setMessages((currentMessages) => [
        ...currentMessages,
        {
          role: "assistant",
          status,
          content,
          originalQuestion: payload.question || trimmedQuestion,
          standaloneQuestion: payload.standaloneQuestion || payload.question || trimmedQuestion,
          citations: safeCitations,
          // Present only when the answer cites nothing (a not-found reply). These
          // are the passages retrieval actually found, so "no answer" does not
          // have to be a dead end.
          retrievedContext,
          // Present only when ASK_EVIDENCE_CONTRACT is on. Null keeps the legacy
          // prose rendering path selected.
          evidence,
        },
      ]);
      setAskState({
        status: "idle",
        message: "",
      });
    } catch (error) {
      setMessages((currentMessages) => [
        ...currentMessages,
        {
          role: "assistant",
          status: "error",
          content: error.message || "Could not answer this question.",
          citations: [],
        },
      ]);
      setAskState({
        status: "idle",
        message: "",
      });
    }
  }

  const isLoading = askState.status === "loading";

  // The page <h1> already names the feature "Ask AI"; this card is titled by its
  // task so the same name does not appear at two heading levels.
  return (
    <SectionCard title="Ask a question">
      {/* Same component the Repair Planner uses, so the two AI features cannot
          drift into differently-worded versions of the same warning. */}
      <AiSafetyNotices disclosure={AI_DISCLOSURE_ASK} />

      <form className="space-y-4" onSubmit={handleSubmit}>
        <label className="grid gap-2 text-sm text-slate-700">
          <span className="font-medium text-slate-900">Question</span>
          <textarea
            className="min-h-24 rounded-xl border border-slate-300 px-3 py-2 outline-none transition focus:border-sky-500"
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder="What is the oil drain plug torque?"
          />
        </label>

        {attachments.length ? (
          <div className="grid gap-2 text-sm text-slate-700">
            <label className="grid gap-2">
              <span className="font-medium text-slate-900">
                Attach a saved photo (optional)
              </span>
              <select
                className="rounded-xl border border-slate-300 px-3 py-2 outline-none transition focus:border-sky-500"
                value={selectedAttachmentId}
                onChange={(event) => setSelectedAttachmentId(event.target.value)}
              >
                <option value="">No photo</option>
                {attachments.map((attachment) => (
                  <option key={attachment.id} value={String(attachment.id)}>
                    {attachment.caption ||
                      attachment.originalFilename ||
                      `Attachment ${attachment.id}`}
                  </option>
                ))}
              </select>
            </label>

            <p className="text-xs text-slate-500">
              The photo helps describe what you see. Specs, torque values, and
              repair steps still come only from your uploaded PDFs.
            </p>

            {selectedAttachment ? (
              <div className="flex items-center gap-3">
                <img
                  src={attachmentFileUrl(selectedAttachment.id)}
                  alt={
                    selectedAttachment.caption ||
                    selectedAttachment.originalFilename ||
                    "Selected photo"
                  }
                  className="h-16 w-16 rounded-lg border border-slate-200 object-cover"
                />
                <button
                  type="button"
                  onClick={() => setSelectedAttachmentId("")}
                  className="text-sm font-medium text-red-700 transition hover:text-red-900"
                >
                  Remove photo
                </button>
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="flex flex-wrap gap-3">
          <button
            type="submit"
            disabled={isLoading}
            className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-600"
          >
            {isLoading ? "Asking..." : "Ask question"}
          </button>
        </div>
      </form>

      <AskThread messages={messages} />
      <AskStatusPanel status={askState} />
    </SectionCard>
  );
}

// One config per entity type drives a shared SearchSection instead of four
// near-identical ~150-line components differing only in endpoint, fields,
// and result card.
//
// Each title says "Search ..." rather than just naming the entity: these cards
// share a page with the Ask AI panel, and a bare "Documents" heading also reads
// as the nav destination of the same name. Keyword search and the AI answer are
// separate features (`/api/search/*` is deterministic SQL and needs no API key)
// that merely share a route, so their headings have to say which is which.
const SEARCH_SECTIONS = [
  {
    key: "documents",
    title: "Search documents",
    endpoint: "/api/search/documents",
    defaultForm: defaultDocumentsForm,
    defaultFilters: defaultDocumentsFilters,
    gridColsClass: "xl:grid-cols-5",
    resultNoun: "document",
    resultNounPlural: "documents",
    emptyMessage: "No documents matched this search.",
    idleEmptyMessage: "No documents in your library yet.",
    // The document library is the one scope that can grow into the thousands,
    // so it is the only section that pages.
    paginated: true,
    ResultCard: DocumentResultCard,
    renderFields({ form, setForm, filters }) {
      return (
        <>
          <TextField
            label="Keyword"
            name="q"
            value={form.q}
            onChange={(event) =>
              setForm((currentForm) => ({ ...currentForm, q: event.target.value }))
            }
            placeholder="spark plug, wiring, torque specs"
          />
          <SelectField
            label="System"
            name="system"
            value={form.system}
            onChange={(event) =>
              setForm((currentForm) => ({ ...currentForm, system: event.target.value }))
            }
            emptyOption="All systems"
            options={toOptions(filters.systems || [])}
          />
          <SelectField
            label="Document type"
            name="documentType"
            value={form.documentType}
            onChange={(event) =>
              setForm((currentForm) => ({ ...currentForm, documentType: event.target.value }))
            }
            emptyOption="All document types"
            options={toOptions(filters.documentTypes || [])}
          />
          <SelectField
            label="Favorite filter"
            name="favorite"
            value={form.favorite}
            onChange={(event) =>
              setForm((currentForm) => ({ ...currentForm, favorite: event.target.value }))
            }
            emptyOption="All documents"
            options={FAVORITE_OPTIONS}
          />
          <SelectField
            label="Bookmark filter"
            name="bookmarked"
            value={form.bookmarked}
            onChange={(event) =>
              setForm((currentForm) => ({ ...currentForm, bookmarked: event.target.value }))
            }
            emptyOption="All documents"
            options={BOOKMARKED_OPTIONS}
          />
          <SelectField
            label="Tag"
            name="tag"
            value={form.tag}
            onChange={(event) =>
              setForm((currentForm) => ({ ...currentForm, tag: event.target.value }))
            }
            emptyOption="All tags"
            options={toOptions(filters.tags || [])}
          />
          <SelectField
            label="Sort"
            name="sort"
            value={form.sort}
            onChange={(event) =>
              setForm((currentForm) => ({ ...currentForm, sort: event.target.value }))
            }
            options={DOCUMENTS_SORT_OPTIONS}
          />
        </>
      );
    },
  },
  {
    key: "symptoms",
    title: "Search symptoms",
    endpoint: "/api/search/symptoms",
    defaultForm: defaultSymptomsForm,
    defaultFilters: defaultSymptomsFilters,
    gridColsClass: "xl:grid-cols-4",
    resultNoun: "symptom",
    resultNounPlural: "symptoms",
    emptyMessage: "No symptoms matched this search.",
    idleEmptyMessage: "No symptoms saved yet.",
    ResultCard: SymptomResultCard,
    renderFields({ form, setForm, filters }) {
      return (
        <>
          <TextField
            label="Keyword"
            name="q"
            value={form.q}
            onChange={(event) =>
              setForm((currentForm) => ({ ...currentForm, q: event.target.value }))
            }
            placeholder="idle, vibration, leak"
          />
          <SelectField
            label="System"
            name="system"
            value={form.system}
            onChange={(event) =>
              setForm((currentForm) => ({ ...currentForm, system: event.target.value }))
            }
            emptyOption="All systems"
            options={toOptions(filters.systems || [])}
          />
          <SelectField
            label="Status"
            name="status"
            value={form.status}
            onChange={(event) =>
              setForm((currentForm) => ({ ...currentForm, status: event.target.value }))
            }
            emptyOption="All statuses"
            options={toOptions(filters.statuses || [])}
          />
          <SelectField
            label="Sort"
            name="sort"
            value={form.sort}
            onChange={(event) =>
              setForm((currentForm) => ({ ...currentForm, sort: event.target.value }))
            }
            options={TITLE_SORT_OPTIONS}
          />
        </>
      );
    },
  },
  {
    key: "procedures",
    title: "Search procedures",
    endpoint: "/api/search/procedures",
    defaultForm: defaultProceduresForm,
    defaultFilters: defaultProceduresFilters,
    gridColsClass: "xl:grid-cols-4",
    resultNoun: "procedure",
    resultNounPlural: "procedures",
    emptyMessage: "No procedures matched this search.",
    idleEmptyMessage: "No procedures saved yet.",
    ResultCard: ProcedureResultCard,
    renderFields({ form, setForm, filters }) {
      return (
        <>
          <TextField
            label="Keyword"
            name="q"
            value={form.q}
            onChange={(event) =>
              setForm((currentForm) => ({ ...currentForm, q: event.target.value }))
            }
            placeholder="cleaning, inspection, replacement"
          />
          <SelectField
            label="System"
            name="system"
            value={form.system}
            onChange={(event) =>
              setForm((currentForm) => ({ ...currentForm, system: event.target.value }))
            }
            emptyOption="All systems"
            options={toOptions(filters.systems || [])}
          />
          <SelectField
            label="Difficulty"
            name="difficulty"
            value={form.difficulty}
            onChange={(event) =>
              setForm((currentForm) => ({ ...currentForm, difficulty: event.target.value }))
            }
            emptyOption="All difficulties"
            options={toOptions(filters.difficulties || [])}
          />
          <SelectField
            label="Sort"
            name="sort"
            value={form.sort}
            onChange={(event) =>
              setForm((currentForm) => ({ ...currentForm, sort: event.target.value }))
            }
            options={TITLE_SORT_OPTIONS}
          />
        </>
      );
    },
  },
  {
    key: "notes",
    title: "Search notes",
    endpoint: "/api/search/notes",
    defaultForm: defaultNotesForm,
    defaultFilters: defaultNotesFilters,
    gridColsClass: "xl:grid-cols-4",
    resultNoun: "note",
    resultNounPlural: "notes",
    emptyMessage: "No notes matched this search.",
    idleEmptyMessage: "No notes saved yet.",
    ResultCard: NoteResultCard,
    renderFields({ form, setForm, filters }) {
      return (
        <>
          <TextField
            label="Keyword"
            name="q"
            value={form.q}
            onChange={(event) =>
              setForm((currentForm) => ({ ...currentForm, q: event.target.value }))
            }
            placeholder="observation, reminder, repair log"
          />
          <SelectField
            label="Note type"
            name="noteType"
            value={form.noteType}
            onChange={(event) =>
              setForm((currentForm) => ({ ...currentForm, noteType: event.target.value }))
            }
            emptyOption="All note types"
            options={toOptions(filters.noteTypes || [])}
          />
          <SelectField
            label="Linked item type"
            name="relatedEntityType"
            value={form.relatedEntityType}
            onChange={(event) =>
              setForm((currentForm) => ({
                ...currentForm,
                relatedEntityType: event.target.value,
              }))
            }
            emptyOption="All link types"
            options={toOptions(filters.relatedEntityTypes || [])}
          />
          <SelectField
            label="Sort"
            name="sort"
            value={form.sort}
            onChange={(event) =>
              setForm((currentForm) => ({ ...currentForm, sort: event.target.value }))
            }
            options={NEWEST_OLDEST_SORT_OPTIONS}
          />
        </>
      );
    },
  },
];

function SearchSection({ config }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const [state, setState] = useState(createSectionState(config.defaultFilters));
  const requestSeq = useRef(0);
  const ResultCard = config.ResultCard;
  const pageKey = sectionParamKey(config, "page");

  // The URL holds the search that produced the visible results; `form` is only
  // the draft in the input boxes. Paging therefore uses the URL rather than the
  // draft, so edits the owner has not submitted yet still cannot be applied to
  // page 2 of an older query -- the invariant the old `appliedForm` protected,
  // now enforced by where the value lives.
  const appliedForm = readSectionForm(searchParams, config);
  const appliedQuery = buildQueryString(appliedForm);
  const [form, setForm] = useState(appliedForm);

  // A card counts as "searched" when the URL carries any of its form
  // parameters. `page` is deliberately excluded: paging through the library
  // listing is not a search, and counting it as one would swap the summary copy
  // from "in your library" to "results" just for pressing Next.
  const searched = Object.keys(config.defaultForm).some((field) =>
    searchParams.has(sectionParamKey(config, field))
  );

  const currentPage = config.paginated ? readPageParam(searchParams, pageKey) : 1;
  const requestOffset = (currentPage - 1) * DOCUMENT_RESULTS_PER_PAGE;
  const requestForm = config.paginated
    ? {
        ...appliedForm,
        limit: String(DOCUMENT_RESULTS_PER_PAGE),
        offset: requestOffset > 0 ? String(requestOffset) : "",
      }
    : appliedForm;
  // The exact query the endpoint will be called with, and the only thing the
  // fetch effect depends on: one request per distinct search, whether the URL
  // changed because of a submit, a page button, Back, or a pasted link.
  const requestQuery = buildQueryString(requestForm);

  const updateSectionParams = useCallback(
    (updates, { replace = false } = {}) => {
      setSearchParams((currentParams) => applyParamUpdates(currentParams, updates), {
        replace,
      });
    },
    [setSearchParams]
  );

  // Re-sync the draft when the URL's search changes underneath it -- Back,
  // Forward, Clear, or a pasted link. Keyed on the serialized query rather than
  // the form object so it fires on real changes only, not on every render.
  useEffect(() => {
    const appliedParams = new URLSearchParams(appliedQuery);
    const nextForm = {};

    Object.entries(config.defaultForm).forEach(([field, defaultValue]) => {
      nextForm[field] = appliedParams.get(field) ?? defaultValue;
    });

    setForm(nextForm);
  }, [appliedQuery, config]);

  // Every request bumps the sequence, so a slow reply for an older query *or an
  // older page* is dropped instead of replacing newer results.
  useEffect(() => {
    const seq = (requestSeq.current += 1);

    fetchSearchSection(config.endpoint, requestForm, setState, config.defaultFilters, {
      shouldApply: () => seq === requestSeq.current,
    });
    // `requestQuery` is the serialization of `requestForm`, so the string is
    // the whole dependency -- listing the object too would re-fetch on every
    // render, since it is rebuilt each time.
  }, [requestQuery, config]);

  // Normalization only, so it replaces: a `page` past the end of the results --
  // or a hand-typed `page=abc` -- should not leave a history entry behind.
  useEffect(() => {
    if (!config.paginated || state.loading || state.error) {
      return;
    }

    const lastPage = Math.max(1, Math.ceil(state.total / state.limit));
    const canonicalPage = pageParamValue(Math.min(currentPage, lastPage));

    if ((searchParams.get(pageKey) ?? null) !== canonicalPage) {
      updateSectionParams({ [pageKey]: canonicalPage }, { replace: true });
    }
  }, [
    config.paginated,
    state.loading,
    state.error,
    state.total,
    state.limit,
    currentPage,
    pageKey,
    searchParams,
    updateSectionParams,
  ]);

  const hasKeyword = appliedForm.q.trim().length > 0;

  function handleSubmit(event) {
    event.preventDefault();
    // Submitting is a navigation step, so it pushes -- and a new query or
    // filter set always restarts at the first page.
    updateSectionParams({ ...sectionFormUpdates(form, config), [pageKey]: null });
  }

  function handleClear() {
    updateSectionParams(clearSectionUpdates(config));
  }

  return (
    <SectionCard title={config.title}>
      <form className="space-y-4" onSubmit={handleSubmit}>
        <div className={`grid gap-4 md:grid-cols-2 ${config.gridColsClass}`}>
          {config.renderFields({ form, setForm, filters: state.filters })}
        </div>

        <SectionActions loading={state.loading} onClear={handleClear} />
      </form>

      {!state.loading && !state.error ? (
        <ResultSummary
          searched={searched}
          paginated={Boolean(config.paginated)}
          total={state.total}
          offset={state.offset}
          resultsOnPage={state.results.length}
          noun={config.resultNoun}
          nounPlural={config.resultNounPlural}
        />
      ) : null}

      <SectionStatus
        loading={state.loading}
        error={state.error}
        total={state.total}
        label={config.resultNounPlural}
        emptyMessage={searched ? config.emptyMessage : config.idleEmptyMessage}
      />

      {!state.loading && !state.error && state.results.length
        ? state.results.map((result) => (
            <ResultCard key={result.id} result={result} showSnippetReason={hasKeyword} />
          ))
        : null}

      {config.paginated && !state.loading && !state.error ? (
        <PaginationControls
          limit={state.limit}
          offset={state.offset}
          total={state.total}
          hasMore={state.hasMore}
          // Changing page is a navigation step, so it pushes. The page number
          // is derived from the offset the server echoed back, so Previous/Next
          // move relative to the page actually on screen.
          onChangeOffset={(nextOffset) =>
            updateSectionParams({
              [pageKey]: pageParamValue(Math.floor(nextOffset / state.limit) + 1),
            })
          }
        />
      ) : null}
    </SectionCard>
  );
}

export function SearchPage() {
  return (
    <>
      {/* The heading matches the nav item that routes here. The description has
          to cover both halves of the page: the old one described only the
          search sections, which left the AI panel above them unnamed. */}
      <PageHeader
        title="Ask AI"
        description="Ask a question and get an answer built only from your uploaded PDFs, or search documents, symptoms, procedures, and notes from the same page."
      />

      <div className="space-y-6">
        <AskDocumentsSection />
        {SEARCH_SECTIONS.map((config) => (
          <SearchSection key={config.key} config={config} />
        ))}
      </div>
    </>
  );
}
