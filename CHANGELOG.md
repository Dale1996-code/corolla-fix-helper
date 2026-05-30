# Changelog

## Week of 2026-05-25

### Highlights

- Added the backend "Ask your documents" RAG pipeline on the `ai-rag-backend-goal` branch. This includes `POST /api/ask`, `document_chunks`, page-aware PDF chunking, idempotent chunk backfill, keyword retrieval, isolated OpenAI answer generation, citation handling, and server tests for the Goal A cases. Evidence: commit `11bf787`.
- Added the AI RAG implementation plan in `docs/AI_RAG_PLAN.md`, including the scoped backend-first Goal A path and later frontend Goal B notes. See [PR #22](https://github.com/Dale1996-code/corolla-fix-helper/pull/22).
- Refreshed the project-state documentation and added GCE demo deployment guidance. See [PR #21](https://github.com/Dale1996-code/corolla-fix-helper/pull/21).
- Refreshed `docs/project-state-2026-05-01.md` with a truth pass against the current checkout. See [PR #20](https://github.com/Dale1996-code/corolla-fix-helper/pull/20).
- Cleaned up project docs by renaming the project brief file and removing the old `PRD.md` from `main`. Evidence: commits `366b5c0` and `c13c38c`.

### Key PR Links

- [PR #22: AI RAG plan](https://github.com/Dale1996-code/corolla-fix-helper/pull/22)
- [PR #21: Goal docs and deployment notes](https://github.com/Dale1996-code/corolla-fix-helper/pull/21)
- [PR #20: Project-state doc update](https://github.com/Dale1996-code/corolla-fix-helper/pull/20)
