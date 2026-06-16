# Corolla Fix Helper

Corolla Fix Helper is a local-first repair workspace for one vehicle:

- 2009 Toyota Corolla LE 1.8L

Local-first means the app stores its working data on the computer or server that runs it. The current app uses one SQLite database file and one local uploads folder for PDFs.

Storage is still local. Document Q&A is not offline when `OPENAI_API_KEY` is configured, because query embeddings and answer generation depend on OpenAI service availability and per-query network latency.

## What Works Now

The current codebase includes:

- Dashboard summary cards and recent activity
- PDF document upload, metadata editing, extraction status, favorites, delete cleanup, and PDF open links
- Re-run extraction for one saved document
- Optional local OCR for scanned or image-only PDF pages when Tesseract and Poppler are installed
- Resumable folder import for many PDFs with duplicate detection, OCR-aware chunk rebuilds, and an image-only report
- Workspace search with separate sections for documents, symptoms, procedures, and notes
- "Repair Planner" streaming agent that turns a rough repair brief into a prioritized plan, readiness score, owner checklist, and handoff drafts grounded in uploaded PDFs (needs `OPENAI_API_KEY`)
- "Ask your documents" Q&A that retrieves matching uploaded PDF chunks with hybrid keyword+embedding search and uses OpenAI to generate cited answers when configured
- Symptoms with create, edit, delete, filters, sorting, and document links
- Procedures with create, edit, delete, filters, sorting, steps, tools, parts, safety notes, and document links
- Notes with create, edit, delete, filters, sorting, and links to a document, symptom, or procedure
- Settings for the single vehicle profile, document defaults, runtime info, and backup export
- Restore from an exported backup with a pre-restore snapshot and rollback on failure (`npm run restore`), plus a `npm run backup:drill` round-trip check — see [docs/backup-restore.md](docs/backup-restore.md)
- Production serving of the built React app from the Express server
- A Dockerfile for the intended Google Compute Engine deployment path

## Current Limits

The current app does not include:

- user accounts or login
- cloud sync
- multi-vehicle support
- general open-ended AI chat (the Ask and Repair Planner features stay grounded in the uploaded documents and the repair brief)
- a verified current cloud deployment from this branch

The document Q&A and Repair Planner features need `OPENAI_API_KEY` in the server environment. After importing or re-extracting PDFs, run `npm run embed:backfill` so existing chunks, including OCR-created chunks, have current embeddings. Without an OpenAI key, the app keeps working and both features show that AI is not configured. See [docs/repair-planner.md](docs/repair-planner.md) for how the agent, its tools, and the streaming API route work, plus the validation checklist.

Use sample or fake PDFs before sharing a public demo. The app does not have access control yet.

## Tech Stack

- Frontend: React, Vite, Tailwind CSS
- Backend: Node.js, Express
- Database: SQLite through Node's built-in `node:sqlite`
- File storage: local uploaded PDF folder
- Required runtime: Node.js `>=24 <25`

## Start Here

For local setup:

- [Getting started on Windows](docs/getting-started-windows.md)
- [Local development](docs/local-development.md)
- [Environment variables](docs/environment-variables.md)
- [Troubleshooting](docs/troubleshooting.md)

For understanding the app:

- [Architecture](docs/architecture.md)
- [Repair Planner agent](docs/repair-planner.md)
- [Current data model](DATA_MODEL.md)
- [Manual QA checklist](QA_CHECKLIST.md)
- [Roadmap](ROADMAP.md)

For Google Cloud planning:

- [Google Cloud deployment](docs/gcp-deployment.md)
- [Cost control](docs/cost-control.md)

## Quick Local Commands

Run these from the repo root:

```powershell
cd C:\Users\daleb\source\corolla-fix-helper
npm run install:all
npm run dev
```

Open:

- frontend: `http://localhost:5173`
- backend health check: `http://localhost:4000/api/health`

To check the app:

```powershell
npm run lint
npm run typecheck
npm run build
npm run test
```

To bulk import PDFs:

```powershell
npm run import -- "C:\path\to\pdfs"
```

The import report shows imported, skipped, failed, and `IMAGE-ONLY` counts. `IMAGE-ONLY` means PDF text extraction found almost no text. If Tesseract and Poppler are installed, OCR runs on those low-text pages and the OCR text becomes searchable; if they are missing, the document status starts with `ocr_unavailable:`.

## Deployment Note

The intended Google Cloud path is a Google Compute Engine VM running the Docker image from this repo, with persistent storage mounted for the SQLite database and uploaded PDFs.

This branch does not claim the app is currently deployed. Follow [docs/gcp-deployment.md](docs/gcp-deployment.md) only when you intentionally want to create cloud resources.
