# Corolla Fix Helper Agent Notes

Keep repo guidance tied to commands and behavior that exist in the current codebase.

## Working Commands

Run these from `C:\Users\daleb\source\corolla-fix-helper`:

- `npm run install:all` installs root, server, and client packages.
- `npm run dev` starts the local backend and frontend together.
- `npm run dev:server` starts only the Express backend.
- `npm run dev:client` starts only the Vite frontend.
- `npm run build` builds the current app. The server build step is still a no-op.
- `npm run test` runs the backend and frontend test suites.
- `npm run test:server` runs backend tests with Node's built-in test runner.
- `npm run test:client` runs frontend tests with Vitest.
- `npm run embed:backfill` embeds existing `document_chunks` with the active OpenAI embedding config and skips chunks already at the current embedding version.
- `npm run eval:retrieval` runs the hybrid retrieval eval and prints keyword-only vs hybrid top-page results.
- `npm start` starts the Express server, which can serve `client/dist` after `npm run build`.

## Local Workflow Checks

- Frontend dev URL: `http://localhost:5173`
- Backend URL: `http://localhost:4000`
- Health check: `http://localhost:4000/api/health`
- Use `QA_CHECKLIST.md` for manual verification after changes.

## Current Scope Rules

- The app is local-first for one 2009 Toyota Corolla LE 1.8L.
- Current storage is SQLite plus local uploaded PDF files.
- Current search covers documents, symptoms, procedures, and notes in separate Search page sections.
- Current Repair Planner is a streaming tool-calling agent (`POST /api/repair-plan`, SSE) that plans repairs grounded in uploaded PDFs; it reuses the raw-`fetch` Responses API + dependency-injection conventions and is documented in `docs/repair-planner.md`.
- Current document Q&A uses uploaded PDF chunks, OpenAI embeddings, hybrid keyword+embedding retrieval, and OpenAI answer generation when `OPENAI_API_KEY` is configured.
- Current AI support uses in-memory cosine search over SQLite-stored embedding BLOBs. It does not include a vector database or general open-ended chat; both AI features stay grounded in uploaded documents and the supplied input.
- Current Google Cloud docs describe an intended deployment path, not proof of an active deployment.

## Useful Docs

- `README.md` is the main entry point.
- `docs/local-development.md` explains local setup.
- `docs/environment-variables.md` explains placeholder-only env values.
- `docs/architecture.md` explains current app structure.
- `docs/gcp-deployment.md` explains the intended Google Compute Engine path.
- `docs/archive/` contains old plans, generated snapshots, and superseded deployment notes.
