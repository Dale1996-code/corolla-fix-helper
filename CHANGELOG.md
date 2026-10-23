# Changelog

## Week of 2026-10-19

### Highlights

- Acted on the 2026-10-18 full review, one stage per PR. The audit's evidence and safety findings became oracle tests, the unfixed ones marked `todo` ([PR #147](https://github.com/Dale1996-code/corolla-fix-helper/pull/147)). Restore now swaps folders by rename and reports what it actually did, and stopping the server checkpoints the WAL into the `.db` file ([PR #148](https://github.com/Dale1996-code/corolla-fix-helper/pull/148)). The Ask verifier fails closed: a claimed number must be printed in its quote in the same unit, with no tolerance or conversion (owner decision D1) ([PR #149](https://github.com/Dale1996-code/corolla-fix-helper/pull/149)), and Ask shows that printed figure beside each verified claim ([PR #151](https://github.com/Dale1996-code/corolla-fix-helper/pull/151)). A request gate stands in for the missing login: unknown `Host` → 421, cross-site write → 403, a body that is not JSON or multipart → 415, and unhandled errors as JSON ([PR #150](https://github.com/Dale1996-code/corolla-fix-helper/pull/150)).
- Repair Planner verification keeps a claim's meaning: negation, range, whole-clause, and task-subject checks, plus whole-word tool and part matching ([PR #152](https://github.com/Dale1996-code/corolla-fix-helper/pull/152)). Its stream frames no longer carry model arguments or provider error bodies, searches and tool calls per turn have fixed bounds, embedding requests time out and count against the daily ceiling (owner decision D4), and the defeat gate runs inside the planner as well as at its route ([PR #155](https://github.com/Dale1996-code/corolla-fix-helper/pull/155)).
- Wheel, tire, CV-axle, hub-bearing, and exhaust jobs now block a Ready rating, and the defeat gate's "how does … work" exemption no longer pardons a defeat request ([PR #153](https://github.com/Dale1996-code/corolla-fix-helper/pull/153)). Tests never read `server/.env`, CI is hardened, a time-zone-dependent test is fixed, and the repo has an `.nvmrc` ([PR #154](https://github.com/Dale1996-code/corolla-fix-helper/pull/154)).
- Started N5 (applicability): migration `006_vehicle_applicability_profile` and a **Variant details** section on Settings ([PR #156](https://github.com/Dale1996-code/corolla-fix-helper/pull/156)), then a deterministic tagger and `npm run diagnose:applicability` report that classify which engine a manual passage is scoped to. Nothing uses the tagger yet ([PR #157](https://github.com/Dale1996-code/corolla-fix-helper/pull/157)).

### Key PR Links

- [PR #157: feat(n5): classification-only applicability tagger and report (N5 P1)](https://github.com/Dale1996-code/corolla-fix-helper/pull/157)
- [PR #156: feat(n5): vehicle variant details and migration 006 (N5 P0)](https://github.com/Dale1996-code/corolla-fix-helper/pull/156)
- [PR #155: fix(planner): close SSE and error leaks, bound planner and embedding spend (audit Stage 5-E1)](https://github.com/Dale1996-code/corolla-fix-helper/pull/155)
- [PR #154: fix(test): global .env isolation for tests, CI hardening, TZ-safe test, .nvmrc (audit Stage 9)](https://github.com/Dale1996-code/corolla-fix-helper/pull/154)
- [PR #153: fix(safety): safety classifier and defeat gate (audit Stage 6)](https://github.com/Dale1996-code/corolla-fix-helper/pull/153)
- [PR #152: fix(planner): meaning-preserving claim verification (audit Stage 5-E2)](https://github.com/Dale1996-code/corolla-fix-helper/pull/152)
- [PR #151: feat(ask): show the manual's printed figure beside each verified claim (D1)](https://github.com/Dale1996-code/corolla-fix-helper/pull/151)
- [PR #150: fix(security): request gate for the no-login app (Stage 3)](https://github.com/Dale1996-code/corolla-fix-helper/pull/150)
- [PR #149: fix(ask): make the evidence verifier fail closed (audit Stage 2)](https://github.com/Dale1996-code/corolla-fix-helper/pull/149)
- [PR #148: fix: rename-only restore and clean SQLite shutdown (Stage 4-D1)](https://github.com/Dale1996-code/corolla-fix-helper/pull/148)
- [PR #147: test: evidence and safety oracles, audit findings as todo tests (Stage 1a)](https://github.com/Dale1996-code/corolla-fix-helper/pull/147)

## Week of 2026-10-05

### Highlights

- N4: volts, millivolts, ohms, kilohms, amps, and milliamps must equal the printed value, with no tolerance ([PR #140](https://github.com/Dale1996-code/corolla-fix-helper/pull/140)), and the `A` and `mA` symbols are detected, counting only toward current claims ([PR #146](https://github.com/Dale1996-code/corolla-fix-helper/pull/146)).
- Cleared every dependency advisory in the root, server, and client lockfiles: `brace-expansion` and `shell-quote` ([PR #141](https://github.com/Dale1996-code/corolla-fix-helper/pull/141)), `multer`, `proxy-addr`, and `qs` ([PR #142](https://github.com/Dale1996-code/corolla-fix-helper/pull/142)), `pdfjs-dist` 6.2.108 ([PR #143](https://github.com/Dale1996-code/corolla-fix-helper/pull/143)), a client lockfile refresh ([PR #144](https://github.com/Dale1996-code/corolla-fix-helper/pull/144)), and Vitest 4.1.11 ([PR #145](https://github.com/Dale1996-code/corolla-fix-helper/pull/145)).

### Key PR Links

- [PR #146: Check A and mA current symbols, scoped to current claims (N4)](https://github.com/Dale1996-code/corolla-fix-helper/pull/146)
- [PR #145: fix(deps): upgrade client to Vitest 4.1.11 (last client advisories)](https://github.com/Dale1996-code/corolla-fix-helper/pull/145)
- [PR #144: fix(deps): clear client production and in-range dev advisories](https://github.com/Dale1996-code/corolla-fix-helper/pull/144)
- [PR #143: fix(deps): upgrade server pdfjs-dist to 6.2.108 (last server advisory)](https://github.com/Dale1996-code/corolla-fix-helper/pull/143)
- [PR #142: fix(deps): clear server multer, proxy-addr and qs advisories](https://github.com/Dale1996-code/corolla-fix-helper/pull/142)
- [PR #141: fix(deps): clear root brace-expansion and shell-quote advisories](https://github.com/Dale1996-code/corolla-fix-helper/pull/141)
- [PR #140: Require electrical values to equal the printed value (N4)](https://github.com/Dale1996-code/corolla-fix-helper/pull/140)

## Week of 2026-09-28

### Highlights

- The Ask subject guard accepts a part name in a different word order ("X of the Y") and lettered parts such as "bolt A", alongside an N1 slice of table-derived eval cases; its live eval (Experiment G) passed 14/14 verified ([PR #138](https://github.com/Dale1996-code/corolla-fix-helper/pull/138)).
- Two test suites that opened the real repair database at import time now use scratch paths, with a guard against it happening again ([PR #139](https://github.com/Dale1996-code/corolla-fix-helper/pull/139)).

### Key PR Links

- [PR #139: test: isolate two suites that opened the real database, and guard it](https://github.com/Dale1996-code/corolla-fix-helper/pull/139)
- [PR #138: Fix Ask subject-guard word order and lettered parts; add N1 table evals](https://github.com/Dale1996-code/corolla-fix-helper/pull/138)

## Week of 2026-09-14

### Highlights

- The evidence checks recognize the electrical symbols manuals print — `V`, `mV`, `Ω`, and `kΩ` — case-sensitively, with no conversion between them (N4) ([PR #137](https://github.com/Dale1996-code/corolla-fix-helper/pull/137)).

### Key PR Links

- [PR #137: Recognize electrical unit symbols in evidence checks](https://github.com/Dale1996-code/corolla-fix-helper/pull/137)

## Week of 2026-09-07

### Highlights

- The Ask subject guard covers voltage, resistance, rpm, and temperature as well, and each Ask answer now states what verification does and does not check (first N4 slice) ([PR #136](https://github.com/Dale1996-code/corolla-fix-helper/pull/136)).

### Key PR Links

- [PR #136: Extend Ask evidence subject guards](https://github.com/Dale1996-code/corolla-fix-helper/pull/136)

## Week of 2026-08-31

### Highlights

- Planner citations survive into repair history: migration `005_repair_checklist_provenance` and `POST /api/repair-checklists/:id/complete` (N3.2) ([PR #134](https://github.com/Dale1996-code/corolla-fix-helper/pull/134)), then the **Repair History** page and the **Record completed repair** form (N3.3) ([PR #135](https://github.com/Dale1996-code/corolla-fix-helper/pull/135)).

### Key PR Links

- [PR #135: Add N3.3 repair history UI](https://github.com/Dale1996-code/corolla-fix-helper/pull/135)
- [PR #134: Preserve checklist provenance in repair history](https://github.com/Dale1996-code/corolla-fix-helper/pull/134)

## Week of 2026-08-24

### Highlights

- Recorded the post-M2 live answer eval (Experiment B) and finished N2: a valid vision fixture and a written rule for when the paid answer eval runs ([PR #131](https://github.com/Dale1996-code/corolla-fix-helper/pull/131)).
- Ask and the Repair Planner refuse requests to permanently defeat a vehicle safety system, in deterministic code (N2.5) ([PR #132](https://github.com/Dale1996-code/corolla-fix-helper/pull/132)).
- Repair history foundation: migration `004_repair_history` and `/api/repair-history`, with the odometer on the repair record (N3.1) ([PR #133](https://github.com/Dale1996-code/corolla-fix-helper/pull/133)).

### Key PR Links

- [PR #133: Add N3.1 repair history foundation](https://github.com/Dale1996-code/corolla-fix-helper/pull/133)
- [PR #132: Enforce T4 safety-system defeat refusal](https://github.com/Dale1996-code/corolla-fix-helper/pull/132)
- [PR #131: Record post-M2 evaluation and repair N2 eval defects](https://github.com/Dale1996-code/corolla-fix-helper/pull/131)

## Week of 2026-08-17

### Highlights

- Recovered the zero-chunk corpus: zero-chunk documents went from 128 to 13, each remaining one explained (N0) ([PR #126](https://github.com/Dale1996-code/corolla-fix-helper/pull/126)).
- Retrieval returns identical evidence once and caps chunks per logical source (`RETRIEVAL_MAX_CHUNKS_PER_SOURCE`, M2) ([PR #127](https://github.com/Dale1996-code/corolla-fix-helper/pull/127)).
- Grew and corrected the verified answer-eval set (N1) ([PR #128](https://github.com/Dale1996-code/corolla-fix-helper/pull/128)), recorded its corrected-instrument live run ([PR #129](https://github.com/Dale1996-code/corolla-fix-helper/pull/129)), and demoted the engine-mount case that run showed was unstable ([PR #130](https://github.com/Dale1996-code/corolla-fix-helper/pull/130)).

### Key PR Links

- [PR #130: Demote the unstable engine-mount applicability gate](https://github.com/Dale1996-code/corolla-fix-helper/pull/130)
- [PR #129: Record the N1 corrected-instrument live eval](https://github.com/Dale1996-code/corolla-fix-helper/pull/129)
- [PR #128: Grow and strengthen the verified answer-eval set (N1)](https://github.com/Dale1996-code/corolla-fix-helper/pull/128)
- [PR #127: Stop redundant evidence monopolizing retrieval results (M2)](https://github.com/Dale1996-code/corolla-fix-helper/pull/127)
- [PR #126: Fix N0 zero-chunk corpus recovery](https://github.com/Dale1996-code/corolla-fix-helper/pull/126)

## Week of 2026-08-10

### Highlights

- Ask's verifier rejections are reported, sanitized, behind `ASK_DEBUG_METRICS`, so a false rejection can be told apart from "not in the documents" ([PR #123](https://github.com/Dale1996-code/corolla-fix-helper/pull/123)).
- Moved the roadmap into `docs/` ([PR #124](https://github.com/Dale1996-code/corolla-fix-helper/pull/124)), then made the Markdown `docs/roadmap.md` the single current roadmap ([PR #125](https://github.com/Dale1996-code/corolla-fix-helper/pull/125)).

### Key PR Links

- [PR #125: docs: finalize the 2026-2027 roadmap and clarify roadmap history](https://github.com/Dale1996-code/corolla-fix-helper/pull/125)
- [PR #124: docs: move roadmap into docs/ and add 2026-2027 roadmap PDF](https://github.com/Dale1996-code/corolla-fix-helper/pull/124)
- [PR #123: Expose Ask verifier rejections behind ASK_DEBUG_METRICS (#107)](https://github.com/Dale1996-code/corolla-fix-helper/pull/123)

## Week of 2026-08-03

### Highlights

- Brought the Repair Planner evidence contract and real readiness onto `main`; PR #97 had merged into its stacked branch only ([PR #98](https://github.com/Dale1996-code/corolla-fix-helper/pull/98)). Turned Ask's evidence contract on by default and hardened its citations ([PR #99](https://github.com/Dale1996-code/corolla-fix-helper/pull/99)), documented both in `CLAUDE.md` and `AGENTS.md` ([PR #100](https://github.com/Dale1996-code/corolla-fix-helper/pull/100)), and generalized the Ask subject guard beyond torque ([PR #122](https://github.com/Dale1996-code/corolla-fix-helper/pull/122)).
- Repair Planner usability: a real control for the safety acknowledgment ([PR #102](https://github.com/Dale1996-code/corolla-fix-helper/pull/102)), saving a completed plan as a checklist ([PR #109](https://github.com/Dale1996-code/corolla-fix-helper/pull/109)), the AI disclosure and safety warning before generation ([PR #111](https://github.com/Dale1996-code/corolla-fix-helper/pull/111)), and copyable handoff drafts ([PR #112](https://github.com/Dale1996-code/corolla-fix-helper/pull/112)).
- UI fixes from the H-series review: Ask AI pages its document card from the server ([PR #101](https://github.com/Dale1996-code/corolla-fix-helper/pull/101)), every evidence source card opens at its cited page ([PR #108](https://github.com/Dale1996-code/corolla-fix-helper/pull/108)), an unknown URL shows a Not Found page ([PR #110](https://github.com/Dale1996-code/corolla-fix-helper/pull/110)), Settings shows AI status and restore instructions ([PR #113](https://github.com/Dale1996-code/corolla-fix-helper/pull/113)), one product name and one label per feature ([PR #114](https://github.com/Dale1996-code/corolla-fix-helper/pull/114)), view state in the URL ([PR #115](https://github.com/Dale1996-code/corolla-fix-helper/pull/115)), the shared list/detail layout ([PR #116](https://github.com/Dale1996-code/corolla-fix-helper/pull/116), [PR #117](https://github.com/Dale1996-code/corolla-fix-helper/pull/117), [PR #119](https://github.com/Dale1996-code/corolla-fix-helper/pull/119)), and one vocabulary and counter format ([PR #118](https://github.com/Dale1996-code/corolla-fix-helper/pull/118)).
- Closed three open issues: readiness inputs are cloned and frozen in the plan-run store (#103, [PR #120](https://github.com/Dale1996-code/corolla-fix-helper/pull/120)), and a test pins `chunkIndex` 0 for a page's first chunk (#105, [PR #121](https://github.com/Dale1996-code/corolla-fix-helper/pull/121)); PR #122 above closed #106.

### Key PR Links

- [PR #122: Generalize the Ask subject guard beyond torque specifications](https://github.com/Dale1996-code/corolla-fix-helper/pull/122)
- [PR #121: test: pin keyword retrieval chunkIndex 0 for a page's first chunk](https://github.com/Dale1996-code/corolla-fix-helper/pull/121)
- [PR #120: Clone and deep-freeze both readiness inputs in planRunStore.save() (#103)](https://github.com/Dale1996-code/corolla-fix-helper/pull/120)
- [PR #119: docs: document the shared ListDetailLayout convention (H6)](https://github.com/Dale1996-code/corolla-fix-helper/pull/119)
- [PR #118: Copy sweep: one vocabulary and one counter format across the UI](https://github.com/Dale1996-code/corolla-fix-helper/pull/118)
- [PR #117: Harden the H6 list/detail layout after review](https://github.com/Dale1996-code/corolla-fix-helper/pull/117)
- [PR #116: H6: fix list/detail layout clipping across the five record pages](https://github.com/Dale1996-code/corolla-fix-helper/pull/116)
- [PR #115: Put list filters, pagination, and selection in the URL (H7)](https://github.com/Dale1996-code/corolla-fix-helper/pull/115)
- [PR #114: Identity: one product name and one label per feature (H5)](https://github.com/Dale1996-code/corolla-fix-helper/pull/114)
- [PR #113: Settings: surface AI status and CLI restore instructions (H8)](https://github.com/Dale1996-code/corolla-fix-helper/pull/113)
- [PR #112: fix(planner): let each handoff draft be copied to the clipboard (H4)](https://github.com/Dale1996-code/corolla-fix-helper/pull/112)
- [PR #111: fix(planner): show the AI disclosure and safety warning on Repair Planner](https://github.com/Dale1996-code/corolla-fix-helper/pull/111)
- [PR #110: fix(client): render a Not Found page instead of a blank screen](https://github.com/Dale1996-code/corolla-fix-helper/pull/110)
- [PR #109: feat(planner): save a completed repair plan as a checklist](https://github.com/Dale1996-code/corolla-fix-helper/pull/109)
- [PR #108: fix(ask): make every evidence source card openable at its cited page](https://github.com/Dale1996-code/corolla-fix-helper/pull/108)
- [PR #102: fix(planner): give the safety readiness requirement a real acknowledgment control](https://github.com/Dale1996-code/corolla-fix-helper/pull/102)
- [PR #101: fix(search): bound Ask/Search document loading with server pagination](https://github.com/Dale1996-code/corolla-fix-helper/pull/101)
- [PR #100: docs: sync CLAUDE.md and AGENTS.md with PR #93-#99 behavior](https://github.com/Dale1996-code/corolla-fix-helper/pull/100)
- [PR #99: Harden Ask citation and evidence integrity](https://github.com/Dale1996-code/corolla-fix-helper/pull/99)
- [PR #98: Repair Planner PR 2 carry-forward: evidence contract and real readiness](https://github.com/Dale1996-code/corolla-fix-helper/pull/98)

## Week of 2026-07-27

### Highlights

- Implemented the AI/RAG grounding plan with GPT-5 compatibility; its new behaviors shipped behind flags that defaulted off ([PR #93](https://github.com/Dale1996-code/corolla-fix-helper/pull/93)), and the default answer model moved to the pinned `gpt-5.5-2026-04-23` snapshot ([PR #94](https://github.com/Dale1996-code/corolla-fix-helper/pull/94)).
- Wrote the Repair Planner integrity plan ([PR #95](https://github.com/Dale1996-code/corolla-fix-helper/pull/95)) and landed its first half: the trust boundary, canonical tasks, and completion integrity ([PR #96](https://github.com/Dale1996-code/corolla-fix-helper/pull/96)). The second half, the evidence contract and real readiness, merged into the stacked branch ([PR #97](https://github.com/Dale1996-code/corolla-fix-helper/pull/97)) and reached `main` the next week through PR #98.

### Key PR Links

- [PR #97: Repair Planner PR 2: evidence contract and real readiness](https://github.com/Dale1996-code/corolla-fix-helper/pull/97)
- [PR #96: Repair Planner PR 1: trust boundary, canonical tasks, and completion integrity](https://github.com/Dale1996-code/corolla-fix-helper/pull/96)
- [PR #95: docs: corrected Repair Planner integrity plan](https://github.com/Dale1996-code/corolla-fix-helper/pull/95)
- [PR #94: Update the default OpenAI answer model to the pinned GPT-5.5 snapshot](https://github.com/Dale1996-code/corolla-fix-helper/pull/94)
- [PR #93: AI/RAG grounding, verified evidence contract, safety hardening, and model compatibility](https://github.com/Dale1996-code/corolla-fix-helper/pull/93)

## Week of 2026-07-20

### Highlights

- Made the app fully usable from an iPhone: an installable PWA (manifest, wrench icon, launch screens), a safe offline fallback page that never intercepts `/api` and caches nothing dynamic, and a phone-ready startup banner that prints LAN/Tailscale/HTTPS install URLs. See [docs/mobile-access.md](docs/mobile-access.md). See [PR #83](https://github.com/Dale1996-code/corolla-fix-helper/pull/83).
- Worked through `corolla-fix-helper-audit-MASTER.md` in stages: cache invalidation on document delete/edit plus dependency/security hardening (multer bump, upload field caps, baseline security headers, `PRAGMA busy_timeout`) in Stage 1 & 2 ([PR #84](https://github.com/Dale1996-code/corolla-fix-helper/pull/84)); loopback-by-default binding (`NETWORK_MODE` opt-in) and AI accidental-spend guards — the shared rate limiter, a daily call ceiling, output-token caps, and a stream idle timeout — in Stage 3 safety ([PR #85](https://github.com/Dale1996-code/corolla-fix-helper/pull/85)); an ~12.5x smaller `GET /api/documents`/search payload by dropping the unused `extractedText` field in Stage 3 perf ([PR #86](https://github.com/Dale1996-code/corolla-fix-helper/pull/86)); checklist UTC-timestamp/ordering fixes, a working search "Oldest" sort, and keyboard/screen-reader-accessible checklist rows in Stage 3 client ([PR #87](https://github.com/Dale1996-code/corolla-fix-helper/pull/87)); and a new index-only migration `003_link_and_sort_indexes` covering document/link/checklist sort queries in Stage 3 indexes ([PR #89](https://github.com/Dale1996-code/corolla-fix-helper/pull/89)).
- Committed a curated set of offline/PWA phone-access fixes (service worker `/api` bypass, startup-banner refinements, new tests) that had been left uncommitted by a paused scheduled task. See [PR #88](https://github.com/Dale1996-code/corolla-fix-helper/pull/88).
- Re-applied two `AGENTS.md` corrections — the AI rate limiter is one shared 20/min window, and the folder importer dedups by MD5 only — after PR #88's merge order had reverted them. See [PR #90](https://github.com/Dale1996-code/corolla-fix-helper/pull/90).
- Frontend accessibility and consistency pass: converted clickable `<div>` list rows to real `<button>`s for keyboard/screen-reader navigation, fixed low-contrast text and a hidden `<h1>`, added `role="alert"`/`role="status"` banners across 57 previously-silent messages, and de-duplicated shared form/section components. See [PR #91](https://github.com/Dale1996-code/corolla-fix-helper/pull/91).
- Ran a documentation audit against the codebase and fixed the drift it confirmed, including migration `003_link_and_sort_indexes` missing from `DATA_MODEL.md`. See [PR #92](https://github.com/Dale1996-code/corolla-fix-helper/pull/92).

### Key PR Links

- [PR #92: docs: sync documentation with codebase through PR #91](https://github.com/Dale1996-code/corolla-fix-helper/pull/92)
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
