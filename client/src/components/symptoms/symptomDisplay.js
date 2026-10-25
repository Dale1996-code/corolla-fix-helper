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

// The range counter for the symptom page on screen: "Showing 26–50 of 60
// symptoms." The total in it is how many symptoms the filters leave (the
// server's `matched`). It deliberately does NOT restate the library total: the
// summary cards directly above already show "Total symptoms" and "Visible now",
// and two counters for one list is what the counter sweep was cleaning up.
export function formatSymptomRangeText({ libraryTotal, matched, from, count }) {
  return formatResultRange({
    from,
    to: from + count - 1,
    total: matched,
    noun: "symptom",
    nounPlural: "symptoms",
    emptyText: libraryTotal ? "No symptoms match these filters." : "No symptoms yet.",
  });
}
