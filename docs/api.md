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
- **Rate limits:** `POST /api/ask` and `POST /api/repair-plan` share **one** 20-requests-per-minute window (in-house limiter, `server/src/middleware/rateLimit.js`) — not one window each. Everything else is unlimited.
- **PowerShell examples:** plain `GET`/download requests use `curl.exe` (the real curl, not the PowerShell alias). Requests with a **JSON body** use `Invoke-RestMethod` instead. This is deliberate: passing inline JSON to `curl.exe` is mangled by Windows PowerShell 5.1's parser — it strips the double quotes before curl ever sees them (a literal, a `$variable`, and `ConvertTo-Json` output all break the same way), so the server receives invalid JSON and returns `400`. `Invoke-RestMethod` hands its `-Body` to the request in-process, so the JSON survives intact in both Windows PowerShell 5.1 and PowerShell 7. Multipart uploads (`-F`) still use `curl.exe`; if a field value contains spaces, run those from PowerShell 7 or a POSIX shell to avoid the same 5.1 quoting issue.

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
| `GET/POST /api/repair-checklists`, `GET/PUT/DELETE /api/repair-checklists/:id` | Repair checklist CRUD |
| `POST /api/repair-checklists/:id/items`, `PUT/DELETE .../items/:itemId`, `POST .../items/:itemId/move` | Checklist item add / edit / delete / reorder |
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
$body = @{ isFavorite = $true; tags = @("torque-specs", "front-end") } | ConvertTo-Json
Invoke-RestMethod -Method Put -Uri http://localhost:4000/api/documents/12 `
  -ContentType "application/json" -Body $body
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
| `GET /api/search` and `GET /api/search/documents` | `q`, `system`, `documentType`, `favorite`, `bookmarked`, `tag`, `sort`, `limit`, `offset` |
| `GET /api/search/symptoms` | `q`, `system`, `status`, `sort` |
| `GET /api/search/procedures` | `q`, `system`, `difficulty`, `sort` |
| `GET /api/search/notes` | `q`, `noteType`, `relatedEntityType`, `sort` |

Document search covers metadata, notes, extracted text (including OCR text), and tags.

**Document search is always paged.** It is the one scope that can grow into the thousands, so `/api/search` and `/api/search/documents` add `limit`, `offset`, and `hasMore` to the shared shape and never return the whole library — including when no pagination params are sent. `limit` defaults to 25 and is capped at 100; `offset` defaults to 0. Missing, negative, fractional, non-numeric, and oversized values fall back to those defaults rather than erroring. `total` is the full count of matching documents (a separate `COUNT(*)` over the same filters), not the number of rows in `results`. Results carry a server-built `snippet`, never the full `extractedText`. The other three scopes are unpaged and unchanged.

```powershell
curl.exe "http://localhost:4000/api/search/documents?q=caliper&system=Brakes"
curl.exe "http://localhost:4000/api/search/documents?limit=25&offset=50"
```

---

## Ask Your Documents (RAG)

### `POST /api/ask`  *(rate limited: 20/min)*

| Body field | Required | Notes |
| --- | --- | --- |
| `question` | ✅ | max 2000 characters |
| `history` | – | prior conversation turns as `{ role, content }` objects (`role` is `"user"` or `"assistant"`, anything else is treated as `"user"`); used to rewrite vague follow-ups into a standalone question. Only the most recent turns are kept and each `content` is truncated. Turns in any other shape (e.g. `{question, answer}`) are ignored, silently dropping follow-up context |
| `attachmentId` | – | id of one **already-saved** image attachment (Vision Ask) — never raw image data |

```powershell
$body = @{ question = "What is the oil drain plug torque spec?" } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://localhost:4000/api/ask `
  -ContentType "application/json" -Body $body
