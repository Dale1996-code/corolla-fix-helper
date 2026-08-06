import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { PageHeader } from "../components/PageHeader";
import { ErrorBanner, SuccessBanner } from "../components/feedback/Banner";
import { SelectField, TextAreaField, TextField } from "../components/forms/FormFields";
import { formatDate, getSortTimestamp } from "../lib/formatDate";
import { useScrollToHash } from "../lib/useScrollToHash";

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

function ChecklistList({ checklists, selectedChecklistId, onSelectChecklist }) {
  const listGridClass =
    "grid grid-cols-[minmax(11rem,2.4fr)_minmax(7rem,1fr)_minmax(6rem,0.9fr)_minmax(8rem,1fr)] gap-3";

  return (
    <section
      id="checklist-library"
      className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm"
    >
      <div className="overflow-x-auto">
        <div className="min-w-[620px]">
          <div
            className={`${listGridClass} border-b border-slate-200 bg-slate-50 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-600`}
          >
            <span>Title</span>
            <span>Status</span>
            <span>Progress</span>
            <span>Updated</span>
          </div>

          {checklists.length === 0 ? (
            <div className="px-4 py-6 text-sm text-slate-600">No checklists yet.</div>
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
          aria-label="New item text"
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

function ChecklistDetails({
  checklist,
  isEditing,
  editForm,
  saveState,
  deleteState,
  itemsProps,
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

  // `?checklistId=` lets another page link straight to one checklist -- the
  // Repair Planner's "Open saved checklist" link is the first caller. It only
  // preselects a row; the checklist itself is still loaded from the server, so
  // a bogus id simply falls back to the newest checklist.
  const [searchParams] = useSearchParams();
  const requestedChecklistIdValue = Number(searchParams.get("checklistId"));
  const requestedChecklistId =
    Number.isInteger(requestedChecklistIdValue) && requestedChecklistIdValue > 0
      ? requestedChecklistIdValue
      : null;

  const [checklists, setChecklists] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const [createForm, setCreateForm] = useState(emptyChecklistForm);
  const [creating, setCreating] = useState(false);
  const [createMessage, setCreateMessage] = useState("");
  const [createError, setCreateError] = useState("");

  const [selectedChecklistId, setSelectedChecklistId] = useState(null);
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

  const selectedChecklist = useMemo(() => {
    if (!selectedChecklistId) {
      return null;
    }

    return checklists.find((checklist) => checklist.id === selectedChecklistId) || null;
  }, [checklists, selectedChecklistId]);

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
      setSelectedChecklistId((currentId) => {
        if (currentId && nextChecklists.some((checklist) => checklist.id === currentId)) {
          return currentId;
        }

        // A deep link picks the checklist it names, but only if it is really
        // there -- a stale or hand-typed id falls back to the newest one rather
        // than showing an empty detail pane.
        if (
          requestedChecklistId &&
          nextChecklists.some((checklist) => checklist.id === requestedChecklistId)
        ) {
          return requestedChecklistId;
        }

        return nextChecklists[0]?.id || null;
      });
    } catch (error) {
      setLoadError(error.message || "Could not load repair checklists.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadData();
  }, []);

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
      setSelectedChecklistId(newChecklist.id);
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
    setEditingChecklistId(checklist.id);
    setEditForm({
      title: checklist.title || "",
      status: checklist.status || "planned",
      description: checklist.description || "",
      notes: checklist.notes || "",
    });
    setSaveState({ saving: false, message: "", error: "" });
    setDeleteState({ deletingId: null, error: "" });
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

      setChecklists((currentChecklists) => {
        const remaining = currentChecklists.filter((current) => current.id !== checklist.id);

        setSelectedChecklistId((currentId) =>
          currentId === checklist.id ? remaining[0]?.id || null : currentId
        );

        return remaining;
      });

      if (editingChecklistId === checklist.id) {
        cancelEditingChecklist();
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
    setSelectedChecklistId(checklistId);
    cancelEditingItem();
    // Cancel any in-progress checklist edit so its form/state does not leak across
    // checklists; cancelEditingChecklist also clears the saveState banner.
    cancelEditingChecklist();
    setItemError("");
    setNewItemText("");
    // Clear the delete error too, so a status banner from the previously selected
    // checklist is not shown under this one.
    setDeleteState({ deletingId: null, error: "" });
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
              <section className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600 shadow-sm">
                <span className="font-semibold text-slate-900">{checklists.length}</span>{" "}
                checklist{checklists.length === 1 ? "" : "s"}.
              </section>

              <div className="grid gap-6 xl:grid-cols-2">
                <ChecklistList
                  checklists={checklists}
                  selectedChecklistId={selectedChecklistId}
                  onSelectChecklist={handleSelectChecklist}
                />

                <ChecklistDetails
                  checklist={selectedChecklist}
                  isEditing={editingChecklistId === selectedChecklistId}
                  editForm={editForm}
                  saveState={saveState}
                  deleteState={deleteState}
                  itemsProps={itemsProps}
                  onStartEdit={startEditingChecklist}
                  onCancelEdit={cancelEditingChecklist}
                  onEditChange={handleEditFormChange}
                  onSaveEdit={handleSaveChecklist}
                  onDelete={handleDeleteChecklist}
                />
              </div>
            </>
          ) : null}
        </div>
      </div>
    </>
  );
}
