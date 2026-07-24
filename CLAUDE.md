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
- `npm run smoke` — post-build production smoke test: boots the real app against throwaway database/uploads paths, checks the built frontend, `GET /api/health`, core API routes, Ask's no-key fallback, and a Repair Checklists round trip. Run after `npm run build`
- `npm run import -- "/path/to/pdfs"` — resumable bulk PDF import (MD5 duplicate detection, image-only report)
- `npm run demo:seed` — load the optional sample PDF + chunks. **Normal startup seeds nothing — the workspace is empty by default** (or set `SEED_DEMO`)
- `npm run embed:backfill` — embed `document_chunks` missing the current embedding version; run after importing or re-extracting PDFs
- `npm run eval:retrieval` / `npm run eval:rerank` / `npm run eval:answers` — retrieval, reranker A/B, and answer-quality evals
- `npm run restore -- "/path/to/corolla-fix-helper-backup-*.tar.gz"` — restore a backup archive (validate → snapshot → atomic swap → rollback on failure); stop the server first. `npm run backup:drill` proves the round trip. See `docs/backup-restore.md`

Single test file:

- Server: `cd server && node --test test/app.test.js`
- Client: `cd client && npx vitest run src/pages/NotesPage.test.jsx`

Note: `lint` now covers the whole `server/` tree (`eslint.config.mjs`) and `client/src` (`client/eslint.config.mjs`, a JSX-aware flat config); the root `lint` script runs both. `typecheck` (`tsconfig.json`) now covers the **whole `server/src` tree** (plus a curated set of tests) under `checkJs` with several strict-family flags on. Full `strict` (`strictNullChecks`/`noImplicitAny`) is still off because the untyped JS would produce a large backlog, so a clean run is broad coverage, not exhaustive null/any safety — tighten incrementally rather than flipping `strict` on wholesale.

## Architecture

Two npm workspaces-by-convention (separate `package.json`s, root scripts delegate via `npm --prefix`):

- `client/` — React 19 + React Router + Tailwind. One page component per feature under `src/pages/`, tests co-located (`*.test.jsx`, jsdom + Testing Library).
- `server/` — ES modules. `src/app.js` builds the Express app (`createApp(options)`); `src/index.js` starts it. Routes in `src/routes/` are thin; logic lives in `src/services/`. `src/config.js` reads all env vars (see `.env.example`; key one is `OPENAI_API_KEY`). `src/initDatabase.js` creates/migrates the SQLite schema on startup (documented in `DATA_MODEL.md`).

### Route, service, and mapper conventions

- `src/routes/` owns HTTP parsing, validation, status codes, and response behavior. Dedicated entity services own entity operations and canonical row shaping: `documentService.js`, `symptomService.js`, `procedureService.js`, and `noteService.js`.
- `src/routes/health.js` serves `GET /api/health` with `status: "ok"`; `src/app.js` mounts it at `/api/health`. `GET /api` is the service name/version check.
- `src/routes/repairChecklists.js` currently contains the standalone V1 checklist queries and mapping. Its `/api/repair-checklists` routes return ordered checklists, and successful item writes return the refreshed whole checklist; V1 does not link checklists to other entities.
- All single-vehicle lookups go through `src/services/vehicleService.js` (`getVehicle` or `getVehicleId`). Do not repeat the first-row vehicle query in a route or service.
- `symptomService.js` exports `mapSymptomCore` and `procedureService.js` exports `mapProcedureCore`. Full entity views add their cross-entity links on top of those cores; `searchService.js` reuses the cores and `noteService.js`'s `mapNoteRow` instead of duplicating row mapping.

### Dependency injection convention (important for tests)

The repo deliberately avoids heavy dependencies — there is no OpenAI SDK or agents framework. OpenAI calls use raw `fetch` against the Responses API, and every external dependency (model client, retriever) is injectable: `createApp({ askQuestion, runRepairPlan })`, `runRepairPlannerAgent(..., { streamTurn })`. All tests run without an API key by injecting mocks. Follow this pattern for any new AI-touching code.

### The two AI features

Both stay grounded in uploaded PDFs and degrade gracefully to an "AI not configured" state without `OPENAI_API_KEY`:

