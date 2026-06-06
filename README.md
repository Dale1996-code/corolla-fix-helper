# Corolla Fix Helper

Corolla Fix Helper is a local-first repair workspace for one vehicle:

- 2009 Toyota Corolla LE 1.8L

Local-first means the app stores its working data on the computer or server that runs it. The current app uses one SQLite database file and one local uploads folder for PDFs.

## What Works Now

The current codebase includes:

- Dashboard summary cards and recent activity
- PDF document upload, metadata editing, extraction status, favorites, delete cleanup, and PDF open links
- Re-run extraction for one saved document
- Workspace search with separate sections for documents, symptoms, procedures, and notes
- "Ask your documents" Q&A that retrieves matching uploaded PDF chunks and uses OpenAI to generate cited answers when configured
- "Repair Planner" streaming agent that turns a rough repair brief into a prioritized plan, readiness score, owner checklist, and handoff drafts grounded in uploaded PDFs (needs `OPENAI_API_KEY`)
- Symptoms with create, edit, delete, filters, sorting, and document links
- Procedures with create, edit, delete, filters, sorting, steps, tools, parts, safety notes, and document links
- Notes with create, edit, delete, filters, sorting, and links to a document, symptom, or procedure
- Settings for the single vehicle profile, document defaults, runtime info, and backup export
- Production serving of the built React app from the Express server
- A Dockerfile for the intended Google Compute Engine deployment path

## Current Limits

The current app does not include:

- user accounts or login
- cloud sync
- multi-vehicle support
- embeddings or vector search
- general open-ended AI chat (the Ask and Repair Planner features stay grounded in the uploaded documents and the repair brief)
- automatic restore from a backup archive
- a verified current cloud deployment from this branch

The document Q&A and Repair Planner features need `OPENAI_API_KEY` in the server environment. Without that key, the app keeps working and both features show that AI is not configured. See [docs/repair-planner.md](docs/repair-planner.md) for how the agent, its tools, and the streaming API route work, plus the validation checklist.

Use sample or fake PDFs before sharing a public demo. The app does not have access control yet.

## Tech Stack

- Frontend: React, Vite, Tailwind CSS
- Backend: Node.js, Express
- Database: SQLite through Node's built-in `node:sqlite`
- File storage: local uploaded PDF folder
- Required runtime: Node.js `>=24 <25`

## Start Here

For local setup:

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
npm run build
npm run test
```

## Deployment Note

The intended Google Cloud path is a Google Compute Engine VM running the Docker image from this repo, with persistent storage mounted for the SQLite database and uploaded PDFs.

This branch does not claim the app is currently deployed. Follow [docs/gcp-deployment.md](docs/gcp-deployment.md) only when you intentionally want to create cloud resources.
