import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { PageHeader } from "../components/PageHeader";
import { buildEntityLink } from "../lib/navigation";
import { mergeSuggestionValues } from "../lib/suggestionUtils";

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

function labelize(value) {
  if (!value) {
    return "Not set";
  }

  return value
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function getDifficultyBadgeClass(difficulty) {
  if (difficulty === "advanced") {
    return "bg-red-100 text-red-800";
  }

  if (difficulty === "intermediate") {
    return "bg-amber-100 text-amber-800";
  }

  return "bg-emerald-100 text-emerald-800";
}

function getSortTimestamp(procedure) {
  const value = procedure.updatedAt || procedure.createdAt;
  const time = new Date(value || "").getTime();
  return Number.isNaN(time) ? 0 : time;
}

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
      <h3 className="text-lg font-semibold text-slate-900">Create procedure</h3>
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

function ProceduresListControls({
  searchValue,
  onSearchChange,
  systemFilter,
  onSystemFilterChange,
  difficultyFilter,
  onDifficultyFilterChange,
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
            placeholder="Search title, system, tools, parts, steps, or notes"
          />
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
          <span>Difficulty filter</span>
          <select
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            value={difficultyFilter}
            onChange={onDifficultyFilterChange}
          >
            <option value="all">All difficulty levels</option>
            <option value="beginner">Beginner</option>
            <option value="intermediate">Intermediate</option>
            <option value="advanced">Advanced</option>
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
          <span>Sort</span>
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
          Showing <span className="font-semibold text-slate-900">{visibleCount}</span> of{" "}
          <span className="font-semibold text-slate-900">{totalCount}</span> procedure
          {totalCount === 1 ? "" : "s"}.
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

function ProceduresList({
  procedures,
  totalProcedures,
  hasActiveFilters,
  selectedProcedureId,
  onSelectProcedure,
}) {
  const listGridClass =
    "grid grid-cols-[minmax(13rem,2.5fr)_minmax(7rem,1fr)_minmax(7rem,1fr)_minmax(7rem,1fr)_minmax(6rem,0.8fr)_minmax(9rem,1fr)] gap-3";

  return (
    <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="overflow-x-auto">
        <div className="min-w-[720px]">
          <div
            className={`${listGridClass} border-b border-slate-200 bg-slate-50 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-600`}
          >
            <span>Title</span>
            <span>System</span>
            <span>Difficulty</span>
            <span>Confidence</span>
            <span>Linked docs</span>
            <span>Updated</span>
          </div>

          {procedures.length === 0 ? (
            <div className="px-4 py-6 text-sm text-slate-600">
              {totalProcedures === 0 ? "No procedures saved yet." : null}
              {totalProcedures > 0 && hasActiveFilters
                ? "No procedures match the current filters."
                : null}
            </div>
          ) : null}

          {procedures.map((procedure) => {
            const isSelected = procedure.id === selectedProcedureId;

            return (
              <div
                key={procedure.id}
                className={`${listGridClass} cursor-pointer border-b border-slate-100 px-4 py-3 text-sm ${
                  isSelected ? "bg-sky-50" : "hover:bg-slate-50"
                }`}
                onClick={() => onSelectProcedure(procedure.id)}
              >
                <span className="truncate font-medium text-slate-900">{procedure.title}</span>
                <span className="truncate text-slate-700">{procedure.system || "Not set"}</span>
                <span>
                  <span
                    className={`rounded-full px-2 py-1 text-xs font-semibold ${getDifficultyBadgeClass(procedure.difficulty)}`}
                  >
                    {labelize(procedure.difficulty)}
                  </span>
                </span>
                <span className="truncate text-slate-700">{labelize(procedure.confidence)}</span>
                <span className="text-slate-700">{procedure.linkedDocumentIds.length}</span>
                <span className="truncate text-xs text-slate-600">{formatDate(procedure.updatedAt)}</span>
              </div>
            );
          })}
        </div>
      </div>
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
        id="edit-procedure-system-suggestions"
        options={systemSuggestions}
      />
    </form>
  );
}

function ProcedureDetails({
  procedure,
  isEditing,
  editForm,
  documents,
  systemSuggestions,
  saveState,
  deleteState,
  onStartEdit,
  onCancelEdit,
  onEditChange,
  onToggleEditDocument,
  onSaveEdit,
  onDelete,
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
          <h3 className="text-xl font-semibold text-slate-900">{procedure.title}</h3>
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
          <h4 className="font-semibold text-slate-900">Tools needed</h4>
          <p className="mt-2 whitespace-pre-wrap text-slate-700">
            {procedure.toolsNeeded || "No tools listed yet."}
          </p>
        </div>

        <div>
          <h4 className="font-semibold text-slate-900">Parts needed</h4>
          <p className="mt-2 whitespace-pre-wrap text-slate-700">
            {procedure.partsNeeded || "No parts listed yet."}
          </p>
        </div>

        <div>
          <h4 className="font-semibold text-slate-900">Safety notes</h4>
          <p className="mt-2 whitespace-pre-wrap text-slate-700">
            {procedure.safetyNotes || "No safety notes yet."}
          </p>
        </div>

        <div>
          <h4 className="font-semibold text-slate-900">Steps</h4>
          <p className="mt-2 whitespace-pre-wrap text-slate-700">
            {procedure.steps || "No steps yet."}
          </p>
        </div>

        <div>
          <h4 className="font-semibold text-slate-900">Notes</h4>
          <p className="mt-2 whitespace-pre-wrap text-slate-700">
            {procedure.notes || "No notes yet."}
          </p>
        </div>

        <div>
          <h4 className="font-semibold text-slate-900">Linked documents</h4>
          {procedure.linkedDocuments.length ? (
            <ul className="mt-2 space-y-2">
              {procedure.linkedDocuments.map((document) => (
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
  const [searchParams] = useSearchParams();
  const requestedProcedureIdValue = Number(searchParams.get("procedureId"));
  const requestedProcedureId =
    Number.isInteger(requestedProcedureIdValue) && requestedProcedureIdValue > 0
      ? requestedProcedureIdValue
      : null;
  const [procedures, setProcedures] = useState([]);
  const [documents, setDocuments] = useState([]);
  const [savedCommonSystems, setSavedCommonSystems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const [createForm, setCreateForm] = useState(emptyProcedureForm);
  const [creating, setCreating] = useState(false);
  const [createMessage, setCreateMessage] = useState("");
  const [createError, setCreateError] = useState("");

  const [selectedProcedureId, setSelectedProcedureId] = useState(null);
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
  const [searchValue, setSearchValue] = useState("");
  const [systemFilter, setSystemFilter] = useState("all");
  const [difficultyFilter, setDifficultyFilter] = useState("all");
  const [confidenceFilter, setConfidenceFilter] = useState("all");
  const [sortBy, setSortBy] = useState("newest");

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

  const selectedProcedure = useMemo(() => {
    if (!selectedProcedureId) {
      return null;
    }

    return filteredProcedures.find((procedure) => procedure.id === selectedProcedureId) || null;
  }, [filteredProcedures, selectedProcedureId]);

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
      setSelectedProcedureId((currentId) => {
        if (
          requestedProcedureId &&
          nextProcedures.some((procedure) => procedure.id === requestedProcedureId)
        ) {
          return requestedProcedureId;
        }

        if (currentId && nextProcedures.some((procedure) => procedure.id === currentId)) {
          return currentId;
        }

        return nextProcedures[0]?.id || null;
      });

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

  useEffect(() => {
    loadData();
  }, []);

  useEffect(() => {
    setSelectedProcedureId((currentId) => {
      if (!filteredProcedures.length) {
        return null;
      }

      if (currentId && filteredProcedures.some((procedure) => procedure.id === currentId)) {
        return currentId;
      }

      return filteredProcedures[0].id;
    });
  }, [filteredProcedures]);

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
      setSelectedProcedureId(newProcedure.id);
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

      setProcedures((currentProcedures) => {
        const remainingProcedures = currentProcedures.filter(
          (currentProcedure) => currentProcedure.id !== procedure.id
        );

        setSelectedProcedureId((currentId) => {
          if (currentId !== procedure.id) {
            return currentId;
          }

          return remainingProcedures[0]?.id || null;
        });

        return remainingProcedures;
      });

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
        eyebrow="Working Feature"
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
            <section className="rounded-xl border border-red-200 bg-red-50 p-6 shadow-sm">
              <p className="font-semibold text-red-800">Could not load procedures.</p>
              <p className="mt-2 text-sm text-red-700">{loadError}</p>
            </section>
          ) : null}

          {!loading && !loadError ? (
            <>
              <section className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600 shadow-sm">
                You have <span className="font-semibold text-slate-900">{procedures.length}</span>{" "}
                procedure{procedures.length === 1 ? "" : "s"} saved.
              </section>

              <ProceduresListControls
                searchValue={searchValue}
                onSearchChange={(event) => setSearchValue(event.target.value)}
                systemFilter={systemFilter}
                onSystemFilterChange={(event) => setSystemFilter(event.target.value)}
                difficultyFilter={difficultyFilter}
                onDifficultyFilterChange={(event) => setDifficultyFilter(event.target.value)}
                confidenceFilter={confidenceFilter}
                onConfidenceFilterChange={(event) => setConfidenceFilter(event.target.value)}
                sortBy={sortBy}
                onSortByChange={(event) => setSortBy(event.target.value)}
                systems={availableSystems}
                totalCount={procedures.length}
                visibleCount={filteredProcedures.length}
                hasActiveFilters={hasActiveFilters}
                onClearFilters={() => {
                  setSearchValue("");
                  setSystemFilter("all");
                  setDifficultyFilter("all");
                  setConfidenceFilter("all");
                  setSortBy("newest");
                }}
              />

              <div className="grid gap-6 xl:grid-cols-2">
                <ProceduresList
                  procedures={filteredProcedures}
                  totalProcedures={procedures.length}
                  hasActiveFilters={hasActiveFilters}
                  selectedProcedureId={selectedProcedureId}
                  onSelectProcedure={setSelectedProcedureId}
                />

                <ProcedureDetails
                  procedure={selectedProcedure}
                  isEditing={editingProcedureId === selectedProcedureId}
                  editForm={editForm}
                  documents={documents}
                  systemSuggestions={systemSuggestions}
                  saveState={saveState}
                  deleteState={deleteState}
                  onStartEdit={startEditingProcedure}
                  onCancelEdit={cancelEditingProcedure}
                  onEditChange={handleEditFormChange}
                  onToggleEditDocument={handleToggleEditDocument}
                  onSaveEdit={handleSaveProcedure}
                  onDelete={handleDeleteProcedure}
                />
              </div>
            </>
          ) : null}
        </div>
      </div>
    </>
  );
}
