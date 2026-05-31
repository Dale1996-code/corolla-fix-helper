# AI RAG Plan

## Summary
Planned content for `docs/AI_RAG_PLAN.md`, based on the current checkout. This plan adds an "Ask your documents" RAG layer **beside** the existing app without rewriting it. The work is scoped for execution as two sequential Codex Goals (see "Execution as Goals" below).

## Current Capabilities To Preserve
- The app is local-first for one vehicle: 2009 Toyota Corolla LE 1.8L.
- Stack confirmed: React + Vite + Tailwind client, Express server, `node:sqlite` with `DatabaseSync`, and local PDF uploads under `server/uploads`.
- Runtime should stay Node `>=24 <25`; current shell is Node `v24.15.0`.
- Validation commands to preserve: `npm run install:all`, `npm run build`, `npm run test`, `npm run test:server`, `npm run test:client`.
- Current code has `GET /api/search` for document search only. The four-endpoint shape `/api/search/documents`, `/api/search/symptoms`, `/api/search/procedures`, `/api/search/notes` exists only in a planning spec, not this checkout.
- Current settings show backup/export as unsupported. `.tar.gz` backup export is not present in this checkout.

## What Is Already Done And Must Not Be Rebuilt
- Preserve Dashboard, Documents, document search, Symptoms, Procedures, Notes, and Settings.
- Preserve PDF upload, local file storage, metadata editing, favorites, opening stored PDFs, filters, extraction status, and page count.
- Preserve symptom/procedure/note CRUD and document linking behavior.
- Do not rebuild current document search; add RAG as a layer beside it.
- Do not depend on prompt-only features not present here: document delete-with-cleanup, manual re-extraction, four search endpoints, or backup export.

## The Smallest Useful AI/RAG MVP
- Add "Ask your documents" question answering over uploaded PDFs.
- Use keyword chunk retrieval first. Embeddings/vector search are V1.5, not MVP.
- The model may answer only from retrieved chunks.
- If no chunk supports the question, return: "The uploaded documents do not contain enough information to answer that."
- Every answer must return citations.

## Required Database Changes
- Add `document_chunks` in `server/src/initDatabase.js` using current `CREATE TABLE IF NOT EXISTS` patterns.
- Proposed columns: `id`, `document_id`, `page_number`, `chunk_index`, `chunk_text`, `created_at`.
- Add `FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE`.
- Add indexes for `document_id` and chunk search.
- Keep all database work inside `node:sqlite` / `DatabaseSync`; do not add `better-sqlite3`.
- Change `pdfService.js` to retain page boundaries while still returning the existing whole `extractedText`.

## Chunking Approach
- Extract each PDF page as `{ pageNumber, text }`.
- Convert each page into simple fixed-size chunks, roughly 180-220 words with a small overlap.
- Store page number and chunk index with each chunk.
- Keep `documents.extracted_text` unchanged for existing search behavior.
- For old uploaded documents, do not guess page numbers from the old blob. Re-read the stored PDF from `server/uploads`, run page-aware extraction, delete old chunks for that document, and insert new chunks.
- Because this checkout has no manual re-extraction route, the RAG work should add a small chunk-rebuild service and call it after upload plus during a controlled backfill.

### Backfill Safety Requirements
- The backfill must be **idempotent**: running it twice over the same documents must produce identical chunk rows (same `page_number`, `chunk_index`, and `chunk_text`), with no duplicates and no orphaned chunks.
- Implement rebuild as delete-then-insert per document inside a single transaction so a partial failure cannot leave a document half-chunked.
- Add a test that runs the backfill twice and asserts the chunk set is byte-for-byte identical after the second run.

