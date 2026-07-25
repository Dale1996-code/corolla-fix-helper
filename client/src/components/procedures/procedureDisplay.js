// Shared display helpers for the Procedures feature, used by ProceduresPage and
// its presentational components.

export function getDifficultyBadgeClass(difficulty) {
  if (difficulty === "advanced") {
    return "bg-red-100 text-red-800";
  }

  if (difficulty === "intermediate") {
    return "bg-amber-100 text-amber-800";
  }

  return "bg-emerald-100 text-emerald-800";
}
