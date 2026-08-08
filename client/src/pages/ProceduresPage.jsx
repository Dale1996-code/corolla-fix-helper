import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AttachmentPanel } from "../components/AttachmentPanel";
import { PageHeader } from "../components/PageHeader";
import { ListDetailLayout } from "../components/ListDetailLayout";
import { ErrorBanner, SuccessBanner } from "../components/feedback/Banner";
import {
  SelectField,
  SuggestionDatalist,
  TextAreaField,
  TextField,
} from "../components/forms/FormFields";
import { setProcedureSymptoms } from "../lib/apiClient";
import { formatDate, getSortTimestamp } from "../lib/formatDate";
import { formatLibraryTotal } from "../lib/resultRange";
import { labelize } from "../lib/labelize";
import { buildEntityLink } from "../lib/navigation";
import { mergeSuggestionValues } from "../lib/suggestionUtils";
import { useScrollToHash } from "../lib/useScrollToHash";
import { ProceduresListControls } from "../components/procedures/ProceduresListControls";
import { ProceduresList } from "../components/procedures/ProceduresList";
import {
  applyParamUpdates,
  clearFilterUpdates,
  filterValueUpdates,
  readFilterValues,
  readIdParam,
  resolveSelectedRecord,
  useDraftTextParam,
} from "../lib/urlState";

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
  linkedDocumentIds: [],
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

function compareProcedures(firstProcedure, secondProcedure, sortBy) {
  if (sortBy === "oldest") {
    return getSortTimestamp(firstProcedure) - getSortTimestamp(secondProcedure);
  }

  if (sortBy === "title") {
    return firstProcedure.title.localeCompare(secondProcedure.title);
  }

  return getSortTimestamp(secondProcedure) - getSortTimestamp(firstProcedure);
}

function matchesSearch(procedure, query) {
  if (!query) {
    return true;
  }

  const searchableFields = [
    procedure.title,
    procedure.system,
    procedure.toolsNeeded,
    procedure.partsNeeded,
    procedure.notes,
    procedure.steps,
  ];

  return searchableFields.some((value) => value?.toLowerCase().includes(query));
}

