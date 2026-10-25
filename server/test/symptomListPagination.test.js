import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";

// Isolated database/uploads dir, set before importing anything that opens the
// SQLite connection (same pattern as documentListPagination.test.js). Every row
// below is synthetic: nothing here reads or resembles the owner's records.
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-symptom-list-"));

process.env.DATABASE_FILE = path.join(tempRoot, "test.db");
process.env.UPLOADS_DIR = path.join(tempRoot, "uploads");

fs.mkdirSync(process.env.UPLOADS_DIR, { recursive: true });

const { db } = await import("../src/database.js");
const { initializeDatabase } = await import("../src/initDatabase.js");
const { createApp } = await import("../src/app.js");
const { getSymptom, listSymptoms } = await import("../src/services/symptomService.js");

initializeDatabase();

const app = createApp();
const vehicleId = db.prepare("SELECT id FROM vehicles ORDER BY id ASC LIMIT 1").get().id;

const insertSymptom = db.prepare(`
  INSERT INTO symptoms (
    vehicle_id, title, description, system, suspected_causes, confidence, status,
    notes, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

function addSymptom({
  title,
  description = "",
  system = "Engine",
  suspectedCauses = "",
  confidence = "medium",
  status = "open",
  notes = "",
  updatedAt = "2026-01-01 12:00:00",
}) {
  return Number(
    insertSymptom.run(
      vehicleId,
      title,
      description,
      system,
      suspectedCauses,
      confidence,
      status,
      notes,
      updatedAt,
      updatedAt
    ).lastInsertRowid
  );
}

function addDocument(title) {
  return Number(
    db
      .prepare(`
        INSERT INTO documents (
          vehicle_id, title, original_filename, stored_filename, file_path, file_type,
          system, document_type, extraction_status
        ) VALUES (?, ?, ?, ?, ?, 'application/pdf', 'Brakes', 'Repair Manual', 'completed')
      `)
      .run(vehicleId, title, `${title}.pdf`, `${title}.pdf`, `uploads/${title}.pdf`)
      .lastInsertRowid
  );
}

function addProcedure(title, updatedAt = "2026-01-01 12:00:00") {
  return Number(
    db
      .prepare(`
        INSERT INTO procedures (vehicle_id, title, system, steps, created_at, updated_at)
        VALUES (?, ?, 'Brakes', 'Synthetic step.', ?, ?)
      `)
      .run(vehicleId, title, updatedAt, updatedAt).lastInsertRowid
  );
}

// 60 symptoms sharing ONE timestamp, so ordering has to fall back to the unique
// id tie-breaker -- the case where pages overlap or skip rows if that
// tie-breaker is missing. Statuses, confidences, and systems cycle.
const LIBRARY_SIZE = 60;
const ids = [];

for (let index = 1; index <= LIBRARY_SIZE; index += 1) {
  ids.push(
    addSymptom({
      title: `Fixture ${String(index).padStart(3, "0")}`,
      description: "Synthetic description.",
      system: ["Engine", "Brakes", "Cooling"][index % 3],
      confidence: ["low", "medium", "high"][index % 3],
      status: ["open", "monitoring", "resolved"][index % 3],
      notes: "Synthetic notes.",
    })
  );
}

// The default order puts the lowest id on the last page. Giving only that row a
// distinctive keyword proves a filter reaches past page one.
const lastPageId = ids[0];
db.prepare("UPDATE symptoms SET suspected_causes = ? WHERE id = ?").run(
  "Corroded caliper slide pin",
  lastPageId
);

const brakeDoc = addDocument("Synthetic brake manual");
const otherDoc = addDocument("Synthetic other manual");
const padProcedure = addProcedure("Synthetic pad swap");
db.prepare("INSERT INTO symptom_documents (symptom_id, document_id) VALUES (?, ?)").run(
  lastPageId,
  brakeDoc
);
db.prepare("INSERT INTO symptom_documents (symptom_id, document_id) VALUES (?, ?)").run(
  ids[1],
  otherDoc
);
db.prepare("INSERT INTO symptom_procedures (symptom_id, procedure_id) VALUES (?, ?)").run(
  lastPageId,
  padProcedure
);

async function getPage(query) {
  const response = await request(app).get(`/api/symptoms?${query}`);
  assert.equal(response.status, 200, response.text);
  return response.body;
}

function titlesOf(body) {
  return body.symptoms.map((symptom) => symptom.title);
}

test("without limit the list is unchanged: every symptom, ignoring filters", async () => {
  const response = await request(app).get("/api/symptoms?status=resolved&q=caliper");

  assert.equal(response.status, 200);
  assert.equal(response.body.symptoms.length, LIBRARY_SIZE);
  assert.equal(response.body.total, LIBRARY_SIZE);
  assert.deepEqual(Object.keys(response.body).sort(), ["symptoms", "total"]);
  assert.deepEqual(response.body.symptoms, listSymptoms(vehicleId));
});

test("pages walk the whole list once, in order, across a shared timestamp", async () => {
  const seen = [];

  for (let offset = 0; offset < LIBRARY_SIZE; offset += 25) {
    const body = await getPage(`limit=25&offset=${offset}`);
    assert.equal(body.total, LIBRARY_SIZE);
    assert.equal(body.matched, LIBRARY_SIZE);
    assert.equal(body.limit, 25);
    assert.equal(body.offset, offset);
    seen.push(...body.symptoms.map((symptom) => symptom.id));
  }

  // Newest first with every timestamp equal is highest id first, and no id is
  // repeated or skipped at the 25 and 50 boundaries.
  assert.deepEqual(seen, [...ids].reverse());
});

test("a page carries full symptoms for its own rows only", async () => {
  const body = await getPage("limit=25&offset=50");
  const last = body.symptoms.at(-1);

  assert.equal(body.symptoms.length, 10);
  assert.equal(last.id, lastPageId);
  assert.deepEqual(last, getSymptom(vehicleId, lastPageId));
  assert.deepEqual(last.linkedDocumentIds, [brakeDoc]);
  assert.deepEqual(last.linkedProcedureIds, [padProcedure]);
  // Links belong to their own symptom; narrowing never cross-attaches them.
  assert.deepEqual(
    body.symptoms.find((symptom) => symptom.id === ids[1]).linkedDocumentIds,
    [otherDoc]
  );
});

test("limit is capped, a bad limit falls back, and a page past the end is empty", async () => {
  assert.equal((await getPage("limit=1000")).symptoms.length, LIBRARY_SIZE);
  assert.equal((await getPage("limit=1000")).limit, 100);
  assert.equal((await getPage("limit=abc")).limit, 25);
  assert.equal((await getPage("limit=-5")).symptoms.length, 25);

  const pastEnd = await getPage("limit=25&offset=500");
  assert.deepEqual(pastEnd.symptoms, []);
  assert.equal(pastEnd.matched, LIBRARY_SIZE);
});

test("the keyword filter searches the whole list, not one page", async () => {
  const body = await getPage("limit=25&q=CALIPER%20slide");

  assert.equal(body.matched, 1);
  assert.deepEqual(
    body.symptoms.map((symptom) => symptom.id),
    [lastPageId]
  );
});

test("filters apply over every symptom and combine", async () => {
  const resolved = await getPage("limit=100&status=resolved");
  assert.equal(resolved.matched, 20);
  assert.ok(resolved.symptoms.every((symptom) => symptom.status === "resolved"));

  const active = await getPage("limit=100&status=active");
  assert.equal(active.matched, 40);
  assert.ok(active.symptoms.every((symptom) => symptom.status !== "resolved"));

  // index % 3 drives all three columns together, so Brakes is always medium
  // confidence and monitoring: the combination narrows to the same 20...
  const combined = await getPage("limit=100&system=Brakes&confidence=medium&status=monitoring");
  assert.equal(combined.matched, 20);
  // ...and one disagreeing filter empties it.
  const none = await getPage("limit=100&system=Brakes&confidence=low");
  assert.equal(none.matched, 0);
  assert.deepEqual(none.symptoms, []);

  // Filters never shrink the whole-list counts.
  assert.equal(none.total, LIBRARY_SIZE);
  assert.deepEqual(none.statusCounts, { open: 20, monitoring: 20, resolved: 20 });
});

test("unknown or repeated filter values are ignored instead of reaching a comparison", async () => {
  assert.equal((await getPage("limit=100&status=bogus")).matched, LIBRARY_SIZE);
  assert.equal((await getPage("limit=100&confidence=extreme")).matched, LIBRARY_SIZE);
  assert.equal((await getPage("limit=100&system=Brakes&system=Engine")).matched, LIBRARY_SIZE);
  assert.equal((await getPage("limit=100&sort=sideways")).symptoms[0].id, ids.at(-1));
});

test("the filter-options route lists every system once and is not read as an id", async () => {
  const response = await request(app).get("/api/symptoms/filter-options");

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { systems: ["Brakes", "Cooling", "Engine"] });
});

test("by-id lookups still answer from the full mapping, and 404 when missing", async () => {
  const response = await request(app).get(`/api/symptoms/${lastPageId}`);

  assert.equal(response.status, 200);
  assert.deepEqual(
    response.body.symptom,
    listSymptoms(vehicleId).find((symptom) => symptom.id === lastPageId)
  );
  assert.equal((await request(app).get("/api/symptoms/999999")).status, 404);
});

test("the paged search for procedures is bounded; without limit it is unchanged", async () => {
  for (let index = 1; index <= 30; index += 1) {
    addProcedure(`Paged procedure ${String(index).padStart(2, "0")}`, `2026-02-${String(index).padStart(2, "0")} 08:00:00`);
  }

  const unpaged = await request(app).get("/api/search/procedures");
  assert.equal(unpaged.status, 200);
  assert.equal(unpaged.body.results.length, 31);
  assert.equal(unpaged.body.total, 31);
  assert.equal(unpaged.body.hasMore, undefined);

  const first = await request(app).get("/api/search/procedures?limit=25");
  assert.equal(first.body.results.length, 25);
  assert.equal(first.body.total, 31);
  assert.equal(first.body.hasMore, true);
  // Same newest-first order the unpaged list (and the old /api/procedures) uses.
  assert.deepEqual(
    first.body.results.map((procedure) => procedure.id),
    unpaged.body.results.slice(0, 25).map((procedure) => procedure.id)
  );

  const second = await request(app).get("/api/search/procedures?limit=25&offset=25");
  assert.equal(second.body.results.length, 6);
  assert.equal(second.body.hasMore, false);

  const searched = await request(app).get("/api/search/procedures?limit=5&q=pad%20swap");
  assert.deepEqual(
    searched.body.results.map((procedure) => procedure.id),
    [padProcedure]
  );

  assert.equal((await request(app).get("/api/search/procedures?limit=500")).body.limit, 100);
});

// Sorting and the keyword's case rules on a small, separate vehicle-wide set.
// They run last and replace the fixture, so the earlier tests keep theirs.
test("sorting and keyword matching follow the page's old browser rules", async () => {
  db.prepare("DELETE FROM symptoms").run();

  const banana = addSymptom({ title: "banana", updatedAt: "2026-03-01 08:00:00" });
  const apple = addSymptom({ title: "Apple", updatedAt: "2026-03-03 08:00:00" });
  const eclair = addSymptom({ title: "Éclair", updatedAt: "2026-03-02 08:00:00" });
  const zebra = addSymptom({
    title: "Zebra",
    notes: "ÉTRIER grippé",
    updatedAt: "2026-03-02 08:00:00",
  });
  const blank = addSymptom({ title: "Blank status", status: "", updatedAt: "2026-02-01 08:00:00" });

  const idsOf = (body) => body.symptoms.map((symptom) => symptom.id);

  // localeCompare order, not byte order: "Éclair" sits with the E's, ahead of Z.
  assert.deepEqual(titlesOf(await getPage("limit=25&sort=title")), [
    "Apple",
    "banana",
    "Blank status",
    "Éclair",
    "Zebra",
  ]);
  // Equal timestamps keep the legacy order (highest id first) in both directions.
  assert.deepEqual(idsOf(await getPage("limit=25&sort=newest")), [apple, zebra, eclair, banana, blank]);
  assert.deepEqual(idsOf(await getPage("limit=25&sort=oldest")), [blank, banana, zebra, eclair, apple]);

  // Case folding is Unicode-aware, like the browser's toLowerCase.
  assert.deepEqual(idsOf(await getPage("limit=25&q=%C3%A9trier")), [zebra]);
  // The description was never part of the keyword search.
  addSymptom({ title: "Hidden", description: "only-in-description" });
  assert.equal((await getPage("limit=25&q=only-in-description")).matched, 0);

  // A blank status reads as open, in the counts and in the filter.
  const counts = await getPage("limit=25&status=open");
  assert.ok(idsOf(counts).includes(blank));
  assert.equal(counts.statusCounts.open, 6);
});
