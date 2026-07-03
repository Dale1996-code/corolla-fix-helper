# Onboarding Guide

Welcome! This guide takes a new developer — including a beginner — from zero to making confident changes in Corolla Fix Helper. It links to the deeper docs instead of repeating them; read it top to bottom once, then use it as a map.

## 1. Understand These Five Things First

1. **It's one app for one car.** A local-first repair workspace for a single 2009 Toyota Corolla LE 1.8L. No login, no cloud sync, no multi-vehicle support — and changes should stay inside that scope (the scope rules live in `AGENTS.md`).
2. **Two halves, one contract.** `client/` is a React app; `server/` is an Express API. The browser only ever talks to the server through `/api/...` routes ([api.md](api.md) lists them all).
3. **All data is two things on disk:** one SQLite database file (`server/data/`) and one uploads folder (`server/uploads/`). Delete those two and the app is factory-new. Back them up and you've backed up everything.
4. **The AI is grounded, and optional.** "Ask your documents" and the Repair Planner only use text retrieved from *your uploaded PDFs*, cite their sources, and refuse (`not in documents`) rather than guess. Without an `OPENAI_API_KEY` they degrade to an "AI not configured" state and the rest of the app works normally.
5. **Node must be 24.** The server uses Node's built-in `node:sqlite`, so the required range is `>=24 <25`. Most mystery failures are the wrong Node version.

## 2. Set Up Your Environment

Follow [local-development.md](local-development.md) (manual, step-by-step) or [getting-started-windows.md](getting-started-windows.md) (one guided script). Short version:

```powershell
node -v                # must be v24.x
cd C:\Users\daleb\source\corolla-fix-helper
npm run install:all
npm run dev
```

Open `http://localhost:5173`. Verify `http://localhost:4000/api/health` returns `{"status":"ok",...}`.

Optional extras when you need them:

- **AI features:** `Copy-Item .env.example server\.env`, put your `OPENAI_API_KEY` in `server\.env`, restart the backend. ([environment-variables.md](environment-variables.md))
- **OCR for scanned PDFs:** install Tesseract + Poppler ([local-development.md](local-development.md) §4).

## 3. How the Pieces Connect

Follow one request end-to-end and you understand the whole app. Take "the Documents page loads":

1. Browser renders `client/src/pages/DocumentsPage.jsx`, which calls `fetch("/api/documents")` (via the `requestJson` helper in `client/src/lib/apiClient.js`).
2. In dev, Vite (port 5173) proxies `/api` to the Express server (port 4000) — configured in `client/vite.config.js`.
3. Express (`server/src/app.js`) routes it to `server/src/routes/documents.js`.
4. The route calls `listDocuments()` in `server/src/services/documentService.js`, which queries SQLite through the shared connection in `server/src/database.js`.
5. JSON goes back up the same path.

Every feature follows this shape: **page → apiClient → route → service → SQLite**. The special flows (PDF upload/extraction/OCR, hybrid retrieval + Ask, the streaming Repair Planner agent) are diagrammed in [architecture.md](architecture.md) — read that next.

## 4. Guided File Walkthrough

Read these in order; it's about an hour total and covers 90% of what matters:

| Order | File | Why |
| --- | --- | --- |
| 1 | `README.md` | The map |
| 2 | `server/src/app.js` (~95 lines) | Every route mounted in one screen; the DI seams (`createApp(options)`) |
| 3 | `server/src/config.js` | Every env var the app reads, with defaults |
| 4 | `server/src/routes/documents.js` | The canonical route file: validation, service calls, error shapes |
| 5 | `server/src/services/documentService.js` | The canonical service: SQL lives here, not in routes |
| 6 | `server/src/initDatabase.js` + [DATA_MODEL.md](../DATA_MODEL.md) | The schema and the numbered-migration pattern |
| 7 | `client/src/App.jsx` + `client/src/pages/DocumentsPage.jsx` | Frontend routing and the page pattern |
| 8 | `client/src/lib/apiClient.js` | How the frontend calls the API |
| 9 | `server/src/routes/ask.js` + `server/src/services/aiAnswerService.js` | The RAG flow ([architecture.md](architecture.md) explains it) |
| 10 | `server/src/services/agent/repairPlannerAgent.js` | The agent loop ([repair-planner.md](repair-planner.md) explains it) |
| 11 | A test next to code you read, e.g. `server/test/app.test.js` and `client/src/pages/DocumentsPage.test.jsx` | How tests inject mocks so no API key is ever needed |

## 5. The One Convention You Must Follow

**Dependency injection for anything external.** This repo has no OpenAI SDK and no agents framework. AI calls are raw `fetch`, and every external dependency is a parameter with the real implementation as its default:

```js
// route accepts an injected implementation; tests pass a mock
export function createAskRouter({ askQuestion = askQuestionUsingDocuments } = {}) { ... }

// app accepts injected AI functions
createApp({ askQuestion, runRepairPlan })
```

Because of this, **the entire test suite runs offline with no key**. If you add code that calls the network (or the filesystem in a hard-to-test way), take that call as an injectable option the same way.

