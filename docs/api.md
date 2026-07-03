# API Reference

Every HTTP endpoint the Corolla Fix Helper server exposes, grounded in the route files under `server/src/routes/`. For how these fit together see [architecture.md](architecture.md); for the tables behind them see [DATA_MODEL.md](../DATA_MODEL.md).

## Conventions

- **Base URL:** `http://localhost:4000` (dev frontend on `:5173` proxies `/api` there automatically).
- **No authentication.** Anyone who can reach the server can call everything — see the warning in the [README](../README.md#current-limits).
- **Requests/responses are JSON** unless noted (uploads are `multipart/form-data`; file/backup routes stream binary; the Repair Planner streams Server-Sent Events).
- **Errors** are JSON with a single field and an appropriate status code:

  ```json
  { "error": "Human-readable message." }
  ```

  `400` invalid input · `404` not found · `415` wrong media type (attachments) · `429` rate limited · `500` server failure.
- **Rate limits:** `POST /api/ask` and `POST /api/repair-plan` are each limited to **20 requests/minute** (in-house limiter, `server/src/middleware/rateLimit.js`). Everything else is unlimited.
- PowerShell examples use `curl.exe` (the real curl, not the PowerShell alias).

## Quick Endpoint List

| Method + Path | Purpose |
| --- | --- |
| `GET /api` | API name/version info |
| `GET /api/health` | Health check |
| `GET /api/dashboard` | Summary counts + recent activity |
| `GET /api/documents` | List documents (optional pagination) |
| `POST /api/documents/upload` | Upload one PDF |
| `GET /api/documents/:id/file` | Open the stored PDF |
| `POST /api/documents/:id/extract` | Re-run text extraction |
| `PUT /api/documents/:id` | Edit metadata / favorite / bookmark / tags |
| `DELETE /api/documents/:id` | Delete document + full cleanup |
| `GET /api/search` (+ `/documents`, `/symptoms`, `/procedures`, `/notes`) | Keyword search per section |
| `POST /api/ask` | Ask your documents (RAG Q&A) |
| `POST /api/repair-plan` | Repair Planner agent (SSE stream) |
| `GET/POST /api/symptoms`, `GET/PUT/DELETE /api/symptoms/:id` | Symptom CRUD |
| `PUT /api/symptoms/:id/procedures` | Replace a symptom's linked procedures |
| `GET /api/symptoms/:id/suggested-procedures` | Grounded procedure suggestions |
| `GET/POST /api/procedures`, `GET/PUT/DELETE /api/procedures/:id` | Procedure CRUD |
| `PUT /api/procedures/:id/symptoms` | Replace a procedure's linked symptoms |
| `GET/POST /api/notes`, `PUT/DELETE /api/notes/:id` | Note CRUD |
| `GET/POST /api/attachments`, `GET /api/attachments/all`, `GET /api/attachments/:id/file`, `DELETE /api/attachments/:id` | Image attachments |
| `GET /api/settings`, `PUT /api/settings/vehicle`, `PUT /api/settings/document-defaults` | Settings |
| `GET /api/settings/backup-export` | Download a `.tar.gz` backup |

---

## Meta

### `GET /api`

```json
{ "name": "Corolla Fix Helper API", "version": "0.1.0" }
```

### `GET /api/health`

```json
{ "status": "ok", "message": "Corolla Fix Helper server is running." }
```

### `GET /api/dashboard`

Returns the vehicle profile, summary counts, and recent lists in one call (all limits are fixed server-side — 5 per list, 8 activity entries):

```json
{
  "vehicle": { "id": 1, "year": 2009, "make": "Toyota", "model": "Corolla", "trim": "LE", "engine": "1.8L" },
  "summary": {
    "totalDocuments": 42, "favoriteDocuments": 3,
    "totalSymptoms": 5, "activeSymptoms": 2,
    "totalProcedures": 7, "totalNotes": 11
  },
  "favoriteDocuments": [ ... ], "recentDocuments": [ ... ],
  "recentSymptoms": [ ... ], "recentProcedures": [ ... ], "recentNotes": [ ... ],
  "activeSymptoms": [ ... ],
  "recentActivity": [ { "key": "document-42", "entityType": "document", "entityId": 42, "typeLabel": "Document", "title": "...", "updatedAt": "..." } ]
}
```

`activeSymptoms` counts statuses `open` and `monitoring`.

---

## Documents

### `GET /api/documents`

With no query params, returns **every** document (the Documents page relies on this):

```json
{ "documents": [ ... ], "total": 42 }
```

With `?limit=50&offset=0`, pages through instead — `limit` is capped at 200:

```json
{ "documents": [ ... ], "total": 42, "limit": 50, "offset": 0 }
```

### `POST /api/documents/upload`

`multipart/form-data`. PDF only; size capped at `MAX_UPLOAD_SIZE_MB` (default 20 MB).

| Field | Required | Notes |
| --- | --- | --- |
| `pdfFile` | ✅ | the PDF file |
| `system` | ✅ | e.g. `Brakes` |
| `documentType` | ✅ | e.g. `Repair Manual` |
| `title` | – | defaults to a title derived from the filename |
| `subsystem`, `source`, `notes` | – | free text |
| `isBookmarked` | – | `"true"` to bookmark on upload |
| `tags` | – | tag names to apply |

```powershell
curl.exe -X POST http://localhost:4000/api/documents/upload `
  -F "pdfFile=@C:\path\to\brakes-manual.pdf" `
  -F "system=Brakes" -F "documentType=Repair Manual"
```

`201` response:

```json
{ "message": "Uploaded brakes-manual.pdf successfully.", "document": { ... }, "totalDocuments": 43 }
```

Upload also extracts text (with OCR on low-text pages when tools are installed) and rebuilds the document's `document_chunks`. On any failure the stored file and partial rows are cleaned up before the error returns. Common errors: `"Only PDF files are allowed right now."`, `"PDF is too large. The limit is 20 MB."`, `"System and document type are required."`

### `GET /api/documents/:id/file`

Streams the stored PDF inline (`Content-Type: application/pdf`). `404` if the document or its file is missing.

### `POST /api/documents/:id/extract`

Re-runs extraction on the stored file and rebuilds its chunks. Returns `{ "message": "Extraction re-run complete.", "document": { ... } }`. Run `npm run embed:backfill` afterwards so new chunks get embeddings.

### `PUT /api/documents/:id`

JSON body; only fields you send are changed, but `title`, `system`, and `documentType` must remain non-empty. `isFavorite` / `isBookmarked` are real booleans here (unlike upload). Sending `tags` replaces the document's tag set.

```powershell
curl.exe -X PUT http://localhost:4000/api/documents/12 `
  -H "Content-Type: application/json" `
  -d '{"isFavorite": true, "tags": ["torque-specs", "front-end"]}'
```

### `DELETE /api/documents/:id`

Deletes the document, its stored file, its chunks, its symptom/procedure links, and clears note links:

```json
{ "message": "Document deleted.", "cleanup": { ... } }
```

---

## Search

All search endpoints are `GET`, share the shape `{ "results": [...], "total": n, "filters": {...} }`, and default `sort` to `relevance`. `filters` lists the values currently in use (systems, types, tags...) so the UI can build dropdowns.

| Endpoint | Query params |
| --- | --- |
| `GET /api/search` and `GET /api/search/documents` | `q`, `system`, `documentType`, `favorite`, `bookmarked`, `tag`, `sort` |
| `GET /api/search/symptoms` | `q`, `system`, `status`, `sort` |
| `GET /api/search/procedures` | `q`, `system`, `difficulty`, `sort` |
| `GET /api/search/notes` | `q`, `noteType`, `relatedEntityType`, `sort` |

Document search covers metadata, notes, extracted text (including OCR text), and tags.

```powershell
curl.exe "http://localhost:4000/api/search/documents?q=caliper&system=Brakes"
```

---

## Ask Your Documents (RAG)

### `POST /api/ask`  *(rate limited: 20/min)*

| Body field | Required | Notes |
| --- | --- | --- |
| `question` | ✅ | max 2000 characters |
| `history` | – | prior `{question, answer}` turns; used to rewrite vague follow-ups into a standalone question |
| `attachmentId` | – | id of one **already-saved** image attachment (Vision Ask) — never raw image data |

```powershell
curl.exe -X POST http://localhost:4000/api/ask `
  -H "Content-Type: application/json" `
  -d '{"question": "What is the oil drain plug torque spec?"}'
```

Response:

```json
{
  "question": "What is the oil drain plug torque spec?",
  "standaloneQuestion": "What is the oil drain plug torque spec?",
  "status": "answered",
  "answer": "The oil drain plug torque is 37 N·m (27 ft·lbf). [1]",
  "citations": [
    { "documentId": 3, "documentTitle": "Engine Repair Manual", "pageNumber": 14, "snippet": "..." }
  ]
}
```

`status` values:

- `answered` — answer generated from retrieved chunks, with citations
- `not_found` — the uploaded documents don't contain enough matching information ("not in documents"); this is deliberate refusal, not an error
- `ai_not_configured` — matching chunks exist but no `OPENAI_API_KEY` is set

Attachment-specific errors: `400` bad id, `404` unknown/missing file, `415` not a JPEG/PNG/WebP. A bad attachment fails **before** anything is sent to OpenAI.

---

## Repair Planner

### `POST /api/repair-plan`  *(rate limited: 20/min, streams Server-Sent Events)*

| Body field | Required | Notes |
| --- | --- | --- |
| `brief` | ✅ | free-text repair brief |
| `skillLevel`, `availableTools`, `availableParts`, `constraints` | – | strings feeding the readiness rubric |

```powershell
curl.exe -N -X POST http://localhost:4000/api/repair-plan `
  -H "Content-Type: application/json" `
  -d '{"brief": "Front brakes squeak when stopping. Replace the pads this weekend.", "skillLevel": "beginner"}'
```

The response is `text/event-stream`; each frame is `data: <json>\n\n` with a `type` of `status`, `tool_call`, `tool_result`, `text_delta`, `trace`, `ai_not_configured`, `error`, or `done` (the `done` frame carries the assembled `artifacts`). Full protocol, tool list, and readiness rubric: [repair-planner.md](repair-planner.md).

---

## Symptoms

Allowed values — `confidence`: `low` | `medium` (default) | `high`; `status`: `open` (default) | `monitoring` | `resolved`.

| Endpoint | Notes |
| --- | --- |
| `GET /api/symptoms` | `{ "symptoms": [...], "total": n }` — each includes `linkedDocuments` and `linkedProcedures` |
| `GET /api/symptoms/:id` | `{ "symptom": {...} }` |
| `POST /api/symptoms` | body: `title` (required), `description`, `system`, `suspectedCauses`, `notes`, `confidence`, `status`, `linkedDocumentIds` (array). `201` → `{ "message", "symptom" }` |
| `PUT /api/symptoms/:id` | same fields; partial update |
| `PUT /api/symptoms/:id/procedures` | body `{ "procedureIds": [1, 2] }` — **replaces** the whole linked set; returns the updated symptom |
| `GET /api/symptoms/:id/suggested-procedures` | ranks existing procedures for this symptom, grounded in retrieved chunks. Response carries `status` (`answered`/`not_found`), `aiConfigured`, and `mode` so the UI can show whether ranking was AI-assisted or the deterministic keyword/system fallback (no key needed) |
| `DELETE /api/symptoms/:id` | also removes document/procedure links and the symptom's image attachments |

```powershell
curl.exe -X POST http://localhost:4000/api/symptoms `
  -H "Content-Type: application/json" `
  -d '{"title": "Squeak when braking", "system": "Brakes", "status": "open"}'
```

---

## Procedures

Allowed values — `difficulty`: `beginner` | `intermediate` (default) | `advanced`; `confidence`: `low` | `medium` (default) | `high`.

| Endpoint | Notes |
| --- | --- |
| `GET /api/procedures` | `{ "procedures": [...], "total": n }` — each includes `linkedDocuments` and `linkedSymptoms` |
| `GET /api/procedures/:id` | `{ "procedure": {...} }` |
| `POST /api/procedures` | body: `title` (required), `system`, `difficulty`, `confidence`, `toolsNeeded`, `partsNeeded`, `safetyNotes`, `steps`, `notes`, `linkedDocumentIds` (array). `201` → `{ "message", "procedure" }` |
| `PUT /api/procedures/:id` | same fields; partial update |
| `PUT /api/procedures/:id/symptoms` | body `{ "symptomIds": [3] }` — replaces the whole linked set |
| `DELETE /api/procedures/:id` | also removes links and image attachments |

---

## Notes

Allowed values — `noteType`: `general` (default) | `observation` | `repair_log` | `reminder`; `relatedEntityType`: `none` (default) | `document` | `symptom` | `procedure`.

| Endpoint | Notes |
| --- | --- |
| `GET /api/notes` | `{ "notes": [...], "total": n }` — linked records come back expanded as `linkedDocument` / `linkedSymptom` / `linkedProcedure` |
| `POST /api/notes` | body: `title` (required), `content`, `noteType`, `relatedEntityType`, `relatedEntityId`. If `relatedEntityType` is not `none`, `relatedEntityId` is required and must point at an existing record. `201` → `{ "message", "note" }` |
| `PUT /api/notes/:id` | same fields; partial update |
| `DELETE /api/notes/:id` | also removes the note's image attachments |

A note links to **at most one** related record.

---

## Attachments (images on symptoms/procedures/notes)

JPEG, PNG, or WebP only. Size capped by `MAX_UPLOAD_SIZE_MB`. Documents stay PDF-only — attachments are a separate image feature and never enter search chunks.

| Endpoint | Notes |
| --- | --- |
| `GET /api/attachments?entityType=symptom&entityId=3` | list one entity's images → `{ "attachments": [...] }` |
| `GET /api/attachments/all` | every saved image, newest first (feeds the Vision Ask picker) |
| `GET /api/attachments/:id/file` | streams the image inline |
| `POST /api/attachments` | multipart: `image` (file), `entityType` (`symptom`\|`procedure`\|`note`), `entityId`, optional `caption`. `201` → `{ "message", "attachment" }` |
| `DELETE /api/attachments/:id` | removes the row and the stored file |

```powershell
curl.exe -X POST http://localhost:4000/api/attachments `
  -F "image=@C:\photos\pad-wear.jpg" -F "entityType=symptom" -F "entityId=3" -F "caption=Inner pad wear"
```

---

## Settings

### `GET /api/settings`

```json
{
  "vehicle": { "id": 1, "year": 2009, "make": "Toyota", "model": "Corolla", "trim": "LE", "engine": "1.8L" },
  "runtime": { "databaseFile": "...", "uploadsDir": "...", "maxUploadSizeMb": 20, "port": 4000, "clientPort": 5173, "pathsEditable": false },
  "documentDefaults": { "commonSystems": [...], "documentTypes": [...] },
  "backupExport": { "supported": true, ... }
}
```

`runtime` is the fastest way to check which database/uploads paths the live server is actually using.

### `PUT /api/settings/vehicle`

Body: `year` (integer 1900–2100), `make` (required), `model` (required), `trim`, `engine`.

### `PUT /api/settings/document-defaults`

Body: `commonSystems`, `documentTypes` — the option lists offered on the upload form.

### `GET /api/settings/backup-export`

Streams `corolla-fix-helper-backup-<timestamp>.tar.gz` (database + entire uploads tree) as a download. `500` with `{ "error": "Could not create backup export archive." }` if `tar` fails — see the [runbook](runbook.md#backup-export-fails). Restore is a CLI operation, not an API call ([backup-restore.md](backup-restore.md)).

---

## Keeping This Document Honest

This reference was written against the route files on 2026-07-02. When routes change, update this file in the same PR — the route files in `server/src/routes/` are always the source of truth.
