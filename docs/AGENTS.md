# AGENTS.md — docs/

Long-form documentation, runbooks, and dated state snapshots. Inherits
the root `AGENTS.md`.

## What lives here

- **Runbooks** — operational, step-by-step procedures
  (e.g. `GCE_DEPLOYMENT_RUNBOOK.md`).
- **Dated state snapshots** — `project-state-YYYY-MM-DD.md` files that
  capture the repo's state at a point in time. Don't edit old snapshots;
  add a new one.
- **`superpowers/`** — experimental plans and specs that aren't yet
  promoted to top-level `PRD.md` / `ROADMAP.md`.

## What does NOT live here

- Current product requirements → `PRD.md` at repo root.
- Current milestones → `ROADMAP.md` at repo root.
- Schema reference → `DATA_MODEL.md` at repo root.
- Manual QA pass list → `QA_CHECKLIST.md` at repo root.

If a doc here becomes authoritative, promote it to the root and leave a
pointer behind.

## Conventions

- Filenames: `kebab-case.md` or `SCREAMING_SNAKE.md` for runbooks
  (matches existing style).
- Dated files use ISO `YYYY-MM-DD`.
- Link to source files with repo-relative paths
  (`../server/src/routes/documents.js`), not absolute paths.
- Don't paste secrets, tokens, or absolute user-home paths.

## When updating docs

- Behavior change in code → update `PRD.md` / `README.md` if user-visible.
- Schema change → update `DATA_MODEL.md`.
- New QA surface → add to `QA_CHECKLIST.md`.
- Deployment change → update `GCE_DEPLOYMENT_RUNBOOK.md` here.
