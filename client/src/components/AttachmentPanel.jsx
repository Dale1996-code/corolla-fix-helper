import { useEffect, useRef, useState } from "react";
import { ErrorBanner } from "./feedback/Banner";
import {
  attachmentFileUrl,
  deleteAttachment,
  fetchAttachments,
  uploadAttachment,
} from "../lib/apiClient";

// Reusable image-attachment panel for a symptom, procedure, or note detail
// view. It owns its own load/upload/delete state so a page only has to drop in
// <AttachmentPanel entityType="symptom" entityId={symptom.id} />.

export function AttachmentPanel({ entityType, entityId }) {
  const [attachments, setAttachments] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [caption, setCaption] = useState("");
  const [selectedFile, setSelectedFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [actionError, setActionError] = useState("");
  const [deletingId, setDeletingId] = useState(null);
  const fileInputRef = useRef(null);

  const fileInputId = `attachment-file-${entityType}-${entityId}`;
  const captionInputId = `attachment-caption-${entityType}-${entityId}`;

  useEffect(() => {
    let active = true;

    async function load() {
      if (!entityId) {
        setAttachments([]);
        return;
      }

      try {
        setLoading(true);
        setLoadError("");
        const next = await fetchAttachments(entityType, entityId);

        if (active) {
          setAttachments(next);
        }
      } catch (error) {
        if (active) {
          setLoadError(error.message || "Could not load photos.");
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    }

    load();

    return () => {
      active = false;
    };
  }, [entityType, entityId]);

  function handleFileChange(event) {
    setActionError("");
    setSelectedFile(event.target.files?.[0] || null);
  }

  async function handleUpload(event) {
    event.preventDefault();

    if (!selectedFile) {
      setActionError("Choose a photo to upload.");
      return;
    }

    try {
      setUploading(true);
      setActionError("");

      const created = await uploadAttachment({
        entityType,
        entityId,
        file: selectedFile,
        caption,
      });

      setAttachments((current) => [...current, created]);
      setCaption("");
      setSelectedFile(null);

      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    } catch (error) {
      setActionError(error.message || "Could not upload the photo.");
    } finally {
      setUploading(false);
    }
  }

  async function handleDelete(attachment) {
    const confirmed = window.confirm(
      `Delete this photo${attachment.caption ? ` ("${attachment.caption}")` : ""}? This cannot be undone.`
    );

    if (!confirmed) {
      return;
    }

    try {
      setDeletingId(attachment.id);
      setActionError("");
      await deleteAttachment(attachment.id);
      setAttachments((current) =>
        current.filter((item) => item.id !== attachment.id)
      );
    } catch (error) {
      setActionError(error.message || "Could not delete the photo.");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div data-testid="attachment-panel">
      <h3 className="font-semibold text-slate-900">Photos</h3>

      {loading ? (
        <p className="mt-2 text-sm text-slate-600">Loading photos...</p>
      ) : null}

      {loadError ? <ErrorBanner className="mt-2">{loadError}</ErrorBanner> : null}

      {!loading && !loadError && attachments.length === 0 ? (
        <p className="mt-2 text-sm text-slate-700">
          No photos yet. Add one below.
        </p>
      ) : null}

      {attachments.length ? (
        <ul className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
          {attachments.map((attachment) => (
            <li
              key={attachment.id}
              className="overflow-hidden rounded-lg border border-slate-200 bg-slate-50"
            >
              <a
                href={attachmentFileUrl(attachment.id)}
                target="_blank"
                rel="noreferrer"
              >
                <img
                  className="h-28 w-full object-cover"
                  src={attachmentFileUrl(attachment.id)}
                  alt={attachment.caption || attachment.originalFilename || "Attached photo"}
                />
              </a>
              <div className="space-y-1 px-2 py-2">
                <p className="truncate text-xs text-slate-700">
                  {attachment.caption || attachment.originalFilename}
                </p>
                <button
                  type="button"
                  onClick={() => handleDelete(attachment)}
                  disabled={deletingId === attachment.id}
                  className="text-xs font-medium text-red-700 hover:text-red-900 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {deletingId === attachment.id ? "Deleting..." : "Delete"}
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      <form className="mt-3 grid gap-2" onSubmit={handleUpload}>
        <label
          className="grid gap-1 text-xs font-medium text-slate-700"
          htmlFor={fileInputId}
        >
          <span>Add a photo (JPEG, PNG, or WebP)</span>
          <input
            id={fileInputId}
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            onChange={handleFileChange}
            className="text-sm text-slate-700"
          />
        </label>

        <label
          className="grid gap-1 text-xs font-medium text-slate-700"
          htmlFor={captionInputId}
        >
          <span>Caption (optional)</span>
          <input
            id={captionInputId}
            type="text"
            value={caption}
            onChange={(event) => setCaption(event.target.value)}
            placeholder="What does this photo show?"
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none transition focus:border-sky-500"
          />
        </label>

        <div>
          <button
            type="submit"
            disabled={uploading}
            className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-semibold text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-400"
          >
            {uploading ? "Uploading..." : "Upload photo"}
          </button>
        </div>

        {actionError ? <ErrorBanner>{actionError}</ErrorBanner> : null}
      </form>
    </div>
  );
}
