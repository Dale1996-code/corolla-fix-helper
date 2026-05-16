# AGENTS.md

Guidance for AI coding agents working in this repo.

## Project shape

- Product: local-first Corolla repair helper for a 2009 Toyota Corolla LE 1.8L.
- Frontend: `client/` is a React + Vite app.
- Backend: `server/` is a Node.js + Express API.
- Database: SQLite through Node's built-in `node:sqlite` module.
- File storage: uploaded PDFs are stored on local disk.
- Keep V1 local-first. Do not add cloud sync, accounts, AI chat, or deployment changes unless the user explicitly asks.

## Main commands

Run commands from the repo root unless a command uses `--prefix`.

```powershell
npm run install:all
npm run dev
npm run build
npm run test
npm run test:server
npm run test:client
npm start
```

What they do:

- `npm run install:all` installs root, server, and client packages.
- `npm run dev` starts server and client together with `concurrently`.
- `npm run dev:server` runs `npm --prefix server run dev`.
- `npm run dev:client` runs `npm --prefix client run dev`.
- `npm run build` runs the server placeholder build, then `vite build` for the client.
- `npm run test` runs server tests, then client tests.
- `npm start` starts the Express server from `server/src/index.js`.

## Runtime defaults

These defaults are defined in `.env.example` and `server/src/config.js`:

- `PORT=4000`
- `CLIENT_PORT=5173`
- `DATABASE_FILE=./server/data/corolla-fix-helper.db`
- `UPLOADS_DIR=./server/uploads`
- `MAX_UPLOAD_SIZE_MB=20`

The Vite dev server proxies `/api` to `http://localhost:4000`.

## Database and persistence

- The app creates the SQLite database directory automatically.
- The default local database file is `server/data/corolla-fix-helper.db`.
- SQLite WAL mode and foreign keys are enabled in `server/src/database.js`.
- `server/src/initDatabase.js` creates and backfills tables at app startup.
- The app seeds one vehicle record for a 2009 Toyota Corolla LE 1.8L.
- Treat the database file as user data. Do not delete or reset it without explicit approval.

## Uploads and PDFs

- PDF upload form field name is `pdfFile`.
- Non-PDF uploads are rejected by `server/src/routes/documents.js`.
- The upload size limit comes from `MAX_UPLOAD_SIZE_MB`.
- Stored filenames are sanitized with `server/src/utils/sanitizeFilename.js`.
- Uploaded files are written to `UPLOADS_DIR`; the default is `server/uploads`.
- The database stores a relative file path like `server/uploads/<stored-file>`.
- `GET /api/documents/:id/file` serves uploaded PDFs inline from `UPLOADS_DIR`.
- PDF text extraction uses `pdfjs-dist/legacy/build/pdf.mjs` in `server/src/services/pdfService.js`.
- Extraction is best-effort: failures return empty text, a `failed: ...` status, and do not block saving the uploaded document.
- A PDF with no text returns `extractionStatus: "no_text_found"`.

## API and UI conventions

- Express routes are mounted in `server/src/app.js` under `/api`.
- Current API areas: health, dashboard, documents, search, symptoms, procedures, notes, and settings.
- The frontend uses React Router paths such as `/documents`, `/search`, `/symptoms`, `/procedures`, `/notes`, and `/settings`.
- Reuse `client/src/lib/navigation.js` for entity deep links instead of inventing a new navigation pattern.
- Settings runtime paths are read-only in the browser; they come from config and optional `.env` values.
- Backup/export is not wired up in this checkout. Keep wording truthful.

## Deployment notes

- `docs/GCE_DEMO_DEPLOYMENT.md` records a successful Google Compute Engine demo deployment.
- The documented GCE deployment uses Node 24, systemd, and Nginx.
- The documented internal app port is `4000`; public HTTP is port `80`.
- The documented live VM data paths are:
  - `/var/corolla-fix-helper/data/corolla-fix-helper.db`
  - `/var/corolla-fix-helper/uploads`
- Docker is not used by the currently documented GCE deployment.
- This worktree has no `Dockerfile` or `docker-compose.yml`; do not invent Docker build or run commands.
- Commands that affect a real VM, firewall, registry, or billing should be clearly labeled and warned about before running.

## CI and automation

- This worktree has no `.github/` folder, so no GitHub Actions workflow is present here.
- Do not claim CI coverage unless a workflow file is added and verified.

## Verified on 2026-05-15 in this worktree

- `node --version` returned `v24.15.0`.
- `npm run build` was attempted but stopped because `client/node_modules` was missing and `vite` was not found.
- `npm run test` was attempted but stopped because `server/node_modules` was missing and `supertest` was not found.
- `node_modules`, `client/node_modules`, and `server/node_modules` were all absent.

If build or test fails in a fresh worktree with missing package errors, run `npm run install:all` before diagnosing app code.

## Things to avoid changing without explicit approval

- Do not delete or reset `server/data/*.db`.
- Do not delete uploaded files in `server/uploads`.
- Do not edit generated dependency folders or lockfiles unless the task is dependency-related.
- Do not replace the local-first SQLite design with cloud storage unless requested.
- Do not add Docker, CI, deployment, AI, authentication, or backup/export features as drive-by changes.

## Unverified / Needs confirmation

- TODO: `docs/GCE_DEMO_DEPLOYMENT.md` says VM shell access is still needed to confirm the exact app `WorkingDirectory=` and Nginx config file location.
- TODO: Re-run `npm run build` and `npm run test` after `npm run install:all` before treating the current missing-package failures as real app failures.
