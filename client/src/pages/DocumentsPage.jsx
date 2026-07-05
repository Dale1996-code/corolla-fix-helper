import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { PageHeader } from "../components/PageHeader";
import { formatDate, getSortTimestamp } from "../lib/formatDate";
import { mergeSuggestionValues } from "../lib/suggestionUtils";
import {
  getDocumentTags,
  normalizeExtractionStatus,
} from "../components/documents/documentDisplay";
import { TagChips } from "../components/documents/TagChips";
import { ListControls } from "../components/documents/ListControls";
import { DocumentsList } from "../components/documents/DocumentsList";

const emptyUploadForm = {
  pdfFile: null,
  title: "",
  system: "",
  subsystem: "",
  documentType: "",
  source: "",
  notes: "",
  tags: "",
  isBookmarked: false,
};

const emptyEditForm = {
  title: "",
  system: "",
  subsystem: "",
  documentType: "",
  source: "",
  notes: "",
  isFavorite: false,
  isBookmarked: false,
  tags: "",
};

const emptyDocumentDefaults = {
  commonSystems: [],
  documentTypes: [],
};

function normalizeFavoriteFilter(value) {
  if (value === "favorites_only" || value === "not_favorites") {
    return value;
  }

  return "all";
}

function normalizeBookmarkFilter(value) {
  if (value === "bookmarked_only" || value === "not_bookmarked") {
    return value;
  }

  return "all";
}

function TextField({
  label,
  name,
  value,
  onChange,
  required = false,
  placeholder = "",
  listId = "",
}) {
  return (
    <label className="grid gap-2 text-sm text-slate-700">
      <span className="font-medium text-slate-900">
        {label}
        {required ? " *" : ""}
      </span>
      <input
        className="rounded-lg border border-slate-300 bg-white px-3 py-2 outline-none transition focus:border-sky-500 focus:ring-2 focus:ring-sky-100"
        name={name}
        value={value}
        onChange={onChange}
        required={required}
        placeholder={placeholder}
        list={listId || undefined}
      />
    </label>
  );
}

function TextAreaField({ label, name, value, onChange, placeholder = "" }) {
  return (
    <label className="grid gap-2 text-sm text-slate-700">
      <span className="font-medium text-slate-900">{label}</span>
      <textarea
        className="min-h-24 rounded-lg border border-slate-300 bg-white px-3 py-2 outline-none transition focus:border-sky-500 focus:ring-2 focus:ring-sky-100"
        name={name}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
      />
    </label>
  );
}

function SuggestionDatalist({ id, options }) {
  if (!options.length) {
    return null;
  }

  return (
    <datalist id={id}>
      {options.map((option) => (
        <option key={option} value={option} />
      ))}
    </datalist>
  );
}

