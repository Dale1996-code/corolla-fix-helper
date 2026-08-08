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
- `npm run eval:relevance-floor` — calibrates the Ask relevance floor against real positive/negative pairs. The floor ships in shadow mode; run this before arguing for a threshold or enabling `ASK_RELEVANCE_FLOOR`
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
- `src/routes/settings.js` serves `/api/settings` (app settings via `appSettingsService.js`, document defaults, vehicle edits, plus a read-only `ai` status block and the CLI restore command the Settings page displays). The `ai` block exposes `Boolean(config.openAiApiKey)` and **never** the key itself, in any form. Its `GET /backup-export` is wrapped in the local `requireLoopback` guard, so the backup download stays loopback-only even when `NETWORK_MODE=1` opens the rest of the app to the LAN — keep that guard on any route that streams the whole database.
- `src/routes/repairChecklists.js` currently contains the standalone V1 checklist queries and mapping. Its `/api/repair-checklists` routes return ordered checklists, and successful item writes return the refreshed whole checklist; V1 does not link checklists to other entities.
- All single-vehicle lookups go through `src/services/vehicleService.js` (`getVehicle` or `getVehicleId`). Do not repeat the first-row vehicle query in a route or service.
- `symptomService.js` exports `mapSymptomCore` and `procedureService.js` exports `mapProcedureCore`. Full entity views add their cross-entity links on top of those cores; `searchService.js` reuses the cores and `noteService.js`'s `mapNoteRow` instead of duplicating row mapping.

### Dependency injection convention (important for tests)

The repo deliberately avoids heavy dependencies — there is no OpenAI SDK or agents framework. OpenAI calls use raw `fetch` against the Responses API, and every external dependency (model client, retriever) is injectable: `createApp({ askQuestion, runRepairPlan })`, `runRepairPlannerAgent(..., { streamTurn })`. All tests run without an API key by injecting mocks. Follow this pattern for any new AI-touching code.

### The two AI features

Both stay grounded in uploaded PDFs and degrade gracefully to an "AI not configured" state without `OPENAI_API_KEY`:

