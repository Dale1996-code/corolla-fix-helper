# Getting Started On Windows

This is the beginner path for running Corolla Fix Helper with document Q&A.

## What This Script Does

Run one command from the repo folder:

```powershell
cd C:\Users\daleb\source\corolla-fix-helper
powershell -ExecutionPolicy Bypass -File .\start-corolla-helper.ps1
```

The script will:

- create `server\.env` if it does not exist
- ask for your OpenAI API key and save it in `server\.env`
- install packages
- ask for a folder of PDF repair documents
- import that folder with `npm run import`
- embed document chunks with `npm run embed:backfill`
- build the frontend
- start the app at `http://localhost:4000`

`server\.env` is ignored by Git. That means your key stays local and should not be committed.

## Before You Start

Check Node.js:

```powershell
node -v
```

The version should start with `v24.`.

## PDF Folder

When the script asks for a PDF folder, paste the full folder path, for example:

```text
C:\Users\daleb\Documents\Corolla repair PDFs
```

The importer scans that folder and subfolders for PDF files. It skips duplicate PDFs. Image-only wiring diagrams can still import as `IMAGE-ONLY`, but they are not useful for text Q&A until OCR is added.

## After The Script Starts The App

Open:

```text
http://localhost:4000
```

Leave the PowerShell window open while using the app. Closing it stops the local server.

## Running It Again

Run the same command again:

```powershell
cd C:\Users\daleb\source\corolla-fix-helper
powershell -ExecutionPolicy Bypass -File .\start-corolla-helper.ps1
```

If your key is already in `server\.env`, the script will not ask for it again. `npm run embed:backfill` is resumable and skips chunks already embedded with the current embedding model.
