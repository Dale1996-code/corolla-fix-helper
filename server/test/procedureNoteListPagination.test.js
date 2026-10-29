import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";

// N7 for Procedures and Notes: each list is filtered, ordered, and paged by the
// server with the rules those pages used to apply in the browser, so neither
// page downloads its whole collection. Every row below is synthetic.
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-procedure-note-list-"));

process.env.DATABASE_FILE = path.join(tempRoot, "test.db");
process.env.UPLOADS_DIR = path.join(tempRoot, "uploads");

fs.mkdirSync(process.env.UPLOADS_DIR, { recursive: true });

const { db } = await import("../src/database.js");
const { initializeDatabase } = await import("../src/initDatabase.js");
const { createApp } = await import("../src/app.js");

initializeDatabase();

const app = createApp();
const vehicleId = db.prepare("SELECT id FROM vehicles ORDER BY id ASC LIMIT 1").get().id;

after(() => {
  db.close();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

const insertProcedure = db.prepare(`
  INSERT INTO procedures (
    vehicle_id, title, system, difficulty, tools_needed, parts_needed, steps, notes,
    confidence, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

function addProcedure({
  title,
  system = "Brakes",
  difficulty = "beginner",
  tools = "",
  parts = "",
  steps = "",
  notes = "",
  confidence = "medium",
  updatedAt = "2026-01-01 12:00:00",
}) {
  return Number(
    insertProcedure.run(vehicleId, title, system, difficulty, tools, parts, steps, notes, confidence, updatedAt, updatedAt)
      .lastInsertRowid
  );
}

const insertNote = db.prepare(`
  INSERT INTO notes (
    vehicle_id, title, content, note_type, related_entity_type, related_entity_id,
    created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

function addNote({ title, noteType = "general", related = "none", relatedId = null, updatedAt }) {
  return Number(
    insertNote.run(vehicleId, title, "", noteType, related, relatedId, updatedAt, updatedAt).lastInsertRowid
  );
}

const titlesOf = (body, key) => body[key].map((record) => record.title);

// ---- Procedures ----

test("the procedure list pages in the page's order, and a page boundary repeats or skips nothing", async () => {
  for (let index = 1; index <= 31; index += 1) {
    addProcedure({
      title: `Procedure ${String(index).padStart(2, "0")}`,
      system: index % 2 ? "Brakes" : "Engine",
      updatedAt: `2026-02-${String(index % 28 || 28).padStart(2, "0")} 08:00:00`,
    });
  }

  const unpaged = await request(app).get("/api/procedures");
  assert.equal(unpaged.status, 200);
  assert.equal(unpaged.body.procedures.length, 31);
  assert.equal(unpaged.body.matched, undefined, "the unpaged answer keeps its old shape");

  const first = await request(app).get("/api/procedures?limit=25&sort=newest");
  const second = await request(app).get("/api/procedures?limit=25&offset=25&sort=newest");
  assert.equal(first.body.procedures.length, 25);
  assert.equal(second.body.procedures.length, 6);
  assert.equal(first.body.total, 31);
  assert.equal(first.body.matched, 31);
  assert.deepEqual(
    [...titlesOf(first.body, "procedures"), ...titlesOf(second.body, "procedures")],
    titlesOf(unpaged.body, "procedures"),
    "newest is the unpaged order: latest update, then highest id"
  );
  // A full page carries what the detail panel shows.
  assert.ok(Array.isArray(first.body.procedures[0].linkedDocuments));
  assert.ok(Array.isArray(first.body.procedures[0].linkedSymptoms));
});

test("the procedure filters and keyword match what the page matched in the browser", async () => {
  const stepsOnly = addProcedure({
    title: "Caliper slide service",
    system: "Suspension",
    difficulty: "advanced",
    confidence: "high",
    steps: "Clean and regrease the SLIDE PINS",
    updatedAt: "2026-03-05 08:00:00",
  });

  const bySteps = await request(app).get("/api/procedures?limit=25&q=slide%20pins");
  assert.deepEqual(bySteps.body.procedures.map((procedure) => procedure.id), [stepsOnly]);
  assert.equal(bySteps.body.matched, 1);
  assert.ok(bySteps.body.total > 1, "total counts every procedure, not the matches");

  const combined = await request(app).get(
    "/api/procedures?limit=25&system=Suspension&difficulty=advanced&confidence=high"
  );
  assert.deepEqual(combined.body.procedures.map((procedure) => procedure.id), [stepsOnly]);

  // An unknown difficulty or sort is no filter and the default order.
  const unknown = await request(app).get("/api/procedures?limit=100&difficulty=expert&sort=bogus");
  assert.equal(unknown.body.matched, unknown.body.total);

  assert.equal((await request(app).get("/api/procedures?limit=500")).body.limit, 100);
});

test("the procedure title sort is a person's order, and the System choices cover every procedure", async () => {
  db.prepare("DELETE FROM procedures").run();
  addProcedure({ title: "banana", system: "Électrique", updatedAt: "2026-03-01 08:00:00" });
  addProcedure({ title: "Éclair", system: "Brakes", updatedAt: "2026-03-02 08:00:00" });
  addProcedure({ title: "Apple", system: "Brakes", updatedAt: "2026-03-03 08:00:00" });

  const byTitle = await request(app).get("/api/procedures?limit=25&sort=title");
  assert.deepEqual(titlesOf(byTitle.body, "procedures"), ["Apple", "banana", "Éclair"]);

  const oldest = await request(app).get("/api/procedures?limit=25&sort=oldest");
  assert.deepEqual(titlesOf(oldest.body, "procedures"), ["banana", "Éclair", "Apple"]);

  const options = await request(app).get("/api/procedures/filter-options");
  assert.equal(options.status, 200);
  assert.deepEqual(options.body.systems, ["Brakes", "Électrique"]);
});

// ---- Notes ----

test("the note list pages, filters by type and link, and opens one note by id", async () => {
  const procedureId = addProcedure({ title: "Rotor swap", updatedAt: "2026-04-01 08:00:00" });
  const ids = [];

  for (let index = 1; index <= 30; index += 1) {
    ids.push(
      addNote({
        title: `Note ${String(index).padStart(2, "0")}`,
        noteType: index % 3 === 0 ? "reminder" : "observation",
        related: index % 5 === 0 ? "procedure" : "none",
        relatedId: index % 5 === 0 ? procedureId : null,
        updatedAt: `2026-05-${String(index).padStart(2, "0")} 08:00:00`,
      })
    );
  }

  const unpaged = await request(app).get("/api/notes");
  assert.equal(unpaged.body.notes.length, 30);
  assert.equal(unpaged.body.matched, undefined, "the unpaged answer keeps its old shape");

  const first = await request(app).get("/api/notes?limit=25");
  const second = await request(app).get("/api/notes?limit=25&offset=25");
  assert.deepEqual(
    [...titlesOf(first.body, "notes"), ...titlesOf(second.body, "notes")],
    titlesOf(unpaged.body, "notes")
  );
  assert.equal(first.body.total, 30);

  const oldest = await request(app).get("/api/notes?limit=3&sort=oldest");
  assert.deepEqual(titlesOf(oldest.body, "notes"), ["Note 01", "Note 02", "Note 03"]);

  const reminders = await request(app).get("/api/notes?limit=25&noteType=reminder");
  assert.equal(reminders.body.matched, 10);
  assert.ok(reminders.body.notes.every((note) => note.noteType === "reminder"));

  const linked = await request(app).get("/api/notes?limit=25&relatedEntityType=procedure");
  assert.equal(linked.body.matched, 6);
  assert.equal(linked.body.notes[0].linkedProcedure.title, "Rotor swap");

  const unlinked = await request(app).get("/api/notes?limit=25&relatedEntityType=none");
  assert.equal(unlinked.body.matched, 24);

  const options = await request(app).get("/api/notes/filter-options");
  assert.deepEqual(options.body.noteTypes, ["observation", "reminder"]);

  const one = await request(app).get(`/api/notes/${ids[4]}`);
  assert.equal(one.status, 200);
  assert.equal(one.body.note.title, "Note 05");
  assert.equal((await request(app).get("/api/notes/999999")).status, 404);
  assert.equal((await request(app).get("/api/notes/abc")).status, 400);
});
