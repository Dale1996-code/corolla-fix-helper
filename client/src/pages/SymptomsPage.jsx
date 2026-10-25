import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AttachmentPanel } from "../components/AttachmentPanel";
import { PageHeader } from "../components/PageHeader";
import { ListDetailLayout } from "../components/ListDetailLayout";
import { ListPager } from "../components/ListPager";
import { ErrorBanner, SuccessBanner } from "../components/feedback/Banner";
import {
  SelectField,
  SuggestionDatalist,
  TextAreaField,
  TextField,
} from "../components/forms/FormFields";
import { RecordPicker } from "../components/forms/RecordPicker";
import {
  fetchSuggestedProcedures,
  setSymptomProcedures,
} from "../lib/apiClient";
import { formatDate } from "../lib/formatDate";
import { labelize } from "../lib/labelize";
import { buildEntityLink } from "../lib/navigation";
import { mergeSuggestionValues } from "../lib/suggestionUtils";
import { useScrollToHash } from "../lib/useScrollToHash";
import {
  buildSymptomsListQuery,
  countSymptomPages,
  SYMPTOMS_PER_PAGE,
} from "../lib/symptomsQuery";
import {
  clearFilterUpdates,
  DEFAULT_PAGE,
  filterValueUpdates,
  pageParamValue,
  readFilterValues,
  readIdParam,
  readPageParam,
  useDraftTextParam,
  useViewParamWriter,
} from "../lib/urlState";
import {
  formatSymptomRangeText,
  getStatusBadgeClass,
} from "../components/symptoms/symptomDisplay";
import { SymptomsControls } from "../components/symptoms/SymptomsControls";
import { SymptomsSummary } from "../components/symptoms/SymptomsSummary";
import { SymptomsList } from "../components/symptoms/SymptomsList";

const emptySymptomForm = {
  title: "",
  description: "",
  system: "",
  suspectedCauses: "",
  confidence: "medium",
  status: "open",
  notes: "",
  // Records, not bare ids: the picker no longer holds the whole library, so a
  // linked document's title has to travel with its id.
  linkedDocuments: [],
};

// The filters that materially decide which symptoms are on screen, and so
// belong in the URL. `system` carries no options list: the choices come from
// the owner's own symptoms, and a system that matches nothing filters the list
// to empty rather than being an error.
const SYMPTOM_FILTERS = {
  q: { default: "" },
  status: {
    default: "all",
    options: ["all", "active", "open", "monitoring", "resolved"],
  },
  system: { default: "all" },
  confidence: { default: "all", options: ["all", "high", "medium", "low"] },
  sort: { default: "newest", options: ["newest", "oldest", "title"] },
};

// A committed keyword starts its results from page 1.
const PAGE_KEYS = ["page"];

// The status cards' counts until the server sends its own (the cards are not
// shown before the first answer), and the fallback for any count it omits.
const emptyStatusCounts = { open: 0, monitoring: 0, resolved: 0 };

function describeDocument(document) {
  return `${document.system || "No system"} - ${document.documentType || "No type"}`;
}

function describeProcedure(procedure) {
  return `${procedure.system || "No system"} - ${labelize(procedure.difficulty)}`;
}

function toLinkedDocument(document) {
  return {
    id: document.id,
    title: document.title,
    system: document.system || "",
    documentType: document.documentType || "",
  };
}

function toLinkedProcedure(procedure) {
  return {
    id: procedure.id,
    title: procedure.title,
    system: procedure.system || "",
    difficulty: procedure.difficulty,
  };
}

function toggleRecord(records, record, toLinkedRecord) {
  return records.some((current) => current.id === record.id)
    ? records.filter((current) => current.id !== record.id)
    : [...records, toLinkedRecord(record)];
}

function LinkedDocumentsSelector({ selectedDocuments, onToggle, pickerCache, disabled = false }) {
  return (
    <RecordPicker
      legend="Linked documents"
      endpoint="/api/search/documents"
      cache={pickerCache}
      selected={selectedDocuments}
      onToggle={onToggle}
      describe={describeDocument}
      noun="document"
      nounPlural="documents"
      searchLabel="Find documents"
      searchPlaceholder="Search titles, systems, or text"
      emptyLibraryText="No documents available yet. Upload a PDF on the Documents page first."
      disabled={disabled}
    />
  );
}

function SymptomCreateForm({
  form,
  pickerCache,
  systemSuggestions,
  creating,
  createMessage,
  createError,
  onChange,
  onToggleDocument,
  onSubmit,
}) {
  return (
    <section
      id="create-symptom"
      className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
    >
      <h2 className="text-lg font-semibold text-slate-900">Create symptom</h2>
      <p className="mt-1 text-sm text-slate-600">
        Save what you observed and link it to useful documents.
      </p>

      <form className="mt-4 grid gap-4" onSubmit={onSubmit}>
        <div className="grid gap-4 md:grid-cols-2">
          <TextField
            label="Title"
            name="title"
            value={form.title}
            onChange={onChange}
            required
            placeholder="Rough idle at stop lights"
          />
          <TextField
            label="System"
            name="system"
            value={form.system}
            onChange={onChange}
            placeholder="Engine, Brakes, Electrical..."
            listId="create-symptom-system-suggestions"
          />
          <SelectField
            label="Confidence"
            name="confidence"
            value={form.confidence}
            onChange={onChange}
            options={[
              { value: "low", label: "Low" },
              { value: "medium", label: "Medium" },
              { value: "high", label: "High" },
            ]}
          />
          <SelectField
            label="Status"
            name="status"
            value={form.status}
            onChange={onChange}
            options={[
              { value: "open", label: "Open" },
              { value: "monitoring", label: "Monitoring" },
              { value: "resolved", label: "Resolved" },
            ]}
          />
        </div>

        <TextAreaField
          label="Description"
          name="description"
          value={form.description}
          onChange={onChange}
          placeholder="When does it happen? What does it sound or feel like?"
        />

        <TextAreaField
          label="Suspected causes"
          name="suspectedCauses"
          value={form.suspectedCauses}
          onChange={onChange}
          placeholder="Possible vacuum leak, dirty throttle body, worn spark plugs..."
        />

        <TextAreaField
          label="Notes"
          name="notes"
          value={form.notes}
          onChange={onChange}
          placeholder="Extra details, test results, what changed after repairs..."
        />

        <LinkedDocumentsSelector
          selectedDocuments={form.linkedDocuments}
          onToggle={onToggleDocument}
          pickerCache={pickerCache}
          disabled={creating}
        />

        {createMessage ? <SuccessBanner>{createMessage}</SuccessBanner> : null}

        {createError ? <ErrorBanner>{createError}</ErrorBanner> : null}

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={creating}
            className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-600"
          >
            {creating ? "Saving..." : "Save symptom"}
          </button>
        </div>

        <SuggestionDatalist
          id="create-symptom-system-suggestions"
          options={systemSuggestions}
        />
      </form>
    </section>
  );
}

