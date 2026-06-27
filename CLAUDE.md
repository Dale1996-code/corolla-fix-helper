# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Local-first repair workspace for a single vehicle (2009 Toyota Corolla LE 1.8L). React/Vite frontend, Express backend, SQLite via Node's built-in `node:sqlite` (hence the hard requirement **Node >=24 <25**), and a local uploads folder for PDFs. No login, no cloud sync, no multi-vehicle support, no vector database — keep changes inside that scope (see `AGENTS.md` and `docs/architecture.md`).

## Commands

Run from the repo root:

- `npm run install:all` — install root, server, and client packages
- `npm run dev` — backend (`http://localhost:4000`) + frontend (`http://localhost:5173`) together; `dev:server` / `dev:client` for one side
- `npm run test` — both suites; `npm run test:server` (Node built-in test runner) and `npm run test:client` (Vitest)
- `npm run lint` / `npm run typecheck` / `npm run build` — checks; the server build step is a no-op
- `npm start` — production-style: Express serves `client/dist` after `npm run build`
- `npm run import -- "/path/to/pdfs"` — resumable bulk PDF import (MD5 duplicate detection, image-only report)
- `npm run demo:seed` — load the optional sample PDF + chunks. **Normal startup seeds nothing — the workspace is empty by default** (or set `SEED_DEMO`)
- `npm run embed:backfill` — embed `document_chunks` missing the current embedding version; run after importing or re-extracting PDFs
- `npm run eval:retrieval` / `npm run eval:rerank` / `npm run eval:answers` — retrieval, reranker A/B, and answer-quality evals
- `npm run restore -- "/path/to/corolla-fix-helper-backup-*.tar.gz"` — restore a backup archive (validate → snapshot → atomic swap → rollback on failure); stop the server first. `npm run backup:drill` proves the round trip. See `docs/backup-restore.md`

Single test file:

- Server: `cd server && node --test test/app.test.js`
- Client: `cd client && npx vitest run src/pages/NotesPage.test.jsx`

Note: `lint` now covers the whole `server/` tree (`eslint.config.mjs`) and `client/src` (`client/eslint.config.mjs`, a JSX-aware flat config); the root `lint` script runs both. `typecheck` still applies only to an allowlist (`tsconfig.changed.json`) — a clean typecheck run does not mean the rest of the code was checked, so consider adding server files you touch to that list.

## Architecture

Two npm workspaces-by-convention (separate `package.json`s, root scripts delegate via `npm --prefix`):

- `client/` — React 19 + React Router + Tailwind. One page component per feature under `src/pages/`, tests co-located (`*.test.jsx`, jsdom + Testing Library).
- `server/` — ES modules. `src/app.js` builds the Express app (`createApp(options)`); `src/index.js` starts it. Routes in `src/routes/` are thin; logic lives in `src/services/`. `src/config.js` reads all env vars (see `.env.example`; key one is `OPENAI_API_KEY`). `src/initDatabase.js` creates/migrates the SQLite schema on startup (documented in `DATA_MODEL.md`).

### Dependency injection convention (important for tests)

The repo deliberately avoids heavy dependencies — there is no OpenAI SDK or agents framework. OpenAI calls use raw `fetch` against the Responses API, and every external dependency (model client, retriever) is injectable: `createApp({ askQuestion, runRepairPlan })`, `runRepairPlannerAgent(..., { streamTurn })`. All tests run without an API key by injecting mocks. Follow this pattern for any new AI-touching code.

### The two AI features

Both stay grounded in uploaded PDFs and degrade gracefully to an "AI not configured" state without `OPENAI_API_KEY`:

1. **Ask your documents** (`POST /api/ask`): RAG flow. PDF upload/extraction → `documentChunkService.js` writes page-aware chunks to `document_chunks` → `embed:backfill` stores Float32 embedding BLOBs (versioned as `model@dimensions`; mismatched versions are ignored at query time) → `chunkRetrievalService.js` embeds the question, cosine-scans an in-memory embedding cache, and fuses with keyword ranking → `aiAnswerService.js` builds citations and calls OpenAI.

2. **Repair Planner** (`POST /api/repair-plan`, SSE streaming): a hand-rolled tool-calling agent loop in `server/src/services/agent/` (`repairPlannerAgent.js` loop, `repairTools.js` deterministic tools + JSON schemas, `openAiResponsesClient.js` streaming client). Events stream to `RepairPlannerPage.jsx` as `data: <json>` frames (`status`, `tool_call`, `text_delta`, `done`, etc.). `docs/repair-planner.md` documents the event protocol, readiness rubric, and how to add tools.

### Storage

Everything lives in one SQLite file (`server/data/` by default) plus `server/uploads/` for PDF files — both configurable via `DATABASE_FILE` / `UPLOADS_DIR`. Document deletes must clean up related rows (`symptom_documents`, `procedure_documents`, `document_chunks`, note links) and the stored file. Schema changes go in `src/initDatabase.js` as a new **numbered migration** (tracked in `schema_migrations`) — never edit an already-applied one. Backups snapshot the DB via `databaseSnapshot.js` (`VACUUM INTO`, not a raw file copy) so WAL-resident rows are captured.

### Conventions & gotchas

- **Rate limiting:** `/api/ask` and `/api/repair-plan` share an in-memory 20-req/min limiter (`middleware/rateLimit.js`) to cap accidental OpenAI spend — it is not authentication.
- **Env-gated optional AI:** local OCR (`OCR_ENABLED`, runs only on low-text PDF pages, needs Poppler `pdftoppm` + Tesseract) and a second-pass Ask reranker (`RERANK_ENABLED`, off by default, must fall back to the hybrid order on any failure).
- **UI vs route:** the `/search` route is branded **"Ask AI"** in the UI (nav item + page heading); the route path itself is unchanged.
- **Windows:** use `services/tarExecutable.js` (resolves the native `%SystemRoot%\System32\tar.exe`) for any tar work — never spawn bare `tar`. Vite/Vitest/build can fail in a sandbox with an esbuild `Access is denied` error; rerun outside the sandbox before treating it as a real failure.

## Docs worth knowing

- `QA_CHECKLIST.md` — manual verification steps after changes
- `docs/repair-planner.md` — agent internals + validation checklist
- `docs/archive/` — superseded plans; don't treat as current
- Cloud docs (`docs/gcp-deployment.md`) describe an *intended* GCE deployment, not a live one