function UploadForm({
  form,
  uploading,
  feedback,
  error,
  isOpen,
  onToggleOpen,
  systemSuggestions,
  documentTypeSuggestions,
  onFileChange,
  onTextChange,
  onSubmit,
}) {
  return (
    <section
      id="document-upload"
      className="overflow-hidden rounded-lg border border-slate-300 bg-white shadow-sm"
    >
      <button
        type="button"
        onClick={onToggleOpen}
        aria-expanded={isOpen}
        aria-controls="document-upload-panel"
        className={`flex w-full flex-wrap items-center justify-between gap-3 bg-slate-50 px-5 py-4 text-left transition hover:bg-slate-100 ${
          isOpen ? "border-b border-slate-200" : ""
        }`}
      >
        <div>
          <h3 className="text-lg font-semibold text-slate-950">Import PDF</h3>
          <p className="mt-1 text-sm text-slate-600">
            Upload one document at a time, then review status and fix details if needed
          </p>
        </div>
        <span className="flex items-center gap-3">
          <span className="rounded-full border border-sky-200 bg-sky-50 px-3 py-1 text-xs font-semibold text-sky-900">
            PDF up to 20 MB
          </span>
          <svg
            viewBox="0 0 20 20"
            fill="currentColor"
            aria-hidden="true"
            className={`h-5 w-5 shrink-0 text-slate-500 transition-transform ${
              isOpen ? "rotate-180" : ""
            }`}
          >
            <path
              fillRule="evenodd"
              d="M5.23 7.21a.75.75 0 0 1 1.06.02L10 11.06l3.71-3.83a.75.75 0 1 1 1.08 1.04l-4.25 4.39a.75.75 0 0 1-1.08 0L5.21 8.27a.75.75 0 0 1 .02-1.06Z"
              clipRule="evenodd"
            />
          </svg>
        </span>
      </button>

      {isOpen ? (
        <form id="document-upload-panel" className="grid gap-5 p-5" onSubmit={onSubmit}>
          <div className="grid gap-4 rounded-lg border border-slate-200 bg-slate-50 p-4 sm:flex sm:items-center sm:justify-between">
            <div className="grid gap-2 text-sm text-slate-700">
              <label className="font-medium text-slate-900" htmlFor="document-upload-file">
                PDF file *
              </label>
              <input
                id="document-upload-file"
                type="file"
                accept="application/pdf,.pdf"
                onChange={onFileChange}
                required
                className="peer sr-only"
              />
              <div className="flex flex-wrap items-center gap-3">
                <label
                  htmlFor="document-upload-file"
                  className="inline-flex cursor-pointer items-center justify-center rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-800 shadow-sm transition hover:border-slate-400 hover:bg-slate-100 peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-sky-500"
                >
                  Choose PDF
                </label>
                {form.pdfFile ? (
                  <span className="min-w-0 truncate text-sm text-slate-600">
                    {form.pdfFile.name}
                  </span>
                ) : (
                  <span className="text-sm text-slate-500">No file chosen</span>
                )}
              </div>
            </div>

            <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
              <input
                type="checkbox"
                name="isBookmarked"
                checked={form.isBookmarked}
                onChange={onTextChange}
              />
              Bookmark this document
            </label>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <TextField
              label="Title"
              name="title"
              value={form.title}
              onChange={onTextChange}
              placeholder="Optional manual title"
            />
            <TextField
              label="System"
              name="system"
              value={form.system}
              onChange={onTextChange}
              required
              placeholder="Engine, Brakes, Electrical..."
              listId="upload-system-suggestions"
            />
            <TextField
              label="Subsystem"
              name="subsystem"
              value={form.subsystem}
              onChange={onTextChange}
              placeholder="Ignition, Cooling..."
            />
            <TextField
              label="Document Type"
              name="documentType"
              value={form.documentType}
              onChange={onTextChange}
              required
              placeholder="Repair Manual, Wiring Diagram..."
              listId="upload-document-type-suggestions"
            />
            <TextField
              label="Source"
              name="source"
              value={form.source}
              onChange={onTextChange}
              placeholder="Toyota manual, forum download..."
            />
          </div>

          <TextField
            label="Tags"
            name="tags"
            value={form.tags}
            onChange={onTextChange}
            placeholder="Comma separated, e.g. brakes, torque-specs, diy"
          />

          <TextAreaField
            label="Notes"
            name="notes"
            value={form.notes}
            onChange={onTextChange}
            placeholder="Any quick notes about this document"
          />

          {feedback ? (
            <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
              {feedback}
            </p>
          ) : null}

          {error ? (
            <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </p>
          ) : null}

          <div className="flex flex-wrap items-center gap-3 border-t border-slate-200 pt-4">
            <button
              type="submit"
              disabled={uploading}
              className="rounded-lg bg-slate-950 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-400"
            >
              {uploading ? "Uploading..." : "Upload PDF"}
            </button>
            <p className="text-xs text-slate-500">Suggestions appear from Settings while typing.</p>
          </div>

          <SuggestionDatalist id="upload-system-suggestions" options={systemSuggestions} />
          <SuggestionDatalist
            id="upload-document-type-suggestions"
            options={documentTypeSuggestions}
          />
        </form>
      ) : null}
    </section>
  );
}

