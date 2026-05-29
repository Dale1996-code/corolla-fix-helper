import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { PageHeader } from "../components/PageHeader";
import { mergeSuggestionValues } from "../lib/suggestionUtils";

const emptyUploadForm = {
  pdfFile: null,
  title: "",
  system: "",
  subsystem: "",
  documentType: "",
  source: "",
  notes: "",
};

const emptyEditForm = {
  title: "",
  system: "",
  subsystem: "",
  documentType: "",
  source: "",
  notes: "",
  isFavorite: false,
};

const emptyDocumentDefaults = {
  commonSystems: [],
  documentTypes: [],
};

function normalizeExtractionStatus(status) {
  const value = typeof status === "string" ? status : "";

  if (!value || value === "not_attempted") {
    return {
      key: "not_attempted",
      label: "Not attempted",
      className: "bg-slate-100 text-slate-700",
    };
  }

  if (value === "completed") {
    return {
      key: "completed",
      label: "Completed",
      className: "bg-emerald-100 text-emerald-800",
    };
  }

  if (value === "no_text_found") {
    return {
      key: "no_text_found",
      label: "No text found",
      className: "bg-amber-100 text-amber-800",
    };
  }

  if (value.startsWith("failed")) {
    return {
      key: "failed",
      label: "Failed",
      className: "bg-red-100 text-red-800",
    };
  }

  return {
    key: "other",
    label: value,
    className: "bg-slate-100 text-slate-700",
  };
}

function formatDate(value) {
  if (!value) {
    return "Not available";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "Not available";
  }

  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function getSortTimestamp(document) {
  const dateValue = document.updatedAt || document.createdAt;
  const time = new Date(dateValue || "").getTime();
  return Number.isNaN(time) ? 0 : time;
}

function normalizeFavoriteFilter(value) {
  if (value === "favorites_only" || value === "not_favorites") {
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
        className="rounded-xl border border-slate-300 px-3 py-2 outline-none transition focus:border-sky-500"
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
        className="min-h-24 rounded-xl border border-slate-300 px-3 py-2 outline-none transition focus:border-sky-500"
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
  systemSuggestions,
  documentTypeSuggestions,
  onFileChange,
  onTextChange,
  onSubmit,
}) {
  return (
    <section
      id="document-upload"
      className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
    >
      <h3 className="text-lg font-semibold text-slate-900">Import one PDF</h3>
      <p className="mt-1 text-sm text-slate-600">
        Upload one document at a time, then review extraction status and fix details if needed.
      </p>
      <p className="mt-1 text-xs text-slate-500">
        Saved suggestions from Settings appear while you type in System and Document Type.
      </p>

      <form className="mt-4 grid gap-4" onSubmit={onSubmit}>
        <label className="grid gap-2 text-sm text-slate-700">
          <span className="font-medium text-slate-900">PDF file *</span>
          <input
            type="file"
            accept="application/pdf,.pdf"
            onChange={onFileChange}
            required
            className="rounded-xl border border-slate-300 px-3 py-2 text-sm"
          />
        </label>

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

        <TextAreaField
          label="Notes"
          name="notes"
          value={form.notes}
          onChange={onTextChange}
          placeholder="Any quick notes about this document"
        />

        {feedback ? (
          <p className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
            {feedback}
          </p>
        ) : null}

        {error ? (
          <p className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        ) : null}

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={uploading}
            className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-400"
          >
            {uploading ? "Uploading..." : "Upload PDF"}
          </button>
          <p className="text-xs text-slate-500">PDF only, up to 20 MB.</p>
        </div>

        <SuggestionDatalist id="upload-system-suggestions" options={systemSuggestions} />
        <SuggestionDatalist
          id="upload-document-type-suggestions"
          options={documentTypeSuggestions}
        />
      </form>
    </section>
  );
}

function ListControls({
  sortBy,
  onSortChange,
  systemFilter,
  onSystemFilterChange,
  documentTypeFilter,
  onDocumentTypeFilterChange,
  favoriteFilter,
  onFavoriteFilterChange,
  extractionFilter,
  onExtractionFilterChange,
  systems,
  documentTypes,
}) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
        <label className="grid gap-1 text-xs font-medium text-slate-700">
          <span>Sort</span>
          <select
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
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
          <span>Document type</span>
          <select
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
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
            className="min-w-[10.5rem] w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            value={favoriteFilter}
            onChange={onFavoriteFilterChange}
          >
            <option value="all">All</option>
            <option value="favorites_only">Favorites only</option>
            <option value="not_favorites">Not favorites</option>
          </select>
        </label>

        <label className="grid gap-1 text-xs font-medium text-slate-700">
          <span>Extraction</span>
          <select
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            value={extractionFilter}
            onChange={onExtractionFilterChange}
          >
            <option value="all">All</option>
            <option value="completed">Completed</option>
            <option value="no_text_found">No text found</option>
            <option value="failed">Failed</option>
            <option value="not_attempted">Not attempted</option>
          </select>
        </label>
      </div>
    </section>
  );
}

