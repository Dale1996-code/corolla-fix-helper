# Corolla Fix Helper

Corolla Fix Helper is a local-first repair helper for one vehicle:

- 2009 Toyota Corolla LE 1.8L

It runs on your computer, stores data in a local SQLite database, and keeps uploaded PDF files in a local folder. The goal is to help you keep repair information, symptoms, procedures, and notes in one place while working on the car.

## Current v1 scope

Version 1 currently includes these main areas:

- Dashboard
- Documents
- Document Search
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

For a V1 demo deployment, the recommended target is a Google Cloud Compute Engine VM. That keeps the app close to how it works locally: one Node server, one local SQLite database file, and one local uploads folder.

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

Document fields currently used in the app include:

- title
- system
- subsystem
- document type
- source
- notes

### Document Search

The Document Search page is implemented.

It lets you search through imported documents and filter results by things like:

- keyword
- system
- document type
- favorites

It does not search symptoms, procedures, or notes yet.

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
- store steps, tools, parts, safety notes, and confidence
- link procedures to documents

### Notes

The Notes feature is implemented.

What it can do:

- create notes
- edit notes
- delete notes
- organize notes by note type
- link notes to one document, symptom, or procedure in the current UI

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
- `runtime`: Node.js 24
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

Use Node.js 24 for this app. That matters because the backend uses `node:sqlite`, which is Node's built-in SQLite feature.

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

Build the app:

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
npm run build
npm start
```

After `npm start`, the built app should load from the backend at `http://localhost:4000`.

Manual QA checklist:

- `QA_CHECKLIST.md`

## Recommended V1 demo deployment

For a public V1 demo, use a Google Cloud Compute Engine VM with Node.js 24.

Plain-English storage notes:

- SQLite is a local database file. In this app, that file stores the app records.
- Uploaded PDFs are local files. They are saved in the uploads folder.
- Persistent storage means the database file and PDFs survive app restarts.
- A public demo should use sample or fake PDFs because the app does not have user accounts yet.

Use a durable VM folder or a persistent disk folder for app data. Example environment values:

```bash
DATABASE_FILE=/opt/corolla-fix-helper-data/corolla-fix-helper.db
UPLOADS_DIR=/opt/corolla-fix-helper-data/uploads
MAX_UPLOAD_SIZE_MB=20
PORT=4000
```

Typical manual VM setup:

```bash
npm run install:all
npm run build
npm start
```

Production demo details:

- build command: `npm run build`
- start command: `npm start`
- health check path: `/api/health`
- internal Node port: `4000`, or another value set with `PORT`
- optional web proxy: Nginx can forward public web traffic to `http://localhost:4000`

Cloud Run is not the preferred V1 demo target for this app because the current design uses a local SQLite file and local uploaded PDF files. Cloud Run can be considered later only if storage is redesigned, for example with Cloud SQL for the database and object storage for PDFs.

## Environment values

Copy `.env.example` to `.env` if you want your own local settings.

Important values:

- `PORT=4000` sets the Express server port
- `CLIENT_PORT=5173` sets the Vite dev server port
- `DATABASE_FILE=./server/data/corolla-fix-helper.db` sets the SQLite database file path
- `UPLOADS_DIR=./server/uploads` sets where uploaded PDFs are stored
- `MAX_UPLOAD_SIZE_MB=20` sets the PDF upload size limit
