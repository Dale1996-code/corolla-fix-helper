# Environment Variables

Environment variables are settings the app reads when it starts. They let you change paths and ports without editing code.

Use placeholder values in examples. Do not commit real secrets.

## Local Env File

For the current npm scripts, the backend runs from the `server/` folder. That means a local backend env file should be:

```text
server/.env
```

Check before creating it:

```powershell
Test-Path server\.env
```

If it does not exist, copy the placeholder example:

```powershell
Copy-Item .env.example server\.env
```

Do not overwrite an existing `server\.env` unless you have checked what is inside it.

## Current Variables

```env
NODE_ENV=development
PORT=4000
CLIENT_PORT=5173
CORS_ORIGIN=http://localhost:5173
DATABASE_FILE=./data/corolla-fix-helper.db
UPLOADS_DIR=./uploads
MAX_UPLOAD_SIZE_MB=20
OPENAI_API_KEY=
OPENAI_ANSWER_MODEL=gpt-4.1
RERANK_ENABLED=false
RERANK_CANDIDATE_LIMIT=20
OPENAI_RERANK_MODEL=
OPENAI_EMBEDDING_MODEL=text-embedding-3-small
OPENAI_EMBEDDING_DIMENSIONS=512
OPENAI_EMBEDDING_BATCH_SIZE=64
OCR_ENABLED=true
OCR_MIN_TEXT_CHARACTERS=20
OCR_DPI=300
OCR_LANGUAGE=eng
OCR_TESSERACT_COMMAND=tesseract
OCR_PDFTOPPM_COMMAND=pdftoppm
```

What each one means:

- `NODE_ENV` tells code whether it is running for development or production.
- `PORT` is the backend port.
- `CLIENT_PORT` is the frontend dev server port.
- `CORS_ORIGIN` is the browser origin allowed to call the backend during local dev.
- `DATABASE_FILE` is the SQLite database file path.
- `UPLOADS_DIR` is where uploaded PDFs are stored.
- `MAX_UPLOAD_SIZE_MB` is the largest PDF upload size in megabytes.
- `OPENAI_API_KEY` is the OpenAI API key used by the "Ask your documents" feature.
- `OPENAI_ANSWER_MODEL` is the OpenAI model name used for generated answers. The default is `gpt-4.1`.
- `RERANK_ENABLED` turns the optional Ask reranker on or off. The default is `false`. When `true`, Ask retrieval over-fetches a wider candidate pool and asks the model to reorder it before the final result slice. It needs an API key; with no key, a malformed reply, or any error it silently falls back to the existing hybrid order.
- `RERANK_CANDIDATE_LIMIT` is how many fused candidates the reranker is allowed to reorder. The default is `20`.
- `OPENAI_RERANK_MODEL` is the OpenAI model name used by the reranker. Leave blank to reuse `OPENAI_ANSWER_MODEL`.
- `OPENAI_EMBEDDING_MODEL` is the OpenAI model name used to embed document chunks and questions.
- `OPENAI_EMBEDDING_DIMENSIONS` is the embedding size stored in SQLite. The current value is `512`.
- `OPENAI_EMBEDDING_BATCH_SIZE` is how many chunks `npm run embed:backfill` sends per embedding request.
- `OCR_ENABLED` turns scanned-PDF OCR on or off. The default is `true`.
- `OCR_MIN_TEXT_CHARACTERS` is the page text threshold below which OCR is attempted.
- `OCR_DPI` is the image-rendering resolution used before OCR.
- `OCR_LANGUAGE` is the Tesseract language code. The default `eng` means English.
- `OCR_TESSERACT_COMMAND` is the Tesseract command name or full `.exe` path.
- `OCR_PDFTOPPM_COMMAND` is the Poppler `pdftoppm` command name or full `.exe` path.

Because this file is normally copied to `server/.env`, the relative paths above are relative to the `server/` folder.

`server/src/config.js` reads `OPENAI_API_KEY`, `OPENAI_ANSWER_MODEL`, `OPENAI_EMBEDDING_MODEL`, `OPENAI_EMBEDDING_DIMENSIONS`, and `OPENAI_EMBEDDING_BATCH_SIZE`. It still accepts the older `OPENAI_MODEL` name as a fallback for existing local env files. `server/src/services/aiAnswerService.js` uses the answer model when it calls the OpenAI Responses API. `server/src/services/chunkEmbeddingService.js` uses the embedding model and dimensions when it calls the OpenAI Embeddings API.

Keep `OPENAI_API_KEY` blank in committed examples. Put the real key only in your local `server/.env` file or in the VM/container environment.

If `OPENAI_API_KEY` is not set, the Ask feature still checks uploaded document chunks with keyword retrieval. When matching chunks exist, `/api/ask` returns `status: "ai_not_configured"` and the UI explains that AI is not configured. When the documents do not contain enough matching information, the app returns `not in documents` instead.

After importing or re-extracting PDFs with an OpenAI key configured, run:

```powershell
npm run embed:backfill
```

This embeds chunks that are missing the active `OPENAI_EMBEDDING_MODEL` and `OPENAI_EMBEDDING_DIMENSIONS` pair, and skips chunks already stored at the current embedding version.

OCR is local. It does not use OpenAI. When a PDF page has very little normal text, the backend uses Poppler `pdftoppm` to render that page to an image, then uses Tesseract to read text from the image. If either tool is missing, text PDFs still import normally, and scanned PDFs get an extraction status starting with `ocr_unavailable:`.

## Google Compute Engine Values

For the intended Docker-on-VM deployment, pass env values to Docker instead of storing secrets in the repo:

```bash
-e NODE_ENV=production
-e PORT=4000
-e DATABASE_FILE=/data/corolla-fix-helper.db
-e UPLOADS_DIR=/data/uploads
-e MAX_UPLOAD_SIZE_MB=20
-e OPENAI_API_KEY=placeholder-openai-key
-e OPENAI_ANSWER_MODEL=gpt-4.1
-e OPENAI_EMBEDDING_MODEL=text-embedding-3-small
-e OPENAI_EMBEDDING_DIMENSIONS=512
-e OPENAI_EMBEDDING_BATCH_SIZE=64
-e OCR_ENABLED=true
-e OCR_TESSERACT_COMMAND=tesseract
-e OCR_PDFTOPPM_COMMAND=pdftoppm
```

The `/data` path should be mounted to a persistent folder on the VM.

Do not paste a real key into documentation, commits, screenshots, or pull request text.