function EditMetadataForm({
  values,
  onChange,
  onSubmit,
  onCancel,
  saving,
  systemSuggestions,
  documentTypeSuggestions,
}) {
  return (
    <form className="mt-4 grid gap-4 rounded-lg border border-slate-200 bg-slate-50 p-4" onSubmit={onSubmit}>
      <div className="grid gap-4 md:grid-cols-2">
        <TextField label="Title" name="title" value={values.title} onChange={onChange} required />
        <TextField
          label="System"
          name="system"
          value={values.system}
          onChange={onChange}
          required
          listId="edit-system-suggestions"
        />
        <TextField
          label="Subsystem"
          name="subsystem"
          value={values.subsystem}
          onChange={onChange}
        />
        <TextField
          label="Document Type"
          name="documentType"
          value={values.documentType}
          onChange={onChange}
          required
          listId="edit-document-type-suggestions"
        />
        <TextField label="Source" name="source" value={values.source} onChange={onChange} />
      </div>

      <TextField
        label="Tags"
        name="tags"
        value={values.tags}
        onChange={onChange}
        placeholder="Comma separated, e.g. brakes, torque-specs, diy"
      />

      <TextAreaField label="Document notes" name="notes" value={values.notes} onChange={onChange} />

      <div className="flex flex-wrap gap-4">
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            name="isFavorite"
            checked={values.isFavorite}
            onChange={onChange}
          />
          Mark this document as favorite
        </label>

        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            name="isBookmarked"
            checked={values.isBookmarked}
            onChange={onChange}
          />
          Bookmark this document
        </label>
      </div>

      <div className="flex flex-wrap gap-3">
        <button
          type="submit"
          disabled={saving}
          className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-sky-500 disabled:cursor-not-allowed disabled:bg-sky-300"
        >
          {saving ? "Saving..." : "Save metadata"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-100"
        >
          Cancel
        </button>
      </div>

      <SuggestionDatalist id="edit-system-suggestions" options={systemSuggestions} />
      <SuggestionDatalist
        id="edit-document-type-suggestions"
        options={documentTypeSuggestions}
      />
    </form>
  );
}

function DocumentDetails({
  document,
  isEditing,
  editValues,
  saveState,
  extractionRunState,
  bookmarkUpdateState,
  systemSuggestions,
  documentTypeSuggestions,
  onStartEdit,
  onCancelEdit,
  onEditChange,
  onSaveEdit,
  onOpenFile,
  onToggleFavorite,
  onToggleBookmark,
  onRerunExtraction,
  onDeleteDocument,
}) {
  if (!document) {
    return (
      <section className="rounded-lg border border-slate-300 bg-white p-6 text-sm text-slate-600 shadow-sm">
        Select a document to view details.
      </section>
    );
  }

  const extraction = normalizeExtractionStatus(document.extractionStatus);

  return (
    <section className="rounded-lg border border-slate-300 bg-white p-6 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-xl font-semibold text-slate-900">{document.title}</h3>
          <p className="mt-1 text-sm text-slate-500">{document.originalFilename}</p>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => onOpenFile(document.id)}
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100"
          >
            Open file
          </button>
          <button
            type="button"
            onClick={() => onToggleFavorite(document)}
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100"
          >
            {document.isFavorite ? "Unfavorite" : "Favorite"}
          </button>
          <button
            type="button"
            onClick={() => onToggleBookmark(document)}
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100"
          >
            {document.isBookmarked ? "Remove bookmark" : "Bookmark"}
          </button>
          <button
            type="button"
            onClick={() => onStartEdit(document)}
            className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-700"
          >
            Edit metadata
          </button>
          <button
            type="button"
            onClick={() => onRerunExtraction(document.id)}
            disabled={extractionRunState.running}
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {extractionRunState.running ? "Re-running..." : "Re-run extraction"}
          </button>
          <button
            type="button"
            onClick={() => onDeleteDocument(document)}
            className="rounded-lg border border-red-300 px-3 py-2 text-sm font-semibold text-red-700 transition hover:bg-red-50"
          >
            Delete document
          </button>
        </div>
      </div>

      <dl className="mt-5 grid gap-3 text-sm md:grid-cols-2">
        <div>
          <dt className="font-semibold text-slate-900">System</dt>
          <dd className="text-slate-700">{document.system}</dd>
        </div>
        <div>
          <dt className="font-semibold text-slate-900">Subsystem</dt>
          <dd className="text-slate-700">{document.subsystem || "Not set"}</dd>
        </div>
        <div>
          <dt className="font-semibold text-slate-900">Document type</dt>
          <dd className="text-slate-700">{document.documentType}</dd>
        </div>
        <div>
          <dt className="font-semibold text-slate-900">Source</dt>
          <dd className="text-slate-700">{document.source || "Not set"}</dd>
        </div>
        <div>
          <dt className="font-semibold text-slate-900">Page count</dt>
          <dd className="text-slate-700">{document.pageCount ?? "Unknown"}</dd>
        </div>
        <div>
          <dt className="font-semibold text-slate-900">Extraction status</dt>
          <dd>
            <span className={`rounded-full px-2 py-1 text-xs font-semibold ${extraction.className}`}>
              {extraction.label}
            </span>
          </dd>
        </div>
        <div>
          <dt className="font-semibold text-slate-900">Original filename</dt>
          <dd className="break-all text-slate-700">{document.originalFilename}</dd>
        </div>
        <div>
          <dt className="font-semibold text-slate-900">Stored filename</dt>
          <dd className="break-all text-slate-700">{document.storedFilename || "Not available"}</dd>
        </div>
        <div>
          <dt className="font-semibold text-slate-900">Date added</dt>
          <dd className="text-slate-700">{formatDate(document.createdAt)}</dd>
        </div>
        <div>
          <dt className="font-semibold text-slate-900">Last updated</dt>
          <dd className="text-slate-700">{formatDate(document.updatedAt)}</dd>
        </div>
      </dl>

      {document.extractionStatus?.startsWith("failed") ? (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          <p className="font-semibold">Extraction error details</p>
          <p className="mt-1">{document.extractionStatus}</p>
        </div>
      ) : null}

      <div className="mt-5 flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold text-slate-900">Saved flags:</span>
        <span
          className={`rounded-full px-2 py-1 text-xs font-semibold ${
            document.isFavorite ? "bg-amber-100 text-amber-800" : "bg-slate-100 text-slate-600"
          }`}
        >
          {document.isFavorite ? "Favorite" : "Not favorite"}
        </span>
        <span
          className={`rounded-full px-2 py-1 text-xs font-semibold ${
            document.isBookmarked ? "bg-sky-100 text-sky-800" : "bg-slate-100 text-slate-600"
          }`}
        >
          {document.isBookmarked ? "Bookmarked" : "Not bookmarked"}
        </span>
        {bookmarkUpdateState?.documentId === document.id && bookmarkUpdateState?.error ? (
          <span className="text-xs text-red-700">{bookmarkUpdateState.error}</span>
        ) : null}
      </div>

      <div className="mt-4">
        <h4 className="text-sm font-semibold text-slate-900">Tags</h4>
        <div className="mt-2">
          {getDocumentTags(document).length ? (
            <TagChips tags={getDocumentTags(document)} />
          ) : (
            <p className="text-sm text-slate-600">No tags yet.</p>
          )}
        </div>
      </div>

      <div className="mt-4">
        <h4 className="text-sm font-semibold text-slate-900">Document notes</h4>
        <p className="mt-2 whitespace-pre-wrap text-sm text-slate-700">
          {document.notes || "No notes yet."}
        </p>
      </div>

      {isEditing ? (
        <EditMetadataForm
          values={editValues}
          onChange={onEditChange}
          onSubmit={onSaveEdit}
          onCancel={onCancelEdit}
          saving={saveState.saving}
          systemSuggestions={systemSuggestions}
          documentTypeSuggestions={documentTypeSuggestions}
        />
      ) : null}

      {saveState.message ? (
        <p className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          {saveState.message}
        </p>
      ) : null}

      {saveState.error ? (
        <p className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {saveState.error}
        </p>
      ) : null}
      {extractionRunState.message ? (
        <p className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          {extractionRunState.message}
        </p>
      ) : null}
      {extractionRunState.error ? (
        <p className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {extractionRunState.error}
        </p>
      ) : null}
    </section>
  );
}

