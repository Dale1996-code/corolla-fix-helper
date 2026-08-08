# Corolla Fix Helper Agent Notes

Keep repo guidance tied to commands and behavior that exist in the current codebase.

## Working Commands

Run these from `C:\Users\daleb\source\corolla-fix-helper`:

- `npm run install:all` installs root, server, and client packages.
- `powershell -ExecutionPolicy Bypass -File .\start-corolla-helper.ps1` runs the Windows guided setup: it creates `server\.env` if missing, prompts for an OpenAI key, optionally imports PDFs, runs `npm run embed:backfill`, builds, and starts the app. It is interactive and writes local `server\.env`, so do not run it in non-interactive automation unless that setup is the goal.
- `npm run dev` starts the local backend and frontend together.
- `npm run dev:server` starts only the Express backend.
- `npm run dev:client` starts only the Vite frontend.
- `npm run build` builds the current app. The server build step is still a no-op.
- `npm run build:server` runs the server build placeholder.
- `npm run build:client` builds the Vite frontend.
- `npm run lint` runs ESLint over `server/src`, `server/test`, and `client/src`.
- `npm run typecheck` type-checks the whole `server/src` tree (plus a curated set of tests) via `tsconfig.json`. It runs with `checkJs` and several strict-family flags, but full `strict` (`strictNullChecks`/`noImplicitAny`) is still off, so a clean run is broad coverage, not exhaustive null/any safety.
- `npm run test` runs the backend and frontend test suites.
- `npm run test:server` runs backend tests with Node's built-in test runner.
- `npm run test:client` runs frontend tests with Vitest.
- `npm run import -- "C:\path\to\pdfs"` bulk-imports PDFs from a folder and its subfolders.
- `npm run demo:seed` explicitly loads the optional sample maintenance PDF and chunks. Normal startup does not seed demo documents.
- `npm run embed:backfill` embeds existing `document_chunks` with the active OpenAI embedding config and skips chunks already at the current embedding version.
- `npm run eval:retrieval` runs the hybrid retrieval eval and prints keyword-only vs hybrid top-page results.
- `npm run eval:rerank` A/B-compares fusion-only retrieval against the optional LLM reranker.
- `npm run eval:answers` runs the live answer-quality eval against the real embedded database. It skips when `OPENAI_API_KEY` is not set and fails only verified cases.
- `npm run eval:relevance-floor` calibrates the shadow-mode Ask relevance floor against real positive/negative pairs. It is the only eval that can observe the floor: `eval:retrieval` imports the retrieval layer alone, while the floor sits above it inside `askQuestionUsingDocuments`. Run it before proposing a threshold or enabling `ASK_RELEVANCE_FLOOR`.
- `npm run restore -- "C:\path\to\corolla-fix-helper-backup-....tar.gz"` restores a backup archive into the configured database file and uploads folder (stop the server first). It takes one path argument, runs with no confirmation prompt, and snapshots the current data to `pre-restore-<timestamp>` before swapping. Restore is CLI-only — the Settings page shows this command rather than offering a restore button. See `docs/backup-restore.md`.
- `npm run backup:drill` runs an end-to-end backup + restore round trip on a throwaway temp install with fake data.
- `npm run smoke` runs a production-style smoke test against the real Express app with throwaway database/uploads paths. Run it after `npm run build` when checking a production build.
- `npm start` starts the Express server, which can serve `client/dist` after `npm run build`.

## Local Workflow Checks

- Required Node.js range: `>=24 <25`.
- Frontend dev URL: `http://localhost:5173`
- Backend URL: `http://localhost:4000`
- Health check: `http://localhost:4000/api/health`
- Production-style local start is `npm run build` then `npm start`. `server/src/index.js` prints `localhost` plus best-effort phone URLs for same-Wi-Fi, Tailscale, and HTTPS `tailscale serve` install access when those are detectable.
- Use `QA_CHECKLIST.md` for manual verification after changes.
- In dev, `client/vite.config.js` proxies `/api` to `http://localhost:4000`; if the backend `PORT` changes, update the Vite proxy target and `CORS_ORIGIN` together.
- For PowerShell API examples with JSON bodies, prefer `Invoke-RestMethod`; `docs/api.md` documents that Windows PowerShell 5.1 can mangle inline JSON passed to `curl.exe`. Plain GET/download requests and multipart uploads still use `curl.exe`.
- On Windows, Vite/Vitest/build commands can fail inside the sandbox with an esbuild `Access is denied` error. Rerun outside the sandbox before treating that as a code failure.
- `npm run build` writes generated frontend output under `client/dist`; do not hand-edit generated files.

