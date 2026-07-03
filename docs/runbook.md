# Runbook

Operational procedures for Corolla Fix Helper: how to start, stop, check, and recover the app. Use this when something is broken or you are about to do something risky (restore, upgrade, move data). For symptom-by-symptom fixes see [troubleshooting.md](troubleshooting.md); this runbook focuses on *procedures*.

Everything below is run from the repo root (`C:\Users\daleb\source\corolla-fix-helper`) in PowerShell unless stated otherwise.

## Prerequisites

- Node.js `>=24 <25` — check first, this is the #1 cause of weird failures:

  ```powershell
  node -v    # must print v24.x
  ```

- Packages installed: `npm run install:all`
- Optional: Tesseract + Poppler for scanned-PDF OCR ([local-development.md](local-development.md) §4)
- Optional: `OPENAI_API_KEY` in `server\.env` for the AI features

## Start the App

### Development (two servers, hot reload)

```powershell
npm run dev
```

- Frontend: `http://localhost:5173`
- Backend: `http://localhost:4000`

One side only: `npm run dev:server` or `npm run dev:client`.

### Production-style (one server, built frontend)

```powershell
npm run build
npm start
```

App at `http://localhost:4000`.

### Windows guided script

```powershell
powershell -ExecutionPolicy Bypass -File .\start-corolla-helper.ps1
```

Handles env file, key entry, install, import, embedding, build, and start in one pass ([getting-started-windows.md](getting-started-windows.md)).

## Stop and Restart Safely

- **Stop:** press `Ctrl+C` in the terminal running the app (for `npm run dev`, `concurrently` stops both servers). Closing the terminal window also stops it.
- The app is safe to stop at any time for normal use — SQLite commits transactions as it goes. Avoid killing it in the middle of a **bulk import** or **restore** if you can; both are resumable/recoverable, but let them finish when possible.
- **Restart:** just run the start command again. There is no daemon, no service manager, no PID file.
- After changing anything in `server\.env`, a backend restart is required — env vars are read once at startup by `server/src/config.js`.

## Health Checks

Is the backend up?

```powershell
curl.exe http://localhost:4000/api/health
# expect: {"status":"ok","message":"Corolla Fix Helper server is running."}
```

Is the API serving data (also proves the database opened)?

```powershell
curl.exe http://localhost:4000/api/dashboard
# expect: JSON with vehicle, summary counts, recent activity
```

Is the frontend up (dev mode)? Open `http://localhost:5173` — the sidebar should list Dashboard, Documents, Search, Repair Planner, Symptoms, Procedures, Notes, Settings.

Which database/uploads is the app actually using? Open **Settings → runtime info** in the UI, or:

```powershell
curl.exe http://localhost:4000/api/settings
# runtime.databaseFile and runtime.uploadsDir show the live paths
```

Are the AI features configured? Ask something in the Search page Ask panel — `"status":"ai_not_configured"` in the response means no key reached the server process.

## Where the Logs Are

There is no log file. Both servers log to the terminal that started them:

- Backend errors (stack traces, tar failures, OpenAI errors) appear in the `dev:server` / `npm start` output.
- Frontend build/HMR issues appear in the `dev:client` output.
- Browser-side errors: open the browser DevTools console and Network tab — failed `/api` calls show the JSON `{ "error": "..." }` body the server returned.

When reporting or debugging a failure, capture the terminal output around the timestamp plus the failing request from the Network tab.

## Failure Procedures

### App won't start

1. `node -v` — must be `v24.x`. Fix your Node install/version manager first.
2. `npm run install:all` — reinstall packages (fixes `Cannot find package`, `ERR_MODULE_NOT_FOUND`, `vite is not recognized`).
3. Port conflict (`EADDRINUSE`): another process owns 4000 or 5173. Find and stop it, or change `PORT` in `server\.env`:

   ```powershell
   Get-NetTCPConnection -LocalPort 4000 -State Listen | Select-Object OwningProcess
   Get-Process -Id <thatProcessId>
   ```

