# Corolla Fix Helper Agent Notes

Keep repo guidance tied to the commands and flows that are already in use here.

## Working commands

Run these from `C:\Users\daleb\source\corolla-fix-helper`:

- `npm run install:all` installs root, server, and client dependencies.
- `npm run dev` starts the full local app.
- `npm run dev:server` starts only the Express server.
- `npm run dev:client` starts only the Vite client.
- `npm run build` runs the current full build flow. The server build step is still a no-op and prints `No server build step needed yet.`
- `npm run test` is the main root verification command and runs both test suites.
- `npm run test:server` runs the backend Node test suite.
- `npm run test:client` runs the frontend Vitest suite.
- `npm start` starts the server app.

## Local workflow checks

- Main dev URLs: frontend `http://localhost:5173`, backend `http://localhost:4000`, health check `http://localhost:4000/api/health`.
- Use `QA_CHECKLIST.md` for manual verification after changes.
- Current manual QA covers Settings, Documents, Search, Symptoms, Procedures, Notes, build, and tests.
- Search is a whole-app page with separate sections for documents, symptoms, procedures, and notes.
- Notes acceptance should include the details panel showing the linked item correctly for document, symptom, or procedure links.