function DocumentsList({
  documents,
  selectedDocumentId,
  onSelectDocument,
  onToggleFavorite,
  favoriteUpdateState,
}) {
  const listGridClass =
    "grid grid-cols-[minmax(15rem,2.8fr)_minmax(8rem,1.1fr)_minmax(9rem,1.2fr)_minmax(7.25rem,0.9fr)_minmax(9rem,1.1fr)_minmax(9.5rem,1.1fr)] gap-3";

  return (
    <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="overflow-x-auto">
        <div className="min-w-[820px]">
          <div
            className={`${listGridClass} border-b border-slate-200 bg-slate-50 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-600`}
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
                className={`${listGridClass} cursor-pointer border-b border-slate-100 px-4 py-3 text-sm ${
                  isSelected ? "bg-sky-50" : "hover:bg-slate-50"
                }`}
                onClick={() => onSelectDocument(document.id)}
              >
                <div className="min-w-0">
                  <p className="truncate font-medium text-slate-900">{document.title}</p>
                  <p className="truncate text-xs text-slate-500">{document.originalFilename}</p>
                </div>
                <span className="truncate text-slate-700">{document.system}</span>
                <span className="truncate text-slate-700">{document.documentType}</span>
                <div>
                  <button
                    type="button"
                    className="rounded-md border border-slate-300 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100"
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
    <form className="mt-4 grid gap-4 rounded-xl border border-slate-200 bg-slate-50 p-4" onSubmit={onSubmit}>
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

      <TextAreaField label="Document notes" name="notes" value={values.notes} onChange={onChange} />

      <label className="flex items-center gap-2 text-sm text-slate-700">
        <input
          type="checkbox"
          name="isFavorite"
          checked={values.isFavorite}
          onChange={onChange}
        />
        Mark this document as favorite
      </label>

      <div className="flex flex-wrap gap-3">
        <button
          type="submit"
          disabled={saving}
          className="rounded-xl bg-sky-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-sky-500 disabled:cursor-not-allowed disabled:bg-sky-300"
        >
          {saving ? "Saving..." : "Save metadata"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-100"
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
  systemSuggestions,
  documentTypeSuggestions,
  onStartEdit,
  onCancelEdit,
  onEditChange,
  onSaveEdit,
  onOpenFile,
  onToggleFavorite,
  onRerunExtraction,
  onDeleteDocument,
}) {
  if (!document) {
    return (
      <section className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-600 shadow-sm">
        Select a document to view details.
      </section>
    );
  }

  const extraction = normalizeExtractionStatus(document.extractionStatus);

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
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

      <div className="mt-5">
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
  const [extractionFilter, setExtractionFilter] = useState("all");

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

      const normalizedExtractionStatus = normalizeExtractionStatus(
        document.extractionStatus
      );

      if (
        extractionFilter !== "all" &&
        normalizedExtractionStatus.key !== extractionFilter
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
    extractionFilter,
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

  function handleUploadFileChange(event) {
    const nextFile = event.target.files?.[0] || null;

    setUploadForm((currentForm) => ({
      ...currentForm,
      pdfFile: nextFile,
    }));
  }

  function handleUploadTextChange(event) {
    const { name, value } = event.target;

    setUploadForm((currentForm) => ({
      ...currentForm,
      [name]: value,
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
        eyebrow="Ready to Use"
        title="Documents"
        description="Import repair PDFs, check extraction status, sort and filter your library, then use favorites to keep the most important documents easy to find."
      />

      <div className="space-y-6">
        <section className="rounded-xl border border-sky-200 bg-sky-50 p-4 shadow-sm">
          <p className="text-sm font-semibold text-sky-900">
            Favorites are the only saved-document flag in V1.
          </p>
          <p className="mt-1 text-sm text-sky-800">
            Tags and bookmarks are not part of the current document workflow.
          </p>
        </section>

        <UploadForm
          form={uploadForm}
          uploading={uploading}
          feedback={uploadFeedback}
          error={uploadError}
          systemSuggestions={systemSuggestions}
          documentTypeSuggestions={documentTypeSuggestions}
          onFileChange={handleUploadFileChange}
          onTextChange={handleUploadTextChange}
          onSubmit={handleUploadSubmit}
        />

        <div id="document-library" className="space-y-6">
          {loading ? (
            <section className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-600 shadow-sm">
              Loading documents...
            </section>
          ) : null}

          {loadError ? (
            <section className="rounded-xl border border-red-200 bg-red-50 p-6 shadow-sm">
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
                extractionFilter={extractionFilter}
                onExtractionFilterChange={(event) =>
                  setExtractionFilter(event.target.value)
                }
                systems={systems}
                documentTypes={documentTypes}
              />

              <section className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600 shadow-sm">
                Showing{" "}
                <span className="font-semibold text-slate-900">{filteredDocuments.length}</span>{" "}
                of <span className="font-semibold text-slate-900">{documents.length}</span>{" "}
                documents.
              </section>

              <div className="grid gap-6 xl:grid-cols-2">
                <DocumentsList
                  documents={filteredDocuments}
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
                  onStartEdit={startEditingDocument}
                  onCancelEdit={cancelEditingDocument}
                  onEditChange={handleEditFormChange}
                  onSaveEdit={handleSaveMetadata}
                  onOpenFile={openDocumentFile}
                  onToggleFavorite={toggleFavorite}
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
