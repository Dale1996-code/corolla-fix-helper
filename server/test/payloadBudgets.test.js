import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";

// N7 payload budgets. Every page that lists records asks for one bounded page,
// so what a visit costs must NOT grow with the library. These tests hold that
// line at two levels, on a synthetic library shaped like the owner's real one
// (1,443 documents, about 1.2 MiB when downloaded whole):
//
//   1. a page of rows is the same size at 1,500 documents as at 100 -- the
//      library can grow without a visit getting slower to download; and
//   2. every request a page makes when it opens stays under a fixed byte budget,
//      so a field added to a row has to come with a decision about the budget.
//
// What this does NOT gate: response time and import throughput. Both depend on
// the machine running the test, so a threshold here would be a coin flip; the
// roadmap's N7 item still lists them as unset.
//
// The numbers are bytes of JSON. The budgets leave headroom over today's sizes
// (printed on failure) -- raise one only on purpose, in the same change that
// makes a row bigger.
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-payload-budgets-"));

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

const KIB = 1024;
const PAGE = "limit=25&offset=0";

const insertDocument = db.prepare(`
  INSERT INTO documents (
    vehicle_id, title, original_filename, stored_filename, file_path, file_type,
    system, document_type, extraction_status, extracted_text, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, 'application/pdf', ?, ?, 'completed', ?, ?, ?)
`);
const insertSymptom = db.prepare(`
  INSERT INTO symptoms (
    vehicle_id, title, description, system, suspected_causes, confidence, status, notes,
    created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, 'medium', 'open', ?, ?, ?)
`);
const insertProcedure = db.prepare(`
  INSERT INTO procedures (
    vehicle_id, title, system, difficulty, tools_needed, parts_needed, safety_notes, steps,
    notes, confidence, created_at, updated_at
  ) VALUES (?, ?, ?, 'intermediate', ?, ?, ?, ?, ?, 'medium', ?, ?)
`);
const insertNote = db.prepare(`
  INSERT INTO notes (
    vehicle_id, title, content, note_type, related_entity_type, related_entity_id,
    created_at, updated_at
  ) VALUES (?, ?, ?, ?, 'none', NULL, ?, ?)
`);

// A realistic row: long enough text fields that a page of them has real weight,
// but all synthetic.
const SENTENCE = "Remove the cover, inspect the part for wear, and refit it with new fasteners. ";
const stamp = (index) => `2026-01-${String((index % 28) + 1).padStart(2, "0")} ${String(index % 24).padStart(2, "0")}:00:00`;

function addLibrary({ from, to }) {
  db.exec("BEGIN");

  for (let index = from; index < to; index += 1) {
    const label = String(index).padStart(4, "0");
    const at = stamp(index);

    insertDocument.run(
      vehicleId, `Manual ${label} brakes`, `manual-${label}.pdf`, `manual-${label}.pdf`,
      `uploads/manual-${label}.pdf`, index % 2 ? "Brakes" : "Engine", "Repair Manual",
      SENTENCE.repeat(50), at, at
    );
    insertSymptom.run(vehicleId, `Symptom ${label}`, SENTENCE.repeat(2), "Engine", SENTENCE, SENTENCE, at, at);
    insertProcedure.run(
      vehicleId, `Procedure ${label}`, index % 2 ? "Brakes" : "Engine", SENTENCE, SENTENCE,
      SENTENCE, SENTENCE.repeat(8), SENTENCE.repeat(2), at, at
    );
    insertNote.run(vehicleId, `Note ${label}`, SENTENCE.repeat(3), index % 2 ? "reminder" : "observation", at, at);
  }

  db.exec("COMMIT");
}

// Every request a page makes when it opens on its first page, by page. The
// document picker is the one the link forms share.
const PAGE_LOADS = {
  Documents: [`/api/documents?${PAGE}&sort=newest`, "/api/documents/filter-options"],
  Symptoms: [
    `/api/symptoms?${PAGE}&sort=newest`,
    "/api/symptoms/filter-options",
    `/api/search/documents?${PAGE}`,
    `/api/search/procedures?${PAGE}`,
  ],
  Procedures: [
    `/api/procedures?${PAGE}&sort=newest`,
    "/api/procedures/filter-options",
    `/api/search/documents?${PAGE}`,
    `/api/search/symptoms?${PAGE}`,
  ],
  // Nothing is fetched for a link picker until a link type is chosen.
  Notes: [`/api/notes?${PAGE}&sort=newest`, "/api/notes/filter-options"],
  "Notes, with Document chosen": [
    `/api/notes?${PAGE}&sort=newest`,
    "/api/notes/filter-options",
    `/api/search/documents?${PAGE}`,
  ],
};

