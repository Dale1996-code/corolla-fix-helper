export function mergeSuggestionValues(values) {
  const nextValues = [];
  const seenValues = new Set();

  for (const value of Array.isArray(values) ? values : []) {
    const trimmedValue = typeof value === "string" ? value.trim() : "";

    if (!trimmedValue) {
      continue;
    }

    const normalizedKey = trimmedValue.toLowerCase();

    if (seenValues.has(normalizedKey)) {
      continue;
    }

    seenValues.add(normalizedKey);
    nextValues.push(trimmedValue);
  }

  return nextValues;
}
