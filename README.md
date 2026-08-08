# Corolla Fix Helper

Corolla Fix Helper is a local-first repair workspace for one vehicle:

- 2009 Toyota Corolla LE 1.8L

**Why it exists:** repair information for one car ends up scattered across PDF manuals, forum printouts, wiring diagrams, and handwritten notes. This app puts all of it in one searchable local place, and adds two AI features that answer questions and plan repairs *using only your uploaded documents* — with citations back to the exact PDF page.

**Local-first** means the app stores its working data on the computer that runs it: one SQLite database file and one local uploads folder for PDFs. There is no cloud account and no sync.

Storage is local, but the AI features are not offline: when `OPENAI_API_KEY` is configured, question embedding and answer generation call the OpenAI API over the network.

## Main Features

- **Documents** — upload PDFs, edit metadata, tag, favorite, bookmark, open the stored file, re-run text extraction, and delete with full cleanup
- **Bulk import** — resumable folder import for many PDFs with MD5 duplicate detection and an image-only report (`npm run import`)
- **OCR (optional)** — scanned or image-only PDF pages become searchable text when local Tesseract and Poppler are installed
- **Ask AI** — RAG-style Q&A: hybrid keyword+embedding retrieval over PDF chunks, OpenAI-generated answers with citations, and a deliberate `not in documents` refusal when your PDFs don't contain the answer. Can optionally include one saved photo (Vision Ask). Sidebar **Ask AI**, route `/search`; the panel on that page is headed "Ask a question".
- **Search** — plain keyword search, no AI and no API key needed. Its four sections ("Search documents", "Search symptoms", "Search procedures", "Search notes") sit below the Ask AI panel on the same page, and hit `/api/search/*`.
- **Repair Planner** — a streaming tool-calling agent that turns a rough repair brief into a prioritized plan, readiness score, owner checklist, and handoff drafts, grounded in your PDFs
- **Symptoms, Procedures, Notes** — create/edit/delete with filters and sorting; link them to documents and to each other; attach photos (JPEG/PNG/WebP)
- **Repair Checklists** — plan a repair job as a simple list of steps, check them off as you go, add a status (planned / in progress / blocked / done) and notes, and reorder steps with Up/Down
- **Settings** — vehicle profile, document defaults, runtime info, and one-click backup export
- **Backup & restore** — export a `.tar.gz` of everything; restore validates the archive, snapshots current data, swaps atomically, and rolls back on failure ([docs/backup-restore.md](docs/backup-restore.md))

### What things are called

The product is **Corolla Fix Helper** everywhere it is named: browser tab title, app header, PWA manifest `name`, this README, and the user docs. The one sanctioned short form is **Corolla Fix**, used only where the platform truncates — the manifest's `short_name` and the iOS `apple-mobile-web-app-title` that labels the Home Screen icon.

Each feature has exactly one visible name, and the sidebar item, the page's own heading, and the browser tab title all use it:

| Feature | Visible name | Route |
| --- | --- | --- |
| Document library | Documents | `/documents` |
| AI question answering | Ask AI | `/search` |
| Keyword search | Search (as "Search documents", "Search symptoms", …) | `/search` |
| Repair planning agent | Repair Planner | `/repair-planner` |
| Job checklists | Repair Checklists | `/repair-checklists` |

Routes and API paths are **not** renamed to match: `/search` predates the "Ask AI" name and is still the address of that page, `SearchPage.jsx` is still the component, and `/api/search/*` is still the keyword-search API. Only what the owner reads changed.

## Current Limits

The app does **not** include:

- user accounts or login
- cloud sync
- multi-vehicle support
- general open-ended AI chat (both AI features stay grounded in the uploaded documents)
- a verified current cloud deployment from this branch

> ⚠️ **Do not expose this app on a public URL without putting HTTPS and authentication in front of it.** There is no login, so anyone who can reach it can read your data and spend your OpenAI budget. The AI endpoints are rate-limited (20 requests/minute) as a basic safeguard, but that is not a substitute for authentication. Ask AI sends your question and relevant excerpts from your uploaded PDFs (plus any photo you attach) to OpenAI to generate an answer.

Use sample or fake PDFs before sharing a public demo.

## Tech Stack

- **Frontend:** React 19, Vite 7, React Router 7, Tailwind CSS 4
- **Backend:** Node.js, Express 5
- **Database:** SQLite through Node's built-in `node:sqlite` (this is why Node `>=24 <25` is required)
- **File storage:** local uploads folder for PDFs and attachment images
- **AI:** raw `fetch` calls to the OpenAI Responses and Embeddings APIs — no OpenAI SDK, no agents framework
- **Tests:** Node's built-in test runner (server), Vitest + Testing Library (client)

## Quick Start

Requires Node.js `>=24 <25` (check with `node -v` — it should start with `v24.`).