1. **Ask your documents** (`POST /api/ask`): RAG flow. PDF upload/extraction → `documentChunkService.js` writes page-aware chunks to `document_chunks` → `embed:backfill` stores Float32 embedding BLOBs (versioned as `model@dimensions`; a mismatched version is ignored for **semantic** ranking only — the chunk's text still participates in keyword ranking, so a model/dimension change never makes a document vanish from Ask) → `chunkRetrievalService.js` embeds the question, cosine-scans an in-memory embedding cache, and fuses with keyword ranking → `aiAnswerService.js` builds citations and calls OpenAI.

2. **Repair Planner** (`POST /api/repair-plan`, SSE streaming): a hand-rolled tool-calling agent loop in `server/src/services/agent/` (`repairPlannerAgent.js` loop, `repairTools.js` deterministic tools + JSON schemas, `openAiResponsesClient.js` streaming client, `tracing.js`). Events stream to `RepairPlannerPage.jsx` as `data: <json>` frames (`status`, `tool_call`, `text_delta`, `done`, etc.). `docs/repair-planner.md` documents the event protocol, readiness rubric, and how to add tools.

Ask can optionally attach **one already-saved image** by `attachmentId` (`OPENAI_VISION_MODEL`, falls back to `OPENAI_ANSWER_MODEL`). Retrieval still runs on the text question only, and repair facts must stay grounded in cited PDF chunks — the image is context, not a source.

### Storage

Everything lives in one SQLite file (`server/data/` by default) plus `server/uploads/` for uploaded files — both configurable via `DATABASE_FILE` / `UPLOADS_DIR`. Documents are PDF-only; symptoms, procedures, and notes can additionally carry JPEG/PNG/WebP **image attachments** (route `attachments.js`, `attachmentService.js`) stored under `UPLOADS_DIR/attachments/images/` with metadata in SQLite. Deletes cascade to both rows and files: deleting a document cleans up related rows (`symptom_documents`, `procedure_documents`, `document_chunks`, note links) and the stored PDF; deleting an owning symptom/procedure/note removes its attachment rows and image files. Schema changes go in `src/initDatabase.js` as a new **numbered migration** (tracked in `schema_migrations`) — never edit an already-applied one. Backups snapshot the DB via `databaseSnapshot.js` (`VACUUM INTO`, not a raw file copy) so WAL-resident rows are captured, and include the whole uploads tree so attachment images are backed up too.

### Conventions & gotchas

- **Rate limiting:** `/api/ask` and `/api/repair-plan` share **one** in-memory 20-req/min limiter window (`middleware/rateLimit.js`), so their combined AI request rate is bounded (~20/min total). The limiter evicts expired windows so its map cannot grow unbounded. Tests can inject a limiter via `createApp({ aiRateLimiter })`. It caps accidental OpenAI spend — it is not authentication.
- **AI accidental-spend guards** (single-user app, not abuse defense): every OpenAI call sends `max_output_tokens` (`OPENAI_MAX_OUTPUT_TOKENS`); the rerank/suggestion calls route through `postToOpenAiResponses` for its 30s timeout and the streaming agent has an idle timeout (`OPENAI_STREAM_IDLE_TIMEOUT_MS`); a coarse daily model-call ceiling (`AI_DAILY_CALL_LIMIT`, 0 disables) in `aiUsageBudget.js` backstops a runaway loop; `/api/repair-plan` caps brief/field length like Ask.
- **Env-gated optional AI:** local OCR (`OCR_ENABLED`, runs only on low-text PDF pages, needs Poppler `pdftoppm` + Tesseract) and a second-pass Ask reranker (`RERANK_ENABLED`, off by default, must fall back to the hybrid order on any failure).
- **UI vs route:** the `/search` route is branded **"Ask AI"** in the UI (nav item + page heading); the route path itself is unchanged.
- **Windows:** use `services/tarExecutable.js` (resolves the native `%SystemRoot%\System32\tar.exe`) for any tar work — never spawn bare `tar`. Vite/Vitest/build can fail in a sandbox with an esbuild `Access is denied` error; rerun outside the sandbox before treating it as a real failure.

## Docs worth knowing

- `AGENTS.md` — the most detailed running log of conventions, env vars, and recently-verified commands; check it first when this file is thin on a topic
- `docs/architecture.md` — current app structure; `docs/api.md` — per-route `/api` endpoint reference; `docs/onboarding.md` — new-developer walkthrough
- `QA_CHECKLIST.md` — manual verification steps after changes
- `docs/repair-planner.md` — agent internals + validation checklist
- `docs/backup-restore.md` — backup contents + safe restore; `docs/runbook.md` — start/stop, health checks, recovery; `docs/mobile-access.md` — phone access (Wi-Fi, Tailscale, Home Screen install)
- `docs/archive/` — superseded plans; don't treat as current
- Cloud docs (`docs/gcp-deployment.md`) describe an *intended* GCE deployment, not a live one
