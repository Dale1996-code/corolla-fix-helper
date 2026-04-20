# Phase 5 - Finish And Polish V1

## Summary
- Finish the app as a polished local-first V1 without adding any new feature area.
- Keep this phase focused on four deliverables: real Settings, Symptoms polish, basic automated tests, and a manual QA checklist.
- End the phase by updating the docs so the repo truthfully says V1 is finished.

## Public Interfaces
- Add `GET /api/settings` returning:
  - `vehicle`: `{ id, year, make, model, trim, engine }`
  - `runtime`: `{ databaseFile, uploadsDir, maxUploadSizeMb, port, clientPort, pathsEditable: false }`
- Add `PUT /api/settings/vehicle` accepting `{ year, make, model, trim, engine }`, validating `year`, `make`, and `model`, and returning the updated `vehicle`.
- Add root test commands so these exist and become the acceptance commands for the phase: `npm run build`, `npm run test`, `npm run test:server`, and `npm run test:client`.
- Keep Symptoms filtering and search client-side in this phase. Do not add new Symptoms API query parameters.

## Implementation Changes
- Replace the Settings placeholder with a real page built around two sections only: editable Vehicle Profile and read-only Local App Info.
- Reuse the existing `vehicles` table for the editable part. Do not create a new settings table.
- Show the database path, uploads path, upload limit, and ports as read-only values, with plain-English help that these come from `.env` and are not safely edited inside the browser.
- Save vehicle edits immediately from the Settings page and show clear success and error messages.
- Add a Symptoms control bar with search, status filter, system filter, and sort.
- Make Symptoms search match `title`, `system`, `suspectedCauses`, and `notes`.
- Add a Symptoms summary strip showing total items, visible items, and counts for `open`, `monitoring`, and `resolved`.
- Improve the Symptoms list so each row is easier to scan quickly: title, system, status, confidence, linked-document count, and updated date.
- Keep selection stable when filters change. If the selected symptom disappears from the filtered list, auto-select the first visible item or clear the detail panel if none remain.
- Add a friendly no-results state for Symptoms that tells the user whether to change filters or create a new symptom.
- Limit extra polish to small, low-risk consistency fixes directly adjacent to this work: clearer empty states, count bars, button text, and matching feedback messages.
- Update `README.md`, `PRD.md`, and `ROADMAP.md` at the end so Settings is no longer described as unfinished and the new test commands are documented.

## Test Plan
- Split server startup from app creation so route tests can import the Express app without opening a real port.
- Use Node’s built-in test runner plus `supertest` for backend route tests.
- Use Vitest plus React Testing Library for frontend smoke tests.
- Backend tests should cover `GET /api/settings`, `PUT /api/settings/vehicle`, and a quick sanity check that existing core routes still respond after the server-entry refactor.
- Frontend tests should cover Settings loading, vehicle save flow, Symptoms search/filter/sort behavior, selection behavior after filtering, and the no-results state.
- Add a root `QA_CHECKLIST.md` covering the manual core flow: run the app, edit vehicle info, upload/open/search a PDF, create and filter a symptom, create a procedure, create a note, then run `npm run build` and `npm run test`.

## Assumptions
- “Finished” means a polished V1 within the current roadmap, not a new feature expansion.
- Browser-based Settings will not edit filesystem paths or `.env` values.
- No new database tables are needed for this phase.
- Any polish outside Settings and Symptoms stays minor and does not turn into an app-wide redesign.
