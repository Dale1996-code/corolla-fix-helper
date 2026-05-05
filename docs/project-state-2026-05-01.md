# Corolla Fix Helper Project State Review (May 1, 2026)

## Purpose
This document summarizes the current observed project state, what is still missing or broken, what should be done next, and the tests/checks that should be run.

## Current state snapshot
- Product scope and docs position the app as a polished local-first V1 with Dashboard, Documents, Search, Symptoms, Procedures, Notes, and Settings.
- Core build command currently completes successfully.
- Automated tests are currently not green end-to-end.

## What's still missing or broken

### 1) Server test suite is currently blocked by a syntax error
- `npm run test` fails during `npm run test:server`.
- Failure is a parsing error in `server/src/routes/documents.js`:
  - `SyntaxError: Unexpected token 'if'`
  - Reported around line 279.
- Impact: backend verification cannot complete, and root `npm run test` fails.

### 2) Client test suite has failing tests
Observed failures include:
- `SettingsPage loads settings and saves vehicle changes`
  - Error: `createObjectURL does not exist`
- `DocumentsPage confirms before deleting and removes document after success`
  - Error: unable to find button "Delete document"
- `DocumentsPage allows re-running extraction from document details`
  - Error: unable to find button "Re-run extraction"

Impact:
- Frontend automated test confidence is reduced.
- Likely mix of test-environment mocking gaps and UI/test mismatch.

### 3) JSX warning in Documents page should be cleaned up
- Build and tests emit a Vite/esbuild warning in `client/src/pages/DocumentsPage.jsx`:
  - `The character ">" is not valid inside a JSX element`
- Build still succeeds, but warning indicates malformed JSX that may cause unstable render/test behavior.

### 4) No explicit E2E/browser regression suite is present in active scripts
- Current root scripts cover build and unit/integration style suites.
- A manual QA checklist exists, but no automated end-to-end script is wired into root scripts.

## What is still needed (recommended next steps)

### Priority 0: restore baseline reliability
1. Fix the server syntax error in `server/src/routes/documents.js` and re-run backend tests.
2. Fix client test environment support for `URL.createObjectURL` (test setup polyfill or mock).
3. Resolve Documents page JSX warning and any malformed markup.
4. Align Documents page tests with rendered UI behavior (or vice versa) for delete and re-run extraction controls.

### Priority 1: re-establish green CI-equivalent local checks
1. Ensure all these pass in sequence:
   - `npm run build`
   - `npm run test:server`
   - `npm run test:client`
   - `npm run test`
2. Keep `npm run test` as the one-command confidence gate before merging.

### Priority 2: improve regression safety
1. Add a minimal automated E2E smoke flow (if desired scope allows):
   - app starts
   - health endpoint responds
   - basic navigation to each top-level page
2. Keep `QA_CHECKLIST.md` as required manual acceptance for data-linking flows (documents/symptoms/procedures/notes).

## Tests and checks that should be run

### Core commands (root)
1. `npm run build`
2. `npm run test:server`
3. `npm run test:client`
4. `npm run test`

### Optional targeted debug runs
- `node --test server/test/app.test.js`
- `npm --prefix client run test -- src/pages/SettingsAndSymptoms.test.jsx`
- `npm --prefix client run test -- src/pages/DocumentsPage.test.jsx`

### Manual acceptance checks
Run through `QA_CHECKLIST.md`, with extra attention to:
- Settings backup export flow.
- Document delete cleanup across linked symptoms/procedures/notes.
- Document extraction re-run feedback.
- Notes linked-item details for document/symptom/procedure links.

## Commands used for this assessment
- `npm run test`
- `npm run build`
- `npm run test:client`
- `sed -n '1,220p' README.md`
- `sed -n '1,260p' ROADMAP.md`
- `sed -n '1,260p' QA_CHECKLIST.md`
- `cat package.json`
