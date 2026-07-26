# Local Development

Use this guide to run Corolla Fix Helper on your computer.

For the simplest Windows setup with OpenAI key entry, folder import, embedding, build, and app start in one script, use [Getting Started On Windows](getting-started-windows.md).

## 1. Check Node.js

This repo expects Node.js `>=24 <25`.

```powershell
node -v
npm -v
```

If `node -v` starts with `v24.`, you are in the expected range.

## 2. Open The Repo

```powershell
cd C:\Users\daleb\source\corolla-fix-helper
```

This changes your terminal into the project folder.

## 3. Install Packages

```powershell
npm run install:all
```

This installs:

- root packages
- backend packages in `server/`
- frontend packages in `client/`

## 4. Optional OCR For Scanned PDFs

OCR means optical character recognition. It turns words inside a scanned page image into searchable text.

For scanned or image-only wiring diagrams on Windows, install Tesseract and Poppler:

```powershell
winget install --id UB-Mannheim.TesseractOCR -e
winget install --id oschwartz10612.Poppler -e
```

Then close and reopen PowerShell, and check both commands:

```powershell
tesseract --version
pdftoppm -v
```

If `winget` cannot find those packages, install Tesseract from the UB Mannheim Windows installer and Poppler from the Poppler Windows release zip. Make sure the folders containing `tesseract.exe` and `pdftoppm.exe` are on your Windows `PATH`.

If the commands are installed but not on `PATH`, put the full `.exe` paths in `server\.env`:

```env
OCR_TESSERACT_COMMAND=C:\Program Files\Tesseract-OCR\tesseract.exe
OCR_PDFTOPPM_COMMAND=C:\Tools\poppler\Library\bin\pdftoppm.exe
```

OCR is optional. Text-based PDFs still import without it. Scanned PDFs show an `ocr_unavailable:` extraction status if OCR tools are missing.

## 5. Optional Local Settings

The app has safe default settings. You only need a local env file if you want to change ports, database path, upload path, or upload size.

Before creating one, check whether a local file already exists:

```powershell
Test-Path server\.env
```

If this prints `False`, you can copy the placeholder example:

```powershell
Copy-Item .env.example server\.env
```

Do not paste real secrets into docs or committed files. `server\.env` is ignored by Git for local use.

## 6. Start The App

```powershell
npm run dev
```

This starts two things:

- the Express backend on `http://localhost:4000`
- the Vite frontend on `http://localhost:5173`

Open the app at:

```text
http://localhost:5173
```

Check the backend at:

```text
http://localhost:4000/api/health
```

## 7. Build And Test

```powershell
npm run lint
npm run typecheck
npm run build
npm run test
```

`npm run lint` runs ESLint over the whole `server/` tree and `client/src`.

`npm run typecheck` runs TypeScript `checkJs` over the whole `server/src` tree (plus a curated set of tests) via `tsconfig.json`, with several strict-family flags on. Full `strict` (`strictNullChecks`/`noImplicitAny`) is still off, so a clean run is broad coverage, not exhaustive null/any safety.

`npm run build` checks that the app can produce a production frontend build.

`npm run test` runs backend and frontend automated tests.

### Known dependency advisories

`npm run install:all` may print `5 high severity vulnerabilities` for the
frontend. As of this writing they all come from one source: `esbuild`, pulled
in through `vite` and `vitest`.

What this means in practice:

- These are **development-only** tools (the local dev server and the test
  runner). They are **not** part of the production app that gets built into
  `client/dist` and served to users, so the deployed app is not exposed.
- The advisories mainly matter if the Vite **dev server** is reachable by an
  attacker on your network. On a normal local machine using `localhost`, the
  practical risk is low.

Do **not** run `npm audit fix --force`. The only available fix upgrades Vite to
a new major version (a breaking change) that can break the build and tests. That
upgrade should be done deliberately and re-verified, not as an automatic fix.

You can review the current details any time with:

```powershell
npm --prefix client audit
```

## 8. Bulk Import PDFs

Run this from the repo root:

```powershell
npm run import -- "C:\path\to\pdfs"
```

Replace `C:\path\to\pdfs` with the folder that contains the PDFs.

The importer:

- scans the folder and subfolders for `.pdf` files
- copies readable PDFs into the configured uploads folder
- stores each document in SQLite
- runs OCR on low-text pages when OCR is enabled and the local tools are installed
- rebuilds `document_chunks` for document Q&A, including OCR text
- skips duplicates by MD5 file hash only (two byte-distinct files that share a basename both import; the stored filename is disambiguated)
- keeps going when one PDF is corrupt or unreadable
- prints imported, skipped, failed, and `IMAGE-ONLY` counts; `ocr_unavailable:` means the OCR tools were missing

Default imported metadata is:

- system: `Imported Documents`
- document type: `Repair Manual`
- source: `Bulk Folder Import`

You can edit document metadata later in the Documents page.

## 9. Embed Document Chunks

If you have `OPENAI_API_KEY` configured and you want Ask to use hybrid retrieval, run this after importing or re-extracting PDFs:

```powershell
npm run embed:backfill
```

This sends chunk text to OpenAI's embedding API, stores a Float32 embedding BLOB on each chunk, and skips chunks already stored at the current embedding version.

## 10. Run The Retrieval Eval

Run this from the repo root:

```powershell
npm run eval:retrieval
```

This uses a temporary synthetic repair corpus with 2,500 distractor documents and prints keyword-only vs hybrid top-page results.

## 11. Run The Built App Locally

```powershell
npm run build
npm start
```

After this, the backend serves the built frontend at:

```text
http://localhost:4000
```

## Useful Commands

Run only the backend:

```powershell
npm run dev:server
```

Run only the frontend:

```powershell
npm run dev:client
```

Run only backend tests:

```powershell
npm run test:server
```

Run only frontend tests:

```powershell
npm run test:client
```