## Repo Shape

- `server/src/app.js` wires the Express API routes and serves `client/dist` when the built frontend exists.
- `server/src/routes/` contains API route modules for dashboard, documents, search, symptoms, procedures, notes, repair checklists, image attachments, settings, Ask, and Repair Planner.
- `server/src/services/` contains document extraction, chunking, retrieval, embedding, search, attachments, backup/restore, app settings, single-vehicle lookup, document/symptom/procedure/note helpers, and repair-planner agent helpers.
- Five leaf modules under `server/src/services/` are shared by the AI call sites: `askEvidenceContract.js` (claim verification, plus the three neutral helpers the planner reuses), `safetyClassifier.js` (the one hazard rule table), `relevanceFloor.js` (shadow-mode chunk filter), `openAiModelCapabilities.js` (per-model request tuning, used by every call site including the streaming client), and `openAiResponsePayload.js` (fail-closed parsing for non-streaming calls only). Four import nothing at all; `askEvidenceContract.js` imports only Node's built-in `node:crypto`. Keeping them dependency-free is deliberate — it lets every call site share them without deepening the existing `aiAnswerService` → `chunkRetrievalService` → `chunkRerankService` → `aiAnswerService` import cycle. Extend these instead of adding a local copy at a call site.
- `server/src/scripts/` contains repo commands such as folder import, backup drill/restore, smoke testing, embedding backfill, retrieval eval, and answer eval.
- `client/src/pages/` contains the main React page components and colocated frontend tests. Shared presentational pieces live under `client/src/components/`.
- `client/public/` contains install/offline assets: `manifest.webmanifest`, `sw.js`, `offline.html`, icons, and splash images.
- `docs/archive/` is historical context only; do not treat archived plans as current repo truth without checking live files.

## Route, Service, And Mapper Conventions

- `server/src/routes/health.js` serves `GET /api/health` with `{ status: "ok", message }`; `server/src/app.js` mounts it at `/api/health`. The `/api` route is the service name/version check.
- `server/src/routes/repairChecklists.js` currently contains the standalone V1 checklist queries and row mapping. It serves `/api/repair-checklists` and `/api/repair-checklists/:id` plus item add/edit/delete/move routes; list results are newest-activity-first, and successful item writes return the refreshed whole checklist. It is built by `createRepairChecklistsRouter({ planRuns })` (default export `repairChecklistsRouter` unchanged) so `POST /from-planner` can be driven with an injected draft store in tests.
- Routes own HTTP parsing, validation, status codes, and response behavior. Dedicated entity services own entity operations and canonical row shaping: `documentService.js`, `symptomService.js`, `procedureService.js`, and `noteService.js`.
- All single-vehicle lookups go through `server/src/services/vehicleService.js` (`getVehicle` or `getVehicleId`) instead of repeating the first-row vehicle query.
- `symptomService.js` exports `mapSymptomCore` and `procedureService.js` exports `mapProcedureCore`. Full entity mappers add their cross-entity links on top of those cores; `searchService.js` must reuse the exported cores and `noteService.js`'s `mapNoteRow` rather than duplicating row mapping in routes or search code.

## Current Scope Rules

