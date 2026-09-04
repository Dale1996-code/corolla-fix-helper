import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { PageHeader } from "../components/PageHeader";
import { ListDetailLayout } from "../components/ListDetailLayout";
import { ErrorBanner, InfoBanner, SuccessBanner } from "../components/feedback/Banner";
import { SelectField, TextAreaField, TextField } from "../components/forms/FormFields";
import { formatDate, getSortTimestamp } from "../lib/formatDate";
import { formatLibraryTotal } from "../lib/resultRange";
import { buildEntityLink } from "../lib/navigation";
import {
  DEFAULT_REPAIR_OUTCOME,
  parseOdometerInput,
  REPAIR_OUTCOME_OPTIONS,
} from "../lib/repairHistory";
import { useScrollToHash } from "../lib/useScrollToHash";
import { applyParamUpdates, readIdParam } from "../lib/urlState";

const STATUS_OPTIONS = [
  { value: "planned", label: "Planned" },
  { value: "in_progress", label: "In progress" },
  { value: "blocked", label: "Blocked" },
  { value: "done", label: "Done" },
];

const STATUS_LABELS = STATUS_OPTIONS.reduce((labels, option) => {
  labels[option.value] = option.label;
  return labels;
}, {});

const STATUS_BADGE_CLASSES = {
  planned: "bg-slate-100 text-slate-700",
  in_progress: "bg-sky-100 text-sky-800",
  blocked: "bg-amber-100 text-amber-800",
  done: "bg-emerald-100 text-emerald-800",
};

const emptyChecklistForm = {
  title: "",
  status: "planned",
  description: "",
  notes: "",
};

// The completion form's own fields, and ONLY the historical facts the API
// accepts. There is no title here and no sources: the server takes the title
// from the checklist and the provenance from the checklist's own saved rows,
// inside the writing transaction. A title or a `sources` array sent from the
// browser is ignored, and building either into this form would be a standing
// invitation to make the browser the authority on what backed a repair.
const emptyCompletionForm = {
  performedOn: "",
  odometerMiles: "",
  outcome: DEFAULT_REPAIR_OUTCOME,
  summary: "",
  followUp: "",
  symptomId: "",
};

// Tagged with the checklist it describes. A completion request can outlive the
// screen that sent it -- the owner selects another checklist, opens its form --
// and an untagged banner would then report one checklist's repair underneath a
// different one.
const emptyCompletionState = { checklistId: null, saving: false, message: "", error: "" };

function statusLabel(status) {
  return STATUS_LABELS[status] || "Planned";
}

function statusBadgeClass(status) {
  return STATUS_BADGE_CLASSES[status] || STATUS_BADGE_CLASSES.planned;
}

function StatusBadge({ status }) {
  return (
    <span
      className={`inline-flex rounded-full px-3 py-1 text-xs font-semibold ${statusBadgeClass(status)}`}
    >
      {statusLabel(status)}
    </span>
  );
}

function ChecklistCreateForm({ form, creating, createMessage, createError, onChange, onSubmit }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <h2 className="text-lg font-semibold text-slate-900">Create checklist</h2>
      <p className="mt-1 text-sm text-slate-600">
        Group the steps for a repair job, then check them off and reorder them as you work.
      </p>

      <form className="mt-4 grid gap-4" onSubmit={onSubmit}>
        <div className="grid gap-4 md:grid-cols-2">
          <TextField
            label="Title"
            name="title"
            value={form.title}
            onChange={onChange}
            required
            placeholder="Front brake job"
          />
          <SelectField
            label="Status"
            name="status"
            value={form.status}
            onChange={onChange}
            options={STATUS_OPTIONS}
          />
        </div>

        <TextAreaField
          label="Description"
          name="description"
          value={form.description}
          onChange={onChange}
          placeholder="What is this checklist for?"
        />

        <TextAreaField
          label="Notes"
          name="notes"
          value={form.notes}
          onChange={onChange}
          placeholder="Torque specs, part numbers, reminders..."
        />

        {createMessage ? <SuccessBanner>{createMessage}</SuccessBanner> : null}

        {createError ? <ErrorBanner>{createError}</ErrorBanner> : null}

        <div>
          <button
            type="submit"
            disabled={creating}
            className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-600"
          >
            {creating ? "Saving..." : "Save checklist"}
          </button>
        </div>
      </form>
    </section>
  );
}

// Checklist titles are long and were the most cramped column on the page at
// 11rem; Status (60px), Progress (an 82px header over "3/8"), and Updated
// (a 102px date) funded the increase.
// Tracks 224+96+96+120 = 536px, +3x12px gap +32px padding = 604px.
//
// ChecklistList is page-local; see NotesPage for why the table's width is
// exported as one named definition.
export const checklistListTable = {
  name: "RepairChecklists",
  gridClass:
    "grid grid-cols-[minmax(14rem,2.4fr)_minmax(6rem,1fr)_minmax(6rem,0.9fr)_minmax(7.5rem,1fr)] gap-3",
  minWidthClass: "min-w-[38rem]",
};