```

Response:

```json
{
  "question": "What is the oil drain plug torque spec?",
  "standaloneQuestion": "What is the oil drain plug torque spec?",
  "status": "answered",
  "answer": "The oil drain plug torque is 37 N·m (27 ft·lbf). [Engine Repair Manual, page 14]",
  "citations": [
    {
      "evidenceId": "ask_ev_v1_0123456789abcdef01234567",
      "documentId": 3,
      "documentTitle": "Engine Repair Manual",
      "originalFilename": "engine-repair.pdf",
      "pageNumber": 14,
      "chunkIndex": 2,
      "snippet": "Install the oil drain plug with a new gasket. Torque: 37 N·m (27 ft·lbf).",
      "evidenceQuote": "Install the oil drain plug with a new gasket. Torque: 37 N·m (27 ft·lbf)."
    }
  ],
  "evidence": {
    "documentSupported": [
      {
        "evidenceId": "ask_ev_v1_0123456789abcdef01234567",
        "claim": "The oil drain plug torque is 37 N·m (27 ft·lbf).",
        "evidenceQuote": "Install the oil drain plug with a new gasket. Torque: 37 N·m (27 ft·lbf).",
        "documentId": 3,
        "documentTitle": "Engine Repair Manual",
        "originalFilename": "engine-repair.pdf",
        "pageNumber": 14,
        "chunkIndex": 2
      }
    ],
    "generalGuidance": [],
    "gaps": []
  }
}
```

`status` values:

- `answered` — answer generated from retrieved chunks, with citations
- `partial` — at least one claim verified, but one or more requested facts were not verified
- `unverified` — legacy compatibility mode produced prose that was not checked claim by claim; `citations` is always empty
- `not_found` — the uploaded documents don't contain enough matching information ("not in documents"); this is deliberate refusal, not an error
- `ai_not_configured` — matching chunks exist but no `OPENAI_API_KEY` is set

#### `retrievedContext` (not-found and unverified replies only)

A `not_found` reply always returns `citations: []`. When retrieval *did* find
passages that simply were not good enough to answer from, those passages are
additionally returned as `retrievedContext` so a refusal is not a dead end. It is
**omitted entirely** when it would be empty:

| Case | `citations` | `retrievedContext` |
| --- | --- | --- |
| `answered` / `partial` | only passages that backed verified claims | absent (the answer already cites its sources) |
| `unverified` | `[]` | present when passages were retrieved; they are not proof of the prose |
| `not_found`, passages retrieved | `[]` | present, non-empty |
| `not_found`, nothing retrieved | `[]` | absent |
| `ai_not_configured` | `[]` | absent |

Entries use the same shape as `citations`. These passages were **not** used to
answer and are not endorsed as correct — the UI labels them "Retrieved context
(may include passages the answer did not use)".

```json
{
  "question": "What is the water pump torque?",
  "standaloneQuestion": "What is the water pump torque?",
  "status": "not_found",
  "answer": "not in documents",
  "citations": [],
  "retrievedContext": [
    {
      "documentId": 12,
      "documentTitle": "Engine Mechanical Torque Specifications",
      "originalFilename": "engine-torque.pdf",
      "pageNumber": 3,
      "chunkIndex": 0,
      "snippet": "..."
    }
  ]
}
```

#### `evidence` (the default; `ASK_EVIDENCE_CONTRACT=true`)

With the evidence contract enabled, Ask requests atomic claims instead of prose
and applies server-side source, quote, and numeric checks before a claim can
render. The response gains an `evidence` object and `status` may additionally be
`partial`:

| Field | Meaning |
| --- | --- |
| `evidence.documentSupported[]` | Claims that passed the checks below. Each carries `evidenceId`, `claim`, the verbatim `evidenceQuote`, and the source (`documentId`, `documentTitle`, `originalFilename`, `pageNumber`, `chunkIndex`). |
| `evidence.generalGuidance[]` | General mechanical advice explicitly NOT from the documents. Never contains a specification. |
| `evidence.gaps[]` | What the documents do not answer, plus anything removed by verification. |

Server-side verification, in order:

1. The reply must match the JSON schema (hand-written validator).
2. Each `sourceId` (`S1`..`Sn`, prompt-local; never a database row id) must map to a retrieved chunk.
3. The `evidenceQuote` must be a genuine substring of that chunk (whitespace- and case-insensitive).
4. Every unit-bearing number in the claim must be present in the quote, allowing conversions within a unit family (37 N·m grounds a 27 ft-lbf claim).
5. For recognized torque-claim wording, the complete normalized part name from the claim must also occur in the quote. This rejects an oil-filter-cap claim that cites an oil-drain-plug passage carrying the same torque value.
6. The server assigns a deterministic `evidenceId` from the document/page/chunk location and normalized verified quote, and copies that ID to the matching citation. The model cannot choose it.
7. `status` is derived by the server from what actually verified — never taken from the model.

Anything failing a step is removed from the answer and becomes a gap. **Gap text
never reprints the failing value**, so an ungrounded specification cannot render
under any heading. `citations` contains only chunks that backed a claim which
passed these checks, rather than every retrieved chunk.

On this path, each citation also carries the complete verified `evidenceQuote`
and the same `evidenceId` alongside its bounded `snippet` preview. The client
compares the server identifier, source location, and complete quote—not only a
shared preview prefix. Exact duplicate citations collapse; distinct quotes from
the same chunk remain separate because each may support a different atomic claim.

**Current integrity limits:** `ASK_EVIDENCE_CONTRACT` defaults to `true`. The
checks deterministically prove source identity, quote presence, supported
unit-bearing numbers, and lexical subject agreement for common torque wording.
They are not a general semantic-entailment engine: unrecognized sentence shapes,
non-numeric claims, pronouns, synonyms, and a long quote that mentions several
parts can still require human judgment. The subject rule intentionally favors a
safe rejection over guessing that two differently worded part names are equal.

Setting `ASK_EVIDENCE_CONTRACT=false` is an explicit compatibility escape hatch.
It changes a legacy successful reply to `status: "unverified"`, keeps the prose,
returns `citations: []`, and moves retrieved passages to `retrievedContext`. The
UI shows an amber "not document-backed" warning and never renders those passages
under Sources. This is a response-contract change for consumers that deliberately
disable verification; verified/default responses retain `answered`, `partial`,
or `not_found` and gain the additive `evidenceId` field.

`status` values on this path: `answered` (all claims verified, no gaps),
`partial` (some verified, some gaps), `not_found` (nothing verified).

**Model-call failures.** When the model reply cannot be confirmed as finished —
truncated, filtered, cancelled, still generating, refused, or malformed — the
request fails with a `500` and a short safe `error` string rather than returning
a partial answer. Provider error text is never forwarded to the client.

When `ASK_DEBUG_METRICS=true`, the response also includes a development-only
`metrics` object. The flag is off by default, so normal responses keep the shape
shown above. The object is log-safe: it contains measurements and numeric
references, never document text, titles, filenames, or citation snippets.

```json
{
  "metrics": {
    "retrievalMs": 12,
    "rewriteMs": 0,
    "answerMs": 842,
    "totalMs": 860,
    "chunkCount": 5,
    "citationCount": 2,
    "contextChars": 1840,
    "approxContextTokens": 460,
    "topSemanticScore": 0.91,
    "retrievalMode": "hybrid",
    "chunkRefs": [
      { "documentId": 3, "pageNumber": 14, "chunkIndex": 2 }
    ]
  }
}
```

The fields come directly from `buildAskMetrics` in
`server/src/services/aiAnswerService.js`:

- `retrievalMs`, `rewriteMs`, `answerMs`, and `totalMs` are rounded
  milliseconds for retrieval, question rewriting, answer generation, and the
  complete request.
- `chunkCount` and `citationCount` count the retrieved chunks and returned
  citations.
- `contextChars` is the total character count of retrieved chunk text, and
  `approxContextTokens` is `Math.ceil(contextChars / 4)`, a rough token estimate.
- `topSemanticScore` and `retrievalMode` describe the first retrieved chunk, or
  are `null` when there is no such value.
- `chunkRefs` contains one reference per retrieved chunk with only its numeric
  `documentId`, `pageNumber`, and `chunkIndex` values (or `null` when a value is
  unavailable).

Attachment-specific errors: `400` bad id, `404` unknown/missing file, `415` not a JPEG/PNG/WebP. A bad attachment fails **before** anything is sent to OpenAI.

---

## Repair Planner

### `POST /api/repair-plan`  *(rate limited: 20/min, streams Server-Sent Events)*

| Body field | Required | Notes |
| --- | --- | --- |
| `brief` | ✅ | free-text repair brief |
| `skillLevel`, `availableTools`, `availableParts`, `constraints` | – | strings feeding the readiness rubric |

```powershell
$body = @{
  brief = "Front brakes squeak when stopping. Replace the pads this weekend."
  skillLevel = "beginner"
} | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://localhost:4000/api/repair-plan `
  -ContentType "application/json" -Body $body
