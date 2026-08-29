import { Router } from "express";
import { getVehicleId } from "../services/vehicleService.js";
import {
  createRepairHistory,
  deleteRepairHistory,
  findChecklistForVehicle,
  findMissingDocumentIds,
  findSymptomForVehicle,
  getRepairHistory,
  getRepairHistoryRecord,
  listRepairHistory,
  normalizeOdometerMiles,
  normalizeOptionalEntityId,
  normalizeOutcome,
  normalizePerformedOn,
  normalizeSourceInputs,
  updateRepairHistory,
} from "../services/repairHistoryService.js";
import { hasOwnField, normalizeText } from "../utils/text.js";
import { parsePositiveInt } from "../utils/http.js";

// Repair history: what work was actually done, when, at what mileage, and which
// documents backed it.
//
// Thin by the repository's convention -- HTTP parsing, validation, and status
// codes live here; every query and the canonical row shape live in
// repairHistoryService.js.
//
// TWO THINGS THIS ROUTE IS RESPONSIBLE FOR, beyond ordinary CRUD:
//
//   1. Every validation failure must be a clean 400, never a database 500. The
//      schema carries CHECK constraints on the odometer range and the outcome
//      vocabulary as defence in depth, but a caller should be told what was
//      wrong with their input, not handed a constraint error.
//   2. `PUT` distinguishes "field omitted" from "field explicitly set", using
//      hasOwnField. That distinction is load-bearing rather than cosmetic: it is
//      what stops an edit to a summary from re-snapshotting a symptom title. See
//      the snapshot rules on updateRepairHistory.

export const repairHistoryRouter = Router();

// Normalize the parsed body to a plain object so handlers can read fields off it
// without a guard, matching the repair-checklists router. A missing body, or a
// JSON scalar like `null`, otherwise leaves request.body non-object and throws a
// TypeError (surfacing as an HTML 500) before validation can return a clean 400.
repairHistoryRouter.use((request, _response, next) => {
  if (request.body === null || typeof request.body !== "object" || Array.isArray(request.body)) {
    request.body = {};
  }

  next();
});

/**
 * Confirm every linked record named in a request actually exists for this
 * vehicle, so an unknown id is refused rather than silently stored.
 *
 * Returns an error message, or `null` when everything resolves.
 */
function findLinkProblem(vehicleId, { symptomId, checklistId, sources }) {
  if (symptomId !== null && symptomId !== undefined && !findSymptomForVehicle(vehicleId, symptomId)) {
    return "Linked symptom does not exist.";
  }

  if (
    checklistId !== null &&
    checklistId !== undefined &&
    !findChecklistForVehicle(vehicleId, checklistId)
  ) {
    return "Linked checklist does not exist.";
  }

  if (sources && sources.length) {
    const missing = findMissingDocumentIds(
      vehicleId,
      sources.map((source) => source.documentId)
    );

    if (missing.length) {
      return `Linked document${missing.length === 1 ? "" : "s"} ${missing.join(", ")} do${
        missing.length === 1 ? "es" : ""
      } not exist.`;
    }
  }

  return null;
}

repairHistoryRouter.get("/", (_request, response) => {
  try {
    const vehicleId = getVehicleId();
    const repairHistory = listRepairHistory(vehicleId);

    response.json({
      repairHistory,
      total: repairHistory.length,
    });
  } catch (error) {
    response.status(500).json({
      error: error.message || "Could not load repair history.",
    });
  }
});

repairHistoryRouter.get("/:id", (request, response) => {
  const repairHistoryId = parsePositiveInt(request.params.id);

  if (repairHistoryId === null) {
    response.status(400).json({
      error: "Repair history ID must be a positive number.",
    });
    return;
  }

  try {
    const vehicleId = getVehicleId();
    const record = getRepairHistory(vehicleId, repairHistoryId);

    if (!record) {
      response.status(404).json({
        error: "Repair history record not found.",
      });
      return;
    }

    response.json({ repairHistory: record });
  } catch (error) {
    response.status(500).json({
      error: error.message || "Could not load repair history record.",
    });
  }
});

