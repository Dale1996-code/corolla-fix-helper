# Archived Documentation

This folder keeps old docs, generated snapshots, and superseded plans for reference.

**Nothing in this folder is current.** Several files here are old roadmaps and planning
documents. If you are looking for the plan, it is [`docs/roadmap.md`](../roadmap.md) — and
only that file. The rule: a roadmap filename with a date in it is history; the undated
`docs/roadmap.md` is the plan.

For the current state of the project, start with:

- [`README.md`](../../README.md)
- [`docs/roadmap.md`](../roadmap.md) — the current roadmap
- [`docs/architecture.md`](../architecture.md)
- [`docs/local-development.md`](../local-development.md)
- [`docs/environment-variables.md`](../environment-variables.md)
- [`docs/gcp-deployment.md`](../gcp-deployment.md) (an intended path, not a live deployment)
- [`QA_CHECKLIST.md`](../../QA_CHECKLIST.md)
- [`DATA_MODEL.md`](../../DATA_MODEL.md)

## Archived Files

### Superseded roadmaps and planning documents

- `roadmap.md` **does not live here** — it is at [`docs/roadmap.md`](../roadmap.md) and is the current plan. The three files below are its history.
- `strategy-review-2026-08.pdf`: the August 2026 12-month strategy and architecture review. This is the document the current roadmap was derived from; its strategic direction was kept and its factual and scope errors were corrected. Section 3 of the current roadmap records exactly what changed and why. Originally committed as `docs/roadmap-2026-2027.md.pdf`.
- `roadmap-v1.md`: the V1 baseline-and-next-work document, maintained from the first commit until August 2026. Its feature inventory was accurate when archived; its "Best Next Work" list is superseded. Originally at the repository root as `ROADMAP.md`, then `docs/roadmap-v1.md`.
- `project-health-report-2026-06-20.docx`: a 20 June 2026 read-only audit of the repository with a prioritized P0–P3 fix list. **It is an audit, not a roadmap**, despite its original filename `corolla-roadmap-2026-06-20.docx`. Its findings were implemented in PRs #60 and #61; the two that were not fully closed (client-heavy list loading, oversized page components) are carried into the current roadmap.

### Other archived documents

- `AI_RAG_PLAN.md`: future AI/RAG plan with stale current-checkout claims; its useful ideas were merged into the V1 roadmap and have since been implemented.
- `GCE_DEMO_DEPLOYMENT.md`: old deployment record that claimed a specific VM and public URL; not treated as current proof.
- `GCE_DEPLOYMENT_RUNBOOK.md`: long older GCE runbook; useful VM/Docker direction was simplified into `docs/gcp-deployment.md`.
- `documentation-audit.md`: completed documentation-rewrite audit; its classifications describe the repo at that time, not the current file set.
- `project-state-2026-05-01.md`: older status artifact with claims that no longer match the current codebase.
- `superpowers/`: historical design specification for whole-app search.
