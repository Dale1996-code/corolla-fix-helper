# Corolla Fix Helper Agent Notes

Keep repo guidance tied to commands and behavior that exist in the current codebase.

## Working Commands

Run these from `C:\Users\daleb\source\corolla-fix-helper`:

- `npm run install:all` installs root, server, and client packages.
- `npm run dev` starts the local backend and frontend together.
- `npm run dev:server` starts only the Express backend.
- `npm run dev:client` starts only the Vite frontend.
- `npm run build` builds the current app. The server build step is still a no-op.
- `npm run build:server` runs the server build placeholder.
- `npm run build:client` builds the Vite frontend.
- `npm run lint` runs ESLint over `server/src`, `server/test`, and `client/src`.
- `npm run typecheck` runs the scoped TypeScript check in `tsconfig.changed.json`.
- `npm run test` runs the backend and frontend test suites.
- `npm run test:server` runs backend tests with Node's built-in test runner.
- `npm run test:client` runs frontend tests with Vitest.
- `npm run import -- "C:\path\to\pdfs"` bulk-imports PDFs from a folder and its subfolders.
- `npm run embed:backfill` embeds existing `document_chunks` with the active OpenAI embedding config and skips chunks already at the current embedding version.
- `npm run eval:retrieval` runs the hybrid retrieval eval and prints keyword-only vs hybrid top-page results.
- `npm run eval:answers` runs the live answer-quality eval against the real embedded database. It skips when `OPENAI_API_KEY` is not set and fails only verified cases.
- `npm run restore -- "C:\path\to\corolla-fix-helper-backup-....tar.gz"` restores a backup archive into the configured database file and uploads folder (stop the server first). See `docs/backup-restore.md`.
- `npm run backup:drill` runs an end-to-end backup + restore round trip on a throwaway temp install with fake data.
- `npm start` starts the Express server, which can serve `client/dist` after `npm run build`.

## Local Workflow Checks

- Required Node.js range: `>=24 <25`.
- Frontend dev URL: `http://localhost:5173`
- Backend URL: `http://localhost:4000`
- Health check: `http://localhost:4000/api/health`
- Use `QA_CHECKLIST.md` for manual verification after changes.

## Repo Shape

- `server/src/app.js` wires the Express API routes and serves `client/dist` when the built frontend exists.
- `server/src/routes/` contains API route modules for dashboard, documents, search, symptoms, procedures, notes, image attachments, settings, Ask, and Repair Planner.
- `server/src/services/` contains document extraction, chunking, retrieval, embedding, search, attachments, backup/restore, app settings, and repair-planner agent helpers.
- `server/src/scripts/` contains repo commands such as folder import, backup drill/restore, embedding backfill, retrieval eval, and answer eval.
- `client/src/pages/` contains the main React page components and colocated frontend tests.
- `docs/archive/` is historical context only; do not treat archived plans as current repo truth without checking live files.

## Current Scope Rules

- The app is local-first for one 2009 Toyota Corolla LE 1.8L.
- Current storage is SQLite plus local uploaded PDF files.
- Current search covers documents, symptoms, procedures, and notes in separate Search page sections.
- Current Repair Planner is a streaming tool-calling agent (`POST /api/repair-plan`, SSE) that plans repairs grounded in uploaded PDFs; it reuses the raw-`fetch` Responses API + dependency-injection conventions and is documented in `docs/repair-planner.md`.
- Current document Q&A uses uploaded PDF chunks, OpenAI embeddings, hybrid keyword+embedding retrieval, and OpenAI answer generation when `OPENAI_API_KEY` is configured.
- Symptoms, procedures, and notes can have saved JPEG, PNG, or WebP attachments. Documents remain PDF-only.
- Ask can optionally include one already-saved image attachment by `attachmentId`. Retrieval still uses only the text question, and repair facts must remain grounded in cited PDF chunks.
- Current AI support uses in-memory cosine search over SQLite-stored embedding BLOBs. It does not include a vector database or general open-ended chat; both AI features stay grounded in uploaded documents and the supplied input.
- Current Google Cloud docs describe an intended deployment path, not proof of an active deployment.

## Storage, Uploads, And PDF Extraction