// Total bytes a visit may download, per page, on this synthetic library: about
// 1.5x what each page measured when the budgets were set (2026-10-28: Documents
// 12.3 KiB, Symptoms 66.9, Procedures 66.6, Notes 11.9, Notes with a Document
// link chosen 29.5). Tight enough that a field added to every row, or a request
// a page did not make before, trips it. The failure message prints each
// request's size.
const PAGE_BUDGET_KIB = {
  Documents: 20,
  Symptoms: 100,
  Procedures: 100,
  Notes: 20,
  "Notes, with Document chosen": 45,
};

async function measure(urls) {
  const sizes = {};

  for (const url of urls) {
    const response = await request(app).get(url);
    assert.equal(response.status, 200, url);
    sizes[url] = Buffer.byteLength(response.text);
  }

  return sizes;
}

const total = (sizes) => Object.values(sizes).reduce((sum, bytes) => sum + bytes, 0);

test("a page of rows is no bigger in a library fifteen times the size", async () => {
  addLibrary({ from: 0, to: 100 });
  const small = {};
  for (const [page, urls] of Object.entries(PAGE_LOADS)) small[page] = await measure(urls);

  addLibrary({ from: 100, to: 1500 });
  const large = {};
  for (const [page, urls] of Object.entries(PAGE_LOADS)) large[page] = await measure(urls);

  for (const page of Object.keys(PAGE_LOADS)) {
    for (const url of PAGE_LOADS[page]) {
      // The filter choices may list a few more values, and a page's own "total"
      // gains digits; nothing else may grow.
      const allowed = Math.ceil(small[page][url] * 1.05) + 64;

      assert.ok(
        large[page][url] <= allowed,
        `${page}: ${url} grew from ${small[page][url]} to ${large[page][url]} bytes ` +
          `(allowed ${allowed}) as the library went from 100 to 1,500 records`
      );
    }
  }
});

test("every page opens within its payload budget on a library the size of the owner's", async () => {
  // The library from the previous test is still in the database: 1,500 of each.
  const counts = db
    .prepare(
      "SELECT (SELECT COUNT(*) FROM documents) AS documents, (SELECT COUNT(*) FROM procedures) AS procedures, " +
        "(SELECT COUNT(*) FROM notes) AS notes, (SELECT COUNT(*) FROM symptoms) AS symptoms"
    )
    .get();
  assert.ok(counts.documents >= 1443, "the synthetic library is smaller than the owner's");

  for (const [page, urls] of Object.entries(PAGE_LOADS)) {
    const sizes = await measure(urls);
    const used = total(sizes);
    const budget = PAGE_BUDGET_KIB[page] * KIB;

    assert.ok(
      used <= budget,
      `${page} downloaded ${(used / KIB).toFixed(1)} KiB, over its ${PAGE_BUDGET_KIB[page]} KiB budget: ` +
        JSON.stringify(Object.fromEntries(Object.entries(sizes).map(([url, bytes]) => [url, bytes])))
    );
  }
});

test("a requested page never carries more rows than the page size, whatever the library holds", async () => {
  const lists = [
    ["/api/documents", "documents"],
    ["/api/symptoms", "symptoms"],
    ["/api/procedures", "procedures"],
    ["/api/notes", "notes"],
    ["/api/search/documents", "results"],
    ["/api/search/symptoms", "results"],
    ["/api/search/procedures", "results"],
  ];

  for (const [url, key] of lists) {
    const defaultPage = await request(app).get(`${url}?limit=25`);
    assert.ok(defaultPage.body[key].length <= 25, `${url} returned ${defaultPage.body[key].length} rows for limit=25`);

    // A client cannot ask for the whole library by naming a huge page.
    const huge = await request(app).get(`${url}?limit=1000000`);
    assert.ok(huge.body[key].length <= 200, `${url} let a client page of ${huge.body[key].length} rows through`);
  }
});

test("the unpaged whole-library answers still exist, and are what the budgets exist to avoid", async () => {
  // Documented for API clients and the smoke test, and no page asks for them.
  // The size is asserted so that anyone tempted to bring one back sees the cost.
  const whole = await request(app).get("/api/documents");
  const page = await request(app).get(`/api/documents?${PAGE}&sort=newest`);

  assert.equal(whole.status, 200);
  assert.ok(whole.body.documents.length >= 1443);
  assert.ok(
    Buffer.byteLength(whole.text) > 40 * Buffer.byteLength(page.text),
    "the whole-library answer is no longer meaningfully bigger than a page"
  );
});
