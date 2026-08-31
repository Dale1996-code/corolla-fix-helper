# Corolla Fix Helper Data Model

This file summarizes the current SQLite data model. SQLite is a local database stored as one file.

The current app is centered on one vehicle:

- 2009 Toyota Corolla LE 1.8L

The full app architecture is described in `docs/architecture.md`.

## Storage

- Database file: configured by `DATABASE_FILE`
- Uploaded PDF folder: configured by `UPLOADS_DIR`
- Image attachment folder: `UPLOADS_DIR` + `/attachments/images/` (kept inside the uploads tree so backups capture it automatically)
- Default local database path: `server/data/corolla-fix-helper.db`
- Default local upload path: `server/uploads`

In a Google Compute Engine demo, both paths should point to persistent storage so data survives app restarts.

## Main Tables

### `vehicles`

Stores the single vehicle profile.

Important fields:

- `id`
- `year`
- `make`
- `model`
- `trim`
- `engine`
- `created_at`

### `app_settings`

Stores reusable Settings values.

Important fields:

- `id`
- `document_system_defaults`
- `document_type_defaults`
- `updated_at`

The app keeps one settings row with `id = 1`.

### `documents`

Stores uploaded PDF records and metadata.

Important fields:

- `id`
- `vehicle_id`
- `title`
- `original_filename`
- `stored_filename`
- `file_path`
- `file_type`
- `system`
- `subsystem`
- `document_type`
- `source`
- `notes`
- `file_md5`
- `extracted_text`
- `extraction_status`
- `page_count`
- `is_favorite`
- `is_bookmarked`
- `created_at`
- `updated_at`

Current use:

- Upload and store PDFs locally.
- Edit metadata.
- Track extraction status and page count.
- Store OCR text in `extracted_text` when low-text PDF pages are OCR-read.
- Mark favorites.
- Mark bookmarks.
- Apply freeform tags.
- Open stored PDFs.
- Re-run extraction for one saved document.
- Skip duplicate files during bulk import.
- Delete documents and clean up related links.

`file_md5` stores the MD5 hash of imported PDF bytes. MD5 is used here as a duplicate key for local repair PDFs, not as a security feature.

Favorites (`is_favorite`) and bookmarks (`is_bookmarked`) are two independent saved-document flags. Tags are stored separately in the `tags` and `document_tags` tables.

### `tags`

Stores the distinct tag names used to label documents.

Important fields:

- `id`
- `name`
- `created_at`

Tag names are unique case-insensitively (`idx_tags_name` is a `COLLATE NOCASE` unique index). When a document is tagged, an existing tag with the same name (any casing) is reused, so each tag keeps one canonical spelling. Tags that are no longer linked to any document are pruned automatically.

### `document_tags`

Links documents to tags.

Important fields:

- `document_id`
- `tag_id`
- `created_at`

One document can carry many tags. One tag can label many documents. Rows are removed by `ON DELETE CASCADE` when either the document or the tag is deleted.

### `symptoms`

Stores problems or observations about the car.

Important fields:

- `id`
- `vehicle_id`
- `title`
- `description`
- `system`
- `suspected_causes`
- `confidence`
- `severity`
- `status`
- `notes`
- `first_observed_at`
- `created_at`
- `updated_at`

Current use:

- Create, edit, and delete symptoms.
- Search, filter, and sort symptoms.
- Link symptoms to documents.
- Link symptoms to procedures (see `symptom_procedures`).
- Attach images (stored in the `attachments` table).

### `symptom_documents`

Links symptoms to documents.

Important fields:

- `symptom_id`
- `document_id`

One symptom can link to many documents. One document can support many symptoms.

### `procedures`

Stores repair procedures and work notes.

Important fields:

- `id`
- `vehicle_id`
- `title`
- `system`
- `difficulty`
- `tools_needed`
- `parts_needed`
- `safety_notes`
- `steps`
- `confidence`
- `status`
- `notes`
- `created_at`
- `updated_at`

Current use:

- Create, edit, and delete procedures.
- Store steps, tools, parts, safety notes, difficulty, and confidence.
- Search, filter, and sort procedures.
- Link procedures to documents.
- Link procedures to symptoms (see `symptom_procedures`).
- Attach images (stored in the `attachments` table).

