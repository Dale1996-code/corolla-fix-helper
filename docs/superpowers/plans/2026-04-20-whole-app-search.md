# Whole-App Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand the Search page from document-only search into one page with separate search sections for documents, symptoms, procedures, and notes.

**Architecture:** Keep the current document search behavior but move it behind `/api/search/documents`, then add three parallel entity-specific search endpoints for symptoms, procedures, and notes. Rebuild `client/src/pages/SearchPage.jsx` into a four-section page where each section owns its own state, filters, loading, errors, and result list, and reuses existing deep-link routing into the entity pages.

**Tech Stack:** Node.js, Express, SQLite, React, Vite, Vitest, React Testing Library, Node test runner, supertest.

---

### Task 1: Add failing server tests for whole-app search endpoints

**Files:**
- Modify: `server/test/app.test.js`
- Test: `server/test/app.test.js`

- [ ] **Step 1: Write the failing test**

Add these tests near the end of `server/test/app.test.js`:

```js
test("search endpoints return separate entity results and filters", async () => {
  const vehicle = db.prepare("SELECT id FROM vehicles ORDER BY id ASC LIMIT 1").get();

  const documentId = Number(
    db.prepare(`
      INSERT INTO documents (
        vehicle_id,
        title,
        original_filename,
        stored_filename,
        file_path,
        file_type,
        system,
        document_type,
        notes,
        extracted_text
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      vehicle.id,
      "Throttle body reference",
      "throttle-body.pdf",
      "throttle-body-copy.pdf",
      "C:/temp/throttle-body.pdf",
      "application/pdf",
      "Engine",
      "Reference",
      "Use this when checking idle airflow.",
      "Throttle body cleaning and airflow checks."
    ).lastInsertRowid
  );

  const symptomId = Number(
    db.prepare(`
      INSERT INTO symptoms (
        vehicle_id,
        title,
        description,
        system,
        suspected_causes,
        status,
        notes
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      vehicle.id,
      "Idle flare on cold start",
      "RPM jumps for a few seconds.",
      "Engine",
      "Dirty throttle body",
      "monitoring",
      "Happens after sitting overnight."
    ).lastInsertRowid
  );

  const procedureId = Number(
    db.prepare(`
      INSERT INTO procedures (
        vehicle_id,
        title,
        system,
        difficulty,
        tools_needed,
        steps,
        notes
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      vehicle.id,
      "Throttle body cleaning",
      "Engine",
      "beginner",
      "10mm socket, rag",
      "Remove intake tube and clean the throttle plate.",
      "Do not force the plate too hard."
    ).lastInsertRowid
  );

  const noteResponse = await request(app)
    .post("/api/notes")
    .send({
      title: "Cold-start idle note",
      content: "Idle settles after throttle body cleaning.",
      noteType: "observation",
      relatedEntityType: "symptom",
      relatedEntityId: symptomId,
    });

  assert.equal(noteResponse.status, 201);

  const [documentsResponse, symptomsResponse, proceduresResponse, notesResponse] =
    await Promise.all([
      request(app).get("/api/search/documents").query({ q: "throttle" }),
      request(app).get("/api/search/symptoms").query({ q: "idle", status: "monitoring" }),
      request(app).get("/api/search/procedures").query({ q: "cleaning", difficulty: "beginner" }),
      request(app).get("/api/search/notes").query({ q: "idle", relatedEntityType: "symptom" }),
    ]);

  assert.equal(documentsResponse.status, 200);
  assert.equal(symptomsResponse.status, 200);
  assert.equal(proceduresResponse.status, 200);
  assert.equal(notesResponse.status, 200);

  assert.ok(documentsResponse.body.results.some((result) => result.id === documentId));
  assert.ok(symptomsResponse.body.results.some((result) => result.id === symptomId));
  assert.ok(proceduresResponse.body.results.some((result) => result.id === procedureId));
  assert.ok(notesResponse.body.results.some((result) => result.title === "Cold-start idle note"));

  assert.ok(Array.isArray(documentsResponse.body.filters.systems));
  assert.ok(Array.isArray(symptomsResponse.body.filters.systems));
  assert.ok(Array.isArray(proceduresResponse.body.filters.difficulties));
  assert.ok(Array.isArray(notesResponse.body.filters.noteTypes));
});

