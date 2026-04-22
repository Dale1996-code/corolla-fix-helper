# Corolla Fix Helper - Current Data Model

## Purpose
This file explains the main SQLite tables used by the current app.

The app is local-first and currently centered on one vehicle:
- 2009 Toyota Corolla LE 1.8L

The current v1 workflow is built around:
- imported repair documents
- symptom tracking
- repair procedures
- notes
- document search

## Main entities

### `vehicles`
Stores vehicle information.

Current v1 expectation:
- the app is used for one Corolla, so this table is effectively a single-vehicle anchor

Main fields:
- `id`
- `year`, `make`, `model`, `trim`, `engine`
- `created_at`

### `documents`
Stores uploaded PDF records and their metadata.

This is the document library used by the Documents, Search, Dashboard, Symptoms, Procedures, and Notes workflows.

Main fields:
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
- `extracted_text`
- `extraction_status`
- `page_count`
- `is_favorite`
- `created_at`
- `updated_at`

Current v1 use:
- upload and store PDFs locally
- edit metadata
- track extraction status
- track page count
- mark favorites
- open the stored PDF from the app

Important note:
- favorites are the only saved-document flag supported in the current V1 workflow
- older databases may still contain leftover bookmark or tag data from earlier experiments, but the current app does not use them

### `symptoms`
Stores repair symptoms or problems the user wants to track.

Main fields:
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

Current v1 use:
- create, edit, and delete symptoms
- organize symptoms by system and status
- link symptoms to supporting documents

Important note:
- `severity` and `first_observed_at` exist in the database, but they are not the main focus of the current UI

### `symptom_documents`
Join table that links symptoms to documents.

Main fields:
- `symptom_id`
- `document_id`

Current v1 use:
- one symptom can link to many documents
- one document can support many symptoms

### `procedures`
Stores repair procedures, checklists, and step-by-step work notes.

Main fields:
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

Current v1 use:
- create, edit, and delete procedures
- store tools, parts, safety notes, and steps
- link procedures to supporting documents

Important note:
- `status` exists in the schema, but it is not a major part of the current confirmed UI workflow

### `procedure_documents`
Join table that links procedures to documents.

Main fields:
- `procedure_id`
- `document_id`

Current v1 use:
- one procedure can link to many documents
- one document can support many procedures

### `notes`
Stores freeform notes for the vehicle.

Main fields:
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

Current v1 use:
- create, edit, and delete notes
- store note title and main note content
- link notes to one document, symptom, or procedure in the current UI
- return linked record details in the API as `linkedDocument`, `linkedSymptom`, or `linkedProcedure`

Important note:
- `related_entity_type` stores whether the note is linked to a `document`, `symptom`, `procedure`, or to `none`
- `related_entity_id` stores the matching record ID when a link is present
- older note rows may still use `document_id` and `body`; the server includes backfill logic to keep older data usable

## Supporting tables

## Search data expectations
There is no separate search table.

The current `/api/search` route searches document data using fields already stored in `documents`, especially:
- document metadata
- extracted text
- favorite filter state

Current v1 meaning:
- Search is a one-page workspace search with separate sections for documents, symptoms, procedures, and notes