## Retrieval Approach
- Add a retrieval service that searches `document_chunks` before any LLM call.
- Use the existing search style first: lowercase keyword matching with simple scoring.
- Boost chunks where more question terms appear, and include document title/filename/system in the returned metadata.
- Retrieve top 6-8 chunks for the question.
- **Keyword retrieval is the shippable MVP path and the default.** FTS5 is a non-blocking experiment only: probe whether FTS5 is available under Node's `node:sqlite` build, and if it is not trivially available, do not block on it and do not spend goal budget forcing it. Embeddings/vector search remain a later (V1.5+) enhancement and are explicitly out of scope here.

## Answer Quality Bar (Verification Surface)
To avoid a vague "tests pass" finish line, the Ask feature has a measurable correctness bar:
- Add a small fixed eval set of at least **5 question / expected-citation pairs** against a committed sample (fake) PDF that contains known repair facts.
- Each eval case names the question, the expected source document, and the expected page number.
- The Ask backend is considered correct when, for all eval questions, the returned citations include the expected document and page.
- At least one eval case must be an unanswerable question whose expected result is the honest not-found response with **no** model call.
- This eval set is the primary stopping condition for Goal A's answer behavior, alongside the unit/route tests.

## Citation / Source Reference Approach
- Citation objects are built by the server from the exact chunks sent to the model.
- Each citation includes document id, document title, original filename, page number, chunk index, and snippet.
- The model does not invent citations. It can reference citation numbers, but the server returns the trusted citation list.
- Frontend citation links use `buildEntityLink("document", documentId)` and show `Page N`.
- Optional PDF link can use `/api/documents/:id/file#page=N`, but the document detail link remains the reliable fallback.

## API Route Plan
- Add `POST /api/ask`.
- Request body: `{ "question": "What is the oil drain plug torque?" }`.
- Route flow: validate question, retrieve chunks, return not-found if chunks are insufficient, then call the model only with those chunks.
- Isolate the model call in a service such as `aiAnswerService.js`.
- If no API key is set, the route returns a graceful "AI not configured" response and the rest of the app still runs.
- Mount the route in `server/src/app.js` without changing existing routes.

## Frontend UI Plan
- Put the MVP Ask box on the current Search page above document search.
- Keep existing page/card styling and avoid a new navigation item for MVP.
- UI states: empty question, loading, AI not configured, not found, answer with citations, request error.
- Render citations as clickable cards with document name, page number, and exact snippet.
- Keep the existing document search UI below the Ask panel.

## Environment Variable Plan
- Add to `.env.example`:
  - `OPENAI_API_KEY=`
  - `OPENAI_MODEL=`
- Read these through `server/src/config.js`.
- MVP uses OpenAI only to keep provider handling simple. **This is a deliberate choice, not a default** — Anthropic could be added later behind the same isolated model-service boundary (`aiAnswerService.js`), so the service interface must not leak OpenAI-specific shapes into routes or the frontend.
- Missing key behavior: no crash, no broken startup, clear UI message that AI is not configured.

## Test Plan
- Server tests use existing `node:test` + `supertest`.
- Test DB init creates `document_chunks`.
- Test chunking preserves page numbers.
- Test backfill is idempotent (running twice yields identical chunks).
- Test retrieval returns the best matching fake chunks.
- Test `POST /api/ask` with no API key returns graceful "AI not configured."
- Test unanswerable question returns the honest not-found response and does not call the model.
- Test answer response returns citations from the same chunks used as context.
- Test the eval set: all answerable eval questions return the expected document and page; the unanswerable eval question returns not-found.
- Client tests use Vitest + React Testing Library.
- Test Ask panel renders on Search page.
- Test answer with citations renders document/page/snippet links.
- Test not-found and no-key states.

## Manual QA Checklist Additions
- Use only fake/sample PDFs.
- Upload a fake PDF containing a known repair fact.
- Ask an answerable question and verify the answer cites the correct document and page.
- Ask an unanswerable question and verify the app says the uploaded documents do not contain enough information.
- Run with no `OPENAI_API_KEY` and verify the app still starts, V1 flows still work, and Ask shows "AI not configured."
- Run `npm run build`, `npm run test`, `npm run test:server`, and `npm run test:client`.