function LinkedDocumentsSelector({
  documents,
  selectedIds,
  onToggle,
  disabled = false,
}) {
  return (
    <fieldset className="grid gap-2 text-sm text-slate-700">
      <legend className="font-medium text-slate-900">Linked documents</legend>

      {documents.length === 0 ? (
        <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
          No documents available yet. Upload a PDF on the Documents page first.
        </p>
      ) : (
        <div className="max-h-48 space-y-2 overflow-y-auto rounded-xl border border-slate-200 bg-slate-50 p-3">
          {documents.map((document) => {
            const checked = selectedIds.includes(document.id);

            return (
              <label key={document.id} className="flex items-start gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={disabled}
                  onChange={() => onToggle(document.id)}
                />
                <span>
                  <span className="font-medium text-slate-900">{document.title}</span>
                  <span className="block text-xs text-slate-500">
                    {document.system} - {document.documentType}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      )}
    </fieldset>
  );
}

function ProcedureCreateForm({
  form,
  documents,
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
          documents={documents}
          selectedIds={form.linkedDocumentIds}
          onToggle={onToggleDocument}
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
  documents,
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
        documents={documents}
        selectedIds={form.linkedDocumentIds}
        onToggle={onToggleDocument}
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
function ProcedureSymptomPanel({ procedure, symptoms, onProcedureUpdated }) {
  const linkedSymptoms = procedure.linkedSymptoms || [];
  const [selectedIds, setSelectedIds] = useState(procedure.linkedSymptomIds || []);
  const [saveState, setSaveState] = useState({ saving: false, message: "", error: "" });

  function toggleSymptom(symptomId) {
    setSelectedIds((current) =>
      current.includes(symptomId)
        ? current.filter((id) => id !== symptomId)
        : [...current, symptomId]
    );
  }

  async function handleSaveLinks() {
    try {
      setSaveState({ saving: true, message: "", error: "" });
      const payload = await setProcedureSymptoms(procedure.id, selectedIds);
      onProcedureUpdated(payload.procedure);
      setSelectedIds(payload.procedure.linkedSymptomIds || []);
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

      <fieldset className="mt-3 grid gap-2 text-sm text-slate-700">
        <legend className="font-medium text-slate-900">Link symptoms</legend>

        {symptoms.length === 0 ? (
          <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
            No symptoms available yet. Create one on the Symptoms page first.
          </p>
        ) : (
          <div className="max-h-48 space-y-2 overflow-y-auto rounded-xl border border-slate-200 bg-slate-50 p-3">
            {symptoms.map((symptom) => (
              <label
                key={symptom.id}
                className="flex items-start gap-2 text-sm text-slate-700"
              >
                <input
                  type="checkbox"
                  checked={selectedIds.includes(symptom.id)}
                  disabled={saveState.saving}
                  onChange={() => toggleSymptom(symptom.id)}
                />
                <span>
                  <span className="font-medium text-slate-900">{symptom.title}</span>
                  <span className="block text-xs text-slate-500">
                    {symptom.system || "No system"} - {labelize(symptom.status)}
                  </span>
                </span>
              </label>
            ))}
          </div>
        )}

        {symptoms.length > 0 ? (
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
        ) : null}

        {saveState.error ? <ErrorBanner>{saveState.error}</ErrorBanner> : null}
      </fieldset>
    </div>
  );
}

function ProcedureDetails({
  procedure,
  isEditing,
  editForm,
  documents,
  symptoms,
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
          symptoms={symptoms}
          onProcedureUpdated={onProcedureUpdated}
        />

        <AttachmentPanel key={`attachments-${procedure.id}`} entityType="procedure" entityId={procedure.id} />
      </div>

      {isEditing ? (
        <ProcedureEditForm
          form={editForm}
          documents={documents}
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
    linkedDocumentIds: form.linkedDocumentIds,
  };
}

export function ProceduresPage() {
  useScrollToHash();

  const [searchParams, setSearchParams] = useSearchParams();
  const requestedProcedureId = readIdParam(searchParams, "procedureId");
  const [procedures, setProcedures] = useState([]);
  const [documents, setDocuments] = useState([]);
  const [symptoms, setSymptoms] = useState([]);
  const [savedCommonSystems, setSavedCommonSystems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

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
  // Filters read from the URL, so Back returns to the filtered list rather than
  // to an unfiltered one. The keyword box types locally and lands in the URL a
  // beat later (see useDraftTextParam), so typing does not fill up history.
  const {
    system: systemFilter,
    difficulty: difficultyFilter,
    confidence: confidenceFilter,
    sort: sortBy,
  } = readFilterValues(searchParams, PROCEDURE_FILTERS);
  const [searchValue, setSearchValue] = useDraftTextParam("q", {
    searchParams,
    setSearchParams,
  });

  const updateViewParams = useCallback(
    (updates, { replace = false } = {}) => {
      setSearchParams((currentParams) => applyParamUpdates(currentParams, updates), {
        replace,
      });
    },
    [setSearchParams]
  );

  function handleFilterChange(key, value) {
    updateViewParams(filterValueUpdates({ [key]: value }, PROCEDURE_FILTERS));
  }

  const availableSystems = useMemo(
    () =>
      Array.from(new Set(procedures.map((procedure) => procedure.system).filter(Boolean))).sort(
        (a, b) => a.localeCompare(b)
      ),
    [procedures]
  );

  const filteredProcedures = useMemo(() => {
    const normalizedQuery = searchValue.trim().toLowerCase();

    return [...procedures]
      .filter((procedure) => {
        if (!matchesSearch(procedure, normalizedQuery)) {
          return false;
        }

        if (systemFilter !== "all" && procedure.system !== systemFilter) {
          return false;
        }

        if (difficultyFilter !== "all" && procedure.difficulty !== difficultyFilter) {
          return false;
        }

        if (confidenceFilter !== "all" && procedure.confidence !== confidenceFilter) {
          return false;
        }

        return true;
      })
      .sort((firstProcedure, secondProcedure) =>
        compareProcedures(firstProcedure, secondProcedure, sortBy)
      );
  }, [procedures, searchValue, systemFilter, difficultyFilter, confidenceFilter, sortBy]);

  const hasActiveFilters =
    searchValue.trim() !== "" ||
    systemFilter !== "all" ||
    difficultyFilter !== "all" ||
    confidenceFilter !== "all" ||
    sortBy !== "newest";

  // Derived from the URL and the list rather than stored. No `procedureId`
  // means the page's existing default (see resolveSelectedRecord), now spelled
  // as an absent parameter so an untouched list keeps a clean `/procedures`.
  const selectedProcedure = useMemo(
    () => resolveSelectedRecord(requestedProcedureId, procedures, filteredProcedures),
    [requestedProcedureId, procedures, filteredProcedures]
  );
  const selectedProcedureId = selectedProcedure?.id ?? null;

  const systemSuggestions = useMemo(() => {
    return mergeSuggestionValues([
      ...savedCommonSystems,
      ...procedures.map((procedure) => procedure.system),
    ]);
  }, [savedCommonSystems, procedures]);

  function toggleLinkedDocument(selectedIds, documentId) {
    if (selectedIds.includes(documentId)) {
      return selectedIds.filter((id) => id !== documentId);
    }

    return [...selectedIds, documentId];
  }

  // Keep the list and detail panel in sync after a symptom link change.
  function handleProcedureUpdated(updatedProcedure) {
    if (!updatedProcedure) {
      return;
    }

    setProcedures((currentProcedures) =>
      currentProcedures.map((procedure) =>
        procedure.id === updatedProcedure.id ? updatedProcedure : procedure
      )
    );
  }

  async function loadData() {
    try {
      setLoadError("");
      setLoading(true);

      const [proceduresResponse, documentsResponse] = await Promise.all([
        fetch("/api/procedures"),
        fetch("/api/documents"),
      ]);

      const proceduresPayload = await proceduresResponse.json();
      const documentsPayload = await documentsResponse.json();

      if (!proceduresResponse.ok) {
        throw new Error(proceduresPayload.error || "Could not load procedures.");
      }

      if (!documentsResponse.ok) {
        throw new Error(documentsPayload.error || "Could not load documents.");
      }

      const nextProcedures = Array.isArray(proceduresPayload.procedures)
        ? proceduresPayload.procedures
        : [];
      const nextDocuments = Array.isArray(documentsPayload.documents)
        ? documentsPayload.documents
        : [];

      setProcedures(nextProcedures);
      setDocuments(nextDocuments);

      // Symptoms power the manual link selector; a failure here should not
      // block the procedure list, so it loads on its own.
      try {
        const symptomsResponse = await fetch("/api/symptoms");
        const symptomsPayload = await symptomsResponse.json();

        if (symptomsResponse.ok) {
          setSymptoms(
            Array.isArray(symptomsPayload.symptoms) ? symptomsPayload.symptoms : []
          );
        }
      } catch {
        setSymptoms([]);
      }

      try {
        const settingsResponse = await fetch("/api/settings");
        const settingsPayload = await settingsResponse.json();

        if (settingsResponse.ok) {
          setSavedCommonSystems(settingsPayload.documentDefaults?.commonSystems || []);
        }
      } catch {
        setSavedCommonSystems([]);
      }
    } catch (error) {
      setLoadError(error.message || "Could not load procedure data.");
    } finally {
      setLoading(false);
    }
  }

  // Loaded once. Filtering, sorting, and picking a procedure all work on this
  // list, so URL changes -- including Back and Forward -- never refetch.
  useEffect(() => {
    loadData();
  }, []);

  // A `procedureId` for a procedure that is not in the library -- deleted, or
  // hand-typed, well-formed or not -- drops out of the URL so the address stops
  // naming a record that does not exist. A procedure that exists but is hidden
  // by the current filter keeps its parameter: the filter is doing the hiding,
  // and loosening it should bring the owner's selection back.
  useEffect(() => {
    if (loading || loadError || !searchParams.has("procedureId")) {
      return;
    }

    const namesALoadedProcedure =
      requestedProcedureId &&
      procedures.some((procedure) => procedure.id === requestedProcedureId);

    if (!namesALoadedProcedure) {
      updateViewParams({ procedureId: null }, { replace: true });
    }
  }, [loading, loadError, requestedProcedureId, procedures, searchParams, updateViewParams]);

  function handleCreateFormChange(event) {
    const { name, value } = event.target;

    setCreateForm((currentForm) => ({
      ...currentForm,
      [name]: value,
    }));
  }

  function handleToggleCreateDocument(documentId) {
    setCreateForm((currentForm) => ({
      ...currentForm,
      linkedDocumentIds: toggleLinkedDocument(currentForm.linkedDocumentIds, documentId),
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

      setProcedures((currentProcedures) => [newProcedure, ...currentProcedures]);
      // Replace, not push: opening the procedure just created is part of
      // creating it, not a step to press Back through.
      updateViewParams({ procedureId: newProcedure.id }, { replace: true });
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
      linkedDocumentIds: procedure.linkedDocumentIds || [],
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

  function handleToggleEditDocument(documentId) {
    setEditForm((currentForm) => ({
      ...currentForm,
      linkedDocumentIds: toggleLinkedDocument(currentForm.linkedDocumentIds, documentId),
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

      const updatedProcedure = payload.procedure;

      setProcedures((currentProcedures) =>
        currentProcedures.map((procedure) =>
          procedure.id === updatedProcedure.id ? updatedProcedure : procedure
        )
      );
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

      // Dropping the row is enough: the deleted id no longer matches anything,
      // so the detail panel falls back to the first remaining procedure and the
      // normalization effect clears the stale `procedureId` from the URL.
      setProcedures((currentProcedures) =>
        currentProcedures.filter((currentProcedure) => currentProcedure.id !== procedure.id)
      );

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

  return (
    <>
      <PageHeader
        title="Procedures"
        description="Track repair procedures for your Corolla, including tools, parts, safety notes, and steps, then link each procedure to helpful documents."
      />

      <div className="space-y-6">
        <ProcedureCreateForm
          form={createForm}
          documents={documents}
          systemSuggestions={systemSuggestions}
          creating={creating}
          createMessage={createMessage}
          createError={createError}
          onChange={handleCreateFormChange}
          onToggleDocument={handleToggleCreateDocument}
          onSubmit={handleCreateProcedure}
        />

        <div id="procedure-library" className="space-y-6">
          {loading ? (
            <section className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-600 shadow-sm">
              Loading procedures...
            </section>
          ) : null}

          {loadError ? (
            <ErrorBanner title="Could not load procedures." className="shadow-sm">
              {loadError}
            </ErrorBanner>
          ) : null}

          {!loading && !loadError ? (
            <>
              <section className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600 shadow-sm">
                {formatLibraryTotal({
                  total: procedures.length,
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
                systems={availableSystems}
                totalCount={procedures.length}
                visibleCount={filteredProcedures.length}
                hasActiveFilters={hasActiveFilters}
                onClearFilters={() => {
                  setSearchValue("");
                  // Clears only the filters this page owns; a `procedureId`
                  // deep link (or anything else in the URL) survives.
                  updateViewParams(clearFilterUpdates(PROCEDURE_FILTERS));
                }}
              />

              <ListDetailLayout
                selectedId={selectedProcedureId}
                list={
                  <ProceduresList
                    procedures={filteredProcedures}
                    totalProcedures={procedures.length}
                    hasActiveFilters={hasActiveFilters}
                    selectedProcedureId={selectedProcedureId}
                    onSelectProcedure={(procedureId) => updateViewParams({ procedureId })}
                  />
                }
                detail={
                  <ProcedureDetails
                    procedure={selectedProcedure}
                    isEditing={editingProcedureId === selectedProcedureId}
                    editForm={editForm}
                    documents={documents}
                    symptoms={symptoms}
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
                }
              />
            </>
          ) : null}
        </div>
      </div>
    </>
  );
}
