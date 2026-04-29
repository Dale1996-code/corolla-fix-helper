import { Router } from "express";
import { db } from "../database.js";

export const dashboardRouter = Router();

const DASHBOARD_LIMITS = {
  favorites: 5,
  recentDocuments: 5,
  recentSymptoms: 5,
  recentProcedures: 5,
  recentNotes: 5,
  activeSymptoms: 5,
  recentActivity: 8,
};

function getVehicleId() {
  const vehicle = db
    .prepare("SELECT id FROM vehicles ORDER BY id ASC LIMIT 1")
    .get();

  if (!vehicle) {
    throw new Error("No vehicle record exists yet.");
  }

  return vehicle.id;
}

function getVehicleProfile() {
  const vehicle = db
    .prepare(
      `
      SELECT
        id,
        year,
        make,
        model,
        trim,
        engine
      FROM vehicles
      ORDER BY id ASC
      LIMIT 1
    `
    )
    .get();

  if (!vehicle) {
    throw new Error("No vehicle record exists yet.");
  }

  return {
    id: vehicle.id,
    year: vehicle.year,
    make: vehicle.make,
    model: vehicle.model,
    trim: vehicle.trim || "",
    engine: vehicle.engine || "",
  };
}

function mapDocumentRow(row) {
  return {
    id: row.id,
    title: row.title,
    system: row.system || "",
    documentType: row.document_type || "",
    isFavorite: Boolean(row.is_favorite),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapSymptomRow(row) {
  return {
    id: row.id,
    title: row.title,
    system: row.system || "",
    status: row.status || "open",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapProcedureRow(row) {
  return {
    id: row.id,
    title: row.title,
    system: row.system || "",
    difficulty: row.difficulty || "intermediate",
    confidence: row.confidence || "medium",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapNoteRow(row) {
  return {
    id: row.id,
    title: row.title || "Untitled note",
    noteType: row.note_type || "general",
    relatedEntityType: row.related_entity_type || "none",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function listFavoriteDocuments(vehicleId, limit) {
  const rows = db
    .prepare(`
      SELECT
        id,
        title,
        system,
        document_type,
        is_favorite,
        created_at,
        updated_at
      FROM documents
      WHERE vehicle_id = ?
      AND is_favorite = 1
      ORDER BY updated_at DESC, id DESC
      LIMIT ?
    `)
    .all(vehicleId, limit);

  return rows.map((row) => mapDocumentRow(row));
}

function listRecentDocuments(vehicleId, limit) {
  const rows = db
    .prepare(`
      SELECT
        id,
        title,
        system,
        document_type,
        is_favorite,
        created_at,
        updated_at
      FROM documents
      WHERE vehicle_id = ?
      ORDER BY updated_at DESC, id DESC
      LIMIT ?
    `)
    .all(vehicleId, limit);

  return rows.map((row) => mapDocumentRow(row));
}

function listRecentSymptoms(vehicleId, limit) {
  const rows = db
    .prepare(`
      SELECT
        id,
        title,
        system,
        status,
        created_at,
        updated_at
      FROM symptoms
      WHERE vehicle_id = ?
      ORDER BY updated_at DESC, id DESC
      LIMIT ?
    `)
    .all(vehicleId, limit);

  return rows.map((row) => mapSymptomRow(row));
}

function listActiveSymptoms(vehicleId, limit) {
  const rows = db
    .prepare(`
      SELECT
        id,
        title,
        system,
        status,
        created_at,
        updated_at
      FROM symptoms
      WHERE vehicle_id = ?
      AND status IN ('open', 'monitoring')
      ORDER BY updated_at DESC, id DESC
      LIMIT ?
    `)
    .all(vehicleId, limit);

  return rows.map((row) => mapSymptomRow(row));
}

function listRecentProcedures(vehicleId, limit) {
  const rows = db
    .prepare(`
      SELECT
        id,
        title,
        system,
        difficulty,
        confidence,
        created_at,
        updated_at
      FROM procedures
      WHERE vehicle_id = ?
      ORDER BY updated_at DESC, id DESC
      LIMIT ?
    `)
    .all(vehicleId, limit);

  return rows.map((row) => mapProcedureRow(row));
}

function listRecentNotes(vehicleId, limit) {
  const rows = db
    .prepare(`
      SELECT
        id,
        COALESCE(NULLIF(TRIM(title), ''), 'Untitled note') AS title,
        note_type,
        related_entity_type,
        created_at,
        updated_at
      FROM notes
      WHERE vehicle_id = ?
      ORDER BY updated_at DESC, id DESC
      LIMIT ?
    `)
    .all(vehicleId, limit);

  return rows.map((row) => mapNoteRow(row));
}

function listRecentActivity(vehicleId, limit) {
  const rows = db
    .prepare(`
      SELECT
        entity_type,
        entity_id,
        title,
        updated_at
      FROM (
        SELECT
          'Document' AS entity_type,
          id AS entity_id,
          title,
          COALESCE(updated_at, created_at) AS updated_at
        FROM documents
        WHERE vehicle_id = ?

        UNION ALL

        SELECT
          'Symptom' AS entity_type,
          id AS entity_id,
          title,
          COALESCE(updated_at, created_at) AS updated_at
        FROM symptoms
        WHERE vehicle_id = ?

        UNION ALL

        SELECT
          'Procedure' AS entity_type,
          id AS entity_id,
          title,
          COALESCE(updated_at, created_at) AS updated_at
        FROM procedures
        WHERE vehicle_id = ?

        UNION ALL

        SELECT
          'Note' AS entity_type,
          id AS entity_id,
          COALESCE(NULLIF(TRIM(title), ''), 'Untitled note') AS title,
          COALESCE(updated_at, created_at) AS updated_at
        FROM notes
        WHERE vehicle_id = ?
      )
      ORDER BY updated_at DESC, entity_id DESC
      LIMIT ?
    `)
    .all(vehicleId, vehicleId, vehicleId, vehicleId, limit);

  return rows.map((row) => ({
    key: `${String(row.entity_type).toLowerCase()}-${row.entity_id}`,
    entityType: String(row.entity_type).toLowerCase(),
    entityId: row.entity_id,
    typeLabel: row.entity_type,
    title: row.title,
    updatedAt: row.updated_at,
  }));
}

function getSummaryCounts(vehicleId) {
  const totalDocuments = db
    .prepare("SELECT COUNT(*) AS total FROM documents WHERE vehicle_id = ?")
    .get(vehicleId).total;

  const favoriteDocuments = db
    .prepare("SELECT COUNT(*) AS total FROM documents WHERE vehicle_id = ? AND is_favorite = 1")
    .get(vehicleId).total;

  const totalSymptoms = db
    .prepare("SELECT COUNT(*) AS total FROM symptoms WHERE vehicle_id = ?")
    .get(vehicleId).total;

  const activeSymptoms = db
    .prepare(`
      SELECT COUNT(*) AS total
      FROM symptoms
      WHERE vehicle_id = ?
      AND status IN ('open', 'monitoring')
    `)
    .get(vehicleId).total;

  const totalProcedures = db
    .prepare("SELECT COUNT(*) AS total FROM procedures WHERE vehicle_id = ?")
    .get(vehicleId).total;

  const totalNotes = db
    .prepare("SELECT COUNT(*) AS total FROM notes WHERE vehicle_id = ?")
    .get(vehicleId).total;

  return {
    totalDocuments,
    favoriteDocuments,
    totalSymptoms,
    activeSymptoms,
    totalProcedures,
    totalNotes,
  };
}

dashboardRouter.get("/", (_request, response) => {
  try {
    const vehicle = getVehicleProfile();
    const vehicleId = vehicle.id;
    const summary = getSummaryCounts(vehicleId);
    const favoriteDocuments = listFavoriteDocuments(vehicleId, DASHBOARD_LIMITS.favorites);
    const recentDocuments = listRecentDocuments(vehicleId, DASHBOARD_LIMITS.recentDocuments);
    const recentSymptoms = listRecentSymptoms(vehicleId, DASHBOARD_LIMITS.recentSymptoms);
    const recentProcedures = listRecentProcedures(vehicleId, DASHBOARD_LIMITS.recentProcedures);
    const recentNotes = listRecentNotes(vehicleId, DASHBOARD_LIMITS.recentNotes);
    const activeSymptoms = listActiveSymptoms(vehicleId, DASHBOARD_LIMITS.activeSymptoms);
    const recentActivity = listRecentActivity(vehicleId, DASHBOARD_LIMITS.recentActivity);

    response.json({
      vehicle,
      summary,
      favoriteDocuments,
      recentDocuments,
      recentSymptoms,
      recentProcedures,
      recentNotes,
      activeSymptoms,
      recentActivity,
    });
  } catch (error) {
    response.status(500).json({
      error: error.message || "Could not load dashboard data.",
    });
  }
});
