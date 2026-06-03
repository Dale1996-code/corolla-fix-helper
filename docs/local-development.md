# Local Development

Use this guide to run Corolla Fix Helper on your computer.

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

## 4. Optional Local Settings

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

## 5. Start The App

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

## 6. Build And Test

```powershell
npm run build
npm run test
```

`npm run build` checks that the app can produce a production frontend build.

`npm run test` runs backend and frontend automated tests.

## 7. Run The Built App Locally

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
