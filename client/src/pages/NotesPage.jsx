import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AttachmentPanel } from "../components/AttachmentPanel";
import { PageHeader } from "../components/PageHeader";
import { ListDetailLayout } from "../components/ListDetailLayout";
import { ListPager } from "../components/ListPager";
import { ErrorBanner, SuccessBanner } from "../components/feedback/Banner";
import { SelectField, TextAreaField, TextField } from "../components/forms/FormFields";
import { RecordPicker } from "../components/forms/RecordPicker";
import { formatDate } from "../lib/formatDate";
import { formatCount, formatLibraryTotal, formatResultRange } from "../lib/resultRange";
import { labelize } from "../lib/labelize";
import { buildEntityLink } from "../lib/navigation";
import { buildNotesListQuery, countNotePages, NOTES_PER_PAGE } from "../lib/notesQuery";
import { useScrollToHash } from "../lib/useScrollToHash";
import {
  DEFAULT_PAGE,
  filterValueUpdates,
  pageParamValue,
  readFilterValues,
  readIdParam,
  readPageParam,
  useViewParamWriter,
} from "../lib/urlState";

const emptyNoteForm = {
  title: "",
  content: "",
  noteType: "general",
  relatedEntityType: "none",
  relatedEntityId: "",
  // The linked record itself, so the picker can show it even when it is not on
  // the page of results the picker has loaded.
  relatedEntity: null,
};

// The filters that materially decide which notes are on screen, and so belong
// in the URL. `noteType` has no options list: the choices are built from the
// note types the owner has actually used.
const NOTE_FILTERS = {
  noteType: { default: "all" },
  relatedEntityType: {
    default: "all",
    options: ["all", "none", "document", "symptom", "procedure"],
  },
  sort: { default: "newest", options: ["newest", "oldest"] },
};

// How to search for each kind of record a note can link to. The picker asks
// `/api/search/*` for one page at a time, so the page never downloads a whole
// library (1,443 documents on the owner's) to offer one link (N7).
const RELATED_ENTITY_PICKERS = {
  document: {
    legend: "Linked document",
    endpoint: "/api/search/documents",
    noun: "document",
    nounPlural: "documents",
    searchLabel: "Find documents",
    searchPlaceholder: "Search titles, systems, or text",
    emptyLibraryText: "No documents available yet. Upload a PDF on the Documents page first.",
    describe: (record) => `${record.system || "No system"} - ${record.documentType || "No type"}`,
    toLinked: ({ id, title, system, documentType }) => ({ id, title, system, documentType }),
  },
  symptom: {
    legend: "Linked symptom",
    endpoint: "/api/search/symptoms",
    noun: "symptom",
    nounPlural: "symptoms",
    searchLabel: "Find symptoms",
    searchPlaceholder: "Search titles, systems, or causes",
    emptyLibraryText: "No symptoms available yet. Create one on the Symptoms page first.",
    describe: (record) => `${record.system || "No system"} - ${labelize(record.status || "open")}`,
    toLinked: ({ id, title, system, status }) => ({ id, title, system, status }),
  },
  procedure: {
    legend: "Linked procedure",
    endpoint: "/api/search/procedures",
    noun: "procedure",
    nounPlural: "procedures",
    searchLabel: "Find procedures",
    searchPlaceholder: "Search titles, systems, steps, or parts",
    emptyLibraryText: "No procedures available yet. Create one on the Procedures page first.",
    describe: (record) =>
      `${record.system || "No system"} - ${labelize(record.difficulty || "intermediate")}`,
    toLinked: ({ id, title, system, difficulty }) => ({ id, title, system, difficulty }),
  },
};

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

/**
 * The record an edit form starts with: the note's linked record as the server
 * sent it, or -- when that record was deleted -- a stand-in carrying only its
 * id. Saving still sends that id, and the server drops a link that was already
 * dead (audit 1B-05) instead of refusing the edit.
 */