```powershell
cd C:\Users\daleb\source\corolla-fix-helper
npm run install:all
npm run dev
```

Open:

- frontend: `http://localhost:5173`
- backend health check: `http://localhost:4000/api/health`

That's a working app with no API key — upload PDFs and use keyword search right away. To enable the AI features, see [Environment Variables](#environment-variables) below.

New to the repo? Start with [docs/onboarding.md](docs/onboarding.md). On Windows there is also a one-command guided setup script: [docs/getting-started-windows.md](docs/getting-started-windows.md).

## Environment Variables

The app runs with safe defaults and **no env file at all**. You only need one to change ports/paths or to enable AI.

```powershell
Copy-Item .env.example server\.env
```

The key ones:

| Variable | Default | What it does |
| --- | --- | --- |
| `OPENAI_API_KEY` | (empty) | Enables Ask AI answers, Repair Planner, embeddings, and answer evals. Without it, both AI features show "AI not configured" and everything else keeps working. |
| `PORT` | `4000` | Backend port |
| `DATABASE_FILE` | `server/data/corolla-fix-helper.db` | SQLite database file |
| `UPLOADS_DIR` | `server/uploads` | Where uploaded PDFs (and attachment images) live |
| `MAX_UPLOAD_SIZE_MB` | `20` | Largest allowed PDF/image upload |
| `OCR_ENABLED` | `true` | OCR low-text PDF pages when Tesseract + Poppler are installed |

Full reference for every variable (models, reranker, OCR tuning): [docs/environment-variables.md](docs/environment-variables.md). Never commit a real key — `server/.env` is gitignored.

## Common Commands

Run from the repo root:

| Command | What it does |
| --- | --- |
| `npm run install:all` | Install root, server, and client packages |
| `npm run dev` | Backend (`:4000`) + frontend (`:5173`) together |
| `npm run dev:server` / `npm run dev:client` | Just one side |
| `npm run test` | Both test suites (`test:server`, `test:client` for one) |
| `npm run lint` | ESLint over `server/` and `client/src` |
| `npm run typecheck` | TypeScript `checkJs` over the whole `server/src` tree (`tsconfig.json`) |
| `npm run build` | Production frontend build (server build is a no-op) |
| `npm start` | Production-style: Express serves `client/dist` on `:4000` |
| `npm run smoke` | Boot the built app on throwaway data and check the frontend + core API routes respond (run after `npm run build`) |
| `npm run demo:seed` | Load the optional sample maintenance PDF (normal startup seeds nothing) |
| `npm run import -- "C:\path\to\pdfs"` | Bulk PDF import with duplicate detection |
| `npm run embed:backfill` | Embed chunks missing the current embedding version — run after importing or re-extracting PDFs |
| `npm run eval:retrieval` / `npm run eval:answers` | Retrieval and answer-quality evals ([docs/quality-testing.md](docs/quality-testing.md)) |
| `npm run restore -- "path\to\backup.tar.gz"` | Restore a backup (stop the server first) |
| `npm run backup:drill` | Prove the backup→restore round trip on throwaway data |

Import report note: `IMAGE-ONLY` means text extraction found almost no text on a PDF. With Tesseract and Poppler installed, OCR runs on those pages automatically; without them, the document's extraction status starts with `ocr_unavailable:`.

## Project Structure

```text
corolla-fix-helper/
├── client/                  # React frontend (Vite)
│   └── src/
│       ├── pages/           # One page component per feature + co-located *.test.jsx
│       ├── components/      # Shared and per-feature presentational components
│       └── lib/             # apiClient.js fetch wrapper, helpers
├── server/                  # Express backend
│   ├── src/
│   │   ├── index.js         # Starts the server
│   │   ├── app.js           # createApp(options) — wires routes + middleware
│   │   ├── config.js        # Reads ALL env vars in one place
│   │   ├── initDatabase.js  # Creates/migrates the SQLite schema on startup
│   │   ├── routes/          # Thin HTTP handlers (documents, ask, search, ...)
│   │   ├── services/        # The actual logic (extraction, retrieval, AI, backup)
│   │   │   └── agent/       # Repair Planner: agent loop, tools, streaming client
│   │   ├── middleware/      # In-house rate limiter for the AI endpoints
│   │   ├── scripts/         # npm-run commands (import, restore, evals, ...)
│   │   └── evals/           # Answer-quality test cases and scoring
│   ├── data/                # SQLite database file (gitignored)
│   └── uploads/             # Stored PDFs + attachment images (gitignored)
├── docs/                    # All the guides listed below
├── .env.example             # Placeholder env values (copy to server/.env)
├── Dockerfile               # Node 24 image for the intended GCE deployment
└── start-corolla-helper.ps1 # Windows one-command guided setup
```