Second rule: **routes stay thin**. Parsing and status codes in `server/src/routes/`, logic and SQL in `server/src/services/`.

## 6. Common Beginner Tasks

### Add a new frontend page

1. Create `client/src/pages/MyPage.jsx` (copy the shape of an existing page).
2. Add a `<Route path="/my-page" element={<MyPage />} />` in `client/src/App.jsx`.
3. Add a nav entry in `client/src/lib/navigation.js` so it appears in the sidebar.
4. Add `client/src/pages/MyPage.test.jsx` next to it.

### Add a new API endpoint

1. If it's new logic, add a function in the right `server/src/services/` file (or a new one).
2. Add the handler to the matching `server/src/routes/` file — validate input, call the service, return JSON `{ ... }` on success or `{ "error": "..." }` with a 4xx/5xx status.
3. If it's a brand-new route group, mount the router in `server/src/app.js`.
4. Add a test (see below) and document it in [api.md](api.md).

### Add a test

- **Server:** add/extend a file in `server/test/` using Node's built-in runner (`import test from "node:test"`), with `supertest` against `createApp({ ...mocks })`. Run one file: `cd server; node --test test/app.test.js`.
- **Client:** co-locate `Whatever.test.jsx` next to the component, using Testing Library. Run one file: `cd client; npx vitest run src/pages/NotesPage.test.jsx`.
- Never require a real API key or the real database file in a test — inject mocks and use temp paths.

### Add or change a setting / env var

1. Add it to `server/src/config.js` with a sensible default (this is the only file that reads `process.env`).
2. Add the placeholder to `.env.example` (no real values).
3. Document it in [environment-variables.md](environment-variables.md).

### Change the database schema

Add a **new** numbered migration in `server/src/initDatabase.js` (`NNN_short_description`) — never edit an applied one — and update [DATA_MODEL.md](../DATA_MODEL.md). Migrations run once, transactionally, at startup.

## 7. Development Workflow

1. Branch from `main`. Heads-up: `main` moves fast in this repo — `git fetch` and re-check before building on older work.
2. Make the change (tests first or alongside).
3. Before pushing, run what CI runs:

   ```powershell
   npm run lint
   npm run typecheck
   npm run test
   npm run build
   npm run smoke
   ```

   Note: `typecheck` covers the whole `server/src` tree via `tsconfig.json` (`checkJs` + several strict-family flags), but full `strict` is off — a clean run is broad, not exhaustive. `smoke` boots the built app on throwaway data and checks it actually serves.
4. Manually verify with the relevant sections of [QA_CHECKLIST.md](../QA_CHECKLIST.md); for retrieval/answer changes also run the evals ([quality-testing.md](quality-testing.md)).
5. Open a PR; CI (`.github/workflows/ci.yml`) re-runs lint + typecheck + tests + build + smoke on Node 24.

**Testing with real data:** never point experiments at your real database/uploads. Override `DATABASE_FILE` and `UPLOADS_DIR` to scratch paths in the environment when trying anything destructive.

## 8. Things Not to Touch Casually

- **Applied migrations** in `server/src/initDatabase.js` — add new ones instead; editing applied ones desyncs every existing database.
- **Delete-cleanup paths** (`deleteDocument`, attachment cleanup in symptom/procedure/note deletes) — miss one related table and you orphan rows and files.
- **The embedding version scheme** (`model@dimensions` in `config.js` / `chunkEmbeddingService.js`) — changing model or dimensions silently invalidates every stored embedding until a full re-backfill.
- **`server/src/services/tarExecutable.js`** — on Windows it deliberately picks the native `System32\tar.exe`; spawning bare `tar` breaks backups.
- **The SSE disconnect handling in `server/src/routes/repairPlan.js`** — the response-vs-request `"close"` distinction is subtle and load-bearing (the comment in the file explains why).
- **`server/data/` and `server/uploads/`** — that's the user's real data. Don't commit it, don't script against it, don't delete it.
- **`npm audit fix --force`** — force-upgrades Vite across a major version. Don't ([local-development.md](local-development.md)).
- **Real secrets** — only in `server/.env` (gitignored) or deployment env vars; never in code, docs, or commits.

## 9. First Day Checklist

- [ ] `node -v` prints `v24.x`
- [ ] `npm run install:all` completes
- [ ] `npm run dev` — app opens at `http://localhost:5173`, health check OK at `http://localhost:4000/api/health`
- [ ] Upload one PDF on the Documents page; open its stored file; check its extraction status
- [ ] Run a keyword search on the Ask AI page (route `/search` — the page holds both the Ask panel and the search sections)
- [ ] `npm run lint && npm run typecheck && npm run test` all pass
- [ ] Read [architecture.md](architecture.md) (with the diagrams)
- [ ] Skim [api.md](api.md) and [DATA_MODEL.md](../DATA_MODEL.md)
- [ ] (Optional) add `OPENAI_API_KEY` to `server\.env`, run `npm run embed:backfill`, and ask your documents a question — verify the citation opens the right PDF page
- [ ] (Optional) run `npm run backup:drill` and watch the backup→restore round trip pass
- [ ] Make a tiny throwaway change (e.g. edit a page heading), see hot reload work, then revert it
