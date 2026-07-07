import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { Router } from "express";
import { config } from "../config.js";
import { db } from "../database.js";
import {
  getDocumentDefaults,
  updateDocumentDefaults,
} from "../services/appSettingsService.js";
import { resolveTarExecutable } from "../services/tarExecutable.js";
import { snapshotDatabase } from "../services/databaseSnapshot.js";
import { getVehicle } from "../services/vehicleService.js";
import { normalizeText } from "../utils/text.js";

export const settingsRouter = Router();

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
    supported: true,
    path: "Download from Settings",
    message:
      "Use Export backup to download one .tar.gz file containing your SQLite database and uploaded PDFs.",
  };
}

function formatBackupFilename() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `corolla-fix-helper-backup-${stamp}.tar.gz`;
}

async function createBackupStagingDir() {
  const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-fix-helper-backup-"));
  const databaseDir = path.join(stagingRoot, "database");
  const uploadsDir = path.join(stagingRoot, "uploads");

  fs.mkdirSync(databaseDir, { recursive: true });
  fs.mkdirSync(uploadsDir, { recursive: true });

  const databaseFilename = path.basename(config.databaseFile) || `backup-${randomUUID()}.db`;
  // Snapshot through SQLite (not a raw copy) so committed rows still in the WAL
  // sidecar are captured. Use the live connection that owns the WAL.
  snapshotDatabase({
    sourceFile: config.databaseFile,
    destinationFile: path.join(databaseDir, databaseFilename),
    db,
  });

  if (fs.existsSync(config.uploadsDir)) {
    fs.cpSync(config.uploadsDir, uploadsDir, { recursive: true });
  }

  return stagingRoot;
}

export function createBackupExportHandler({
  spawnProcess = spawn,
  resolveTar = resolveTarExecutable,
  createStagingDir = createBackupStagingDir,
  removeStagingDir = (stagingRoot) => {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
  },
  logger = console,
} = {}) {
  return async function backupExportHandler(_request, response) {
    let stagingRoot = "";
    let tarProcess;
    let stderr = "";
    let streamingStarted = false;
    let settled = false;

    const cleanup = () => {
      if (stagingRoot) {
        removeStagingDir(stagingRoot);
        stagingRoot = "";
      }
    };

    const fail = (error, exitCode = null) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();

      const stderrMessage = stderr.trim();
      const exitMessage = exitCode === null ? "" : ` with code ${exitCode}`;
      const detail = stderrMessage || error.message;
      logger.error(`Backup export tar failed${exitMessage}: ${detail}`);

      if (streamingStarted || response.headersSent) {
        response.destroy(error);
        return;
      }

      response.status(500).json({
        error: "Could not create backup export archive.",
      });
    };

    try {
      stagingRoot = await createStagingDir();
      const tarExecutable = resolveTar();
      const args = [
        "-czf",
        "-",
        "-C",
        stagingRoot,
        "database",
        "uploads",
      ];

      tarProcess = spawnProcess(tarExecutable, args, { shell: false });

      tarProcess.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      tarProcess.stdout.once("data", (firstChunk) => {
        if (settled) {
          return;
        }

        streamingStarted = true;
        response.setHeader("Content-Type", "application/gzip");
        response.setHeader(
          "Content-Disposition",
          `attachment; filename="${formatBackupFilename()}"`
        );
        response.write(firstChunk);
        tarProcess.stdout.pipe(response, { end: false });
      });

      tarProcess.on("error", (error) => {
        fail(new Error(`tar could not start: ${error.message}`));
      });

      tarProcess.on("close", (exitCode) => {
        if (exitCode !== 0) {
          fail(
            new Error(
              `tar exited with code ${exitCode}${
                stderr.trim() ? `: ${stderr.trim()}` : ""
              }`
            ),
            exitCode
          );
          return;
        }

        if (!streamingStarted) {
          fail(new Error("tar produced no backup archive data."), exitCode);
          return;
        }

        if (!settled) {
          settled = true;
          cleanup();
          response.end();
        }
      });
    } catch (error) {
      fail(error);
    }
  };
}

settingsRouter.get("/", (_request, response) => {
  try {
    const vehicle = mapVehicleRow(getVehicle());

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

settingsRouter.get("/backup-export", createBackupExportHandler());

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
    const existingVehicle = getVehicle();
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

    const updatedVehicle = mapVehicleRow(getVehicle());

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
