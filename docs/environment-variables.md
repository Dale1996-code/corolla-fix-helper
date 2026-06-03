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
OPENAI_MODEL=gpt-4.1-mini
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
- `OPENAI_MODEL` is the OpenAI model name used for generated answers.

Because this file is normally copied to `server/.env`, the relative paths above are relative to the `server/` folder.

`server/src/config.js` reads `OPENAI_API_KEY` and `OPENAI_MODEL`. `server/src/services/aiAnswerService.js` uses them when it calls the OpenAI Responses API.

Keep `OPENAI_API_KEY` blank in committed examples. Put the real key only in your local `server/.env` file or in the VM/container environment.

If `OPENAI_API_KEY` is not set, the Ask feature still checks uploaded document chunks. When matching chunks exist, `/api/ask` returns `status: "ai_not_configured"` and the UI explains that AI is not configured. When the documents do not contain enough matching information, the app returns a "not enough information" answer instead.

## Google Compute Engine Values

For the intended Docker-on-VM deployment, pass env values to Docker instead of storing secrets in the repo:

```bash
-e NODE_ENV=production
-e PORT=4000
-e DATABASE_FILE=/data/corolla-fix-helper.db
-e UPLOADS_DIR=/data/uploads
-e MAX_UPLOAD_SIZE_MB=20
-e OPENAI_API_KEY=placeholder-openai-key
-e OPENAI_MODEL=gpt-4.1-mini
```

The `/data` path should be mounted to a persistent folder on the VM.

Do not paste a real key into documentation, commits, screenshots, or pull request text.
