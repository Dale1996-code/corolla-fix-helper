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

If you want scanned or image-only wiring diagrams to become searchable, install the local OCR tools before importing PDFs:

```powershell
winget install --id UB-Mannheim.TesseractOCR -e
winget install --id oschwartz10612.Poppler -e
```

Close and reopen PowerShell, then check:

```powershell
tesseract --version
pdftoppm -v
```

OCR means optical character recognition. In this app, Poppler renders a low-text PDF page into an image, and Tesseract reads text from that image.

## PDF Folder

When the script asks for a PDF folder, paste the full folder path, for example:

```text
C:\Users\daleb\Documents\Corolla repair PDFs
```

The importer scans that folder and subfolders for PDF files. It skips duplicate PDFs. Image-only wiring diagrams can import as `IMAGE-ONLY`; when OCR tools are installed, low-text pages are OCR-read and saved into the same searchable chunks as normal PDF text.

## After The Script Starts The App

Open:

```text
http://localhost:4000
```

Leave the PowerShell window open while using the app. Closing it stops the local server.

## Using The Ask Chatbot

Open `http://localhost:4000`, click **Search**, and use the **Ask** panel at the top.

Good first questions to try:

- `What is the oil drain plug torque spec?`
- `How do I replace the water pump?` then a follow-up: `What about the torque?`
- `What is the spark plug gap and torque?`
- A deliberate miss, such as `What is the torque on the flux capacitor?` It should answer
  `not in documents` instead of guessing.

Each answer shows the exact text snippet it used and a citation link to the source PDF page.

## Trust The Citations, Not Just The Answer

For the first several answers, open the cited PDF page and confirm the number matches. This
takes seconds because the snippet is shown right under the answer.

For anything safety-critical (brakes, suspension, airbags), treat the chatbot as a fast
lookup, then confirm the torque spec against the cited manual page before turning a wrench.
The app is grounded in your documents and cites its sources, but it is an assistant, not a
replacement for the manual.

## Running It Again

Run the same command again:

```powershell
cd C:\Users\daleb\source\corolla-fix-helper
powershell -ExecutionPolicy Bypass -File .\start-corolla-helper.ps1
```

If your key is already in `server\.env`, the script will not ask for it again. `npm run embed:backfill` is resumable and skips chunks already embedded with the current embedding model.
