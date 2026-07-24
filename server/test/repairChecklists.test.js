import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import request from "supertest";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-fix-helper-checklists-"));

process.env.DATABASE_FILE = path.join(tempRoot, "test.db");
process.env.UPLOADS_DIR = path.join(tempRoot, "uploads");
process.env.OPENAI_API_KEY = "";
process.env.OCR_ENABLED = "false";

const { createApp } = await import("../src/app.js");
const { db } = await import("../src/database.js");

const app = createApp();

after(() => {
  if (typeof db.close === "function") {
    db.close();
  }

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("creates a repair checklist and lists it", async () => {
  const createResponse = await request(app).post("/api/repair-checklists").send({
    title: "Front brake job",
    status: "in_progress",
    description: "Replace front pads and rotors.",
    notes: "Torque caliper bolts to spec.",
  });

  assert.equal(createResponse.status, 201);

  const checklist = createResponse.body.checklist;
  assert.ok(checklist.id > 0);
  assert.equal(checklist.title, "Front brake job");
  assert.equal(checklist.status, "in_progress");
  assert.equal(checklist.description, "Replace front pads and rotors.");
  assert.equal(checklist.notes, "Torque caliper bolts to spec.");
  assert.deepEqual(checklist.items, []);
  assert.equal(checklist.itemCount, 0);
  assert.equal(checklist.doneItemCount, 0);

  const listResponse = await request(app).get("/api/repair-checklists");

  assert.equal(listResponse.status, 200);
  assert.ok(Array.isArray(listResponse.body.checklists));
  assert.ok(listResponse.body.checklists.some((entry) => entry.id === checklist.id));

  const fetchResponse = await request(app).get(`/api/repair-checklists/${checklist.id}`);
  assert.equal(fetchResponse.status, 200);
  assert.equal(fetchResponse.body.checklist.title, "Front brake job");
});

test("defaults status to planned and validates checklist input", async () => {
  const created = await request(app).post("/api/repair-checklists").send({ title: "Oil change" });
  assert.equal(created.status, 201);
  assert.equal(created.body.checklist.status, "planned");

  const missingTitle = await request(app)
    .post("/api/repair-checklists")
    .send({ description: "no title" });
  assert.equal(missingTitle.status, 400);
  assert.match(missingTitle.body.error, /Title is required/);

  const badStatus = await request(app)
    .post("/api/repair-checklists")
    .send({ title: "Bad status", status: "wip" });
  assert.equal(badStatus.status, 400);
  assert.match(badStatus.body.error, /Status must be/);
});

test("updates a checklist's status and fields, leaving omitted fields intact", async () => {
  const created = await request(app)
    .post("/api/repair-checklists")
    .send({ title: "Coolant flush", status: "planned", notes: "Original notes" });
  const id = created.body.checklist.id;

  const updated = await request(app)
    .put(`/api/repair-checklists/${id}`)
    .send({ status: "done", notes: "Used Toyota SLLC" });

  assert.equal(updated.status, 200);
  assert.equal(updated.body.checklist.status, "done");
  assert.equal(updated.body.checklist.notes, "Used Toyota SLLC");
  assert.equal(updated.body.checklist.title, "Coolant flush");

  const badStatus = await request(app)
    .put(`/api/repair-checklists/${id}`)
    .send({ status: "nope" });
  assert.equal(badStatus.status, 400);

  const missing = await request(app).put("/api/repair-checklists/999999").send({ title: "x" });
  assert.equal(missing.status, 404);
});

test("adds, checks off, edits, reorders, and deletes checklist items", async () => {
  const created = await request(app).post("/api/repair-checklists").send({ title: "Spark plugs" });
  const id = created.body.checklist.id;

  const addFirst = await request(app)
    .post(`/api/repair-checklists/${id}/items`)
    .send({ text: "Remove coils" });
  assert.equal(addFirst.status, 201);
  assert.equal(addFirst.body.checklist.items.length, 1);

  const firstItem = addFirst.body.checklist.items[0];
  assert.equal(firstItem.text, "Remove coils");
  assert.equal(firstItem.isDone, false);
  assert.equal(firstItem.sortOrder, 0);

  const addSecond = await request(app)
    .post(`/api/repair-checklists/${id}/items`)
    .send({ text: "Swap plugs" });
  assert.equal(addSecond.status, 201);
  assert.equal(addSecond.body.checklist.items.length, 2);

  const secondItem = addSecond.body.checklist.items[1];
  assert.equal(secondItem.sortOrder, 1);

  // Check off the first item.
  const checked = await request(app)
    .put(`/api/repair-checklists/${id}/items/${firstItem.id}`)
    .send({ isDone: true });
  assert.equal(checked.status, 200);
  assert.equal(
    checked.body.checklist.items.find((item) => item.id === firstItem.id).isDone,
    true
  );
  assert.equal(checked.body.checklist.doneItemCount, 1);

  // Edit the second item's text.
  const edited = await request(app)
    .put(`/api/repair-checklists/${id}/items/${secondItem.id}`)
    .send({ text: "Install new plugs" });
  assert.equal(edited.status, 200);
  assert.equal(
    edited.body.checklist.items.find((item) => item.id === secondItem.id).text,
    "Install new plugs"
  );

  // Reorder: move the second item up so it sorts first.
  const movedUp = await request(app)
    .post(`/api/repair-checklists/${id}/items/${secondItem.id}/move`)
    .send({ direction: "up" });
  assert.equal(movedUp.status, 200);
  assert.deepEqual(
    movedUp.body.checklist.items.map((item) => item.id),
    [secondItem.id, firstItem.id]
  );

  // Move it back down to the original order.
  const movedDown = await request(app)
    .post(`/api/repair-checklists/${id}/items/${secondItem.id}/move`)
    .send({ direction: "down" });
  assert.equal(movedDown.status, 200);
  assert.deepEqual(
    movedDown.body.checklist.items.map((item) => item.id),
    [firstItem.id, secondItem.id]
  );

  // Moving the top item up is a no-op, not an error.
  const noOp = await request(app)
    .post(`/api/repair-checklists/${id}/items/${firstItem.id}/move`)
    .send({ direction: "up" });
  assert.equal(noOp.status, 200);
  assert.deepEqual(
    noOp.body.checklist.items.map((item) => item.id),
    [firstItem.id, secondItem.id]
  );

  const badDirection = await request(app)
    .post(`/api/repair-checklists/${id}/items/${firstItem.id}/move`)
    .send({ direction: "sideways" });
  assert.equal(badDirection.status, 400);

  const emptyText = await request(app)
    .post(`/api/repair-checklists/${id}/items`)
    .send({ text: "   " });
  assert.equal(emptyText.status, 400);

  // Delete the first item.
  const deleted = await request(app).delete(
    `/api/repair-checklists/${id}/items/${firstItem.id}`
  );
  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.checklist.items.length, 1);
  assert.equal(deleted.body.checklist.items[0].id, secondItem.id);

  const missingItem = await request(app).delete(
    `/api/repair-checklists/${id}/items/${firstItem.id}`
  );
  assert.equal(missingItem.status, 404);
});

test("body-less requests return JSON 400, not an HTML 500", async () => {
  // With no body/content-type express.json() leaves request.body undefined, which
  // used to reach request.body.title and throw a TypeError, surfacing as an
  // unhandled HTML 500 instead of a clean validation error.
  const emptyCreate = await request(app).post("/api/repair-checklists");
  assert.equal(emptyCreate.status, 400);
  assert.match(emptyCreate.body.error, /Title is required/);

  const created = await request(app).post("/api/repair-checklists").send({ title: "Body guard" });
  const id = created.body.checklist.id;

  const emptyItem = await request(app).post(`/api/repair-checklists/${id}/items`);
  assert.equal(emptyItem.status, 400);
  assert.match(emptyItem.body.error, /Item text is required/);
});

test("isDone requires a real boolean and stores it faithfully", async () => {
  const created = await request(app).post("/api/repair-checklists").send({ title: "Boolean job" });
  const id = created.body.checklist.id;
  const added = await request(app)
    .post(`/api/repair-checklists/${id}/items`)
    .send({ text: "Toggle me" });
  const itemId = added.body.checklist.items[0].id;

  // A string "false" is truthy in JS; it must be rejected, not stored as done.
  const stringFalse = await request(app)
    .put(`/api/repair-checklists/${id}/items/${itemId}`)
    .send({ isDone: "false" });
  assert.equal(stringFalse.status, 400);
  assert.match(stringFalse.body.error, /isDone/);

  const setTrue = await request(app)
    .put(`/api/repair-checklists/${id}/items/${itemId}`)
    .send({ isDone: true });
  assert.equal(setTrue.status, 200);
  assert.equal(setTrue.body.checklist.items[0].isDone, true);

  const setFalse = await request(app)
    .put(`/api/repair-checklists/${id}/items/${itemId}`)
    .send({ isDone: false });
  assert.equal(setFalse.status, 200);
  assert.equal(setFalse.body.checklist.items[0].isDone, false);
});

test("item routes return 404 for an unknown checklist", async () => {
  const response = await request(app)
    .post("/api/repair-checklists/999999/items")
    .send({ text: "orphan item" });

  assert.equal(response.status, 404);
});

test("deletes a checklist and cascades its items", async () => {
  const created = await request(app).post("/api/repair-checklists").send({ title: "Throwaway job" });
  const id = created.body.checklist.id;

  await request(app).post(`/api/repair-checklists/${id}/items`).send({ text: "temp item" });

  const deleted = await request(app).delete(`/api/repair-checklists/${id}`);
  assert.equal(deleted.status, 200);

  const fetchAfter = await request(app).get(`/api/repair-checklists/${id}`);
  assert.equal(fetchAfter.status, 404);

  const remainingItems = db
    .prepare("SELECT COUNT(*) AS count FROM repair_checklist_items WHERE checklist_id = ?")
    .get(id);
  assert.equal(remainingItems.count, 0);

  const deleteAgain = await request(app).delete(`/api/repair-checklists/${id}`);
  assert.equal(deleteAgain.status, 404);
});
