import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";

// Isolated database/uploads dir, set before importing anything that opens the
// SQLite connection (same pattern as documentService.test.js).
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-search-page-"));

process.env.DATABASE_FILE = path.join(tempRoot, "test.db");
process.env.UPLOADS_DIR = path.join(tempRoot, "uploads");

fs.mkdirSync(process.env.UPLOADS_DIR, { recursive: true });

const { db } = await import("../src/database.js");
const { initializeDatabase } = await import("../src/initDatabase.js");
const { createApp } = await import("../src/app.js");
const {
  DOCUMENT_SEARCH_MAX_PAGE_SIZE,
  DOCUMENT_SEARCH_PAGE_SIZE,
  searchDocuments,
} = await import("../src/services/documentService.js");

initializeDatabase();

const app = createApp();

const TOTAL_DOCUMENTS = 240;
const MATCHING_TITLE_WORD = "pagefixture";

const vehicleId = db.prepare("SELECT id FROM vehicles ORDER BY id ASC LIMIT 1").get().id;

// Every document shares one created_at so ordering has to fall back to the
// unique id tie-breaker; without it, pages could overlap or skip rows.
const SHARED_TIMESTAMP = "2025-03-01 12:00:00";

const insertDocument = db.prepare(`
  INSERT INTO documents (
    vehicle_id, title, original_filename, stored_filename, file_path, file_type,
    system, document_type, notes, extracted_text, extraction_status,
    is_favorite, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

for (let index = 1; index <= TOTAL_DOCUMENTS; index += 1) {
  // Half the library is in Cooling, so the filtered total (120) differs from the
  // unfiltered total (240) and a count/filter mismatch would be visible.
  const system = index % 2 === 0 ? "Cooling" : "Brakes";

  insertDocument.run(
    vehicleId,
    `${MATCHING_TITLE_WORD} document ${String(index).padStart(4, "0")}`,
    `${MATCHING_TITLE_WORD}-${index}.pdf`,
    `${MATCHING_TITLE_WORD}-${index}.pdf`,
    `server/uploads/${MATCHING_TITLE_WORD}-${index}.pdf`,
    "application/pdf",
    system,
    "Reference",
    `Notes for ${index}.`,
    `Extracted body text for document ${index}. Torque spec details.`,
    "completed",
    index % 20 === 0 ? 1 : 0,
    SHARED_TIMESTAMP,
    SHARED_TIMESTAMP
  );
}

test("GET /api/search/documents returns one bounded default page, not the library", async () => {
  const response = await request(app).get("/api/search/documents");

  assert.equal(response.status, 200);
  assert.equal(response.body.results.length, DOCUMENT_SEARCH_PAGE_SIZE);
  assert.equal(response.body.total, TOTAL_DOCUMENTS);
  assert.equal(response.body.limit, DOCUMENT_SEARCH_PAGE_SIZE);
  assert.equal(response.body.offset, 0);
  assert.equal(response.body.hasMore, true);
  assert.ok(
    response.body.results.length < TOTAL_DOCUMENTS,
    "the default page must not contain the whole document library"
  );
});

test("GET /api/search/documents clamps a limit above the hard maximum", async () => {
  const response = await request(app).get("/api/search/documents").query({ limit: 100000 });

  assert.equal(response.status, 200);
  assert.equal(response.body.limit, DOCUMENT_SEARCH_MAX_PAGE_SIZE);
  assert.equal(response.body.results.length, DOCUMENT_SEARCH_MAX_PAGE_SIZE);
  assert.equal(response.body.total, TOTAL_DOCUMENTS);
});

test("GET /api/search/documents handles invalid pagination values safely", async () => {
  const badValues = ["-5", "0", "abc", "25.5", "", "1e999", "9007199254740993"];

  for (const value of badValues) {
    const response = await request(app)
      .get("/api/search/documents")
      .query({ limit: value, offset: value });

    assert.equal(response.status, 200, `limit/offset=${value} should not error`);
    assert.equal(
      response.body.limit,
      DOCUMENT_SEARCH_PAGE_SIZE,
      `limit=${value} should fall back to the default page size`
    );
    assert.equal(response.body.offset, 0, `offset=${value} should fall back to 0`);
    assert.equal(response.body.results.length, DOCUMENT_SEARCH_PAGE_SIZE);
  }
});

test("GET /api/search/documents pages past the end without error", async () => {
  const response = await request(app)
    .get("/api/search/documents")
    .query({ limit: 10, offset: TOTAL_DOCUMENTS + 500 });

  assert.equal(response.status, 200);
  assert.deepEqual(response.body.results, []);
  assert.equal(response.body.total, TOTAL_DOCUMENTS);
  assert.equal(response.body.hasMore, false);
});

test("successive document pages return non-overlapping records covering the library", async () => {
  const limit = 25;
  const seenIds = new Set();
  let offset = 0;
  let pages = 0;

  for (;;) {
    const response = await request(app)
      .get("/api/search/documents")
      .query({ limit, offset, sort: "title" });

    assert.equal(response.status, 200);
    assert.ok(response.body.results.length <= limit);

    for (const result of response.body.results) {
      assert.equal(seenIds.has(result.id), false, `document ${result.id} appeared on two pages`);
      seenIds.add(result.id);
    }

    pages += 1;
    assert.ok(pages < 50, "paging failed to terminate");

    if (!response.body.hasMore) {
      break;
    }

    offset += limit;
  }

  assert.equal(seenIds.size, TOTAL_DOCUMENTS, "paging must reach every document exactly once");
});

test("document ordering stays deterministic when records share the sort value", async () => {
  // Every fixture row shares created_at, so the "newest" sort is decided purely
  // by the id tie-breaker. Two independent reads of the same window must agree.
  const query = { limit: 30, offset: 60, sort: "newest" };

  const [first, second] = await Promise.all([
    request(app).get("/api/search/documents").query(query),
    request(app).get("/api/search/documents").query(query),
  ]);

  assert.deepEqual(
    first.body.results.map((result) => result.id),
    second.body.results.map((result) => result.id)
  );

  const ids = first.body.results.map((result) => result.id);
  const descending = [...ids].sort((left, right) => right - left);
  assert.deepEqual(ids, descending, "equal timestamps must break ties by descending id");

  // The title sort shares a leading value across every fixture row's prefix too;
  // it must also be stable and non-overlapping between adjacent pages.
  const [titlePage1, titlePage2] = await Promise.all([
    request(app).get("/api/search/documents").query({ limit: 20, offset: 0, sort: "title" }),
    request(app).get("/api/search/documents").query({ limit: 20, offset: 20, sort: "title" }),
  ]);

  const overlap = titlePage1.body.results
    .map((result) => result.id)
    .filter((id) => titlePage2.body.results.some((result) => result.id === id));

  assert.deepEqual(overlap, [], "adjacent title-sorted pages must not share rows");
});

test("the reported total matches the filters, not the unfiltered library", async () => {
  const coolingResponse = await request(app)
    .get("/api/search/documents")
    .query({ system: "Cooling", limit: 5 });

  assert.equal(coolingResponse.status, 200);
  assert.equal(coolingResponse.body.total, TOTAL_DOCUMENTS / 2);
  assert.equal(coolingResponse.body.results.length, 5);
  assert.ok(coolingResponse.body.results.every((result) => result.system === "Cooling"));

  // Walk the filtered result set: the number of rows actually reachable through
  // paging has to equal the total the count query reported.
  let reachable = 0;
  let offset = 0;

  for (;;) {
    const page = await request(app)
      .get("/api/search/documents")
      .query({ system: "Cooling", limit: 50, offset });

    assert.ok(page.body.results.every((result) => result.system === "Cooling"));
    reachable += page.body.results.length;

    if (!page.body.hasMore) {
      break;
    }

    offset += 50;
  }

  assert.equal(reachable, coolingResponse.body.total);
});

test("keyword and favorite filters keep the same semantics under pagination", async () => {
  const keyword = await request(app)
    .get("/api/search/documents")
    .query({ q: MATCHING_TITLE_WORD, limit: 10 });

  assert.equal(keyword.status, 200);
  assert.equal(keyword.body.total, TOTAL_DOCUMENTS);
  assert.equal(keyword.body.results.length, 10);
  assert.ok(
    keyword.body.results.every((result) => result.title.includes(MATCHING_TITLE_WORD))
  );

  const noMatches = await request(app)
    .get("/api/search/documents")
    .query({ q: "definitelynotinthelibrary" });

  assert.equal(noMatches.body.total, 0);
  assert.deepEqual(noMatches.body.results, []);
  assert.equal(noMatches.body.hasMore, false);

  const favorites = await request(app)
    .get("/api/search/documents")
    .query({ favorite: "true", limit: 5 });

  assert.equal(favorites.body.total, TOTAL_DOCUMENTS / 20);
  assert.ok(favorites.body.results.every((result) => result.isFavorite === true));

  const combined = await request(app)
    .get("/api/search/documents")
    .query({ q: MATCHING_TITLE_WORD, system: "Cooling", limit: 5 });

  assert.equal(combined.body.total, TOTAL_DOCUMENTS / 2);
  assert.ok(combined.body.results.every((result) => result.system === "Cooling"));
});

test("paged search results omit the large extracted text field", async () => {
  const response = await request(app).get("/api/search/documents").query({ limit: 5 });

  for (const result of response.body.results) {
    assert.equal(result.extractedText, undefined);
    assert.equal(result.extracted_text, undefined);
  }

  // The snippet the result card actually renders is still built server-side.
  assert.ok(response.body.results.every((result) => typeof result.snippet === "string"));
});

test("the legacy /api/search alias returns the same bounded page", async () => {
  const [legacy, documents] = await Promise.all([
    request(app).get("/api/search").query({ limit: 10, offset: 20 }),
    request(app).get("/api/search/documents").query({ limit: 10, offset: 20 }),
  ]);

  assert.equal(legacy.status, 200);
  assert.deepEqual(legacy.body, documents.body);
  assert.equal(legacy.body.results.length, 10);
  assert.equal(legacy.body.offset, 20);
});

test("searchDocuments clamps its own limit so no caller can read the whole library", () => {
  const huge = searchDocuments({ query: "", limit: 10000 });
  assert.equal(huge.results.length, DOCUMENT_SEARCH_MAX_PAGE_SIZE);
  assert.equal(huge.total, TOTAL_DOCUMENTS);

  const negative = searchDocuments({ query: "", limit: -1, offset: -7 });
  assert.equal(negative.results.length, DOCUMENT_SEARCH_PAGE_SIZE);
  assert.equal(negative.offset, 0);

  const defaulted = searchDocuments({ query: "" });
  assert.equal(defaulted.results.length, DOCUMENT_SEARCH_PAGE_SIZE);
  assert.equal(defaulted.hasMore, true);
});
