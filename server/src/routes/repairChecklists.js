import { Router } from "express";
import { db } from "../database.js";
import { getVehicleId } from "../services/vehicleService.js";
import { planRunStore } from "../services/agent/planRunStore.js";
import {
  completeChecklistIntoHistory,
  insertChecklistSources,
  listChecklistSources,
  listChecklistSourcesForVehicle,
  normalizeChecklistSources,
} from "../services/repairChecklistProvenanceService.js";
import {
  findChecklistForVehicle,
  findSymptomForVehicle,
  normalizeOdometerMiles,
  normalizeOptionalEntityId,
  normalizeOutcome,
  normalizePerformedOn,
} from "../services/repairHistoryService.js";
import { hasOwnField, normalizeText } from "../utils/text.js";
import { parsePositiveInt } from "../utils/http.js";

// Shown when a checklist draft id no longer resolves. Written for a beginner:
// the fix is to rebuild the plan, and nothing was lost from the workspace.
export const CHECKLIST_DRAFT_EXPIRED_MESSAGE =
  "That repair plan is no longer available to save. Plans are held for a few hours after they are built, and this one has expired or the server restarted. Build the plan again, then save it as a checklist from the new result.";

// A checklist status is stored in snake_case; the client maps these to display
// labels (for example `in_progress` renders as "In progress").
const allowedStatusValues = new Set(["planned", "in_progress", "blocked", "done"]);

function normalizeStatus(value) {
  const normalized = normalizeText(value).toLowerCase();

  if (!normalized) {
    return "planned";
  }

  if (!allowedStatusValues.has(normalized)) {
    throw new Error("Status must be planned, in_progress, blocked, or done.");
  }

  return normalized;
}

function normalizeDirection(value) {
  const normalized = normalizeText(value).toLowerCase();

  if (normalized !== "up" && normalized !== "down") {
    throw new Error("Direction must be up or down.");
  }

  return normalized;
}

