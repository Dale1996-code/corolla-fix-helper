# Corolla Fix Helper Project State Review (updated May 27, 2026)

## Purpose
This is the repo-owned status artifact for the current project state.

The Google Drive doc `Corolla Fix Helper: Master Build Plan` is useful as a planning checklist, but some checked boxes in that doc now overstate what this repo actually implements. A checked box means the plan says "done"; it does not prove the code exists here.

This file should be used before starting new work so the next task begins from the real repo state.

## Sources checked
- Live repo folder: `C:\Users\daleb\source\corolla-fix-helper`
- Google Drive doc: `Corolla Fix Helper: Master Build Plan`
- Drive doc id: `1r5RUDfz_o-UOB4v9FhtRQGbTQ-VhYNOGSXsHeipc_U4`
- Current date of this pass: May 27, 2026

## Current repo truth
- The app is still a local-first helper for one vehicle: a 2009 Toyota Corolla LE 1.8L.
- The main app pages exist: Dashboard, Documents, Document Search, Symptoms, Procedures, Notes, and Settings.
- The backend routes exist for health, dashboard, documents, document search, symptoms, procedures, notes, and settings.
- Documents can be uploaded as PDFs, stored locally, edited for metadata, marked favorite, and opened again from the app.
- PDF text extraction is attempted during upload, and extraction status is stored.
- Document Search is implemented, but it searches imported documents only.
- Symptoms can be created, edited, deleted, filtered, sorted, and linked to documents.
- Procedures can be created, edited, deleted, and linked to documents.
- Notes can be created, edited, deleted, filtered, and linked to a document, symptom, or procedure.
- Settings can edit the vehicle profile, edit document default suggestions, and show local runtime info.
- `npm run build` and `npm run test` pass when run outside the Codex sandbox.

## Biggest misleading claims in the Drive build plan

### 1) Repair Session is checked off, but it is not implemented
Drive plan claim:
- `[x] Add "Repair Session" feature (grouping active symptoms and docs for a specific garage day).`

Live repo truth:
- There is no Repair Session page.
- There is no sidebar navigation item for Repair Session.
- There is no `/api/repair-sessions` route.
- There is no `repair_sessions` database table.
- There is no client component or workflow that groups active symptoms and documents for a garage day.

Plain English:
- The plan says this feature is finished, but the repo has no working Repair Session feature yet.

### 2) Backup/export is checked off, but it is not implemented
Drive plan claim:
- `[x] Implement a simple database backup/export option.`

Live repo truth:
- `server/src/routes/settings.js` returns `backupExport.supported: false`.
- The Settings page shows that backup and export are not wired up yet.
- There is no working backup/export endpoint or browser action.

Plain English:
- The app is honest in code: backup/export is not ready. The Drive checklist is the misleading part.

### 3) Reprocess document is checked off, but it is not implemented
Drive plan claim:
- `[x] Add "reprocess document" action.`

Live repo truth:
- The documents API has routes to list documents, upload a PDF, open a stored PDF, and edit metadata.
- There is no route that re-runs extraction on an existing document.
- The Documents page does not expose a reprocess or re-run extraction button.

Plain English:
- Text extraction happens when a PDF is first uploaded. There is not yet a way to click an existing document and re-run extraction.

### 4) Symptom-to-procedure linking is checked off, but it is not implemented
Drive plan claims:
- `[x] Create join tables: symptom_documents, procedure_documents, symptom_procedures.`
- `[x] Link symptoms to documents and procedures.`

Live repo truth:
- `symptom_documents` exists.
- `procedure_documents` exists.
- `symptom_procedures` does not exist in the live schema setup.
- The Symptoms page links symptoms to documents only.
- The Procedures page links procedures to documents only.

Plain English:
- Symptoms and procedures both connect to documents, but symptoms do not directly connect to procedures yet.

### 5) Search is useful, but narrower than the Drive plan says
Drive plan claims:
- Primary goal: search for a Corolla issue and get relevant documents, notes, and procedures.
- `[x] Build search input (Search title, filename, tags, notes, extracted text).`

Live repo truth:
- `/api/search` searches documents only.
- The Search page text clearly says it does not search symptoms, procedures, or notes yet.
- The search code checks document title, original filename, document notes, and extracted text.
- Tags tables exist, but tags are not part of the current search query.

Plain English:
- Search works for documents, but it is not a whole-app search yet.

### 6) Batch import checklist items are not repo-proven
Drive plan claims:
- `[x] First Real Dataset Test: Import 25-75 high-value files...`
- `[x] Import second batch of files.`

Live repo truth:
- The app supports one-at-a-time PDF upload.
- There is no repo-owned batch import workflow or status record proving those dataset milestones.
- Local uploaded files may exist in `server/uploads`, but that is runtime data, not a reliable code feature or project status checkpoint.

Plain English:
- The repo can store uploaded PDFs, but the checked batch-import milestones are not proven by the repo itself.

## What should happen next
Use the Drive build plan as historical planning context only.

For future implementation work, treat these as not done unless a new task proves or builds them:
- Repair Session feature
- backup/export
- reprocess document action
- direct symptom-to-procedure linking
- whole-app search across documents, symptoms, procedures, and notes
- tag search
- repo-owned batch import status or tooling

## Verification commands and checks used

Run from the repo root:

```powershell
cd C:\Users\daleb\source\corolla-fix-helper
rg --files
rg -n "session|repair session|Repair Session|repair_sessions|symptom_procedures|backup|export|reprocess|Re-run" -S .
npm run build
npm run test
```

Important verification notes:
- `npm run build` passed outside the Codex sandbox.
- `npm run test` passed outside the Codex sandbox.
- The first sandboxed build/test attempt hit a Windows `Access is denied` error while loading `client/vite.config.js`; rerunning outside the sandbox passed, so that looked like an environment issue, not a repo failure.
- Git also printed a warning about `C:\Users\daleb/.config/git/ignore` permission access. That warning is outside this repo and was not treated as a Corolla Fix Helper code problem.