test("legacy /api/search stays compatible as document search", async () => {
  const response = await request(app).get("/api/search").query({ q: "sample" });

  assert.equal(response.status, 200);
  assert.ok(Array.isArray(response.body.results));
  assert.ok("filters" in response.body);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
npm run test:server
```

Expected: FAIL because `/api/search/documents`, `/api/search/symptoms`, `/api/search/procedures`, and `/api/search/notes` do not exist yet.

- [ ] **Step 3: Write minimal implementation**

Do not implement yet in this task. The failure proves the missing endpoint behavior.

- [ ] **Step 4: Run test to verify it fails correctly**

Run:

```powershell
npm run test:server
```

Expected: FAIL with route-missing or payload-shape failures that point to the new endpoints.

- [ ] **Step 5: Commit**

```bash
git add server/test/app.test.js
git commit -m "test: cover whole-app search endpoints"
```

### Task 2: Add failing client test for the new Search page sections

**Files:**
- Create: `client/src/pages/SearchPage.test.jsx`
- Test: `client/src/pages/SearchPage.test.jsx`

- [ ] **Step 1: Write the failing test**

Create `client/src/pages/SearchPage.test.jsx` with:

```jsx
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
import { SearchPage } from "./SearchPage";

function jsonResponse(payload, ok = true) {
  return Promise.resolve({
    ok,
    json: async () => payload,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("SearchPage renders separate sections and searches them independently", async () => {
  const fetchMock = vi.fn((url) => {
    if (url.startsWith("/api/search/documents")) {
      return jsonResponse({
        results: [
          {
            id: 1,
            title: "Throttle body reference",
            originalFilename: "throttle-body.pdf",
            system: "Engine",
            documentType: "Reference",
            source: "Manual",
            pageCount: 2,
            extractionStatus: "completed",
            storedFilename: "throttle-body-copy.pdf",
            vehicleLabel: "2009 Toyota Corolla LE",
            isFavorite: false,
            snippet: "Throttle body cleaning and airflow checks.",
            snippetField: "Extracted text",
          },
        ],
        total: 1,
        filters: { systems: ["Engine"], documentTypes: ["Reference"] },
      });
    }

    if (url.startsWith("/api/search/symptoms")) {
      return jsonResponse({
        results: [
          {
            id: 21,
            title: "Idle flare on cold start",
            system: "Engine",
            status: "monitoring",
            confidence: "medium",
            linkedDocumentCount: 1,
            snippet: "RPM jumps for a few seconds.",
            snippetField: "Description",
          },
        ],
        total: 1,
        filters: { systems: ["Engine"], statuses: ["monitoring"] },
      });
    }

    if (url.startsWith("/api/search/procedures")) {
      return jsonResponse({
        results: [],
        total: 0,
        filters: { systems: ["Engine"], difficulties: ["beginner"] },
      });
    }

    if (url.startsWith("/api/search/notes")) {
      return jsonResponse({
        results: [
          {
            id: 31,
            title: "Cold-start idle note",
            noteType: "observation",
            relatedEntityType: "symptom",
            relatedEntityId: 21,
            linkedTitle: "Idle flare on cold start",
            snippet: "Idle settles after throttle body cleaning.",
            snippetField: "Content",
          },
        ],
        total: 1,
        filters: {
          noteTypes: ["observation"],
          relatedEntityTypes: ["symptom"],
        },
      });
    }

    throw new Error(`Unexpected fetch call: ${url}`);
  });

  vi.stubGlobal("fetch", fetchMock);

  render(
    <MemoryRouter initialEntries={["/search"]}>
      <SearchPage />
    </MemoryRouter>
  );

  expect(await screen.findByRole("heading", { name: "Documents" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Symptoms" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Procedures" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Notes" })).toBeInTheDocument();

  const searchInputs = screen.getAllByRole("textbox", { name: /keyword/i });
  fireEvent.change(searchInputs[1], { target: { value: "idle" } });

  const searchButtons = screen.getAllByRole("button", { name: "Search" });
  fireEvent.click(searchButtons[1]);

  await waitFor(() => {
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/search/symptoms?q=idle"),
      undefined
    );
  });

  expect(screen.getByRole("link", { name: "Open symptom Idle flare on cold start" })).toHaveAttribute(
    "href",
    "/symptoms?symptomId=21"
  );
  expect(screen.getByRole("link", { name: "Open note Cold-start idle note" })).toHaveAttribute(
    "href",
    "/notes?noteId=31"
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
npm run test:client
```

Expected: FAIL because the current `SearchPage.jsx` only renders document search.

- [ ] **Step 3: Write minimal implementation**

Do not implement yet in this task. The failure proves the client still uses the old page shape.

- [ ] **Step 4: Run test to verify it fails correctly**

Run:

```powershell
npm run test:client
```

Expected: FAIL with missing headings, controls, or links for the new sections.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/SearchPage.test.jsx
git commit -m "test: cover multi-section search page"
```

### Task 3: Implement symptom, procedure, and note search helpers on the server

**Files:**
- Create: `server/src/services/searchService.js`
- Modify: `server/src/routes/search.js`
- Test: `server/test/app.test.js`

- [ ] **Step 1: Write the failing test**

Use the Task 1 tests already added. No new test code is needed here.

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
npm run test:server
```

Expected: FAIL because the entity-specific search helpers and routes are still missing.

- [ ] **Step 3: Write minimal implementation**

Create `server/src/services/searchService.js` with:

```js
import { db } from "../database.js";

function buildSnippet(text, query) {
  const cleanText = typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";

  if (!cleanText) {
    return "";
  }

  if (!query) {
    return cleanText.length > 180 ? `${cleanText.slice(0, 177)}...` : cleanText;
  }

  const loweredText = cleanText.toLowerCase();
  const loweredQuery = query.toLowerCase();
  const matchIndex = loweredText.indexOf(loweredQuery);

  if (matchIndex === -1) {
    return cleanText.length > 180 ? `${cleanText.slice(0, 177)}...` : cleanText;
  }

  const start = Math.max(0, matchIndex - 80);
  const end = Math.min(cleanText.length, matchIndex + loweredQuery.length + 80);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < cleanText.length ? "..." : "";

  return `${prefix}${cleanText.slice(start, end).trim()}${suffix}`;
}

function buildMatchSnippet(fields, query) {
  if (!query) {
    const previewField = fields.find((field) => field.value.trim());
    return {
      snippet: previewField ? buildSnippet(previewField.value, "") : "",
      snippetField: previewField ? previewField.label : "",
    };
  }

  const loweredQuery = query.toLowerCase();
  const matchingField = fields.find((field) => field.value.toLowerCase().includes(loweredQuery));

  if (!matchingField) {
    return {
      snippet: "",
      snippetField: "",
    };
  }

  return {
    snippet: buildSnippet(matchingField.value, query),
    snippetField: matchingField.label,
  };
}

export function searchSymptoms({ query = "", system = "", status = "", sort = "newest" }) {
  const trimmedQuery = query.trim();
  const searchPattern = `%${trimmedQuery.toLowerCase()}%`;
  const whereClauses = [];
  const params = [];

  if (trimmedQuery) {
    whereClauses.push(`(
      lower(symptoms.title) LIKE ?
      OR lower(COALESCE(symptoms.description, '')) LIKE ?
      OR lower(COALESCE(symptoms.system, '')) LIKE ?
      OR lower(COALESCE(symptoms.suspected_causes, '')) LIKE ?
      OR lower(COALESCE(symptoms.notes, '')) LIKE ?
    )`);
    params.push(searchPattern, searchPattern, searchPattern, searchPattern, searchPattern);
  }

  if (system) {
    whereClauses.push("symptoms.system = ?");
    params.push(system);
  }

  if (status) {
    whereClauses.push("symptoms.status = ?");
    params.push(status);
  }

  const whereSql = whereClauses.length ? `WHERE ${whereClauses.join(" AND ")}` : "";
  const sortSql =
    sort === "oldest"
      ? "ORDER BY symptoms.created_at ASC, symptoms.id ASC"
      : sort === "title"
        ? "ORDER BY symptoms.title COLLATE NOCASE ASC, symptoms.updated_at DESC"
        : "ORDER BY symptoms.updated_at DESC, symptoms.id DESC";

  const rows = db.prepare(`
    SELECT
      symptoms.id,
      symptoms.title,
      symptoms.description,
      symptoms.system,
      symptoms.suspected_causes,
      symptoms.status,
      symptoms.confidence,
      symptoms.notes,
      symptoms.created_at,
      symptoms.updated_at,
      COUNT(symptom_documents.document_id) AS linked_document_count
    FROM symptoms
    LEFT JOIN symptom_documents ON symptom_documents.symptom_id = symptoms.id
    ${whereSql}
    GROUP BY symptoms.id
    ${sortSql}
  `).all(...params);

  return rows.map((row) => {
    const matchSnippet = buildMatchSnippet(
      [
        { label: "Title", value: row.title || "" },
        { label: "Description", value: row.description || "" },
        { label: "Suspected causes", value: row.suspected_causes || "" },
        { label: "Notes", value: row.notes || "" },
      ],
      trimmedQuery
    );

    return {
      id: row.id,
      title: row.title,
      system: row.system || "",
      status: row.status || "open",
      confidence: row.confidence || "medium",
      notes: row.notes || "",
      suspectedCauses: row.suspected_causes || "",
      linkedDocumentCount: Number(row.linked_document_count || 0),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      snippet: matchSnippet.snippet,
      snippetField: matchSnippet.snippetField,
    };
  });
}

export function getSymptomSearchFilters() {
  return {
    systems: db.prepare(`
      SELECT DISTINCT system
      FROM symptoms
      WHERE system IS NOT NULL AND TRIM(system) <> ''
      ORDER BY system COLLATE NOCASE ASC
    `).all().map((row) => row.system),
    statuses: db.prepare(`
      SELECT DISTINCT status
      FROM symptoms
      WHERE status IS NOT NULL AND TRIM(status) <> ''
      ORDER BY status COLLATE NOCASE ASC
    `).all().map((row) => row.status),
  };
}

export function searchProcedures({ query = "", system = "", difficulty = "", sort = "newest" }) {
  const trimmedQuery = query.trim();
  const searchPattern = `%${trimmedQuery.toLowerCase()}%`;
  const whereClauses = [];
  const params = [];

  if (trimmedQuery) {
    whereClauses.push(`(
      lower(procedures.title) LIKE ?
      OR lower(COALESCE(procedures.system, '')) LIKE ?
      OR lower(COALESCE(procedures.tools_needed, '')) LIKE ?
      OR lower(COALESCE(procedures.parts_needed, '')) LIKE ?
      OR lower(COALESCE(procedures.safety_notes, '')) LIKE ?
      OR lower(COALESCE(procedures.steps, '')) LIKE ?
      OR lower(COALESCE(procedures.notes, '')) LIKE ?
    )`);
    params.push(
      searchPattern,
      searchPattern,
      searchPattern,
      searchPattern,
      searchPattern,
      searchPattern,
      searchPattern
    );
  }

  if (system) {
    whereClauses.push("procedures.system = ?");
    params.push(system);
  }

  if (difficulty) {
    whereClauses.push("procedures.difficulty = ?");
    params.push(difficulty);
  }

  const whereSql = whereClauses.length ? `WHERE ${whereClauses.join(" AND ")}` : "";
  const sortSql =
    sort === "oldest"
      ? "ORDER BY procedures.created_at ASC, procedures.id ASC"
      : sort === "title"
        ? "ORDER BY procedures.title COLLATE NOCASE ASC, procedures.updated_at DESC"
        : "ORDER BY procedures.updated_at DESC, procedures.id DESC";

  const rows = db.prepare(`
    SELECT
      procedures.id,
      procedures.title,
      procedures.system,
      procedures.difficulty,
      procedures.confidence,
      procedures.tools_needed,
      procedures.parts_needed,
      procedures.safety_notes,
      procedures.steps,
      procedures.notes,
      procedures.created_at,
      procedures.updated_at,
      COUNT(procedure_documents.document_id) AS linked_document_count
    FROM procedures
    LEFT JOIN procedure_documents ON procedure_documents.procedure_id = procedures.id
    ${whereSql}
    GROUP BY procedures.id
    ${sortSql}
  `).all(...params);

  return rows.map((row) => {
    const matchSnippet = buildMatchSnippet(
      [
        { label: "Title", value: row.title || "" },
        { label: "Tools needed", value: row.tools_needed || "" },
        { label: "Parts needed", value: row.parts_needed || "" },
        { label: "Safety notes", value: row.safety_notes || "" },
        { label: "Steps", value: row.steps || "" },
        { label: "Notes", value: row.notes || "" },
      ],
      trimmedQuery
    );

    return {
      id: row.id,
      title: row.title,
      system: row.system || "",
      difficulty: row.difficulty || "intermediate",
      confidence: row.confidence || "medium",
      linkedDocumentCount: Number(row.linked_document_count || 0),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      snippet: matchSnippet.snippet,
      snippetField: matchSnippet.snippetField,
    };
  });
}

export function getProcedureSearchFilters() {
  return {
    systems: db.prepare(`
      SELECT DISTINCT system
      FROM procedures
      WHERE system IS NOT NULL AND TRIM(system) <> ''
      ORDER BY system COLLATE NOCASE ASC
    `).all().map((row) => row.system),
    difficulties: db.prepare(`
      SELECT DISTINCT difficulty
      FROM procedures
      WHERE difficulty IS NOT NULL AND TRIM(difficulty) <> ''
      ORDER BY difficulty COLLATE NOCASE ASC
    `).all().map((row) => row.difficulty),
  };
}

export function searchNotes({ query = "", noteType = "", relatedEntityType = "", sort = "newest" }) {
  const trimmedQuery = query.trim();
  const searchPattern = `%${trimmedQuery.toLowerCase()}%`;
  const whereClauses = [];
  const params = [];

  if (trimmedQuery) {
    whereClauses.push(`(
      lower(COALESCE(notes.title, '')) LIKE ?
      OR lower(COALESCE(notes.content, notes.body, '')) LIKE ?
    )`);
    params.push(searchPattern, searchPattern);
  }

  if (noteType) {
    whereClauses.push("notes.note_type = ?");
    params.push(noteType);
  }

  if (relatedEntityType) {
    whereClauses.push("notes.related_entity_type = ?");
    params.push(relatedEntityType);
  }

  const whereSql = whereClauses.length ? `WHERE ${whereClauses.join(" AND ")}` : "";
  const sortSql =
    sort === "oldest"
      ? "ORDER BY notes.created_at ASC, notes.id ASC"
      : "ORDER BY notes.updated_at DESC, notes.id DESC";

  const rows = db.prepare(`
    SELECT
      notes.id,
      notes.title,
      notes.content,
      notes.body,
      notes.note_type,
      notes.related_entity_type,
      notes.related_entity_id,
      notes.created_at,
      notes.updated_at,
      documents.title AS linked_document_title,
      symptoms.title AS linked_symptom_title,
      procedures.title AS linked_procedure_title
    FROM notes
    LEFT JOIN documents
      ON notes.related_entity_type = 'document'
      AND notes.related_entity_id = documents.id
    LEFT JOIN symptoms
      ON notes.related_entity_type = 'symptom'
      AND notes.related_entity_id = symptoms.id
    LEFT JOIN procedures
      ON notes.related_entity_type = 'procedure'
      AND notes.related_entity_id = procedures.id
    ${whereSql}
    ${sortSql}
  `).all(...params);

  return rows.map((row) => {
    const content = row.content || row.body || "";
    const matchSnippet = buildMatchSnippet(
      [
        { label: "Title", value: row.title || "" },
        { label: "Content", value: content },
      ],
      trimmedQuery
    );

    return {
      id: row.id,
      title: row.title || "",
      noteType: row.note_type || "general",
      relatedEntityType: row.related_entity_type || "none",
      relatedEntityId: row.related_entity_id || null,
      linkedTitle:
        row.linked_document_title ||
        row.linked_symptom_title ||
        row.linked_procedure_title ||
        "",
      content,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      snippet: matchSnippet.snippet,
      snippetField: matchSnippet.snippetField,
    };
  });
}

export function getNoteSearchFilters() {
  return {
    noteTypes: db.prepare(`
      SELECT DISTINCT note_type
      FROM notes
      WHERE note_type IS NOT NULL AND TRIM(note_type) <> ''
      ORDER BY note_type COLLATE NOCASE ASC
    `).all().map((row) => row.note_type),
    relatedEntityTypes: db.prepare(`
      SELECT DISTINCT related_entity_type
      FROM notes
      WHERE related_entity_type IS NOT NULL AND TRIM(related_entity_type) <> ''
      ORDER BY related_entity_type COLLATE NOCASE ASC
    `).all().map((row) => row.related_entity_type),
  };
}
```

Modify `server/src/routes/search.js` to:

```js
import { Router } from "express";
import {
  getDocumentFilterOptions,
  searchDocuments,
} from "../services/documentService.js";
import {
  getNoteSearchFilters,
  getProcedureSearchFilters,
  getSymptomSearchFilters,
  searchNotes,
  searchProcedures,
  searchSymptoms,
} from "../services/searchService.js";

export const searchRouter = Router();

function getStringQuery(request, key, fallback = "") {
  return typeof request.query[key] === "string" ? request.query[key] : fallback;
}

function handleDocumentSearch(request, response) {
  const results = searchDocuments({
    query: getStringQuery(request, "q"),
    system: getStringQuery(request, "system"),
    documentType: getStringQuery(request, "documentType"),
    favorite: getStringQuery(request, "favorite"),
    sort: getStringQuery(request, "sort", "relevance"),
  });

  response.json({
    results,
    total: results.length,
    filters: getDocumentFilterOptions(),
  });
}

searchRouter.get("/", handleDocumentSearch);
searchRouter.get("/documents", handleDocumentSearch);

searchRouter.get("/symptoms", (request, response) => {
  const results = searchSymptoms({
    query: getStringQuery(request, "q"),
    system: getStringQuery(request, "system"),
    status: getStringQuery(request, "status"),
    sort: getStringQuery(request, "sort", "newest"),
  });

  response.json({
    results,
    total: results.length,
    filters: getSymptomSearchFilters(),
  });
});

searchRouter.get("/procedures", (request, response) => {
  const results = searchProcedures({
    query: getStringQuery(request, "q"),
    system: getStringQuery(request, "system"),
    difficulty: getStringQuery(request, "difficulty"),
    sort: getStringQuery(request, "sort", "newest"),
  });

  response.json({
    results,
    total: results.length,
    filters: getProcedureSearchFilters(),
  });
});

searchRouter.get("/notes", (request, response) => {
  const results = searchNotes({
    query: getStringQuery(request, "q"),
    noteType: getStringQuery(request, "noteType"),
    relatedEntityType: getStringQuery(request, "relatedEntityType"),
    sort: getStringQuery(request, "sort", "newest"),
  });

  response.json({
    results,
    total: results.length,
    filters: getNoteSearchFilters(),
  });
});
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```powershell
npm run test:server
```

Expected: PASS for the new search route tests and the existing server tests.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/searchService.js server/src/routes/search.js server/test/app.test.js
git commit -m "feat: add whole-app search endpoints"
```

### Task 4: Keep document search route compatibility while preserving current document behavior

**Files:**
- Modify: `server/src/services/documentService.js`
- Test: `server/test/app.test.js`

- [ ] **Step 1: Write the failing test**

Use the legacy compatibility test from Task 1. No additional test code is needed.

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
npm run test:server
```

Expected: FAIL if the old `/api/search` behavior is not still returning document search results and filters.

- [ ] **Step 3: Write minimal implementation**

If needed, keep `searchDocuments()` unchanged except for any shared helper imports that stay local to that file. Do not change the existing result shape that the document search UI already expects.

- [ ] **Step 4: Run test to verify it passes**

Run:

```powershell
npm run test:server
```

Expected: PASS with both `/api/search` and `/api/search/documents` returning document search payloads.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/documentService.js server/src/routes/search.js
git commit -m "refactor: preserve document search compatibility"
```

### Task 5: Rebuild the Search page into four independent sections

**Files:**
- Modify: `client/src/pages/SearchPage.jsx`
- Test: `client/src/pages/SearchPage.test.jsx`

- [ ] **Step 1: Write the failing test**

Use the test from Task 2. No additional test code is needed here.

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
npm run test:client
```

Expected: FAIL because the current page still renders only document search.

- [ ] **Step 3: Write minimal implementation**

Replace `client/src/pages/SearchPage.jsx` with this structure:

```jsx
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { PageHeader } from "../components/PageHeader";

const defaultDocumentsForm = {
  q: "",
  system: "",
  documentType: "",
  favorite: "",
  sort: "relevance",
};

const defaultSymptomsForm = {
  q: "",
  system: "",
  status: "",
  sort: "newest",
};

const defaultProceduresForm = {
  q: "",
  system: "",
  difficulty: "",
  sort: "newest",
};

const defaultNotesForm = {
  q: "",
  noteType: "",
  relatedEntityType: "",
  sort: "newest",
};

function buildQueryString(form) {
  const searchParams = new URLSearchParams();

  Object.entries(form).forEach(([key, value]) => {
    if (typeof value === "string" && value.trim()) {
      searchParams.set(key, value.trim());
    }
  });

  return searchParams.toString();
}

function SectionShell({ title, children }) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <h2 className="text-xl font-semibold text-slate-900">{title}</h2>
      <div className="mt-4 space-y-4">{children}</div>
    </section>
  );
}

function KeywordField({ label = "Keyword", value, onChange }) {
  return (
    <label className="grid gap-2 text-sm text-slate-700">
      <span className="font-medium text-slate-900">{label}</span>
      <input
        className="rounded-xl border border-slate-300 px-3 py-2 outline-none transition focus:border-sky-500"
        value={value}
        onChange={onChange}
      />
    </label>
  );
}

function SectionActions({ onSearch, onClear, loading }) {
  return (
    <div className="flex flex-wrap gap-3">
      <button
        type="button"
        onClick={onSearch}
        disabled={loading}
        className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-400"
      >
        {loading ? "Searching..." : "Search"}
      </button>
      <button
        type="button"
        onClick={onClear}
        className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-100"
      >
        Clear
      </button>
    </div>
  );
}

function ResultCount({ total, label }) {
  return (
    <p className="text-sm text-slate-600">
      Found <span className="font-semibold text-slate-900">{total}</span> {label}.
    </p>
  );
}

function EmptyState({ message }) {
  return (
    <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-5 text-sm text-slate-600">
      {message}
    </div>
  );
}

function SearchPageDocumentCard({ result }) {
  return (
    <article className="rounded-xl border border-slate-200 bg-slate-50 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold text-slate-900">{result.title}</h3>
          <p className="text-sm text-slate-500">{result.originalFilename}</p>
        </div>
        <Link
          to={`/documents?documentId=${result.id}`}
          aria-label={`Open document ${result.title}`}
          className="text-sm font-medium text-sky-700 underline decoration-sky-200 underline-offset-2 hover:text-sky-900"
        >
          Open document
        </Link>
      </div>
      <p className="mt-2 text-sm text-slate-700">
        {result.system} - {result.documentType}
      </p>
      {result.snippet ? <p className="mt-2 text-sm text-slate-600">{result.snippet}</p> : null}
    </article>
  );
}

function SearchPageSymptomCard({ result }) {
  return (
    <article className="rounded-xl border border-slate-200 bg-slate-50 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold text-slate-900">{result.title}</h3>
          <p className="text-sm text-slate-500">
            {result.system || "No system"} - {result.status}
          </p>
        </div>
        <Link
          to={`/symptoms?symptomId=${result.id}`}
          aria-label={`Open symptom ${result.title}`}
          className="text-sm font-medium text-sky-700 underline decoration-sky-200 underline-offset-2 hover:text-sky-900"
        >
          Open symptom
        </Link>
      </div>
      {result.snippet ? <p className="mt-2 text-sm text-slate-600">{result.snippet}</p> : null}
    </article>
  );
}

function SearchPageProcedureCard({ result }) {
  return (
    <article className="rounded-xl border border-slate-200 bg-slate-50 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold text-slate-900">{result.title}</h3>
          <p className="text-sm text-slate-500">
            {result.system || "No system"} - {result.difficulty}
          </p>
        </div>
        <Link
          to={`/procedures?procedureId=${result.id}`}
          aria-label={`Open procedure ${result.title}`}
          className="text-sm font-medium text-sky-700 underline decoration-sky-200 underline-offset-2 hover:text-sky-900"
        >
          Open procedure
        </Link>
      </div>
      {result.snippet ? <p className="mt-2 text-sm text-slate-600">{result.snippet}</p> : null}
    </article>
  );
}

function SearchPageNoteCard({ result }) {
  return (
    <article className="rounded-xl border border-slate-200 bg-slate-50 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold text-slate-900">{result.title}</h3>
          <p className="text-sm text-slate-500">
            {result.noteType} {result.linkedTitle ? `- ${result.linkedTitle}` : ""}
          </p>
        </div>
        <Link
          to={`/notes?noteId=${result.id}`}
          aria-label={`Open note ${result.title}`}
          className="text-sm font-medium text-sky-700 underline decoration-sky-200 underline-offset-2 hover:text-sky-900"
        >
          Open note
        </Link>
      </div>
      {result.snippet ? <p className="mt-2 text-sm text-slate-600">{result.snippet}</p> : null}
    </article>
  );
}

async function fetchSection(url, setState) {
  setState((current) => ({ ...current, loading: true, error: "" }));

  try {
    const response = await fetch(url);
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || "Could not load search results.");
    }

    setState({
      loading: false,
      error: "",
      results: payload.results || [],
      filters: payload.filters || {},
      total: payload.total || 0,
    });
  } catch (error) {
    setState((current) => ({
      ...current,
      loading: false,
      error: error.message || "Could not load search results.",
    }));
  }
}

export function SearchPage() {
  const [documentsForm, setDocumentsForm] = useState(defaultDocumentsForm);
  const [symptomsForm, setSymptomsForm] = useState(defaultSymptomsForm);
  const [proceduresForm, setProceduresForm] = useState(defaultProceduresForm);
  const [notesForm, setNotesForm] = useState(defaultNotesForm);

  const [documentsState, setDocumentsState] = useState({
    loading: true,
    error: "",
    results: [],
    filters: { systems: [], documentTypes: [] },
    total: 0,
  });
  const [symptomsState, setSymptomsState] = useState({
    loading: true,
    error: "",
    results: [],
    filters: { systems: [], statuses: [] },
    total: 0,
  });
  const [proceduresState, setProceduresState] = useState({
    loading: true,
    error: "",
    results: [],
    filters: { systems: [], difficulties: [] },
    total: 0,
  });
  const [notesState, setNotesState] = useState({
    loading: true,
    error: "",
    results: [],
    filters: { noteTypes: [], relatedEntityTypes: [] },
    total: 0,
  });

  function runDocumentsSearch(form = documentsForm) {
    const query = buildQueryString(form);
    return fetchSection(`/api/search/documents${query ? `?${query}` : ""}`, setDocumentsState);
  }

  function runSymptomsSearch(form = symptomsForm) {
    const query = buildQueryString(form);
    return fetchSection(`/api/search/symptoms${query ? `?${query}` : ""}`, setSymptomsState);
  }

  function runProceduresSearch(form = proceduresForm) {
    const query = buildQueryString(form);
    return fetchSection(`/api/search/procedures${query ? `?${query}` : ""}`, setProceduresState);
  }

  function runNotesSearch(form = notesForm) {
    const query = buildQueryString(form);
    return fetchSection(`/api/search/notes${query ? `?${query}` : ""}`, setNotesState);
  }

  useEffect(() => {
    runDocumentsSearch(defaultDocumentsForm);
    runSymptomsSearch(defaultSymptomsForm);
    runProceduresSearch(defaultProceduresForm);
    runNotesSearch(defaultNotesForm);
  }, []);

  return (
    <>
      <PageHeader
        eyebrow="Working Feature"
        title="Search"
        description="Search documents, symptoms, procedures, and notes from one page while keeping each search area separate and easy to understand."
      />

      <div className="space-y-6">
        <SectionShell title="Documents">
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
            <KeywordField
              value={documentsForm.q}
              onChange={(event) => setDocumentsForm((current) => ({ ...current, q: event.target.value }))}
            />
            <label className="grid gap-2 text-sm text-slate-700">
              <span className="font-medium text-slate-900">System</span>
              <select
                value={documentsForm.system}
                onChange={(event) =>
                  setDocumentsForm((current) => ({ ...current, system: event.target.value }))
                }
                className="rounded-xl border border-slate-300 px-3 py-2"
              >
                <option value="">All systems</option>
                {documentsState.filters.systems.map((system) => (
                  <option key={system} value={system}>{system}</option>
                ))}
              </select>
            </label>
            <label className="grid gap-2 text-sm text-slate-700">
              <span className="font-medium text-slate-900">Document type</span>
              <select
                value={documentsForm.documentType}
                onChange={(event) =>
                  setDocumentsForm((current) => ({ ...current, documentType: event.target.value }))
                }
                className="rounded-xl border border-slate-300 px-3 py-2"
              >
                <option value="">All types</option>
                {documentsState.filters.documentTypes.map((documentType) => (
                  <option key={documentType} value={documentType}>{documentType}</option>
                ))}
              </select>
            </label>
            <label className="grid gap-2 text-sm text-slate-700">
              <span className="font-medium text-slate-900">Favorite filter</span>
              <select
                value={documentsForm.favorite}
                onChange={(event) =>
                  setDocumentsForm((current) => ({ ...current, favorite: event.target.value }))
                }
                className="rounded-xl border border-slate-300 px-3 py-2"
              >
                <option value="">All documents</option>
                <option value="true">Favorites only</option>
              </select>
            </label>
            <label className="grid gap-2 text-sm text-slate-700">
              <span className="font-medium text-slate-900">Sort</span>
              <select
                value={documentsForm.sort}
                onChange={(event) =>
                  setDocumentsForm((current) => ({ ...current, sort: event.target.value }))
                }
                className="rounded-xl border border-slate-300 px-3 py-2"
              >
                <option value="relevance">Relevance</option>
                <option value="newest">Newest</option>
                <option value="title">Title</option>
              </select>
            </label>
          </div>

          <SectionActions
            loading={documentsState.loading}
            onSearch={() => runDocumentsSearch()}
            onClear={() => {
              setDocumentsForm(defaultDocumentsForm);
              runDocumentsSearch(defaultDocumentsForm);
            }}
          />

          {documentsState.error ? <p className="text-sm text-red-700">{documentsState.error}</p> : null}
          <ResultCount total={documentsState.total} label="document results" />
          {documentsState.results.length
            ? documentsState.results.map((result) => (
                <SearchPageDocumentCard key={result.id} result={result} />
              ))
            : <EmptyState message="No documents matched this search." />}
        </SectionShell>

        <SectionShell title="Symptoms">
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <KeywordField
              value={symptomsForm.q}
              onChange={(event) => setSymptomsForm((current) => ({ ...current, q: event.target.value }))}
            />
            <label className="grid gap-2 text-sm text-slate-700">
              <span className="font-medium text-slate-900">System</span>
              <select
                value={symptomsForm.system}
                onChange={(event) =>
                  setSymptomsForm((current) => ({ ...current, system: event.target.value }))
                }
                className="rounded-xl border border-slate-300 px-3 py-2"
              >
                <option value="">All systems</option>
                {symptomsState.filters.systems.map((system) => (
                  <option key={system} value={system}>{system}</option>
                ))}
              </select>
            </label>
            <label className="grid gap-2 text-sm text-slate-700">
              <span className="font-medium text-slate-900">Status</span>
              <select
                value={symptomsForm.status}
                onChange={(event) =>
                  setSymptomsForm((current) => ({ ...current, status: event.target.value }))
                }
                className="rounded-xl border border-slate-300 px-3 py-2"
              >
                <option value="">All statuses</option>
                {symptomsState.filters.statuses.map((status) => (
                  <option key={status} value={status}>{status}</option>
                ))}
              </select>
            </label>
            <label className="grid gap-2 text-sm text-slate-700">
              <span className="font-medium text-slate-900">Sort</span>
              <select
                value={symptomsForm.sort}
                onChange={(event) =>
                  setSymptomsForm((current) => ({ ...current, sort: event.target.value }))
                }
                className="rounded-xl border border-slate-300 px-3 py-2"
              >
                <option value="newest">Newest</option>
                <option value="oldest">Oldest</option>
                <option value="title">Title</option>
              </select>
            </label>
          </div>

          <SectionActions
            loading={symptomsState.loading}
            onSearch={() => runSymptomsSearch()}
            onClear={() => {
              setSymptomsForm(defaultSymptomsForm);
              runSymptomsSearch(defaultSymptomsForm);
            }}
          />

          {symptomsState.error ? <p className="text-sm text-red-700">{symptomsState.error}</p> : null}
          <ResultCount total={symptomsState.total} label="symptom results" />
          {symptomsState.results.length
            ? symptomsState.results.map((result) => (
                <SearchPageSymptomCard key={result.id} result={result} />
              ))
            : <EmptyState message="No symptoms matched this search." />}
        </SectionShell>

        <SectionShell title="Procedures">
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <KeywordField
              value={proceduresForm.q}
              onChange={(event) => setProceduresForm((current) => ({ ...current, q: event.target.value }))}
            />
            <label className="grid gap-2 text-sm text-slate-700">
              <span className="font-medium text-slate-900">System</span>
              <select
                value={proceduresForm.system}
                onChange={(event) =>
                  setProceduresForm((current) => ({ ...current, system: event.target.value }))
                }
                className="rounded-xl border border-slate-300 px-3 py-2"
              >
                <option value="">All systems</option>
                {proceduresState.filters.systems.map((system) => (
                  <option key={system} value={system}>{system}</option>
                ))}
              </select>
            </label>
            <label className="grid gap-2 text-sm text-slate-700">
              <span className="font-medium text-slate-900">Difficulty</span>
              <select
                value={proceduresForm.difficulty}
                onChange={(event) =>
                  setProceduresForm((current) => ({ ...current, difficulty: event.target.value }))
                }
                className="rounded-xl border border-slate-300 px-3 py-2"
              >
                <option value="">All difficulties</option>
                {proceduresState.filters.difficulties.map((difficulty) => (
                  <option key={difficulty} value={difficulty}>{difficulty}</option>
                ))}
              </select>
            </label>
            <label className="grid gap-2 text-sm text-slate-700">
              <span className="font-medium text-slate-900">Sort</span>
              <select
                value={proceduresForm.sort}
                onChange={(event) =>
                  setProceduresForm((current) => ({ ...current, sort: event.target.value }))
                }
                className="rounded-xl border border-slate-300 px-3 py-2"
              >
                <option value="newest">Newest</option>
                <option value="oldest">Oldest</option>
                <option value="title">Title</option>
              </select>
            </label>
          </div>

          <SectionActions
            loading={proceduresState.loading}
            onSearch={() => runProceduresSearch()}
            onClear={() => {
              setProceduresForm(defaultProceduresForm);
              runProceduresSearch(defaultProceduresForm);
            }}
          />

          {proceduresState.error ? <p className="text-sm text-red-700">{proceduresState.error}</p> : null}
          <ResultCount total={proceduresState.total} label="procedure results" />
          {proceduresState.results.length
            ? proceduresState.results.map((result) => (
                <SearchPageProcedureCard key={result.id} result={result} />
              ))
            : <EmptyState message="No procedures matched this search." />}
        </SectionShell>

        <SectionShell title="Notes">
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <KeywordField
              value={notesForm.q}
              onChange={(event) => setNotesForm((current) => ({ ...current, q: event.target.value }))}
            />
            <label className="grid gap-2 text-sm text-slate-700">
              <span className="font-medium text-slate-900">Note type</span>
              <select
                value={notesForm.noteType}
                onChange={(event) =>
                  setNotesForm((current) => ({ ...current, noteType: event.target.value }))
                }
                className="rounded-xl border border-slate-300 px-3 py-2"
              >
                <option value="">All note types</option>
                {notesState.filters.noteTypes.map((noteType) => (
                  <option key={noteType} value={noteType}>{noteType}</option>
                ))}
              </select>
            </label>
            <label className="grid gap-2 text-sm text-slate-700">
              <span className="font-medium text-slate-900">Linked item type</span>
              <select
                value={notesForm.relatedEntityType}
                onChange={(event) =>
                  setNotesForm((current) => ({ ...current, relatedEntityType: event.target.value }))
                }
                className="rounded-xl border border-slate-300 px-3 py-2"
              >
                <option value="">All link types</option>
                {notesState.filters.relatedEntityTypes.map((relatedEntityType) => (
                  <option key={relatedEntityType} value={relatedEntityType}>{relatedEntityType}</option>
                ))}
              </select>
            </label>
            <label className="grid gap-2 text-sm text-slate-700">
              <span className="font-medium text-slate-900">Sort</span>
              <select
                value={notesForm.sort}
                onChange={(event) =>
                  setNotesForm((current) => ({ ...current, sort: event.target.value }))
                }
                className="rounded-xl border border-slate-300 px-3 py-2"
              >
                <option value="newest">Newest</option>
                <option value="oldest">Oldest</option>
              </select>
            </label>
          </div>

          <SectionActions
            loading={notesState.loading}
            onSearch={() => runNotesSearch()}
            onClear={() => {
              setNotesForm(defaultNotesForm);
              runNotesSearch(defaultNotesForm);
            }}
          />

          {notesState.error ? <p className="text-sm text-red-700">{notesState.error}</p> : null}
          <ResultCount total={notesState.total} label="note results" />
          {notesState.results.length
            ? notesState.results.map((result) => (
                <SearchPageNoteCard key={result.id} result={result} />
              ))
            : <EmptyState message="No notes matched this search." />}
        </SectionShell>
      </div>
    </>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```powershell
npm run test:client
```

Expected: PASS for the new Search page test and the existing client tests.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/SearchPage.jsx client/src/pages/SearchPage.test.jsx
git commit -m "feat: add separate whole-app search sections"
```

### Task 6: Update docs to describe the new whole-app search page truthfully

**Files:**
- Modify: `README.md`
- Modify: `PRD.md`
- Modify: `DATA_MODEL.md`

- [ ] **Step 1: Write the failing test**

No automated doc test is needed. The functional tests from earlier tasks are the behavioral safety net.

- [ ] **Step 2: Run tests to verify current behavior before docs**

Run:

```powershell
npm run test
```

Expected: PASS before changing docs.

- [ ] **Step 3: Write minimal implementation**

Update `README.md`:

```md
### Search

The Search page is implemented.

It now searches the whole app through separate sections for:

- documents
- symptoms
- procedures
- notes

Each section has its own keyword search, filters, and clear action so you can narrow one area without resetting the others.
```

Update `PRD.md`:

```md
### Search

- Search across documents, symptoms, procedures, and notes
- Keep each search area separate inside one Search page
- Reuse normal page links to open the selected result in its feature page
```

Update `DATA_MODEL.md` search expectations:

```md
## Search data expectations

There is no separate search table.

The current app searches directly from the existing entity tables:

- `documents`
- `symptoms`
- `procedures`
- `notes`

Current v1 meaning:
- Search is one page with separate sections for each entity type instead of one mixed global result list
```

- [ ] **Step 4: Run test to verify it still passes**

Run:

```powershell
npm run test
npm run build
```

Expected: PASS for tests and PASS for build.

- [ ] **Step 5: Commit**

```bash
git add README.md PRD.md DATA_MODEL.md
git commit -m "docs: describe whole-app search sections"
```

### Task 7: Final verification

**Files:**
- Modify: none
- Test: `server/test/app.test.js`, `client/src/pages/SearchPage.test.jsx`

- [ ] **Step 1: Run the full test suite**

Run:

```powershell
npm run test
```

Expected: PASS with server and client tests green.

- [ ] **Step 2: Run the production build**

Run:

```powershell
npm run build
```

Expected: PASS with Vite build output and no build errors.

- [ ] **Step 3: Summarize the completed behavior**

Verify these outcomes manually in the code and test output:

```text
- /search shows Documents, Symptoms, Procedures, and Notes sections
- each section calls its own /api/search/<entity> endpoint
- each section can be searched and cleared independently
- result links open the normal entity page
- /api/search still works for document search compatibility
```

- [ ] **Step 4: Commit**

```bash
git add .
git commit -m "feat: finish whole-app search"
```
