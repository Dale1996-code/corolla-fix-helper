# Documentation Audit

Audit branch: `docs/rewrite-current-repo-docs`

This audit reviewed every markdown or documentation-style file found in the repo before the rewrite. The goal was to keep useful current docs, rewrite stale main docs, and archive old plans instead of deleting them.

## Classification Summary

| File | Classification | Reason | Final action |
| --- | --- | --- | --- |
| `AGENTS.md` | KEEP / REWRITE | Useful AI-agent workflow notes, mostly accurate but needed links to the new docs structure. | Rewritten in place. |
| `README.md` | REWRITE | Main entry point was useful but mixed current state, validation claims, and old deployment links. | Rewritten in place. |
| `ROADMAP.md` | REWRITE / MERGE | Existing file described one finished phase instead of a current roadmap. | Rewritten and updated with current RAG status plus next-step planning. |
| `QA_CHECKLIST.md` | KEEP / REWRITE | Useful manual checks, but needed clearer current flow and updated deployment separation. | Rewritten in place. |
| `DATA_MODEL.md` | KEEP / REWRITE | Data model mostly matched current schema but missed `app_settings`, the current `document_chunks` table, and needed current wording. | Rewritten in place. |
| `playwright-documents-snapshot.md` | ARCHIVE | Generated/historical UI snapshot with old wording. | Moved to `docs/archive/playwright-documents-snapshot.md`. |
| `ignore.old.ROADMAP.md` | ARCHIVE | Obsolete duplicate roadmap. | Moved to `docs/archive/ignore.old.ROADMAP.md`. |
| `docs/AI_RAG_PLAN.md` | MERGE / ARCHIVE | Useful AI/RAG plan. It has since been partially implemented: `document_chunks`, keyword chunk retrieval, `POST /api/ask`, OpenAI answer generation, citations, and the Search page Ask UI are now current code. Embeddings and vector search remain future work. | Current status and useful future scope merged into `ROADMAP.md`; original moved to archive. |
| `docs/GCE_DEMO_DEPLOYMENT.md` | ARCHIVE | Claimed a specific old deployment and public URL that this branch did not verify. | Moved to `docs/archive/GCE_DEMO_DEPLOYMENT.md`. |
| `docs/GCE_DEPLOYMENT_RUNBOOK.md` | MERGE / ARCHIVE | Useful GCE direction but too long and overlapped with old demo notes. | Simplified into `docs/gcp-deployment.md`; original moved to archive. |
| `docs/project-state-2026-05-01.md` | ARCHIVE | Stale status artifact. It contradicted current code about backup export, extraction re-run, and whole-app search. | Moved to `docs/archive/project-state-2026-05-01.md`. |
| `docs/superpowers/plans/2026-04-20-whole-app-search.md` | ARCHIVE | Historical implementation plan for work now represented in the current code. | Moved to `docs/archive/superpowers/plans/2026-04-20-whole-app-search.md`. |
| `docs/superpowers/specs/2026-04-20-whole-app-search-design.md` | ARCHIVE | Historical design spec for work now represented in the current code. | Moved to `docs/archive/superpowers/specs/2026-04-20-whole-app-search-design.md`. |
| `# Corolla Fix Helper - Project Brief.txt` | ARCHIVE | Historical project brief with duplicate content, old source-of-truth links, and references to missing `PRD.md`. | Moved to `docs/archive/project-brief-current-state-checklist.txt`. |
| `CHANGELOG.md` | ABSENT | Mentioned in the request but not present on this branch. | No file created; release history would need a separate Git-history pass. |

## Clean Current Structure

Current docs are:

- `README.md`
- `AGENTS.md`
- `ROADMAP.md`
- `QA_CHECKLIST.md`
- `DATA_MODEL.md`
- `docs/local-development.md`
- `docs/environment-variables.md`
- `docs/architecture.md`
- `docs/gcp-deployment.md`
- `docs/cost-control.md`
- `docs/troubleshooting.md`
- `docs/documentation-audit.md`
- `docs/archive/`

## Deployment Claims

The active docs now describe the intended Google Compute Engine path. They do not claim that this branch performed or verified a deployment.

## Supporting Non-Markdown Update

`.env.example` was updated to keep placeholder paths aligned with the documented local `server/.env` workflow. No secrets were added.