4. Startup crash mentioning SQLite/migrations: see [Database problems](#database-problems).

### Frontend loads but API calls fail

1. Confirm the backend is up (health check above).
2. In dev, the Vite proxy forwards `/api` from 5173→4000 — if you changed `PORT`, update the proxy target in `client/vite.config.js` too.
3. If CORS errors appear in the browser console, set `CORS_ORIGIN=http://localhost:5173` in `server\.env` and restart the backend.

### Document upload fails

1. Check the error message in the UI — the server returns specific reasons:
   - "Only PDF files are allowed right now." — documents are PDF-only by design.
   - "PDF is too large. The limit is 20 MB." — raise `MAX_UPLOAD_SIZE_MB` in `server\.env` and restart, or shrink the PDF.
   - "System and document type are required." — fill both form fields.
2. Check the uploads folder exists and is writable (path shown in Settings → runtime info).
3. Check the backend terminal for a stack trace. The upload route cleans up after itself on failure (deletes the written file and partial rows), so it is always safe to retry.

### Text extraction fails or a PDF is "IMAGE-ONLY"

1. Re-run extraction for that one document: Documents page → the document → re-run extraction (or `POST /api/documents/:id/extract`).
2. If the extraction status starts with `ocr_unavailable:` — the PDF is a scan and the OCR tools are missing. Verify:

   ```powershell
   tesseract --version
   pdftoppm -v
   ```

   Install them ([local-development.md](local-development.md) §4) or point `OCR_TESSERACT_COMMAND` / `OCR_PDFTOPPM_COMMAND` in `server\.env` at the full `.exe` paths. Then re-run extraction.
3. If OCR is installed but not wanted, set `OCR_ENABLED=false` — text PDFs are unaffected.
4. Remember: OCR runs on the machine running the **backend**. In Docker, the default image has no OCR tools.

### Ask / RAG answering fails

Work down this list — each step isolates one layer:

1. **"AI is not configured"** → `OPENAI_API_KEY` is missing from the server process. Add it to `server\.env`, restart the backend. (This state is by design, not a crash.)
2. **`not in documents` for things you know are in the PDFs** →
   - Confirm the document's text extracted (Documents page shows extraction status and page count).
   - Rebuild embeddings — required after any import or re-extraction:

     ```powershell
     npm run embed:backfill
     ```

     This is resumable and only embeds chunks missing the current embedding version.
   - If you changed `OPENAI_EMBEDDING_MODEL` or `OPENAI_EMBEDDING_DIMENSIONS`, **all** old embeddings are ignored (version mismatch) until you re-run the backfill.
3. **HTTP 429 from `/api/ask`** → the built-in rate limit (20 requests/minute) — wait a minute.
4. **HTTP 500 / network errors** → the backend can't reach OpenAI (egress, invalid key, OpenAI outage). The backend terminal shows the underlying error.
5. **Quality regressions** (answers got worse, wrong citations) → run the evals: `npm run eval:retrieval` (no key needed) and `npm run eval:answers` (needs key, costs cents). See [quality-testing.md](quality-testing.md).

Repair Planner failures follow the same pattern; its stream also emits explicit `ai_not_configured` and `error` frames. Protocol details: [repair-planner.md](repair-planner.md).

### Database problems

The database is one file: `DATABASE_FILE` (default `server/data/corolla-fix-helper.db`), possibly with `-wal`/`-shm` sidecar files next to it — those sidecars are normal SQLite write-ahead-log files, **never delete them while the app runs**.

1. **"Data disappeared"** — almost always the app is pointed at a different file. Check Settings → runtime info; check `DATABASE_FILE` in `server\.env` (relative paths are relative to the `server/` folder).
2. **Startup migration error** — the schema migrates on startup (`server/src/initDatabase.js`); migrations are transactional, so a failure leaves the previous schema intact. Read the terminal error; if it points at a code bug, fix or revert the migration code — do not hand-edit the database.
3. **Suspected corruption** (rare) — stop the server, then:

   ```powershell
   # if you have sqlite3 available:
   sqlite3 server\data\corolla-fix-helper.db "PRAGMA integrity_check;"
   ```

   If it reports errors, restore from a backup (next section).
4. **Locked database in tests/CI** — server tests use isolated test databases; if you added a test that reuses the real path, give it its own temp `DATABASE_FILE`.

### Backup export fails

Backup export streams a `tar.gz` from Settings. If it 500s:

1. The backend terminal logs the tar failure detail.
2. `tar` must be available to the backend process. On Windows the code deliberately resolves the native `%SystemRoot%\System32\tar.exe` (`server/src/services/tarExecutable.js`) — reuse that helper in any new code rather than spawning bare `tar`.

## Backup, Restore, and Rollback

Full details live in [backup-restore.md](backup-restore.md); the short version:

**Take a backup** (do this before anything risky): Settings → **Export backup** downloads `corolla-fix-helper-backup-<timestamp>.tar.gz` containing the database and the whole uploads tree. Store it off the machine.

**Restore** (⚠️ stop the server first):

```powershell
npm run restore -- "C:\path\to\corolla-fix-helper-backup-....tar.gz"
```

Restore is fail-closed: it validates the archive **before** touching anything, snapshots current data to a `pre-restore-<timestamp>` folder next to the database, swaps atomically, and rolls back automatically if the swap fails. On failure it prints `Your existing data was left in place.`

**Manual rollback** (if you restored the wrong thing): stop the server, copy the `pre-restore-<timestamp>` folder's `database/<name>.db` back over `DATABASE_FILE` and its `uploads/` contents back into `UPLOADS_DIR`, start the server.

**Prove the machinery works** (run after touching backup/storage code, or periodically):

```powershell
npm run backup:drill
```

This runs the full export→wipe→restore round trip on throwaway temp data and exits non-zero on any failure. It never touches your real data.

## After Any Recovery

1. Health checks (above) pass.
2. Documents page lists your documents and a stored PDF opens.
3. One Ask question returns an answer or a sensible `not in documents`.
4. If you changed code, run the relevant sections of [QA_CHECKLIST.md](../QA_CHECKLIST.md).

## Escalation

This is a single-maintainer project — "escalation" means gathering enough context to debug it yourself or with an AI assistant:

- The exact command run, the full terminal output, and the failing request/response from the browser Network tab.
- `git log --oneline -10` — did a recent change break it? `git stash` / checkout an earlier commit to bisect.
- `CHANGELOG.md` and merged PRs for recent behavior changes.
