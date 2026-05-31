# Troubleshooting

Use this when local setup, tests, or a demo run fails.

## Node Version Is Wrong

Check:

```powershell
node -v
```

Expected: `v24.x`.

This app uses Node's built-in SQLite support. Node 20 is not the expected runtime for this repo.

## Packages Are Missing

Symptom examples:

- `vite is not recognized`
- `Cannot find package`
- `ERR_MODULE_NOT_FOUND`

Fix:

```powershell
cd C:\Users\daleb\source\corolla-fix-helper
npm run install:all
```

## Port Already In Use

Default ports:

- backend: `4000`
- frontend: `5173`

If a port is busy, stop the other process or change the port in `server\.env`.

## Backend Starts But Frontend Cannot Call API

Check `CORS_ORIGIN` in `server\.env`.

For normal local dev, use:

```env
CORS_ORIGIN=http://localhost:5173
```

Restart the backend after changing env values.

## Data Disappeared

Check which database and uploads folder the app is using:

1. Open Settings.
2. Look at runtime info.
3. Confirm `DATABASE_FILE` and `UPLOADS_DIR` point where you expect.

For a VM or Docker run, those paths should point to persistent storage.

## PDF Upload Or Extraction Fails

Check:

- the file is a PDF
- the file is below `MAX_UPLOAD_SIZE_MB`
- the uploads folder exists and is writable
- the PDF has extractable text

Some PDFs are scans or images. Those may not produce useful text without OCR, and OCR is not part of the current app.

## Backup Export Fails

Backup export uses the system `tar` command.

If export fails, check that `tar` is available in the environment running the backend.

## Docker Container Starts But Data Does Not Persist

Make sure Docker is run with a volume mount:

```bash
-v /opt/corolla-fix-helper-data:/data
```

And matching env values:

```bash
-e DATABASE_FILE=/data/corolla-fix-helper.db
-e UPLOADS_DIR=/data/uploads
```

Without the volume, data can disappear when the container is replaced.

## Ask Your Documents Says AI Is Not Configured

The Ask panel needs `OPENAI_API_KEY` in the server environment before it can generate OpenAI answers.

If you see an AI-not-configured message:

1. Stop the backend.
2. Add `OPENAI_API_KEY=placeholder-openai-key` to `server/.env`, replacing the placeholder with your real key only in that local file.
3. Keep `OPENAI_MODEL=gpt-4.1-mini` unless you intentionally want another model.
4. Start the backend again.

Do not commit a real OpenAI key. The app can still run without the key, but Ask cannot generate answers.
