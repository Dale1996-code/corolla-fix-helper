import { Router } from "express";
import { config } from "../config.js";
import { db } from "../database.js";
import {
  getDocumentDefaults,
  updateDocumentDefaults,
} from "../services/appSettingsService.js";

export const settingsRouter = Router();

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function getVehicleRecord() {
  const vehicle = db
    .prepare(`
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
    `)
    .get();

  if (!vehicle) {
    throw new Error("No vehicle record exists yet.");
  }

  return vehicle;
}

function mapVehicleRow(row) {
  return {
    id: row.id,
    year: row.year,
    make: row.make,
    model: row.model,
    trim: row.trim || "",
    engine: row.engine || "",
  };
}

function normalizeYear(value) {
  const numericYear = Number(value);

  if (!Number.isInteger(numericYear)) {
    throw new Error("Year must be a whole number.");
  }

  if (numericYear < 1900 || numericYear > 2100) {
    throw new Error("Year must be between 1900 and 2100.");
  }

  return numericYear;
}

function getRuntimeSettings() {
  return {
    databaseFile: config.databaseFile,
    uploadsDir: config.uploadsDir,
    maxUploadSizeMb: config.maxUploadSizeMb,
    port: config.port,
    clientPort: config.clientPort,
    pathsEditable: false,
  };
}

function getBackupExportSettings() {
  return {
    supported: false,
    path: "",
    message:
      "Backup and export are not wired up yet, so there is no working backup folder setting to edit in the browser.",
  };
}

settingsRouter.get("/", (_request, response) => {
  try {
    const vehicle = mapVehicleRow(getVehicleRecord());

    response.json({
      vehicle,
      runtime: getRuntimeSettings(),
      documentDefaults: getDocumentDefaults(),
      backupExport: getBackupExportSettings(),
    });
  } catch (error) {
    response.status(500).json({
      error: error.message || "Could not load settings.",
    });
  }
});

settingsRouter.put("/document-defaults", (request, response) => {
  try {
    const documentDefaults = updateDocumentDefaults({
      commonSystems: request.body.commonSystems,
      documentTypes: request.body.documentTypes,
    });

    response.json({
      message: "Document defaults updated.",
      documentDefaults,
    });
  } catch (error) {
    response.status(400).json({
      error: error.message || "Could not update document defaults.",
    });
  }
});

settingsRouter.put("/vehicle", (request, response) => {
  try {
    const existingVehicle = getVehicleRecord();
    const year = normalizeYear(request.body.year);
    const make = normalizeText(request.body.make);
    const model = normalizeText(request.body.model);
    const trim = normalizeText(request.body.trim);
    const engine = normalizeText(request.body.engine);

    if (!make) {
      response.status(400).json({
        error: "Make is required.",
      });
      return;
    }

    if (!model) {
      response.status(400).json({
        error: "Model is required.",
      });
      return;
    }

    db.prepare(`
      UPDATE vehicles
      SET
        year = ?,
        make = ?,
        model = ?,
        trim = ?,
        engine = ?
      WHERE id = ?
    `).run(year, make, model, trim, engine, existingVehicle.id);

    const updatedVehicle = mapVehicleRow(getVehicleRecord());

    response.json({
      message: "Vehicle settings updated.",
      vehicle: updatedVehicle,
    });
  } catch (error) {
    response.status(400).json({
      error: error.message || "Could not update vehicle settings.",
    });
  }
});
