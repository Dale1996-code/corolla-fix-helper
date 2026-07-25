// Turns a snake_case enum value into a display label, e.g. "in_progress" ->
// "In Progress". Shared across Dashboard, Notes, Procedures, Search, and
// Symptoms, which each carried their own copy of this function.
export function labelize(value) {
  if (!value) {
    return "Not set";
  }

  return String(value)
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
