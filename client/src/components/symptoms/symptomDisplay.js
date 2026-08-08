// Shared display helpers for the Symptoms feature, used by both SymptomsPage and
// its presentational components.

import { formatResultRange } from "../../lib/resultRange";

export function getStatusBadgeClass(status) {
  if (status === "resolved") {
    return "bg-emerald-100 text-emerald-800";
  }

  if (status === "monitoring") {
    return "bg-amber-100 text-amber-800";
  }

  return "bg-slate-100 text-slate-700";
}

// The visible-range counter for the symptom list. The whole filtered list is on
// screen (symptoms do not page), so the range runs from the first row to the
// last. It deliberately does NOT restate the library total: the summary cards
// directly above already show "Total symptoms" and "Visible now", and two
// counters for one list is what this sweep was cleaning up.
export function formatVisibleSymptomsText(totalCount, visibleCount) {
  return formatResultRange({
    from: 1,
    to: visibleCount,
    total: visibleCount,
    noun: "symptom",
    nounPlural: "symptoms",
    emptyText: totalCount ? "No symptoms match these filters." : "No symptoms yet.",
  });
}
