# AGENTS.md — Corolla Fix Helper (root)

This file is the entry point for any coding agent working in this repo.
Nested `AGENTS.md` files in `server/`, `client/`, and `docs/` add detail for
their own subtree and inherit everything here.

> Convention: the **closest** `AGENTS.md` to the file being edited wins.
> Treat parent files as defaults, nested files as overrides.

---

## 1. Project overview

Corolla Fix Helper is a local-first repair helper for a single vehicle
(2009 Toyota Corolla LE 1.8L). It stores app records in a local SQLite
database (via Node's built-in `node:sqlite` `DatabaseSync`) and keeps
uploaded PDFs on the local filesystem.

V1 scope: Dashboard, Documents, Search, Symptoms, Procedures, Notes,
Settings. No cloud sync, no auth, single vehicle only.

Authoritative product docs: `PRD.md`, `ROADMAP.md`, `DATA_MODEL.md`,
`QA_CHECKLIST.md`.

## 2. Repo layout

```
.
├── server/        Express 5 API + SQLite (see server/AGENTS.md)
├── client/        React 19 + Vite + Tailwind (see client/AGENTS.md)
├── docs/          Runbooks and dated state snapshots (see docs/AGENTS.md)
├── PRD.md         Product requirements
├── ROADMAP.md     Current milestones
├── DATA_MODEL.md  SQLite schema reference
├── QA_CHECKLIST.md  Manual QA pass list
└── AGENTS.md      ← you are here
```

## 3. Environment

- Node **>=24 <25** (backend uses `node:sqlite`, which needs Node 22.5+).
- Last validated combo: Node `v24.15.0`, npm `11.4.2`.
- Copy `.env.example` to `.env` before first run if you need non-default config.

## 4. Working commands (run from repo root)

| Command | What it does |
| --- | --- |
| `npm run install:all` | Install root, server, and client deps. |
| `npm run dev` | Run server + client together (concurrently). |
| `npm run dev:server` | Express only, on `http://localhost:4000`. |
| `npm run dev:client` | Vite only, on `http://localhost:5173`. |
| `npm run build` | Full build. Server step is a no-op today. |
| `npm run test` | **Primary verification gate.** Runs server + client suites. |
| `npm run test:server` | Backend `node --test` suite. |
| `npm run test:client` | Frontend Vitest suite. |
| `npm start` | Start server from built/source state. |

Health check: `GET http://localhost:4000/api/health`.

## 5. Definition of done

Before declaring a change complete:

1. `npm run test` passes locally.
2. Manual QA from `QA_CHECKLIST.md` covers the affected area
   (Settings, Documents, Search, Symptoms, Procedures, Notes).
3. No new files outside the documented layout above without a reason.
4. Docs in `docs/`, `PRD.md`, `ROADMAP.md`, or `DATA_MODEL.md` updated
   if behavior or schema changed.

## 6. Conventions that apply everywhere

- **ESM only.** Both packages set `"type": "module"`.
- **No new top-level dependencies** without updating this file and the
  relevant nested `AGENTS.md`.
- **Local-first.** Don't introduce cloud services, telemetry, or auth.
- **Single vehicle.** Don't generalize the data model to multi-vehicle
  unless the roadmap explicitly calls for it.
- Prefer editing existing files over creating new ones.
- Don't commit `server/uploads/`, `.env`, or anything under `*.old.*`.

## 7. Things to avoid

- Switching the DB layer away from `node:sqlite`.
- Pinning Node to a major version other than 24 in `engines`.
- Adding a build step to the server without coordinating with deployment
  notes in `docs/GCE_DEPLOYMENT_RUNBOOK.md`.

## 8. When in doubt

Read the matching nested `AGENTS.md` first, then the linked top-level
doc (PRD, ROADMAP, DATA_MODEL, QA_CHECKLIST).
