# Changelog

## Week of 2026-06-15

### Highlights

- Hardened Repair Planner and OCR behavior by handling tool failures, awaiting asynchronous document retrieval, avoiding immediate request aborts, and skipping remaining OCR work when required local tools are missing. See [PR #46](https://github.com/Dale1996-code/corolla-fix-helper/pull/46) and [PR #48](https://github.com/Dale1996-code/corolla-fix-helper/pull/48).
- Reduced duplicated client and server helpers, expanded lint and typecheck coverage, centralized document cleanup, and isolated test databases that could lock each other in CI. See [PR #47](https://github.com/Dale1996-code/corolla-fix-helper/pull/47) and [PR #54](https://github.com/Dale1996-code/corolla-fix-helper/pull/54).
- Added backup restore support, a safe restore guide, and an end-to-end backup drill, then made backup exports select the correct native `tar` executable on Windows. See [PR #50](https://github.com/Dale1996-code/corolla-fix-helper/pull/50) and [PR #55](https://github.com/Dale1996-code/corolla-fix-helper/pull/55).
- Refreshed the app shell and Documents page with an editorial layout, updated navigation, responsive mobile behavior, and bundled fonts. Evidence: commits `7825d33` and `63d8673`.
- Added saved JPEG, PNG, and WebP attachments for symptoms, procedures, and notes, including attachment cleanup and backup coverage. See [PR #51](https://github.com/Dale1996-code/corolla-fix-helper/pull/51).
- Extended Ask so a question can optionally include one saved image attachment while document retrieval remains grounded in the text question and uploaded PDFs. See [PR #53](https://github.com/Dale1996-code/corolla-fix-helper/pull/53).

### Key PR Links

- [PR #55: Use the Windows-safe tar helper for backup exports](https://github.com/Dale1996-code/corolla-fix-helper/pull/55)
- [PR #54: Isolate the answer-quality test database](https://github.com/Dale1996-code/corolla-fix-helper/pull/54)
- [PR #53: Add optional saved-image Vision Q&A](https://github.com/Dale1996-code/corolla-fix-helper/pull/53)
- [PR #51: Add image attachments for symptoms, procedures, and notes](https://github.com/Dale1996-code/corolla-fix-helper/pull/51)
- [PR #50: Add backup restore support, guide, and drill](https://github.com/Dale1996-code/corolla-fix-helper/pull/50)
- [PR #48: Fix immediate Repair Planner request aborts](https://github.com/Dale1996-code/corolla-fix-helper/pull/48)
- [PR #47: Reduce duplication and expand check coverage](https://github.com/Dale1996-code/corolla-fix-helper/pull/47)
- [PR #46: Harden Repair Planner tools and OCR handling](https://github.com/Dale1996-code/corolla-fix-helper/pull/46)

## Week of 2026-06-08

### Highlights

- Added a resumable PDF folder importer with tests, local-development docs, data-model notes, and QA checklist coverage. See [PR #31](https://github.com/Dale1996-code/corolla-fix-helper/pull/31).
- Built the grounded Ask repair chatbot flow on top of uploaded PDF chunks, including embedding storage, hybrid keyword+embedding retrieval, answer generation, retrieval eval scripts, backfill support, updated Search page behavior, and expanded server/client tests. See [PR #32](https://github.com/Dale1996-code/corolla-fix-helper/pull/32).
- Added Ask chatbot usage and citation-trust guidance to the Windows getting-started guide. See [PR #33](https://github.com/Dale1996-code/corolla-fix-helper/pull/33).
- Tightened cleanup and safety behavior by removing dead UI code, guarding favorite double-clicks, rolling back orphaned upload rows, and broadening lint coverage. See [PR #34](https://github.com/Dale1996-code/corolla-fix-helper/pull/34).
- Added an answer-quality evaluation harness for the Ask chatbot, including eval cases, scoring code, a runner script, documentation, and tests. See [PR #35](https://github.com/Dale1996-code/corolla-fix-helper/pull/35).
- Hardened local environment handling by fixing single-line `.env` corruption, improving the term-match guard, adding `CLAUDE.md`, excluding nested `.env` files from Docker context, refreshing client audit fixes, upgrading `concurrently`, and declaring the client Node 24 engine requirement. See [PR #36](https://github.com/Dale1996-code/corolla-fix-helper/pull/36), [PR #37](https://github.com/Dale1996-code/corolla-fix-helper/pull/37), and [PR #38](https://github.com/Dale1996-code/corolla-fix-helper/pull/38).

### Key PR Links

- [PR #38: Dependency, Docker ignore, and Node engine cleanup](https://github.com/Dale1996-code/corolla-fix-helper/pull/38)
- [PR #37: Add CLAUDE.md repo guidance](https://github.com/Dale1996-code/corolla-fix-helper/pull/37)
- [PR #36: Harden `.env` handling and term matching](https://github.com/Dale1996-code/corolla-fix-helper/pull/36)
- [PR #35: Ask chatbot answer-quality eval harness](https://github.com/Dale1996-code/corolla-fix-helper/pull/35)
- [PR #34: Cleanup audit fixes](https://github.com/Dale1996-code/corolla-fix-helper/pull/34)
- [PR #33: Ask chatbot usage docs](https://github.com/Dale1996-code/corolla-fix-helper/pull/33)
- [PR #32: Grounded Ask repair chatbot](https://github.com/Dale1996-code/corolla-fix-helper/pull/32)
- [PR #31: Resumable PDF folder importer](https://github.com/Dale1996-code/corolla-fix-helper/pull/31)

## Week of 2026-06-01

### Highlights

- Added the "Repair Planner" streaming agent on the `claude/launch-desk-agent-MLUNe` branch. A `POST /api/repair-plan` Server-Sent-Events route runs a tool-calling loop (extract tasks, search uploaded PDFs, check readiness against a rubric, build an owner checklist, draft handoff copy) and streams tool progress and model text deltas to a new Repair Planner page. Built in the repo's existing raw-`fetch` Responses API + dependency-injection style, with server and client tests (including an end-to-end SSE test) and `docs/repair-planner.md`.

### Key PR Links

- [PR #30: Repair Planner streaming agent](https://github.com/Dale1996-code/corolla-fix-helper/pull/30)
- [PR #29: Repo docs verification and changelog/archive link fixes](https://github.com/Dale1996-code/corolla-fix-helper/pull/29)

## Week of 2026-05-25

### Highlights

- Added the backend "Ask your documents" RAG pipeline on the `ai-rag-backend-goal` branch. This includes `POST /api/ask`, `document_chunks`, page-aware PDF chunking, idempotent chunk backfill, keyword retrieval, isolated OpenAI answer generation, citation handling, and server tests for the Goal A cases. Evidence: commit `11bf787`.
- Added the AI RAG implementation plan (now archived at `docs/archive/AI_RAG_PLAN.md`), including the scoped backend-first Goal A path and later frontend Goal B notes. See [PR #22](https://github.com/Dale1996-code/corolla-fix-helper/pull/22).
- Refreshed the project-state documentation and added GCE demo deployment guidance. See [PR #21](https://github.com/Dale1996-code/corolla-fix-helper/pull/21).
- Refreshed the project-state doc (now archived at `docs/archive/project-state-2026-05-01.md`) with a truth pass against the current checkout. See [PR #20](https://github.com/Dale1996-code/corolla-fix-helper/pull/20).
- Cleaned up project docs by renaming the project brief file and removing the old `PRD.md` from `main`. Evidence: commits `366b5c0` and `c13c38c`.

### Key PR Links

- [PR #22: AI RAG plan](https://github.com/Dale1996-code/corolla-fix-helper/pull/22)
- [PR #21: Goal docs and deployment notes](https://github.com/Dale1996-code/corolla-fix-helper/pull/21)
- [PR #20: Project-state doc update](https://github.com/Dale1996-code/corolla-fix-helper/pull/20)
