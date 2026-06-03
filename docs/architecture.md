# Architecture

This is the current high-level structure of Corolla Fix Helper.

## App Shape

The repo has two main parts:

```text
client/   React frontend
server/   Express backend, SQLite setup, API routes, and uploads
```

The app is local-first:

- App records are stored in SQLite.
- Uploaded PDFs are stored in a local folder.
- The browser talks to the backend through `/api/...` routes.

## Runtime

The backend uses Node.js `>=24 <25` because it uses Node's built-in `node:sqlite` support.

During local development:

- frontend: `http://localhost:5173`
- backend: `http://localhost:4000`

In a production-style local run:

- `npm run build` builds the frontend into `client/dist`
- `npm start` starts the backend
- Express serves the built frontend from `client/dist`

## Backend Routes

Current route groups:

- `/api` returns basic API info.
- `/api/health` returns health status.
- `/api/dashboard` returns dashboard counts and recent activity.
- `/api/documents` handles document list, upload, file open, metadata edit, extraction re-run, and delete cleanup.
- `/api/ask` answers uploaded-document questions using retrieved document chunks and OpenAI when configured.
- `/api/search` and `/api/search/documents` search documents.
- `/api/search/symptoms` searches symptoms.
- `/api/search/procedures` searches procedures.
- `/api/search/notes` searches notes.
- `/api/symptoms` handles symptom records and document links.
- `/api/procedures` handles procedure records and document links.
- `/api/notes` handles notes and links to documents, symptoms, or procedures.
- `/api/settings` handles vehicle profile, document defaults, runtime info, and backup export.

## Frontend Pages

Current pages:

- Dashboard
- Documents
- Search
- Symptoms
- Procedures
- Notes
- Settings

The Search page is one page with separate sections plus an "Ask your documents" panel. The Ask panel calls `/api/ask`.

## Storage Model

Current storage:

- SQLite database file for records and settings
- local uploads folder for PDF files
- `document_chunks` rows for page-aware text chunks used by document Q&A
- optional backup export as a `.tar.gz` archive

See `DATA_MODEL.md` for table details.

## Document Q&A Path

The app has a current RAG-style document Q&A flow. RAG means retrieval-augmented generation: the server retrieves relevant document text first, then asks an AI model to answer using that text.

Current flow:

1. Uploading a PDF or re-running extraction stores extracted page text.
2. `server/src/services/documentChunkService.js` saves smaller text chunks in the `document_chunks` table.
3. `server/src/services/chunkRetrievalService.js` does keyword-based retrieval over those chunks.
4. `server/src/services/aiAnswerService.js` builds citations and, when `OPENAI_API_KEY` is set, calls the OpenAI Responses API.
5. `server/src/routes/ask.js` exposes this as `POST /api/ask`.

If no useful chunks are found, the app returns a "not enough information" answer. If useful chunks are found but no OpenAI key is configured, it returns an "AI is not configured" state.

The current app does not use embeddings or a vector database.

## Deployment Shape

The intended Google Cloud path is:

1. Build the Docker image from this repo.
2. Push it to Google Artifact Registry.
3. Run it on one Google Compute Engine VM.
4. Mount a persistent VM folder into the container for the SQLite database and uploads.

This keeps deployment close to the app's local-first design.

Cloud Run is not the preferred current target because the app depends on local SQLite and local uploaded files. Cloud Run can be reconsidered later if storage is redesigned.

## Not In The Current App

The current app does not include:

- login or user accounts
- cloud sync
- multi-vehicle UI
- general AI chat outside uploaded documents
- embeddings or vector database
- direct symptom-to-procedure links
- automatic restore from backup export
