// The owner's vehicle variant details (N5, docs/n5-applicability-design.md §6.1).
//
// The manuals print some specifications per engine, build plant, or option,
// often in one table. To say which row belongs to THIS car, the app needs the
// car's value on each axis. These live on the single `vehicles` row (migration
// 006) and every one of them may be unknown.
//
// Unknown is a real state, not a missing default: `null` here is read by the
// applicability check as "cannot be confirmed", never as "matches". That is why
// nothing is ever guessed or seeded -- a 1.8L Corolla is almost always a 2ZR-FE,
// but "almost always" is exactly the assumption N5 exists to stop making.
//
// Pure leaf: imports nothing, so routes, scripts, and the tagger can share it.

/**
 * @typedef {{
 *   engineCode: string | null,
 *   buildPlant: "TMC" | "NUMMI" | "TMMC" | null,
 *   transmissionCode: string | null,
 *   hasVsc: boolean | null,
 *   hasSmartKey: boolean | null,
 * }} ApplicabilityProfile
 */

/** Plants a 2009 Corolla can come from, as the manuals name them. */
export const BUILD_PLANTS = Object.freeze(["TMC", "NUMMI", "TMMC"]);

/** @type {Readonly<ApplicabilityProfile>} */
export const EMPTY_APPLICABILITY_PROFILE = Object.freeze({
  engineCode: null,
  buildPlant: null,
  transmissionCode: null,
  hasVsc: null,
  hasSmartKey: null,
});

const ENGINE_CODE_PATTERN = /^[1-9][A-Z]{2}-[A-Z]{2,3}$/;
const TRANSMISSION_CODE_PATTERN = /^[A-Z]\d{2,3}[A-Z]?$/;

function readText(value) {
  if (value === null || value === undefined) {
    return "";
  }

  return String(value).trim().toUpperCase();
}

function normalizeEngineCode(value) {
  // "2zr fe", "2ZR- FE" and "2ZR-FE" are one engine: collapse the separator.
  const text = readText(value).replace(/\s*-\s*|\s+/g, "-");

  if (!text) {
    return null;
  }

  if (!ENGINE_CODE_PATTERN.test(text)) {
    throw new Error("Engine code must look like 2ZR-FE (a digit, two letters, a hyphen, letters).");
  }

  return text;
}

function normalizeBuildPlant(value) {
  const text = readText(value);

  if (!text) {
    return null;
  }

  if (!BUILD_PLANTS.includes(text)) {
    throw new Error("Build plant must be TMC, NUMMI, TMMC, or unknown.");
  }

  return /** @type {"TMC" | "NUMMI" | "TMMC"} */ (text);
}

function normalizeTransmissionCode(value) {
  const text = readText(value);

  if (!text) {
    return null;
  }

  if (!TRANSMISSION_CODE_PATTERN.test(text)) {
    throw new Error("Transmission code must look like U341E or C59.");
  }

  return text;
}

function normalizeTriState(value, label) {
  if (value === true || value === false) {
    return value;
  }

  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "string") {
    const text = value.trim().toLowerCase();

    if (text === "yes") {
      return true;
    }

    if (text === "no") {
      return false;
    }

    if (text === "" || text === "unknown") {
      return null;
    }
  }

  throw new Error(`${label} must be yes, no, or unknown.`);
}

/**
 * Validate the variant details a client sent. Every field is optional and an
 * absent or empty field is unknown (`null`).
 *
 * @param {unknown} input
 * @returns {ApplicabilityProfile}
 * @throws {Error} with a sentence the Settings page can show as-is.
 */
export function normalizeApplicabilityProfile(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Variant details must be an object.");
  }

  const source = /** @type {Record<string, unknown>} */ (input);

  return {
    engineCode: normalizeEngineCode(source.engineCode),
    buildPlant: normalizeBuildPlant(source.buildPlant),
    transmissionCode: normalizeTransmissionCode(source.transmissionCode),
    hasVsc: normalizeTriState(source.hasVsc, "VSC"),
    hasSmartKey: normalizeTriState(source.hasSmartKey, "Smart Key"),
  };
}

function readStoredFlag(value) {
  if (value === 1) {
    return true;
  }

  if (value === 0) {
    return false;
  }

  return null;
}

/**
 * Read the profile off a `vehicles` row. A row read before migration 006 simply
 * lacks the columns, which reads as unknown.
 *
 * @param {{ engine_code?: unknown, build_plant?: unknown, transmission_code?: unknown,
 *   has_vsc?: unknown, has_smart_key?: unknown }} row
 * @returns {ApplicabilityProfile}
 */
export function profileFromVehicleRow(row) {
  return {
    engineCode: typeof row.engine_code === "string" ? row.engine_code : null,
    buildPlant: BUILD_PLANTS.includes(/** @type {string} */ (row.build_plant))
      ? /** @type {"TMC" | "NUMMI" | "TMMC"} */ (row.build_plant)
      : null,
    transmissionCode: typeof row.transmission_code === "string" ? row.transmission_code : null,
    hasVsc: readStoredFlag(row.has_vsc),
    hasSmartKey: readStoredFlag(row.has_smart_key),
  };
}

function toStoredFlag(value) {
  if (value === true) {
    return 1;
  }

  if (value === false) {
    return 0;
  }

  return null;
}

/**
 * The column values to write for a profile. Booleans are stored as 1/0 and
 * unknown as NULL, matching migration 006's CHECK constraints.
 *
 * @param {ApplicabilityProfile} profile
 */
export function profileToColumns(profile) {
  return {
    engine_code: profile.engineCode,
    build_plant: profile.buildPlant,
    transmission_code: profile.transmissionCode,
    has_vsc: toStoredFlag(profile.hasVsc),
    has_smart_key: toStoredFlag(profile.hasSmartKey),
  };
}