- The app is local-first for one 2009 Toyota Corolla LE 1.8L.
- Current storage is SQLite plus local uploaded PDF files.
- **Visible naming is a contract; the code's identifiers are not.** The product is "Corolla Fix Helper" in every user-facing place (tab title, app header, manifest `name`, docs); "Corolla Fix" is the ONLY sanctioned short form and only in `manifest.short_name` + `apple-mobile-web-app-title`, where the platform truncates. Each feature has exactly one visible name — Documents, Ask AI, Search, Repair Planner, Repair Checklists, Symptoms, Procedures, Notes, Settings — and `client/src/lib/navigation.js` is its single source: the nav item, the destination page's `<h1>`, and the browser tab title are all that same string, because `PageHeader` derives `document.title` from the heading it renders (`lib/pageTitle.js`, `formatPageTitle`). `App.test.jsx` asserts the three agree for every nav item. Do NOT rename routes, `SearchPage.jsx`, API paths, tables, or env vars to chase a label change.
- **List view state is query-string state.** Filters, pagination, and the selected record on Documents, Ask AI's four search cards, Symptoms, Procedures, Notes, and Repair Checklists are read from the URL via `client/src/lib/urlState.js` — not mirrored into `useState`, because a mirrored copy is the one the browser's Back button cannot restore. The contract: defaults are omitted so an untouched list is just `/documents`; every reader is total and falls back rather than throwing on a hand-typed value (`page=abc` is page 1, a non-integer `documentId` is no selection); `applyParamUpdates` carries through parameters the page does not recognise; navigation steps (applying a filter, changing page, picking a record) push while normalization (clamping an out-of-range page, clearing a selection that names nothing, the debounced commit of a live-typing keyword box) replaces; and selection is derived, with an absent id parameter meaning the page's default record (`resolveSelectedRecord`). A selection id that names no loaded record is cleared; one merely hidden by a filter is kept so loosening the filter restores it. Never put a question, an AI answer, or any generated content in the URL. Ask AI's documents card is the only section whose **server** fetch is URL-driven — `documents.page` becomes the API's `limit`/`offset`, the section's query string is the sole fetch dependency (one URL change, one request), and the `requestSeq` stale-response guard still applies. Coverage lives in `lib/urlState.test.js`, `pages/UrlViewState.test.jsx`, and the H7 block at the end of `pages/SearchPagePagination.test.jsx`.
- The `/search` route is branded "Ask AI" in the UI. It holds TWO separate features that merely share a page: the AI panel headed "Ask a question" (`POST /api/ask`, button "Ask question") and, below it, four keyword-search cards headed "Search documents" / "Search symptoms" / "Search procedures" / "Search notes" (`GET /api/search/*`, deterministic SQL, no API key needed). Do not merge them, and do not label the AI feature "Search" or the keyword search "Ask".
- Current Repair Planner is a streaming tool-calling agent (`POST /api/repair-plan`, SSE) that plans repairs grounded in uploaded PDFs; it reuses the raw-`fetch` Responses API + dependency-injection conventions and is documented in `docs/repair-planner.md`.
- Current Repair Checklists is an additive local checklist feature at `/repair-checklists` and `/api/repair-checklists`. It stores standalone job checklists with status (`planned`, `in_progress`, `blocked`, `done`) and ordered check-off items; successful create, metadata, and item writes apply a returned whole-checklist payload, and item activity moves the checklist to the top of the list. V1 does not link checklists to symptoms, procedures, notes, documents, or image attachments.
- A completed Repair Planner run can be SAVED as one of those ordinary checklists via `POST /api/repair-checklists/from-planner`, whose body is `{ checklistDraftId }` and nothing else. The draft is built server-side by `agent/plannerChecklistDraft.js` from validated planner output and held in `agent/planRunStore.js` under an id separate from `planRunId` (every completed run gets a `checklistDraftId`; only a safety-critical one gets a `planRunId`). The checklist and its items are written in one transaction, a repeated save returns the existing checklist rather than a duplicate, and an expired draft is a 404. Notes carry accepted claims with document/page, verified requirements, and safety warnings — never model prose, gaps, placeholder steps, handoff drafts, readiness state, or rejected claims. There is no migration and no stored planner-to-checklist relationship; see `docs/repair-planner.md`.
- Current document Q&A uses uploaded PDF chunks, OpenAI embeddings, hybrid keyword+embedding retrieval, and OpenAI answer generation when `OPENAI_API_KEY` is configured.
- In their default configuration, neither AI feature shows raw model prose. Both request atomic claims carrying a verbatim `evidenceQuote` and a server-assigned source id (`S1`, `S2`, ...), then the server validates the shape, maps each id back to the chunk it was built from, checks the quote really is a substring of the text the model was shown, runs a numeric anomaly detector, derives the status itself, and renders the reply from accepted claims only. Ask uses `askEvidenceContract.js` (statuses `answered` / `partial` / `not_found`); the planner uses `agent/repairPlanEvidenceContract.js` (statuses `verified` / `partial` / `not_found`). Only passages that actually backed a verified claim are cited. Ask's contract is the only one with an off switch (`ASK_EVIDENCE_CONTRACT=false`, legacy — see the env notes); the planner's is unconditional.
- Use server-assigned source ids, never database row ids, in anything the model sees or returns. `documentChunkService.js` rebuilds chunk rows on re-extraction, so a row id echoed back by the model stops meaning anything the moment a document is re-extracted.
- The two features scope those ids differently and the difference is deliberate. Ask's ids are request-local, built for a single question. The planner's `createSourceRegistry()` assigns ids across the WHOLE run, not per search, because one chunk can legitimately support two tasks — a torque table cited for the front brakes is the same evidence when the rear brakes need it. Do not "fix" the planner by resetting ids between searches: that forces the model to re-cite identical text under a new name and rejects honest cross-task citations.
- The planner shows the model a capped `evidenceText` (`EVIDENCE_CONTEXT_CHAR_LIMIT`, 1500 characters) and verifies quotes against that same capped string, not against the unrestricted stored chunk. The full retrieved text stays server-side in the registry.
- Evidence verification is not general semantic entailment, and agent-facing guidance should not imply it is. It deterministically proves source identity, quote presence, supported unit-bearing numbers, and lexical subject agreement for common torque wording. It does not prove a claim follows from its quote — non-numeric claims, pronouns, synonyms, unusual sentence shapes, and a long quote naming several parts can pass and still need human judgment. The subject rule favors a safe rejection over guessing that two differently worded part names are equal. `docs/api.md` states this boundary for API consumers; keep the two descriptions in agreement.
- The planner deliberately does not reuse Ask's schema, renderer, or `answered` status: Ask answers one question while the planner covers a task list, so their coverage rules differ. Only three neutral, config-free helpers are shared from `askEvidenceContract.js` — `checkClaimNumbers`, `quoteAppearsInChunk`, and `redactSpecNumbers`.
- `safetyClassifier.js` holds one rule table driving both `isSafetyCriticalTask()` (does this block a "Ready" rating?) and `detectSafetyFlags()` (which warnings does the owner see?). These were once two independent systems in `agent/repairTools.js` and had drifted apart, so hazards blocked readiness with no stated reason and cooling work warned without blocking. Add a hazard as a single rule carrying both fields; `safetyClassifier.test.js` asserts the invariant across the whole table. Keep patterns word-bounded and context-scoped — the old substring list matched `abs` inside "shock absorber" and filed shock replacement as brake work.
- Current Ask retrieval can optionally run a second-pass LLM reranker when `RERANK_ENABLED=true`; it is off by default and must fall back to the original hybrid order on any failure.
- Symptoms and procedures can be manually linked in both directions. `GET /api/symptoms/:id/suggested-procedures` suggests existing procedures only; it uses keyword/system fallback without an API key and optional grounded LLM ranking with an API key.
- Symptoms, procedures, and notes can have saved JPEG, PNG, or WebP attachments. Documents remain PDF-only.
- Ask can optionally include one already-saved image attachment by `attachmentId`. Retrieval still uses only the text question, and repair facts must remain grounded in cited PDF chunks.
- Current AI support uses in-memory cosine search over SQLite-stored embedding BLOBs. It does not include a vector database or general open-ended chat; both AI features stay grounded in uploaded documents and the supplied input.
- Current Google Cloud docs describe an intended deployment path, not proof of an active deployment.