### `procedure_documents`

Links procedures to documents.

Important fields:

- `procedure_id`
- `document_id`

One procedure can link to many documents. One document can support many procedures.

### `symptom_procedures`

Links symptoms directly to procedures, in either direction.

Important fields:

- `symptom_id`
- `procedure_id`

The composite primary key is `(symptom_id, procedure_id)`, and both foreign keys
use `ON DELETE CASCADE`, so deleting a symptom or a procedure clears its links.
One symptom can link to many procedures, and one procedure can link to many
symptoms. The links are managed with `PUT /api/symptoms/:id/procedures` and
`PUT /api/procedures/:id/symptoms`.

### `notes`

Stores freeform notes.

Important fields:

- `id`
- `vehicle_id`
- `document_id`
- `title`
- `body`
- `content`
- `note_type`
- `related_entity_type`
- `related_entity_id`
- `created_at`
- `updated_at`

Current use:

- Create, edit, and delete notes.
- Organize notes by note type.
- Link one note to one document, symptom, or procedure.
- Return linked record details as `linkedDocument`, `linkedSymptom`, or `linkedProcedure`.
- Attach images (stored in the `attachments` table).

Older note rows may still use `document_id` and `body`. The server includes backfill logic to keep older rows usable.

### `repair_checklists`

Stores repair checklists: a titled, status-tracked list of steps for a job. Added by migration `002_repair_checklists`.

Important fields:

- `id`
- `vehicle_id`
- `title`
- `status` (`planned`, `in_progress`, `blocked`, or `done`; the UI shows `in_progress` as "In progress")
- `description`
- `notes`
- `created_at`
- `updated_at`

Current use:

- Create, edit, and delete checklists (`/api/repair-checklists`).
- Change a checklist's status.
- `updated_at` is bumped when the checklist's own fields change and when its items change (add, check off, edit, delete, reorder), so the list stays ordered by recent activity.

Checklists carry no links to symptoms, procedures, or notes, and no image attachments. The one structured relationship they do have is to **documents**, through `repair_checklist_documents` below — added by N3.2 so planner evidence survives the save.

`status = 'done'` is an **organizational state only**. It files a checklist under "Done" on the Checklists page and does not record that a repair happened. Recording a repair is the separate, explicit `POST /api/repair-checklists/:id/complete` action, which needs facts a status dropdown cannot supply (the date the work happened, the odometer reading, the outcome). The implication runs one way: completing a checklist sets it to `done`; marking it `done` completes nothing.

### `repair_checklist_items`

Stores the ordered steps that belong to one checklist.

Important fields:

- `id`
- `checklist_id`
- `text`
- `is_done` (`0` or `1`)
- `sort_order`
- `created_at`
- `updated_at`

New items are appended at `MAX(sort_order) + 1`. Reordering swaps a row's `sort_order` with its neighbor (the `Up`/`Down` buttons) inside a transaction. The `checklist_id` foreign key uses `ON DELETE CASCADE`, so deleting a checklist removes its items. Items are indexed by `idx_repair_checklist_items_checklist`.

### `repair_checklist_documents`

Stores which document page backed a checklist — the **durable, structured** form of a Repair Planner citation. Added by migration `005_repair_checklist_provenance` (roadmap **N3.2**).

**The gap this closes.** A planner run produces citations that each already carry a `documentId` and a `pageNumber`. Before N3.2, `buildPlannerChecklistDraft` rendered those into prose (`Toyota Repair Manual, page 412`) and dropped the structure: the saved checklist held a sentence a human could read and nothing a query could follow. N3.1 built the destination (`repair_history_documents`); this table is the missing middle, so the chain runs end to end:

`planner evidence` → `repair_checklist_documents` → checklist completion → `repair_history` → `repair_history_documents`

Fields:

- `id`
- `repair_checklist_id` → `repair_checklists(id)`, `ON DELETE CASCADE`
- `document_id` → `documents(id)`, nullable, `ON DELETE SET NULL`
- `document_title` — snapshot taken at write time
- `page_number` — nullable, `CHECK (page_number IS NULL OR page_number > 0)`
- `created_at`

