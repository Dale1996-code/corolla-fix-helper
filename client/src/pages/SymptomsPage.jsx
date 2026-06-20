import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AttachmentPanel } from "../components/AttachmentPanel";
import { PageHeader } from "../components/PageHeader";
import {
  fetchSuggestedProcedures,
  setSymptomProcedures,
} from "../lib/apiClient";
import { formatDate } from "../lib/formatDate";
import { buildEntityLink } from "../lib/navigation";
import { mergeSuggestionValues } from "../lib/suggestionUtils";

const emptySymptomForm = {
  title: "",
  description: "",
  system: "",
  suspectedCauses: "",
  confidence: "medium",
  status: "open",
  notes: "",
  linkedDocumentIds: [],
};

function labelize(value) {
  if (!value) {
    return "Not set";
  }

  return value
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function getStatusBadgeClass(status) {
  if (status === "resolved") {
    return "bg-emerald-100 text-emerald-800";
  }

  if (status === "monitoring") {
    return "bg-amber-100 text-amber-800";
  }

  return "bg-slate-100 text-slate-700";
}

function compareSymptoms(firstSymptom, secondSymptom, sortBy) {
  if (sortBy === "oldest") {
    return new Date(firstSymptom.updatedAt || 0) - new Date(secondSymptom.updatedAt || 0);
  }

  if (sortBy === "title") {
    return firstSymptom.title.localeCompare(secondSymptom.title);
  }

  return new Date(secondSymptom.updatedAt || 0) - new Date(firstSymptom.updatedAt || 0);
}

function matchesStatusFilter(symptom, statusFilter) {
  if (statusFilter === "all") {
    return true;
  }

  if (statusFilter === "active") {
    return symptom.status === "open" || symptom.status === "monitoring";
  }

  return symptom.status === statusFilter;
}

function formatVisibleSymptomsText(totalCount, visibleCount) {
  const symptomLabel = totalCount === 1 ? "symptom" : "symptoms";

  if (visibleCount === totalCount) {
    return `Showing all ${totalCount} ${symptomLabel}`;
  }

  return `Showing ${visibleCount} of ${totalCount} ${symptomLabel}`;
}

function matchesSearch(symptom, query) {
  if (!query) {
    return true;
  }

  const searchableFields = [
    symptom.title,
    symptom.system,
    symptom.suspectedCauses,
    symptom.notes,
  ];

  return searchableFields.some((value) => value?.toLowerCase().includes(query));
}

function TextField({
  label,
  name,
  value,
  onChange,
  placeholder = "",
  required = false,
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

function SelectField({ label, name, value, onChange, options }) {
  return (
    <label className="grid gap-2 text-sm text-slate-700">
      <span className="font-medium text-slate-900">{label}</span>
      <select
        className="rounded-xl border border-slate-300 px-3 py-2 outline-none transition focus:border-sky-500"
        name={name}
        value={value}
        onChange={onChange}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
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
          No documents available yet. Upload a PDF in the Documents tab first.
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

function SymptomCreateForm({
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
      id="create-symptom"
      className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
    >
      <h3 className="text-lg font-semibold text-slate-900">Create symptom</h3>
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
          documents={documents}
          selectedIds={form.linkedDocumentIds}
          onToggle={onToggleDocument}
          disabled={creating}
        />

        {createMessage ? (
          <p className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
            {createMessage}
          </p>
        ) : null}

        {createError ? (
          <p className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {createError}
          </p>
        ) : null}

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={creating}
            className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-400"
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

function SymptomsControls({
  searchValue,
  onSearchChange,
  statusFilter,
  onStatusFilterChange,
  systemFilter,
  onSystemFilterChange,
  confidenceFilter,
  onConfidenceFilterChange,
  sortBy,
  onSortByChange,
  systems,
  totalCount,
  visibleCount,
  hasActiveFilters,
  onClearFilters,
}) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
        <label className="grid gap-1 text-xs font-medium text-slate-700">
          <span>Search</span>
          <input
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none transition focus:border-sky-500"
            value={searchValue}
            onChange={onSearchChange}
            placeholder="Search title, system, causes, or notes"
          />
        </label>

        <label className="grid gap-1 text-xs font-medium text-slate-700">
          <span>Status filter</span>
          <select
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            value={statusFilter}
            onChange={onStatusFilterChange}
          >
            <option value="all">All statuses</option>
            <option value="active">Active only</option>
            <option value="open">Open</option>
            <option value="monitoring">Monitoring</option>
            <option value="resolved">Resolved</option>
          </select>
        </label>

        <label className="grid gap-1 text-xs font-medium text-slate-700">
          <span>System filter</span>
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
          <span>Confidence filter</span>
          <select
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            value={confidenceFilter}
            onChange={onConfidenceFilterChange}
          >
            <option value="all">All confidence levels</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
        </label>

        <label className="grid gap-1 text-xs font-medium text-slate-700">
          <span>Sort order</span>
          <select
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            value={sortBy}
            onChange={onSortByChange}
          >
            <option value="newest">Newest updates first</option>
            <option value="oldest">Oldest updates first</option>
            <option value="title">Title A-Z</option>
          </select>
        </label>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 pt-4">
        <p className="text-sm text-slate-600">
          {formatVisibleSymptomsText(totalCount, visibleCount)}
        </p>

        {hasActiveFilters ? (
          <button
            type="button"
            onClick={onClearFilters}
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-100"
          >
            Clear filters
          </button>
        ) : null}
      </div>
    </section>
  );
}

function SummaryCard({ label, value, tone = "slate" }) {
  const toneClass =
    tone === "open"
      ? "border-sky-200 bg-sky-50 text-sky-900"
      : tone === "monitoring"
        ? "border-amber-200 bg-amber-50 text-amber-900"
        : tone === "resolved"
          ? "border-emerald-200 bg-emerald-50 text-emerald-900"
          : "border-slate-200 bg-white text-slate-900";

  return (
    <div className={`rounded-xl border px-4 py-3 shadow-sm ${toneClass}`}>
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-2 text-2xl font-bold">{value}</p>
    </div>
  );
}

function SymptomsSummary({ totalCount, visibleCount, statusCounts }) {
  return (
    <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
      <SummaryCard label="Total symptoms" value={totalCount} />
      <SummaryCard label="Visible now" value={visibleCount} />
      <SummaryCard label="Open" value={statusCounts.open} tone="open" />
      <SummaryCard label="Monitoring" value={statusCounts.monitoring} tone="monitoring" />
      <SummaryCard label="Resolved" value={statusCounts.resolved} tone="resolved" />
    </section>
  );
}

function SymptomsList({
  symptoms,
  totalSymptoms,
  hasActiveFilters,
  selectedSymptomId,
  onSelectSymptom,
}) {
  const listGridClass =
    "grid grid-cols-[minmax(16rem,2.8fr)_minmax(7rem,1fr)_minmax(7rem,1fr)_minmax(7rem,1fr)_minmax(6rem,0.8fr)_minmax(9rem,1fr)] gap-3";

  return (
    <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="overflow-x-auto">
        <div className="min-w-[880px]">
          <div
            className={`${listGridClass} border-b border-slate-200 bg-slate-50 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-600`}
          >
            <span>Title</span>
            <span>System</span>
            <span>Status</span>
            <span>Confidence</span>
            <span>Linked docs</span>
            <span>Updated</span>
          </div>

          {symptoms.length === 0 ? (
            <div className="px-4 py-8 text-sm text-slate-600">
              {totalSymptoms === 0 ? (
                <div className="space-y-2">
                  <p className="font-semibold text-slate-900">No symptoms saved yet.</p>
                  <p>Create your first symptom above to start tracking what the car is doing.</p>
                </div>
              ) : hasActiveFilters ? (
                <div className="space-y-2">
                  <p className="font-semibold text-slate-900">No symptoms match the current filters.</p>
                  <p>Change the filters or create a new symptom that matches what you want to track.</p>
                </div>
              ) : (
                <p>No symptoms are available right now.</p>
              )}
            </div>
          ) : null}

          {symptoms.map((symptom) => {
            const isSelected = symptom.id === selectedSymptomId;
            const secondaryText =
              symptom.description || symptom.suspectedCauses || "No extra details yet.";

            return (
              <button
                key={symptom.id}
                type="button"
                className={`${listGridClass} w-full cursor-pointer border-b border-slate-100 px-4 py-3 text-left text-sm ${
                  isSelected ? "bg-sky-50" : "hover:bg-slate-50"
                }`}
                onClick={() => onSelectSymptom(symptom.id)}
              >
                <span>
                  <span data-testid="symptom-row-title" className="block truncate font-medium text-slate-900">
                    {symptom.title}
                  </span>
                  <span className="mt-1 block truncate text-xs text-slate-500">{secondaryText}</span>
                </span>
                <span className="truncate text-slate-700">{symptom.system || "Not set"}</span>
                <span>
                  <span
                    className={`rounded-full px-2 py-1 text-xs font-semibold ${getStatusBadgeClass(symptom.status)}`}
                  >
                    {labelize(symptom.status)}
                  </span>
                </span>
                <span className="truncate text-slate-700">{labelize(symptom.confidence)}</span>
                <span className="text-slate-700">{symptom.linkedDocumentIds.length}</span>
                <span className="text-xs text-slate-600">{formatDate(symptom.updatedAt)}</span>
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function SymptomEditForm({
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
        documents={documents}
        selectedIds={form.linkedDocumentIds}
        onToggle={onToggleDocument}
        disabled={saveState.saving}
      />

      <div className="flex flex-wrap gap-3">
        <button
          type="submit"
          disabled={saveState.saving}
          className="rounded-xl bg-sky-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-sky-500 disabled:cursor-not-allowed disabled:bg-sky-300"
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

      {saveState.error ? (
        <p className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {saveState.error}
        </p>
      ) : null}

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
// list and detail panel stay in sync.
function SymptomProcedurePanel({ symptom, procedures, onSymptomUpdated }) {
  const linkedProcedures = symptom.linkedProcedures || [];
  const [selectedIds, setSelectedIds] = useState(symptom.linkedProcedureIds || []);
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

  // Reset everything when the user selects a different symptom.
  useEffect(() => {
    setSelectedIds(symptom.linkedProcedureIds || []);
    setSaveState({ saving: false, message: "", error: "" });
    setSuggestions([]);
    setSuggestState({ loading: false, loaded: false, error: "", status: "", aiConfigured: true });
  }, [symptom.id]);

  function toggleProcedure(procedureId) {
    setSelectedIds((current) =>
      current.includes(procedureId)
        ? current.filter((id) => id !== procedureId)
        : [...current, procedureId]
    );
  }

  async function handleSaveLinks() {
    try {
      setSaveState({ saving: true, message: "", error: "" });
      const payload = await setSymptomProcedures(symptom.id, selectedIds);
      onSymptomUpdated(payload.symptom);
      setSelectedIds(payload.symptom.linkedProcedureIds || []);
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
      setSelectedIds(payload.symptom.linkedProcedureIds || []);
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
      <h4 className="font-semibold text-slate-900">Linked procedures</h4>

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

      <fieldset className="mt-3 grid gap-2 text-sm text-slate-700">
        <legend className="font-medium text-slate-900">Link procedures</legend>

        {procedures.length === 0 ? (
          <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
            No procedures available yet. Create one in the Procedures tab first.
          </p>
        ) : (
          <div className="max-h-48 space-y-2 overflow-y-auto rounded-xl border border-slate-200 bg-slate-50 p-3">
            {procedures.map((procedure) => (
              <label
                key={procedure.id}
                className="flex items-start gap-2 text-sm text-slate-700"
              >
                <input
                  type="checkbox"
                  checked={selectedIds.includes(procedure.id)}
                  disabled={saveState.saving}
                  onChange={() => toggleProcedure(procedure.id)}
                />
                <span>
                  <span className="font-medium text-slate-900">{procedure.title}</span>
                  <span className="block text-xs text-slate-500">
                    {procedure.system || "No system"} - {labelize(procedure.difficulty)}
                  </span>
                </span>
              </label>
            ))}
          </div>
        )}

        {procedures.length > 0 ? (
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={handleSaveLinks}
              disabled={saveState.saving}
              className="rounded-lg bg-sky-600 px-3 py-2 text-sm font-semibold text-white transition hover:bg-sky-500 disabled:cursor-not-allowed disabled:bg-sky-300"
            >
              {saveState.saving ? "Saving..." : "Save linked procedures"}
            </button>
            {saveState.message ? (
              <span className="text-sm text-emerald-700">{saveState.message}</span>
            ) : null}
          </div>
        ) : null}

        {saveState.error ? (
          <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {saveState.error}
          </p>
        ) : null}
      </fieldset>

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
            Suggests stored procedures grounded in your uploaded documents.
          </span>
        </div>

        {suggestState.error ? (
          <p className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {suggestState.error}
          </p>
        ) : null}

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
                    className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-400"
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
  documents,
  procedures,
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
          <h3 className="text-xl font-semibold text-slate-900">{symptom.title}</h3>
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
          <h4 className="font-semibold text-slate-900">Description</h4>
          <p className="mt-2 whitespace-pre-wrap text-slate-700">
            {symptom.description || "No description yet."}
          </p>
        </div>

        <div>
          <h4 className="font-semibold text-slate-900">Suspected causes</h4>
          <p className="mt-2 whitespace-pre-wrap text-slate-700">
            {symptom.suspectedCauses || "No suspected causes added."}
          </p>
        </div>

        <div>
          <h4 className="font-semibold text-slate-900">Notes</h4>
          <p className="mt-2 whitespace-pre-wrap text-slate-700">
            {symptom.notes || "No notes yet."}
          </p>
        </div>

        <div>
          <h4 className="font-semibold text-slate-900">Linked documents</h4>
          {symptom.linkedDocuments.length ? (
            <ul className="mt-2 space-y-2">
              {symptom.linkedDocuments.map((document) => (
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
          symptom={symptom}
          procedures={procedures}
          onSymptomUpdated={onSymptomUpdated}
        />

        <AttachmentPanel entityType="symptom" entityId={symptom.id} />
      </div>

      {isEditing ? (
        <SymptomEditForm
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
        <p className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          {saveState.message}
        </p>
      ) : null}

      {deleteState.error ? (
        <p className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {deleteState.error}
        </p>
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
    linkedDocumentIds: form.linkedDocumentIds,
  };
}

export function SymptomsPage() {
  const [searchParams] = useSearchParams();
  const requestedSymptomIdValue = Number(searchParams.get("symptomId"));
  const requestedSymptomId =
    Number.isInteger(requestedSymptomIdValue) && requestedSymptomIdValue > 0
      ? requestedSymptomIdValue
      : null;
  const [symptoms, setSymptoms] = useState([]);
  const [documents, setDocuments] = useState([]);
  const [procedures, setProcedures] = useState([]);
  const [savedCommonSystems, setSavedCommonSystems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const [createForm, setCreateForm] = useState(emptySymptomForm);
  const [creating, setCreating] = useState(false);
  const [createMessage, setCreateMessage] = useState("");
  const [createError, setCreateError] = useState("");

  const [selectedSymptomId, setSelectedSymptomId] = useState(null);
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
  const [searchValue, setSearchValue] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [systemFilter, setSystemFilter] = useState("all");
  const [confidenceFilter, setConfidenceFilter] = useState("all");
  const [sortBy, setSortBy] = useState("newest");

  const availableSystems = useMemo(() => {
    return Array.from(
      new Set(symptoms.map((symptom) => symptom.system).filter(Boolean))
    ).sort((firstSystem, secondSystem) => firstSystem.localeCompare(secondSystem));
  }, [symptoms]);

  const systemSuggestions = useMemo(() => {
    return mergeSuggestionValues([
      ...savedCommonSystems,
      ...symptoms.map((symptom) => symptom.system),
    ]);
  }, [savedCommonSystems, symptoms]);

  const statusCounts = useMemo(() => {
    return symptoms.reduce(
      (counts, symptom) => {
        if (symptom.status === "monitoring") {
          counts.monitoring += 1;
        } else if (symptom.status === "resolved") {
          counts.resolved += 1;
        } else {
          counts.open += 1;
        }

        return counts;
      },
      {
        open: 0,
        monitoring: 0,
        resolved: 0,
      }
    );
  }, [symptoms]);

  const filteredSymptoms = useMemo(() => {
    const normalizedQuery = searchValue.trim().toLowerCase();

    return symptoms
      .filter((symptom) => {
        if (!matchesStatusFilter(symptom, statusFilter)) {
          return false;
        }

        if (systemFilter !== "all" && symptom.system !== systemFilter) {
          return false;
        }

        if (confidenceFilter !== "all" && symptom.confidence !== confidenceFilter) {
          return false;
        }

        return matchesSearch(symptom, normalizedQuery);
      })
      .sort((firstSymptom, secondSymptom) =>
        compareSymptoms(firstSymptom, secondSymptom, sortBy)
      );
  }, [symptoms, searchValue, statusFilter, systemFilter, confidenceFilter, sortBy]);

  const selectedSymptom = useMemo(() => {
    if (!selectedSymptomId) {
      return null;
    }

    return filteredSymptoms.find((symptom) => symptom.id === selectedSymptomId) || null;
  }, [filteredSymptoms, selectedSymptomId]);

  const hasActiveFilters =
    searchValue.trim() !== "" ||
    statusFilter !== "all" ||
    systemFilter !== "all" ||
    confidenceFilter !== "all";

  function toggleLinkedDocument(selectedIds, documentId) {
    if (selectedIds.includes(documentId)) {
      return selectedIds.filter((id) => id !== documentId);
    }

    return [...selectedIds, documentId];
  }

  // Keep the list and detail panel in sync after a procedure link change.
  function handleSymptomUpdated(updatedSymptom) {
    if (!updatedSymptom) {
      return;
    }

    setSymptoms((currentSymptoms) =>
      currentSymptoms.map((symptom) =>
        symptom.id === updatedSymptom.id ? updatedSymptom : symptom
      )
    );
  }

  async function loadData() {
    try {
      setLoadError("");
      setLoading(true);

      const [symptomsResponse, documentsResponse] = await Promise.all([
        fetch("/api/symptoms"),
        fetch("/api/documents"),
      ]);

      const symptomsPayload = await symptomsResponse.json();
      const documentsPayload = await documentsResponse.json();

      if (!symptomsResponse.ok) {
        throw new Error(symptomsPayload.error || "Could not load symptoms.");
      }

      if (!documentsResponse.ok) {
        throw new Error(documentsPayload.error || "Could not load documents.");
      }

      const nextSymptoms = Array.isArray(symptomsPayload.symptoms)
        ? symptomsPayload.symptoms
        : [];
      const nextDocuments = Array.isArray(documentsPayload.documents)
        ? documentsPayload.documents
        : [];

      setSymptoms(nextSymptoms);
      setDocuments(nextDocuments);
      setSelectedSymptomId((currentId) => {
        if (
          requestedSymptomId &&
          nextSymptoms.some((symptom) => symptom.id === requestedSymptomId)
        ) {
          return requestedSymptomId;
        }

        if (currentId && nextSymptoms.some((symptom) => symptom.id === currentId)) {
          return currentId;
        }

        return nextSymptoms[0]?.id || null;
      });

      // Procedures power the manual link selector; a failure here should not
      // block the symptom list, so it loads on its own.
      try {
        const proceduresResponse = await fetch("/api/procedures");
        const proceduresPayload = await proceduresResponse.json();

        if (proceduresResponse.ok) {
          setProcedures(
            Array.isArray(proceduresPayload.procedures)
              ? proceduresPayload.procedures
              : []
          );
        }
      } catch {
        setProcedures([]);
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
      setLoadError(error.message || "Could not load symptom data.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadData();
  }, []);

  useEffect(() => {
    if (!filteredSymptoms.length) {
      setSelectedSymptomId(null);
      setEditingSymptomId(null);
      return;
    }

    setSelectedSymptomId((currentId) => {
      if (currentId && filteredSymptoms.some((symptom) => symptom.id === currentId)) {
        return currentId;
      }

      return filteredSymptoms[0].id;
    });

    setEditingSymptomId((currentId) => {
      if (currentId && filteredSymptoms.some((symptom) => symptom.id === currentId)) {
        return currentId;
      }

      return null;
    });
  }, [filteredSymptoms]);

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

      setSymptoms((currentSymptoms) => [newSymptom, ...currentSymptoms]);
      setSelectedSymptomId(newSymptom.id);
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
      linkedDocumentIds: symptom.linkedDocumentIds || [],
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

  function handleToggleEditDocument(documentId) {
    setEditForm((currentForm) => ({
      ...currentForm,
      linkedDocumentIds: toggleLinkedDocument(currentForm.linkedDocumentIds, documentId),
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

      const updatedSymptom = payload.symptom;

      setSymptoms((currentSymptoms) =>
        currentSymptoms.map((symptom) =>
          symptom.id === updatedSymptom.id ? updatedSymptom : symptom
        )
      );
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

      setSymptoms((currentSymptoms) => {
        const remainingSymptoms = currentSymptoms.filter(
          (currentSymptom) => currentSymptom.id !== symptom.id
        );

        setSelectedSymptomId((currentId) => {
          if (currentId !== symptom.id) {
            return currentId;
          }

          return remainingSymptoms[0]?.id || null;
        });

        return remainingSymptoms;
      });

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

  return (
    <>
      <PageHeader
        eyebrow="Working Feature"
        title="Symptoms"
        description="Track issues you observe on your Corolla, add your confidence level, and link each symptom to the documents that help you diagnose it."
      />

      <div className="space-y-6">
        <SymptomCreateForm
          form={createForm}
          documents={documents}
          systemSuggestions={systemSuggestions}
          creating={creating}
          createMessage={createMessage}
          createError={createError}
          onChange={handleCreateFormChange}
          onToggleDocument={handleToggleCreateDocument}
          onSubmit={handleCreateSymptom}
        />

        <div id="symptom-library" className="space-y-6">
          {loading ? (
            <section className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-600 shadow-sm">
              Loading symptoms...
            </section>
          ) : null}

          {loadError ? (
            <section className="rounded-xl border border-red-200 bg-red-50 p-6 shadow-sm">
              <p className="font-semibold text-red-800">Could not load symptoms.</p>
              <p className="mt-2 text-sm text-red-700">{loadError}</p>
            </section>
          ) : null}

          {!loading && !loadError ? (
            <>
              <SymptomsSummary
                totalCount={symptoms.length}
                visibleCount={filteredSymptoms.length}
                statusCounts={statusCounts}
              />

              <SymptomsControls
                searchValue={searchValue}
                onSearchChange={(event) => setSearchValue(event.target.value)}
                statusFilter={statusFilter}
                onStatusFilterChange={(event) => setStatusFilter(event.target.value)}
                systemFilter={systemFilter}
                onSystemFilterChange={(event) => setSystemFilter(event.target.value)}
                confidenceFilter={confidenceFilter}
                onConfidenceFilterChange={(event) => setConfidenceFilter(event.target.value)}
                sortBy={sortBy}
                onSortByChange={(event) => setSortBy(event.target.value)}
                systems={availableSystems}
                totalCount={symptoms.length}
                visibleCount={filteredSymptoms.length}
                hasActiveFilters={hasActiveFilters}
                onClearFilters={() => {
                  setSearchValue("");
                  setStatusFilter("all");
                  setSystemFilter("all");
                  setConfidenceFilter("all");
                  setSortBy("newest");
                }}
              />

              <div className="grid gap-6 xl:grid-cols-[minmax(0,1.25fr)_minmax(0,0.95fr)]">
                <SymptomsList
                  symptoms={filteredSymptoms}
                  totalSymptoms={symptoms.length}
                  hasActiveFilters={hasActiveFilters}
                  selectedSymptomId={selectedSymptomId}
                  onSelectSymptom={setSelectedSymptomId}
                />

                <SymptomDetails
                  symptom={selectedSymptom}
                  isEditing={editingSymptomId === selectedSymptomId}
                  editForm={editForm}
                  documents={documents}
                  procedures={procedures}
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
              </div>
            </>
          ) : null}
        </div>
      </div>
    </>
  );
}
