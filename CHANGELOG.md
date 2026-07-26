# Changelog

## Week of 2026-07-20

### Highlights

- Made the app fully usable from an iPhone: an installable PWA (manifest, wrench icon, launch screens), a safe offline fallback page that never intercepts `/api` and caches nothing dynamic, and a phone-ready startup banner that prints LAN/Tailscale/HTTPS install URLs. See [docs/mobile-access.md](docs/mobile-access.md). See [PR #83](https://github.com/Dale1996-code/corolla-fix-helper/pull/83).
- Worked through `corolla-fix-helper-audit-MASTER.md` in stages: cache invalidation on document delete/edit plus dependency/security hardening (multer bump, upload field caps, baseline security headers, `PRAGMA busy_timeout`) in Stage 1 & 2 ([PR #84](https://github.com/Dale1996-code/corolla-fix-helper/pull/84)); loopback-by-default binding (`NETWORK_MODE` opt-in) and AI accidental-spend guards — the shared rate limiter, a daily call ceiling, output-token caps, and a stream idle timeout — in Stage 3 safety ([PR #85](https://github.com/Dale1996-code/corolla-fix-helper/pull/85)); an ~12.5x smaller `GET /api/documents`/search payload by dropping the unused `extractedText` field in Stage 3 perf ([PR #86](https://github.com/Dale1996-code/corolla-fix-helper/pull/86)); checklist UTC-timestamp/ordering fixes, a working search "Oldest" sort, and keyboard/screen-reader-accessible checklist rows in Stage 3 client ([PR #87](https://github.com/Dale1996-code/corolla-fix-helper/pull/87)); and a new index-only migration `003_link_and_sort_indexes` covering document/link/checklist sort queries in Stage 3 indexes ([PR #89](https://github.com/Dale1996-code/corolla-fix-helper/pull/89)).
- Committed a curated set of offline/PWA phone-access fixes (service worker `/api` bypass, startup-banner refinements, new tests) that had been left uncommitted by a paused scheduled task. See [PR #88](https://github.com/Dale1996-code/corolla-fix-helper/pull/88).
- Re-applied two `AGENTS.md` corrections — the AI rate limiter is one shared 20/min window, and the folder importer dedups by MD5 only — after PR #88's merge order had reverted them. See [PR #90](https://github.com/Dale1996-code/corolla-fix-helper/pull/90).
- Frontend accessibility and consistency pass: converted clickable `<div>` list rows to real `<button>`s for keyboard/screen-reader navigation, fixed low-contrast text and a hidden `<h1>`, added `role="alert"`/`role="status"` banners across 57 previously-silent messages, and de-duplicated shared form/section components. See [PR #91](https://github.com/Dale1996-code/corolla-fix-helper/pull/91).

### Key PR Links

- [PR #91: Fix frontend accessibility, contrast, and duplication issues](https://github.com/Dale1996-code/corolla-fix-helper/pull/91)
- [PR #90: docs(AGENTS): re-apply shared-limiter + MD5-only import corrections](https://github.com/Dale1996-code/corolla-fix-helper/pull/90)
- [PR #89: Stage 3 indexes: reverse-link + sort indexes, migration 003 (#18)](https://github.com/Dale1996-code/corolla-fix-helper/pull/89)
- [PR #88: Offline/PWA phone-access hardening (from paused Codex scheduled task)](https://github.com/Dale1996-code/corolla-fix-helper/pull/88)
- [PR #87: Stage 3 client: checklist UTC/ordering (#10), search Oldest+race (#11), checklist a11y (#12)](https://github.com/Dale1996-code/corolla-fix-helper/pull/87)
- [PR #86: Stage 3 perf: slim document list/search DTOs (#4)](https://github.com/Dale1996-code/corolla-fix-helper/pull/86)
- [PR #85: Stage 3 safety: loopback-default binding (#3) + AI accidental-spend guards (#5)](https://github.com/Dale1996-code/corolla-fix-helper/pull/85)
- [PR #84: Audit fixes: Stages 1 & 2 (findings #1, #2, #7, #8, #13–#17, #19–#22)](https://github.com/Dale1996-code/corolla-fix-helper/pull/84)
- [PR #83: iPhone access: installable PWA, phone-ready startup URLs, mobile polish](https://github.com/Dale1996-code/corolla-fix-helper/pull/83)

## Week of 2026-07-06

### Highlights

- Followed up Repair Checklists v1 with smoke-test coverage, API docs, and README pointers so the new local checklist flow is covered by the production smoke check. See [PR #73](https://github.com/Dale1996-code/corolla-fix-helper/pull/73).
- Consolidated server internals by adding shared vehicle, HTTP parsing, and row-mapper helpers, then thinning the symptoms, procedures, notes, and documents routes into service modules with focused service tests. See [PR #72](https://github.com/Dale1996-code/corolla-fix-helper/pull/72), [PR #75](https://github.com/Dale1996-code/corolla-fix-helper/pull/75), [PR #78](https://github.com/Dale1996-code/corolla-fix-helper/pull/78), [PR #79](https://github.com/Dale1996-code/corolla-fix-helper/pull/79), [PR #80](https://github.com/Dale1996-code/corolla-fix-helper/pull/80), and [PR #81](https://github.com/Dale1996-code/corolla-fix-helper/pull/81).
- Improved Ask answer quality and dev visibility by clarifying the beginner-safe AI prompt, adding env-gated `ASK_DEBUG_METRICS`, expanding answer-quality cases, and documenting the RAG iteration log. See [PR #76](https://github.com/Dale1996-code/corolla-fix-helper/pull/76).
- Fixed `sanitizeFilename` so filenames with uppercase extensions no longer get doubled extensions, with characterization and regression coverage. See [PR #74](https://github.com/Dale1996-code/corolla-fix-helper/pull/74).
- Refreshed `CLAUDE.md` with current image-attachment docs and expanded repo pointers. See [PR #71](https://github.com/Dale1996-code/corolla-fix-helper/pull/71).
- Synced documentation and agent guidance through PR #81, restored CHANGELOG entries that had gone missing for PRs #63 and #65–#68, and aligned the QA checklist's sidebar order with the live navigation. See [PR #82](https://github.com/Dale1996-code/corolla-fix-helper/pull/82).

### Key PR Links

- [PR #82: Sync documentation through PR 81](https://github.com/Dale1996-code/corolla-fix-helper/pull/82)
- [PR #81: Consolidate row mappers into shared cores](https://github.com/Dale1996-code/corolla-fix-helper/pull/81)
- [PR #80: Slim documents route into documentService](https://github.com/Dale1996-code/corolla-fix-helper/pull/80)
- [PR #79: Extract noteService from notes route](https://github.com/Dale1996-code/corolla-fix-helper/pull/79)
- [PR #78: Extract procedureService from procedures route](https://github.com/Dale1996-code/corolla-fix-helper/pull/78)
- [PR #76: Improve Ask answer quality and debug visibility](https://github.com/Dale1996-code/corolla-fix-helper/pull/76)
- [PR #75: Extract symptomService from symptoms route](https://github.com/Dale1996-code/corolla-fix-helper/pull/75)
- [PR #74: Fix uppercase filename extension sanitizing](https://github.com/Dale1996-code/corolla-fix-helper/pull/74)
- [PR #73: Add Repair Checklists smoke coverage and docs](https://github.com/Dale1996-code/corolla-fix-helper/pull/73)
- [PR #72: Consolidate server helpers and shared lookups](https://github.com/Dale1996-code/corolla-fix-helper/pull/72)
- [PR #71: Refresh CLAUDE.md repo guidance](https://github.com/Dale1996-code/corolla-fix-helper/pull/71)

## Week of 2026-06-29

### Highlights

- Added Repair Checklists v1 as an additive local checklist feature with checklist status, ordered check-off items, API routes, a React page, navigation updates, schema migration support, and server/client tests. See [PR #70](https://github.com/Dale1996-code/corolla-fix-helper/pull/70).
- Expanded attachment-route typecheck coverage after the image-attachments review pass. See [PR #69](https://github.com/Dale1996-code/corolla-fix-helper/pull/69).
- Hardened the production smoke test so it cleans up its temporary workspace and shuts down cleanly on failure. See [PR #68](https://github.com/Dale1996-code/corolla-fix-helper/pull/68).
- Refreshed the beginner-facing documentation for typecheck scope, Docker OCR, the Ask AI rename, and the smoke test. See [PR #67](https://github.com/Dale1996-code/corolla-fix-helper/pull/67).
- Added the production smoke test, expanded typecheck coverage to the whole `server/src` tree, and installed Poppler and Tesseract in the Docker runtime image. See [PR #66](https://github.com/Dale1996-code/corolla-fix-helper/pull/66).

### Key PR Links

- [PR #70: Add Repair Checklists v1](https://github.com/Dale1996-code/corolla-fix-helper/pull/70)
- [PR #69: Add attachments route test to typecheck coverage](https://github.com/Dale1996-code/corolla-fix-helper/pull/69)
- [PR #68: Harden smoke test cleanup and shutdown](https://github.com/Dale1996-code/corolla-fix-helper/pull/68)
- [PR #67: Beginner-friendly documentation refresh](https://github.com/Dale1996-code/corolla-fix-helper/pull/67)
- [PR #66: Production smoke test, broader typecheck, Docker OCR tools](https://github.com/Dale1996-code/corolla-fix-helper/pull/66)

## Week of 2026-06-22

### Highlights

- Implemented the roadmap P0/P1 fixes and P2 docs/pagination pass, including opt-in demo seeding, shared request limiting for AI routes, transactional guardrails, and refreshed docs/checklists. See [PR #60](https://github.com/Dale1996-code/corolla-fix-helper/pull/60).
- Completed the roadmap P2/P3 cleanup and optional Documents UX work by extracting shared list/result components, adding schema migration version tracking, streaming backup downloads, showing embedding-pending state, adding Documents pagination UI, and removing generated eval/benchmark artifacts from tracking. See [PR #61](https://github.com/Dale1996-code/corolla-fix-helper/pull/61).
- Rebranded the Search feature to **Ask AI**, added a DaleTech brand mark to the app header, and expanded `CLAUDE.md` with repo conventions and gotchas. See [PR #62](https://github.com/Dale1996-code/corolla-fix-helper/pull/62).
- Added regression tests that lock in empty-by-default seeding and demo sample-file integrity. See [PR #63](https://github.com/Dale1996-code/corolla-fix-helper/pull/63).
- Fixed an intermittent failure in the symptom/procedure link tests by resetting link-panel state with a `key` prop instead of a mount effect. See [PR #64](https://github.com/Dale1996-code/corolla-fix-helper/pull/64).
- Refreshed the changelog and agent notes. See [PR #65](https://github.com/Dale1996-code/corolla-fix-helper/pull/65).

### Key PR Links

- [PR #65: Refresh changelog and agent notes](https://github.com/Dale1996-code/corolla-fix-helper/pull/65)
- [PR #64: Fix flaky symptom/procedure link tests](https://github.com/Dale1996-code/corolla-fix-helper/pull/64)
- [PR #63: Lock in empty-by-default seeding with regression tests](https://github.com/Dale1996-code/corolla-fix-helper/pull/63)
- [PR #62: Rebrand Search to "Ask AI" and add DaleTech brand](https://github.com/Dale1996-code/corolla-fix-helper/pull/62)
- [PR #61: Complete roadmap P2/P3 + optional Documents UX](https://github.com/Dale1996-code/corolla-fix-helper/pull/61)
- [PR #60: Roadmap P0/P1 fixes plus P2 docs and pagination](https://github.com/Dale1996-code/corolla-fix-helper/pull/60)

## Week of 2026-06-15

### Highlights

- Added bidirectional symptom-procedure links and AI-assisted procedure suggestions, including API routes, services, UI coverage, docs, and tests. See [PR #56](https://github.com/Dale1996-code/corolla-fix-helper/pull/56).
- Fixed backup snapshots so WAL-only committed SQLite rows are included in backup exports and the backup drill path. See [PR #57](https://github.com/Dale1996-code/corolla-fix-helper/pull/57).
- Added an optional LLM reranker for Ask retrieval and expanded retrieval and answer-quality eval tooling. See [PR #58](https://github.com/Dale1996-code/corolla-fix-helper/pull/58).
- Consolidated planning docs on the 6/20 roadmap and archived superseded planning files. See [PR #59](https://github.com/Dale1996-code/corolla-fix-helper/pull/59).
- Hardened Repair Planner and OCR behavior by handling tool failures, awaiting asynchronous document retrieval, avoiding immediate request aborts, and skipping remaining OCR work when required local tools are missing. See [PR #46](https://github.com/Dale1996-code/corolla-fix-helper/pull/46) and [PR #48](https://github.com/Dale1996-code/corolla-fix-helper/pull/48).
- Reduced duplicated client and server helpers, expanded lint and typecheck coverage, centralized document cleanup, and isolated test databases that could lock each other in CI. See [PR #47](https://github.com/Dale1996-code/corolla-fix-helper/pull/47) and [PR #54](https://github.com/Dale1996-code/corolla-fix-helper/pull/54).
- Added backup restore support, a safe restore guide, and an end-to-end backup drill, then made backup exports select the correct native `tar` executable on Windows. See [PR #50](https://github.com/Dale1996-code/corolla-fix-helper/pull/50) and [PR #55](https://github.com/Dale1996-code/corolla-fix-helper/pull/55).
- Refreshed the app shell and Documents page with an editorial layout, updated navigation, responsive mobile behavior, and bundled fonts. Evidence: commits `7825d33` and `63d8673`.
- Added saved JPEG, PNG, and WebP attachments for symptoms, procedures, and notes, including attachment cleanup and backup coverage. See [PR #51](https://github.com/Dale1996-code/corolla-fix-helper/pull/51).
- Extended Ask so a question can optionally include one saved image attachment while document retrieval remains grounded in the text question and uploaded PDFs. See [PR #53](https://github.com/Dale1996-code/corolla-fix-helper/pull/53).

### Key PR Links

- [PR #59: Consolidate docs on the 6/20 roadmap](https://github.com/Dale1996-code/corolla-fix-helper/pull/59)
- [PR #58: Add optional LLM reranker and expand retrieval/answer evals](https://github.com/Dale1996-code/corolla-fix-helper/pull/58)
- [PR #57: Fix WAL-safe backup snapshots](https://github.com/Dale1996-code/corolla-fix-helper/pull/57)
- [PR #56: Add symptom-procedure links and AI procedure suggestions](https://github.com/Dale1996-code/corolla-fix-helper/pull/56)
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