Same **live foreign key + historical snapshot** strategy as `repair_history_documents`, column for column, because it is the same kind of fact at an earlier moment and completion copies one into the other verbatim. `document_id` follows the live document and goes `NULL` when it is deleted; `document_title` and `page_number` are frozen at write time and always survive. Renaming a document does not change an existing snapshot.

The `CASCADE` on `repair_checklist_id` is the ordinary parent/child one — these rows mean nothing without their checklist. That is safe **because completion copies them** into `repair_history_documents` rather than pointing at them, so deleting a completed checklist later drops these rows and leaves the historical copy whole.

Indexed by `idx_repair_checklist_documents_checklist` for the ordinary read, `idx_repair_checklist_documents_document` to cover the `ON DELETE SET NULL` sweep, and the partial `idx_repair_checklist_documents_unique` on `(repair_checklist_id, document_id, page_number) WHERE document_id IS NOT NULL` as a backstop. As with its `repair_history_documents` twin, that index is not the deduplication guarantee — SQLite treats `NULL`s as distinct — so duplicate planner citations are collapsed deterministically (first-seen order on `documentId:pageNumber`) in `plannerChecklistDraft.js` and `repairChecklistProvenanceService.js`.

**Writes are server-derived only.** `POST /api/repair-checklists/from-planner` takes a `checklistDraftId` and nothing else; the provenance comes from the server-held, deep-frozen planner draft. A `sources` field in the request body is ignored. The browser is never the authority for which document backed a repair.

**What is deliberately not stored here** (identical to `repair_history_documents`): planner `sourceId` values (`S1`, `S2`, …), chunk ids, embedding ids, and the plan run id. Source ids are scoped to the run that minted them — request-local for Ask, run-wide for the planner — `document_chunks` rows are rebuilt whenever a PDF is re-extracted, and a plan run is an in-memory record that expires in hours. None of the three can be resolved by a reader weeks later, which is exactly when a repair history is read. `document_id` + title snapshot + `page_number` is the only identity that outlives all of them.

### `repair_history`

Stores a repair that was actually carried out: when, at what mileage, why, what happened, and which documents backed it. Added by migration `004_repair_history`. This is the persistence foundation of roadmap item **N3**; there is no UI for it yet.

Important fields:

- `id`
- `vehicle_id`
- `performed_on` — the calendar day the work happened, stored as `YYYY-MM-DD` text. Validated strictly (see below); distinct from `created_at`, which is when the row was written
- `odometer_miles` — whole miles, `NULL` when not recorded, `CHECK`-constrained to 0–2,000,000
- `title`
- `outcome` (`fixed`, `partial`, `not_fixed`, or `unknown` — the default; `CHECK`-constrained)
- `summary` — what actually happened
- `follow_up` — free text for anything to check later. Not a reminder or a schedule
- `symptom_id` → `symptoms(id)`, `ON DELETE SET NULL`
- `symptom_title` — snapshot
- `checklist_id` → `repair_checklists(id)`, `ON DELETE SET NULL`
- `checklist_title` — snapshot
- `created_at`
- `updated_at`

Listed by `performed_on DESC, id DESC` — by the day the work happened, unlike the other lists in this app, which order by recent activity. Correcting a typo in an old record must not move it to the top of the log. Indexed by `idx_repair_history_vehicle_performed` for that filter-then-sort, plus `idx_repair_history_symptom` and `idx_repair_history_checklist` to cover the `ON DELETE SET NULL` sweeps.

**One checklist is one repair.** `idx_repair_history_checklist_unique`, a partial unique index on `(checklist_id) WHERE checklist_id IS NOT NULL` added by migration `005_repair_checklist_provenance`, is the guarantee that completing a checklist twice cannot record the same physical job twice. It binds **both** entry points — the CRUD route and `POST /api/repair-checklists/:id/complete` — because one repair recorded twice is the same mistake whichever door it came through. The services check first so a repeat gets an explanatory response rather than a constraint error, but the index is what makes the guarantee true rather than merely likely. The predicate is required because `checklist_id` is `ON DELETE SET NULL`: once a completed checklist is deleted its history row drops to `NULL`, and any number of such orphaned records may coexist.

### `repair_history_documents`

Stores which document pages backed one repair. Since N3.2 this is normally a **copy** of the completed checklist's `repair_checklist_documents` rows, taken verbatim at completion — including `document_id NULL` where the cited document had already been deleted. Copying rather than referencing is what lets the checklist be deleted afterwards without touching the history.