## Testing

```powershell
npm run test            # everything
npm run test:server     # Node built-in test runner
npm run test:client     # Vitest (jsdom + Testing Library)
```

Single files:

```powershell
cd server; node --test test/app.test.js
cd client; npx vitest run src/pages/NotesPage.test.jsx
```

All tests run **without an OpenAI key** — every AI-touching module accepts an injected mock (see the dependency-injection convention in [docs/architecture.md](docs/architecture.md)). After code changes, also walk [QA_CHECKLIST.md](QA_CHECKLIST.md) for manual verification, and use [docs/quality-testing.md](docs/quality-testing.md) to check answer quality.

CI (`.github/workflows/ci.yml`) runs `install:all`, `lint`, `typecheck`, `test`, `build`, and the production `smoke` test on every push and pull request with Node 24.

## Basic Troubleshooting

| Symptom | First thing to try |
| --- | --- |
| App won't start / weird module errors | `node -v` must be `v24.x`; then `npm run install:all` |
| Port in use | Stop the other process or change `PORT` in `server\.env` |
| "AI is not configured" | Put `OPENAI_API_KEY` in `server\.env`, restart the backend |
| Ask finds nothing after import | `npm run embed:backfill` (keyword search works without it; embeddings improve ranking) |
| Scanned PDF has no text | Install Tesseract + Poppler, then re-run extraction on the document |
| Data "disappeared" | Settings → runtime info: check which `DATABASE_FILE`/`UPLOADS_DIR` the app is actually using |

Full symptom-by-symptom guide: [docs/troubleshooting.md](docs/troubleshooting.md). Operational procedures (start/stop/recover): [docs/runbook.md](docs/runbook.md).

## Documentation Map

Getting running:

- [Onboarding guide](docs/onboarding.md) — start here as a new developer
- [Getting started on Windows](docs/getting-started-windows.md) — one-command guided setup
- [Local development](docs/local-development.md) — step-by-step manual setup
- [Environment variables](docs/environment-variables.md)

Understanding the app:

- [Architecture](docs/architecture.md) — system design, data flows, key modules, trade-offs
- [API reference](docs/api.md) — every endpoint with request/response examples
- [Data model](DATA_MODEL.md) — every SQLite table
- [Repair Planner agent](docs/repair-planner.md) — agent internals, event protocol, how to add tools

Operating it:

- [Runbook](docs/runbook.md) — start/stop, health checks, failure recovery
- [Use it on your iPhone](docs/mobile-access.md) — same Wi-Fi, Tailscale, Add to Home Screen
- [Troubleshooting](docs/troubleshooting.md)
- [Backup and restore](docs/backup-restore.md)
- [Quality testing the chatbot](docs/quality-testing.md)
- [Manual QA checklist](QA_CHECKLIST.md)

Planning:

- [Roadmap](ROADMAP.md)
- [Google Cloud deployment](docs/gcp-deployment.md) (intended path, not a live deployment) and [Cost control](docs/cost-control.md)
- `docs/archive/` holds superseded plans — do not treat as current

## Notes for Future Contributors

- **Stay in scope.** One vehicle, local-first, SQLite + local files, no login, no vector DB. `AGENTS.md` and [docs/architecture.md](docs/architecture.md) spell out the scope rules.
- **Follow the dependency-injection convention.** No OpenAI SDK; AI calls use raw `fetch`, and every external dependency (model client, retriever) is injectable so tests run without a key. New AI-touching code must do the same.
- **Routes stay thin; logic goes in `server/src/services/`.**
- **Deleting a document must clean up everything:** `symptom_documents`, `procedure_documents`, `document_chunks`, note links, and the stored file.
- **Schema changes are numbered migrations** in `server/src/initDatabase.js` — add a new one, never edit an applied one ([DATA_MODEL.md](DATA_MODEL.md)).
- **Typecheck is broad but not exhaustive.** `npm run typecheck` covers the whole `server/src` tree plus a curated set of tests via `tsconfig.json` (`checkJs` with several strict-family flags), but full `strict` (`strictNullChecks`/`noImplicitAny`) is still off — a clean run is broad coverage, not complete null/any safety.
- **Before opening a PR:** `npm run lint && npm run typecheck && npm run test`, then the relevant parts of [QA_CHECKLIST.md](QA_CHECKLIST.md).

## Deployment Note

The intended Google Cloud path is a Google Compute Engine VM running the Docker image from this repo, with persistent storage mounted for the SQLite database and uploaded PDFs. This branch does not claim the app is currently deployed. Follow [docs/gcp-deployment.md](docs/gcp-deployment.md) only when you intentionally want to create cloud resources. The Docker image installs the OCR tools (`poppler-utils`, `tesseract-ocr`), so scanned-PDF OCR works in containers too.
