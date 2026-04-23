# Corolla Fix Helper

Corolla Fix Helper is a local-first repair helper for one vehicle:

- 2009 Toyota Corolla LE 1.8L

It runs on your computer, stores data in a local SQLite database, and keeps uploaded PDF files in a local folder. The goal is to help you keep repair information, symptoms, procedures, and notes in one place while working on the car.

## Current v1 scope

Version 1 currently includes these main areas:

- Dashboard
- Documents
- Search
- Symptoms
- Procedures
- Notes
- Settings

Version 1 is still limited in a few important ways:

- Single vehicle only
- Local-first only
- No cloud sync
- No user accounts
- No AI chat

## What the app does right now

### Dashboard

The Dashboard gives a quick summary of the current project. It shows counts and recent activity for:

- documents
- symptoms
- procedures
- notes
- favorites

It also gives quick links into the main parts of the app.

### Documents

The Documents area is fully working for the main document workflow.

What it can do:

- upload PDF files
- save uploaded PDFs into `server/uploads`
- store document details in SQLite
- try to extract text from PDFs
- store extraction status
- store page count
- edit document metadata after upload
- mark documents as favorites
- open an uploaded PDF from the app
- use saved Settings suggestions while entering system and document type
- sort and filter the document list
- show document details in a side panel

For V1, favorites are the only saved-document flag in the app.
Tags and bookmarks are not part of the current document workflow.

Document fields currently used in the app include:

- title
- system
- subsystem
- document type
- source
- notes

### Search

The Search page is implemented.

It gives you four separate search sections on one page:

- documents
- symptoms
- procedures
- notes

Each section keeps its own keyword box, filters, and results so you can search one area without changing the others.

### Symptoms

The Symptoms feature is implemented.

What it can do:

- create symptoms
- edit symptoms
- delete symptoms
- store status and confidence
- link symptoms to documents
- show linked documents in the symptom details
- search symptoms by title, system, suspected causes, and notes
- filter symptoms by status and system
- sort symptoms by newest update, oldest update, or title
- show summary counts for open, monitoring, and resolved symptoms

### Procedures

The Procedures feature is implemented.

What it can do:

- create procedures
- edit procedures
- delete procedures
- store steps, tools, parts, safety notes, difficulty, and confidence
- link procedures to documents
- reuse saved Settings system suggestions while entering the system field
- search procedures by title, system, tools, parts, steps, and notes
- filter procedures by system, difficulty, and confidence
- sort procedures by newest update, oldest update, or title
- show a visible "Showing X of Y procedures" count while browsing
- keep the detail panel focused on a visible procedure when filters change

### Notes

The Notes feature is implemented.

What it can do:

- create notes
- edit notes
- delete notes
- organize notes by note type
- link notes to a document, symptom, or procedure in the current UI
- browse saved notes with note type, linked item, and sort controls
- show a visible "Showing X of Y notes" count while browsing
- open the linked document, symptom, or procedure from the note details panel

### Settings

The Settings page is implemented.

What it can do:

- edit the single stored vehicle profile
- save reusable document defaults for common system names and document types
- show the local database path
- show the local uploads folder
- show the upload size limit
- show the frontend and backend ports

The runtime path values are read-only in the browser. They come from local config and optional `.env` values.
Backup/export is still not wired up yet, so Settings shows that honestly instead of exposing a fake folder field.

## Tech stack

- `client`: React + Vite + Tailwind CSS
- `server`: Node.js + Express
- `database`: SQLite
- `file storage`: local `server/uploads` folder

## Project structure

```text
corolla-fix-helper/
  client/   Frontend app
  server/   API, database setup, and file storage
```

## First-time setup

Open a terminal in the project folder:

```powershell
cd C:\Users\daleb\source\corolla-fix-helper
npm run install:all
```

What this does:

- installs the root package used to run the client and server together
- installs server packages
- installs client packages

## Run the app

```powershell
cd C:\Users\daleb\source\corolla-fix-helper
npm run dev
```

After that:

- frontend: `http://localhost:5173`
- backend: `http://localhost:4000`
- health check: `http://localhost:4000/api/health`

## Useful commands

Run only the server:

```powershell
npm run dev:server
```

Run only the client:

```powershell
npm run dev:client
```

Build the client:

```powershell
npm run build
```

Run both test suites:

```powershell
npm run test
```

Run only the backend tests:

```powershell
npm run test:server
```

Run only the frontend tests:

```powershell
npm run test:client
```

Start the app with the built client:

```powershell
npm start
```

Manual QA checklist:

- `QA_CHECKLIST.md`

## Environment values

Copy `.env.example` to `.env` if you want your own local settings.

Important values:

- `PORT=4000` sets the Express server port
- `CLIENT_PORT=5173` sets the Vite dev server port
- `DATABASE_FILE=./server/data/corolla-fix-helper.db` sets the SQLite database file path
- `UPLOADS_DIR=./server/uploads` sets where uploaded PDFs are stored
- `MAX_UPLOAD_SIZE_MB=20` sets the PDF upload size limit
