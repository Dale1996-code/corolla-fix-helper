import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { PageHeader } from "../components/PageHeader";
import { buildEntityLink } from "../lib/navigation";

const emptyNoteForm = {
  title: "",
  content: "",
  noteType: "general",
  relatedEntityType: "none",
  relatedEntityId: "",
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

function getSortTimestamp(note) {
  const dateValue = note.updatedAt || note.createdAt;
  const time = new Date(dateValue || "").getTime();
  return Number.isNaN(time) ? 0 : time;
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

function TextField({ label, name, value, onChange, placeholder = "", required = false }) {
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
      />
    </label>
  );
}

function TextAreaField({ label, name, value, onChange, placeholder = "" }) {
  return (
    <label className="grid gap-2 text-sm text-slate-700">
      <span className="font-medium text-slate-900">{label}</span>
      <textarea
        className="min-h-28 rounded-xl border border-slate-300 px-3 py-2 outline-none transition focus:border-sky-500"
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

function getRelatedEntityFieldConfig(relatedEntityType, documents, symptoms, procedures) {
  if (relatedEntityType === "document") {
    return {
      label: "Linked document",
      placeholder: "Choose a document",
      entities: documents,
      emptyMessage: "No documents available yet. Upload a PDF in Documents first.",
    };
  }

  if (relatedEntityType === "symptom") {
    return {
      label: "Linked symptom",
      placeholder: "Choose a symptom",
      entities: symptoms,
      emptyMessage: "No symptoms available yet. Add a symptom first.",
    };
  }

  if (relatedEntityType === "procedure") {
    return {
      label: "Linked procedure",
      placeholder: "Choose a procedure",
      entities: procedures,
      emptyMessage: "No procedures available yet. Add a procedure first.",
    };
  }

  return null;
}

function getMissingRelatedEntityError(relatedEntityType) {
  if (relatedEntityType === "document") {
    return "Please choose a linked document.";
  }

  if (relatedEntityType === "symptom") {
    return "Please choose a linked symptom.";
  }

  if (relatedEntityType === "procedure") {
    return "Please choose a linked procedure.";
  }

  return "";
}

function getLinkedEntity(note) {
  if (note.relatedEntityType === "document") {
    return note.linkedDocument || null;
  }

  if (note.relatedEntityType === "symptom") {
    return note.linkedSymptom || null;
  }

  if (note.relatedEntityType === "procedure") {
    return note.linkedProcedure || null;
  }

  return null;
}

function getLinkedEntityTitle(note) {
  if (note.relatedEntityType === "none") {
    return "No link";
  }

  const linkedEntity = getLinkedEntity(note);

  if (linkedEntity?.title) {
    return linkedEntity.title;
  }

  if (note.relatedEntityId) {
    return `${labelize(note.relatedEntityType)} #${note.relatedEntityId}`;
  }

  return `${labelize(note.relatedEntityType)} link`;
}

function getLinkedEntityMeta(note) {
  const linkedEntity = getLinkedEntity(note);

  if (!linkedEntity) {
    return "";
  }

  if (note.relatedEntityType === "document") {
    return `${linkedEntity.system || "No system"} - ${linkedEntity.documentType || "No type"}`;
  }

  if (note.relatedEntityType === "symptom") {
    return `${linkedEntity.system || "No system"} - ${labelize(linkedEntity.status || "open")}`;
  }

  if (note.relatedEntityType === "procedure") {
    return `${linkedEntity.system || "No system"} - ${labelize(linkedEntity.difficulty || "intermediate")}`;
  }

  return "";
}

function getLinkedEntityOpenLabel(relatedEntityType) {
  if (relatedEntityType === "document") {
    return "document";
  }

  if (relatedEntityType === "symptom") {
    return "symptom";
  }

  if (relatedEntityType === "procedure") {
    return "procedure";
  }

  return "item";
}

function getLinkedEntityHeading(relatedEntityType) {
  if (relatedEntityType === "document") {
    return "Linked document";
  }

  if (relatedEntityType === "symptom") {
    return "Linked symptom";
  }

  if (relatedEntityType === "procedure") {
    return "Linked procedure";
  }

  return "Linked item";
}

function getLinkedEntityTypeLabel(relatedEntityType) {
  if (relatedEntityType === "none") {
    return "";
  }

  return labelize(relatedEntityType);
}

function getRelatedEntityTypeFilterLabel(relatedEntityType) {
  if (relatedEntityType === "none") {
    return "No link";
  }

  return labelize(relatedEntityType);
}

function RelatedEntityField({
  label,
  placeholder,
  entities,
  value,
  onChange,
  disabled = false,
  emptyMessage,
}) {
  return (
    <label className="grid gap-2 text-sm text-slate-700">
      <span className="font-medium text-slate-900">{label}</span>
      <select
        className="rounded-xl border border-slate-300 px-3 py-2 outline-none transition focus:border-sky-500 disabled:cursor-not-allowed disabled:bg-slate-100"
        value={value}
        onChange={onChange}
        disabled={disabled || entities.length === 0}
      >
        <option value="">{placeholder}</option>
        {entities.map((entity) => (
          <option key={entity.id} value={String(entity.id)}>
            {entity.title}
          </option>
        ))}
      </select>
      {entities.length === 0 ? (
        <span className="text-xs text-slate-500">{emptyMessage}</span>
      ) : null}
    </label>
  );
}

function NoteCreateForm({
  form,
  documents,
  symptoms,
  procedures,
  creating,
  createMessage,
  createError,
  onChange,
  onRelatedEntityTypeChange,
  onRelatedEntityChange,
  onSubmit,
}) {
  const relatedEntityField = getRelatedEntityFieldConfig(
    form.relatedEntityType,
    documents,
    symptoms,
    procedures
  );

  return (
    <section
      id="create-note"
      className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
    >
      <h3 className="text-lg font-semibold text-slate-900">Create note</h3>
      <p className="mt-1 text-sm text-slate-600">
        Save observations, reminders, and repair notes. In this page, you can optionally link
        each note to one document, symptom, or procedure.
      </p>

      <form className="mt-4 grid gap-4" onSubmit={onSubmit}>
        <div className="grid gap-4 md:grid-cols-2">
          <TextField
            label="Title"
            name="title"
            value={form.title}
            onChange={onChange}
            required
            placeholder="Idle note after coil replacement"
          />
          <SelectField
            label="Note type"
            name="noteType"
            value={form.noteType}
            onChange={onChange}
            options={[
              { value: "general", label: "General" },
              { value: "observation", label: "Observation" },
              { value: "repair_log", label: "Repair log" },
              { value: "reminder", label: "Reminder" },
            ]}
          />
          <SelectField
            label="Link note to"
            name="relatedEntityType"
            value={form.relatedEntityType}
            onChange={onRelatedEntityTypeChange}
            options={[
              { value: "none", label: "Nothing" },
              { value: "document", label: "Document" },
              { value: "symptom", label: "Symptom" },
              { value: "procedure", label: "Procedure" },
            ]}
          />
          {relatedEntityField ? (
            <RelatedEntityField
              label={relatedEntityField.label}
              placeholder={relatedEntityField.placeholder}
              entities={relatedEntityField.entities}
              emptyMessage={relatedEntityField.emptyMessage}
              value={form.relatedEntityId}
              onChange={onRelatedEntityChange}
              disabled={creating}
            />
          ) : (
            <div />
          )}
        </div>

        <TextAreaField
          label="Content"
          name="content"
          value={form.content}
          onChange={onChange}
          placeholder="Write your note here..."
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
            {creating ? "Saving..." : "Save note"}
          </button>
        </div>
      </form>
    </section>
  );
}

function NotesListControls({
  noteTypeFilter,
  onNoteTypeFilterChange,
  relatedEntityTypeFilter,
  onRelatedEntityTypeFilterChange,
  sortBy,
  onSortByChange,
  noteTypes,
}) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="grid gap-3 md:grid-cols-3">
        <label className="grid gap-1 text-xs font-medium text-slate-700">
          <span>Note type</span>
          <select
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            value={noteTypeFilter}
            onChange={onNoteTypeFilterChange}
          >
            <option value="all">All note types</option>
            {noteTypes.map((noteType) => (
              <option key={noteType} value={noteType}>
                {labelize(noteType)}
              </option>
            ))}
          </select>
        </label>

        <label className="grid gap-1 text-xs font-medium text-slate-700">
          <span>Linked item</span>
          <select
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            value={relatedEntityTypeFilter}
            onChange={onRelatedEntityTypeFilterChange}
          >
            <option value="all">All links</option>
            <option value="document">{getRelatedEntityTypeFilterLabel("document")}</option>
            <option value="symptom">{getRelatedEntityTypeFilterLabel("symptom")}</option>
            <option value="procedure">{getRelatedEntityTypeFilterLabel("procedure")}</option>
            <option value="none">{getRelatedEntityTypeFilterLabel("none")}</option>
          </select>
        </label>

        <label className="grid gap-1 text-xs font-medium text-slate-700">
          <span>Sort</span>
          <select
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            value={sortBy}
            onChange={onSortByChange}
          >
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
          </select>
        </label>
      </div>
    </section>
  );
}

function NotesList({ notes, selectedNoteId, onSelectNote }) {
  const listGridClass =
    "grid grid-cols-[minmax(13rem,2.5fr)_minmax(7rem,1fr)_minmax(10rem,1.4fr)_minmax(9rem,1fr)] gap-3";

  return (
    <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="overflow-x-auto">
        <div className="min-w-[680px]">
          <div
            className={`${listGridClass} border-b border-slate-200 bg-slate-50 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-600`}
          >
            <span>Title</span>
            <span>Type</span>
            <span>Linked item</span>
            <span>Updated</span>
          </div>

          {notes.length === 0 ? (
            <div className="px-4 py-6 text-sm text-slate-600">
              No notes saved yet.
            </div>
          ) : null}

          {notes.map((note) => {
            const isSelected = note.id === selectedNoteId;
            const relatedLabel = getLinkedEntityTitle(note);

            return (
              <div
                key={note.id}
                className={`${listGridClass} cursor-pointer border-b border-slate-100 px-4 py-3 text-sm ${
                  isSelected ? "bg-sky-50" : "hover:bg-slate-50"
                }`}
                onClick={() => onSelectNote(note.id)}
              >
                <span className="truncate font-medium text-slate-900">{note.title}</span>
                <span className="truncate text-slate-700">{labelize(note.noteType)}</span>
                <span className="truncate text-slate-700">{relatedLabel}</span>
                <span className="truncate text-xs text-slate-600">
                  {formatDate(note.updatedAt)}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function NoteEditForm({
  form,
  documents,
  symptoms,
  procedures,
  saveState,
  onChange,
  onRelatedEntityTypeChange,
  onRelatedEntityChange,
  onSubmit,
  onCancel,
}) {
  const relatedEntityField = getRelatedEntityFieldConfig(
    form.relatedEntityType,
    documents,
    symptoms,
    procedures
  );

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
        <SelectField
          label="Note type"
          name="noteType"
          value={form.noteType}
          onChange={onChange}
          options={[
            { value: "general", label: "General" },
            { value: "observation", label: "Observation" },
            { value: "repair_log", label: "Repair log" },
            { value: "reminder", label: "Reminder" },
          ]}
        />
        <SelectField
          label="Link note to"
          name="relatedEntityType"
          value={form.relatedEntityType}
          onChange={onRelatedEntityTypeChange}
          options={[
            { value: "none", label: "Nothing" },
            { value: "document", label: "Document" },
            { value: "symptom", label: "Symptom" },
            { value: "procedure", label: "Procedure" },
          ]}
        />
        {relatedEntityField ? (
          <RelatedEntityField
            label={relatedEntityField.label}
            placeholder={relatedEntityField.placeholder}
            entities={relatedEntityField.entities}
            emptyMessage={relatedEntityField.emptyMessage}
            value={form.relatedEntityId}
            onChange={onRelatedEntityChange}
            disabled={saveState.saving}
          />
        ) : (
          <div />
        )}
      </div>

      <TextAreaField label="Content" name="content" value={form.content} onChange={onChange} />

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
    </form>
  );
}

function NoteDetails({
  note,
  isEditing,
  editForm,
  documents,
  symptoms,
  procedures,
  saveState,
  deleteState,
  onStartEdit,
  onCancelEdit,
  onEditChange,
  onRelatedEntityTypeChange,
  onRelatedEntityChange,
  onSaveEdit,
  onDelete,
}) {
  if (!note) {
    return (
      <section className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-600 shadow-sm">
        Select a note to view details.
      </section>
    );
  }

  const linkedEntity = getLinkedEntity(note);
  const linkedEntityHeading = getLinkedEntityHeading(note.relatedEntityType);
  const linkedEntityTitle = getLinkedEntityTitle(note);
  const linkedEntityTypeLabel = getLinkedEntityTypeLabel(note.relatedEntityType);
  const linkedEntityMeta = getLinkedEntityMeta(note);
  const linkedEntityLink = buildEntityLink(note.relatedEntityType, note.relatedEntityId);
  const linkedEntityOpenLabel = getLinkedEntityOpenLabel(note.relatedEntityType);

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-xl font-semibold text-slate-900">{note.title}</h3>
          <p className="mt-1 text-sm text-slate-500">
            Updated {formatDate(note.updatedAt)}
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => onStartEdit(note)}
            className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-700"
          >
            Edit note
          </button>
          <button
            type="button"
            onClick={() => onDelete(note)}
            disabled={deleteState.deletingId === note.id}
            className="rounded-lg border border-red-300 px-3 py-2 text-sm font-semibold text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {deleteState.deletingId === note.id ? "Deleting..." : "Delete"}
          </button>
        </div>
      </div>

      <dl className="mt-5 grid gap-3 text-sm md:grid-cols-2">
        <div>
          <dt className="font-semibold text-slate-900">Note type</dt>
          <dd className="text-slate-700">{labelize(note.noteType)}</dd>
        </div>
        <div>
          <dt className="font-semibold text-slate-900">Linked item</dt>
          <dd className="text-slate-700">
            {note.relatedEntityType === "none" ? (
              "No link"
            ) : (
              <>
                <Link
                  className="font-medium text-sky-700 underline decoration-sky-200 underline-offset-2 hover:text-sky-900"
                  to={linkedEntityLink}
                  aria-label={`Open linked ${linkedEntityOpenLabel} ${linkedEntityTitle}`}
                >
                  {linkedEntityTitle}
                </Link>
                <span className="block text-xs text-slate-500">{linkedEntityTypeLabel}</span>
              </>
            )}
          </dd>
        </div>
        <div>
          <dt className="font-semibold text-slate-900">Created</dt>
          <dd className="text-slate-700">{formatDate(note.createdAt)}</dd>
        </div>
      </dl>

      <div className="mt-5 space-y-4 text-sm">
        <div>
          <h4 className="font-semibold text-slate-900">Content</h4>
          <p className="mt-2 whitespace-pre-wrap text-slate-700">
            {note.content || "No content yet."}
          </p>
        </div>

        {note.relatedEntityType !== "none" ? (
          <div>
            <h4 className="font-semibold text-slate-900">{linkedEntityHeading}</h4>
            {linkedEntity ? (
              <div className="mt-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-slate-700">
                <Link
                  className="font-medium text-sky-700 underline decoration-sky-200 underline-offset-2 hover:text-sky-900"
                  to={linkedEntityLink}
                  aria-label={`Open linked ${linkedEntityOpenLabel} ${linkedEntity.title}`}
                >
                  {linkedEntity.title}
                </Link>
                {linkedEntityMeta ? (
                  <p className="text-xs text-slate-500">{linkedEntityMeta}</p>
                ) : null}
                <Link
                  className="mt-1 inline-flex text-xs font-medium text-sky-700 hover:text-sky-900"
                  to={linkedEntityLink}
                >
                  Open {linkedEntityOpenLabel}
                </Link>
              </div>
            ) : (
              <p className="mt-2 text-slate-700">
                {linkedEntityHeading} ID: {note.relatedEntityId || "Not set"}
              </p>
            )}
          </div>
        ) : null}
      </div>

      {isEditing ? (
        <NoteEditForm
          form={editForm}
          documents={documents}
          symptoms={symptoms}
          procedures={procedures}
          saveState={saveState}
          onChange={onEditChange}
          onRelatedEntityTypeChange={onRelatedEntityTypeChange}
          onRelatedEntityChange={onRelatedEntityChange}
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

function toNotePayload(form) {
  return {
    title: form.title,
    content: form.content,
    noteType: form.noteType,
    relatedEntityType: form.relatedEntityType,
    relatedEntityId: form.relatedEntityId ? Number(form.relatedEntityId) : null,
  };
}

export function NotesPage() {
  const [searchParams] = useSearchParams();
  const requestedNoteIdValue = Number(searchParams.get("noteId"));
  const requestedNoteId =
    Number.isInteger(requestedNoteIdValue) && requestedNoteIdValue > 0
      ? requestedNoteIdValue
      : null;
  const [notes, setNotes] = useState([]);
  const [documents, setDocuments] = useState([]);
  const [symptoms, setSymptoms] = useState([]);
  const [procedures, setProcedures] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const [createForm, setCreateForm] = useState(emptyNoteForm);
  const [creating, setCreating] = useState(false);
  const [createMessage, setCreateMessage] = useState("");
  const [createError, setCreateError] = useState("");

  const [selectedNoteId, setSelectedNoteId] = useState(null);
  const [editingNoteId, setEditingNoteId] = useState(null);
  const [editForm, setEditForm] = useState(emptyNoteForm);
  const [saveState, setSaveState] = useState({
    saving: false,
    message: "",
    error: "",
  });
  const [deleteState, setDeleteState] = useState({
    deletingId: null,
    error: "",
  });
  const [noteTypeFilter, setNoteTypeFilter] = useState("all");
  const [relatedEntityTypeFilter, setRelatedEntityTypeFilter] = useState("all");
  const [sortBy, setSortBy] = useState("newest");

  const noteTypes = useMemo(() => {
    return Array.from(
      new Set(notes.map((note) => note.noteType).filter(Boolean))
    ).sort((a, b) => a.localeCompare(b));
  }, [notes]);

  const filteredNotes = useMemo(() => {
    const nextNotes = notes.filter((note) => {
      if (noteTypeFilter !== "all" && note.noteType !== noteTypeFilter) {
        return false;
      }

      if (
        relatedEntityTypeFilter !== "all" &&
        (note.relatedEntityType || "none") !== relatedEntityTypeFilter
      ) {
        return false;
      }

      return true;
    });

    nextNotes.sort((firstNote, secondNote) => {
      const firstTime = getSortTimestamp(firstNote);
      const secondTime = getSortTimestamp(secondNote);

      if (sortBy === "oldest") {
        return firstTime - secondTime;
      }

      return secondTime - firstTime;
    });

    return nextNotes;
  }, [notes, noteTypeFilter, relatedEntityTypeFilter, sortBy]);

  const selectedNote = useMemo(() => {
    if (!selectedNoteId) {
      return null;
    }

    return filteredNotes.find((note) => note.id === selectedNoteId) || null;
  }, [filteredNotes, selectedNoteId]);

  async function loadData() {
    try {
      setLoadError("");
      setLoading(true);

      const [notesResponse, documentsResponse, symptomsResponse, proceduresResponse] = await Promise.all([
        fetch("/api/notes"),
        fetch("/api/documents"),
        fetch("/api/symptoms"),
        fetch("/api/procedures"),
      ]);

      const notesPayload = await notesResponse.json();
      const documentsPayload = await documentsResponse.json();
      const symptomsPayload = await symptomsResponse.json();
      const proceduresPayload = await proceduresResponse.json();

      if (!notesResponse.ok) {
        throw new Error(notesPayload.error || "Could not load notes.");
      }

      if (!documentsResponse.ok) {
        throw new Error(documentsPayload.error || "Could not load documents.");
      }

      if (!symptomsResponse.ok) {
        throw new Error(symptomsPayload.error || "Could not load symptoms.");
      }

      if (!proceduresResponse.ok) {
        throw new Error(proceduresPayload.error || "Could not load procedures.");
      }

      const nextNotes = Array.isArray(notesPayload.notes) ? notesPayload.notes : [];
      const nextDocuments = Array.isArray(documentsPayload.documents)
        ? documentsPayload.documents
        : [];
      const nextSymptoms = Array.isArray(symptomsPayload.symptoms)
        ? symptomsPayload.symptoms
        : [];
      const nextProcedures = Array.isArray(proceduresPayload.procedures)
        ? proceduresPayload.procedures
        : [];

      setNotes(nextNotes);
      setDocuments(nextDocuments);
      setSymptoms(nextSymptoms);
      setProcedures(nextProcedures);
      setSelectedNoteId((currentId) => {
        if (requestedNoteId && nextNotes.some((note) => note.id === requestedNoteId)) {
          return requestedNoteId;
        }

        if (currentId && nextNotes.some((note) => note.id === currentId)) {
          return currentId;
        }

        return nextNotes[0]?.id || null;
      });
    } catch (error) {
      setLoadError(error.message || "Could not load note data.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadData();
  }, []);

  useEffect(() => {
    if (filteredNotes.length === 0) {
      setSelectedNoteId(null);
      setEditingNoteId(null);
      return;
    }

    setSelectedNoteId((currentId) => {
      if (currentId && filteredNotes.some((note) => note.id === currentId)) {
        return currentId;
      }

      return filteredNotes[0].id;
    });

    setEditingNoteId((currentEditingId) => {
      if (
        currentEditingId &&
        filteredNotes.some((note) => note.id === currentEditingId)
      ) {
        return currentEditingId;
      }

      return null;
    });
  }, [filteredNotes]);

  function handleCreateFormChange(event) {
    const { name, value } = event.target;

    setCreateForm((currentForm) => ({
      ...currentForm,
      [name]: value,
    }));
  }

  function handleCreateRelatedEntityTypeChange(event) {
    const nextType = event.target.value;

    setCreateForm((currentForm) => ({
      ...currentForm,
      relatedEntityType: nextType,
      relatedEntityId: nextType === currentForm.relatedEntityType ? currentForm.relatedEntityId : "",
    }));
  }

  function handleCreateRelatedEntityChange(event) {
    setCreateForm((currentForm) => ({
      ...currentForm,
      relatedEntityId: event.target.value,
    }));
  }

  async function handleCreateNote(event) {
    event.preventDefault();

    if (!createForm.title.trim()) {
      setCreateError("Title is required.");
      return;
    }

    const createLinkError = getMissingRelatedEntityError(createForm.relatedEntityType);

    if (createLinkError && !createForm.relatedEntityId) {
      setCreateError(createLinkError);
      return;
    }

    try {
      setCreating(true);
      setCreateError("");
      setCreateMessage("");

      const response = await fetch("/api/notes", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(toNotePayload(createForm)),
      });

      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || "Could not create note.");
      }

      const newNote = payload.note;

      setNotes((currentNotes) => [newNote, ...currentNotes]);
      setSelectedNoteId(newNote.id);
      setCreateForm(emptyNoteForm);
      setCreateMessage("Note saved.");
      setEditingNoteId(null);
      setSaveState({
        saving: false,
        message: "",
        error: "",
      });
    } catch (error) {
      setCreateError(error.message || "Could not create note.");
    } finally {
      setCreating(false);
    }
  }

  function startEditingNote(note) {
    setEditingNoteId(note.id);
    setEditForm({
      title: note.title || "",
      content: note.content || "",
      noteType: note.noteType || "general",
      relatedEntityType: note.relatedEntityType || "none",
      relatedEntityId: note.relatedEntityId ? String(note.relatedEntityId) : "",
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

  function cancelEditingNote() {
    setEditingNoteId(null);
    setEditForm(emptyNoteForm);
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

  function handleEditRelatedEntityTypeChange(event) {
    const nextType = event.target.value;

    setEditForm((currentForm) => ({
      ...currentForm,
      relatedEntityType: nextType,
      relatedEntityId: nextType === currentForm.relatedEntityType ? currentForm.relatedEntityId : "",
    }));
  }

  function handleEditRelatedEntityChange(event) {
    setEditForm((currentForm) => ({
      ...currentForm,
      relatedEntityId: event.target.value,
    }));
  }

  async function handleSaveNote(event) {
    event.preventDefault();

    if (!editingNoteId) {
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

    const editLinkError = getMissingRelatedEntityError(editForm.relatedEntityType);

    if (editLinkError && !editForm.relatedEntityId) {
      setSaveState({
        saving: false,
        message: "",
        error: editLinkError,
      });
      return;
    }

    try {
      setSaveState({
        saving: true,
        message: "",
        error: "",
      });

      const response = await fetch(`/api/notes/${editingNoteId}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(toNotePayload(editForm)),
      });

      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || "Could not update note.");
      }

      const updatedNote = payload.note;

      setNotes((currentNotes) =>
        currentNotes.map((note) => (note.id === updatedNote.id ? updatedNote : note))
      );
      setSaveState({
        saving: false,
        message: "Changes saved.",
        error: "",
      });
      setEditingNoteId(null);
    } catch (error) {
      setSaveState({
        saving: false,
        message: "",
        error: error.message || "Could not update note.",
      });
    }
  }

  async function handleDeleteNote(note) {
    const confirmed = window.confirm(`Delete "${note.title}"? This cannot be undone.`);

    if (!confirmed) {
      return;
    }

    try {
      setDeleteState({
        deletingId: note.id,
        error: "",
      });

      const response = await fetch(`/api/notes/${note.id}`, {
        method: "DELETE",
      });

      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || "Could not delete note.");
      }

      setNotes((currentNotes) => {
        const remainingNotes = currentNotes.filter((currentNote) => currentNote.id !== note.id);

        setSelectedNoteId((currentId) => {
          if (currentId !== note.id) {
            return currentId;
          }

          return remainingNotes[0]?.id || null;
        });

        return remainingNotes;
      });

      if (editingNoteId === note.id) {
        cancelEditingNote();
      }

      setDeleteState({
        deletingId: null,
        error: "",
      });
    } catch (error) {
      setDeleteState({
        deletingId: null,
        error: error.message || "Could not delete note.",
      });
    }
  }

  return (
    <>
      <PageHeader
        eyebrow="Working Feature"
        title="Notes"
        description="Save practical notes for your Corolla work, then optionally link each note to one document, symptom, or procedure in the current Notes page."
      />

      <div className="space-y-6">
        <NoteCreateForm
          form={createForm}
          documents={documents}
          symptoms={symptoms}
          procedures={procedures}
          creating={creating}
          createMessage={createMessage}
          createError={createError}
          onChange={handleCreateFormChange}
          onRelatedEntityTypeChange={handleCreateRelatedEntityTypeChange}
          onRelatedEntityChange={handleCreateRelatedEntityChange}
          onSubmit={handleCreateNote}
        />

        <div id="note-library" className="space-y-6">
          {loading ? (
            <section className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-600 shadow-sm">
              Loading notes...
            </section>
          ) : null}

          {loadError ? (
            <section className="rounded-xl border border-red-200 bg-red-50 p-6 shadow-sm">
              <p className="font-semibold text-red-800">Could not load notes.</p>
              <p className="mt-2 text-sm text-red-700">{loadError}</p>
            </section>
          ) : null}

          {!loading && !loadError ? (
            <>
                    <NotesListControls
                      noteTypeFilter={noteTypeFilter}
                      onNoteTypeFilterChange={(event) => setNoteTypeFilter(event.target.value)}
                      relatedEntityTypeFilter={relatedEntityTypeFilter}
                      onRelatedEntityTypeFilterChange={(event) =>
                        setRelatedEntityTypeFilter(event.target.value)
                      }
                      sortBy={sortBy}
                      onSortByChange={(event) => setSortBy(event.target.value)}
                      noteTypes={noteTypes}
                    />

              <section className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600 shadow-sm">
                Showing{" "}
                <span className="font-semibold text-slate-900">{filteredNotes.length}</span>{" "}
                of <span className="font-semibold text-slate-900">{notes.length}</span>{" "}
                note{notes.length === 1 ? "" : "s"}.
              </section>

              <div className="grid gap-6 xl:grid-cols-2">
                <NotesList
                  notes={filteredNotes}
                  selectedNoteId={selectedNoteId}
                  onSelectNote={setSelectedNoteId}
                />

            <NoteDetails
              note={selectedNote}
              isEditing={editingNoteId === selectedNoteId}
              editForm={editForm}
              documents={documents}
              symptoms={symptoms}
              procedures={procedures}
              saveState={saveState}
              deleteState={deleteState}
              onStartEdit={startEditingNote}
              onCancelEdit={cancelEditingNote}
              onEditChange={handleEditFormChange}
              onRelatedEntityTypeChange={handleEditRelatedEntityTypeChange}
              onRelatedEntityChange={handleEditRelatedEntityChange}
              onSaveEdit={handleSaveNote}
              onDelete={handleDeleteNote}
            />
              </div>
            </>
          ) : null}
        </div>
      </div>
    </>
  );
}
