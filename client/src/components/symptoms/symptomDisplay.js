// Shared display helpers for the Symptoms feature, used by both SymptomsPage and
// its presentational components.

export function labelize(value) {
  if (!value) {
    return "Not set";
  }

  return value
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function getStatusBadgeClass(status) {
  if (status === "resolved") {
    return "bg-emerald-100 text-emerald-800";
  }

  if (status === "monitoring") {
    return "bg-amber-100 text-amber-800";
  }

  return "bg-slate-100 text-slate-700";
}

export function formatVisibleSymptomsText(totalCount, visibleCount) {
  const symptomLabel = totalCount === 1 ? "symptom" : "symptoms";

  if (visibleCount === totalCount) {
    return `Showing all ${totalCount} ${symptomLabel}`;
  }

  return `Showing ${visibleCount} of ${totalCount} ${symptomLabel}`;
}