```

`skillLevel` must be `beginner`, `intermediate`, or `advanced` when present; anything else is a 400.

The response is `text/event-stream`; each frame is `data: <json>\n\n` with a `type` of `status`, `tool_call`, `tool_result`, `trace`, `ai_not_configured`, `error`, or `done`. The `done` frame carries `status: "completed"`, an `evidenceStatus` of `verified` / `partial` / `not_found`, the server-rendered plan in `text`, and the assembled `artifacts` (including `requirements` and `evidence.gaps`). The planner does **not** emit `text_delta`: model prose is discarded and the plan is rendered server-side from claims verified against the cited PDF text.

A run that cannot produce a verified plan emits an `error` frame with a `code` (`planner_incomplete` or `planner_invalid_output`), a `reason` (`no_canonical_task`, `turn_limit`, `invalid_final_contract`, `provider_incomplete`, `missing_terminal_event`, `malformed_tool_arguments`), and a fixed safe `message` — and **no** `done` frame and no artifacts.

`Invoke-RestMethod` waits for the stream to finish and returns the concatenated `data:` frames as text — to watch frames arrive live, run the equivalent `curl.exe -N` from a POSIX shell (Bash/WSL). Full protocol, tool list, and readiness rubric: [repair-planner.md](repair-planner.md).

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
$body = @{ title = "Squeak when braking"; system = "Brakes"; status = "open" } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://localhost:4000/api/symptoms `
  -ContentType "application/json" -Body $body
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

