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
import { setProcedureSymptoms } from "../lib/apiClient";
import { formatDate } from "../lib/formatDate";
import { formatLibraryTotal, formatResultRange } from "../lib/resultRange";
import { labelize } from "../lib/labelize";
import { buildEntityLink } from "../lib/navigation";
import { mergeSuggestionValues } from "../lib/suggestionUtils";
import { useScrollToHash } from "../lib/useScrollToHash";
import { ProceduresListControls } from "../components/procedures/ProceduresListControls";
import { ProceduresList } from "../components/procedures/ProceduresList";
import {
  buildProceduresListQuery,
  countProcedurePages,
  PROCEDURES_PER_PAGE,
} from "../lib/proceduresQuery";
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

// A committed keyword starts its results from page 1.
const PAGE_KEYS = ["page"];

const emptyProcedureForm = {
  title: "",
  system: "",
  difficulty: "intermediate",
  toolsNeeded: "",
  partsNeeded: "",
  safetyNotes: "",
  steps: "",
  notes: "",
  confidence: "medium",
  // Records, not ids: the picker lists what is linked even when it is not on
  // the page of results it has loaded.
  linkedDocuments: [],
};

// The filters that materially decide which procedures are on screen, and so
// belong in the URL. `system` carries no options list: its choices come from
// the owner's own procedures.
const PROCEDURE_FILTERS = {
  q: { default: "" },
  system: { default: "all" },
  difficulty: {
    default: "all",
    options: ["all", "beginner", "intermediate", "advanced"],
  },
  confidence: { default: "all", options: ["all", "high", "medium", "low"] },
  sort: { default: "newest", options: ["newest", "oldest", "title"] },
};

function describeDocument(document) {
  return `${document.system || "No system"} - ${document.documentType || "No type"}`;
}

function describeSymptom(symptom) {
  return `${symptom.system || "No system"} - ${labelize(symptom.status)}`;
}

function toLinkedDocument(document) {
  return {
    id: document.id,
    title: document.title,
    system: document.system || "",
    documentType: document.documentType || "",
  };
}

function toLinkedSymptom(symptom) {
  return {
    id: symptom.id,
    title: symptom.title,
    system: symptom.system || "",
    status: symptom.status,
  };
}

function toggleRecord(records, record, toLinkedRecord) {
  return records.some((current) => current.id === record.id)
    ? records.filter((current) => current.id !== record.id)
    : [...records, toLinkedRecord(record)];
}

// Searches the library a page at a time instead of listing every document,
// which on a real library is over a thousand checkboxes downloaded on every
// visit (N7).
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

function ProcedureCreateForm({
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
      id="create-procedure"
      className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
    >
      <h2 className="text-lg font-semibold text-slate-900">Create procedure</h2>
      <p className="mt-1 text-sm text-slate-600">
        Save one repair procedure and link it to the documents you use while doing it.
      </p>

      <form className="mt-4 grid gap-4" onSubmit={onSubmit}>
        <div className="grid gap-4 md:grid-cols-2">
          <TextField
            label="Title"
            name="title"
            value={form.title}
            onChange={onChange}
            required
            placeholder="Spark plug replacement"
          />
          <TextField
            label="System"
            name="system"
            value={form.system}
            onChange={onChange}
            placeholder="Engine, Brakes, Electrical..."
            listId="create-procedure-system-suggestions"
          />
          <SelectField
            label="Difficulty"
            name="difficulty"
            value={form.difficulty}
            onChange={onChange}
            options={[
              { value: "beginner", label: "Beginner" },
              { value: "intermediate", label: "Intermediate" },
              { value: "advanced", label: "Advanced" },
            ]}
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
        </div>

        <TextAreaField
          label="Tools needed"
          name="toolsNeeded"
          value={form.toolsNeeded}
          onChange={onChange}
          placeholder="10mm socket, spark plug socket, ratchet, torque wrench..."
        />

        <TextAreaField
          label="Parts needed"
          name="partsNeeded"
          value={form.partsNeeded}
          onChange={onChange}
          placeholder="4 spark plugs, dielectric grease..."
        />

        <TextAreaField
          label="Safety notes"
          name="safetyNotes"
          value={form.safetyNotes}
          onChange={onChange}
          placeholder="Wait for engine to cool. Disconnect battery if needed..."
        />

        <TextAreaField
          label="Steps"
          name="steps"
          value={form.steps}
          onChange={onChange}
          placeholder="1) Remove engine cover. 2) Unplug ignition coils..."
        />

        <TextAreaField
          label="Notes"
          name="notes"
          value={form.notes}
          onChange={onChange}
          placeholder="Extra context, pitfalls, or reminders."
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
            {creating ? "Saving..." : "Save procedure"}
          </button>
        </div>

        <SuggestionDatalist
          id="create-procedure-system-suggestions"
          options={systemSuggestions}
        />
      </form>
    </section>
  );
}

