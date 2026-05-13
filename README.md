# Corolla Fix Helper

Corolla Fix Helper is a local-first repair helper for one vehicle:

- 2009 Toyota Corolla LE 1.8L

It stores app records in a local SQLite database and keeps uploaded PDF files in a local folder. The goal is to keep repair documents, symptoms, procedures, and notes in one practical workspace while working on the car.

## Current repo state on `main`

This repo is past the early planning/pre-V1 state. The current `main` branch documents a validated local-first V1 demo candidate.

The verified V1 baseline is:

- Dashboard, Documents, Search, Symptoms, Procedures, Notes, and Settings are implemented.
- Local SQLite storage and local PDF uploads are the current storage model.
- Node.js `>=24 <25` is required because the backend uses `node:sqlite` with `DatabaseSync`.
- The last documented validation run used Node.js `v24.15.0` and npm `11.4.2`.
- `npm run install:all`, `npm run build`, `npm run test`, `npm run test:server`, and `npm run test:client` completed successfully in that validation run.

This README describes the current `main` branch. Unmerged pull requests may contain extra hardening or deployment experiments, but they are not part of the baseline until merged.

## Current V1 scope

V1 includes:

- Dashboard
- Documents
- Search
- Symptoms
- Procedures
- Notes
- Settings

V1 is intentionally limited:

- Single vehicle only
- Local-first only
- No cloud sync
- No user accounts
- No AI chat
- No embeddings or vector database
- No multi-vehicle support

For a V1 demo deployment, the recommended target is a Google Cloud Compute Engine VM. That keeps the deployed app close to the local architecture: one Node server, one local SQLite database file, and one local uploads folder.

## What the app does right now

### Dashboard

The Dashboard shows summary counts and recent activity for documents, symptoms, procedures, notes, and favorites. It also provides quick links into the main app sections.

### Documents

The Documents area can:

- upload PDF files
- save uploaded PDFs into `server/uploads`
- store document details in SQLite
- attempt PDF text extraction
- manually re-run extraction for a single document from the detail panel
- store extraction status and page count
- edit document metadata after upload
- mark documents as favorites
- open an uploaded PDF from the app
- delete a document with confirmation
- clean up linked symptom/procedure links and note references when a document is deleted
- use saved Settings suggestions while entering system and document type
- sort and filter the document list
- show document details in a side panel

For V1, favorites are the only saved-document flag in the app. Tags and bookmarks are not part of the current document workflow.

Document fields currently used in the app include title, system, subsystem, document type, source, and notes.

### Search

The Search page is implemented. It has separate search sections for:

- documents
- symptoms
- procedures
- notes

Each section keeps its own keyword box, filters, and results.

### Symptoms

The Symptoms feature can create, edit, delete, search, filter, sort, and summarize symptoms. Symptoms can be linked to documents and viewed in a detail panel with their linked documents.

### Procedures

The Procedures feature can create, edit, delete, search, filter, sort, and show procedures. Procedures can store steps, tools, parts, safety notes, difficulty, confidence, and linked documents.

### Notes

The Notes feature can create, edit, delete, sort, and filter notes. Notes can be linked to a document, symptom, or procedure, and the detail panel can open the linked item.

### Settings

The Settings page can:

- edit the single stored vehicle profile
- save reusable document defaults for common system names and document types
- show the local database path
- show the local uploads folder
- show the upload size limit
- show the frontend and backend ports
- export a local backup archive (`.tar.gz`) containing the SQLite database and uploaded PDFs

Runtime path values are read-only in the browser. They come from local config and optional `.env` values. Restore is not included in this phase.

## Tech stack

- `client`: React + Vite + Tailwind CSS
- `server`: Node.js + Express
- `runtime`: Node.js `>=24 <25`
- `database`: SQLite
- `file storage`: local `server/uploads` folder

## Project structure

```text
corolla-fix-helper/
  client/   Frontend app
  server/   API, database setup, and file storage
  docs/     Deployment and project-state notes
```

## First-time setup

Use Node.js `>=24 <25`.

Open a terminal in the project folder, then run:

```bash
npm run install:all
```

This installs the root package, server packages, and client packages.

## Run the app locally

```bash
npm run dev
```

After that:

- frontend: `http://localhost:5173`
- backend: `http://localhost:4000`
- health check: `http://localhost:4000/api/health`

## Useful commands

Run only the server:

```bash
npm run dev:server
```

Run only the client:

```bash
npm run dev:client
```

Build the app:

```bash
npm run build
```

Run both automated test suites:

```bash
npm run test
```

Run only the backend tests:

```bash
npm run test:server
```

Run only the frontend tests:

```bash
npm run test:client
```

Start the app with the built client:

```bash
npm run build
npm start
```

After `npm start`, the built app should load from the backend at `http://localhost:4000`.

## V1 readiness status

Latest documented validation in this repo was run on Node.js `v24.15.0` with npm `11.4.2`.

These commands completed successfully:

```bash
npm run install:all
npm run build
npm run test
npm run test:server
npm run test:client
```

No repo lint or typecheck scripts are currently defined. During install, npm reported one moderate client dependency audit finding; that audit finding did not block the V1 build or automated tests.

Based on the documented validation above, V1 is ready to tag under Node.js `>=24 <25`. Do not tag V1 from a Node 20 validation run, because the backend depends on `node:sqlite` with `DatabaseSync`.

## Manual QA

Use `QA_CHECKLIST.md` before relying on a demo build.

Pay special attention to:

- uploading and opening a sample PDF
- manually re-running extraction
- document delete cleanup across linked symptoms, procedures, and notes
- Settings backup export
- local production start with `npm run build` then `npm start`

## Recommended V1 demo deployment

For a public or private V1 demo, use a Google Cloud Compute Engine VM with Node.js `>=24 <25` or the included Docker image path.

Plain-English storage notes:

- SQLite is a local database file.
- Uploaded PDFs are local files.
- Persistent storage means the database file and PDFs survive app restarts.
- A demo should use sample or fake PDFs because the app does not have user accounts yet.

Cloud Run is not the preferred V1 target because the current design uses a local SQLite file and local uploaded PDF files. Cloud Run can be considered later only if storage is redesigned, for example with a managed database and object storage for PDFs.

For the beginner-friendly VM deployment checklist, use [`docs/GCE_DEPLOYMENT_RUNBOOK.md`](docs/GCE_DEPLOYMENT_RUNBOOK.md).

## Environment values

Copy `.env.example` to `.env` if you want your own local settings.

Important values:

- `PORT=4000` sets the Express server port
- `CLIENT_PORT=5173` sets the Vite dev server port
- `DATABASE_FILE=./server/data/corolla-fix-helper.db` sets the SQLite database file path
- `UPLOADS_DIR=./server/uploads` sets where uploaded PDFs are stored
- `MAX_UPLOAD_SIZE_MB=20` sets the PDF upload size limit
- `NODE_ENV=production` marks the app as a production run for deployment tooling
- `CORS_ORIGIN=http://localhost:5173` sets the allowed CORS origin for the API