function linkedRecordForEdit(note) {
  const picker = RELATED_ENTITY_PICKERS[note.relatedEntityType];

  if (!picker || !note.relatedEntityId) {
    return null;
  }

  const linkedEntity = getLinkedEntity(note);

  return linkedEntity
    ? picker.toLinked(linkedEntity)
    : { id: note.relatedEntityId, title: getLinkedEntityTitle(note) };
}

// One link at a time, so a radio group; it searches the chosen kind of record
// rather than listing all of them.
function RelatedEntityPicker({ relatedEntityType, selected, onSelect, pickerCache, disabled = false }) {
  const picker = RELATED_ENTITY_PICKERS[relatedEntityType];

  if (!picker) {
    return null;
  }

  return (
    <RecordPicker
      key={relatedEntityType}
      multiple={false}
      legend={picker.legend}
      endpoint={picker.endpoint}
      cache={pickerCache}
      selected={selected ? [selected] : []}
      onToggle={(record) => onSelect(picker.toLinked(record))}
      describe={picker.describe}
      noun={picker.noun}
      nounPlural={picker.nounPlural}
      searchLabel={picker.searchLabel}
      searchPlaceholder={picker.searchPlaceholder}
      emptyLibraryText={picker.emptyLibraryText}
      disabled={disabled}
    />
  );
}

