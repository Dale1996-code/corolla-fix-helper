// Shared display helpers for the Documents feature, used by both DocumentsPage
// and its presentational components.

export function normalizeExtractionStatus(status) {
  const value = typeof status === "string" ? status : "";

  if (!value || value === "not_attempted") {
    return {
      key: "not_attempted",
      label: "Not attempted",
      className: "bg-slate-100 text-slate-700",
    };
  }

  if (value === "completed") {
    return {
      key: "completed",
      label: "Completed",
      className: "bg-emerald-100 text-emerald-800",
    };
  }

  if (value === "no_text_found") {
    return {
      key: "no_text_found",
      label: "No text found",
      className: "bg-amber-100 text-amber-800",
    };
  }

  if (value.startsWith("failed")) {
    return {
      key: "failed",
      label: "Failed",
      className: "bg-red-100 text-red-800",
    };
  }

  return {
    key: "other",
    label: value,
    className: "bg-slate-100 text-slate-700",
  };
}

export function getDocumentTags(document) {
  return Array.isArray(document?.tags) ? document.tags : [];
}
