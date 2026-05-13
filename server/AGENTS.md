# AGENTS.md — server/

Backend for Corolla Fix Helper. Inherits everything in the root
`AGENTS.md`; this file only adds backend-specific guidance.

## Stack

- Express 5 (`express`), CORS, Multer for uploads, `pdfjs-dist` for PDF text.
- Storage: `node:sqlite` `DatabaseSync` — synchronous, in-process, no driver.
- ESM (`"type": "module"`). Node **>=24 <25**.
- Tests: built-in `node --test`, with `supertest` for HTTP.

## Layout

```
server/
├── src/
│   ├── index.js          App entry / server bootstrap
│   ├── app.js            Express app wiring (mount this in tests)
│   ├── config.js         Env + path config
│   ├── database.js       SQLite connection (DatabaseSync)
│   ├── initDatabase.js   Schema bootstrap / migrations
│   ├── routes/           One file per resource (dashboard, documents, …)
│   ├── services/         Business logic (pdfService, searchService, …)
│   └── utils/            Pure helpers (sanitizeFilename, …)
├── test/
│   ├── app.test.js
│   └── fixtures/
└── uploads/              Local PDF storage — DO NOT COMMIT
```

## Commands (run from `server/` or via root scripts)

- `npm run dev` — `node --watch` on `src/`.
- `npm test` — runs `node --test` over `test/`.
- `npm run build` — currently a no-op; keep it that way unless coordinating
  with the deployment runbook.

## Conventions

- **Add a route**: create `src/routes/<resource>.js`, register it in
  `src/app.js`. Keep request/response shaping in the route; push DB and
  filesystem work into `src/services/`.
- **Add a table or column**: update `src/initDatabase.js` and document the
  change in `DATA_MODEL.md`. There is no migration tool yet — schema is
  re-created from `initDatabase.js`.
- **File uploads** go through `multer` into `server/uploads/`. Always run
  user-provided filenames through `utils/sanitizeFilename.js`.
- **Errors**: return JSON `{ error: string }` with an appropriate status;
  don't leak stack traces.

## Testing

- Import `app.js` (not `index.js`) and drive it with `supertest`.
- Put binary fixtures in `test/fixtures/`.
- Tests must be hermetic: use a temp DB path / temp uploads dir, don't
  touch the user's real `uploads/` folder.

## Don't

- Don't swap `node:sqlite` for `better-sqlite3` or `sql.js`.
- Don't add an ORM.
- Don't introduce async DB calls — `DatabaseSync` is intentional.
- Don't add auth/session middleware; the app is local-only.
