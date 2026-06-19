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

Storage remains local-first, but document Q&A is not fully offline when `OPENAI_API_KEY` is configured. In that mode, `/api/ask` depends on OpenAI uptime and network latency for query embeddings and answer generation.

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
- `/api/ask` answers uploaded-document questions using retrieved document chunks and OpenAI when configured. It optionally accepts one saved image attachment by `attachmentId` so the model can see a photo, while repair specs, procedures, and steps still come only from PDF chunks (Vision Ask).
- `/api/search` and `/api/search/documents` search documents.
- `/api/search/symptoms` searches symptoms.
- `/api/search/procedures` searches procedures.
- `/api/search/notes` searches notes.
- `/api/symptoms` handles symptom records and document links.
- `/api/procedures` handles procedure records and document links.
- `/api/notes` handles notes and links to documents, symptoms, or procedures.
- `/api/attachments` handles image attachments (upload, list, file open, delete) for symptoms, procedures, and notes.
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
- image attachments for symptoms, procedures, and notes under `UPLOADS_DIR/attachments/images/` (documents stay PDF-only)
- `document_chunks` rows for page-aware text chunks and Float32 embedding BLOBs used by document Q&A
- `documents.file_md5` for resumable bulk-import duplicate detection
- optional backup export as a `.tar.gz` archive (covers the whole uploads tree, including attachment images)

See `DATA_MODEL.md` for table details.

## Document Q&A Path

The app has a current RAG-style document Q&A flow. RAG means retrieval-augmented generation: the server retrieves relevant document text first, then asks an AI model to answer using that text.

Current flow:

1. Uploading a PDF or re-running extraction stores extracted page text. Pages with very little PDF text are OCR-read when local Tesseract and Poppler commands are available.
2. `server/src/services/documentChunkService.js` saves smaller text chunks in the `document_chunks` table. OCR text uses the same page-aware chunk flow as normal PDF text.
3. `npm run embed:backfill` stores current OpenAI embeddings on chunks that do not already have the active embedding version.
4. `server/src/services/chunkRetrievalService.js` embeds the question once, cosine-scans an in-memory chunk embedding cache, and fuses that ranking with keyword ranking.
5. `server/src/services/aiAnswerService.js` builds citations and, when `OPENAI_API_KEY` is set, calls the OpenAI Responses API.
6. `server/src/routes/ask.js` exposes this as `POST /api/ask`.

If no useful chunks are found, the app returns `not in documents`. If useful chunks are found but no OpenAI key is configured, it returns an "AI is not configured" state.

The current app uses SQLite-stored embedding BLOBs and an in-memory cosine scan. It does not use a vector database or SQLite vector extension.

### Optional image in Ask (Vision Ask)

`POST /api/ask` accepts an optional `attachmentId` that points at one already-saved image attachment (the Phase 1 symptom/procedure/note photos). The Search page Ask panel lets the user pick from existing saved attachments; it never uploads a new file and never sends raw or base64 image data from the client. The backend loads that attachment record and its stored file from attachment storage (`server/src/routes/ask.js` `loadAttachmentImageFromStorage`, injectable for tests) and turns it into a `data:` URI.

When an image is present, `aiAnswerService.js` switches only that OpenAI request to the Responses API structured input (`input_text` + `input_image`) and uses `OPENAI_VISION_MODEL` (which defaults to `OPENAI_ANSWER_MODEL`). Everything else is unchanged: retrieval still runs on the text question only, images never enter `document_chunks`, documents stay PDF-only, and the same not-found gate applies. The model may describe what is visible in the photo, but every repair spec, torque value, capacity, tool, step, and warning must still come from the retrieved PDF chunks and stays cited. Without `OPENAI_API_KEY`, Ask degrades to the same "AI not configured" state whether or not an image is attached.

## Bulk PDF Import Path

`server/src/scripts/importFolder.js` imports a folder of PDFs from the command line:

```powershell
npm run import -- "C:\path\to\pdfs"
```

It uses the same storage model as document upload: copied PDF files live in the uploads folder, document metadata is saved in `documents`, and chunks are rebuilt through `rebuildDocumentChunksFromPages`.

The importer is resumable. It skips duplicates by MD5 file hash first and original filename second, keeps going after bad files, and reports how many PDFs are image-only. If OCR tools are installed, low-text pages can still become searchable chunks; if they are missing, the extraction status starts with `ocr_unavailable:`.

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
- vector database
- direct symptom-to-procedure links
- automatic restore from backup export
