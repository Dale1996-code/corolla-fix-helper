// Manual symptom <-> procedure links.
//
// This mirrors the inline document-linking helpers in the symptom and procedure
// routes (DELETE-then-INSERT to replace a link set, validate ids against the
// stored rows first), but keeps both directions in one place because the join
// is shared by both routes and read back on each detail response.

import { db } from "../database.js";

/** Keep only requested procedure ids that actually exist as stored procedures. */
function getExistingProcedureIds(requestedProcedureIds) {
  if (!requestedProcedureIds.length) {
    return [];
  }

  const placeholders = requestedProcedureIds.map(() => "?").join(", ");

  return db
    .prepare(`SELECT id FROM procedures WHERE id IN (${placeholders})`)
    .all(...requestedProcedureIds)
    .map((row) => row.id);
}

/** Keep only requested symptom ids that actually exist as stored symptoms. */
function getExistingSymptomIds(requestedSymptomIds) {
  if (!requestedSymptomIds.length) {
    return [];
  }

  const placeholders = requestedSymptomIds.map(() => "?").join(", ");

  return db
    .prepare(`SELECT id FROM symptoms WHERE id IN (${placeholders})`)
    .all(...requestedSymptomIds)
    .map((row) => row.id);
}

/**
 * Replace every procedure linked to one symptom with the requested set.
 * Returns the procedure ids that were actually linked (existing ones only).
 */
export function setSymptomProcedures(symptomId, requestedProcedureIds) {
  db.prepare("DELETE FROM symptom_procedures WHERE symptom_id = ?").run(symptomId);

  const validProcedureIds = getExistingProcedureIds(requestedProcedureIds);

  if (!validProcedureIds.length) {
    return [];
  }

  const insertLink = db.prepare(`
    INSERT INTO symptom_procedures (symptom_id, procedure_id)
    VALUES (?, ?)
  `);

  for (const procedureId of validProcedureIds) {
    insertLink.run(symptomId, procedureId);
  }

  return validProcedureIds;
}

/**
 * Replace every symptom linked to one procedure with the requested set.
 * Returns the symptom ids that were actually linked (existing ones only).
 */
export function setProcedureSymptoms(procedureId, requestedSymptomIds) {
  db.prepare("DELETE FROM symptom_procedures WHERE procedure_id = ?").run(procedureId);

  const validSymptomIds = getExistingSymptomIds(requestedSymptomIds);

  if (!validSymptomIds.length) {
    return [];
  }

  const insertLink = db.prepare(`
    INSERT INTO symptom_procedures (symptom_id, procedure_id)
    VALUES (?, ?)
  `);

  for (const symptomId of validSymptomIds) {
    insertLink.run(symptomId, procedureId);
  }

  return validSymptomIds;
}

/**
 * Build a map of symptom id -> linked procedures for one vehicle, so the symptom
 * list/detail responses can embed procedures the same way they embed documents.
 */
export function buildSymptomProcedureLinksMap(vehicleId) {
  const linkRows = db
    .prepare(`
      SELECT
        symptom_procedures.symptom_id,
        procedures.id AS procedure_id,
        procedures.title AS procedure_title,
        procedures.system AS procedure_system,
        procedures.difficulty AS procedure_difficulty
      FROM symptom_procedures
      JOIN symptoms ON symptoms.id = symptom_procedures.symptom_id
      JOIN procedures ON procedures.id = symptom_procedures.procedure_id
      WHERE symptoms.vehicle_id = ?
      ORDER BY procedures.title COLLATE NOCASE ASC
    `)
    .all(vehicleId);

  const linksMap = new Map();

  for (const linkRow of linkRows) {
    if (!linksMap.has(linkRow.symptom_id)) {
      linksMap.set(linkRow.symptom_id, []);
    }

    linksMap.get(linkRow.symptom_id).push({
      id: linkRow.procedure_id,
      title: linkRow.procedure_title,
      system: linkRow.procedure_system || "",
      difficulty: linkRow.procedure_difficulty || "intermediate",
    });
  }

  return linksMap;
}

/**
 * Build a map of procedure id -> linked symptoms for one vehicle, so the
 * procedure list/detail responses can embed symptoms.
 */
export function buildProcedureSymptomLinksMap(vehicleId) {
  const linkRows = db
    .prepare(`
      SELECT
        symptom_procedures.procedure_id,
        symptoms.id AS symptom_id,
        symptoms.title AS symptom_title,
        symptoms.system AS symptom_system,
        symptoms.status AS symptom_status
      FROM symptom_procedures
      JOIN procedures ON procedures.id = symptom_procedures.procedure_id
      JOIN symptoms ON symptoms.id = symptom_procedures.symptom_id
      WHERE procedures.vehicle_id = ?
      ORDER BY symptoms.title COLLATE NOCASE ASC
    `)
    .all(vehicleId);

  const linksMap = new Map();

  for (const linkRow of linkRows) {
    if (!linksMap.has(linkRow.procedure_id)) {
      linksMap.set(linkRow.procedure_id, []);
    }

    linksMap.get(linkRow.procedure_id).push({
      id: linkRow.symptom_id,
      title: linkRow.symptom_title,
      system: linkRow.symptom_system || "",
      status: linkRow.symptom_status || "open",
    });
  }

  return linksMap;
}
