# Corolla Fix Helper - Roadmap

## Current v1 scope

Version 1 is a local-first repair helper for one vehicle only:

- 2009 Toyota Corolla LE 1.8L

Current v1 includes:

- Dashboard
- Documents
- Document Search
- Symptoms
- Procedures
- Notes
- Settings

V1 finish status:

- finished for the planned local-first scope
- still intentionally limited to one vehicle and local-only storage

## Completed work

### Foundation

- [x] React + Vite client
- [x] Express server
- [x] SQLite database setup
- [x] Basic app shell and sidebar navigation

### Documents

- [x] PDF upload
- [x] Local file storage in `server/uploads`
- [x] Metadata saved in SQLite
- [x] PDF extraction attempt
- [x] Extraction status
- [x] Page count
- [x] Favorites
- [x] Open uploaded PDF
- [x] Sort and filter controls
- [x] Document detail panel
- [x] Metadata editing

### Document Search

- [x] Search API
- [x] Search page UI
- [x] Search filters for imported documents

### Dashboard

- [x] Summary cards
- [x] Recent activity sections
- [x] Quick links into the main app areas

### Symptoms

- [x] Symptoms CRUD
- [x] Status and confidence fields
- [x] Symptom-to-document linking
- [x] Symptoms page with create, edit, delete, list, and detail view
- [x] Symptoms search, filters, sort controls, and summary counts

### Procedures

- [x] Procedures CRUD
- [x] Procedure-to-document linking
- [x] Procedures page with create, edit, delete, list, and detail view

### Notes

- [x] Notes CRUD
- [x] Note type support
- [x] Document linking in the current UI
- [x] Notes page with list, filters, edit, delete, and detail view

### Settings

- [x] Settings page with editable vehicle profile
- [x] Read-only local runtime info for database path, uploads path, size limit, and ports

### QA and tests

- [x] Manual QA checklist
- [x] Basic backend route tests
- [x] Basic frontend smoke tests
