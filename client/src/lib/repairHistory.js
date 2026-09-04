import { formatCount } from "./resultRange";

// The owner-facing vocabulary for a recorded repair.
//
// One list, shared by the Repair History page (which reads outcomes back) and
// the Repair Checklists completion form (which writes them). Two copies would
// be two chances for the labels to disagree about what `not_fixed` is called,
// and the write side is exactly where a stray label becomes a permanent record.
//
// The `value`s are the server's vocabulary from `REPAIR_OUTCOMES` in
// repairHistoryService.js and are never shown: a raw `not_fixed` on screen is
// the "never render a stored value where a human label exists" rule broken.

export const REPAIR_OUTCOME_OPTIONS = [
  { value: "fixed", label: "Fixed" },
  { value: "partial", label: "Partially fixed" },
  { value: "not_fixed", label: "Not fixed" },
  { value: "unknown", label: "Unknown" },
];

const OUTCOME_LABELS = REPAIR_OUTCOME_OPTIONS.reduce((labels, option) => {
  labels[option.value] = option.label;
  return labels;
}, {});

export const DEFAULT_REPAIR_OUTCOME = "unknown";

/**
 * The label for a stored outcome.
 *
 * An unrecognised value reads as "Unknown" rather than being echoed: the column
 * has a CHECK constraint, so anything else is a record this build does not
 * understand, and showing its raw token would tell the owner nothing.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function repairOutcomeLabel(value) {
  return OUTCOME_LABELS[value] || OUTCOME_LABELS[DEFAULT_REPAIR_OUTCOME];
}

/**
 * An odometer reading as the owner should read it: "183,456 mi".
 *
 * `null` means the reading was never written down, which is a different fact
 * from a reading of zero and must not be shown as one -- so it gets a sentence,
 * never a number. Thousands separators come from the same `formatCount` every
 * other visible number on the app uses.
 *
 * @param {unknown} value
 * @param {{ missingText?: string }} [options]
 * @returns {string}
 */
export function formatOdometerMiles(value, { missingText = "Not recorded" } = {}) {
  if (!Number.isInteger(value) || value < 0) {
    return missingText;
  }

  return `${formatCount(value)} mi`;
}

/**
 * Parse what the owner typed into the odometer box into what the API takes.
 *
 * Blank is `null` -- "I did not write it down" -- and never `0`, which is a
 * genuine reading of zero miles. Anything that is not a run of digits is
 * refused here rather than sent, so the owner gets the box they can fix instead
 * of a 400 from the server. The accepted value is returned as a JSON **number**:
 * `normalizeOdometerMiles` rejects a numeric string outright.
 *
 * @param {unknown} value
 * @returns {{ ok: true, odometerMiles: number|null } | { ok: false, error: string }}
 */
export function parseOdometerInput(value) {
  const text = typeof value === "string" ? value.trim() : value === null || value === undefined ? "" : String(value);

  if (!text) {
    return { ok: true, odometerMiles: null };
  }

  if (!/^[0-9]+$/.test(text)) {
    return {
      ok: false,
      error: "Odometer must be a whole number of miles, or left blank if you did not write it down.",
    };
  }

  const miles = Number(text);

  if (!Number.isSafeInteger(miles)) {
    return {
      ok: false,
      error: "Odometer must be a whole number of miles, or left blank if you did not write it down.",
    };
  }

  return { ok: true, odometerMiles: miles };
}
