// Small text helpers shared by routes and services. Keeping a single copy
// avoids the previous drift where every route redefined these inline.

/**
 * Trim a value if it is a string, otherwise fall back.
 *
 * With the default empty fallback this behaves exactly like the per-route
 * `value.trim()`-or-`""` helpers it replaces; the optional `fallback` keeps the
 * bulk import script's "use a default when blank" behavior.
 */
export function normalizeText(value, fallback = "") {
  const text = typeof value === "string" ? value.trim() : "";
  return text || fallback;
}

/**
 * Safe own-property check that ignores the prototype chain. Used to tell
 * "field omitted" apart from "field explicitly set to empty" in request bodies.
 */
export function hasOwnField(object, fieldName) {
  return Object.prototype.hasOwnProperty.call(object, fieldName);
}
