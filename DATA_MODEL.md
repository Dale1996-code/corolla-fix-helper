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
- Attach images (stored in the `attachments` table).

### `procedure_documents`

Links procedures to documents.

Important fields:

- `procedure_id`
- `document_id`

One procedure can link to many documents. One document can support many procedures.

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

### `document_chunks`

Stores smaller page-aware chunks of extracted PDF text for the "Ask your documents" feature. OCR-created text uses the same table and keeps the original PDF page number.

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

`embedding` stores the Float32 embedding as a SQLite BLOB. `embedding_version` stores the active model and dimension pair, for example `text-embedding-3-small@512`. Hybrid retrieval ignores chunks whose `embedding_version` does not match the current config.

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
- Delete one image and its file (`DELETE /api/attachments/:id`).

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

## Not In The Current Schema

The current schema does not include:

- user accounts
- cloud sync tables
- multi-vehicle UI support beyond the existing vehicle table
- direct symptom-to-procedure join table
- separate vector database or vector-extension tables