Important fields:

- `id`
- `repair_history_id` → `repair_history(id)`, `ON DELETE CASCADE`
- `document_id` → `documents(id)`, `ON DELETE SET NULL`
- `document_title` — snapshot
- `page_number` — snapshot of the cited page; `NULL` when the citation is whole-document. `CHECK`-constrained to a positive number
- `created_at`

`idx_repair_history_documents_unique` is a **partial** unique index on `(repair_history_id, document_id, page_number) WHERE document_id IS NOT NULL`. The predicate is required: once a document is deleted, several provenance rows can drop to `document_id NULL` under one history record, and an unfiltered unique index would treat them as colliding. It is a backstop only — SQLite treats `NULL`s as distinct, so duplicate caller input is collapsed deterministically in `repairHistoryService.js` rather than by relying on a constraint error.

Planner `sourceId` values (`S1`, `S2`, …) and `document_chunks.id` are deliberately **not** stored. Source ids are request-local (Ask) or run-wide (planner) and mean nothing outside the run that minted them; chunk rows are rebuilt on re-extraction, so a chunk id goes stale the next time a PDF is re-extracted. `document_id` + `page_number` survives both, and is what the client's `buildDocumentFileLink` needs to deep-link a cited page.

### Historical integrity: live foreign key + snapshot

Repair history is the one place in this schema where a row must stay true after the records it points at change. Both halves of the strategy carry weight:

- **Every inbound foreign key is `ON DELETE SET NULL`, never `CASCADE`.** Deleting a symptom, a checklist, or a document must not delete the owner's record that they did the work. This matches what `documentService.deleteDocument` already does by hand for note links. The only `CASCADE` is `repair_history` → `repair_history_documents`, where the child genuinely belongs to the parent.
- **The `*_title` columns are snapshots taken at write time.** They keep a history row readable after its links are gone or its linked records were renamed.

The snapshots are therefore written **only** by the code path that explicitly changes the relationship they belong to. Editing a summary, outcome, follow-up, odometer, date, or title leaves every snapshot alone; supplying `symptomId`, `checklistId`, or `sources` re-snapshots that relationship from the newly selected record. Renaming a symptom, editing a checklist, or deleting a document never rewrites a completed history record.

Creates and updates run in one `BEGIN IMMEDIATE` transaction covering both tables, so a repair record can never commit its header without its citations. Validation runs before the transaction opens, so invalid input is a `400` rather than a rolled-back write.

There is deliberately **no** `vehicles.current_odometer`. A reading taken on the day of a job is a historical fact; a "current" odometer is a derived maximum, and keeping both would create two writable sources of truth for one number with no rule for reconciling them. Nothing in the app reads a current odometer today, and `SELECT MAX(odometer_miles) FROM repair_history` answers the question if anything ever does.

### `document_chunks`

Stores smaller page-aware chunks of extracted PDF text for the Ask AI feature. OCR-created text uses the same table and keeps the original PDF page number.

Important fields:

- `id`
- `document_id`
- `page_number`
- `chunk_index`
- `chunk_text`
- `embedding`
- `embedding_version`
- `created_at`

Current use:

- Rebuilt after PDF upload and extraction re-run.
- Embedded by `npm run embed:backfill` using the active OpenAI embedding config.
- Retrieved by `POST /api/ask` before OpenAI answer generation.
- Used for citations back to document names and page numbers.

The table keeps each document, page, and chunk index unique so re-running extraction can replace old chunks cleanly.

`embedding` stores the Float32 embedding as a SQLite BLOB. `embedding_version` stores the active model and dimension pair, for example `text-embedding-3-small@512`. Hybrid retrieval ignores a chunk's vector for **semantic** ranking when its `embedding_version` does not match the current config, but the chunk still participates in keyword ranking — so changing the model/dimensions never removes a document from Ask, it just loses semantic ranking until `embed:backfill` re-embeds it.

### `attachments`

Stores image attachments for symptoms, procedures, and notes. Documents stay PDF-only and keep their own storage; image attachments are a separate, image-only feature.

Important fields:

- `id`
- `entity_type` (`symptom`, `procedure`, or `note`)
- `entity_id`
- `original_filename`
- `stored_filename`
- `file_path`
- `mime_type` (`image/jpeg`, `image/png`, or `image/webp`)
- `file_size`
- `caption`
- `created_at`

Current use:

- Upload images against a symptom, procedure, or note (`POST /api/attachments`).
- List the images for one entity (`GET /api/attachments?entityType=...&entityId=...`).
- Serve a stored image inline (`GET /api/attachments/:id/file`).
- List every saved image across all entities (`GET /api/attachments/all`), used by the Vision Ask picker on the Ask AI page.
- Delete one image and its file (`DELETE /api/attachments/:id`).

Vision Ask reuses these saved rows read-only: `POST /api/ask` accepts an optional `attachmentId`, and the server loads that record and its stored file to show the model the photo. Attachment images are never copied into `document_chunks`; documents stay PDF-only and remain the only source of repair facts.

The `(entity_type, entity_id)` pair is polymorphic and is **not** a foreign key (the same approach the note links use), so it is indexed by `idx_attachments_entity`. Because there is no `ON DELETE CASCADE`, the symptom, procedure, and note delete paths call `deleteAttachmentsForEntity(entityType, entityId)` to remove the rows and their stored files. Image files live under `UPLOADS_DIR/attachments/images/`.

## Search

There is no separate search table.

Current search endpoints use existing table data:

- `/api/search` and `/api/search/documents` search document metadata, notes, extracted text, tags, favorite state, and bookmark state. They also accept `tag` and `bookmarked` filters and return the list of in-use tags under `filters.tags`.
- `/api/search/symptoms` searches symptom fields.
- `/api/search/procedures` searches procedure fields.
- `/api/search/notes` searches note fields and linked record details.
- `/api/ask` retrieves matching `document_chunks` with hybrid keyword+embedding search and returns cited document Q&A results.

The current Ask retrieval embeds the question once, cosine-scans an in-memory cache of current chunk embeddings, and fuses that ranking with keyword ranking. It does not use a vector database or SQLite vector extension.

## Schema Migrations

Schema changes are tracked in a `schema_migrations` table (`id`, `name`, `applied_at`). On startup `initDatabase.js` ensures that table exists, then runs each numbered migration exactly once via `runMigration(name, fn)` — the migration body and its bookkeeping insert share one transaction, so a failure rolls back without recording a half-applied migration.

Convention: name migrations `NNN_short_description` in increasing order, starting at `001_initial_schema` (which wraps the original `CREATE TABLE` / `ensureColumn` setup). To change the schema, add a new numbered migration rather than editing an applied one. The initial schema is idempotent, so existing databases simply record `001` on their first startup after this was introduced — no data is dropped or rewritten.

Applied migrations:

- `001_initial_schema` — original tables, columns, and indexes.
- `002_repair_checklists` — adds the `repair_checklists` and `repair_checklist_items` tables.
- `003_link_and_sort_indexes` — adds `idx_documents_created_at` plus reverse-link indexes on `symptom_documents.document_id`, `procedure_documents.document_id`, and `symptom_procedures.procedure_id`, and adds `idx_repair_checklists_vehicle_updated` and `idx_repair_checklist_items_order` for checklist sorting. Index-only: no new tables or columns.
- `004_repair_history` — adds the `repair_history` and `repair_history_documents` tables and their indexes. Purely additive: no existing table is altered, and in particular `vehicles` gains no odometer column.
- `005_repair_checklist_provenance` — adds the `repair_checklist_documents` table and its indexes, plus the partial unique index `idx_repair_history_checklist_unique` on the existing `repair_history` table. Additive: no existing table is altered and no column is added or changed. The migration refuses to apply if a checklist is already linked to more than one `repair_history` row, so the "one checklist is one repair" rule fails with a sentence naming the offending checklist rather than a bare constraint error at startup.

## Not In The Current Schema

The current schema does not include:

- user accounts
- cloud sync tables
- multi-vehicle UI support beyond the existing vehicle table
- separate vector database or vector-extension tables
- a vehicle-level current odometer (`vehicles` has no mileage column — see `repair_history` above)
- parts used and repair cost (a later N3 slice; when cost lands it will be integer `cost_cents`, never a float or text)
- maintenance reminders and service intervals (not an N3 slice at all — the app records what was done, it does not schedule)