export function DocumentsPage() {
  const [searchParams] = useSearchParams();
  const [documents, setDocuments] = useState([]);
  const [documentDefaults, setDocumentDefaults] = useState(emptyDocumentDefaults);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const [uploadForm, setUploadForm] = useState(emptyUploadForm);
  const [uploading, setUploading] = useState(false);
  const [uploadFeedback, setUploadFeedback] = useState("");
  const [uploadError, setUploadError] = useState("");
  // Import is collapsed by default so the library (the reason to visit this
  // page) is visible immediately; open it when arriving via the dashboard's
  // "#document-upload" quick action.
  const [isUploadOpen, setIsUploadOpen] = useState(
    () => typeof window !== "undefined" && window.location.hash === "#document-upload"
  );

  const [sortBy, setSortBy] = useState("newest");
  const [systemFilter, setSystemFilter] = useState("all");
  const [documentTypeFilter, setDocumentTypeFilter] = useState("all");
  const requestedDocumentIdValue = Number(searchParams.get("documentId"));
  const requestedDocumentId =
    Number.isInteger(requestedDocumentIdValue) && requestedDocumentIdValue > 0
      ? requestedDocumentIdValue
      : null;
  const requestedFavoriteFilter = normalizeFavoriteFilter(searchParams.get("favorite"));
  const [favoriteFilter, setFavoriteFilter] = useState(requestedFavoriteFilter);
  const requestedBookmarkFilter = normalizeBookmarkFilter(searchParams.get("bookmark"));
  const [bookmarkFilter, setBookmarkFilter] = useState(requestedBookmarkFilter);
  const requestedTagFilter = searchParams.get("tag") || "all";
  const [tagFilter, setTagFilter] = useState(requestedTagFilter);

  const [page, setPage] = useState(1);
  const [selectedDocumentId, setSelectedDocumentId] = useState(null);
  const [editingDocumentId, setEditingDocumentId] = useState(null);
  const [editForm, setEditForm] = useState(emptyEditForm);
  const [saveState, setSaveState] = useState({
    documentId: null,
    saving: false,
    message: "",
    error: "",
  });
  const [favoriteUpdateState, setFavoriteUpdateState] = useState({
    documentId: null,
    error: "",
  });
  const [bookmarkUpdateState, setBookmarkUpdateState] = useState({
    documentId: null,
    error: "",
  });
  const [extractionRunState, setExtractionRunState] = useState({
    documentId: null,
    running: false,
    message: "",
    error: "",
  });

  const systems = useMemo(() => {
    return Array.from(
      new Set(documents.map((document) => document.system).filter(Boolean))
    ).sort((a, b) => a.localeCompare(b));
  }, [documents]);

  const documentTypes = useMemo(() => {
    return Array.from(
      new Set(documents.map((document) => document.documentType).filter(Boolean))
    ).sort((a, b) => a.localeCompare(b));
  }, [documents]);

  const availableTags = useMemo(() => {
    return Array.from(
      new Set(documents.flatMap((document) => getDocumentTags(document)))
    ).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  }, [documents]);

  const systemSuggestions = useMemo(() => {
    return mergeSuggestionValues([
      ...documentDefaults.commonSystems,
      ...documents.map((document) => document.system),
    ]);
  }, [documentDefaults.commonSystems, documents]);

  const documentTypeSuggestions = useMemo(() => {
    return mergeSuggestionValues([
      ...documentDefaults.documentTypes,
      ...documents.map((document) => document.documentType),
    ]);
  }, [documentDefaults.documentTypes, documents]);

  const selectedDocument = useMemo(() => {
    if (!selectedDocumentId) {
      return null;
    }

    return documents.find((document) => document.id === selectedDocumentId) || null;
  }, [documents, selectedDocumentId]);

  const filteredDocuments = useMemo(() => {
    const nextDocuments = documents.filter((document) => {
      if (systemFilter !== "all" && document.system !== systemFilter) {
        return false;
      }

      if (
        documentTypeFilter !== "all" &&
        document.documentType !== documentTypeFilter
      ) {
        return false;
      }

      if (favoriteFilter === "favorites_only" && !document.isFavorite) {
        return false;
      }

      if (favoriteFilter === "not_favorites" && document.isFavorite) {
        return false;
      }

      if (bookmarkFilter === "bookmarked_only" && !document.isBookmarked) {
        return false;
      }

      if (bookmarkFilter === "not_bookmarked" && document.isBookmarked) {
        return false;
      }

      if (
        tagFilter !== "all" &&
        !getDocumentTags(document).some(
          (tag) => tag.toLowerCase() === tagFilter.toLowerCase()
        )
      ) {
        return false;
      }

      return true;
    });

    nextDocuments.sort((firstDocument, secondDocument) => {
      if (sortBy === "title_asc") {
        return firstDocument.title.localeCompare(secondDocument.title, undefined, {
          sensitivity: "base",
        });
      }

      const firstTime = getSortTimestamp(firstDocument);
      const secondTime = getSortTimestamp(secondDocument);

      if (sortBy === "oldest") {
        return firstTime - secondTime;
      }

      return secondTime - firstTime;
    });

    return nextDocuments;
  }, [
    documents,
    sortBy,
    systemFilter,
    documentTypeFilter,
    favoriteFilter,
    bookmarkFilter,
    tagFilter,
  ]);

  // Show the documents in fixed-size pages so a large library stays scannable.
  const DOCUMENTS_PER_PAGE = 25;
  const totalPages = Math.max(
    1,
    Math.ceil(filteredDocuments.length / DOCUMENTS_PER_PAGE)
  );
  const currentPage = Math.min(page, totalPages);
  const pagedDocuments = useMemo(() => {
    const start = (currentPage - 1) * DOCUMENTS_PER_PAGE;
    return filteredDocuments.slice(start, start + DOCUMENTS_PER_PAGE);
  }, [filteredDocuments, currentPage]);

  // Reset to the first page whenever the filtered set changes underneath us.
  useEffect(() => {
    setPage(1);
  }, [
    sortBy,
    systemFilter,
    documentTypeFilter,
    favoriteFilter,
    bookmarkFilter,
    tagFilter,
  ]);

  async function loadDocuments() {
    try {
      setLoadError("");
      setLoading(true);

      const response = await fetch("/api/documents");
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || "Could not load documents.");
      }

      const nextDocuments = Array.isArray(payload.documents) ? payload.documents : [];
      setDocuments(nextDocuments);

      if (nextDocuments.length === 0) {
        setSelectedDocumentId(null);
        setEditingDocumentId(null);
        return;
      }

      setSelectedDocumentId((currentSelectedId) => {
        if (
          requestedDocumentId &&
          nextDocuments.some((document) => document.id === requestedDocumentId)
        ) {
          return requestedDocumentId;
        }

        if (
          currentSelectedId &&
          nextDocuments.some((document) => document.id === currentSelectedId)
        ) {
          return currentSelectedId;
        }

        return nextDocuments[0].id;
      });

      setEditingDocumentId((currentEditingId) => {
        if (
          currentEditingId &&
          nextDocuments.some((document) => document.id === currentEditingId)
        ) {
          return currentEditingId;
        }

        return null;
      });
    } catch (error) {
      setLoadError(error.message || "Could not load documents.");
    } finally {
      setLoading(false);
    }
  }

  async function loadDocumentDefaults() {
    try {
      const response = await fetch("/api/settings");
      const payload = await response.json();

      if (!response.ok) {
        return;
      }

      setDocumentDefaults({
        commonSystems: payload.documentDefaults?.commonSystems || [],
        documentTypes: payload.documentDefaults?.documentTypes || [],
      });
    } catch {
      setDocumentDefaults(emptyDocumentDefaults);
    }
  }

  useEffect(() => {
    loadDocuments();
    loadDocumentDefaults();
  }, []);

  useEffect(() => {
    setFavoriteFilter(requestedFavoriteFilter);
  }, [requestedFavoriteFilter]);

  useEffect(() => {
    setBookmarkFilter(requestedBookmarkFilter);
  }, [requestedBookmarkFilter]);

  useEffect(() => {
    setTagFilter(requestedTagFilter);
  }, [requestedTagFilter]);

  function handleUploadFileChange(event) {
    const nextFile = event.target.files?.[0] || null;

    setUploadForm((currentForm) => ({
      ...currentForm,
      pdfFile: nextFile,
    }));
  }

  function handleUploadTextChange(event) {
    const { name, type, checked, value } = event.target;

    setUploadForm((currentForm) => ({
      ...currentForm,
      [name]: type === "checkbox" ? checked : value,
    }));
  }

  async function handleUploadSubmit(event) {
    event.preventDefault();

    if (!uploadForm.pdfFile) {
      setUploadError("Please choose a PDF before uploading.");
      return;
    }

    const formData = new FormData();
    formData.append("pdfFile", uploadForm.pdfFile);
    formData.append("title", uploadForm.title);
    formData.append("system", uploadForm.system);
    formData.append("subsystem", uploadForm.subsystem);
    formData.append("documentType", uploadForm.documentType);
    formData.append("source", uploadForm.source);
    formData.append("notes", uploadForm.notes);
    formData.append("tags", uploadForm.tags);
    formData.append("isBookmarked", uploadForm.isBookmarked ? "true" : "false");

    try {
      setUploading(true);
      setUploadError("");
      setUploadFeedback("");

      const response = await fetch("/api/documents/upload", {
        method: "POST",
        body: formData,
      });

      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || "Could not upload the document.");
      }

      const newDocument = payload.document;
      const extraction = normalizeExtractionStatus(newDocument?.extractionStatus);

      setUploadFeedback(
        `Upload complete. Extraction status: ${extraction.label}.`
      );
      setUploadForm(emptyUploadForm);

      await loadDocuments();

      if (newDocument?.id) {
        setSelectedDocumentId(newDocument.id);
      }
    } catch (error) {
      setUploadError(error.message || "Could not upload the document.");
    } finally {
      setUploading(false);
    }
  }

  function handleSelectDocument(documentId) {
    setSelectedDocumentId(documentId);
    setEditingDocumentId(null);
    setSaveState({
      documentId: null,
      saving: false,
      message: "",
      error: "",
    });
    setExtractionRunState({
      documentId,
      running: false,
      message: "",
      error: "",
    });
  }

  function startEditingDocument(document) {
    setEditingDocumentId(document.id);
    setEditForm({
      title: document.title || "",
      system: document.system || "",
      subsystem: document.subsystem || "",
      documentType: document.documentType || "",
      source: document.source || "",
      notes: document.notes || "",
      isFavorite: Boolean(document.isFavorite),
      isBookmarked: Boolean(document.isBookmarked),
      tags: getDocumentTags(document).join(", "),
    });
    setSaveState({
      documentId: document.id,
      saving: false,
      message: "",
      error: "",
    });
  }

  function cancelEditingDocument() {
    setEditingDocumentId(null);
    setEditForm(emptyEditForm);
    setSaveState({
      documentId: null,
      saving: false,
      message: "",
      error: "",
    });
  }

  function handleEditFormChange(event) {
    const { name, type, checked, value } = event.target;

    setEditForm((currentForm) => ({
      ...currentForm,
      [name]: type === "checkbox" ? checked : value,
    }));
  }

  async function handleSaveMetadata(event) {
    event.preventDefault();

    if (!editingDocumentId) {
      return;
    }

    const metadataPayload = {
      title: editForm.title,
      system: editForm.system,
      subsystem: editForm.subsystem,
      documentType: editForm.documentType,
      source: editForm.source,
      notes: editForm.notes,
      isFavorite: editForm.isFavorite,
      isBookmarked: editForm.isBookmarked,
      tags: editForm.tags,
    };

    try {
      setSaveState({
        documentId: editingDocumentId,
        saving: true,
        message: "",
        error: "",
      });

      const response = await fetch(`/api/documents/${editingDocumentId}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(metadataPayload),
      });

      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || "Could not update document metadata.");
      }

      const updatedDocument = payload.document;

      setDocuments((currentDocuments) =>
        currentDocuments.map((document) =>
          document.id === updatedDocument.id ? updatedDocument : document
        )
      );

      setSaveState({
        documentId: updatedDocument.id,
        saving: false,
        message: "Metadata saved.",
        error: "",
      });
      setEditingDocumentId(null);
    } catch (error) {
      setSaveState({
        documentId: editingDocumentId,
        saving: false,
        message: "",
        error: error.message || "Could not update document metadata.",
      });
    }
  }

  async function toggleFavorite(document) {
    const nextFavoriteValue = !document.isFavorite;

    try {
      setFavoriteUpdateState({
        documentId: document.id,
        error: "",
      });

      const response = await fetch(`/api/documents/${document.id}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ isFavorite: nextFavoriteValue }),
      });

      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || "Could not update favorite status.");
      }

      const updatedDocument = payload.document;

      setDocuments((currentDocuments) =>
        currentDocuments.map((currentDocument) =>
          currentDocument.id === updatedDocument.id ? updatedDocument : currentDocument
        )
      );

      if (editingDocumentId === updatedDocument.id) {
        setEditForm((currentForm) => ({
          ...currentForm,
          isFavorite: updatedDocument.isFavorite,
        }));
      }

      setFavoriteUpdateState({
        documentId: null,
        error: "",
      });
    } catch (error) {
      setFavoriteUpdateState({
        documentId: document.id,
        error: error.message || "Could not update favorite status.",
      });
    }
  }

  async function toggleBookmark(document) {
    const nextBookmarkValue = !document.isBookmarked;

    try {
      setBookmarkUpdateState({
        documentId: document.id,
        error: "",
      });

      const response = await fetch(`/api/documents/${document.id}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ isBookmarked: nextBookmarkValue }),
      });

      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || "Could not update bookmark status.");
      }

      const updatedDocument = payload.document;

      setDocuments((currentDocuments) =>
        currentDocuments.map((currentDocument) =>
          currentDocument.id === updatedDocument.id ? updatedDocument : currentDocument
        )
      );

      if (editingDocumentId === updatedDocument.id) {
        setEditForm((currentForm) => ({
          ...currentForm,
          isBookmarked: updatedDocument.isBookmarked,
        }));
      }

      setBookmarkUpdateState({
        documentId: null,
        error: "",
      });
    } catch (error) {
      setBookmarkUpdateState({
        documentId: document.id,
        error: error.message || "Could not update bookmark status.",
      });
    }
  }

  async function handleDeleteDocument(document) {
    const confirmed = window.confirm(
      `Delete "${document.title}"? This removes the document record and uploaded PDF file. Linked symptom/procedure references will be removed and linked notes will be cleared.`
    );

    if (!confirmed) {
      return;
    }

    try {
      const response = await fetch(`/api/documents/${document.id}`, {
        method: "DELETE",
      });

      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || "Could not delete document.");
      }

      setSaveState({
        documentId: null,
        saving: false,
        message: payload.message || "Document deleted.",
        error: "",
      });

      setEditingDocumentId(null);
      await loadDocuments();
    } catch (error) {
      setSaveState({
        documentId: document.id,
        saving: false,
        message: "",
        error: error.message || "Could not delete document.",
      });
    }
  }

  function openDocumentFile(documentId) {
    window.open(`/api/documents/${documentId}/file`, "_blank", "noopener,noreferrer");
  }

  async function rerunExtraction(documentId) {
    setExtractionRunState({
      documentId,
      running: true,
      message: "",
      error: "",
    });

    try {
      const response = await fetch(`/api/documents/${documentId}/extract`, {
        method: "POST",
      });
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || "Could not re-run extraction.");
      }

      const updatedDocument = payload.document;
      const extraction = normalizeExtractionStatus(updatedDocument?.extractionStatus);

      if (updatedDocument?.id) {
        setDocuments((currentDocuments) =>
          currentDocuments.map((currentDocument) =>
            currentDocument.id === updatedDocument.id ? updatedDocument : currentDocument
          )
        );
      } else {
        await loadDocuments();
      }

      setExtractionRunState({
        documentId,
        running: false,
        message: `Extraction re-run complete. Status: ${extraction.label}.`,
        error: "",
      });
    } catch (error) {
      setExtractionRunState({
        documentId,
        running: false,
        message: "",
        error: error.message || "Could not re-run extraction.",
      });
    }
  }

  return (
    <>
      <PageHeader
        title="Documents"
        description=""
      />

      <div className="space-y-6">
        <UploadForm
          form={uploadForm}
          uploading={uploading}
          feedback={uploadFeedback}
          error={uploadError}
          isOpen={isUploadOpen}
          onToggleOpen={() => setIsUploadOpen((open) => !open)}
          systemSuggestions={systemSuggestions}
          documentTypeSuggestions={documentTypeSuggestions}
          onFileChange={handleUploadFileChange}
          onTextChange={handleUploadTextChange}
          onSubmit={handleUploadSubmit}
        />

        <div id="document-library" className="space-y-6">
          {loading ? (
            <section className="rounded-lg border border-slate-300 bg-white p-6 text-sm text-slate-600 shadow-sm">
              Loading documents...
            </section>
          ) : null}

          {loadError ? (
            <section className="rounded-lg border border-red-200 bg-red-50 p-6 shadow-sm">
              <p className="font-semibold text-red-800">Could not load documents.</p>
              <p className="mt-2 text-sm text-red-700">{loadError}</p>
            </section>
          ) : null}

          {!loading && !loadError ? (
            <>
              <ListControls
                sortBy={sortBy}
                onSortChange={(event) => setSortBy(event.target.value)}
                systemFilter={systemFilter}
                onSystemFilterChange={(event) => setSystemFilter(event.target.value)}
                documentTypeFilter={documentTypeFilter}
                onDocumentTypeFilterChange={(event) =>
                  setDocumentTypeFilter(event.target.value)
                }
                favoriteFilter={favoriteFilter}
                onFavoriteFilterChange={(event) => setFavoriteFilter(event.target.value)}
                bookmarkFilter={bookmarkFilter}
                onBookmarkFilterChange={(event) => setBookmarkFilter(event.target.value)}
                tagFilter={tagFilter}
                onTagFilterChange={(event) => setTagFilter(event.target.value)}
                systems={systems}
                documentTypes={documentTypes}
                tags={availableTags}
              />

              <section className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-300 bg-white px-4 py-3 text-sm text-slate-600 shadow-sm">
                <span>
                  Showing{" "}
                  <span className="font-semibold text-slate-900">{pagedDocuments.length}</span>{" "}
                  of <span className="font-semibold text-slate-900">{filteredDocuments.length}</span>{" "}
                  matching ({documents.length} total).
                </span>

                {totalPages > 1 ? (
                  <span className="flex items-center gap-2">
                    <button
                      type="button"
                      className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
                      onClick={() => setPage((value) => Math.max(1, value - 1))}
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
                      className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
                      onClick={() => setPage((value) => Math.min(totalPages, value + 1))}
                      disabled={currentPage >= totalPages}
                    >
                      Next
                    </button>
                  </span>
                ) : null}
              </section>

              <div className="grid gap-6 xl:grid-cols-[minmax(0,1.08fr)_minmax(22rem,0.92fr)]">
                <DocumentsList
                  documents={pagedDocuments}
                  selectedDocumentId={selectedDocumentId}
                  onSelectDocument={handleSelectDocument}
                  onToggleFavorite={toggleFavorite}
                  favoriteUpdateState={favoriteUpdateState}
                />

                <DocumentDetails
                  document={selectedDocument}
                  isEditing={editingDocumentId === selectedDocumentId}
                  editValues={editForm}
                  saveState={saveState}
                  extractionRunState={extractionRunState}
                  bookmarkUpdateState={bookmarkUpdateState}
                  onStartEdit={startEditingDocument}
                  onCancelEdit={cancelEditingDocument}
                  onEditChange={handleEditFormChange}
                  onSaveEdit={handleSaveMetadata}
                  onOpenFile={openDocumentFile}
                  onToggleFavorite={toggleFavorite}
                  onToggleBookmark={toggleBookmark}
                  onRerunExtraction={rerunExtraction}
                  onDeleteDocument={handleDeleteDocument}
                  systemSuggestions={systemSuggestions}
                  documentTypeSuggestions={documentTypeSuggestions}
                />
              </div>
            </>
          ) : null}
        </div>
      </div>
    </>
  );
}