## Mobile, Phone Access, And Offline Notes

- Phone access is local/private-network access, not cloud sync. `server/src/services/networkAddresses.js` only builds startup-banner URLs and must degrade to fewer lines, never a startup failure, if interfaces or the Tailscale CLI are unavailable.
- Tailscale MagicDNS and `tailscale serve` detection are best-effort. The HTTPS `tailscale serve` URL is the recommended iPhone install URL because service workers require a secure origin; plain HTTP same-Wi-Fi access still works, but without the offline fallback page.
- `client/src/main.jsx` registers the service worker only in production secure contexts. `client/public/sw.js` deliberately caches only `/offline.html` and `/icon.svg`, serves navigations network-first with offline-page fallback, and never intercepts `/api` or `/api/*`.
- `server/src/app.js` reinforces the same boundary by sending `Cache-Control: no-store` for `/api` responses and `Cache-Control: no-cache` for `sw.js`. If you change PWA/offline behavior, keep repair data network-only and update `client/src/serviceWorker.test.js`.
- Do not recommend router port-forwarding or `tailscale funnel` for this app unless authentication and public-exposure protections are added; the current app has no login.

## Storage, Uploads, And PDF Extraction

- If no env override is set, `server/src/config.js` stores SQLite at `server/data/corolla-fix-helper.db` and uploaded PDFs in `server/uploads/`.
- Local env examples are copied to `server/.env`; relative `DATABASE_FILE` and `UPLOADS_DIR` values are relative to the `server/` process working directory.
- Normal startup creates the single vehicle row but does not seed the sample/demo PDF unless `SEED_DEMO` is truthy. Use `npm run demo:seed` for the sample data path.
- Schema changes are tracked in `schema_migrations`. Add a new numbered migration in `server/src/initDatabase.js` instead of editing an already-applied migration.
- Uploaded PDFs are stored on disk, while document rows keep a `server/uploads/...` file path. Deleting a document removes the stored file and clears linked notes.
- Attachment images live under `UPLOADS_DIR/attachments/images/`, with metadata in SQLite. Deleting the owning symptom, procedure, or note also deletes its attachment rows and files.
- Uploads and the folder importer both rebuild `document_chunks` from extracted page text. Re-running extraction for one document also rebuilds its chunks.
- Documents whose chunks are missing current embeddings expose an `embeddingPending` flag; keyword search still works, but semantic ranking needs `npm run embed:backfill`.
- PDF text extraction uses `pdfjs-dist`. Optional OCR runs only on low-text pages when `OCR_ENABLED=true`.
- OCR is local, not OpenAI-based. It needs Poppler `pdftoppm` and Tesseract; missing tools leave text PDFs working but scanned PDFs can show an `ocr_unavailable:` extraction status.
- The folder importer skips duplicates by MD5 hash only; two byte-distinct files that share a basename both import (the stored filename is disambiguated). It keeps going after bad PDFs and reports imported, skipped, failed, and `IMAGE-ONLY` counts.