## Risks And Fallbacks
- SQLite vector or embedding extensions may not load under `node:sqlite`; default to keyword retrieval.
- FTS5 may be unavailable under Node's SQLite build; keyword retrieval is the default and FTS5 is non-blocking.
- Bad chunking can hurt answers; fixed-size page chunks are simple and testable.
- Hallucination risk is controlled by strict prompting, server-built citations, and honest not-found responses.
- Backfill could corrupt chunk state; idempotent delete-then-insert in a transaction plus a double-run test mitigates this.
- Wiring diagrams and images may not extract as text; show the source page and do not invent an answer.
- API calls add cost, latency, and offline limits; no-key mode must keep the app usable.
- Private or paid repair documents must never be used in automated tests.

## Clear Non-Goals
- No user accounts.
- No cloud sync.
- No payments.
- No mobile packaging.
- No replacing `node:sqlite` / SQLite unless proven strictly necessary.
- No embeddings/vector database in the MVP.
- No model answer without citations.
- No answers from general model knowledge.
- No private or paid repair documents in tests.
- No app rewrite; this is an add-on layer over the existing V1 app.

## Milestones
1. Add page-aware extraction, chunk table, chunk creation, and idempotent backfill.
2. Add chunk retrieval and `POST /api/ask` with no-key/not-found behavior.
3. Add isolated OpenAI answer service with server-built citations.
4. Add Search page Ask UI, tests, and QA checklist updates.

## Execution as Goals
This plan is implemented as **two sequential Codex Goals**, not one mega-goal and not four fragmented ones. Milestones 1-3 share one evidence loop (the server test suite) and are tightly coupled; milestone 4 has its own evidence loop (the client test suite). Goal A must be complete and green before Goal B builds on it.

### Goal A — Backend RAG pipeline (Milestones 1-3)
> Implement the backend "Ask your documents" RAG pipeline from this plan (page-aware extraction, `document_chunks` table, idempotent chunk backfill, keyword retrieval, `POST /api/ask`, and an isolated cited answer service), verified by `npm run test:server` passing — including the DB-init, chunking, idempotent-backfill, retrieval, no-key "AI not configured", not-found-without-model-call, citation-matching, and 5-question eval-set tests — while preserving all existing V1 routes, schema, document search, and the `node:sqlite`/`DatabaseSync` constraint. Use only the server codebase, `server/uploads`, and committed fake sample PDFs. Between iterations, record what changed, which tests/eval cases pass, and the next failing case to fix. Keyword retrieval is the shippable path; treat FTS5 as a non-blocking experiment only. If blocked or no valid path remains, stop and report attempted paths, evidence gathered, the blocker, and the next input needed. Do not modify the frontend in this goal.

**Stopping condition:** `npm run test:server` green, all 5 eval cases pass with correct document+page citations, and the unanswerable eval case returns not-found with no model call.

### Goal B — Frontend Ask experience (Milestone 4)
> Add the Search-page "Ask your documents" UI from this plan above the existing document search, covering all six UI states (empty, loading, AI not configured, not found, answer with citations, request error) with clickable citation cards showing document name, page number, and exact snippet, verified by `npm run test:client` passing and the manual QA checklist. Use only the client codebase and the existing `POST /api/ask` contract from Goal A. Preserve existing Search page styling and the document search UI below the Ask panel; add no new navigation item. Between iterations, record which UI states are covered and which client tests pass. If blocked, stop and report the blocker and the next input needed. Do not modify backend routes in this goal.

**Stopping condition:** `npm run test:client` green, all six UI states covered by tests, and the manual QA checklist passes against a fake sample PDF.

### Constraint across both goals
Goal A's server suite must be green before Goal B starts. If work in Goal B reveals a backend gap, pause Goal B, fix it under Goal A's contract and evidence loop, then resume Goal B — do not let backend changes happen outside Goal A's verification surface.