## Repair Checklists

Plan a repair as a list of steps you can check off. Each checklist belongs to the single vehicle and holds ordered items (the individual steps).

Allowed values — `status`: `planned` (default) | `in_progress` | `blocked` | `done`. A move takes `direction`: `up` | `down`.

Every write returns the **whole** checklist — its own fields plus `items`, `itemCount`, and `doneItemCount` — so the UI can re-render after any change without a second fetch. Editing, adding, deleting, or moving an item also bumps the parent checklist's `updatedAt`, which is why the list is ordered newest-activity-first.

| Endpoint | Notes |
| --- | --- |
| `GET /api/repair-checklists` | `{ "checklists": [...], "total": n }`, most recently updated first |
| `GET /api/repair-checklists/:id` | `{ "checklist": {...} }` |
| `POST /api/repair-checklists` | body: `title` (required), `status`, `description`, `notes`. `201` → `{ "message", "checklist" }` |
| `PUT /api/repair-checklists/:id` | same fields; partial update |
| `DELETE /api/repair-checklists/:id` | deletes the checklist; its items cascade away |
| `POST /api/repair-checklists/:id/items` | body: `text` (required). Appends an item to the end → `201 { "message", "checklist" }` |
| `PUT /api/repair-checklists/:id/items/:itemId` | body: `text` and/or `isDone` (boolean); partial update |
| `DELETE /api/repair-checklists/:id/items/:itemId` | removes one item |
| `POST /api/repair-checklists/:id/items/:itemId/move` | body `{ "direction": "up" }` — swaps the item with its neighbor. At the top/bottom of the list it is a no-op, not an error. |

```powershell
$body = @{ title = "Front brake job"; status = "in_progress" } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://localhost:4000/api/repair-checklists `
  -ContentType "application/json" -Body $body
```

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

This reference was written against the route files on 2026-07-02 and last updated 2026-07-25 (shared rate-limit wording). When routes change, update this file in the same PR — the route files in `server/src/routes/` are always the source of truth.
