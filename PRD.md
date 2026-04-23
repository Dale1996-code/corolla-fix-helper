# Corolla Fix Helper - Product Requirements (V1)

## 1) Product summary

Corolla Fix Helper is a local-first repair helper for one vehicle:

- 2009 Toyota Corolla LE 1.8L

Version 1 is no longer just a PDF organizer. The current product combines:

- repair documents
- whole-app search
- dashboard summaries
- symptom tracking
- procedure tracking
- repair notes

The app is meant to help one person keep repair information in one local workspace while working on the car.

## 2) V1 product rules

- One vehicle only
- Local-first storage
- No cloud dependency
- Real repair usefulness over extra features
- Beginner-friendly code and structure

## 3) In scope for V1

### Core workspace

- Sidebar-based app shell
- Dashboard page
- Documents page
- Search page
- Symptoms page
- Procedures page
- Notes page

### Documents

- Upload PDF documents into local storage (`server/uploads`)
- Store document metadata in SQLite
- Attempt PDF text extraction
- Store extraction status
- Store page count
- Edit document metadata after upload
- Mark documents as favorite
- Open uploaded PDFs from the app
- Sort and filter documents
- View document details
- Use favorites as the only saved-document flag in V1

### Search

- Search documents, symptoms, procedures, and notes from one page
- Keep each search area separate with its own filters and results

### Symptoms

- Create, edit, and delete symptoms
- Track symptom status, confidence, system, and notes
- Link symptoms to supporting documents

### Procedures

- Create, edit, and delete procedures
- Track steps, tools, parts, safety notes, difficulty, and confidence
- Link procedures to supporting documents
- Search procedures by title, system, tools, parts, steps, and notes
- Filter procedures by system, difficulty, and confidence
- Sort procedures by newest update, oldest update, or title
- Show a visible count while browsing the filtered procedure list
- Keep the details panel synced to a visible procedure when filters change

### Notes

- Create, edit, and delete notes
- Organize notes by note type
- Link notes to documents, symptoms, and procedures in the current UI
- Browse saved notes with note type, linked item, and sort controls
- Show note details with the linked record title and an open link to that record

### Settings

- Edit the single stored vehicle profile
- Show local runtime info for database path, uploads path, upload size limit, and ports
- Keep runtime path editing out of the browser

## 4) Out of scope right now

- AI chat
- embeddings or vector database
- cloud sync
- completed OCR pipeline beyond the current PDF extraction attempt
- multi-vehicle support
- auth
- voice features
- parts integrations
- document tags
- document bookmarks
- major architecture rewrites

## 5) Primary user workflows

### Document workflow

1. Upload a repair PDF
2. Add or fix basic metadata
3. Review extraction status and page count
4. Favorite important documents
5. Open the PDF again when needed

### Repair tracking workflow

1. Record a symptom
2. Link helpful documents to that symptom
3. Create or update a repair procedure
4. Link helpful documents to that procedure
5. Save notes while diagnosing or repairing the car

### Daily use workflow

1. Open the Dashboard to see recent activity
2. Search the saved workspace when you need a manual, symptom, procedure, or note
3. Update symptoms, procedures, and notes as repair work changes

## 6) Definition of useful

Version 1 is useful if it is:

- fast to run on one local machine
- easy to understand
- good at storing and reopening repair PDFs
- good at tracking symptoms, procedures, and notes in one place
- honest about current local-only limits