function ChecklistList({ checklists, selectedChecklistId, onSelectChecklist }) {
  const listGridClass = checklistListTable.gridClass;

  return (
    <section
      id="checklist-library"
      className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm"
    >
      <div className="overflow-x-auto">
        <div className={checklistListTable.minWidthClass}>
          <div
            className={`${listGridClass} border-b border-slate-200 bg-slate-50 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-600`}
          >
            <span>Title</span>
            <span>Status</span>
            <span>Progress</span>
            <span>Updated</span>
          </div>

          {checklists.length === 0 ? (
            <div className="space-y-2 px-4 py-8 text-sm text-slate-600">
              <p className="font-semibold text-slate-900">No checklists yet.</p>
              <p>Create your first checklist above to plan a repair job step by step.</p>
            </div>
          ) : null}

          {checklists.map((checklist) => {
            const isSelected = checklist.id === selectedChecklistId;

            return (
              <button
                key={checklist.id}
                type="button"
                aria-current={isSelected ? "true" : undefined}
                aria-label={`Select checklist: ${checklist.title}`}
                className={`${listGridClass} w-full items-center border-b border-slate-100 px-4 py-3 text-left text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sky-500 ${
                  isSelected ? "bg-sky-50" : "hover:bg-slate-50"
                }`}
                onClick={() => onSelectChecklist(checklist.id)}
              >
                <span className="truncate font-medium text-slate-900">{checklist.title}</span>
                <span className="truncate text-slate-700">{statusLabel(checklist.status)}</span>
                <span className="truncate text-slate-700">
                  {checklist.doneItemCount}/{checklist.itemCount}
                </span>
                <span className="truncate text-xs text-slate-600">
                  {formatDate(checklist.updatedAt)}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function ChecklistItemRow({
  item,
  index,
  itemCount,
  isEditing,
  editingText,
  pending,
  onToggle,
  onStartEdit,
  onEditTextChange,
  onSaveEdit,
  onCancelEdit,
  onMove,
  onDelete,
}) {
  return (
    <li className="flex flex-wrap items-center gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2">
      <input
        type="checkbox"
        className="h-4 w-4 shrink-0"
        checked={item.isDone}
        onChange={() => onToggle(item)}
        disabled={pending}
        aria-label={`Toggle done for ${item.text}`}
      />

      {isEditing ? (
        <form
          className="flex min-w-0 flex-1 flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            onSaveEdit(item);
          }}
        >
          <input
            className="min-w-0 flex-1 rounded-lg border border-slate-300 px-2 py-1 text-sm outline-none focus:border-sky-500"
            value={editingText}
            onChange={(event) => onEditTextChange(event.target.value)}
            aria-label={`Edit text for ${item.text}`}
          />
          <button
            type="submit"
            disabled={pending}
            className="rounded-lg bg-sky-600 px-3 py-1 text-xs font-semibold text-white hover:bg-sky-500 disabled:cursor-not-allowed disabled:bg-slate-600"
          >
            Save
          </button>
          <button
            type="button"
            onClick={onCancelEdit}
            className="rounded-lg border border-slate-300 px-3 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-100"
          >
            Cancel
          </button>
        </form>
      ) : (
        <span
          className={`min-w-0 flex-1 text-sm ${
            item.isDone ? "text-slate-500 line-through" : "text-slate-800"
          }`}
        >
          {item.text}
        </span>
      )}

      {!isEditing ? (
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => onMove(item, "up")}
            disabled={pending || index === 0}
            className="rounded-lg border border-slate-300 px-2 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
            aria-label={`Move ${item.text} up`}
          >
            Up
          </button>
          <button
            type="button"
            onClick={() => onMove(item, "down")}
            disabled={pending || index === itemCount - 1}
            className="rounded-lg border border-slate-300 px-2 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
            aria-label={`Move ${item.text} down`}
          >
            Down
          </button>
          <button
            type="button"
            onClick={() => onStartEdit(item)}
            disabled={pending}
            className="rounded-lg border border-slate-300 px-2 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
            aria-label={`Edit ${item.text}`}
          >
            Edit
          </button>
          <button
            type="button"
            onClick={() => onDelete(item)}
            disabled={pending}
            className="rounded-lg border border-red-300 px-2 py-1 text-xs font-semibold text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40"
            aria-label={`Delete ${item.text}`}
          >
            Delete
          </button>
        </div>
      ) : null}
    </li>
  );
}

function ChecklistItems({
  items,
  itemError,
  newItemText,
  addingItem,
  itemActionPending,
  editingItemId,
  editingItemText,
  onNewItemTextChange,
  onAddItem,
  onToggleItem,
  onStartEditItem,
  onEditItemTextChange,
  onSaveItemEdit,
  onCancelItemEdit,
  onMoveItem,
  onDeleteItem,
}) {
  return (
    <div className="mt-5">
      <h3 className="font-semibold text-slate-900">Items</h3>

      <form className="mt-2 flex flex-wrap items-center gap-2" onSubmit={onAddItem}>
        <input
          className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-sky-500 disabled:cursor-not-allowed disabled:bg-slate-100"
          value={newItemText}
          onChange={(event) => onNewItemTextChange(event.target.value)}
          placeholder="Add a checklist item"
          aria-label="New checklist item"
          disabled={addingItem}
        />
        <button
          type="submit"
          disabled={addingItem}
          className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-600"
        >
          {addingItem ? "Adding..." : "Add item"}
        </button>
      </form>

      {itemError ? <ErrorBanner className="mt-2">{itemError}</ErrorBanner> : null}

      {items.length === 0 ? (
        <p className="mt-3 text-sm text-slate-600">No items yet. Add the first step above.</p>
      ) : (
        <ul className="mt-3 grid gap-2">
          {items.map((item, index) => (
            <ChecklistItemRow
              key={item.id}
              item={item}
              index={index}
              itemCount={items.length}
              isEditing={editingItemId === item.id}
              editingText={editingItemText}
              pending={itemActionPending}
              onToggle={onToggleItem}
              onStartEdit={onStartEditItem}
              onEditTextChange={onEditItemTextChange}
              onSaveEdit={onSaveItemEdit}
              onCancelEdit={onCancelItemEdit}
              onMove={onMoveItem}
              onDelete={onDeleteItem}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function ChecklistEditForm({ form, saveState, onChange, onSubmit, onCancel }) {
  const titleInputRef = useRef(null);

  // The Edit button only renders this form once clicked, so mounting is the
  // "form opened" event — move focus in so a keyboard user lands in it.
  useEffect(() => {
    titleInputRef.current?.focus();
  }, []);

  return (
    <form
      className="mt-4 grid gap-4 rounded-xl border border-slate-200 bg-slate-50 p-4"
      onSubmit={onSubmit}
    >
      <div className="grid gap-4 md:grid-cols-2">
        <TextField
          ref={titleInputRef}
          label="Title"
          name="title"
          value={form.title}
          onChange={onChange}
          required
        />
        <SelectField
          label="Status"
          name="status"
          value={form.status}
          onChange={onChange}
          options={STATUS_OPTIONS}
        />
      </div>

      <TextAreaField
        label="Description"
        name="description"
        value={form.description}
        onChange={onChange}
      />
      <TextAreaField label="Notes" name="notes" value={form.notes} onChange={onChange} />

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

// Shown once a checklist has been recorded as a repair.
//
// This is the reload-safe half of the completion workflow, and the reason
// `repairHistoryId` is on the checklist payload at all. Derived from the
// server's own field rather than from anything this page remembers, so a
// refresh, a Back, or a fresh browser lands on exactly this panel instead of a
// blank completion form that invites the owner to record a repair that already
// exists.
//
// Deliberately NOT derived from `status === "done"`: done is an organizational
// state the owner can set from the dropdown, and it records nothing.
function RecordedRepairPanel({ repairHistoryId, linkRef }) {
  return (
    <section className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
      <p className="font-semibold">Recorded in Repair History</p>
      <p className="mt-2">
        This checklist has already been recorded as a repair. One checklist records one repair, so
        there is nothing more to enter here.
      </p>
      {/* Focus lands here the moment a repair is recorded: the form the keyboard
          user was in has just been removed, and this link is what replaced it. */}
      <Link
        ref={linkRef}
        to={buildEntityLink("repairHistory", repairHistoryId)}
        className="mt-3 inline-flex font-medium text-emerald-900 underline decoration-emerald-300 underline-offset-2 hover:text-emerald-950"
      >
        Open the repair record
      </Link>
    </section>
  );
}

// The one place a repair gets written into permanent history.
//
// It asks for exactly the facts nothing on the server can derive -- the day the
// work happened, the mileage, how it turned out, what was done, what is left --
// and nothing else. The repair's title and its source documents are the
// checklist's own and are read server-side; see the trust boundary on
// `POST /api/repair-checklists/:id/complete`.
function ChecklistCompletionForm({
  form,
  symptomOptions,
  symptomsError,
  completionState,
  onChange,
  onSubmit,
  onCancel,
}) {
  const dateInputRef = useRef(null);

  // The button only renders this form once pressed, so mounting is the "form
  // opened" event -- move focus to the first field, which is also the only
  // required one, so a keyboard user lands where the work starts.
  useEffect(() => {
    dateInputRef.current?.focus();
  }, []);

  return (
    <form
      className="mt-4 grid gap-4 rounded-xl border border-slate-200 bg-slate-50 p-4"
      onSubmit={onSubmit}
    >
      <div>
        <h3 className="text-base font-semibold text-slate-900">Record completed repair</h3>
        <p className="mt-1 text-sm text-slate-600">
          Save this checklist as a repair that actually happened. The repair keeps the checklist's
          title and the document pages that backed it.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <TextField
          ref={dateInputRef}
          label="Repair date"
          name="performedOn"
          type="date"
          value={form.performedOn}
          onChange={onChange}
          required
        />
        {/* `inputMode="numeric"` rather than `type="number"`: a number input
            silently DISCARDS anything it cannot parse, so an owner who types
            "183,456" watches the box empty itself with no explanation and the
            reading is quietly lost. Keeping it a text box means what was typed
            stays on screen and `parseOdometerInput` can say what is wrong with
            it, while a phone still gets the numeric keypad. */}
        <TextField
          label="Odometer (miles)"
          name="odometerMiles"
          inputMode="numeric"
          value={form.odometerMiles}
          onChange={onChange}
          placeholder="183456"
          helpText="Leave blank if you did not write it down."
        />
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <SelectField
          label="Outcome"
          name="outcome"
          value={form.outcome}
          onChange={onChange}
          options={REPAIR_OUTCOME_OPTIONS}
        />
        <SelectField
          label="Symptom"
          name="symptomId"
          value={form.symptomId}
          onChange={onChange}
          options={symptomOptions}
          emptyOption="No symptom linked"
        />
      </div>

      {symptomsError ? (
        <InfoBanner tone="amber">
          {symptomsError} You can still record the repair without linking a symptom.
        </InfoBanner>
      ) : null}

      <TextAreaField
        label="What was done"
        name="summary"
        value={form.summary}
        onChange={onChange}
        placeholder="Replaced both front pads and rotors, bedded them in on the way home."
      />

      <TextAreaField
        label="Follow-up"
        name="followUp"
        value={form.followUp}
        onChange={onChange}
        placeholder="Re-check the pad wear at the next oil change."
      />

      {completionState.error ? <ErrorBanner>{completionState.error}</ErrorBanner> : null}

      <div className="flex flex-wrap gap-3">
        <button
          type="submit"
          disabled={completionState.saving}
          className="rounded-xl bg-emerald-700 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-600 disabled:cursor-not-allowed disabled:bg-slate-600"
        >
          {completionState.saving ? "Recording..." : "Record repair"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-100"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

function ChecklistDetails({
  checklist,
  isEditing,
  editForm,
  saveState,
  deleteState,
  itemsProps,
  completionProps,
  onStartEdit,
  onCancelEdit,
  onEditChange,
  onSaveEdit,
  onDelete,
}) {
  if (!checklist) {
    return (
      <section className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-600 shadow-sm">
        Select a checklist to view its items.
      </section>
    );
  }

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-slate-900">{checklist.title}</h2>
          <div className="mt-2 flex items-center gap-3">
            <StatusBadge status={checklist.status} />
            <span className="text-xs text-slate-500">
              {checklist.doneItemCount}/{checklist.itemCount} done
            </span>
          </div>
          <p className="mt-2 text-sm text-slate-500">Updated {formatDate(checklist.updatedAt)}</p>
        </div>

        <div className="flex flex-wrap gap-2">
          {/* "Record completed repair", never a bare "Complete": on a page full
              of tick boxes, "Complete" would read as "tick every item". This
              button writes a permanent repair record, and its label has to say
              so. It disappears once the repair exists -- one checklist records
              one repair -- so the form cannot invite a re-entry the server
              would only answer with the record already there. */}
          {!checklist.repairHistoryId && !completionProps.isOpen ? (
            <button
              type="button"
              ref={completionProps.openButtonRef}
              onClick={() => completionProps.onStart(checklist)}
              className="rounded-lg bg-emerald-700 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-600"
            >
              Record completed repair
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => onStartEdit(checklist)}
            className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-700"
          >
            Edit checklist
          </button>
          <button
            type="button"
            onClick={() => onDelete(checklist)}
            disabled={deleteState.deletingId === checklist.id}
            className="rounded-lg border border-red-300 px-3 py-2 text-sm font-semibold text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {deleteState.deletingId === checklist.id ? "Deleting..." : "Delete"}
          </button>
        </div>
      </div>

      {isEditing ? (
        <ChecklistEditForm
          form={editForm}
          saveState={saveState}
          onChange={onEditChange}
          onSubmit={onSaveEdit}
          onCancel={onCancelEdit}
        />
      ) : (
        <>
          <dl className="mt-5 grid gap-3 text-sm md:grid-cols-2">
            <div>
              <dt className="font-semibold text-slate-900">Status</dt>
              <dd className="text-slate-700">{statusLabel(checklist.status)}</dd>
            </div>
            <div>
              <dt className="font-semibold text-slate-900">Created</dt>
              <dd className="text-slate-700">{formatDate(checklist.createdAt)}</dd>
            </div>
          </dl>

          {checklist.description ? (
            <div className="mt-4 text-sm">
              <h3 className="font-semibold text-slate-900">Description</h3>
              <p className="mt-2 whitespace-pre-wrap text-slate-700">{checklist.description}</p>
            </div>
          ) : null}

          {checklist.notes ? (
            <div className="mt-4 text-sm">
              <h3 className="font-semibold text-slate-900">Notes</h3>
              <p className="mt-2 whitespace-pre-wrap text-slate-700">{checklist.notes}</p>
            </div>
          ) : null}
        </>
      )}

      {checklist.repairHistoryId ? (
        <RecordedRepairPanel
          repairHistoryId={checklist.repairHistoryId}
          linkRef={completionProps.recordedRepairLinkRef}
        />
      ) : null}

      {completionProps.isOpen && !checklist.repairHistoryId ? (
        <ChecklistCompletionForm
          form={completionProps.form}
          symptomOptions={completionProps.symptomOptions}
          symptomsError={completionProps.symptomsError}
          completionState={completionProps.state}
          onChange={completionProps.onChange}
          onSubmit={completionProps.onSubmit}
          onCancel={completionProps.onCancel}
        />
      ) : null}

      {completionProps.state.message ? (
        <SuccessBanner className="mt-4">{completionProps.state.message}</SuccessBanner>
      ) : null}

      {/* The completion error also renders inside the form; this is the copy
          that survives a successful-but-already-recorded response, where the
          form has closed. */}
      {completionProps.state.error && !completionProps.isOpen ? (
        <ErrorBanner className="mt-4">{completionProps.state.error}</ErrorBanner>
      ) : null}

      <ChecklistItems {...itemsProps} />

      {saveState.message ? (
        <SuccessBanner className="mt-4">{saveState.message}</SuccessBanner>
      ) : null}

      {deleteState.error ? <ErrorBanner className="mt-4">{deleteState.error}</ErrorBanner> : null}
    </section>
  );
}

function toChecklistPayload(form) {
  return {
    title: form.title,
    status: form.status,
    description: form.description,
    notes: form.notes,
  };
}

export function RepairChecklistsPage() {
  useScrollToHash();

  // `?checklistId=` is where the open checklist lives, so Back returns to the
  // checklist that was open rather than to the newest one. The Repair Planner's
  // "Open saved checklist" link writes the same parameter. It only names a row;
  // the checklist itself is still loaded from the server, so a bogus id falls
  // back to the newest checklist and then drops out of the URL.
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedChecklistId = readIdParam(searchParams, "checklistId");

  const [checklists, setChecklists] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const [createForm, setCreateForm] = useState(emptyChecklistForm);
  const [creating, setCreating] = useState(false);
  const [createMessage, setCreateMessage] = useState("");
  const [createError, setCreateError] = useState("");

  const [editingChecklistId, setEditingChecklistId] = useState(null);
  const [editForm, setEditForm] = useState(emptyChecklistForm);
  const [saveState, setSaveState] = useState({ saving: false, message: "", error: "" });
  const [deleteState, setDeleteState] = useState({ deletingId: null, error: "" });

  const [newItemText, setNewItemText] = useState("");
  const [addingItem, setAddingItem] = useState(false);
  const [itemError, setItemError] = useState("");
  const [editingItemId, setEditingItemId] = useState(null);
  const [editingItemText, setEditingItemText] = useState("");
  // Synchronous re-entrancy guard for item mutations (see runItemAction). A ref,
  // not state, so a rapid second event in the same render sees the flag.
  // itemActionPending mirrors it as state purely to disable item controls
  // while a mutation is in flight, so a second click is visibly impossible
  // rather than silently dropped.
  const itemActionInFlight = useRef(false);
  const [itemActionPending, setItemActionPending] = useState(false);
  const creatingInFlight = useRef(false);

  // --- Completing a checklist into repair history (roadmap N3.3) ------------
  const [completingChecklistId, setCompletingChecklistId] = useState(null);
  const [completionForm, setCompletionForm] = useState(emptyCompletionForm);
  const [completionState, setCompletionState] = useState(emptyCompletionState);
  const [symptomOptions, setSymptomOptions] = useState([]);
  const [symptomsError, setSymptomsError] = useState("");
  // Symptoms are fetched once, and only when a completion form is first opened.
  // The link is optional, so making every visit to this page pay for a second
  // request would be a cost for a field most owners will leave blank.
  const symptomsRequested = useRef(false);
  // The checklist whose completion request is in flight, or null. It doubles as
  // the re-entrancy guard -- one completion at a time -- but it is an id rather
  // than a boolean because every answer this request gives has to be checked
  // against WHOSE completion it was.
  const completionRequestChecklistId = useRef(null);
  // Mirrors `completingChecklistId` for those async checks. State read inside a
  // resolved promise is the value captured when the request went out, which is
  // precisely the wrong answer once the owner has opened another checklist's
  // form in the meantime.
  const openCompletionChecklistId = useRef(null);
  // Focus goes back to the button that opened the form when it closes, so a
  // keyboard user is not returned to the top of the document.
  const recordButtonRef = useRef(null);
  // ...and to the recorded-repair link when the form closes because the repair
  // now exists, since that link is what replaced the form.
  const recordedRepairLinkRef = useRef(null);

  // Derived from the URL and the loaded list: no `checklistId` means the newest
  // checklist, the fallback this page always had, now spelled as an absent
  // parameter so an untouched page keeps a clean `/repair-checklists` URL.
  const selectedChecklist = useMemo(() => {
    const requestedChecklist = requestedChecklistId
      ? checklists.find((checklist) => checklist.id === requestedChecklistId)
      : null;

    return requestedChecklist || checklists[0] || null;
  }, [checklists, requestedChecklistId]);
  const selectedChecklistId = selectedChecklist?.id ?? null;

  const updateViewParams = useCallback(
    (updates, { replace = false } = {}) => {
      setSearchParams((currentParams) => applyParamUpdates(currentParams, updates), {
        replace,
      });
    },
    [setSearchParams]
  );

  async function loadData() {
    try {
      setLoadError("");
      setLoading(true);

      const response = await fetch("/api/repair-checklists");
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || "Could not load repair checklists.");
      }

      const nextChecklists = Array.isArray(payload.checklists) ? payload.checklists : [];

      setChecklists(nextChecklists);
    } catch (error) {
      setLoadError(error.message || "Could not load repair checklists.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadData();
  }, []);

  // A `checklistId` naming a checklist that is not there -- deleted, or a stale
  // link from the Repair Planner -- drops out of the URL after the newest
  // checklist has been shown in its place, so the address stops describing a
  // view that does not exist.
  useEffect(() => {
    if (loading || loadError || !searchParams.has("checklistId")) {
      return;
    }

    const namesALoadedChecklist =
      requestedChecklistId &&
      checklists.some((checklist) => checklist.id === requestedChecklistId);

    if (!namesALoadedChecklist) {
      updateViewParams({ checklistId: null }, { replace: true });
    }
  }, [loading, loadError, requestedChecklistId, checklists, searchParams, updateViewParams]);

  // Replace one checklist in state with a server-returned copy (item mutations
  // and edits both return the full, refreshed checklist), then re-sort so the
  // just-touched checklist moves to the top — matching the server's
  // newest-activity-first order (updated_at DESC, id DESC) without a reload.
  function applyChecklistUpdate(updatedChecklist) {
    setChecklists((currentChecklists) => {
      const next = currentChecklists.map((checklist) =>
        checklist.id === updatedChecklist.id ? updatedChecklist : checklist
      );

      return next.sort((left, right) => {
        const activityDelta = getSortTimestamp(right) - getSortTimestamp(left);
        return activityDelta !== 0 ? activityDelta : right.id - left.id;
      });
    });
  }

  function handleCreateFormChange(event) {
    const { name, value } = event.target;
    setCreateForm((currentForm) => ({ ...currentForm, [name]: value }));
  }

  async function handleCreateChecklist(event) {
    event.preventDefault();

    if (creatingInFlight.current) {
      return;
    }

    if (!createForm.title.trim()) {
      setCreateError("Title is required.");
      return;
    }

    try {
      creatingInFlight.current = true;
      setCreating(true);
      setCreateError("");
      setCreateMessage("");

      const response = await fetch("/api/repair-checklists", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(toChecklistPayload(createForm)),
      });

      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || "Could not create checklist.");
      }

      const newChecklist = payload.checklist;

      setChecklists((currentChecklists) => [newChecklist, ...currentChecklists]);
      // Replace, not push: opening the checklist just created is part of
      // creating it, not a step to press Back through.
      updateViewParams({ checklistId: newChecklist.id }, { replace: true });
      setCreateForm(emptyChecklistForm);
      setCreateMessage("Checklist saved.");
      setEditingChecklistId(null);
    } catch (error) {
      setCreateError(error.message || "Could not create checklist.");
    } finally {
      creatingInFlight.current = false;
      setCreating(false);
    }
  }

  function startEditingChecklist(checklist) {
    // Pin the checklist being edited into the URL. Saving re-sorts the list by
    // newest activity, so without a named selection the implicit "first row"
    // default could slide to a different checklist mid-edit. Replace, not push:
    // opening an edit form is not a navigation step of its own.
    updateViewParams({ checklistId: checklist.id }, { replace: true });
    setEditingChecklistId(checklist.id);
    setEditForm({
      title: checklist.title || "",
      status: checklist.status || "planned",
      description: checklist.description || "",
      notes: checklist.notes || "",
    });
    setSaveState({ saving: false, message: "", error: "" });
    setDeleteState({ deletingId: null, error: "" });
    // One form at a time: editing the checklist's own fields and recording the
    // repair it became are different jobs, and two open forms in one panel is
    // how a keyboard user loses track of which one Enter submits.
    closeCompletionForm();
  }

  function cancelEditingChecklist() {
    setEditingChecklistId(null);
    setEditForm(emptyChecklistForm);
    setSaveState({ saving: false, message: "", error: "" });
  }

  function handleEditFormChange(event) {
    const { name, value } = event.target;
    setEditForm((currentForm) => ({ ...currentForm, [name]: value }));
  }

  async function handleSaveChecklist(event) {
    event.preventDefault();

    if (!editingChecklistId) {
      return;
    }

    if (!editForm.title.trim()) {
      setSaveState({ saving: false, message: "", error: "Title is required." });
      return;
    }

    try {
      setSaveState({ saving: true, message: "", error: "" });

      const response = await fetch(`/api/repair-checklists/${editingChecklistId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(toChecklistPayload(editForm)),
      });

      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || "Could not update checklist.");
      }

      applyChecklistUpdate(payload.checklist);
      setSaveState({ saving: false, message: "Changes saved.", error: "" });
      setEditingChecklistId(null);
    } catch (error) {
      setSaveState({ saving: false, message: "", error: error.message || "Could not update checklist." });
    }
  }

  async function handleDeleteChecklist(checklist) {
    const confirmed = window.confirm(`Delete "${checklist.title}"? This cannot be undone.`);

    if (!confirmed) {
      return;
    }

    try {
      setDeleteState({ deletingId: checklist.id, error: "" });

      const response = await fetch(`/api/repair-checklists/${checklist.id}`, {
        method: "DELETE",
      });

      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || "Could not delete checklist.");
      }

      // Dropping the row is enough: the deleted id no longer matches anything,
      // so the detail panel falls back to the newest remaining checklist and
      // the normalization effect clears the stale `checklistId` from the URL.
      setChecklists((currentChecklists) =>
        currentChecklists.filter((current) => current.id !== checklist.id)
      );

      if (editingChecklistId === checklist.id) {
        cancelEditingChecklist();
      }

      if (completingChecklistId === checklist.id) {
        setCompletionState(emptyCompletionState);
        closeCompletionForm();
      }

      setDeleteState({ deletingId: null, error: "" });
    } catch (error) {
      setDeleteState({ deletingId: null, error: error.message || "Could not delete checklist." });
    }
  }

  // --- Item actions (all return the full, refreshed checklist) -------------

  async function runItemAction(url, options) {
    // Ignore overlapping item mutations (e.g. a double-click on a checkbox or a
    // double-Enter on the add-item form) so a second request cannot fire before
    // the first response updates state — which would send a duplicate write or a
    // toggle computed from a stale value. Returns whether the request actually ran
    // so callers do not clear inputs / close edit forms for an ignored one.
    if (itemActionInFlight.current) {
      return false;
    }

    itemActionInFlight.current = true;
    setItemActionPending(true);
    setItemError("");

    try {
      const response = await fetch(url, options);
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || "Could not update checklist item.");
      }

      applyChecklistUpdate(payload.checklist);
      return true;
    } finally {
      itemActionInFlight.current = false;
      setItemActionPending(false);
    }
  }

  async function handleAddItem(event) {
    event.preventDefault();

    if (!selectedChecklist) {
      return;
    }

    if (!newItemText.trim()) {
      setItemError("Item text is required.");
      return;
    }

    try {
      setAddingItem(true);
      const added = await runItemAction(`/api/repair-checklists/${selectedChecklist.id}/items`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: newItemText }),
      });
      if (added) {
        setNewItemText("");
      }
    } catch (error) {
      setItemError(error.message || "Could not add checklist item.");
    } finally {
      setAddingItem(false);
    }
  }

  async function handleToggleItem(item) {
    if (!selectedChecklist) {
      return;
    }

    try {
      await runItemAction(`/api/repair-checklists/${selectedChecklist.id}/items/${item.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isDone: !item.isDone }),
      });
    } catch (error) {
      setItemError(error.message || "Could not update checklist item.");
    }
  }

  function startEditingItem(item) {
    setEditingItemId(item.id);
    setEditingItemText(item.text);
    setItemError("");
  }

  function cancelEditingItem() {
    setEditingItemId(null);
    setEditingItemText("");
  }

  async function handleSaveItemEdit(item) {
    if (!selectedChecklist) {
      return;
    }

    if (!editingItemText.trim()) {
      setItemError("Item text is required.");
      return;
    }

    try {
      const saved = await runItemAction(`/api/repair-checklists/${selectedChecklist.id}/items/${item.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: editingItemText }),
      });
      if (saved) {
        cancelEditingItem();
      }
    } catch (error) {
      setItemError(error.message || "Could not update checklist item.");
    }
  }

  async function handleMoveItem(item, direction) {
    if (!selectedChecklist) {
      return;
    }

    try {
      await runItemAction(`/api/repair-checklists/${selectedChecklist.id}/items/${item.id}/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ direction }),
      });
    } catch (error) {
      setItemError(error.message || "Could not move checklist item.");
    }
  }

  async function handleDeleteItem(item) {
    if (!selectedChecklist) {
      return;
    }

    try {
      const deleted = await runItemAction(`/api/repair-checklists/${selectedChecklist.id}/items/${item.id}`, {
        method: "DELETE",
      });

      if (deleted && editingItemId === item.id) {
        cancelEditingItem();
      }
    } catch (error) {
      setItemError(error.message || "Could not delete checklist item.");
    }
  }

  // --- Completion actions ---------------------------------------------------

  async function loadSymptomOptions() {
    if (symptomsRequested.current) {
      return;
    }

    symptomsRequested.current = true;

    try {
      setSymptomsError("");

      const response = await fetch("/api/symptoms");
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || "Could not load symptoms.");
      }

      const symptoms = Array.isArray(payload.symptoms) ? payload.symptoms : [];

      setSymptomOptions(
        symptoms.map((symptom) => ({ value: String(symptom.id), label: symptom.title }))
      );
    } catch (error) {
      // A failed symptom list is not a failed completion: the link is optional,
      // so the form stays usable and says so rather than blocking the record.
      symptomsRequested.current = false;
      setSymptomOptions([]);
      setSymptomsError(error.message || "Could not load symptoms.");
    }
  }

  function startCompletingChecklist(checklist) {
    // Pin the checklist being completed into the URL, for the same reason
    // editing does: a successful completion re-sorts the list by newest
    // activity, and an unnamed "first row" selection could slide to a different
    // checklist underneath the form. Replace, not push -- opening a form is not
    // a navigation step of its own.
    updateViewParams({ checklistId: checklist.id }, { replace: true });
    openCompletionChecklistId.current = checklist.id;
    setCompletingChecklistId(checklist.id);
    setCompletionForm(emptyCompletionForm);
    setCompletionState(emptyCompletionState);
    loadSymptomOptions();
  }

  function closeCompletionForm({ returnFocus = false } = {}) {
    openCompletionChecklistId.current = null;
    setCompletingChecklistId(null);
    setCompletionForm(emptyCompletionForm);

    if (returnFocus) {
      // After the state update has re-rendered the opening button.
      window.requestAnimationFrame(() => recordButtonRef.current?.focus());
    }
  }

  function cancelCompletingChecklist() {
    setCompletionState(emptyCompletionState);
    closeCompletionForm({ returnFocus: true });
  }

  function handleCompletionFormChange(event) {
    const { name, value } = event.target;
    setCompletionForm((currentForm) => ({ ...currentForm, [name]: value }));
  }

  async function handleCompleteChecklist(event) {
    event.preventDefault();

    if (!completingChecklistId) {
      return;
    }

    // The checklist this submission belongs to, captured before anything can be
    // awaited. Every answer below is tagged with it and checked against it.
    const checklistId = completingChecklistId;
    const pendingChecklistId = completionRequestChecklistId.current;

    // One completion at a time, and never silently: a press that does nothing at
    // all reads as a broken button, and the owner would try again.
    if (pendingChecklistId !== null) {
      setCompletionState({
        checklistId,
        // Keep the in-flight indicator honest: it belongs to the request that is
        // really running, which is this form's only when the ids match.
        saving: pendingChecklistId === checklistId,
        message: "",
        error:
          pendingChecklistId === checklistId
            ? "This repair is already being recorded. Wait for it to finish."
            : "Another repair is still being recorded. Wait for it to finish, then record this one.",
      });
      return;
    }

    if (!completionForm.performedOn.trim()) {
      setCompletionState({ checklistId, saving: false, message: "", error: "Repair date is required." });
      return;
    }

    // A blank box means "I did not write it down" and must stay `null`; a real
    // reading has to leave here as a JSON number, because the API rejects a
    // numeric string outright rather than coercing it (a coerced "" would be a
    // legitimate-looking reading of zero miles).
    const odometer = parseOdometerInput(completionForm.odometerMiles);

    if (!odometer.ok) {
      setCompletionState({ checklistId, saving: false, message: "", error: odometer.error });
      return;
    }

    const symptomId = completionForm.symptomId ? Number(completionForm.symptomId) : null;

    try {
      completionRequestChecklistId.current = checklistId;
      setCompletionState({ checklistId, saving: true, message: "", error: "" });

      const response = await fetch(`/api/repair-checklists/${checklistId}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Historical facts ONLY. No title, no sources, no document ids: the
        // server owns those and reads them from the checklist itself.
        body: JSON.stringify({
          performedOn: completionForm.performedOn,
          odometerMiles: odometer.odometerMiles,
          outcome: completionForm.outcome,
          summary: completionForm.summary,
          followUp: completionForm.followUp,
          symptomId,
        }),
      });

      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || "Could not record the repair.");
      }

      // The server-returned checklist is applied wherever the owner happens to
      // be looking. It is a fact about that checklist rather than a message
      // about this screen, and a checklist that has been recorded has to stop
      // offering to be recorded again in every list and panel that shows it.
      //
      // `created: false` is a 200 saying this checklist was already recorded.
      // That is an answer, not an error -- one checklist records one repair, so
      // the honest response to a retry is the record it already became.
      if (payload.checklist) {
        applyChecklistUpdate(payload.checklist);
      }

      setCompletionState({
        checklistId,
        saving: false,
        message: payload.created
          ? "Repair recorded. It is now in your Repair History."
          : "This checklist was already recorded as a repair.",
        error: "",
      });

      // Everything from here is about the form on screen, so it happens only
      // while the form on screen is still this request's own. If the owner
      // opened another checklist's completion form while this was in flight,
      // closing it would throw away what they had typed into a repair this
      // response knows nothing about.
      if (openCompletionChecklistId.current === checklistId) {
        closeCompletionForm();
        // The form the keyboard user was in has just been removed; the recorded
        // repair's link is what took its place, so focus follows it there
        // instead of falling back to the top of the document. One frame, so the
        // panel this focuses has actually rendered.
        window.requestAnimationFrame(() => recordedRepairLinkRef.current?.focus());
      }
    } catch (error) {
      setCompletionState({
        checklistId,
        saving: false,
        message: "",
        error: error.message || "Could not record the repair.",
      });
    } finally {
      completionRequestChecklistId.current = null;
    }
  }

  // A completion banner is about one checklist, so it is only ever shown under
  // that checklist. Scoping it here rather than trusting the request handler
  // means even a response that lands long after the owner has moved on cannot
  // announce itself under whatever is open now.
  const completionStateForSelection =
    completionState.checklistId !== null && completionState.checklistId === selectedChecklistId
      ? completionState
      : emptyCompletionState;

  const completionProps = {
    isOpen: completingChecklistId !== null && completingChecklistId === selectedChecklistId,
    form: completionForm,
    state: completionStateForSelection,
    symptomOptions,
    symptomsError,
    openButtonRef: recordButtonRef,
    recordedRepairLinkRef,
    onStart: startCompletingChecklist,
    onChange: handleCompletionFormChange,
    onSubmit: handleCompleteChecklist,
    onCancel: cancelCompletingChecklist,
  };

  const itemsProps = {
    items: selectedChecklist?.items || [],
    itemError,
    newItemText,
    addingItem,
    itemActionPending,
    editingItemId,
    editingItemText,
    onNewItemTextChange: setNewItemText,
    onAddItem: handleAddItem,
    onToggleItem: handleToggleItem,
    onStartEditItem: startEditingItem,
    onEditItemTextChange: setEditingItemText,
    onSaveItemEdit: handleSaveItemEdit,
    onCancelItemEdit: cancelEditingItem,
    onMoveItem: handleMoveItem,
    onDeleteItem: handleDeleteItem,
  };

  function handleSelectChecklist(checklistId) {
    // Picking a checklist is a real navigation step, so it pushes: Back returns
    // to the checklist that was open before.
    updateViewParams({ checklistId });
    cancelEditingItem();
    // Cancel any in-progress checklist edit so its form/state does not leak across
    // checklists; cancelEditingChecklist also clears the saveState banner.
    cancelEditingChecklist();
    setItemError("");
    setNewItemText("");
    // Clear the delete error too, so a status banner from the previously selected
    // checklist is not shown under this one.
    setDeleteState({ deletingId: null, error: "" });
    // Same for the completion form and its banner: a "Repair recorded" message
    // belongs to the checklist it was recorded for, not to whichever one is
    // opened next.
    setCompletionState(emptyCompletionState);
    closeCompletionForm();
  }

  return (
    <>
      <PageHeader
        title="Repair Checklists"
        description="Plan a repair job as a list of steps, check them off as you go, and reorder them with Up/Down."
      />

      <div className="space-y-6">
        <ChecklistCreateForm
          form={createForm}
          creating={creating}
          createMessage={createMessage}
          createError={createError}
          onChange={handleCreateFormChange}
          onSubmit={handleCreateChecklist}
        />

        <div className="space-y-6">
          {loading ? (
            <section className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-600 shadow-sm">
              Loading checklists...
            </section>
          ) : null}

          {loadError ? (
            <ErrorBanner title="Could not load checklists." className="shadow-sm">
              {loadError}
            </ErrorBanner>
          ) : null}

          {!loading && !loadError ? (
            <>
              {/* Every checklist is always on screen -- there is no filter and
                  no paging here -- so this is the library-total form, not a
                  range that would only restate its own total. */}
              <section className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600 shadow-sm">
                {formatLibraryTotal({
                  total: checklists.length,
                  noun: "checklist",
                  nounPlural: "checklists",
                })}
              </section>

              <ListDetailLayout
                selectedId={selectedChecklistId}
                list={
                  <ChecklistList
                    checklists={checklists}
                    selectedChecklistId={selectedChecklistId}
                    onSelectChecklist={handleSelectChecklist}
                  />
                }
                detail={
                  <ChecklistDetails
                    checklist={selectedChecklist}
                    isEditing={editingChecklistId === selectedChecklistId}
                    editForm={editForm}
                    saveState={saveState}
                    deleteState={deleteState}
                    itemsProps={itemsProps}
                    completionProps={completionProps}
                    onStartEdit={startEditingChecklist}
                    onCancelEdit={cancelEditingChecklist}
                    onEditChange={handleEditFormChange}
                    onSaveEdit={handleSaveChecklist}
                    onDelete={handleDeleteChecklist}
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