function mapItemRow(row) {
  return {
    id: row.id,
    text: row.text || "",
    isDone: Boolean(row.is_done),
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function buildChecklist(row, items, sources = []) {
  const doneItemCount = items.filter((item) => item.isDone).length;

  return {
    id: row.id,
    title: row.title || "",
    status: row.status || "planned",
    description: row.description || "",
    notes: row.notes || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    items,
    itemCount: items.length,
    doneItemCount,
    // Structured planner provenance (roadmap N3.2). Additive: a checklist
    // created by hand has none, and every existing client ignores the field.
    // The human-readable citation text in `notes` is unchanged and stays -- this
    // is the queryable twin, not a replacement.
    sources,
    sourceCount: sources.length,
  };
}

function listItemsForChecklist(checklistId) {
  return db
    .prepare(`
      SELECT id, text, is_done, sort_order, created_at, updated_at
      FROM repair_checklist_items
      WHERE checklist_id = ?
      ORDER BY sort_order ASC, id ASC
    `)
    .all(checklistId)
    .map((row) => mapItemRow(row));
}

function listChecklistsForVehicle(vehicleId) {
  const checklistRows = db
    .prepare(`
      SELECT id, title, status, description, notes, created_at, updated_at
      FROM repair_checklists
      WHERE vehicle_id = ?
      ORDER BY updated_at DESC, id DESC
    `)
    .all(vehicleId);

  // One query for every item so the list does not fan out into per-checklist
  // reads. Items are grouped back onto their checklist below.
  const itemRows = db
    .prepare(`
      SELECT
        items.id,
        items.checklist_id,
        items.text,
        items.is_done,
        items.sort_order,
        items.created_at,
        items.updated_at
      FROM repair_checklist_items AS items
      JOIN repair_checklists ON repair_checklists.id = items.checklist_id
      WHERE repair_checklists.vehicle_id = ?
      ORDER BY items.sort_order ASC, items.id ASC
    `)
    .all(vehicleId);

  const itemsByChecklist = new Map();

  for (const itemRow of itemRows) {
    if (!itemsByChecklist.has(itemRow.checklist_id)) {
      itemsByChecklist.set(itemRow.checklist_id, []);
    }

    itemsByChecklist.get(itemRow.checklist_id).push(mapItemRow(itemRow));
  }

  // Batched the same way the items are, so adding provenance to the list view
  // costs one more query rather than one per checklist.
  const sourcesByChecklist = listChecklistSourcesForVehicle(vehicleId);

  return checklistRows.map((row) =>
    buildChecklist(row, itemsByChecklist.get(row.id) || [], sourcesByChecklist.get(row.id) || [])
  );
}

function getChecklistForVehicle(vehicleId, checklistId) {
  const row = db
    .prepare(`
      SELECT id, title, status, description, notes, created_at, updated_at
      FROM repair_checklists
      WHERE id = ? AND vehicle_id = ?
    `)
    .get(checklistId, vehicleId);

  if (!row) {
    return null;
  }

  return buildChecklist(row, listItemsForChecklist(row.id), listChecklistSources(row.id));
}

// Confirm a checklist exists for this vehicle before touching its items.
function findChecklistId(vehicleId, checklistId) {
  const row = db
    .prepare("SELECT id FROM repair_checklists WHERE id = ? AND vehicle_id = ?")
    .get(checklistId, vehicleId);

  return row ? row.id : null;
}

// Item changes bump the parent checklist so "Updated" and list ordering reflect
// the latest activity, not just edits to the checklist's own fields.
function touchChecklist(checklistId) {
  db.prepare(`
    UPDATE repair_checklists
    SET updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(checklistId);
}

// Swap two items' sort positions in one transaction so a mid-swap failure never
// leaves both items sharing a position.
function swapItemOrder(firstItem, secondItem) {
  db.exec("BEGIN IMMEDIATE TRANSACTION");

  try {
    const updateSortOrder = db.prepare(`
      UPDATE repair_checklist_items
      SET sort_order = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);

    updateSortOrder.run(secondItem.sort_order, firstItem.id);
    updateSortOrder.run(firstItem.sort_order, secondItem.id);

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

// Writes a whole checklist -- its header row, every item, and every structured
// planner citation -- in ONE transaction, so a plan is never saved as a titled
// checklist with half its tasks missing. A partial save is worse than a failed
// one here: it looks finished, and the owner has no way to tell what was
// dropped.
//
// Provenance joined that transaction in N3.2 for the same reason (and it is the
// sharper case): a checklist that committed its text but lost its citations is
// indistinguishable afterwards from a plan that grounded nothing. If the
// provenance insert fails, the checklist is not saved at all.
function insertChecklistWithItems(vehicleId, draft) {
  db.exec("BEGIN IMMEDIATE TRANSACTION");

  try {
    const insertResult = db
      .prepare(`
        INSERT INTO repair_checklists (vehicle_id, title, status, description, notes)
        VALUES (?, ?, ?, ?, ?)
      `)
      .run(
        vehicleId,
        draft.title,
        normalizeStatus(draft.status),
        draft.description || "",
        draft.notes || ""
      );

    const checklistId = Number(insertResult.lastInsertRowid);
    const insertItem = db.prepare(`
      INSERT INTO repair_checklist_items (checklist_id, text, is_done, sort_order)
      VALUES (?, ?, 0, ?)
    `);

    (draft.items || []).forEach((item, index) => {
      insertItem.run(checklistId, item.text, index);
    });

    // `draft.sources` is the server's own, built by buildPlannerChecklistDraft
    // from the evidence contract's citations and frozen in the plan run store.
    // No request field reaches here.
    insertChecklistSources(vehicleId, checklistId, normalizeChecklistSources(draft.sources));

    db.exec("COMMIT");

    return checklistId;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/**
 * Builds the repair-checklists router.
 *
 * `planRuns` is injectable so tests can drive `POST /from-planner` with their
 * own draft store instead of the shared module-level one.
 *
 * @param {{ planRuns?: typeof planRunStore }} [deps]
 */
export function createRepairChecklistsRouter({ planRuns = planRunStore } = {}) {
  const router = Router();

  // Normalize the parsed body to a plain object so handlers can read fields off
  // it without a guard. A missing body, or a JSON scalar like `null`/`"x"`,
  // otherwise left request.body undefined/non-object and threw a TypeError
  // (surfacing as an HTML 500) before validation could return a clean JSON 400.
  router.use((request, _response, next) => {
    if (request.body === null || typeof request.body !== "object" || Array.isArray(request.body)) {
      request.body = {};
    }

    next();
  });

  // Saves a completed Repair Planner result as an ordinary checklist.
  //
  // TRUST BOUNDARY: the body carries a draft id and nothing else. Title, items,
  // notes, claims, source labels, safety warnings, AND the structured
  // `documentId` / `pageNumber` provenance all come out of the server's own
  // draft (built in plannerChecklistDraft.js from validated planner output), so
  // no request can write invented repair text into SQLite under the planner's
  // name. Any other field in the body is ignored -- including a `sources` array,
  // which is read from `record.draft` and never from `request.body`. Keeping
  // that boundary was a design constraint of N3.2: the browser must not become
  // the authority for which document backed a repair.
  //
  // Registered before the parameterized routes so a future `POST /:id` cannot
  // shadow it.
  router.post("/from-planner", (request, response) => {
    const checklistDraftId = normalizeText(request.body.checklistDraftId);

    if (!checklistDraftId) {
      response.status(400).json({
        error: 'Field "checklistDraftId" is required.',
      });
      return;
    }

    try {
      const record = planRuns.getChecklistDraft(checklistDraftId);

      if (!record) {
        response.status(404).json({ error: CHECKLIST_DRAFT_EXPIRED_MESSAGE });
        return;
      }

      const vehicleId = getVehicleId();

      // Saving the same draft twice returns the checklist it already became, so
      // a double-click (or a retried request) cannot litter the workspace with
      // duplicates. If that checklist has since been deleted the draft is saved
      // again -- the owner asked for a checklist, and there is no longer one.
      if (record.savedChecklistId) {
        const existing = getChecklistForVehicle(vehicleId, record.savedChecklistId);

        if (existing) {
          response.json({
            message: "This plan was already saved as a checklist.",
            checklist: existing,
            created: false,
          });
          return;
        }
      }

      const checklistId = insertChecklistWithItems(vehicleId, record.draft);
      planRuns.markChecklistDraftSaved(checklistDraftId, checklistId);

      response.status(201).json({
        message: "Checklist saved from your repair plan.",
        checklist: getChecklistForVehicle(vehicleId, checklistId),
        created: true,
      });
    } catch (error) {
      response.status(500).json({
        error: error.message || "Could not save the plan as a checklist.",
      });
    }
  });

  // Completes a checklist into a durable repair-history record (roadmap N3.2).
  //
  // AN EXPLICIT ACTION, NOT A STATUS CHANGE. `PUT /:id` with `status: "done"`
  // stays exactly what it was: an organizational state the owner picks from a
  // dropdown on the Checklists page, alongside Planned / In progress / Blocked.
  // It does NOT create history, and it deliberately was not overloaded to --
  // recording a repair needs facts nothing on the server can derive (the day the
  // work happened, the odometer reading, how it turned out), and a dropdown has
  // nowhere to ask for them. Silently writing a permanent record with a guessed
  // date, from a control that today just re-files a checklist, would also break
  // the current client.
  //
  // The implication runs one way and only one way: completing sets the checklist
  // to `done`, but marking a checklist `done` completes nothing.
  //
  // WHAT THE BODY MAY SAY: the historical facts, and nothing else. Provenance is
  // read from the checklist's own saved rows, and the title from the checklist
  // itself -- both inside the writing transaction, not here. A `sources` or
  // `title` field in the body is ignored.
  router.post("/:id/complete", (request, response) => {
    const checklistId = parsePositiveInt(request.params.id);

    if (checklistId === null) {
      response.status(400).json({
        error: "Checklist ID must be a positive number.",
      });
      return;
    }

    let performedOn;
    let odometerMiles;
    let outcome;
    let symptomId;

    // The N3.1 validators, reused rather than reimplemented. Two entry points
    // writing repair history must agree on what a valid date, odometer reading,
    // and outcome are; a second, subtly different copy here is how they would
    // stop agreeing.
    try {
      performedOn = normalizePerformedOn(request.body.performedOn);
      odometerMiles = normalizeOdometerMiles(request.body.odometerMiles);
      outcome = normalizeOutcome(request.body.outcome);
      symptomId = normalizeOptionalEntityId(request.body.symptomId, "Symptom ID");
    } catch (error) {
      response.status(400).json({
        error: error.message || "Invalid repair completion values.",
      });
      return;
    }

    try {
      const vehicleId = getVehicleId();

      // These two lookups exist ONLY to answer a bad request cleanly -- 404 for a
      // checklist that is not there, 400 for a symptom that is not. They are
      // deliberately NOT the source of anything that gets written: the service
      // re-reads the checklist and the symptom inside its own transaction and
      // takes the historical titles from there. A snapshot read out here could
      // be stale by the time the row is inserted, and passing one in would make
      // this route an authority on history that it has no lock to back up.
      if (!findChecklistForVehicle(vehicleId, checklistId)) {
        response.status(404).json({
          error: "Checklist not found.",
        });
        return;
      }

      if (symptomId !== null && !findSymptomForVehicle(vehicleId, symptomId)) {
        response.status(400).json({
          error: "Linked symptom does not exist.",
        });
        return;
      }

      const { created, repairHistory } = completeChecklistIntoHistory(vehicleId, checklistId, {
        performedOn,
        odometerMiles,
        outcome,
        summary: normalizeText(request.body.summary),
        followUp: normalizeText(request.body.followUp),
        symptomId,
      });

      // A repeated completion is answered, not failed: one checklist is one
      // repair, so the honest response to "complete this again" is the record it
      // already became. 200 rather than 201 because nothing was created.
      response.status(created ? 201 : 200).json({
        message: created
          ? "Repair recorded from your checklist."
          : "This checklist was already completed as a repair.",
        repairHistory,
        checklist: getChecklistForVehicle(vehicleId, checklistId),
        created,
      });
    } catch (error) {
      response.status(500).json({
        error: error.message || "Could not complete the checklist.",
      });
    }
  });

  router.get("/", (_request, response) => {
    try {
      const vehicleId = getVehicleId();
      const checklists = listChecklistsForVehicle(vehicleId);

      response.json({
        checklists,
        total: checklists.length,
      });
    } catch (error) {
      response.status(500).json({
        error: error.message || "Could not load repair checklists.",
      });
    }
  });

  router.get("/:id", (request, response) => {
    const checklistId = parsePositiveInt(request.params.id);

    if (checklistId === null) {
      response.status(400).json({
        error: "Checklist ID must be a positive number.",
      });
      return;
    }

    try {
      const vehicleId = getVehicleId();
      const checklist = getChecklistForVehicle(vehicleId, checklistId);

      if (!checklist) {
        response.status(404).json({
          error: "Checklist not found.",
        });
        return;
      }

      response.json({ checklist });
    } catch (error) {
      response.status(500).json({
        error: error.message || "Could not load checklist.",
      });
    }
  });

  router.post("/", (request, response) => {
    const title = normalizeText(request.body.title);
    const description = normalizeText(request.body.description);
    const notes = normalizeText(request.body.notes);

    if (!title) {
      response.status(400).json({
        error: "Title is required.",
      });
      return;
    }

    let status;

    try {
      status = normalizeStatus(request.body.status);
    } catch (error) {
      response.status(400).json({
        error: error.message || "Invalid checklist values.",
      });
      return;
    }

    try {
      const vehicleId = getVehicleId();
      const insertResult = db
        .prepare(`
          INSERT INTO repair_checklists (vehicle_id, title, status, description, notes)
          VALUES (?, ?, ?, ?, ?)
        `)
        .run(vehicleId, title, status, description, notes);

      const checklistId = Number(insertResult.lastInsertRowid);
      const checklist = getChecklistForVehicle(vehicleId, checklistId);

      response.status(201).json({
        message: "Checklist created.",
        checklist,
      });
    } catch (error) {
      response.status(500).json({
        error: error.message || "Could not create checklist.",
      });
    }
  });

  router.put("/:id", (request, response) => {
    const checklistId = parsePositiveInt(request.params.id);

    if (checklistId === null) {
      response.status(400).json({
        error: "Checklist ID must be a positive number.",
      });
      return;
    }

    try {
      const vehicleId = getVehicleId();
      const existingChecklist = db
        .prepare(`
          SELECT id, title, status, description, notes
          FROM repair_checklists
          WHERE id = ? AND vehicle_id = ?
        `)
        .get(checklistId, vehicleId);

      if (!existingChecklist) {
        response.status(404).json({
          error: "Checklist not found.",
        });
        return;
      }

      const title = hasOwnField(request.body, "title")
        ? normalizeText(request.body.title)
        : existingChecklist.title;
      const description = hasOwnField(request.body, "description")
        ? normalizeText(request.body.description)
        : existingChecklist.description || "";
      const notes = hasOwnField(request.body, "notes")
        ? normalizeText(request.body.notes)
        : existingChecklist.notes || "";

      if (!title) {
        response.status(400).json({
          error: "Title is required.",
        });
        return;
      }

      let status = existingChecklist.status || "planned";

      try {
        status = hasOwnField(request.body, "status")
          ? normalizeStatus(request.body.status)
          : normalizeStatus(existingChecklist.status);
      } catch (error) {
        response.status(400).json({
          error: error.message || "Invalid checklist values.",
        });
        return;
      }

      db.prepare(`
        UPDATE repair_checklists
        SET title = ?, status = ?, description = ?, notes = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND vehicle_id = ?
      `).run(title, status, description, notes, checklistId, vehicleId);

      const checklist = getChecklistForVehicle(vehicleId, checklistId);

      response.json({
        message: "Checklist updated.",
        checklist,
      });
    } catch (error) {
      response.status(500).json({
        error: error.message || "Could not update checklist.",
      });
    }
  });

  router.delete("/:id", (request, response) => {
    const checklistId = parsePositiveInt(request.params.id);

    if (checklistId === null) {
      response.status(400).json({
        error: "Checklist ID must be a positive number.",
      });
      return;
    }

    try {
      const vehicleId = getVehicleId();
      // Items are removed by the ON DELETE CASCADE foreign key.
      const deleteResult = db
        .prepare("DELETE FROM repair_checklists WHERE id = ? AND vehicle_id = ?")
        .run(checklistId, vehicleId);

      if (deleteResult.changes === 0) {
        response.status(404).json({
          error: "Checklist not found.",
        });
        return;
      }

      response.json({
        message: "Checklist deleted.",
      });
    } catch (error) {
      response.status(500).json({
        error: error.message || "Could not delete checklist.",
      });
    }
  });

  router.post("/:id/items", (request, response) => {
    const checklistId = parsePositiveInt(request.params.id);

    if (checklistId === null) {
      response.status(400).json({
        error: "Checklist ID must be a positive number.",
      });
      return;
    }

    const text = normalizeText(request.body.text);

    if (!text) {
      response.status(400).json({
        error: "Item text is required.",
      });
      return;
    }

    try {
      const vehicleId = getVehicleId();

      if (findChecklistId(vehicleId, checklistId) === null) {
        response.status(404).json({
          error: "Checklist not found.",
        });
        return;
      }

      // New items land at the end of the list.
      const nextSortRow = db
        .prepare(`
          SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_sort
          FROM repair_checklist_items
          WHERE checklist_id = ?
        `)
        .get(checklistId);

      db.prepare(`
        INSERT INTO repair_checklist_items (checklist_id, text, is_done, sort_order)
        VALUES (?, ?, 0, ?)
      `).run(checklistId, text, nextSortRow.next_sort);

      touchChecklist(checklistId);

      const checklist = getChecklistForVehicle(vehicleId, checklistId);

      response.status(201).json({
        message: "Checklist item added.",
        checklist,
      });
    } catch (error) {
      response.status(500).json({
        error: error.message || "Could not add checklist item.",
      });
    }
  });

  router.put("/:id/items/:itemId", (request, response) => {
    const checklistId = parsePositiveInt(request.params.id);
    const itemId = parsePositiveInt(request.params.itemId);

    if (checklistId === null || itemId === null) {
      response.status(400).json({
        error: "Checklist and item IDs must be positive numbers.",
      });
      return;
    }

    try {
      const vehicleId = getVehicleId();

      if (findChecklistId(vehicleId, checklistId) === null) {
        response.status(404).json({
          error: "Checklist not found.",
        });
        return;
      }

      const existingItem = db
        .prepare(`
          SELECT id, text, is_done
          FROM repair_checklist_items
          WHERE id = ? AND checklist_id = ?
        `)
        .get(itemId, checklistId);

      if (!existingItem) {
        response.status(404).json({
          error: "Checklist item not found.",
        });
        return;
      }

      const text = hasOwnField(request.body, "text")
        ? normalizeText(request.body.text)
        : existingItem.text;

      if (!text) {
        response.status(400).json({
          error: "Item text is required.",
        });
        return;
      }

      if (hasOwnField(request.body, "isDone") && typeof request.body.isDone !== "boolean") {
        response.status(400).json({
          error: "isDone must be a boolean (true or false).",
        });
        return;
      }

      const isDone = hasOwnField(request.body, "isDone")
        ? (request.body.isDone ? 1 : 0)
        : existingItem.is_done;

      db.prepare(`
        UPDATE repair_checklist_items
        SET text = ?, is_done = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND checklist_id = ?
      `).run(text, isDone, itemId, checklistId);

      touchChecklist(checklistId);

      const checklist = getChecklistForVehicle(vehicleId, checklistId);

      response.json({
        message: "Checklist item updated.",
        checklist,
      });
    } catch (error) {
      response.status(500).json({
        error: error.message || "Could not update checklist item.",
      });
    }
  });

  router.delete("/:id/items/:itemId", (request, response) => {
    const checklistId = parsePositiveInt(request.params.id);
    const itemId = parsePositiveInt(request.params.itemId);

    if (checklistId === null || itemId === null) {
      response.status(400).json({
        error: "Checklist and item IDs must be positive numbers.",
      });
      return;
    }

    try {
      const vehicleId = getVehicleId();

      if (findChecklistId(vehicleId, checklistId) === null) {
        response.status(404).json({
          error: "Checklist not found.",
        });
        return;
      }

      const deleteResult = db
        .prepare("DELETE FROM repair_checklist_items WHERE id = ? AND checklist_id = ?")
        .run(itemId, checklistId);

      if (deleteResult.changes === 0) {
        response.status(404).json({
          error: "Checklist item not found.",
        });
        return;
      }

      touchChecklist(checklistId);

      const checklist = getChecklistForVehicle(vehicleId, checklistId);

      response.json({
        message: "Checklist item deleted.",
        checklist,
      });
    } catch (error) {
      response.status(500).json({
        error: error.message || "Could not delete checklist item.",
      });
    }
  });

  router.post("/:id/items/:itemId/move", (request, response) => {
    const checklistId = parsePositiveInt(request.params.id);
    const itemId = parsePositiveInt(request.params.itemId);

    if (checklistId === null || itemId === null) {
      response.status(400).json({
        error: "Checklist and item IDs must be positive numbers.",
      });
      return;
    }

    let direction;

    try {
      direction = normalizeDirection(request.body.direction);
    } catch (error) {
      response.status(400).json({
        error: error.message || "Invalid move direction.",
      });
      return;
    }

    try {
      const vehicleId = getVehicleId();

      if (findChecklistId(vehicleId, checklistId) === null) {
        response.status(404).json({
          error: "Checklist not found.",
        });
        return;
      }

      const currentItem = db
        .prepare(`
          SELECT id, sort_order
          FROM repair_checklist_items
          WHERE id = ? AND checklist_id = ?
        `)
        .get(itemId, checklistId);

      if (!currentItem) {
        response.status(404).json({
          error: "Checklist item not found.",
        });
        return;
      }

      // The adjacent item in the requested direction. When there is none (already
      // at the top or bottom) the move is a no-op and the checklist is returned
      // unchanged.
      const neighborItem =
        direction === "up"
          ? db
              .prepare(`
                SELECT id, sort_order
                FROM repair_checklist_items
                WHERE checklist_id = ? AND sort_order < ?
                ORDER BY sort_order DESC, id DESC
                LIMIT 1
              `)
              .get(checklistId, currentItem.sort_order)
          : db
              .prepare(`
                SELECT id, sort_order
                FROM repair_checklist_items
                WHERE checklist_id = ? AND sort_order > ?
                ORDER BY sort_order ASC, id ASC
                LIMIT 1
              `)
              .get(checklistId, currentItem.sort_order);

      if (neighborItem) {
        swapItemOrder(currentItem, neighborItem);
        touchChecklist(checklistId);
      }

      const checklist = getChecklistForVehicle(vehicleId, checklistId);

      response.json({
        message: "Checklist item moved.",
        checklist,
      });
    } catch (error) {
      response.status(500).json({
        error: error.message || "Could not move checklist item.",
      });
    }
  });

  return router;
}

export const repairChecklistsRouter = createRepairChecklistsRouter();
