import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";

// Isolated database/uploads dir, set before importing anything that opens the
// SQLite connection (same pattern as searchDocumentPagination.test.js). Every
// row below is synthetic: nothing here reads or resembles the owner's library.
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-doc-list-"));

process.env.DATABASE_FILE = path.join(tempRoot, "test.db");
process.env.UPLOADS_DIR = path.join(tempRoot, "uploads");

fs.mkdirSync(process.env.UPLOADS_DIR, { recursive: true });

const { db } = await import("../src/database.js");
const { initializeDatabase } = await import("../src/initDatabase.js");
const { createApp } = await import("../src/app.js");
const { setDocumentTags } = await import("../src/services/documentTagService.js");
const { listDocuments, countDocuments } = await import("../src/services/documentService.js");

initializeDatabase();

const app = createApp();
const vehicleId = db.prepare("SELECT id FROM vehicles ORDER BY id ASC LIMIT 1").get().id;

const insertDocument = db.prepare(`
  INSERT INTO documents (
    vehicle_id, title, original_filename, stored_filename, file_path, file_type,
    system, document_type, extraction_status, extracted_text,
    is_favorite, is_bookmarked, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

function addDocument({
  title,
  system = "Engine",
  documentType = "Repair Manual",
  favorite = 0,
  bookmarked = 0,
  createdAt = "2025-03-01 12:00:00",
  updatedAt = createdAt,
}) {
  return Number(
    insertDocument.run(
      vehicleId,
      title,
      `${title}.pdf`,
      `${title}.pdf`,
      `server/uploads/${title}.pdf`,
      "application/pdf",
      system,
      documentType,
      "completed",
      // Large enough that a payload carrying it would be obvious.
      "Extracted body text. ".repeat(200),
      favorite,
      bookmarked,
      createdAt,
      updatedAt
    ).lastInsertRowid
  );
}

// 130 documents. Every one shares a single timestamp so ordering has to fall back
// to the unique id tie-breaker -- the case where pages overlap or skip rows if
// that tie-breaker is missing. Systems cycle across three values; every 10th is a
// favorite, every 13th bookmarked; the 2nd and 3rd-from-last tag rows carry a
// mixed-case tag.
const LIBRARY_SIZE = 130;
const ids = [];

for (let index = 1; index <= LIBRARY_SIZE; index += 1) {
  ids.push(
    addDocument({
      title: `Fixture ${String(index).padStart(3, "0")}`,
      system: ["Engine", "Brakes", "Cooling"][index % 3],
      documentType: index % 2 === 0 ? "Repair Manual" : "Wiring Diagram",
      favorite: index % 10 === 0 ? 1 : 0,
      bookmarked: index % 13 === 0 ? 1 : 0,
    })
  );
}

// The default order is newest-id-first (every timestamp is shared), so the
// lowest id sits on the final page. Tagging it proves a filter reaches past
// page one; the highest id gets a second, differently-spelled tag.
const lastId = ids[0];
setDocumentTags(lastId, "Torque-Specs, Brakes");
setDocumentTags(ids[ids.length - 1], "torque-specs");

async function getDocuments(query = "") {
  const response = await request(app).get(`/api/documents${query}`);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body;
}

function idsOf(body) {
  return body.documents.map((document) => document.id);
}

test("paging walks the whole library with no overlap and no gaps", async () => {
  const seen = [];
  let pages = 0;

  for (let offset = 0; ; offset += 25) {
    const body = await getDocuments(`?limit=25&offset=${offset}`);
    pages += 1;

    assert.equal(body.total, LIBRARY_SIZE);
    assert.equal(body.matched, LIBRARY_SIZE);
    assert.equal(body.limit, 25);
    assert.equal(body.offset, offset);
    assert.ok(body.documents.length <= 25);

    if (body.documents.length === 0) {
      break;
    }

    seen.push(...idsOf(body));
  }

  assert.equal(pages, 7, "130 documents is 6 pages (5 full + 1 of 5) and an empty probe");
  assert.equal(seen.length, LIBRARY_SIZE);
  assert.equal(new Set(seen).size, LIBRARY_SIZE, "no document appears on two pages");
  assert.deepEqual([...seen].sort((a, b) => a - b), [...ids].sort((a, b) => a - b));
});

test("a page carries a bounded row count and never the extracted text", async () => {
  const body = await getDocuments("?limit=25");

  assert.equal(body.documents.length, 25);
  assert.equal(
    body.documents.some((document) => "extractedText" in document),
    false
  );
});

test("offset past the end is an empty page that still reports the totals", async () => {
  const body = await getDocuments("?limit=25&offset=100000");

  assert.deepEqual(body.documents, []);
  assert.equal(body.total, LIBRARY_SIZE);
  assert.equal(body.matched, LIBRARY_SIZE);
});

test("limit is clamped and unusable limit/offset values fall back", async () => {
  assert.equal((await getDocuments("?limit=100000")).limit, 200);
  assert.equal((await getDocuments("?limit=abc")).limit, 50);
  assert.equal((await getDocuments("?limit=-5")).limit, 50);
  assert.equal((await getDocuments("?limit=2.5")).limit, 50);

  for (const offset of ["abc", "-10", "1.5", "1e300"]) {
    const body = await getDocuments(`?limit=10&offset=${offset}`);
    assert.equal(body.offset, 0, `offset=${offset} reads as the first page`);
    assert.equal(body.documents.length, 10);
  }
});

test("a filter searches the whole library, not just the first page", async () => {
  // Only one document carries the "Brakes" tag, and under the default order it is
  // far beyond page one of a 25-row page.
  const everything = idsOf(await getDocuments(`?limit=${LIBRARY_SIZE}`));
  assert.ok(everything.indexOf(lastId) >= 100);

  const tagged = await getDocuments("?limit=25&tag=brakes");
  assert.deepEqual(idsOf(tagged), [lastId]);
  assert.equal(tagged.matched, 1);
  assert.equal(tagged.total, LIBRARY_SIZE);
});

test("tag filtering is case-insensitive and exact", async () => {
  const body = await getDocuments("?limit=25&tag=TORQUE-specs");
  assert.deepEqual(new Set(idsOf(body)), new Set([ids[ids.length - 1], lastId]));
  assert.equal(body.matched, 2);

  assert.equal((await getDocuments("?limit=25&tag=torque")).matched, 0);
});

test("system, type, favorite, and bookmark filters narrow the count and the rows together", async () => {
  const expectedSystem = ids.filter((_, i) => ["Engine", "Brakes", "Cooling"][(i + 1) % 3] === "Brakes");
  const system = await getDocuments(`?limit=200&system=Brakes`);
  assert.deepEqual(new Set(idsOf(system)), new Set(expectedSystem));
  assert.equal(system.matched, expectedSystem.length);

  const type = await getDocuments("?limit=200&documentType=Wiring%20Diagram");
  assert.equal(type.matched, LIBRARY_SIZE / 2);
  assert.ok(type.documents.every((d) => d.documentType === "Wiring Diagram"));

  const favorites = await getDocuments("?limit=200&favorite=true");
  assert.equal(favorites.matched, 13);
  assert.ok(favorites.documents.every((d) => d.isFavorite === true));

  const notFavorites = await getDocuments("?limit=200&favorite=false");
  assert.equal(notFavorites.matched, LIBRARY_SIZE - 13);
  assert.ok(notFavorites.documents.every((d) => d.isFavorite === false));

  const bookmarked = await getDocuments("?limit=200&bookmarked=true");
  assert.equal(bookmarked.matched, 10);
  const notBookmarked = await getDocuments("?limit=200&bookmarked=false");
  assert.equal(notBookmarked.matched, LIBRARY_SIZE - 10);
});

test("combined filters are ANDed, and paging a filtered set stays consistent", async () => {
  const query = "system=Cooling&documentType=Repair%20Manual&favorite=false";
  const full = await getDocuments(`?limit=200&${query}`);
  assert.ok(full.matched > 5);
  assert.ok(
    full.documents.every(
      (d) => d.system === "Cooling" && d.documentType === "Repair Manual" && !d.isFavorite
    )
  );

  const paged = [];
  for (let offset = 0; offset < full.matched; offset += 5) {
    const page = await getDocuments(`?limit=5&offset=${offset}&${query}`);
    assert.equal(page.matched, full.matched, "count is stable across pages");
    paged.push(...idsOf(page));
  }

  assert.deepEqual(paged, idsOf(full), "pages concatenate to the unpaged filtered list");
});

test("a filter that matches nothing is an empty page, not an error", async () => {
  const body = await getDocuments("?limit=25&system=Transmission");

  assert.deepEqual(body.documents, []);
  assert.equal(body.matched, 0);
  assert.equal(body.total, LIBRARY_SIZE);
});

test("unusable filter values apply no filter, and SQL in a value is only ever data", async () => {
  // Repeated keys parse as arrays in Express; they must not reach SQL binding.
  assert.equal((await getDocuments("?limit=25&system=Brakes&system=Engine")).matched, LIBRARY_SIZE);
  assert.equal((await getDocuments("?limit=25&favorite=maybe")).matched, LIBRARY_SIZE);
  assert.equal((await getDocuments("?limit=25&favorite=all")).matched, LIBRARY_SIZE);

  const injected = await getDocuments(
    `?limit=25&system=${encodeURIComponent("Engine' OR '1'='1")}`
  );
  assert.equal(injected.matched, 0);
  assert.equal(countDocuments(), LIBRARY_SIZE, "nothing was dropped or altered");
});

test("sorting orders the whole library, then pages it", async () => {
  // Own isolated rows would disturb the counts above, so sort is exercised
  // through the service on the filter that isolates a handful of rows.
  const a = addDocument({
    title: "sortcase zebra",
    system: "SortLab",
    createdAt: "2024-01-01 00:00:00",
    updatedAt: "2024-06-01 00:00:00",
  });
  // ISO spelling of an earlier instant than `a`'s update: a plain string compare
  // of "2024-05-..T" against "2024-06-.. " would still work, but an ISO "T" row
  // dated the same day as a space-form row is the case that mis-sorts as text.
  const b = addDocument({
    title: "Sortcase apple",
    system: "SortLab",
    createdAt: "2024-02-01 00:00:00",
    updatedAt: "2024-05-31T23:59:59.000Z",
  });
  const c = addDocument({
    title: "sortcase Mango",
    system: "SortLab",
    createdAt: "2024-03-01 00:00:00",
    updatedAt: "2024-06-01T00:00:01.000Z",
  });

  const sorted = async (sort) =>
    idsOf(await getDocuments(`?limit=25&system=SortLab&sort=${sort}`));

  // updated_at: b (May 31) < a (Jun 1 00:00:00) < c (Jun 1 00:00:01)
  assert.deepEqual(await sorted("newest"), [c, a, b]);
  assert.deepEqual(await sorted("oldest"), [b, a, c]);
  // Case-insensitive: apple, Mango, zebra.
  assert.deepEqual(await sorted("title_asc"), [b, c, a]);
  // An unknown sort keeps the legacy created-newest-first order.
  assert.deepEqual(await sorted("sideways"), [c, b, a]);

  // Sorting is applied before paging, so page two continues the same order.
  const first = await getDocuments("?limit=2&offset=0&system=SortLab&sort=oldest");
  const second = await getDocuments("?limit=2&offset=2&system=SortLab&sort=oldest");
  assert.deepEqual([...idsOf(first), ...idsOf(second)], [b, a, c]);

  db.prepare("DELETE FROM documents WHERE system = 'SortLab'").run();
});

// Real-library regression: Title A-Z used to be the browser's
// `localeCompare(..., { sensitivity: "base" })`, which puts symbol- and
// emoji-led titles ("❗️TSB ...") first and folds accents ("É" beside "E").
// SQLite's NOCASE compares UTF-8 bytes after folding ASCII case only, which put
// those four TSB titles on the LAST page and "Émile" after "zeta".
test("Title A-Z keeps the browser's ordering for symbols, digits, case, and accents", async () => {
  const add = (title, createdAt) => addDocument({ title, system: "TitleLab", createdAt });
  const zeta = add("zeta sensor", "2024-01-01 00:00:00");
  const emile = add("Émile bracket", "2024-01-01 00:00:00");
  const brake = add("Brake caliper", "2024-01-01 00:00:00");
  const apple = add("apple pump", "2024-01-01 00:00:00");
  const digits = add("260 Electrical", "2024-01-01 00:00:00");
  const tsb = add("❗️TSB Coolant", "2024-01-01 00:00:00");
  // Equal ignoring case: the tie falls back to the legacy order, newest created
  // first, exactly as the browser's stable sort over the legacy list did.
  const olderDelta = add("Delta valve", "2024-01-01 00:00:00");
  const newerDelta = add("delta Valve", "2024-02-01 00:00:00");

  const expected = [tsb, digits, apple, brake, newerDelta, olderDelta, emile, zeta];

  try {
    const onePage = await getDocuments("?limit=25&system=TitleLab&sort=title_asc");
    assert.equal(onePage.matched, expected.length);
    assert.deepEqual(idsOf(onePage), expected);

    // Sorted across the whole filtered set before paging: walking two at a time
    // gives the same order with no row repeated or skipped.
    const walked = [];
    for (let offset = 0; offset < expected.length; offset += 2) {
      walked.push(...idsOf(await getDocuments(`?limit=2&offset=${offset}&system=TitleLab&sort=title_asc`)));
    }
    assert.deepEqual(walked, expected);

    // The unpaged form honours the same sort.
    assert.deepEqual(idsOf(await getDocuments("?system=TitleLab&sort=title_asc")), expected);
  } finally {
    // Cleanup must run even when an assertion fails, or the extra rows leak
    // into every later test's library-size checks.
    db.prepare("DELETE FROM documents WHERE system = 'TitleLab'").run();
  }
});

test("with no limit the list is still the whole library in the legacy order", async () => {
  const body = await getDocuments();

  assert.equal(body.total, LIBRARY_SIZE);
  assert.equal(body.documents.length, LIBRARY_SIZE);
  assert.equal("limit" in body, false);
  assert.equal("offset" in body, false);
  // Shared timestamp, so the order is the id tie-breaker: descending.
  assert.deepEqual(idsOf(body), [...ids].reverse());
});

test("embeddingPending is decided for the page's own rows only", () => {
  // Both ids land on the first title_asc page ("Fixture 001", "Fixture 002").
  const [first, second] = ids;
  const chunk = db.prepare(`
    INSERT INTO document_chunks (document_id, page_number, chunk_index, chunk_text, embedding_version)
    VALUES (?, 1, 0, 'synthetic chunk', NULL)
  `);

  chunk.run(first);

  const page = listDocuments({ limit: 5, offset: 0, sort: "title_asc" });
  const flagged = new Map(page.map((document) => [document.id, document.embeddingPending]));

  assert.equal(flagged.get(first), true);
  assert.equal(flagged.get(second), false);

  // The unpaged call reports the same answer for the same document.
  assert.equal(listDocuments().find((d) => d.id === first).embeddingPending, true);

  db.prepare("DELETE FROM document_chunks WHERE document_id = ?").run(first);
});

test("filter-options lists every system, type, and tag in the whole library", async () => {
  const response = await request(app).get("/api/documents/filter-options");

  assert.equal(response.status, 200);
  assert.deepEqual(response.body.systems, ["Brakes", "Cooling", "Engine"]);
  assert.deepEqual(response.body.documentTypes, ["Repair Manual", "Wiring Diagram"]);
  assert.ok(response.body.tags.length >= 2);
});

test("GET /api/documents/:id returns one document in the list's shape", async () => {
  const response = await request(app).get(`/api/documents/${lastId}`);

  assert.equal(response.status, 200);
  assert.equal(response.body.document.id, lastId);
  assert.deepEqual(response.body.document.tags.sort(), ["Brakes", "Torque-Specs"]);
  assert.equal("extractedText" in response.body.document, false);

  const [listed] = (await getDocuments(`?limit=1&tag=brakes`)).documents;
  assert.deepEqual(response.body.document, listed);
});

test("GET /api/documents/:id is a 400 for a bad id and a 404 for a missing one", async () => {
  const bad = await request(app).get("/api/documents/abc");
  assert.equal(bad.status, 400);

  const missing = await request(app).get("/api/documents/9999999");
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error, "Document not found.");
});
