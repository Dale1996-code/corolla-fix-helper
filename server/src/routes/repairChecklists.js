import { Router } from "express";
import { db } from "../database.js";
import { getVehicleId } from "../services/vehicleService.js";
import { hasOwnField, normalizeText } from "../utils/text.js";
import { parsePositiveInt } from "../utils/http.js";

export const repairChecklistsRouter = Router();

// Normalize the parsed body to a plain object so handlers can read fields off it
// without a guard. A missing body, or a JSON scalar like `null`/`"x"`, otherwise
// left request.body undefined/non-object and threw a TypeError (surfacing as an
// HTML 500) before validation could return a clean JSON 400.
repairChecklistsRouter.use((request, _response, next) => {
  if (request.body === null || typeof request.body !== "object" || Array.isArray(request.body)) {
    request.body = {};
  }

  next();
});

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

function buildChecklist(row, items) {
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

  return checklistRows.map((row) =>
    buildChecklist(row, itemsByChecklist.get(row.id) || [])
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

  return buildChecklist(row, listItemsForChecklist(row.id));
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

repairChecklistsRouter.get("/", (_request, response) => {
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

repairChecklistsRouter.get("/:id", (request, response) => {
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

repairChecklistsRouter.post("/", (request, response) => {
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

repairChecklistsRouter.put("/:id", (request, response) => {
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

repairChecklistsRouter.delete("/:id", (request, response) => {
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

repairChecklistsRouter.post("/:id/items", (request, response) => {
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

repairChecklistsRouter.put("/:id/items/:itemId", (request, response) => {
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

repairChecklistsRouter.delete("/:id/items/:itemId", (request, response) => {
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

repairChecklistsRouter.post("/:id/items/:itemId/move", (request, response) => {
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