function SymptomEditForm({
  form,
  pickerCache,
  systemSuggestions,
  saveState,
  onChange,
  onToggleDocument,
  onSubmit,
  onCancel,
}) {
  return (
    <form className="mt-4 grid gap-4 rounded-xl border border-slate-200 bg-slate-50 p-4" onSubmit={onSubmit}>
      <div className="grid gap-4 md:grid-cols-2">
        <TextField
          label="Title"
          name="title"
          value={form.title}
          onChange={onChange}
          required
        />
        <TextField
          label="System"
          name="system"
          value={form.system}
          onChange={onChange}
          listId="edit-symptom-system-suggestions"
        />
        <SelectField
          label="Confidence"
          name="confidence"
          value={form.confidence}
          onChange={onChange}
          options={[
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High" },
          ]}
        />
        <SelectField
          label="Status"
          name="status"
          value={form.status}
          onChange={onChange}
          options={[
            { value: "open", label: "Open" },
            { value: "monitoring", label: "Monitoring" },
            { value: "resolved", label: "Resolved" },
          ]}
        />
      </div>

      <TextAreaField label="Description" name="description" value={form.description} onChange={onChange} />
      <TextAreaField
        label="Suspected causes"
        name="suspectedCauses"
        value={form.suspectedCauses}
        onChange={onChange}
      />
      <TextAreaField label="Notes" name="notes" value={form.notes} onChange={onChange} />

      <LinkedDocumentsSelector
        selectedDocuments={form.linkedDocuments}
        onToggle={onToggleDocument}
        pickerCache={pickerCache}
        disabled={saveState.saving}
      />

      <div className="flex flex-wrap gap-3">
        <button
          type="submit"
          disabled={saveState.saving}
          className="rounded-xl bg-sky-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-sky-500 disabled:cursor-not-allowed disabled:bg-slate-600"
        >
          {saveState.saving ? "Saving..." : "Save changes"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-100"
        >
          Cancel
        </button>
      </div>

      {saveState.error ? <ErrorBanner>{saveState.error}</ErrorBanner> : null}

      <SuggestionDatalist
        id="edit-symptom-system-suggestions"
        options={systemSuggestions}
      />
    </form>
  );
}

function SuggestionCitations({ citations }) {
  if (!citations || !citations.length) {
    return null;
  }

  return (
    <ul className="mt-1 space-y-1">
      {citations.map((citation, index) => (
        <li key={`${citation.documentId}-${citation.pageNumber}-${index}`} className="text-xs text-slate-500">
          <span className="font-medium text-slate-600">
            {citation.documentTitle || "Document"}
            {citation.pageNumber ? `, page ${citation.pageNumber}` : ""}
          </span>
          {citation.snippet ? <span className="block">{citation.snippet}</span> : null}
        </li>
      ))}
    </ul>
  );
}

// Manual procedure links plus the "Suggest fixes" helper for one symptom.
// Keeps its own UI state but pushes the updated symptom back up so the page
// list and detail panel stay in sync. The selector searches procedures a page
// at a time instead of listing every procedure in the library.
function SymptomProcedurePanel({ symptom, pickerCache, onSymptomUpdated }) {
  const linkedProcedures = symptom.linkedProcedures || [];
  const [selectedProcedures, setSelectedProcedures] = useState(linkedProcedures);
  const [saveState, setSaveState] = useState({ saving: false, message: "", error: "" });
  const [suggestions, setSuggestions] = useState([]);
  const [suggestState, setSuggestState] = useState({
    loading: false,
    loaded: false,
    error: "",
    status: "",
    aiConfigured: true,
  });
  const [linkingId, setLinkingId] = useState(null);
  const selectedIds = selectedProcedures.map((procedure) => procedure.id);

  function toggleProcedure(procedure) {
    setSelectedProcedures((current) => toggleRecord(current, procedure, toLinkedProcedure));
  }

  async function handleSaveLinks() {
    try {
      setSaveState({ saving: true, message: "", error: "" });
      const payload = await setSymptomProcedures(symptom.id, selectedIds);
      onSymptomUpdated(payload.symptom);
      setSelectedProcedures(payload.symptom.linkedProcedures || []);
      setSaveState({ saving: false, message: "Linked procedures saved.", error: "" });
    } catch (error) {
      setSaveState({
        saving: false,
        message: "",
        error: error.message || "Could not save linked procedures.",
      });
    }
  }

  async function handleSuggest() {
    try {
      setSuggestState((current) => ({ ...current, loading: true, error: "" }));
      const payload = await fetchSuggestedProcedures(symptom.id);
      setSuggestions(Array.isArray(payload.suggestions) ? payload.suggestions : []);
      setSuggestState({
        loading: false,
        loaded: true,
        error: "",
        status: payload.status || "",
        aiConfigured: payload.aiConfigured !== false,
      });
    } catch (error) {
      setSuggestions([]);
      setSuggestState({
        loading: false,
        loaded: true,
        error: error.message || "Could not suggest procedures.",
        status: "",
        aiConfigured: true,
      });
    }
  }

  async function handleLinkSuggestion(procedureId) {
    try {
      setLinkingId(procedureId);
      const nextIds = selectedIds.includes(procedureId)
        ? selectedIds
        : [...selectedIds, procedureId];
      const payload = await setSymptomProcedures(symptom.id, nextIds);
      onSymptomUpdated(payload.symptom);
      setSelectedProcedures(payload.symptom.linkedProcedures || []);
      setSuggestions((current) =>
        current.filter((suggestion) => suggestion.procedureId !== procedureId)
      );
    } catch (error) {
      setSuggestState((current) => ({
        ...current,
        error: error.message || "Could not link the suggested procedure.",
      }));
    } finally {
      setLinkingId(null);
    }
  }

  return (
    <div>
      <h3 className="font-semibold text-slate-900">Linked procedures</h3>

      {linkedProcedures.length ? (
        <ul className="mt-2 space-y-2">
          {linkedProcedures.map((procedure) => (
            <li
              key={procedure.id}
              className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-slate-700"
            >
              <Link
                className="font-medium text-sky-700 underline decoration-sky-200 underline-offset-2 hover:text-sky-900"
                to={buildEntityLink("procedure", procedure.id)}
                aria-label={`Open procedure ${procedure.title}`}
              >
                {procedure.title}
              </Link>
              <p className="text-xs text-slate-500">
                {procedure.system || "No system"} - {labelize(procedure.difficulty)}
              </p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-slate-700">No linked procedures yet.</p>
      )}

      <div className="mt-3">
        <RecordPicker
          legend="Link procedures"
          endpoint="/api/search/procedures"
          cache={pickerCache}
          selected={selectedProcedures}
          onToggle={toggleProcedure}
          describe={describeProcedure}
          noun="procedure"
          nounPlural="procedures"
          searchLabel="Find procedures"
          searchPlaceholder="Search titles, systems, steps, or parts"
          emptyLibraryText="No procedures available yet. Create one on the Procedures page first."
          disabled={saveState.saving}
          footer={
            <>
              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={handleSaveLinks}
                  disabled={saveState.saving}
                  className="rounded-lg bg-sky-600 px-3 py-2 text-sm font-semibold text-white transition hover:bg-sky-500 disabled:cursor-not-allowed disabled:bg-slate-600"
                >
                  {saveState.saving ? "Saving..." : "Save linked procedures"}
                </button>
                {saveState.message ? (
                  <span className="text-sm text-emerald-700">{saveState.message}</span>
                ) : null}
              </div>

              {saveState.error ? <ErrorBanner>{saveState.error}</ErrorBanner> : null}
            </>
          }
        />
      </div>

      <div className="mt-4 border-t border-slate-200 pt-4">
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={handleSuggest}
            disabled={suggestState.loading}
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {suggestState.loading ? "Finding fixes..." : "Suggest fixes"}
          </button>
          <span className="text-xs text-slate-500">
            Suggests saved procedures grounded in your uploaded documents.
          </span>
        </div>

        {suggestState.error ? <ErrorBanner className="mt-3">{suggestState.error}</ErrorBanner> : null}

        {suggestState.loaded && !suggestState.aiConfigured ? (
          <p className="mt-3 text-xs text-slate-500">
            AI is not configured, so these are keyword-based matches.
          </p>
        ) : null}

        {suggestState.loaded && !suggestState.error && suggestions.length === 0 ? (
          <p className="mt-3 text-sm text-slate-700">
            No matching procedures found in your documents yet.
          </p>
        ) : null}

        {suggestions.length ? (
          <ul className="mt-3 space-y-2">
            {suggestions.map((suggestion) => (
              <li
                key={suggestion.procedureId}
                className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <Link
                      className="font-medium text-sky-700 underline decoration-sky-200 underline-offset-2 hover:text-sky-900"
                      to={buildEntityLink("procedure", suggestion.procedureId)}
                    >
                      {suggestion.title}
                    </Link>
                    <p className="text-xs text-slate-500">
                      {suggestion.system || "No system"} - {labelize(suggestion.difficulty)}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleLinkSuggestion(suggestion.procedureId)}
                    disabled={linkingId === suggestion.procedureId}
                    className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-600"
                  >
                    {linkingId === suggestion.procedureId ? "Linking..." : "Link"}
                  </button>
                </div>
                {suggestion.reason ? (
                  <p className="mt-1 text-xs text-slate-600">{suggestion.reason}</p>
                ) : null}
                <SuggestionCitations citations={suggestion.citations} />
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

function SymptomDetails({
  symptom,
  isEditing,
  editForm,
  pickerCache,
  systemSuggestions,
  saveState,
  deleteState,
  onStartEdit,
  onCancelEdit,
  onEditChange,
  onToggleEditDocument,
  onSaveEdit,
  onDelete,
  onSymptomUpdated,
}) {
  if (!symptom) {
    return (
      <section className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-600 shadow-sm">
        Select a symptom to view details.
      </section>
    );
  }

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-slate-900">{symptom.title}</h2>
          <p className="mt-1 text-sm text-slate-500">
            Updated {formatDate(symptom.updatedAt)}
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => onStartEdit(symptom)}
            className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-700"
          >
            Edit symptom
          </button>
          <button
            type="button"
            onClick={() => onDelete(symptom)}
            disabled={deleteState.deletingId === symptom.id}
            className="rounded-lg border border-red-300 px-3 py-2 text-sm font-semibold text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {deleteState.deletingId === symptom.id ? "Deleting..." : "Delete"}
          </button>
        </div>
      </div>

      <dl className="mt-5 grid gap-3 text-sm md:grid-cols-2">
        <div>
          <dt className="font-semibold text-slate-900">System</dt>
          <dd className="text-slate-700">{symptom.system || "Not set"}</dd>
        </div>
        <div>
          <dt className="font-semibold text-slate-900">Status</dt>
          <dd>
            <span className={`rounded-full px-2 py-1 text-xs font-semibold ${getStatusBadgeClass(symptom.status)}`}>
              {labelize(symptom.status)}
            </span>
          </dd>
        </div>
        <div>
          <dt className="font-semibold text-slate-900">Confidence</dt>
          <dd className="text-slate-700">{labelize(symptom.confidence)}</dd>
        </div>
        <div>
          <dt className="font-semibold text-slate-900">Created</dt>
          <dd className="text-slate-700">{formatDate(symptom.createdAt)}</dd>
        </div>
      </dl>

      <div className="mt-5 space-y-4 text-sm">
        <div>
          <h3 className="font-semibold text-slate-900">Description</h3>
          <p className="mt-2 whitespace-pre-wrap text-slate-700">
            {symptom.description || "No description yet."}
          </p>
        </div>

        <div>
          <h3 className="font-semibold text-slate-900">Suspected causes</h3>
          <p className="mt-2 whitespace-pre-wrap text-slate-700">
            {symptom.suspectedCauses || "No suspected causes added."}
          </p>
        </div>

        <div>
          <h3 className="font-semibold text-slate-900">Notes</h3>
          <p className="mt-2 whitespace-pre-wrap text-slate-700">
            {symptom.notes || "No notes yet."}
          </p>
        </div>

        <div>
          <h3 className="font-semibold text-slate-900">Linked documents</h3>
          {(symptom.linkedDocuments || []).length ? (
            <ul className="mt-2 space-y-2">
              {(symptom.linkedDocuments || []).map((document) => (
                <li key={document.id} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-slate-700">
                  <Link
                    className="font-medium text-sky-700 underline decoration-sky-200 underline-offset-2 hover:text-sky-900"
                    to={buildEntityLink("document", document.id)}
                    aria-label={`Open document ${document.title}`}
                  >
                    {document.title}
                  </Link>
                  <p className="text-xs text-slate-500">
                    {document.system || "No system"} - {document.documentType || "No type"}
                  </p>
                  <Link
                    className="mt-1 inline-flex text-xs font-medium text-sky-700 hover:text-sky-900"
                    to={buildEntityLink("document", document.id)}
                  >
                    Open document
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-slate-700">No linked documents yet.</p>
          )}
        </div>

        <SymptomProcedurePanel
          key={symptom.id}
          symptom={symptom}
          pickerCache={pickerCache}
          onSymptomUpdated={onSymptomUpdated}
        />

        <AttachmentPanel key={`attachments-${symptom.id}`} entityType="symptom" entityId={symptom.id} />
      </div>

      {isEditing ? (
        <SymptomEditForm
          form={editForm}
          pickerCache={pickerCache}
          systemSuggestions={systemSuggestions}
          saveState={saveState}
          onChange={onEditChange}
          onToggleDocument={onToggleEditDocument}
          onSubmit={onSaveEdit}
          onCancel={onCancelEdit}
        />
      ) : null}

      {saveState.message ? (
        <SuccessBanner className="mt-4">{saveState.message}</SuccessBanner>
      ) : null}

      {deleteState.error ? (
        <ErrorBanner className="mt-4">{deleteState.error}</ErrorBanner>
      ) : null}
    </section>
  );
}

function toSymptomPayload(form) {
  return {
    title: form.title,
    description: form.description,
    system: form.system,
    suspectedCauses: form.suspectedCauses,
    confidence: form.confidence,
    status: form.status,
    notes: form.notes,
    linkedDocumentIds: form.linkedDocuments.map((document) => document.id),
  };
}

// The detail panel when the symptom a link names could not be loaded for a
// reason other than "it does not exist" (a 404 drops the link instead). It names
// the requested symptom so nothing else is mistaken for it, and the link is kept
// so the owner can simply try again.
function SymptomLookupError({ symptomId, message, onRetry }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <ErrorBanner title={`Could not load symptom #${symptomId}.`}>
        {message} The link to it is kept, so you can try again.
        <button
          type="button"
          className="mt-3 block min-h-11 rounded-md border border-red-300 bg-white px-4 text-sm font-medium text-red-800 hover:bg-red-100"
          onClick={onRetry}
        >
          Try again
        </button>
      </ErrorBanner>
    </section>
  );
}

export function SymptomsPage() {
  useScrollToHash();

  const [searchParams, setSearchParams] = useSearchParams();
  const requestedSymptomId = readIdParam(searchParams, "symptomId");
  const requestedPage = readPageParam(searchParams);
  // `symptoms` is the ONE PAGE the server last sent -- never the whole list. The
  // server also owns the counts: `matchedCount` is how many symptoms the current
  // filters leave; `libraryTotal` and `statusCounts` describe every symptom.
  const [symptoms, setSymptoms] = useState([]);
  const [matchedCount, setMatchedCount] = useState(0);
  const [libraryTotal, setLibraryTotal] = useState(0);
  const [statusCounts, setStatusCounts] = useState(emptyStatusCounts);
  // Which request the rows above answer. Anything that reasons about "this view"
  // (clamping the page, resolving the selection) waits until it equals the
  // current request, so a stale page can never be mistaken for the new one.
  const [settledQuery, setSettledQuery] = useState(null);
  // The page the rows on screen belong to. The counter and the pager describe
  // THESE rows: while a new page loads, or after it failed to, the URL is ahead
  // of what is actually shown.
  const [settledPage, setSettledPage] = useState(DEFAULT_PAGE);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [isFetching, setIsFetching] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [reloadToken, setReloadToken] = useState(0);
  const latestListRequest = useRef(0);
  // The System filter's choices, from every symptom rather than the loaded page.
  const [filterSystems, setFilterSystems] = useState([]);
  const [optionsToken, setOptionsToken] = useState(0);
  const [savedCommonSystems, setSavedCommonSystems] = useState([]);
  // The selected symptom when its row is not on the current page (a deep link,
  // a symptom just created that a filter hides).
  const [fetchedSymptom, setFetchedSymptom] = useState(null);
  // A by-id lookup that failed for a reason other than "no such symptom":
  // `{ symptomId, message }`. The panel reports it instead of showing anything
  // else in the requested symptom's place.
  const [lookupFailure, setLookupFailure] = useState(null);
  // A selection made by this page (a symptom just created, or the one on display
  // when a save re-sorts the page) before the URL has caught up with it: React
  // Router commits that navigation as a transition, so the page can render first.
  const [pinnedSymptomId, setPinnedSymptomId] = useState(null);
  // Pickers on this page share one answer cache per visit, so opening another
  // symptom does not ask for the same first page of procedures again.
  const pickerCache = useRef(new Map()).current;
  // Symptoms this page deleted. Their row goes before the URL stops naming them,
  // and a lookup for one (in that gap, or after Back) could only answer 404.
  const deletedSymptomIds = useRef(new Set());

  const [createForm, setCreateForm] = useState(emptySymptomForm);
  const [creating, setCreating] = useState(false);
  const [createMessage, setCreateMessage] = useState("");
  const [createError, setCreateError] = useState("");

  const [editingSymptomId, setEditingSymptomId] = useState(null);
  const [editForm, setEditForm] = useState(emptySymptomForm);
  const [saveState, setSaveState] = useState({
    saving: false,
    message: "",
    error: "",
  });
  const [deleteState, setDeleteState] = useState({
    deletingId: null,
    error: "",
  });
  // Filters live in the URL so Back returns to the filtered list the owner was
  // reading, not to an unfiltered one. The keyword box is the exception: it
  // types into local state and lands in the URL a beat later (see
  // useDraftTextParam), because "brake" is one view, not five history entries
  // -- and, now that the server does the searching, not five requests either.
  const {
    q: committedSearch,
    status: statusFilter,
    system: systemFilter,
    confidence: confidenceFilter,
    sort: sortBy,
  } = readFilterValues(searchParams, SYMPTOM_FILTERS);
  const [searchValue, setSearchValue] = useDraftTextParam("q", {
    searchParams,
    setSearchParams,
    clearOnCommit: PAGE_KEYS,
  });
  // The pin outranks the URL: it only exists while a selection this page made
  // has not reached the URL yet, and the URL still names the previous one.
  const selectionId = pinnedSymptomId ?? requestedSymptomId;

  // One writer for every URL change this page makes, so "carry the parameters
  // I did not mention" is guaranteed rather than remembered at each call site,
  // and two writes close together (a delete clearing `symptomId`, then the
  // refetch clamping `page`) both land. It is stable, so the list fetch can use
  // it without re-running on every selection click.
  const updateViewParams = useViewParamWriter(searchParams, setSearchParams);

  // Filtering, sorting, and slicing all happen on the server, over every
  // symptom. The request is a pure function of the view state in the URL, and
  // that string is the only thing the fetch effect depends on.
  const listQuery = buildSymptomsListQuery({
    q: committedSearch,
    status: statusFilter,
    system: systemFilter,
    confidence: confidenceFilter,
    sort: sortBy,
    page: requestedPage,
  });
  const dataIsCurrent = settledQuery === listQuery;
  const totalPages = countSymptomPages(matchedCount);
  const currentPage = Math.min(settledPage, totalPages);
  const loadingAnotherPage = isFetching && !dataIsCurrent && requestedPage !== currentPage;

  // Changing a filter is a navigation step the owner should be able to undo, so
  // it pushes -- and it drops `page`, because page 4 of the old filter says
  // nothing about the new one.
  function handleFilterChange(key, value) {
    updateViewParams({
      ...filterValueUpdates({ [key]: value }, SYMPTOM_FILTERS),
      page: null,
    });
  }

  // Previous/Next act on the page the owner can see. When that lands on the page
  // the URL already asks for -- its load is in flight or just failed -- ask the
  // server again (unless it is already being asked) rather than navigating
  // nowhere.
  function goToPage(targetPage) {
    if (targetPage === requestedPage) {
      if (!isFetching) {
        reloadList();
      }
      return;
    }

    updateViewParams({ page: pageParamValue(targetPage) });
  }

  const systemSuggestions = useMemo(() => {
    return mergeSuggestionValues([...savedCommonSystems, ...filterSystems]);
  }, [savedCommonSystems, filterSystems]);

  // Whether the list on screen is narrower than the list itself. Drives which
  // empty state the list shows. The keyword counts once it has reached the URL;
  // the Clear filters button also appears for a keyword still being typed.
  const hasActiveFilters =
    committedSearch.trim() !== "" ||
    statusFilter !== "all" ||
    systemFilter !== "all" ||
    confidenceFilter !== "all";

  // The selected symptom is derived, not stored. No `symptomId` in the URL means
  // "the first symptom" -- the first row of the page on screen, since the rest
  // of the list is not loaded -- spelled as the absence of a parameter, so an
  // untouched list keeps a clean `/symptoms` URL. A `symptomId` whose row is not
  // on this page is fetched on its own below, so a deep link opens its record
  // under any filter or page, and is shown only as itself: while its lookup is
  // in flight the panel is empty, and if it fails the panel says so.
  const rowSymptom = selectionId
    ? symptoms.find((symptom) => symptom.id === selectionId)
    : null;
  const fetchedMatch =
    selectionId && fetchedSymptom?.id === selectionId ? fetchedSymptom : null;
  const selectedSymptom = selectionId
    ? rowSymptom || fetchedMatch || null
    : symptoms[0] || null;
  const selectedSymptomId = selectedSymptom?.id ?? null;
  const selectionLookupFailure =
    selectionId && !selectedSymptom && lookupFailure?.symptomId === selectionId
      ? lookupFailure
      : null;

  // Normalization only, so it replaces rather than pushing: `page=99` or
  // `page=abc` should not become a history entry. Waits until the rows on screen
  // answer THIS request -- before that, the page count belongs to another view.
  useEffect(() => {
    if (!dataIsCurrent || loadError) {
      return;
    }

    const canonicalPage = pageParamValue(
      Math.min(Math.max(requestedPage, DEFAULT_PAGE), totalPages)
    );

    if ((searchParams.get("page") ?? null) !== canonicalPage) {
      updateViewParams({ page: canonicalPage }, { replace: true });
    }
  }, [dataIsCurrent, loadError, requestedPage, totalPages, searchParams, updateViewParams]);

  // An unusable `symptomId` ("abc", "0") names nothing, so it drops out of the
  // URL. Only that parameter is touched; the filters stay as they are.
  useEffect(() => {
    if (!dataIsCurrent || !searchParams.has("symptomId") || requestedSymptomId) {
      return;
    }

    updateViewParams({ symptomId: null }, { replace: true });
  }, [dataIsCurrent, requestedSymptomId, searchParams, updateViewParams]);

  // A well-formed `symptomId` whose row is not on this page is looked up by id.
  // The server's 404 is what says it does not exist -- deleted, or hand-typed --
  // and only then does the parameter drop out of the URL. A symptom that exists
  // but that the filters hide keeps its parameter and is shown.
  const requestedRowIsOnPage = Boolean(rowSymptom);
  useEffect(() => {
    if (
      !selectionId ||
      !dataIsCurrent ||
      requestedRowIsOnPage ||
      fetchedSymptom?.id === selectionId ||
      lookupFailure?.symptomId === selectionId
    ) {
      return undefined;
    }

    // Deleted here, so the server would only say 404: answer that without asking.
    if (deletedSymptomIds.current.has(selectionId)) {
      setPinnedSymptomId(null);
      updateViewParams({ symptomId: null }, { replace: true });
      return undefined;
    }

    let cancelled = false;

    async function lookUpSymptom() {
      try {
        const response = await fetch(`/api/symptoms/${selectionId}`);
        const payload = await response.json().catch(() => ({}));

        if (cancelled) {
          return;
        }

        if (response.status === 404) {
          setFetchedSymptom(null);
          setPinnedSymptomId(null);
          updateViewParams({ symptomId: null }, { replace: true });
          return;
        }

        if (!response.ok || !payload.symptom) {
          throw new Error(payload.error || "The server could not load it.");
        }

        setFetchedSymptom(payload.symptom);
      } catch (error) {
        if (!cancelled) {
          setLookupFailure({
            symptomId: selectionId,
            message:
              error instanceof TypeError
                ? "The server could not be reached."
                : error.message || "The server could not load it.",
          });
        }
      }
    }

    lookUpSymptom();

    return () => {
      cancelled = true;
    };
  }, [
    selectionId,
    dataIsCurrent,
    requestedRowIsOnPage,
    fetchedSymptom,
    lookupFailure,
    updateViewParams,
  ]);

  // A failed lookup is remembered only for the visit it failed on: coming back
  // to that `symptomId` later asks the server again.
  useEffect(() => {
    setLookupFailure(null);
  }, [selectionId]);

  // The pin's job is done once the URL names a symptom itself, and it never
  // outlives the view it was made in.
  useEffect(() => {
    setPinnedSymptomId(null);
  }, [requestedSymptomId, listQuery]);

  // An edit form belongs to the symptom it was opened on. Moving the selection
  // any other way (a row click, Back, a deep link, a filter that changes the
  // first row) closes it instead of leaving it armed for another record.
  useEffect(() => {
    setEditingSymptomId((currentId) =>
      currentId && currentId !== selectedSymptomId ? null : currentId
    );
  }, [selectedSymptomId]);

  // One request per view. The fetch depends on the request string alone, so a
  // filter, sort, keyword, or page change is exactly one fetch, a selection
  // change within the page is none, and Back/Forward re-requests the page it
  // lands on. Rows from the previous view stay on screen until the new ones
  // arrive, so the controls the owner is using never unmount mid-interaction.
  useEffect(() => {
    const requestId = latestListRequest.current + 1;
    latestListRequest.current = requestId;

    async function loadSymptoms() {
      setIsFetching(true);
      // Set when this answer hands over to another request instead of settling.
      let handedOff = false;

      try {
        const response = await fetch(`/api/symptoms?${listQuery}`);
        const payload = await response.json();

        // A newer view has been asked for since: this answer is stale.
        if (requestId !== latestListRequest.current) {
          return;
        }

        if (!response.ok) {
          throw new Error(payload.error || "Could not load symptoms.");
        }

        const nextSymptoms = Array.isArray(payload.symptoms) ? payload.symptoms : [];
        const nextMatched = Number.isFinite(payload.matched)
          ? payload.matched
          : nextSymptoms.length;
        const offset = Number(new URLSearchParams(listQuery).get("offset")) || 0;

        // A page past the end (a hand-typed `page=9`, or the last page after its
        // only row was deleted) answers with no rows while symptoms do match.
        // That empty answer is never shown as the list: the URL moves to the
        // last real page -- by replace, it is normalization -- and that
        // request's answer is the one that settles.
        if (!nextSymptoms.length && nextMatched > 0 && offset >= nextMatched) {
          handedOff = true;
          updateViewParams(
            { page: pageParamValue(countSymptomPages(nextMatched)) },
            { replace: true }
          );
          return;
        }

        setSymptoms(nextSymptoms);
        setSettledPage(Math.floor(offset / SYMPTOMS_PER_PAGE) + 1);
        setMatchedCount(nextMatched);
        setLibraryTotal(Number.isFinite(payload.total) ? payload.total : nextMatched);
        setStatusCounts({ ...emptyStatusCounts, ...payload.statusCounts });
        setSettledQuery(listQuery);
        setLoadError("");
        setHasLoaded(true);
      } catch (error) {
        if (requestId === latestListRequest.current) {
          setLoadError(
            error instanceof TypeError
              ? "The server could not be reached."
              : error.message || "Could not load symptoms."
          );
        }
      } finally {
        if (requestId === latestListRequest.current && !handedOff) {
          setIsFetching(false);
        }
      }
    }

    loadSymptoms();

    // Leaving the page, or asking for another view, makes this answer stale, so
    // it can neither fill a page nobody sees nor move a URL the owner has left.
    return () => {
      latestListRequest.current += 1;
    };
  }, [listQuery, reloadToken, updateViewParams]);

  useEffect(() => {
    let cancelled = false;

    async function loadFilterOptions() {
      try {
        const response = await fetch("/api/symptoms/filter-options");
        const payload = await response.json();

        if (cancelled || !response.ok) {
          return;
        }

        setFilterSystems(Array.isArray(payload.systems) ? payload.systems : []);
      } catch {
        // The dropdown keeps what it had; the list does not depend on it.
      }
    }

    loadFilterOptions();

    return () => {
      cancelled = true;
    };
  }, [optionsToken]);

  useEffect(() => {
    let cancelled = false;

    async function loadSettings() {
      try {
        const response = await fetch("/api/settings");
        const payload = await response.json();

        if (!cancelled && response.ok) {
          setSavedCommonSystems(payload.documentDefaults?.commonSystems || []);
        }
      } catch {
        // Suggestions only; the page works without them.
      }
    }

    loadSettings();

    return () => {
      cancelled = true;
    };
  }, []);

  // Re-ask the server for the page on screen after something changed it. The
  // rows stay put meanwhile, so a save does not flash the list away.
  function reloadList({ options = false } = {}) {
    setReloadToken((token) => token + 1);

    if (options) {
      setOptionsToken((token) => token + 1);
    }
  }

  // A saved symptom reaches its row and the by-id copy immediately; the reload
  // that follows lets the server decide whether it still belongs on this page.
  //
  // Every save bumps `updated_at`, so a sort by last update reorders the page.
  // When the selection is only implicit (the page's first row), that reorder
  // would hand the panel to a different symptom. So the symptom ON DISPLAY is
  // pinned into the URL first -- by replace, since the view does not change --
  // and kept as the by-id copy, so the panel stays where the owner was looking.
  function applyUpdatedSymptom(updatedSymptom) {
    const displayedSymptom = selectedSymptom;
    const isDisplayed = updatedSymptom.id === displayedSymptom?.id;
    const pinDisplayed = Boolean(displayedSymptom) && !requestedSymptomId;

    setSymptoms((currentSymptoms) =>
      currentSymptoms.map((symptom) =>
        symptom.id === updatedSymptom.id ? updatedSymptom : symptom
      )
    );
    setFetchedSymptom((currentSymptom) => {
      if (isDisplayed || currentSymptom?.id === updatedSymptom.id) {
        return updatedSymptom;
      }

      return pinDisplayed ? displayedSymptom : currentSymptom;
    });

    if (pinDisplayed) {
      setPinnedSymptomId(displayedSymptom.id);
      updateViewParams({ symptomId: displayedSymptom.id }, { replace: true });
    }
  }

  // Keep the list and detail panel in sync after a procedure link change. Links
  // do not touch the symptom's own row, so the page needs no reload for them.
  function handleSymptomUpdated(updatedSymptom) {
    if (!updatedSymptom) {
      return;
    }

    applyUpdatedSymptom(updatedSymptom);
  }

  function handleCreateFormChange(event) {
    const { name, value } = event.target;

    setCreateForm((currentForm) => ({
      ...currentForm,
      [name]: value,
    }));
  }

  function handleToggleCreateDocument(document) {
    setCreateForm((currentForm) => ({
      ...currentForm,
      linkedDocuments: toggleRecord(currentForm.linkedDocuments, document, toLinkedDocument),
    }));
  }

  async function handleCreateSymptom(event) {
    event.preventDefault();

    if (!createForm.title.trim()) {
      setCreateError("Title is required.");
      return;
    }

    try {
      setCreating(true);
      setCreateError("");
      setCreateMessage("");

      const response = await fetch("/api/symptoms", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(toSymptomPayload(createForm)),
      });

      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || "Could not create symptom.");
      }

      const newSymptom = payload.symptom;

      // The new symptom is shown at once from the server's answer, whether or
      // not the current filters and page will include its row; the reload then
      // brings the list (and its counts) up to date.
      setFetchedSymptom(newSymptom);
      setPinnedSymptomId(newSymptom.id);
      // Replace, not push: opening the symptom just created is part of creating
      // it, not a step the owner should have to press Back through.
      updateViewParams({ symptomId: newSymptom.id }, { replace: true });
      reloadList({ options: true });
      setCreateForm(emptySymptomForm);
      setCreateMessage("Symptom saved.");
      setEditingSymptomId(null);
      setSaveState({
        saving: false,
        message: "",
        error: "",
      });
    } catch (error) {
      setCreateError(error.message || "Could not create symptom.");
    } finally {
      setCreating(false);
    }
  }

  function startEditingSymptom(symptom) {
    setEditingSymptomId(symptom.id);
    setEditForm({
      title: symptom.title || "",
      description: symptom.description || "",
      system: symptom.system || "",
      suspectedCauses: symptom.suspectedCauses || "",
      confidence: symptom.confidence || "medium",
      status: symptom.status || "open",
      notes: symptom.notes || "",
      linkedDocuments: (symptom.linkedDocuments || []).map(toLinkedDocument),
    });
    setSaveState({
      saving: false,
      message: "",
      error: "",
    });
    setDeleteState({
      deletingId: null,
      error: "",
    });
  }

  function cancelEditingSymptom() {
    setEditingSymptomId(null);
    setEditForm(emptySymptomForm);
    setSaveState({
      saving: false,
      message: "",
      error: "",
    });
  }

  function handleEditFormChange(event) {
    const { name, value } = event.target;

    setEditForm((currentForm) => ({
      ...currentForm,
      [name]: value,
    }));
  }

  function handleToggleEditDocument(document) {
    setEditForm((currentForm) => ({
      ...currentForm,
      linkedDocuments: toggleRecord(currentForm.linkedDocuments, document, toLinkedDocument),
    }));
  }

  async function handleSaveSymptom(event) {
    event.preventDefault();

    if (!editingSymptomId) {
      return;
    }

    if (!editForm.title.trim()) {
      setSaveState({
        saving: false,
        message: "",
        error: "Title is required.",
      });
      return;
    }

    try {
      setSaveState({
        saving: true,
        message: "",
        error: "",
      });

      const response = await fetch(`/api/symptoms/${editingSymptomId}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(toSymptomPayload(editForm)),
      });

      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || "Could not update symptom.");
      }

      applyUpdatedSymptom(payload.symptom);
      reloadList({ options: true });
      setSaveState({
        saving: false,
        message: "Changes saved.",
        error: "",
      });
      setEditingSymptomId(null);
    } catch (error) {
      setSaveState({
        saving: false,
        message: "",
        error: error.message || "Could not update symptom.",
      });
    }
  }

  async function handleDeleteSymptom(symptom) {
    const confirmed = window.confirm(
      `Delete "${symptom.title}"? This cannot be undone.`
    );

    if (!confirmed) {
      return;
    }

    try {
      setDeleteState({
        deletingId: symptom.id,
        error: "",
      });

      const response = await fetch(`/api/symptoms/${symptom.id}`, {
        method: "DELETE",
      });

      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || "Could not delete symptom.");
      }

      deletedSymptomIds.current.add(symptom.id);
      // The row goes at once; the reload refills the page from the server (and
      // steps back a page when this was the last row on the last one). A URL
      // that named the deleted symptom stops naming it, so the panel falls back
      // to the first row rather than looking up a record that is gone.
      setSymptoms((currentSymptoms) =>
        currentSymptoms.filter((currentSymptom) => currentSymptom.id !== symptom.id)
      );
      setFetchedSymptom((current) => (current?.id === symptom.id ? null : current));
      setPinnedSymptomId((current) => (current === symptom.id ? null : current));

      if (requestedSymptomId === symptom.id) {
        updateViewParams({ symptomId: null }, { replace: true });
      }

      reloadList({ options: true });

      if (editingSymptomId === symptom.id) {
        cancelEditingSymptom();
      }

      setDeleteState({
        deletingId: null,
        error: "",
      });
    } catch (error) {
      setDeleteState({
        deletingId: null,
        error: error.message || "Could not delete symptom.",
      });
    }
  }

  const rangeText = formatSymptomRangeText({
    libraryTotal,
    matched: matchedCount,
    from: (currentPage - 1) * SYMPTOMS_PER_PAGE + 1,
    count: symptoms.length,
  });
  const fetchingText = isFetching
    ? loadingAnotherPage
      ? `Loading page ${requestedPage}...`
      : "Updating..."
    : "";

  return (
    <>
      <PageHeader
        title="Symptoms"
        description="Track issues you observe on your Corolla, add your confidence level, and link each symptom to the documents that help you diagnose it."
      />

      <div className="space-y-6">
        <SymptomCreateForm
          form={createForm}
          pickerCache={pickerCache}
          systemSuggestions={systemSuggestions}
          creating={creating}
          createMessage={createMessage}
          createError={createError}
          onChange={handleCreateFormChange}
          onToggleDocument={handleToggleCreateDocument}
          onSubmit={handleCreateSymptom}
        />

        <div id="symptom-library" className="space-y-6" aria-busy={isFetching}>
          {!hasLoaded && !loadError ? (
            <section className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-600 shadow-sm">
              Loading symptoms...
            </section>
          ) : null}

          {loadError ? (
            <ErrorBanner title="Could not load symptoms." className="shadow-sm">
              {loadError}
              {hasLoaded ? " The symptoms below are the last ones that loaded." : null}
              <button
                type="button"
                className="mt-3 block min-h-11 rounded-md border border-red-300 bg-white px-4 text-sm font-medium text-red-800 hover:bg-red-100"
                onClick={() => reloadList()}
              >
                Try again
              </button>
            </ErrorBanner>
          ) : null}

          {hasLoaded ? (
            <>
              <SymptomsSummary
                totalCount={libraryTotal}
                visibleCount={matchedCount}
                statusCounts={statusCounts}
              />

              <SymptomsControls
                searchValue={searchValue}
                onSearchChange={(event) => setSearchValue(event.target.value)}
                statusFilter={statusFilter}
                onStatusFilterChange={(event) =>
                  handleFilterChange("status", event.target.value)
                }
                systemFilter={systemFilter}
                onSystemFilterChange={(event) =>
                  handleFilterChange("system", event.target.value)
                }
                confidenceFilter={confidenceFilter}
                onConfidenceFilterChange={(event) =>
                  handleFilterChange("confidence", event.target.value)
                }
                sortBy={sortBy}
                onSortByChange={(event) => handleFilterChange("sort", event.target.value)}
                systems={filterSystems}
                rangeText={rangeText}
                fetchingText={fetchingText}
                pager={
                  <ListPager
                    label="Symptoms pages"
                    currentPage={currentPage}
                    totalPages={totalPages}
                    onGoToPage={goToPage}
                  />
                }
                hasActiveFilters={hasActiveFilters || searchValue.trim() !== ""}
                onClearFilters={() => {
                  setSearchValue("");
                  // Clears only the filters this page owns (and the page they
                  // were on); a `symptomId` deep link, or anything else in the
                  // query string, survives.
                  updateViewParams({ ...clearFilterUpdates(SYMPTOM_FILTERS), page: null });
                }}
              />

              <ListDetailLayout
                selectedId={selectedSymptomId}
                list={
                  <SymptomsList
                    symptoms={symptoms}
                    totalSymptoms={libraryTotal}
                    hasActiveFilters={hasActiveFilters}
                    selectedSymptomId={selectedSymptomId}
                    onSelectSymptom={(symptomId) => updateViewParams({ symptomId })}
                  />
                }
                detail={
                  selectionLookupFailure ? (
                    <SymptomLookupError
                      symptomId={selectionLookupFailure.symptomId}
                      message={selectionLookupFailure.message}
                      // Clearing the failure is what lets the lookup run again.
                      onRetry={() => setLookupFailure(null)}
                    />
                  ) : (
                    <SymptomDetails
                      symptom={selectedSymptom}
                      isEditing={editingSymptomId === selectedSymptomId}
                      editForm={editForm}
                      pickerCache={pickerCache}
                      systemSuggestions={systemSuggestions}
                      saveState={saveState}
                      deleteState={deleteState}
                      onStartEdit={startEditingSymptom}
                      onCancelEdit={cancelEditingSymptom}
                      onEditChange={handleEditFormChange}
                      onToggleEditDocument={handleToggleEditDocument}
                      onSaveEdit={handleSaveSymptom}
                      onDelete={handleDeleteSymptom}
                      onSymptomUpdated={handleSymptomUpdated}
                    />
                  )
                }
              />
            </>
          ) : null}
        </div>
      </div>
    </>
  );
}
