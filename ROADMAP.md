# Phase 5 - Finish And Polish V1

## Summary
- This phase finished the app as a polished local-first V1 without adding any new feature area.
- This phase focused on four deliverables: real Settings, Symptoms polish, basic automated tests, and a manual QA checklist.
- The repo docs now describe V1 as finished.

## Delivered Interfaces
- `GET /api/settings` returns:
  - `vehicle`: `{ id, year, make, model, trim, engine }`
  - `runtime`: `{ databaseFile, uploadsDir, maxUploadSizeMb, port, clientPort, pathsEditable: false }`
- `PUT /api/settings/vehicle` accepts `{ year, make, model, trim, engine }`, validates `year`, `make`, and `model`, and returns the updated `vehicle`.
- Root test commands exist as the acceptance commands for the phase: `npm run build`, `npm run test`, `npm run test:server`, and `npm run test:client`.
- Symptoms filtering and search stayed client-side in this phase. No new Symptoms API query parameters were added.

## Delivered Changes
- The Settings placeholder was replaced with a real page built around two sections only: editable Vehicle Profile and read-only Local App Info.
- The existing `vehicles` table was reused for the editable part. No new settings table was added.
- The database path, uploads path, upload limit, and ports are shown as read-only values, with plain-English help that these come from `.env` and are not safely edited inside the browser.
- Vehicle edits save immediately from the Settings page and show clear success and error messages.
- Symptoms now have a control bar with search, status filter, system filter, and sort.
- Symptoms search matches `title`, `system`, `suspectedCauses`, and `notes`.
- Symptoms now show a summary strip with total items, visible items, and counts for `open`, `monitoring`, and `resolved`.
- The Symptoms list is easier to scan quickly with title, system, status, confidence, linked-document count, and updated date.
- Selection stays stable when filters change. If the selected symptom disappears from the filtered list, the app auto-selects the first visible item or clears the detail panel if none remain.
- Symptoms now have a friendly no-results state that tells the user whether to change filters or create a new symptom.
- Extra polish stayed limited to small, low-risk consistency fixes directly adjacent to this work: clearer empty states, count bars, button text, and matching feedback messages.
- `README.md`, `PRD.md`, and `ROADMAP.md` were updated so Settings is no longer described as unfinished and the new test commands are documented.

## Test Coverage
- Server startup was split from app creation so route tests can import the Express app without opening a real port.
- Backend route tests use Node’s built-in test runner plus `supertest`.
- Frontend smoke tests use Vitest plus React Testing Library.
- Backend tests cover `GET /api/settings`, `PUT /api/settings/vehicle`, and a quick sanity check that existing core routes still respond after the server-entry refactor.
- Frontend tests cover Settings loading, vehicle save flow, Symptoms search/filter/sort behavior, selection behavior after filtering, and the no-results state.
- A root `QA_CHECKLIST.md` covers the manual core flow: run the app, edit vehicle info, upload/open/search a PDF, create and filter a symptom, create a procedure, create a note, then run `npm run build` and `npm run test`.

## Assumptions Kept
- “Finished” still means a polished V1 within the current roadmap, not a new feature expansion.
- Browser-based Settings do not edit filesystem paths or `.env` values.
- No new database tables were needed for this phase.
- Any polish outside Settings and Symptoms stayed minor and did not turn into an app-wide redesign.
