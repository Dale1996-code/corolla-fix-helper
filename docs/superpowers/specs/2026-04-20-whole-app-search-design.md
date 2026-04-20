# Whole-App Search Design

Date: 2026-04-20
Project: Corolla Fix Helper
Topic: Expand Search from document-only to whole-app search

## Summary

The current Search page only searches documents. The new goal is to make Search cover the whole app while keeping the page beginner-friendly and easy to understand.

The chosen design is:

- keep one Search page at `/search`
- show four separate search sections on that page
- give each section its own search box, filters, clear action, result count, and result list
- search these entity types separately:
  - documents
  - symptoms
  - procedures
  - notes

This avoids one large mixed-result list and keeps each feature area understandable.

## Why This Approach

This repo already has separate feature pages and separate backend routes for documents, symptoms, procedures, and notes. A section-based whole-app search fits the app’s current shape better than building one combined global search result model.

This approach was chosen because it:

- matches the user request for separate search behavior
- keeps filters simple and local to each entity type
- reuses current route patterns and UI patterns
- avoids overengineering a single complex global ranking system

## Current State

At the time of design:

- `/api/search` only searches documents
- `client/src/pages/SearchPage.jsx` is a document-only search page
- symptoms, procedures, and notes already have their own data routes:
  - `/api/symptoms`
  - `/api/procedures`
  - `/api/notes`

The design extends search without changing the existing core entity pages.

## Goals

- Search the whole app from the Search page
- Keep results separate by entity type
- Let each section search independently
- Reuse existing app navigation so clicking a result opens the matching record in its normal page
- Keep the implementation small, readable, and consistent with the current repo

## Non-Goals

- Do not build one mixed “all results” ranking list
- Do not add fuzzy search libraries or full-text engines
- Do not redesign the Documents, Symptoms, Procedures, or Notes pages
- Do not replace existing page-local filters on those pages
- Do not add cloud search, AI search, or semantic search

## Route and API Design

The Search page will remain at:

- `/search`

The backend will expose four explicit search endpoints:

- `GET /api/search/documents`
- `GET /api/search/symptoms`
- `GET /api/search/procedures`
- `GET /api/search/notes`

The existing document search logic should move behind `GET /api/search/documents`.

For backward safety, `GET /api/search` can either:

- remain as an alias to document search for now, or
- be updated to return the same payload as `/api/search/documents`

Recommendation: keep `GET /api/search` as a backward-compatible alias to document search during this change so nothing else breaks accidentally.

## Section Behavior

### Documents section

This section keeps the current document search behavior, but it lives as one section inside the new Search page.

Supported inputs:

- keyword
- system
- document type
- favorite filter
- sort

Search fields:

- title
- original filename
- notes
- extracted text

### Symptoms section

Supported inputs:

- keyword
- system
- status
- sort

Search fields:

- title
- description
- system
- suspected causes
- notes

Recommended sorts:

- newest
- oldest
- title

### Procedures section

Supported inputs:

- keyword
- system
- difficulty
- sort

Search fields:

- title
- system
- tools needed
- parts needed
- safety notes
- steps
- notes

Recommended sorts:

- newest
- oldest
- title

### Notes section

Supported inputs:

- keyword
- note type
- linked item type
- sort

Search fields:

- title
- content

Recommended sorts:

- newest
- oldest

Notes search should not try to search the linked entity’s full text. It should search the note itself and show link context in the result card.

## Response Shape

Each endpoint should return only what its own section needs.

### Documents response

Keep the current structure as much as possible:

- `results`
- `total`
- `filters`

### Symptoms response

Return:

- `results`
- `total`
- `filters`

Each symptom result should include enough display data for the Search page and deep linking:

- `id`
- `title`
- `system`
- `status`
- `confidence`
- `notes`
- `suspectedCauses`
- `updatedAt`
- `createdAt`
- `linkedDocumentCount`
- `snippet`
- `snippetField`

### Procedures response

Return:

- `results`
- `total`
- `filters`