- If no env override is set, `server/src/config.js` stores SQLite at `server/data/corolla-fix-helper.db` and uploaded PDFs in `server/uploads/`.
- Local env examples are copied to `server/.env`; relative `DATABASE_FILE` and `UPLOADS_DIR` values are relative to the `server/` process working directory.
- Uploaded PDFs are stored on disk, while document rows keep a `server/uploads/...` file path. Deleting a document removes the stored file and clears linked notes.
- Attachment images live under `UPLOADS_DIR/attachments/images/`, with metadata in SQLite. Deleting the owning symptom, procedure, or note also deletes its attachment rows and files.
- Uploads and the folder importer both rebuild `document_chunks` from extracted page text. Re-running extraction for one document also rebuilds its chunks.
- PDF text extraction uses `pdfjs-dist`. Optional OCR runs only on low-text pages when `OCR_ENABLED=true`.
- OCR is local, not OpenAI-based. It needs Poppler `pdftoppm` and Tesseract; missing tools leave text PDFs working but scanned PDFs can show an `ocr_unavailable:` extraction status.
- The folder importer skips duplicates by MD5 hash first and original filename second, keeps going after bad PDFs, and reports imported, skipped, failed, and `IMAGE-ONLY` counts.

## Environment And AI Notes

- Keep real secrets out of docs and commits. Put local secrets in `server/.env` or deployment environment variables.
- `OPENAI_API_KEY` enables generated Ask answers, Repair Planner model calls, embedding backfill, and answer-quality evals.
- `OPENAI_ANSWER_MODEL`, `OPENAI_EMBEDDING_MODEL`, `OPENAI_EMBEDDING_DIMENSIONS`, and `OPENAI_EMBEDDING_BATCH_SIZE` are read by server config. `OPENAI_MODEL` is still accepted as an older fallback for the answer model.
- `OPENAI_VISION_MODEL` is used only when Ask includes a saved image; when unset, it falls back to `OPENAI_ANSWER_MODEL`.
- After importing PDFs or re-running extraction with an OpenAI key configured, run `npm run embed:backfill` so new or OCR-created chunks have current embeddings.

## Deployment And CI Notes

- `Dockerfile` uses Node 24, builds the client, prunes server dev dependencies, and runs `node server/src/index.js` in the runtime image.
- `.dockerignore` excludes `server/data`, `server/uploads`, `.env`, and nested env files, so database files, uploaded PDFs, and secrets are not copied into the image.
- The Docker image does not install Tesseract or Poppler. Do not assume OCR works in a container unless the image or host deployment provides those tools.
- `docs/gcp-deployment.md` targets one Google Compute Engine VM running the Docker image with `/data` mounted for the SQLite database and uploads.
- `.github/workflows/ci.yml` runs on push and pull request with Node 24, then runs `npm run install:all`, `npm run lint`, `npm run typecheck`, and `npm run test`.
- Backup export and restore include the entire uploads tree, so saved attachment images are included. Stop the server before restoring; the restore keeps a pre-restore snapshot beside the database.
- Backup code uses `server/src/services/tarExecutable.js`. On Windows, reuse this helper instead of spawning bare `tar`, because it deliberately selects the native `%SystemRoot%\System32\tar.exe` rather than whichever tar appears first on `PATH`.

## Recently Verified Commands

- 2026-06-12: `npm run test:server` passed 56 backend tests.
- 2026-06-12: `npm run lint` passed.
- 2026-06-12: `npm run typecheck` passed.
- 2026-06-12: `npm run eval:retrieval` passed with 12 eval cases, 12 keyword-wrong cases fixed by hybrid retrieval, and 0 hybrid-wrong cases.
- 2026-06-19: backup, settings-export, and tar-resolution tests passed 16 tests.
- 2026-06-19: `npm run backup:drill` passed and restored fake app data, a PDF, and an attachment image.

## Useful Docs

- `README.md` is the main entry point.
- `docs/local-development.md` explains local setup.
- `docs/environment-variables.md` explains placeholder-only env values.
- `docs/architecture.md` explains current app structure.
- `docs/backup-restore.md` explains backup contents, safe restore behavior, and the round-trip drill.
- `docs/gcp-deployment.md` explains the intended Google Compute Engine path.
- `docs/archive/` contains old plans, generated snapshots, and superseded deployment notes.
