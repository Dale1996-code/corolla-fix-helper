# Corolla Fix Helper Data Model

This file summarizes the current SQLite data model. SQLite is a local database stored as one file.

The current app is centered on one vehicle:

- 2009 Toyota Corolla LE 1.8L

The full app architecture is described in `docs/architecture.md`.

## Storage

- Database file: configured by `DATABASE_FILE`
- Uploaded PDF folder: configured by `UPLOADS_DIR`
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
- `created_at`
- `updated_at`

Current use:

- Upload and store PDFs locally.
- Edit metadata.
- Track extraction status and page count.
- Mark favorites.
- Open stored PDFs.
- Re-run extraction for one saved document.
- Skip duplicate files during bulk import.
- Delete documents and clean up related links.

`file_md5` stores the MD5 hash of imported PDF bytes. MD5 is used here as a duplicate key for local repair PDFs, not as a security feature.

Favorites are the current saved-document flag. Bookmarks and tags are not part of the current V1 workflow.

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

Older note rows may still use `document_id` and `body`. The server includes backfill logic to keep older rows usable.

### `document_chunks`

Stores smaller page-aware chunks of extracted PDF text for the "Ask your documents" feature.

Important fields:

- `id`
- `document_id`
- `page_number`
- `chunk_index`
- `chunk_text`
- `created_at`

Current use:

- Rebuilt after PDF upload and extraction re-run.
- Retrieved by `POST /api/ask` before OpenAI answer generation.
- Used for citations back to document names and page numbers.

The table keeps each document, page, and chunk index unique so re-running extraction can replace old chunks cleanly.

## Search

There is no separate search table.

Current search endpoints use existing table data:

- `/api/search` and `/api/search/documents` search document metadata, notes, extracted text, and favorite state.
- `/api/search/symptoms` searches symptom fields.
- `/api/search/procedures` searches procedure fields.
- `/api/search/notes` searches note fields and linked record details.
- `/api/ask` retrieves matching `document_chunks` and returns cited document Q&A results.

The current Ask retrieval is keyword-based. It does not use embeddings or a vector database.

## Not In The Current Schema

The current schema does not include:

- user accounts
- cloud sync tables
- multi-vehicle UI support beyond the existing vehicle table
- direct symptom-to-procedure join table
- vector or embedding tables