Each procedure result should include:

- `id`
- `title`
- `system`
- `difficulty`
- `confidence`
- `updatedAt`
- `createdAt`
- `linkedDocumentCount`
- `snippet`
- `snippetField`

### Notes response

Return:

- `results`
- `total`
- `filters`

Each note result should include:

- `id`
- `title`
- `noteType`
- `relatedEntityType`
- `relatedEntityId`
- `linkedTitle`
- `content`
- `updatedAt`
- `createdAt`
- `snippet`
- `snippetField`

## Snippet Rules

Each section can reuse the same simple snippet idea already used in document search:

- if there is a keyword, show a short excerpt around the first best match
- if there is no keyword, show a short preview from the best available text field
- include `snippetField` so the UI can say where the match came from when useful

The ranking should stay simple and field-priority based. No advanced scoring system is needed.

## Frontend Design

`client/src/pages/SearchPage.jsx` will be rewritten from a document-only page into a four-section search page.

The page will:

- use the same overall page shell and header pattern already used in the repo
- change the page title from `Document Search` to `Search`
- remove the blue info box that says search is document-only
- render four independent search panels

Each panel will contain:

- a section heading
- a small filter form
- a Search button
- a Clear button
- a result count
- an empty-state message
- a result list or cards

Each section keeps its own state. Changing the Symptoms search should not reset Documents, Procedures, or Notes.

## Navigation Rules

Each result must open the matching record in its normal feature page using the existing deep-link pattern.

Expected deep links:

- document result -> `/documents?documentId=<id>`
- symptom result -> `/symptoms?symptomId=<id>`
- procedure result -> `/procedures?procedureId=<id>`
- note result -> `/notes?noteId=<id>`

Where possible, reuse the existing navigation helper instead of creating a new routing system.

## Error Handling

Each section should handle its own loading and error state.

Rules:

- one section failing should not blank the whole Search page
- each section shows its own small error message if its request fails
- each section can still be searched again after a failure
- clear buttons reset only that section

## Compatibility and Migration

This change is additive. It does not require database schema changes.

The implementation should:

- reuse current tables and routes
- keep existing entity pages working the same way
- preserve the current document search behavior while moving it into a new page layout

## File-Level Design

Expected backend files to change:

- `server/src/routes/search.js`
- `server/src/services/documentService.js`

Expected new backend service helpers or files:

- either extend existing services, or
- add a focused search service file if that keeps route code cleaner

Expected frontend files to change:

- `client/src/pages/SearchPage.jsx`
- possibly `client/src/lib/navigation.js` if needed for consistent deep links

Expected tests to change:

- add or update server search route tests
- add client tests for the new Search page

Expected docs to change after implementation:

- `README.md`
- `PRD.md`
- `DATA_MODEL.md`

## Testing Plan

### Server tests

Add tests that prove:

- document search still works
- symptom search only returns symptoms
- procedure search only returns procedures
- notes search only returns notes
- each endpoint respects its own filters
- snippets are returned when there is a keyword match

### Client tests

Add tests that prove:

- the new Search page renders all four sections
- each section can search independently
- clearing one section does not reset the others
- result links point to the correct page and record id
- section-specific empty states appear correctly

### Verification commands

Run from the repo root:

```powershell
cd C:\Users\daleb\source\corolla-fix-helper
npm run build
npm run test
```

## Risks

### Risk: Search page becomes too large

Mitigation:

- keep each section compact
- reuse existing card/list patterns
- avoid turning every section into a full page copy

### Risk: Duplicate search logic grows messy

Mitigation:

- keep each endpoint simple
- extract small shared helpers for snippets and sort handling
- do not force one generic abstraction too early

### Risk: Search terms behave differently between sections

Mitigation:

- document the fields each section searches
- keep field-priority scoring simple and explicit

## Final Recommendation

Implement whole-app search as one page with four independent sections and four explicit backend endpoints. This is the smallest clean change that delivers the requested behavior while staying aligned with the current app structure.
