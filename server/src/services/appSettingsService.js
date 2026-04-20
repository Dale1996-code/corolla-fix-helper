import { db } from "../database.js";

export const DEFAULT_COMMON_SYSTEMS = [
  "Engine",
  "Brakes",
  "Electrical",
  "Cooling",
  "Drivetrain",
  "Suspension",
  "Steering",
  "HVAC",
  "Body",
  "Interior",
];

export const DEFAULT_DOCUMENT_TYPES = [
  "Repair Manual",
  "Wiring Diagram",
  "Inspection",
  "Maintenance Schedule",
  "Procedure",
  "Reference",
];

function uniqueTrimmedList(values) {
  const normalizedValues = [];
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
    normalizedValues.push(trimmedValue);
  }

  return normalizedValues;
}

function parseStoredList(value, fallbackValues) {
  try {
    const parsedValue = JSON.parse(value || "[]");
    const normalizedValue = uniqueTrimmedList(parsedValue);

    return normalizedValue.length ? normalizedValue : [...fallbackValues];
  } catch {
    return [...fallbackValues];
  }
}

export function ensureAppSettingsRecord() {
  const existingSettings = db
    .prepare(`
      SELECT id
      FROM app_settings
      WHERE id = 1
    `)
    .get();

  if (existingSettings) {
    return;
  }

  db.prepare(`
    INSERT INTO app_settings (
      id,
      document_system_defaults,
      document_type_defaults
    ) VALUES (?, ?, ?)
  `).run(
    1,
    JSON.stringify(DEFAULT_COMMON_SYSTEMS),
    JSON.stringify(DEFAULT_DOCUMENT_TYPES)
  );
}

function getAppSettingsRow() {
  ensureAppSettingsRecord();

  return db
    .prepare(`
      SELECT
        document_system_defaults,
        document_type_defaults
      FROM app_settings
      WHERE id = 1
    `)
    .get();
}

export function getDocumentDefaults() {
  const row = getAppSettingsRow();

  return {
    commonSystems: parseStoredList(
      row?.document_system_defaults,
      DEFAULT_COMMON_SYSTEMS
    ),
    documentTypes: parseStoredList(
      row?.document_type_defaults,
      DEFAULT_DOCUMENT_TYPES
    ),
  };
}

export function updateDocumentDefaults({ commonSystems, documentTypes }) {
  const nextCommonSystems = uniqueTrimmedList(commonSystems);
  const nextDocumentTypes = uniqueTrimmedList(documentTypes);

  if (!nextCommonSystems.length) {
    throw new Error("Add at least one common system name.");
  }

  if (!nextDocumentTypes.length) {
    throw new Error("Add at least one document type.");
  }

  ensureAppSettingsRecord();

  db.prepare(`
    UPDATE app_settings
    SET
      document_system_defaults = ?,
      document_type_defaults = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = 1
  `).run(JSON.stringify(nextCommonSystems), JSON.stringify(nextDocumentTypes));

  return {
    commonSystems: nextCommonSystems,
    documentTypes: nextDocumentTypes,
  };
}