function ProcedureEditForm({
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
          listId="edit-procedure-system-suggestions"
        />
        <SelectField
          label="Difficulty"
          name="difficulty"
          value={form.difficulty}
          onChange={onChange}
          options={[
            { value: "beginner", label: "Beginner" },
            { value: "intermediate", label: "Intermediate" },
            { value: "advanced", label: "Advanced" },
          ]}
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
      </div>

      <TextAreaField label="Tools needed" name="toolsNeeded" value={form.toolsNeeded} onChange={onChange} />
      <TextAreaField label="Parts needed" name="partsNeeded" value={form.partsNeeded} onChange={onChange} />
      <TextAreaField label="Safety notes" name="safetyNotes" value={form.safetyNotes} onChange={onChange} />
      <TextAreaField label="Steps" name="steps" value={form.steps} onChange={onChange} />
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
        id="edit-procedure-system-suggestions"
        options={systemSuggestions}
      />
    </form>
  );
}

// Manual symptom links for one procedure (the mirror of SymptomProcedurePanel).
function ProcedureSymptomPanel({ procedure, pickerCache, onProcedureUpdated }) {
  const linkedSymptoms = procedure.linkedSymptoms || [];
  const [selectedSymptoms, setSelectedSymptoms] = useState(() =>
    linkedSymptoms.map(toLinkedSymptom)
  );
  const [saveState, setSaveState] = useState({ saving: false, message: "", error: "" });

  function toggleSymptom(symptom) {
    setSelectedSymptoms((current) => toggleRecord(current, symptom, toLinkedSymptom));
  }

  async function handleSaveLinks() {
    try {
      setSaveState({ saving: true, message: "", error: "" });
      const payload = await setProcedureSymptoms(
        procedure.id,
        selectedSymptoms.map((symptom) => symptom.id)
      );
      onProcedureUpdated(payload.procedure);
      setSelectedSymptoms((payload.procedure.linkedSymptoms || []).map(toLinkedSymptom));
      setSaveState({ saving: false, message: "Linked symptoms saved.", error: "" });
    } catch (error) {
      setSaveState({
        saving: false,
        message: "",
        error: error.message || "Could not save linked symptoms.",
      });
    }
  }

  return (
    <div>
      <h3 className="font-semibold text-slate-900">Linked symptoms</h3>

      {linkedSymptoms.length ? (
        <ul className="mt-2 space-y-2">
          {linkedSymptoms.map((symptom) => (
            <li
              key={symptom.id}
              className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-slate-700"
            >
              <Link
                className="font-medium text-sky-700 underline decoration-sky-200 underline-offset-2 hover:text-sky-900"
                to={buildEntityLink("symptom", symptom.id)}
                aria-label={`Open symptom ${symptom.title}`}
              >
                {symptom.title}
              </Link>
              <p className="text-xs text-slate-500">
                {symptom.system || "No system"} - {labelize(symptom.status)}
              </p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-slate-700">No linked symptoms yet.</p>
      )}

      <div className="mt-3">
        <RecordPicker
          legend="Link symptoms"
          endpoint="/api/search/symptoms"
          cache={pickerCache}
          selected={selectedSymptoms}
          onToggle={toggleSymptom}
          describe={describeSymptom}
          noun="symptom"
          nounPlural="symptoms"
          searchLabel="Find symptoms"
          searchPlaceholder="Search titles, systems, or causes"
          emptyLibraryText="No symptoms available yet. Create one on the Symptoms page first."
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
                  {saveState.saving ? "Saving..." : "Save linked symptoms"}
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
    </div>
  );
}

function ProcedureDetails({
  procedure,
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
  onProcedureUpdated,
}) {
  if (!procedure) {
    return (
      <section className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-600 shadow-sm">
        Select a procedure to view details.
      </section>
    );
  }

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-slate-900">{procedure.title}</h2>
          <p className="mt-1 text-sm text-slate-500">
            Updated {formatDate(procedure.updatedAt)}
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => onStartEdit(procedure)}
            className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-700"
          >
            Edit procedure
          </button>
          <button
            type="button"
            onClick={() => onDelete(procedure)}
            disabled={deleteState.deletingId === procedure.id}
            className="rounded-lg border border-red-300 px-3 py-2 text-sm font-semibold text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {deleteState.deletingId === procedure.id ? "Deleting..." : "Delete"}
          </button>
        </div>
      </div>

      <dl className="mt-5 grid gap-3 text-sm md:grid-cols-2">
        <div>
          <dt className="font-semibold text-slate-900">System</dt>
          <dd className="text-slate-700">{procedure.system || "Not set"}</dd>
        </div>
        <div>
          <dt className="font-semibold text-slate-900">Difficulty</dt>
          <dd className="text-slate-700">{labelize(procedure.difficulty)}</dd>
        </div>
        <div>
          <dt className="font-semibold text-slate-900">Confidence</dt>
          <dd className="text-slate-700">{labelize(procedure.confidence)}</dd>
        </div>
        <div>
          <dt className="font-semibold text-slate-900">Created</dt>
          <dd className="text-slate-700">{formatDate(procedure.createdAt)}</dd>
        </div>
      </dl>

      <div className="mt-5 space-y-4 text-sm">
        <div>
          <h3 className="font-semibold text-slate-900">Tools needed</h3>
          <p className="mt-2 whitespace-pre-wrap text-slate-700">
            {procedure.toolsNeeded || "No tools listed yet."}
          </p>
        </div>

        <div>
          <h3 className="font-semibold text-slate-900">Parts needed</h3>
          <p className="mt-2 whitespace-pre-wrap text-slate-700">
            {procedure.partsNeeded || "No parts listed yet."}
          </p>
        </div>

        <div>
          <h3 className="font-semibold text-slate-900">Safety notes</h3>
          <p className="mt-2 whitespace-pre-wrap text-slate-700">
            {procedure.safetyNotes || "No safety notes yet."}
          </p>
        </div>

        <div>
          <h3 className="font-semibold text-slate-900">Steps</h3>
          <p className="mt-2 whitespace-pre-wrap text-slate-700">
            {procedure.steps || "No steps yet."}
          </p>
        </div>

        <div>
          <h3 className="font-semibold text-slate-900">Notes</h3>
          <p className="mt-2 whitespace-pre-wrap text-slate-700">
            {procedure.notes || "No notes yet."}
          </p>
        </div>

        <div>
          <h3 className="font-semibold text-slate-900">Linked documents</h3>
          {(procedure.linkedDocuments || []).length ? (
            <ul className="mt-2 space-y-2">
              {(procedure.linkedDocuments || []).map((document) => (
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

        <ProcedureSymptomPanel
          key={procedure.id}
          procedure={procedure}
          pickerCache={pickerCache}
          onProcedureUpdated={onProcedureUpdated}
        />

        <AttachmentPanel key={`attachments-${procedure.id}`} entityType="procedure" entityId={procedure.id} />
      </div>

      {isEditing ? (
        <ProcedureEditForm
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

      {deleteState.error ? <ErrorBanner className="mt-4">{deleteState.error}</ErrorBanner> : null}
    </section>
  );
}

function toProcedurePayload(form) {
  return {
    title: form.title,
    system: form.system,
    difficulty: form.difficulty,
    toolsNeeded: form.toolsNeeded,
    partsNeeded: form.partsNeeded,
    safetyNotes: form.safetyNotes,
    steps: form.steps,
    notes: form.notes,
    confidence: form.confidence,
    linkedDocumentIds: form.linkedDocuments.map((document) => document.id),
  };
}

// Mirrors the Symptoms page (N7): the server filters, sorts, counts, and slices
// the list, so this page holds one page of rows and never the whole library.
function ProcedureLookupError({ procedureId, message, onRetry }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <ErrorBanner title={`Could not load procedure #${procedureId}.`}>
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

export function ProceduresPage() {
  useScrollToHash();

  const [searchParams, setSearchParams] = useSearchParams();
  const requestedProcedureId = readIdParam(searchParams, "procedureId");
  const requestedPage = readPageParam(searchParams);
  // `procedures` is the ONE PAGE the server last sent -- never the whole list.
  // The server also owns the counts: `matchedCount` is how many procedures the
  // current filters leave; `libraryTotal` is every procedure.
  const [procedures, setProcedures] = useState([]);
  const [matchedCount, setMatchedCount] = useState(0);
  const [libraryTotal, setLibraryTotal] = useState(0);
  // Which request the rows above answer. Anything that reasons about "this view"
  // (clamping the page, resolving the selection) waits until it equals the
  // current request, so a stale page can never be mistaken for the new one.
  const [settledQuery, setSettledQuery] = useState(null);
  // The page the rows on screen belong to; the counter and pager describe THESE
  // rows while a new page loads or after it failed to.
  const [settledPage, setSettledPage] = useState(DEFAULT_PAGE);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [isFetching, setIsFetching] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [reloadToken, setReloadToken] = useState(0);
  const latestListRequest = useRef(0);
  // The System filter's choices, from every procedure rather than the loaded page.
  const [filterSystems, setFilterSystems] = useState([]);
  const [optionsToken, setOptionsToken] = useState(0);
  const [savedCommonSystems, setSavedCommonSystems] = useState([]);
  // The selected procedure when its row is not on the current page (a deep link,
  // a procedure just created that a filter hides).
  const [fetchedProcedure, setFetchedProcedure] = useState(null);
  // A by-id lookup that failed for a reason other than "no such procedure":
  // `{ procedureId, message }`.
  const [lookupFailure, setLookupFailure] = useState(null);
  // A selection this page made before the URL has caught up with it.
  const [pinnedProcedureId, setPinnedProcedureId] = useState(null);
  // Shared by every picker on the page, so opening another procedure or the
  // edit form does not ask for the same first page again.
  const pickerCache = useRef(new Map()).current;
  // Procedures this page deleted: a lookup for one could only answer 404.
  const deletedProcedureIds = useRef(new Set());

  const [createForm, setCreateForm] = useState(emptyProcedureForm);
  const [creating, setCreating] = useState(false);
  const [createMessage, setCreateMessage] = useState("");
  const [createError, setCreateError] = useState("");

  const [editingProcedureId, setEditingProcedureId] = useState(null);
  const [editForm, setEditForm] = useState(emptyProcedureForm);
  const [saveState, setSaveState] = useState({
    saving: false,
    message: "",
    error: "",
  });
  const [deleteState, setDeleteState] = useState({
    deletingId: null,
    error: "",
  });
  // One writer for every URL change this page makes, so two writes close
  // together (the keyword box committing as a filter changes, a delete clearing
  // `procedureId`, then the refetch clamping `page`) both land.
  const updateViewParams = useViewParamWriter(searchParams, setSearchParams);

  const {
    q: committedSearch,
    system: systemFilter,
    difficulty: difficultyFilter,
    confidence: confidenceFilter,
    sort: sortBy,
  } = readFilterValues(searchParams, PROCEDURE_FILTERS);
  // The keyword box types into local state and lands in the URL a beat later, so
  // "brake" is one view and one request rather than five.
  const [searchValue, setSearchValue] = useDraftTextParam("q", {
    searchParams,
    writeParams: updateViewParams,
    clearOnCommit: PAGE_KEYS,
  });
  // The pin outranks the URL: it only exists while a selection this page made
  // has not reached the URL yet.
  const selectionId = pinnedProcedureId ?? requestedProcedureId;

  // The request is a pure function of the view state in the URL, and that string
  // is the only thing the fetch effect depends on.
  const listQuery = buildProceduresListQuery({
    q: committedSearch,
    system: systemFilter,
    difficulty: difficultyFilter,
    confidence: confidenceFilter,
    sort: sortBy,
    page: requestedPage,
  });
  const dataIsCurrent = settledQuery === listQuery;
  const totalPages = countProcedurePages(matchedCount);
  const currentPage = Math.min(settledPage, totalPages);
  const loadingAnotherPage = isFetching && !dataIsCurrent && requestedPage !== currentPage;

  // Changing a filter is a navigation step the owner should be able to undo, so
  // it pushes -- and it drops `page`, because page 4 of the old filter says
  // nothing about the new one.
  function handleFilterChange(key, value) {
    updateViewParams({
      ...filterValueUpdates({ [key]: value }, PROCEDURE_FILTERS),
      page: null,
    });
  }

  // Previous/Next act on the page the owner can see. When that lands on the page
  // the URL already asks for -- its load is in flight or just failed -- ask the
  // server again rather than navigating nowhere.
  function goToPage(targetPage) {
    if (targetPage === requestedPage) {
      if (!isFetching) {
        reloadList();
      }
      return;
    }

    updateViewParams({ page: pageParamValue(targetPage) });
  }

  const systemSuggestions = useMemo(
    () => mergeSuggestionValues([...savedCommonSystems, ...filterSystems]),
    [savedCommonSystems, filterSystems]
  );

  const hasActiveFilters =
    committedSearch.trim() !== "" ||
    systemFilter !== "all" ||
    difficultyFilter !== "all" ||
    confidenceFilter !== "all";

  // The selected procedure is derived, not stored. No `procedureId` means "the
  // first procedure" -- the first row of the page on screen -- spelled as the
  // absence of a parameter. A `procedureId` whose row is not on this page is
  // fetched on its own below, so a deep link opens its record under any filter
  // or page.
  const rowProcedure = selectionId
    ? procedures.find((procedure) => procedure.id === selectionId)
    : null;
  const fetchedMatch =
    selectionId && fetchedProcedure?.id === selectionId ? fetchedProcedure : null;
  const selectedProcedure = selectionId
    ? rowProcedure || fetchedMatch || null
    : procedures[0] || null;
  const selectedProcedureId = selectedProcedure?.id ?? null;
  const selectionLookupFailure =
    selectionId && !selectedProcedure && lookupFailure?.procedureId === selectionId
      ? lookupFailure
      : null;

  // Normalization only, so it replaces rather than pushing. Waits until the rows
  // on screen answer THIS request -- before that, the page count belongs to
  // another view.
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

  // An unusable `procedureId` ("abc", "0") names nothing, so it drops out of the
  // URL. Only that parameter is touched; the filters stay as they are.
  useEffect(() => {
    if (!dataIsCurrent || !searchParams.has("procedureId") || requestedProcedureId) {
      return;
    }

    updateViewParams({ procedureId: null }, { replace: true });
  }, [dataIsCurrent, requestedProcedureId, searchParams, updateViewParams]);

  // A well-formed `procedureId` whose row is not on this page is looked up by
  // id. The server's 404 is what says it does not exist -- deleted, or
  // hand-typed -- and only then does the parameter drop out of the URL. A
  // procedure that exists but that the filters hide keeps its parameter.
  const requestedRowIsOnPage = Boolean(rowProcedure);
  useEffect(() => {
    if (
      !selectionId ||
      !dataIsCurrent ||
      requestedRowIsOnPage ||
      fetchedProcedure?.id === selectionId ||
      lookupFailure?.procedureId === selectionId
    ) {
      return undefined;
    }

    // Deleted here, so the server would only say 404: answer that without asking.
    if (deletedProcedureIds.current.has(selectionId)) {
      setPinnedProcedureId(null);
      updateViewParams({ procedureId: null }, { replace: true });
      return undefined;
    }

    let cancelled = false;

    async function lookUpProcedure() {
      try {
        const response = await fetch(`/api/procedures/${selectionId}`);
        const payload = await response.json().catch(() => ({}));

        if (cancelled) {
          return;
        }

        if (response.status === 404) {
          setFetchedProcedure(null);
          setPinnedProcedureId(null);
          updateViewParams({ procedureId: null }, { replace: true });
          return;
        }

        if (!response.ok || !payload.procedure) {
          throw new Error(payload.error || "The server could not load it.");
        }

        setFetchedProcedure(payload.procedure);
      } catch (error) {
        if (!cancelled) {
          setLookupFailure({
            procedureId: selectionId,
            message:
              error instanceof TypeError
                ? "The server could not be reached."
                : error.message || "The server could not load it.",
          });
        }
      }
    }

    lookUpProcedure();

    return () => {
      cancelled = true;
    };
  }, [
    selectionId,
    dataIsCurrent,
    requestedRowIsOnPage,
    fetchedProcedure,
    lookupFailure,
    updateViewParams,
  ]);

  // A failed lookup is remembered only for the visit it failed on.
  useEffect(() => {
    setLookupFailure(null);
  }, [selectionId]);

  // The pin's job is done once the URL names a procedure itself, and it never
  // outlives the view it was made in.
  useEffect(() => {
    setPinnedProcedureId(null);
  }, [requestedProcedureId, listQuery]);

  // An edit form belongs to the procedure it was opened on. Moving the selection
  // any other way closes it instead of leaving it armed for another record.
  useEffect(() => {
    setEditingProcedureId((currentId) =>
      currentId && currentId !== selectedProcedureId ? null : currentId
    );
  }, [selectedProcedureId]);

  // One request per view. The fetch depends on the request string alone, so a
  // filter, sort, keyword, or page change is exactly one fetch, a selection
  // change within the page is none. Rows from the previous view stay on screen
  // until the new ones arrive.
  useEffect(() => {
    const requestId = latestListRequest.current + 1;
    latestListRequest.current = requestId;

    async function loadProcedures() {
      setIsFetching(true);
      // Set when this answer hands over to another request instead of settling.
      let handedOff = false;

      try {
        const response = await fetch(`/api/procedures?${listQuery}`);
        const payload = await response.json();

        // A newer view has been asked for since: this answer is stale.
        if (requestId !== latestListRequest.current) {
          return;
        }

        if (!response.ok) {
          throw new Error(payload.error || "Could not load procedures.");
        }

        const nextProcedures = Array.isArray(payload.procedures) ? payload.procedures : [];
        const nextMatched = Number.isFinite(payload.matched)
          ? payload.matched
          : nextProcedures.length;
        const offset = Number(new URLSearchParams(listQuery).get("offset")) || 0;

        // A page past the end (a hand-typed `page=9`, or the last page after its
        // only row was deleted) answers with no rows while procedures do match.
        // That empty answer is never shown as the list: the URL moves to the
        // last real page, and that request's answer is the one that settles.
        if (!nextProcedures.length && nextMatched > 0 && offset >= nextMatched) {
          handedOff = true;
          updateViewParams(
            { page: pageParamValue(countProcedurePages(nextMatched)) },
            { replace: true }
          );
          return;
        }

        setProcedures(nextProcedures);
        setSettledPage(Math.floor(offset / PROCEDURES_PER_PAGE) + 1);
        setMatchedCount(nextMatched);
        setLibraryTotal(Number.isFinite(payload.total) ? payload.total : nextMatched);
        setSettledQuery(listQuery);
        setLoadError("");
        setHasLoaded(true);
      } catch (error) {
        if (requestId === latestListRequest.current) {
          setLoadError(
            error instanceof TypeError
              ? "The server could not be reached."
              : error.message || "Could not load procedures."
          );
        }
      } finally {
        if (requestId === latestListRequest.current && !handedOff) {
          setIsFetching(false);
        }
      }
    }

    loadProcedures();

    // Leaving the page, or asking for another view, makes this answer stale.
    return () => {
      latestListRequest.current += 1;
    };
  }, [listQuery, reloadToken, updateViewParams]);

  useEffect(() => {
    let cancelled = false;

    async function loadFilterOptions() {
      try {
        const response = await fetch("/api/procedures/filter-options");
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

  // A saved procedure reaches its row and the by-id copy immediately; the
  // reload that follows lets the server decide whether it still belongs here.
  //
  // Every save bumps `updated_at`, so a sort by last update reorders the page.
  // When the selection is only implicit (the page's first row), that reorder
  // would hand the panel to a different procedure, so the one ON DISPLAY is
  // pinned into the URL first and kept as the by-id copy.
  function applyUpdatedProcedure(updatedProcedure) {
    const displayedProcedure = selectedProcedure;
    const isDisplayed = updatedProcedure.id === displayedProcedure?.id;
    const pinDisplayed = Boolean(displayedProcedure) && !requestedProcedureId;

    setProcedures((currentProcedures) =>
      currentProcedures.map((procedure) =>
        procedure.id === updatedProcedure.id ? updatedProcedure : procedure
      )
    );
    setFetchedProcedure((currentProcedure) => {
      if (isDisplayed || currentProcedure?.id === updatedProcedure.id) {
        return updatedProcedure;
      }

      return pinDisplayed ? displayedProcedure : currentProcedure;
    });

    if (pinDisplayed) {
      setPinnedProcedureId(displayedProcedure.id);
      updateViewParams({ procedureId: displayedProcedure.id }, { replace: true });
    }
  }

  // Keep the list and detail panel in sync after a symptom link change. Links do
  // not touch the procedure's own row, so the page needs no reload for them.
  function handleProcedureUpdated(updatedProcedure) {
    if (!updatedProcedure) {
      return;
    }

    applyUpdatedProcedure(updatedProcedure);
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

  async function handleCreateProcedure(event) {
    event.preventDefault();

    if (!createForm.title.trim()) {
      setCreateError("Title is required.");
      return;
    }

    try {
      setCreating(true);
      setCreateError("");
      setCreateMessage("");

      const response = await fetch("/api/procedures", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(toProcedurePayload(createForm)),
      });

      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || "Could not create procedure.");
      }

      const newProcedure = payload.procedure;

      // The new procedure is shown at once from the server's answer, whether or
      // not the current filters and page will include its row; the reload then
      // brings the list (and its counts) up to date.
      setFetchedProcedure(newProcedure);
      setPinnedProcedureId(newProcedure.id);
      // Replace, not push: opening the procedure just created is part of
      // creating it, not a step to press Back through.
      updateViewParams({ procedureId: newProcedure.id }, { replace: true });
      reloadList({ options: true });
      setCreateForm(emptyProcedureForm);
      setCreateMessage("Procedure saved.");
      setEditingProcedureId(null);
      setSaveState({
        saving: false,
        message: "",
        error: "",
      });
    } catch (error) {
      setCreateError(error.message || "Could not create procedure.");
    } finally {
      setCreating(false);
    }
  }

  function startEditingProcedure(procedure) {
    setEditingProcedureId(procedure.id);
    setEditForm({
      title: procedure.title || "",
      system: procedure.system || "",
      difficulty: procedure.difficulty || "intermediate",
      toolsNeeded: procedure.toolsNeeded || "",
      partsNeeded: procedure.partsNeeded || "",
      safetyNotes: procedure.safetyNotes || "",
      steps: procedure.steps || "",
      notes: procedure.notes || "",
      confidence: procedure.confidence || "medium",
      linkedDocuments: (procedure.linkedDocuments || []).map(toLinkedDocument),
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

  function cancelEditingProcedure() {
    setEditingProcedureId(null);
    setEditForm(emptyProcedureForm);
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

  async function handleSaveProcedure(event) {
    event.preventDefault();

    if (!editingProcedureId) {
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

      const response = await fetch(`/api/procedures/${editingProcedureId}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(toProcedurePayload(editForm)),
      });

      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || "Could not update procedure.");
      }

      applyUpdatedProcedure(payload.procedure);
      reloadList({ options: true });
      setSaveState({
        saving: false,
        message: "Changes saved.",
        error: "",
      });
      setEditingProcedureId(null);
    } catch (error) {
      setSaveState({
        saving: false,
        message: "",
        error: error.message || "Could not update procedure.",
      });
    }
  }

  async function handleDeleteProcedure(procedure) {
    const confirmed = window.confirm(
      `Delete "${procedure.title}"? This cannot be undone.`
    );

    if (!confirmed) {
      return;
    }

    try {
      setDeleteState({
        deletingId: procedure.id,
        error: "",
      });

      const response = await fetch(`/api/procedures/${procedure.id}`, {
        method: "DELETE",
      });

      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || "Could not delete procedure.");
      }

      deletedProcedureIds.current.add(procedure.id);
      // The row goes at once; the reload refills the page from the server (and
      // steps back a page when this was the last row on the last one). A URL
      // that named the deleted procedure stops naming it, so the panel falls
      // back to the first row rather than looking up a record that is gone.
      setProcedures((currentProcedures) =>
        currentProcedures.filter((currentProcedure) => currentProcedure.id !== procedure.id)
      );
      setFetchedProcedure((current) => (current?.id === procedure.id ? null : current));
      setPinnedProcedureId((current) => (current === procedure.id ? null : current));

      if (requestedProcedureId === procedure.id) {
        updateViewParams({ procedureId: null }, { replace: true });
      }

      reloadList({ options: true });

      if (editingProcedureId === procedure.id) {
        cancelEditingProcedure();
      }

      setDeleteState({
        deletingId: null,
        error: "",
      });
    } catch (error) {
      setDeleteState({
        deletingId: null,
        error: error.message || "Could not delete procedure.",
      });
    }
  }

  const rangeText = formatResultRange({
    from: (currentPage - 1) * PROCEDURES_PER_PAGE + 1,
    to: (currentPage - 1) * PROCEDURES_PER_PAGE + procedures.length,
    total: matchedCount,
    noun: "procedure",
    nounPlural: "procedures",
    emptyText: libraryTotal ? "No procedures match these filters." : "No procedures yet.",
  });
  const fetchingText = isFetching
    ? loadingAnotherPage
      ? `Loading page ${requestedPage}...`
      : "Updating..."
    : "";

  return (
    <>
      <PageHeader
        title="Procedures"
        description="Track repair procedures for your Corolla, including tools, parts, safety notes, and steps, then link each procedure to helpful documents."
      />

      <div className="space-y-6">
        <ProcedureCreateForm
          form={createForm}
          pickerCache={pickerCache}
          systemSuggestions={systemSuggestions}
          creating={creating}
          createMessage={createMessage}
          createError={createError}
          onChange={handleCreateFormChange}
          onToggleDocument={handleToggleCreateDocument}
          onSubmit={handleCreateProcedure}
        />

        <div id="procedure-library" className="space-y-6" aria-busy={isFetching}>
          {!hasLoaded && !loadError ? (
            <section className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-600 shadow-sm">
              Loading procedures...
            </section>
          ) : null}

          {loadError ? (
            <ErrorBanner title="Could not load procedures." className="shadow-sm">
              {loadError}
              {hasLoaded ? " The procedures below are the last ones that loaded." : null}
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
              <section className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600 shadow-sm">
                {formatLibraryTotal({
                  total: libraryTotal,
                  noun: "procedure",
                  nounPlural: "procedures",
                })}
              </section>

              <ProceduresListControls
                searchValue={searchValue}
                onSearchChange={(event) => setSearchValue(event.target.value)}
                systemFilter={systemFilter}
                onSystemFilterChange={(event) =>
                  handleFilterChange("system", event.target.value)
                }
                difficultyFilter={difficultyFilter}
                onDifficultyFilterChange={(event) =>
                  handleFilterChange("difficulty", event.target.value)
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
                    label="Procedures pages"
                    currentPage={currentPage}
                    totalPages={totalPages}
                    onGoToPage={goToPage}
                  />
                }
                hasActiveFilters={hasActiveFilters || searchValue.trim() !== ""}
                onClearFilters={() => {
                  setSearchValue("");
                  // Clears only the filters this page owns (and the page they
                  // were on); a `procedureId` deep link survives.
                  updateViewParams({ ...clearFilterUpdates(PROCEDURE_FILTERS), page: null });
                }}
              />

              <ListDetailLayout
                selectedId={selectedProcedureId}
                list={
                  <ProceduresList
                    procedures={procedures}
                    totalProcedures={libraryTotal}
                    hasActiveFilters={hasActiveFilters}
                    selectedProcedureId={selectedProcedureId}
                    onSelectProcedure={(procedureId) => updateViewParams({ procedureId })}
                  />
                }
                detail={
                  selectionLookupFailure ? (
                    <ProcedureLookupError
                      procedureId={selectionLookupFailure.procedureId}
                      message={selectionLookupFailure.message}
                      // Clearing the failure is what lets the lookup run again.
                      onRetry={() => setLookupFailure(null)}
                    />
                  ) : (
                    <ProcedureDetails
                      procedure={selectedProcedure}
                      isEditing={editingProcedureId === selectedProcedureId}
                      editForm={editForm}
                      pickerCache={pickerCache}
                      systemSuggestions={systemSuggestions}
                      saveState={saveState}
                      deleteState={deleteState}
                      onStartEdit={startEditingProcedure}
                      onCancelEdit={cancelEditingProcedure}
                      onEditChange={handleEditFormChange}
                      onToggleEditDocument={handleToggleEditDocument}
                      onSaveEdit={handleSaveProcedure}
                      onDelete={handleDeleteProcedure}
                      onProcedureUpdated={handleProcedureUpdated}
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