repairHistoryRouter.post("/", (request, response) => {
  const title = normalizeText(request.body.title);

  if (!title) {
    response.status(400).json({
      error: "Title is required.",
    });
    return;
  }

  let performedOn;
  let odometerMiles;
  let outcome;
  let symptomId;
  let checklistId;
  let sources;

  try {
    performedOn = normalizePerformedOn(request.body.performedOn);
    odometerMiles = normalizeOdometerMiles(request.body.odometerMiles);
    outcome = normalizeOutcome(request.body.outcome);
    symptomId = normalizeOptionalEntityId(request.body.symptomId, "Symptom ID");
    checklistId = normalizeOptionalEntityId(request.body.checklistId, "Checklist ID");
    sources = normalizeSourceInputs(request.body.sources);
  } catch (error) {
    response.status(400).json({
      error: error.message || "Invalid repair history values.",
    });
    return;
  }

  try {
    const vehicleId = getVehicleId();
    const linkProblem = findLinkProblem(vehicleId, { symptomId, checklistId, sources });

    if (linkProblem) {
      response.status(400).json({ error: linkProblem });
      return;
    }

    const created = createRepairHistory(vehicleId, {
      performedOn,
      odometerMiles,
      title,
      outcome,
      summary: normalizeText(request.body.summary),
      followUp: normalizeText(request.body.followUp),
      symptomId,
      checklistId,
      sources,
    });

    response.status(201).json({
      message: "Repair history record created.",
      repairHistory: created,
    });
  } catch (error) {
    response.status(500).json({
      error: error.message || "Could not create repair history record.",
    });
  }
});

repairHistoryRouter.put("/:id", (request, response) => {
  const repairHistoryId = parsePositiveInt(request.params.id);

  if (repairHistoryId === null) {
    response.status(400).json({
      error: "Repair history ID must be a positive number.",
    });
    return;
  }

  try {
    const vehicleId = getVehicleId();
    const existing = getRepairHistoryRecord(vehicleId, repairHistoryId);

    if (!existing) {
      response.status(404).json({
        error: "Repair history record not found.",
      });
      return;
    }

    const title = hasOwnField(request.body, "title")
      ? normalizeText(request.body.title)
      : normalizeText(existing.title);

    if (!title) {
      response.status(400).json({
        error: "Title is required.",
      });
      return;
    }

    let performedOn;
    let odometerMiles;
    let outcome;
    // Left undefined unless the caller explicitly supplied the field. That is
    // what protects the historical snapshots from an unrelated edit.
    let symptomChange;
    let checklistChange;
    let sources;

    try {
      performedOn = hasOwnField(request.body, "performedOn")
        ? normalizePerformedOn(request.body.performedOn)
        : normalizeText(existing.performed_on);

      odometerMiles = hasOwnField(request.body, "odometerMiles")
        ? normalizeOdometerMiles(request.body.odometerMiles)
        : (/** @type {number|null} */ (
            Number.isInteger(existing.odometer_miles) ? existing.odometer_miles : null
          ));

      outcome = hasOwnField(request.body, "outcome")
        ? normalizeOutcome(request.body.outcome)
        : normalizeOutcome(existing.outcome);

      if (hasOwnField(request.body, "symptomId")) {
        symptomChange = {
          symptomId: normalizeOptionalEntityId(request.body.symptomId, "Symptom ID"),
        };
      }

      if (hasOwnField(request.body, "checklistId")) {
        checklistChange = {
          checklistId: normalizeOptionalEntityId(request.body.checklistId, "Checklist ID"),
        };
      }

      if (hasOwnField(request.body, "sources")) {
        sources = normalizeSourceInputs(request.body.sources);
      }
    } catch (error) {
      response.status(400).json({
        error: error.message || "Invalid repair history values.",
      });
      return;
    }

    const linkProblem = findLinkProblem(vehicleId, {
      symptomId: symptomChange?.symptomId,
      checklistId: checklistChange?.checklistId,
      sources,
    });

    if (linkProblem) {
      response.status(400).json({ error: linkProblem });
      return;
    }

    const updated = updateRepairHistory(vehicleId, repairHistoryId, {
      performedOn,
      odometerMiles,
      title,
      outcome,
      summary: hasOwnField(request.body, "summary")
        ? normalizeText(request.body.summary)
        : normalizeText(existing.summary),
      followUp: hasOwnField(request.body, "followUp")
        ? normalizeText(request.body.followUp)
        : normalizeText(existing.follow_up),
      symptomChange,
      checklistChange,
      sources,
    });

    response.json({
      message: "Repair history record updated.",
      repairHistory: updated,
    });
  } catch (error) {
    response.status(500).json({
      error: error.message || "Could not update repair history record.",
    });
  }
});

repairHistoryRouter.delete("/:id", (request, response) => {
  const repairHistoryId = parsePositiveInt(request.params.id);

  if (repairHistoryId === null) {
    response.status(400).json({
      error: "Repair history ID must be a positive number.",
    });
    return;
  }

  try {
    const vehicleId = getVehicleId();
    // Provenance rows are removed by the ON DELETE CASCADE foreign key.
    const removed = deleteRepairHistory(vehicleId, repairHistoryId);

    if (removed === 0) {
      response.status(404).json({
        error: "Repair history record not found.",
      });
      return;
    }

    response.json({
      message: "Repair history record deleted.",
    });
  } catch (error) {
    response.status(500).json({
      error: error.message || "Could not delete repair history record.",
    });
  }
});