1. **Ask AI** (`POST /api/ask`): RAG flow. PDF upload/extraction → `documentChunkService.js` writes page-aware chunks to `document_chunks` → `embed:backfill` stores Float32 embedding BLOBs (versioned as `model@dimensions`; a mismatched version is ignored for **semantic** ranking only — the chunk's text still participates in keyword ranking, so a model/dimension change never makes a document vanish from Ask) → `chunkRetrievalService.js` embeds the question, cosine-scans an in-memory embedding cache, and fuses with keyword ranking → `aiAnswerService.js` runs the evidence contract and calls OpenAI.

2. **Repair Planner** (`POST /api/repair-plan`, SSE streaming): a hand-rolled tool-calling agent loop in `server/src/services/agent/` (`repairPlannerAgent.js` loop, `repairTools.js` deterministic tools + JSON schemas, `openAiResponsesClient.js` streaming client, `tracing.js`). Events stream to `RepairPlannerPage.jsx` as `data: <json>` frames (`status`, `tool_call`, `text_delta`, `done`, etc.). `docs/repair-planner.md` documents the event protocol, readiness rubric, and how to add tools.

Ask can optionally attach **one already-saved image** by `attachmentId` (`OPENAI_VISION_MODEL`, falls back to `OPENAI_ANSWER_MODEL`). Retrieval still runs on the text question only, and repair facts must stay grounded in cited PDF chunks — the image is context, not a source.

### Evidence contracts (read before touching either AI feature)

**In their default configuration**, neither feature sends model prose to the browser. Both ask the model for **atomic claims**, each carrying a verbatim `evidenceQuote` and a server-assigned source id (`S1`, `S2`, …), then verify server-side and render the final text from accepted claims only. `askEvidenceContract.js` (Ask, gated by `ASK_EVIDENCE_CONTRACT`, **on by default**) and `agent/repairPlanEvidenceContract.js` (planner, no opt-out) each: validate the reply shape by hand (no new dependency), map source ids back to the chunk they were built from, verify the quote is really a substring of the text the model was shown, run a numeric anomaly detector, and derive the status (`answered`/`partial`/`not_found`; the planner uses `verified`/`partial`/`not_found`) **itself** rather than trusting the model's self-report. Only passages that actually backed a verified claim become citations. Ask's contract is the only one that can be switched off — see the legacy bullet below.

Consequences worth internalizing:

- **Server-assigned ids, never database row ids.** `documentChunkService.js` rebuilds chunk rows on re-extraction, so a row id echoed by the model is meaningless the moment a document is re-extracted.
- **The two features scope those ids differently, and the difference is load-bearing.** Ask's ids are **request-local** — built fresh for one question. The planner's `createSourceRegistry()` is **run-wide**, assigned across the whole run rather than per search, because one chunk can legitimately support two tasks (a torque table cited for the front brakes is the same evidence when the rear brakes need it). Re-scoping planner ids per search would force the model to re-cite identical text under a new name and would reject honest cross-task citations. Also note what the planner verifies against: the model sees a capped `evidenceText` (`EVIDENCE_CONTEXT_CHAR_LIMIT`, 1500 chars), and quotes are checked against **that same capped string**, not the unrestricted stored chunk.
- **Verification is not general semantic entailment — know what it does and does not prove.** It deterministically establishes source identity, quote presence, supported unit-bearing numbers, and lexical subject agreement for common torque wording. It does **not** confirm that a claim follows from its quote: non-numeric claims, pronouns, synonyms, unusual sentence shapes, and a long quote mentioning several parts can all pass verification and still need human judgment. The subject rule deliberately prefers a safe rejection over guessing that two differently-worded part names mean the same thing. `docs/api.md` documents this boundary for API consumers; do not describe verified output as "confirmed correct."
- The planner deliberately does **not** reuse Ask's schema, renderer, or statuses — a question and a task list have different coverage rules. Only three neutral helpers are shared (`checkClaimNumbers`, `quoteAppearsInChunk`, `redactSpecNumbers`).
- Disabling `ASK_EVIDENCE_CONTRACT` is a legacy-compatibility path only, and it is the one case where model prose does reach the browser: the reply keeps that prose but carries `status: "unverified"`, returns `citations: []`, and moves retrieved passages to `retrievedContext`. The UI shows an amber "not document-backed" warning and never renders those passages as citations.
- `safetyClassifier.js` is the **single** rule table behind both "does this block a Ready rating?" (`isSafetyCriticalTask`) and "which warnings does the owner see?" (`detectSafetyFlags`). These were once separate lists that drifted apart. Add hazards as one rule with both fields; `safetyClassifier.test.js` asserts the invariant over the whole table. Its patterns are word-boundary and context-scoped on purpose — the old substring list matched `abs` inside "shock **abs**orber".

### OpenAI call plumbing (two shared leaf modules)

- `openAiModelCapabilities.js` decides which sampling controls a model gets. **Every** call site uses it, streaming and non-streaming alike. **Reasoning-family models (`gpt-5*`, `o1`–`o9`) reject `temperature` outright — a hard 400 that fails the whole request** — and take `reasoning.effort` instead (`none`/`low`/`medium`/`high`/`xhigh`/`max`; `minimal` is rejected). Default effort is `low` because reasoning tokens bill against `OPENAI_MAX_OUTPUT_TOKENS` and can truncate the answer. Never add a per-call-site string check for the model family; extend this module.
- `openAiResponsePayload.js` is the shared **fail-closed** parser for **non-streaming** Responses calls (Ask, rerank, procedure suggestions). The planner does not use it: `agent/openAiResponsesClient.js` consumes an SSE stream and does its own completion-aware parsing off `response.output_text.delta` / `response.completed` events. Keep both paths fail-closed; a fix to one is not automatically a fix to the other. A payload yields text only when the provider reports `status: "completed"` *and* a well-formed non-empty `output_text` exists; a truncated, refused, cancelled, or malformed response yields **no** text — half a repair procedure reads exactly like a whole one. It keeps two separate channels: `failure.message` (safe, user-facing) and `failure.diagnostic` (internal, never sent to the client or logged). Both modules import nothing so all call sites can share them without deepening the existing `aiAnswerService → chunkRetrievalService → chunkRerankService` cycle.
- `OPENAI_ANSWER_MODEL` defaults to a **pinned snapshot, not a floating alias** — an alias would change model behavior underneath the eval suite, making a regression indistinguishable from a model update. Move it deliberately.

### Storage

Everything lives in one SQLite file (`server/data/` by default) plus `server/uploads/` for uploaded files — both configurable via `DATABASE_FILE` / `UPLOADS_DIR`. Documents are PDF-only; symptoms, procedures, and notes can additionally carry JPEG/PNG/WebP **image attachments** (route `attachments.js`, `attachmentService.js`) stored under `UPLOADS_DIR/attachments/images/` with metadata in SQLite. Deletes cascade to both rows and files: deleting a document cleans up related rows (`symptom_documents`, `procedure_documents`, `document_chunks`, note links) and the stored PDF; deleting an owning symptom/procedure/note removes its attachment rows and image files. Schema changes go in `src/initDatabase.js` as a new **numbered migration** (tracked in `schema_migrations`) — never edit an already-applied one. Backups snapshot the DB via `databaseSnapshot.js` (`VACUUM INTO`, not a raw file copy) so WAL-resident rows are captured, and include the whole uploads tree so attachment images are backed up too.

### Conventions & gotchas

- **Rate limiting:** `/api/ask` and `/api/repair-plan` share **one** in-memory 20-req/min limiter window (`middleware/rateLimit.js`), so their combined AI request rate is bounded (~20/min total). The limiter evicts expired windows so its map cannot grow unbounded. Tests can inject a limiter via `createApp({ aiRateLimiter })`. It caps accidental OpenAI spend — it is not authentication.
- **AI accidental-spend guards** (single-user app, not abuse defense): every OpenAI call sends `max_output_tokens` (`OPENAI_MAX_OUTPUT_TOKENS`); the rerank/suggestion calls route through `postToOpenAiResponses` for its 30s timeout and the streaming agent has an idle timeout (`OPENAI_STREAM_IDLE_TIMEOUT_MS`); a coarse daily model-call ceiling (`AI_DAILY_CALL_LIMIT`, 0 disables) in `aiUsageBudget.js` backstops a runaway loop; `/api/repair-plan` caps brief/field length like Ask. `aiUsageBudget.js` **counts always and enforces only when a limit is set**, so Settings → AI can report "AI calls today" even with the ceiling disabled. The counted unit is one **provider request** at the two choke points (not one user action), the day boundary is local midnight, and the counter is in memory — a restart resets it, deliberately (see `docs/evals/ask-rag-iteration-log.md`).
- **Env-gated optional AI:** local OCR (`OCR_ENABLED`, runs only on low-text PDF pages, needs Poppler `pdftoppm` + Tesseract) and a second-pass Ask reranker (`RERANK_ENABLED`, off by default, must fall back to the hybrid order on any failure).
- **Shadow-mode features stay shadow-mode until calibrated.** The per-chunk relevance floor (`relevanceFloor.js`, `ASK_RELEVANCE_FLOOR`, **off**) computes what it *would* drop and reports it through the log-safe metrics channel without changing results. The threshold is uncalibrated and `eval:retrieval` structurally cannot observe the filter (it lives above the retrieval layer, in `askQuestionUsingDocuments`) — use `eval:relevance-floor` instead. The floor also only judges chunks with a real semantic score; dropping keyword-only chunks would silently delete newly-uploaded documents from Ask.
- **Binding is loopback-only by default** (`NETWORK_MODE=0` → host `127.0.0.1`). Phone/LAN/Tailscale reachability is a deliberate opt-in, and the app still has no login — so don't widen the bind, recommend port-forwarding, or use `tailscale funnel` as a fix for "can't reach it from my phone."
- **UI vs route:** the `/search` route is branded **"Ask AI"** in the UI (nav item + page heading + browser tab); the route path, `SearchPage.jsx`, and `/api/search/*` are unchanged. That page hosts two distinct features — the AI panel headed **"Ask a question"** (button **"Ask question"**, `POST /api/ask`) and four keyword-search cards headed **"Search documents/symptoms/procedures/notes"** (`GET /api/search/*`, no API key needed). Never label the AI feature "Search" or the keyword search "Ask".
- **One visible name per feature, from one list.** `client/src/lib/navigation.js` holds every nav label; the destination page's `<h1>` must be that same string, and `PageHeader` derives the browser tab title from the heading it renders via `lib/pageTitle.js` (`<Page> | Corolla Fix Helper`). `App.test.jsx` asserts nav label == `<h1>` == tab title for all nine destinations, and `navigation.test.js` pins the labels and rejects retired ones ("Search", "Ask", "Checklists", "Planner"). The product name is **Corolla Fix Helper**; **"Corolla Fix"** is the only short form and lives only in `manifest.short_name` and `apple-mobile-web-app-title`.
- **View state belongs in the query string, not `useState`.** Filters, pagination, and the selected record on Documents, Ask AI's four search cards, Symptoms, Procedures, Notes, and Repair Checklists are read from the URL through `client/src/lib/urlState.js`, so Back/Forward, refresh, and a pasted link rebuild the same view. Defaults are omitted (an untouched list is just `/documents`); readers never throw on a hand-typed value; `applyParamUpdates` preserves parameters it was not asked about. Navigation steps (filter, page, record) **push**; normalization (clamping a page, clearing a selection that names nothing, a debounced keyword commit) **replaces**. Selection is derived — absence of `documentId`/`symptomId`/… means the page's default record via `resolveSelectedRecord`. Do **not** put a question, an AI answer, or any generated content in the URL. Ask AI's documents card is the only URL-driven **server** fetch: its `documents.page` becomes the API's `limit`/`offset`, and the section's query string is the sole fetch dependency, so one URL change is one request.
- **Windows:** use `services/tarExecutable.js` (resolves the native `%SystemRoot%\System32\tar.exe`) for any tar work — never spawn bare `tar`. Vite/Vitest/build can fail in a sandbox with an esbuild `Access is denied` error; rerun outside the sandbox before treating it as a real failure.

## Docs worth knowing

- `AGENTS.md` — the most detailed running log of conventions, env vars, and recently-verified commands; check it first when this file is thin on a topic
- `docs/architecture.md` — current app structure; `docs/api.md` — per-route `/api` endpoint reference; `docs/onboarding.md` — new-developer walkthrough
- `QA_CHECKLIST.md` — manual verification steps after changes
- `docs/repair-planner.md` — agent internals + validation checklist; `docs/evals/ask-rag-iteration-log.md` — what was actually measured on the Ask RAG pipeline (read before re-litigating a retrieval or grounding decision)
- `docs/environment-variables.md` — every env var with defaults; `.env.example` carries the reasoning behind the non-obvious ones
- `docs/backup-restore.md` — backup contents + safe restore; `docs/runbook.md` — start/stop, health checks, recovery; `docs/mobile-access.md` — phone access (Wi-Fi, Tailscale, Home Screen install)
- `docs/archive/` — superseded plans; don't treat as current
- Cloud docs (`docs/gcp-deployment.md`) describe an *intended* GCE deployment, not a live one