function NoteCreateForm({
  form,
  pickerCache,
  creating,
  createMessage,
  createError,
  onChange,
  onRelatedEntityTypeChange,
  onRelatedEntityChange,
  onSubmit,
}) {
  return (
    <section
      id="create-note"
      className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
    >
      <h2 className="text-lg font-semibold text-slate-900">Create note</h2>
      <p className="mt-1 text-sm text-slate-600">
        Save observations, reminders, and repair notes. You can optionally link each note to
        one document, symptom, or procedure.
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
        </div>

        <RelatedEntityPicker
          relatedEntityType={form.relatedEntityType}
          selected={form.relatedEntity}
          onSelect={onRelatedEntityChange}
          pickerCache={pickerCache}
          disabled={creating}
        />

        <TextAreaField
          label="Content"
          name="content"
          value={form.content}
          onChange={onChange}
          placeholder="Write your note here..."
        />

        {createMessage ? <SuccessBanner>{createMessage}</SuccessBanner> : null}

        {createError ? <ErrorBanner>{createError}</ErrorBanner> : null}

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={creating}
            className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-600"
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

// Title grew and the three trailing columns shrank to what they measure:
// a note type is 71px, a linked-item label 103px, a formatted date 102px.
// Tracks 224+96+136+120 = 576px, +3x12px gap +32px padding = 644px.
//
// NotesList is page-local, so this export exists purely so the shared width
// test can name the notes table directly rather than guessing which arbitrary
// class in a 1200-line page file belongs to it.
export const notesListTable = {
  name: "Notes",
  gridClass:
    "grid grid-cols-[minmax(14rem,2.5fr)_minmax(6rem,1fr)_minmax(8.5rem,1.4fr)_minmax(7.5rem,1fr)] gap-3",
  minWidthClass: "min-w-[41rem]",
};

function NotesList({
  notes,
  totalNotes = 0,
  hasActiveFilters = false,
  selectedNoteId,
  onSelectNote,
}) {
  const listGridClass = notesListTable.gridClass;

  return (
    <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="overflow-x-auto">
        <div className={notesListTable.minWidthClass}>
          <div
            className={`${listGridClass} border-b border-slate-200 bg-slate-50 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-600`}
          >
            <span>Title</span>
            <span>Type</span>
            <span>Linked item</span>
            <span>Updated</span>
          </div>

          {/* "You have written nothing" and "your filters hide everything" need
              different next steps; the create form is directly above the list. */}
          {notes.length === 0 ? (
            <div className="px-4 py-8 text-sm text-slate-600">
              {totalNotes === 0 ? (
                <div className="space-y-2">
                  <p className="font-semibold text-slate-900">No notes yet.</p>
                  <p>Write your first note above to start your repair log.</p>
                </div>
              ) : hasActiveFilters ? (
                <div className="space-y-2">
                  <p className="font-semibold text-slate-900">
                    No notes match these filters.
                  </p>
                  <p>Change the filters above to see more of your notes.</p>
                </div>
              ) : (
                <p>No notes are available right now.</p>
              )}
            </div>
          ) : null}

          {notes.map((note) => {
            const isSelected = note.id === selectedNoteId;
            const relatedLabel = getLinkedEntityTitle(note);

            return (
              <button
                key={note.id}
                type="button"
                aria-current={isSelected ? "true" : undefined}
                aria-label={`Select note: ${note.title}`}
                className={`${listGridClass} w-full items-center border-b border-slate-100 px-4 py-3 text-left text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sky-500 ${
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
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function NoteEditForm({
  form,
  pickerCache,
  saveState,
  onChange,
  onRelatedEntityTypeChange,
  onRelatedEntityChange,
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
      </div>

      <RelatedEntityPicker
        relatedEntityType={form.relatedEntityType}
        selected={form.relatedEntity}
        onSelect={onRelatedEntityChange}
        pickerCache={pickerCache}
        disabled={saveState.saving}
      />

      <TextAreaField label="Content" name="content" value={form.content} onChange={onChange} />

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
    </form>
  );
}

function NoteDetails({
  note,
  isEditing,
  editForm,
  pickerCache,
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
          <h2 className="text-xl font-semibold text-slate-900">{note.title}</h2>
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
          <h3 className="font-semibold text-slate-900">Content</h3>
          <p className="mt-2 whitespace-pre-wrap text-slate-700">
            {note.content || "No content yet."}
          </p>
        </div>

        {note.relatedEntityType !== "none" ? (
          <div>
            <h3 className="font-semibold text-slate-900">{linkedEntityHeading}</h3>
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
              /* The linked record is gone (or was never joined), so say that
                 rather than printing a bare database id at the owner. */
              <p className="mt-2 text-slate-700">
                {note.relatedEntityId
                  ? `${linkedEntityHeading} #${note.relatedEntityId} is no longer available.`
                  : `${linkedEntityHeading} is no longer available.`}
              </p>
            )}
          </div>
        ) : null}

        <AttachmentPanel key={`attachments-${note.id}`} entityType="note" entityId={note.id} />
      </div>

      {isEditing ? (
        <NoteEditForm
          form={editForm}
          pickerCache={pickerCache}
          saveState={saveState}
          onChange={onEditChange}
          onRelatedEntityTypeChange={onRelatedEntityTypeChange}
          onRelatedEntityChange={onRelatedEntityChange}
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

// A different kind of link drops the chosen record: a document id is not a
// procedure id.
function withRelatedEntityType(form, nextType) {
  if (nextType === form.relatedEntityType) {
    return form;
  }

  return { ...form, relatedEntityType: nextType, relatedEntityId: "", relatedEntity: null };
}

function withRelatedEntity(form, record) {
  return { ...form, relatedEntityId: String(record.id), relatedEntity: record };
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

// Mirrors the Symptoms and Procedures pages (N7): the server filters, sorts,
// counts, and slices the list, so this page holds one page of rows and never
// every note.
function NoteLookupError({ noteId, message, onRetry }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <ErrorBanner title={`Could not load note #${noteId}.`}>
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

export function NotesPage() {
  useScrollToHash();

  const [searchParams, setSearchParams] = useSearchParams();
  const requestedNoteId = readIdParam(searchParams, "noteId");
  const requestedPage = readPageParam(searchParams);
  // `notes` is the ONE PAGE the server last sent -- never every note. The server
  // also owns the counts: `matchedCount` is how many notes the current filters
  // leave; `libraryTotal` is every note.
  const [notes, setNotes] = useState([]);
  const [matchedCount, setMatchedCount] = useState(0);
  const [libraryTotal, setLibraryTotal] = useState(0);
  // Which request the rows above answer; anything that reasons about "this view"
  // waits until it equals the current request.
  const [settledQuery, setSettledQuery] = useState(null);
  const [settledPage, setSettledPage] = useState(DEFAULT_PAGE);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [isFetching, setIsFetching] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [reloadToken, setReloadToken] = useState(0);
  const latestListRequest = useRef(0);
  // The Note type filter's choices, from every note rather than the loaded page.
  const [noteTypes, setNoteTypes] = useState([]);
  const [optionsToken, setOptionsToken] = useState(0);
  // The selected note when its row is not on the current page (a deep link, a
  // note just created that a filter hides).
  const [fetchedNote, setFetchedNote] = useState(null);
  // A by-id lookup that failed for a reason other than "no such note".
  const [lookupFailure, setLookupFailure] = useState(null);
  // A selection this page made before the URL has caught up with it.
  const [pinnedNoteId, setPinnedNoteId] = useState(null);
  // Shared by the create and edit pickers, so switching between them does not
  // ask for the same first page again.
  const pickerCache = useRef(new Map()).current;
  // Notes this page deleted: a lookup for one could only answer 404.
  const deletedNoteIds = useRef(new Set());

  const [createForm, setCreateForm] = useState(emptyNoteForm);
  const [creating, setCreating] = useState(false);
  const [createMessage, setCreateMessage] = useState("");
  const [createError, setCreateError] = useState("");

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
  // One writer for every URL change this page makes, so two writes close
  // together both land.
  const updateViewParams = useViewParamWriter(searchParams, setSearchParams);

  // Filters read from the URL, so Back returns to the filtered list the owner
  // was reading rather than to an unfiltered one.
  const {
    noteType: noteTypeFilter,
    relatedEntityType: relatedEntityTypeFilter,
    sort: sortBy,
  } = readFilterValues(searchParams, NOTE_FILTERS);
  // The pin outranks the URL: it only exists while a selection this page made
  // has not reached the URL yet.
  const selectionId = pinnedNoteId ?? requestedNoteId;

  // The request is a pure function of the view state in the URL, and that string
  // is the only thing the fetch effect depends on.
  const listQuery = buildNotesListQuery({
    noteType: noteTypeFilter,
    relatedEntityType: relatedEntityTypeFilter,
    sort: sortBy,
    page: requestedPage,
  });
  const dataIsCurrent = settledQuery === listQuery;
  const totalPages = countNotePages(matchedCount);
  const currentPage = Math.min(settledPage, totalPages);
  const loadingAnotherPage = isFetching && !dataIsCurrent && requestedPage !== currentPage;

  // Changing a filter is a navigation step the owner should be able to undo, so
  // it pushes -- and it drops `page`, because page 4 of the old filter says
  // nothing about the new one.
  function handleFilterChange(key, value) {
    updateViewParams({
      ...filterValueUpdates({ [key]: value }, NOTE_FILTERS),
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

  const hasActiveFilters = noteTypeFilter !== "all" || relatedEntityTypeFilter !== "all";

  // The selected note is derived, not stored. No `noteId` means "the first note"
  // -- the first row of the page on screen -- spelled as the absence of a
  // parameter. A `noteId` whose row is not on this page is fetched on its own
  // below, so a deep link opens its record under any filter or page.
  const rowNote = selectionId ? notes.find((note) => note.id === selectionId) : null;
  const fetchedMatch = selectionId && fetchedNote?.id === selectionId ? fetchedNote : null;
  const selectedNote = selectionId ? rowNote || fetchedMatch || null : notes[0] || null;
  const selectedNoteId = selectedNote?.id ?? null;
  const selectionLookupFailure =
    selectionId && !selectedNote && lookupFailure?.noteId === selectionId ? lookupFailure : null;

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

  // An unusable `noteId` ("abc", "0") names nothing, so it drops out of the URL.
  useEffect(() => {
    if (!dataIsCurrent || !searchParams.has("noteId") || requestedNoteId) {
      return;
    }

    updateViewParams({ noteId: null }, { replace: true });
  }, [dataIsCurrent, requestedNoteId, searchParams, updateViewParams]);

  // A well-formed `noteId` whose row is not on this page is looked up by id. The
  // server's 404 is what says it does not exist -- deleted, or hand-typed -- and
  // only then does the parameter drop out of the URL. A note that exists but
  // that the filters hide keeps its parameter and is shown.
  const requestedRowIsOnPage = Boolean(rowNote);
  useEffect(() => {
    if (
      !selectionId ||
      !dataIsCurrent ||
      requestedRowIsOnPage ||
      fetchedNote?.id === selectionId ||
      lookupFailure?.noteId === selectionId
    ) {
      return undefined;
    }

    // Deleted here, so the server would only say 404: answer that without asking.
    if (deletedNoteIds.current.has(selectionId)) {
      setPinnedNoteId(null);
      updateViewParams({ noteId: null }, { replace: true });
      return undefined;
    }

    let cancelled = false;

    async function lookUpNote() {
      try {
        const response = await fetch(`/api/notes/${selectionId}`);
        const payload = await response.json().catch(() => ({}));

        if (cancelled) {
          return;
        }

        if (response.status === 404) {
          setFetchedNote(null);
          setPinnedNoteId(null);
          updateViewParams({ noteId: null }, { replace: true });
          return;
        }

        if (!response.ok || !payload.note) {
          throw new Error(payload.error || "The server could not load it.");
        }

        setFetchedNote(payload.note);
      } catch (error) {
        if (!cancelled) {
          setLookupFailure({
            noteId: selectionId,
            message:
              error instanceof TypeError
                ? "The server could not be reached."
                : error.message || "The server could not load it.",
          });
        }
      }
    }

    lookUpNote();

    return () => {
      cancelled = true;
    };
  }, [selectionId, dataIsCurrent, requestedRowIsOnPage, fetchedNote, lookupFailure, updateViewParams]);

  // A failed lookup is remembered only for the visit it failed on.
  useEffect(() => {
    setLookupFailure(null);
  }, [selectionId]);

  // The pin's job is done once the URL names a note itself, and it never
  // outlives the view it was made in.
  useEffect(() => {
    setPinnedNoteId(null);
  }, [requestedNoteId, listQuery]);

  // An edit form has to close when its note stops being the one on display, or
  // the page would keep editing a record nobody can see.
  useEffect(() => {
    setEditingNoteId((currentId) =>
      currentId && currentId !== selectedNoteId ? null : currentId
    );
  }, [selectedNoteId]);

  // One request per view. The fetch depends on the request string alone, so a
  // filter, sort, or page change is exactly one fetch and a selection change
  // within the page is none. Rows from the previous view stay on screen until
  // the new ones arrive.
  useEffect(() => {
    const requestId = latestListRequest.current + 1;
    latestListRequest.current = requestId;

    async function loadNotes() {
      setIsFetching(true);
      // Set when this answer hands over to another request instead of settling.
      let handedOff = false;

      try {
        const response = await fetch(`/api/notes?${listQuery}`);
        const payload = await response.json();

        // A newer view has been asked for since: this answer is stale.
        if (requestId !== latestListRequest.current) {
          return;
        }

        if (!response.ok) {
          throw new Error(payload.error || "Could not load notes.");
        }

        const nextNotes = Array.isArray(payload.notes) ? payload.notes : [];
        const nextMatched = Number.isFinite(payload.matched) ? payload.matched : nextNotes.length;
        const offset = Number(new URLSearchParams(listQuery).get("offset")) || 0;

        // A page past the end answers with no rows while notes do match. That
        // empty answer is never shown as the list: the URL moves to the last
        // real page, and that request's answer is the one that settles.
        if (!nextNotes.length && nextMatched > 0 && offset >= nextMatched) {
          handedOff = true;
          updateViewParams({ page: pageParamValue(countNotePages(nextMatched)) }, { replace: true });
          return;
        }

        setNotes(nextNotes);
        setSettledPage(Math.floor(offset / NOTES_PER_PAGE) + 1);
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
              : error.message || "Could not load notes."
          );
        }
      } finally {
        if (requestId === latestListRequest.current && !handedOff) {
          setIsFetching(false);
        }
      }
    }

    loadNotes();

    // Leaving the page, or asking for another view, makes this answer stale.
    return () => {
      latestListRequest.current += 1;
    };
  }, [listQuery, reloadToken, updateViewParams]);

  useEffect(() => {
    let cancelled = false;

    async function loadFilterOptions() {
      try {
        const response = await fetch("/api/notes/filter-options");
        const payload = await response.json();

        if (cancelled || !response.ok) {
          return;
        }

        setNoteTypes(Array.isArray(payload.noteTypes) ? payload.noteTypes : []);
      } catch {
        // The dropdown keeps what it had; the list does not depend on it.
      }
    }

    loadFilterOptions();

    return () => {
      cancelled = true;
    };
  }, [optionsToken]);

  // Re-ask the server for the page on screen after something changed it. The
  // rows stay put meanwhile, so a save does not flash the list away.
  function reloadList({ options = false } = {}) {
    setReloadToken((token) => token + 1);

    if (options) {
      setOptionsToken((token) => token + 1);
    }
  }

  // A saved note reaches its row and the by-id copy immediately; the reload that
  // follows lets the server decide whether it still belongs on this page.
  //
  // Every save bumps `updated_at`, so "Newest first" reorders the page. When the
  // selection is only implicit (the page's first row), that reorder would hand
  // the panel to a different note, so the one ON DISPLAY is pinned into the URL
  // first and kept as the by-id copy.
  function applyUpdatedNote(updatedNote) {
    const displayedNote = selectedNote;
    const isDisplayed = updatedNote.id === displayedNote?.id;
    const pinDisplayed = Boolean(displayedNote) && !requestedNoteId;

    setNotes((currentNotes) =>
      currentNotes.map((note) => (note.id === updatedNote.id ? updatedNote : note))
    );
    setFetchedNote((currentNote) => {
      if (isDisplayed || currentNote?.id === updatedNote.id) {
        return updatedNote;
      }

      return pinDisplayed ? displayedNote : currentNote;
    });

    if (pinDisplayed) {
      setPinnedNoteId(displayedNote.id);
      updateViewParams({ noteId: displayedNote.id }, { replace: true });
    }
  }

  function handleCreateFormChange(event) {
    const { name, value } = event.target;

    setCreateForm((currentForm) => ({
      ...currentForm,
      [name]: value,
    }));
  }

  function handleCreateRelatedEntityTypeChange(event) {
    setCreateForm((currentForm) => withRelatedEntityType(currentForm, event.target.value));
  }

  function handleCreateRelatedEntityChange(record) {
    setCreateForm((currentForm) => withRelatedEntity(currentForm, record));
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

      // The new note is shown at once from the server's answer, whether or not
      // the current filters and page will include its row; the reload then
      // brings the list (and its counts) up to date.
      setFetchedNote(newNote);
      setPinnedNoteId(newNote.id);
      // Replace, not push: opening the note just created is part of creating
      // it, not a step to press Back through.
      updateViewParams({ noteId: newNote.id }, { replace: true });
      reloadList({ options: true });
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
      relatedEntity: linkedRecordForEdit(note),
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
    setEditForm((currentForm) => withRelatedEntityType(currentForm, event.target.value));
  }

  function handleEditRelatedEntityChange(record) {
    setEditForm((currentForm) => withRelatedEntity(currentForm, record));
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

      applyUpdatedNote(payload.note);
      reloadList({ options: true });
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

      deletedNoteIds.current.add(note.id);
      // The row goes at once; the reload refills the page from the server (and
      // steps back a page when this was the last row on the last one). A URL
      // that named the deleted note stops naming it, so the panel falls back to
      // the first row rather than looking up a record that is gone.
      setNotes((currentNotes) => currentNotes.filter((currentNote) => currentNote.id !== note.id));
      setFetchedNote((current) => (current?.id === note.id ? null : current));
      setPinnedNoteId((current) => (current === note.id ? null : current));

      if (requestedNoteId === note.id) {
        updateViewParams({ noteId: null }, { replace: true });
      }

      reloadList({ options: true });

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

  // The range of the page on screen. The library total is shown nowhere else on
  // this page, so a narrowed list says what it was narrowed from.
  const from = (currentPage - 1) * NOTES_PER_PAGE + 1;
  const range = formatResultRange({
    from,
    to: from + notes.length - 1,
    total: matchedCount,
    noun: "note",
    nounPlural: "notes",
    // The zero-state carries the library size, which the list's own empty state
    // below does not, so the two do not simply repeat each other.
    emptyText: libraryTotal
      ? `No notes match these filters. ${formatLibraryTotal({
          total: libraryTotal,
          noun: "note",
          nounPlural: "notes",
        })}`
      : "No notes in your library yet.",
  });
  const noteRangeSummary =
    matchedCount && matchedCount !== libraryTotal
      ? `${range} Filtered from ${formatCount(libraryTotal)} in your library.`
      : range;
  const fetchingText = isFetching
    ? loadingAnotherPage
      ? `Loading page ${requestedPage}...`
      : "Updating..."
    : "";

  return (
    <>
      <PageHeader
        title="Notes"
        description="Save practical notes for your Corolla work, then optionally link each note to one document, symptom, or procedure."
      />

      <div className="space-y-6">
        <NoteCreateForm
          form={createForm}
          pickerCache={pickerCache}
          creating={creating}
          createMessage={createMessage}
          createError={createError}
          onChange={handleCreateFormChange}
          onRelatedEntityTypeChange={handleCreateRelatedEntityTypeChange}
          onRelatedEntityChange={handleCreateRelatedEntityChange}
          onSubmit={handleCreateNote}
        />

        <div id="note-library" className="space-y-6" aria-busy={isFetching}>
          {!hasLoaded && !loadError ? (
            <section className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-600 shadow-sm">
              Loading notes...
            </section>
          ) : null}

          {loadError ? (
            <ErrorBanner title="Could not load notes." className="shadow-sm">
              {loadError}
              {hasLoaded ? " The notes below are the last ones that loaded." : null}
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
              <NotesListControls
                noteTypeFilter={noteTypeFilter}
                onNoteTypeFilterChange={(event) =>
                  handleFilterChange("noteType", event.target.value)
                }
                relatedEntityTypeFilter={relatedEntityTypeFilter}
                onRelatedEntityTypeFilterChange={(event) =>
                  handleFilterChange("relatedEntityType", event.target.value)
                }
                sortBy={sortBy}
                onSortByChange={(event) => handleFilterChange("sort", event.target.value)}
                noteTypes={noteTypes}
              />

              <section className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600 shadow-sm sm:flex-row sm:items-center sm:justify-between">
                <p role="status">
                  {noteRangeSummary}
                  {fetchingText ? (
                    <span className="ml-2 text-xs text-slate-500">{fetchingText}</span>
                  ) : null}
                </p>
                <ListPager
                  label="Notes pages"
                  currentPage={currentPage}
                  totalPages={totalPages}
                  onGoToPage={goToPage}
                />
              </section>

              <ListDetailLayout
                selectedId={selectedNoteId}
                list={
                  <NotesList
                    notes={notes}
                    totalNotes={libraryTotal}
                    hasActiveFilters={hasActiveFilters}
                    selectedNoteId={selectedNoteId}
                    onSelectNote={(noteId) => updateViewParams({ noteId })}
                  />
                }
                detail={
                  selectionLookupFailure ? (
                    <NoteLookupError
                      noteId={selectionLookupFailure.noteId}
                      message={selectionLookupFailure.message}
                      // Clearing the failure is what lets the lookup run again.
                      onRetry={() => setLookupFailure(null)}
                    />
                  ) : (
                    <NoteDetails
                      note={selectedNote}
                      isEditing={editingNoteId === selectedNoteId}
                      editForm={editForm}
                      pickerCache={pickerCache}
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