## Environment And AI Notes

- Keep real secrets out of docs and commits. Put local secrets in `server/.env` or deployment environment variables.
- `PORT`, `CLIENT_PORT`, `CORS_ORIGIN`, `DATABASE_FILE`, `UPLOADS_DIR`, `MAX_UPLOAD_SIZE_MB`, OpenAI model settings, reranker settings, and OCR settings are read in `server/src/config.js`; `.env.example` and `docs/environment-variables.md` are the current reference for placeholders and defaults.
- `OPENAI_API_KEY` enables generated Ask AI answers, Repair Planner model calls, AI-assisted procedure suggestions, optional reranking, embedding backfill, and answer-quality evals.
- `OPENAI_ANSWER_MODEL`, `OPENAI_EMBEDDING_MODEL`, `OPENAI_EMBEDDING_DIMENSIONS`, and `OPENAI_EMBEDDING_BATCH_SIZE` are read by server config. `OPENAI_MODEL` is still accepted as an older fallback for the answer model.
- `OPENAI_VISION_MODEL` is used only when Ask includes a saved image; when unset, it falls back to `OPENAI_ANSWER_MODEL`.
- `OPENAI_ANSWER_MODEL` defaults to a pinned dated snapshot, not a floating alias. An alias would change model behavior underneath the eval suite, making a real regression indistinguishable from a model update. Move the pin deliberately and re-run the evals when you do.
- Reasoning-family models (`gpt-5*`, `o1`–`o9`) reject `temperature` outright — a hard 400 that fails the whole request — and take `reasoning.effort` instead. `openAiModelCapabilities.js` is the single place that decides which sampling controls a model gets; extend it rather than adding a model-name string check at a call site. Accepted efforts are `none`, `low`, `medium`, `high`, `xhigh`, `max` (`minimal` is rejected). `OPENAI_REASONING_EFFORT` defaults to `low` because reasoning tokens bill against `OPENAI_MAX_OUTPUT_TOKENS`, so a higher effort can consume the budget and truncate the answer.
- `openAiResponsePayload.js` parses **non-streaming** Responses API payloads fail-closed — Ask, the reranker, and procedure suggestions. The streaming planner does not go through it: `agent/openAiResponsesClient.js` reads the SSE event stream and applies its own completion-aware handling via `response.output_text.delta` and `response.completed`. Both paths must stay fail-closed independently; patching one does not patch the other. In the non-streaming parser, text is returned only when the provider reports `status: "completed"` and at least one well-formed non-empty `output_text` is present. A truncated, refused, cancelled, or malformed response yields no text at all, because half a repair procedure reads exactly like a whole one. It keeps two channels separate — `failure.message` is safe and user-facing, `failure.diagnostic` is internal detail that is never sent to the client and never logged.
- `ASK_EVIDENCE_CONTRACT` is on by default. Setting it false is a legacy-compatibility path only: the prose is then labeled unverified and retrieved passages are not presented as citations.
- `ASK_RELEVANCE_FLOOR` is off by default and `relevanceFloor.js` runs in shadow mode — it computes exactly what it would drop, reports that through the log-safe metrics channel, and changes nothing. The threshold is uncalibrated (it was never derived from real positive/negative pairs), so enable it only after `npm run eval:relevance-floor` justifies a value. The floor judges only chunks with a real semantic score; dropping keyword-only chunks would silently remove newly-uploaded documents from Ask, which is the same failure the embedding-version degradation logic exists to prevent.
- `OPENAI_MAX_OUTPUT_TOKENS`, `OPENAI_STREAM_IDLE_TIMEOUT_MS`, and `AI_DAILY_CALL_LIMIT` are accidental-spend guards for a single-user app, not abuse defense. Every model call sends `max_output_tokens`; the streaming agent aborts after that many ms of silence; `aiUsageBudget.js` enforces a coarse daily call ceiling as a runaway-loop backstop (0 disables it).
- `aiUsageBudget.js` **counts and enforces separately**. `reserveAiCall()` always increments the daily counter and only throws when a limit is configured, so the "AI calls today" figure stays truthful with `AI_DAILY_CALL_LIMIT=0` (the owner's posture). `getAiUsageSnapshot()` is the read-only view Settings uses and never increments. The counted unit is **one provider request** at the two choke points (`postToOpenAiResponses`, `streamResponsesTurn`) — not one user action: an Ask can send a rewrite, a rerank, and an answer, and a planner run sends one per agent turn. Embedding calls are not counted, and a call refused by the ceiling is not counted. The day key is **local** midnight and the counter is in module memory (a restart resets it) — persisting it was deliberately rejected, see `docs/evals/ask-rag-iteration-log.md`.
- `GET /api/settings` returns an `ai` block (`apiKeyConfigured`, `model`, `callsToday`, `countingBasis`, `dayBoundary`, `dailyCallLimit`, `countPersistsAcrossRestart`) that the Settings page's AI card renders. Only a boolean is derived from `OPENAI_API_KEY` — never the key, a prefix, or a masked form of it. Keep it that way when extending the block.
- `NETWORK_MODE` defaults to `0`, binding the server to `127.0.0.1`. Reaching the app from a phone or another LAN/Tailscale device is a deliberate opt-in (`NETWORK_MODE=1` → `0.0.0.0`). The app still has no login, so do not widen the bind as a fix for "can't reach it from my phone."
- `GET /api/settings/backup-export` is wrapped in `requireLoopback` inside `server/src/routes/settings.js`, so the backup download stays loopback-only even when `NETWORK_MODE=1` exposes the rest of the app. Keep that guard on any route that streams the whole database.
- `ASK_DEBUG_METRICS=true` is a dev-only Ask visibility flag. It adds log-safe metrics (durations, counts, sizes, numeric IDs; no document text) to `/api/ask` responses and answer eval output, and it is off by default.
- `RERANK_ENABLED`, `RERANK_CANDIDATE_LIMIT`, and `OPENAI_RERANK_MODEL` control the optional Ask reranker. The rerank model falls back to the answer model when unset.
- After importing PDFs or re-running extraction with an OpenAI key configured, run `npm run embed:backfill` so new or OCR-created chunks have current embeddings.
- `/api/ask` and `/api/repair-plan` share **one** in-memory 20-requests-per-minute limiter window (their combined AI request rate is bounded, not one window each); it evicts expired windows so the map cannot grow unbounded. A limiter can be injected in tests via `createApp({ aiRateLimiter })`. It reduces accidental OpenAI spend but is not a substitute for authentication on any public deployment.
- Every response carries baseline security headers set in `src/app.js` (`X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: no-referrer`, and a self-only `Content-Security-Policy`). The CSP assumes same-origin assets and PDFs opened in new tabs — if you add a CDN, external font host, or an embedded (`<iframe>`/`<object>`) viewer, widen the matching directive.
- `src/database.js` sets `PRAGMA busy_timeout = 5000` so a concurrent writer (import/backfill alongside the server) waits briefly instead of failing with `SQLITE_BUSY`.
- Both upload routes cap `files`/`fields`/`parts` (not just `fileSize`); multer is pinned `>= 2.2.0`. Keep the server audit clean (`npm --prefix server audit`).
- Bulk import (`importFolder.js`) dedups strictly on MD5. Two distinct files that share a basename both import (the on-disk stored name is disambiguated); only byte-for-byte duplicates are skipped.

## Deployment And CI Notes

- `Dockerfile` uses Node 24, builds the client, prunes server dev dependencies, installs the OCR tools (`poppler-utils` + `tesseract-ocr`) in the runtime image, and runs `node server/src/index.js`.
- `.dockerignore` excludes `server/data`, `server/uploads`, `.env`, and nested env files, so database files, uploaded PDFs, and secrets are not copied into the image.
- The Docker runtime image installs Tesseract and Poppler, so OCR of scanned PDFs works in a container out of the box (matching the default `OCR_ENABLED=true`). Set `OCR_ENABLED=false` to skip OCR.
- `docs/gcp-deployment.md` targets one Google Compute Engine VM running the Docker image with `/data` mounted for the SQLite database and uploads.
- The documented Docker build path is `docker build -t "$IMAGE" .` followed by `docker push "$IMAGE"` for Artifact Registry; the VM run command mounts `/opt/corolla-fix-helper-data:/data` and sets `DATABASE_FILE=/data/corolla-fix-helper.db` plus `UPLOADS_DIR=/data/uploads` so SQLite/uploads persist.
- `.github/workflows/ci.yml` runs on push and pull request with Node 24, then runs `npm run install:all`, `npm run lint`, `npm run typecheck`, `npm run test`, `npm run build`, and `npm run smoke`.
- `npm run smoke` (`server/src/scripts/smokeTest.js`) is a post-build production smoke test: it boots the real Express app against a throwaway DB/uploads dir and makes live HTTP requests to confirm the built frontend is served, `GET /api/health` and the core API routes respond, Ask degrades gracefully without an API key, Repair Checklists can round-trip a checklist, and PWA assets (`manifest.webmanifest`, `apple-touch-icon.png`, `sw.js`, `offline.html`) are served. Run it after `npm run build`.
- Backup export and restore include the entire uploads tree, so saved attachment images are included. Stop the server before restoring; the restore keeps a pre-restore snapshot beside the database.
- Backup export and archive creation use `server/src/services/databaseSnapshot.js` (`VACUUM INTO`) instead of raw `.db` copies so committed rows still in SQLite's WAL sidecar are included.
- Backup code uses `server/src/services/tarExecutable.js`. On Windows, reuse this helper instead of spawning bare `tar`, because it deliberately selects the native `%SystemRoot%\System32\tar.exe` rather than whichever tar appears first on `PATH`.

## Recently Verified Commands

- 2026-06-12: `npm run test:server` passed 56 backend tests.
- 2026-06-12: `npm run lint` passed.
- 2026-06-12: `npm run typecheck` passed.
- 2026-06-12: `npm run eval:retrieval` passed with 12 eval cases, 12 keyword-wrong cases fixed by hybrid retrieval, and 0 hybrid-wrong cases.
- 2026-06-19: backup, settings-export, and tar-resolution tests passed 16 tests.
- 2026-06-19: `npm run backup:drill` passed and restored fake app data, a PDF, and an attachment image.
- 2026-06-26: `npm run lint` passed.
- 2026-06-26: `npm run typecheck` passed.
- 2026-06-26: `npm run test:server` passed 203 backend tests.
- 2026-06-26: `npm run test:client` passed 61 client tests when run directly outside the Windows sandbox.
- 2026-06-26: a full `npm run test` rerun hit one `SymptomProcedureLinks.test.jsx` client assertion after the direct client suite had passed; `npm run test:client -- SymptomProcedureLinks` then passed 3 targeted tests.
- 2026-06-28: fixed that intermittent `SymptomProcedureLinks` / `ProcedureSymptomLinks` client flake (PR #64) by resetting link-panel state with a `key` prop instead of a mount `useEffect`; the link tests then passed 5/5 across repeated runs.
- 2026-07-03: `npm run smoke` passed 9 checks and confirmed the built frontend was served.
- 2026-07-10: `npm run typecheck` passed.
- 2026-07-10: `npm run test:server` passed 307 backend tests.
- 2026-07-10: `npm run test:client -- RepairChecklistsPage` passed 2 targeted client tests when rerun outside the Windows sandbox after the known Vite/esbuild `Access is denied` sandbox failure.
- 2026-07-24: from `server/`, `npm run test -- test/networkAddresses.test.js` passed 16 backend phone-access tests.
- 2026-07-24: `npm run test:client -- serviceWorker` passed 4 targeted service-worker tests when rerun outside the Windows sandbox after the known Vite/esbuild `Access is denied` startup failure.
- 2026-07-25: after pulling PR #91 (frontend a11y/duplication pass), `npm install --prefix client` picked up the new `eslint-plugin-jsx-a11y` dependency; `npm run lint`, `npm run typecheck`, `npm run test:server` (351 tests), and `npm run test:client` (74 tests) all passed.
- 2026-08-04: on Linux (not the usual Windows box, so the esbuild sandbox caveat did not apply), `npm run lint`, `npm run typecheck`, `npm run test:server` (602 backend tests), and `npm run test:client` (94 tests across 17 files) all passed at `b43700f` — the state after the PR #93–#99 grounding, evidence-contract, and safety work.

## Useful Docs

- `README.md` is the main entry point.
- `docs/onboarding.md` is the new-developer guide with a file walkthrough and first-day checklist.
- `docs/getting-started-windows.md` explains the interactive `start-corolla-helper.ps1` setup path.
- `docs/api.md` is the endpoint reference for every `/api` route.
- `DATA_MODEL.md` summarizes the current SQLite tables and migration names.
- `docs/runbook.md` covers operational procedures: start/stop, health checks, and failure recovery.
- `docs/troubleshooting.md` is the symptom-by-symptom local failure guide.
- `docs/local-development.md` explains local setup.
- `docs/environment-variables.md` explains placeholder-only env values.
- `docs/architecture.md` explains current app structure.
- `docs/backup-restore.md` explains backup contents, safe restore behavior, and the round-trip drill.
- `docs/quality-testing.md` explains `eval:retrieval`, `eval:rerank`, `eval:answers`, and `eval:relevance-floor` (including how to read the threshold sweep before enabling `ASK_RELEVANCE_FLOOR`).
- `docs/evals/ask-rag-iteration-log.md` records what was actually measured on the Ask RAG pipeline. Read it before re-litigating a retrieval or grounding decision.
- `docs/repair-planner.md` documents the SSE event protocol, the readiness rubric, and how to add a tool.
- `docs/mobile-access.md` explains phone access: same-Wi-Fi URLs, Tailscale (and `tailscale serve` for HTTPS), and the iPhone Home Screen install.
- `docs/gcp-deployment.md` explains the intended Google Compute Engine path.
- `docs/archive/` contains old plans, generated snapshots, and superseded deployment notes.
