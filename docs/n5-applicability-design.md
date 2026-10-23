# N5 — Engine and variant applicability: investigation and design

> **Status:** approved by the owner (Option D). **P0** (vehicle variant details, migration 006) is
> implemented on `claude/n5-p0-vehicle-profile`. **P1** (classification-only tagger and report) is
> implemented on `claude/n5-p1-applicability-tagger` and **measured** after a fresh whole-branch review:
> on 158 distinct blind-labeled real contexts, 0/18 other-engine figures judged to apply and 0/81
> owner figures judged another engine's (see the iteration log entry "N5 P1"). Nothing is pushed.
> P2–P6 are not started; see the P3 prerequisites in §7.
> **Date:** 2026-10-22. Measured against `main` = `5e5c4ee`; code references re-checked against
> `46b083d` (after #154 and #155, neither of which touches the code paths this design relies on).
> **Target vehicle:** 2009 Toyota Corolla LE, 1.8L **2ZR-FE**.
> **Roadmap item:** [N5](roadmap.md) — "say which variant a specification belongs to".

## 0. Summary

- **The library mixes engines, but less than it first looks, and in a sneaky way.** 1,153 of 1,443
  documents carry the ALLDATA account header *"2009 Toyota Corolla L4-1.8L (2ZR-FE)"* on the first page
  of every article, **whatever the article is about**. For 780 documents that header is the *only* place
  "2ZR-FE" appears. A rule like "keep it if it mentions 2ZR-FE" would admit, for example, document
  #1355, *Position Of Parts (2AZ-FE)*, because its header names your engine.
- **With the header ignored**, other-engine content is concentrated: 17 documents name another engine
  and never 2ZR-FE; 82 name both; 106 pages are other-engine only, 293 pages name both, and 186 pages
  hold spec tables with both a "(for 2ZR-FE)" and a "(for 2AZ-FE)" block. 1,027 documents name no engine
  at all.
- **Nothing in the app knows about applicability today.** No document, chunk, or vehicle column stores
  an engine code (`vehicles.engine` is the free text "1.8L"). Ask's prompt says only "Toyota Corolla",
  and the verifier checks quote, numbers, and subject — never variant.
- **Chunking loses context.** Chunks are 200 words, page by page, with no heading carried over. On pages
  that name an engine, 677 of 3,289 chunks (21%) do not name it themselves; 139 of those sit on pages
  that name *another* engine.
- **The current retrieval exposes it.** On 18 engine-sensitive questions (keyword path, no API), 5
  questions put other-engine evidence in the top 8 that the model sees.
- **Recommendation: Option D (hybrid), built in phases.** A deterministic scope tagger; scope stored per
  chunk at indexing (no re-embedding, $0); retrieval drops chunks that are explicitly for another engine;
  and — the real safety gate — the verifier resolves which variant **the exact cited figure** belongs to
  and refuses a spec that belongs to another engine or cannot be resolved. Unknown is never treated as
  compatible: it is shown as "the source does not say which engine".

---

## 1. What was examined, and what was left alone

**Read (never written):** the production database through a read-only `VACUUM INTO` snapshot
(1,443 documents, 20,447 chunks, `integrity_check = ok`), the app's stored PDFs folder
(`server/uploads/`, filenames only), the source folders described in §2.1
(filenames only, so no cloud-synced file was downloaded), and the server code.

**Run:** only offline scripts in the session scratchpad (§11). The one script that executed production
code (`retrieveKeywordChunks`) ran against a throwaway copy with `OPENAI_API_KEY` forced empty. **Zero
model or embedding API calls were made.**

**Not touched:** every original PDF, the production `.db` and `-wal` files (size and timestamp
unchanged), embeddings, and the two cloud sessions (Stage 5-E1, Stage 9).

One honest note: opening the database read-only updated the timestamp of its `corolla-fix-helper.db-shm`
file. That is SQLite's shared-memory lock/index file. Every reader, including the app itself, does this,
and it holds no data.

---

## 2. The document collection (Phase 1)

### 2.1 Where the documents are

| Location | PDFs | Relationship to the app |
| --- | --- | --- |
| The app's `server/uploads/` folder | 1,443 | **The app's own copies.** This is what Ask reads; every original is preserved here under a suffixed name. |
| A cloud-synced "Full Corolla guide 2" folder | 1,554 (1,438 distinct names) | 1,433 of the app's 1,439 distinct filenames — almost certainly the bulk-import source |
| A local copy of "Full Corolla guide 2" | 1,386 | 1,373 names in common — a near copy |
| An older cloud-synced "Full Corolla guide" folder | 1,153 | Older, smaller set (1,152 names in common) |
| Three small cloud-synced service-manual folders | 65 each | Small curated subsets, mainly DTC charts |

The owner knows the exact locations; they are deliberately not recorded in this public repository.

The import path is not recorded in the database (`documents.source` is "Bulk Folder Import" for 1,434
rows), so the source match is by filename.

### 2.2 Inventory

- **1,443 documents, 16,730 pages, 20,447 chunks** (all embedded at `text-embedding-3-small@512`).
- Extraction: 1,304 `completed`, 114 `completed_with_ocr`, 23 `no_text_found`, 1 failed, 1 not attempted.
- Size: 529 one-page documents, 530 of 2–5 pages, 356 of 6–20, 21 of 21–100, and **6 of over 100**.
- **The six large ones are one manual twice:** `merged_final.pdf` (#740, 5,302 pages) and its five
  pieces `_chunk_001.pdf` … `_chunk_005.pdf` (#735–#739, together 5,302 pages). They are 63% of all
  pages, they are concatenated ALLDATA article exports, and every applicability finding below appears in
  both copies.
- Metadata is thin: 1,434 bulk-imported documents have `system = "Imported Documents"` and
  `document_type = "Repair Manual"`, so neither column says anything about applicability. Most
  filenames carry the ALLDATA path and a production-date range such as `[12_2007_-_]`.

### 2.3 Engine variants represented

Engine codes found (documents containing them):

| Code | In filenames | In text (raw) | Notes |
| --- | --- | --- | --- |
| **2ZR-FE** (yours) | 49 | 1,178 | 780 of these are header-only mentions (§0) |
| **2AZ-FE** (2.4L, XRS) | 15 | 95 | The only other engine with real content |
| 1NR-FE, 1NZ-FE, 2AR-FE, 1AR-FE, 1UR-FE, 3UR-FE | 0 | 1–4 each | Only in generic material: a diagram-introduction page, a TSB, and the merged manual |
| "2ZA-FE" | 0 | 3 | OCR misreading of 2AZ-FE / 2ZR-FE |

**How a 2ZR-FE mention appears matters more than whether it appears.** Measured marker shapes (header
excluded):

| Shape | Example form | 2ZR-FE | Other engine | Meaning |
| --- | --- | --- | --- | --- |
| Inline condition | "COMPRESSOR (for 2AZ-FE)" | 837 | 350 | Scopes the rows or step that follow |
| Bracketed link | "2AZ-FE [ 2AZ-FE ENGINE CONTROL: …+ ]" | 2,483 | 159 | **A cross-reference to another procedure, not a section header** (only 27 of 14,655 brackets start a page; 5,444 end in the "+" link mark) |
| Article title | "Position Of Parts (2AZ-FE)" | 74 | 51 | Scopes the whole article |
| Diagram title | "Engine Control <2AZ-FE , Except TMC Made>" | 38 | 34 | Scopes a wiring sheet; repeated on each OCR'd page |
| Legend | "* 2: 2AZ-FE  * 3: 2ZR-FE" | 9 | 29 | Footnote keys in diagrams — scope is indirect |
| Account header | "Corolla L4-1.8L (2ZR-FE)" | 3,207 pages | — | **Never evidence of applicability** |

### 2.4 Mixed, other-engine, shared, and unclear documents (header excluded)

| Class | Documents | Pages (from chunks) |
| --- | --- | --- |
| Names only 2ZR-FE | 317 | 1,982 |
| Names both engines (**mixed**) | 82 | 293 |
| Names only another engine (**incompatible**) | 17 | 106 |
| Names no engine (shared or unknown) | 1,027 | 12,863 |

- **The 17 incompatible-only documents** fall into three groups:
  - **11 whose filename names 2AZ-FE.** These are five OCR'd wiring diagrams (#279 *Cooling Fan*,
    #299 *Cruise Control*, #303, #506, #537 *Engine Control*, all "Except TMC Made"), two text wiring
    diagrams (#293, #465), and four location articles (#1354, #1355 *Position Of Parts*, #1379, #1380
    *Ground Points*). Six of these eleven would look "mixed" if the account header were counted.
  - **4 whose filename names no engine, while the text names only 2AZ-FE.** #354 and #356 are overall
    wiring-diagram pages. #140 and #141, *Ambient Temperature Sensor — Removal and Replacement*, are a
    shared procedure with a step marked for the 2AZ-FE only. That is the clearest case for
    whole-document labels being too coarse: most of the procedure applies to your car.
  - **2 that name only unrelated engines** (#1321, #1322, *Diagram Information — Introduction*), which
    use 1NR-FE and 1NZ-FE as examples. They are not incompatible content at all.
- **Filenames cannot be trusted in either direction.** 1,383 filenames name no engine, and the
  filename-level label disagrees with the text-level label for 6 documents.
- **Mixed documents** include the merged manual and its five pieces. Within them, 186 pages hold a
  spec table with both a "(for 2ZR-FE)" and a "(for 2AZ-FE)" block, and 83 chunks name both engines
  *and* carry a unit-bearing specification.
- **Shared procedures.** Maintenance summaries such as #654 *Engine – General Maintenance* list one
  step per engine, each pointing to an engine-specific procedure ("See Procedure 2ZR-FE […] 2AZ-FE […]").
  The step is shared; the linked procedure is not.
- **Unclear.** 12,863 pages name no engine. Most are engine-agnostic (body, brakes, HVAC, B-code
  charts), but the design must not assume that: 6 of those pages sit inside articles whose *title*
  names 2AZ-FE, and 952 pages belong to documents with no ALLDATA article line at all (OCR'd diagrams,
  TSBs) where nothing beyond the page itself can be read.

### 2.5 Other variant axes (documents mentioning)

Engine is not the only axis, and it is not the most frequent one:

| Axis | Documents |
| --- | --- |
| Build plant: "TMC Made" / "Except TMC Made" / "NUMMI Made" | 392 / 207 / 45 |
| Smart Key: with / without | 116 / 109 |
| VSC: with / without | 62 / 36 |
| Transmission: U341E / U250E / C59 / E351 | 43 / 18 / 8 / 6 |
| Market "for USA" | 5 |

The existing eval case `applicability-engine-mount-build-variant` already shows one fastener with two
torques on the *same* engine, split by build plant. Plant cannot be resolved without your car's plant
(§9).

---

## 3. The pipeline today (Phase 2)

| Step | Where | What it does | Applicability |
| --- | --- | --- | --- |
| Import | `server/src/scripts/importFolder.js:144` (bulk), `server/src/services/documentService.js:748` (web upload) | MD5 dedup (bulk only), copy to `UPLOADS_DIR`, extract, chunk | none recorded; `system` is generic |
| Extraction | `server/src/services/pdfService.js:176` `extractPdfData` | Page-by-page text; local OCR on low-text pages when `OCR_ENABLED` | page numbers kept, nothing else |
| Chunking | `server/src/services/documentChunkService.js:25` `chunkPageText`, `:63` `buildChunksFromPages` | 200-word windows, 40-word overlap, **per page**, no heading carried | context lost after the first chunk of a page |
| Embedding | `server/src/services/chunkEmbeddingService.js:282` | Embeds `chunk_text` only, versioned `model@dims` | no title, filename, or scope in the vector |
| Association | `document_chunks(document_id, page_number, chunk_index)` | Chunk → document → filename and page | **preserved correctly**; citations survive |
| Retrieval | `server/src/services/chunkRetrievalService.js:264` | Keyword scoring (title, filename, system boosts at `:43`) fused with cosine similarity, then diversity cap | **no vehicle or variant filter** |
| Model context | `server/src/services/askEvidenceContract.js:83` | `[S1] title (filename) page N: chunk` | the filename sometimes names the engine; nothing structured |
| Prompt | `askEvidenceContract.js:96` | "You answer Toyota Corolla repair questions…" | **your engine is never stated** |
| Verification | `askEvidenceContract.js:1582` `verifyEvidence` | Quote in chunk → numbers printed → no unrecognized figures → subject matches | **no variant check**; a quote holding both engines' rows passes for either number |
| Planner | `server/src/services/agent/repairTools.js:496`, `repairPlannerAgent.js:190` | Sources as `[S1] title (page N)` without filename; the vehicle label defaults to the literal "2009 Toyota Corolla LE 1.8L" rather than reading `vehicles` | same gaps |

**What the database stores about applicability:** nothing structured. `vehicles` has
`year=2009, make=Toyota, model=Corolla, trim=LE, engine="1.8L"` — no engine code, plant, transmission,
or options. `documents` and `document_chunks` have no variant columns.

**Specific weaknesses**

1. **Header pollution.** The account header puts "2ZR-FE" on 3,207 pages regardless of content.
2. **Context loss at chunk boundaries.** 21% of chunks on engine-marked pages carry no marker; a
   "(for 2AZ-FE)" table block can sit in one chunk and the matching "(for 2ZR-FE)" block in the next.
3. **Article scope is on page 1 only.** An article titled "(2AZ-FE)" names its engine once; its later
   pages do not.
4. **Brackets look like headers but are links.** Treating "[ 2AZ-FE … ]" as a section start would
   mis-scope thousands of pages (an early measurement of mine did exactly that and was discarded).
5. **Embeddings cannot see scope.** Only chunk text is embedded, so semantic retrieval ranks a 2AZ-FE
   chunk and a 2ZR-FE chunk by topic alone.
6. **The model is never told the engine,** and the verifier cannot tell which row of a mixed table a
   figure came from.
7. **Variant axes beyond engine are common** (plant on 600+ documents), and your car's values for them
   are not recorded anywhere.

---

## 4. Wrong-engine scenarios (measured)

**Retrieval probe.** 18 engine-sensitive questions through the production `retrieveKeywordChunks`
(top 8, diversity on, no API). Of 144 results: 9 chunks name both engines, 2 name only 2AZ-FE, 6 of the
mixed ones carry a specification, 12 name 2ZR-FE only through the account header, and **78 (54%) name
no engine at chunk or page level**. Five questions pulled other-engine evidence: oil capacity, valve
clearance, crankshaft pulley torque, vehicle height, and drive belt replacement. The hybrid (semantic)
path was not measured, because it needs a paid query embedding.

Concrete shapes, each from the real corpus:

| # | Scenario | Where | What can go wrong today |
| --- | --- | --- | --- |
| S1 | **Mixed spec table in one chunk** | #109 p2, #112 p1 (alignment) | The front-height table prints 2ZR-FE and 2AZ-FE rows, and TMC / except-TMC rows, two lines apart. A claim using the 2AZ-FE figure, quoted with its row, passes every current check. |
| S2 | **Table split across chunks** | #88 p1 (A/C torque) | Retrieval returned the chunk starting with the "(for 2AZ-FE)" block; the "(for 2ZR-FE)" block is in a different chunk. Here the values happen to match; the shape is the hazard. |
| S3 | **Header names your engine, title names the other** | #1355, #1354, #1379 | "Mentions 2ZR-FE" is true of a 2AZ-FE parts-location article. |
| S4 | **Shared step, engine-specific procedure** | #654 p1–p3 (maintenance) | "Inspect drive belt / spark plugs" lists a procedure per engine; a claim can cite the 2AZ-FE link text. |
| S5 | **Incompatible-only wiring diagram** | #537, #506, #303, #299, #279 | A pin or connector claim taken from the 2AZ-FE engine-control diagram would verify; nothing says it is the wrong engine. |
| S6 | **Right engine, wrong plant** | #1269 p1 (eval case `applicability-engine-mount-build-variant`) | Two torques for one fastener on the 2ZR-FE, split by plant. Engine filtering alone cannot help. |

---

## 5. Comparing the four approaches (Phase 3)

| | **A. Curate before import** | **B. Filter results at query time** | **C. Scope metadata at indexing** | **D. Hybrid (recommended)** |
| --- | --- | --- | --- | --- |
| How | Build a second library holding only confirmed-applicable PDFs | Regex the retrieved chunks; drop other-engine ones | Tag every chunk with the scope in effect; enforce in retrieval and verification | C + B's cheap filter + a claim-level check at the exact cited figure + a read-only report |
| Wrong-engine identification risk | Low for whole documents; **cannot split mixed pages or tables** | High: sees only the chunk, so 21% context loss and article scope are invisible | Medium: article and section scope recovered; row level still inside the chunk | **Lowest**: row-level resolution at the figure, and fails closed when unresolved |
| Implementation complexity | Low code, **high manual labor**, repeats for every new PDF | Low | Medium (tagger, migration, rebuild hook, backfill) | Medium–high, but split into small phases |
| Retrieval accuracy | Fewer distractors; may drop shared pages | Shrinks the context unless it over-fetches | Can exclude and label precisely, before diversity backfills the slots | Same as C, plus labels the model can use |
| Mixed pages and shared procedures | No | No (dropping a mixed chunk drops your rows too) | Partly | Yes — mixed chunks are kept, and the figure decides |
| Database compatibility | **Poor**: a re-import creates new document ids and breaks live links from checklists and repair history (the snapshots survive, the links do not) | Full; no schema change | Additive nullable columns; nothing removed | Same as C |
| Reindex or re-embed | Full re-import, OCR, and re-embed | None | **None**: chunk text is unchanged, so embeddings stay valid | None |
| Estimated OpenAI cost | ≈ $0.08 to re-embed ~4.0M tokens (20,447 chunks × ~196 tokens at ~$0.02 per 1M; check current pricing) | $0 | $0 | $0 to build; one approved `eval:answers` run (~81 provider requests) to confirm |
| Testing and rollback | Backup restore; heavy | Trivial | Migration is additive; revert code to roll back | Same as C; each phase reverts on its own |

**Why not A:** it cannot separate the 293 mixed pages or the 186 mixed tables, it would re-key the
library under existing repair records, and it puts you on the hook to re-curate every new PDF. Its one
real benefit — keeping the five 2AZ-FE-only diagrams out — comes for free from the tagger.

**Why not B or C alone:** B cannot see context, and C still needs a decision at the level of a single
table row, because S1 is one chunk. Only a check at the cited figure catches S1.

---

## 6. Recommended architecture (Option D)

### 6.1 Parts

1. **Owner vehicle profile** — your car's values on each axis, stored on the single `vehicles` row:
   `engine_code`, `build_plant`, `transmission_code`, `has_vsc`, `has_smart_key`. `NULL` means unknown,
   and unknown is never compatible (§6.3). The manual's plant wording is matched by meaning, not by
   string: "for TMC Made" matches only `TMC`, while "Except TMC Made" matches any plant except `TMC`
   (NUMMI or TMMC).
2. **Scope tagger** — a new pure leaf module (in the style of `retrievalDiversity.js`; suggested name
   `server/src/services/applicabilityScope.js`), with no database or model access. Given text, it
   returns scope markers with positions. Grammar, from §2.3:
   - **Ignored:** the account header "…Corolla L4-1.8L (2ZR-FE)".
   - **Article scope:** an engine in the ALLDATA path/title line; it lasts until the next article line.
   - **Inline scope:** "(for X)" and a diagram title "<X , …>"; it lasts until the next marker on the
     same axis, a structural break (a numbered step, an all-caps heading, a new article), or the end of
     the page.
   - **Link scope:** "X [ … ]" applies to the link only, never to the surrounding text.
   - **Unresolved regions:** legends ("* 2: 2AZ-FE"), and runs of two different engine codes with no
     figure between them (column headers).
3. **Persisted entry scope** — at chunk build time, store for each chunk the scope in effect at its
   first word (`scope_at_start`) and a `scope_version`, much as embeddings carry `embedding_version`.
   This repairs the context lost at chunk boundaries without changing chunk text or embeddings.
4. **Retrieval** — just before the diversity step, drop chunks whose scope is *explicitly and only*
   another variant (no owner marker, nothing unresolved). Diversity then backfills, so the model still
   gets 8 sources. Each source line in the model context gains a scope label.
5. **Prompt** — states the owner profile and asks the model to quote your row. This is a hint; the
   verifier stays the authority.
6. **Verifier applicability check** — a new step in `verifyEvidence` (`askEvidenceContract.js:1582`),
   after `subject_mismatch`. It resolves the scope at the **exact position of each matched figure**,
   seeded with `scope_at_start`. The figure comes from the same comparison that already yields D1's
   printed figure, but `checkClaimNumbers` (`:970`) returns only the figure's text today. It must also
   return the figure's offset in the quote: one small additive change, which the builder makes first.
7. **UI** — a per-claim line beside the printed figure: "Source states: 2ZR-FE", or "The source does not
   say which engine this applies to". It never says "confirmed for your car".
8. **Read-only report** — `npm run diagnose:applicability`, modelled on `diagnose:zero-chunks`: other-engine
   documents, mixed pages, header-only documents, unresolved tables, per-axis counts. It feeds N8.
9. **Planner parity** — the same tagger and check, exposed as a fourth shared neutral helper.

### 6.2 How a cited figure is judged

For each verified claim with a figure, the check:

1. Strips the account header.
2. Finds the quote's occurrences in the chunk.
3. Finds each matched figure's offset.
4. Assigns the scope of the segment that offset falls in.
5. Compares that scope with the owner profile, axis by axis.

| Result | When | Specification claim | Non-numeric claim (step, warning) |
| --- | --- | --- | --- |
| `applies` | Every scoped axis equals the owner's value | Accepted; "Source states: 2ZR-FE" | Accepted |
| `other_variant` | Any scoped axis names a different value | **Rejected** (`wrong_variant`); gap line with no figure: "The manual gives this value for another engine (2AZ-FE)." | **Rejected** |
| `unresolved` | Unresolved region, the quote spans two scopes, or the owner value is unknown for a scoped axis | **Rejected** (`variant_unresolved`); gap points to the page | Accepted with a flag |
| `not_stated` | No marker on any axis in the segment, page, or article | Accepted with "The source does not say which engine this applies to" | Accepted |

Identical values for both engines (S2) are a known cost. A figure cited from the 2AZ-FE block is
refused even though the 2ZR-FE block prints the same number; the model has to cite your block, which
retrieval now favors. That is fail-closed by design.

### 6.3 The safety requirements, one by one

| Requirement | How it is met |
| --- | --- |
| Never assume 2ZR-FE because the document mentions it | The account header is stripped. A mention elsewhere on the page does not scope a figure; only the segment containing the figure counts. |
| Never treat an unknown engine as compatible | `not_stated` is shown as such, `unresolved` specifications are rejected, and an unknown owner value makes the axis `unresolved`. |
| Preserve original PDFs and page references | Metadata only; chunk text, ids, page numbers, files, and citations are unchanged. |
| Handle mixed tables and sections safely | Mixed chunks stay in context; the cited figure's own row decides; column layouts and legends fail closed. |
| Distinguish general procedures from engine-specific specs | Specification and non-numeric claims follow different rows of §6.2; link scope keeps a shared step separate from its linked procedure. |
| No 2AZ-FE spec presented as a verified 2ZR-FE spec | `other_variant` is a verifier rejection, not a prompt request. |
| Reject or clearly flag when applicability cannot be established | `variant_unresolved` rejection, or the visible `not_stated` note. |
| Preserve existing evidence protections | The check runs after every existing one and can only reject more. |
| Do not rely solely on an LLM | The tagger, scope, and verdict are deterministic code; the prompt hint is advisory. |

---

## 7. Phased implementation plan

Each phase is one branch and one PR, gated by lint, typecheck, both suites, build, and smoke.

| Phase | What | Acceptance criteria |
| --- | --- | --- |
| **P0 — Owner profile** | Numbered migration adds the profile columns to `vehicles`; Settings shows and edits them; `getVehicle()` returns them | Your answers to §9 are stored; `NULL` is shown as "unknown"; migration test; no other behavior change |
| **P1 — Tagger and report (read-only)** | `applicabilityScope.js` with unit tests on synthetic strings; `diagnose:applicability` script | The report reproduces this document's counts (header-only 780, other-only 17, mixed 82, …). On a hand-checked set of ≥150 real chunks (kept in a gitignored folder, never committed), **zero** 2AZ-FE figures are labeled `applies`, and ≤5% of 2ZR-FE figures are labeled `other_variant`. |
| **P2 — Persist scope** | Next numbered migration adds `scope_at_start`, `scope_version` to `document_chunks`; computed inside the same rebuild transaction as the chunks; `backfill:applicability` script | 20,447 of 20,447 chunks tagged; embedding count and versions identical before and after; zero API calls (run with the key unset); re-extraction recomputes atomically (extend `documentChunkAtomicRebuild.test.js`); `eval:retrieval` 12/12 unchanged |
| **P3 — Verifier check, shadow then enforce** | §6.2 in `verifyEvidence`; verdicts first reported through the log-safe metrics channel only, then enforced | New oracle rows (§8) green. An offline replay of captured answers changes verdicts only on applicability rows. Then enforced, with the verified eval set still 14/14. |
| **P4 — Retrieval, prompt, UI** | Exclusion before diversity; scope labels in the context; profile in the prompt; per-claim UI line | The 18-question probe shows 0 explicitly other-engine chunks in the top 8 (today 2), still 8 results each. One approved `eval:answers` run recorded in the iteration log. UI copy never claims more than "source states". |
| **P5 — Other axes** | Plant, VSC, transmission, Smart Key: report first, then enforce one axis at a time | Each axis enforced only after its own measurement and your profile value |
| **P6 — Planner parity** | Shared helper in `repairPlanEvidenceContract.js`; tool results filtered | Planner oracle rows for wrong-engine `numeric_spec` claims green |

**P3 prerequisites found while building P1.** The final review's fail-open paths are fixed in P1, but these
residual risks were ruled rather than fixed, and P3 must handle them before it enforces anything:

1. **Continuation of another engine's block over a page break** reads `not_stated` on the next page
   (an inline `(for X)` block does not cross pages). P3 must not accept a `not_stated` spec silently there.
2. **Engine names in headings without parentheses** are not article scope: "2ZR-FE ENGINE CONTROL: …" in
   the merged manual (12 of the owner's labeled figures read `not_stated`), and an unparenthesized code in a
   "Vehicle > …" title line.
3. **A lost article line.** If an article's "Vehicle > …" line fails to extract, a previous 2ZR-FE article's
   scope can apply to the new article's unmarked figures on that page after a 2AZ-FE step. That never
   happens in the current library (3,198 of 3,207 headers sit directly before their article line; the other 9
   open documents), and the cross-page leg is already refused.
4. **The label sampler's unit pattern over-reads** (a "91V" tire index read as volts). It never affects the
   tagger, but P3 must not reuse it as a spec detector.
5. **Engine size as a variant label.** Wiring diagrams mark variants as "(2.4L)", "(1.8L)", or "TMC MADE &
   2.4L"; the blind check found four such labels the tagger does not read (§10 excludes sizes in v1). Measure
   a "(2.4L)/(1.8L)" alias rule in variant-label positions before P3 enforces on diagrams.

**Rollback.** P1 changes nothing. P2's columns are additive and harmless if unused (never edit an
applied migration). P3 and P4 revert with `git revert`, and the shadow step means enforcement only
lands after its effect is measured. Nothing is left behind a permanent off-by-default flag, matching
the project's rule for safety features.

---

## 8. Regression tests that prove incompatible specs are rejected

All tests use short synthetic manual-style text, never real manual text (the repo is public).

**Tagger units** (`applicabilityScope.test.js`):
- The account header yields no scope.
- "(for 2AZ-FE)" opens a scope and the next "(for 2ZR-FE)" closes it.
- An article titled "(2AZ-FE)" scopes its later pages.
- "2AZ-FE [ … + ]" scopes only the link.
- A legend and a two-code column header are `unresolved`.
- A diagram title "<2AZ-FE , Except TMC Made>" sets two axes.
- `scope_at_start` is correct for a page's third chunk.

**Evidence oracle**: a new `applicability` channel in `server/test/fixtures/evidenceOracle.js`.

| Row | Setup | Expect |
| --- | --- | --- |
| AP-1 | Mixed table; claim uses the 2AZ-FE row's figure | reject `wrong_variant` |
| AP-2 | Same table; claim uses the 2ZR-FE row | accept, `applies` |
| AP-3 | Later chunk inside a "(for 2AZ-FE)" block, no marker of its own | reject `wrong_variant` |
| AP-4 | Page 2 of an article titled "(2AZ-FE)" | reject `wrong_variant` |
| AP-5 | Only the account header names an engine | accept, `not_stated` — never `applies` |
| AP-6 | Column-header table "2ZR-FE 2AZ-FE / 92 96" | reject `variant_unresolved` |
| AP-7 | Brake spec, no markers anywhere | accept, `not_stated` |
| AP-8 | Both engines print the same value; cited from the 2ZR-FE block | accept, `applies` |
| AP-9 | The quote appears in both engine blocks | reject `variant_unresolved` |
| AP-10 | Plant-scoped figure while the owner plant is unknown | reject `variant_unresolved` once the plant axis is enforced |
| AP-11 | Non-numeric step inside a 2AZ-FE block | reject `wrong_variant` |

**Retrieval:**
- An explicitly other-engine chunk is excluded *before* diversity, so 8 slots stay filled.
- A mixed chunk is kept.
- An unscoped chunk is kept.

**Persistence:**
- Scope columns are rebuilt in the same transaction as the chunks.
- The backfill is idempotent and never touches `embedding` or `embedding_version`.

**Rendering:**
- The gap line for a wrong-variant claim contains no figure (reuse `redactSpecNumbers`).
- The UI copy is pinned.

**Answer evals (paid, approved per run):**
- Re-observe `applicability-vehicle-height-wrong-engine` and `applicability-engine-mount-build-variant`.
- Add hand-confirmed cases for S2 (A/C compressor torque) and S4 (drive belt procedure), with
  expectations read off the rendered PDF pages, following the N1 promotion bar.

---

## 9. Decisions needed from you

1. **Your car's profile.** Engine 2ZR-FE (please confirm). Also:
   - **Build plant:** the first character of your VIN tells it. My understanding is J = Japan
     (the manual's "TMC"), 1 = USA (NUMMI), 2 = Canada (TMMC); please check this against the VIN plate.
   - **Transmission:** automatic (U341E) or manual (C59).
   - **VSC:** fitted or not.
   - **Smart Key:** fitted or not.

   Anything you leave unknown stays "unknown", which makes specs scoped on that axis show as unresolved.
2. **"Source doesn't say" specs:** accept them with a visible note (recommended), or downgrade the whole
   answer to `partial`?
3. **Other-engine values:** drop them with a gap line and no number (recommended), or show them
   labeled "for 2AZ-FE (not your engine)"?
4. **Exclude explicitly other-engine chunks from Ask and the planner** before the model sees them?
   (Recommended: yes.)
5. **Schema shape:** new nullable columns on `vehicles` and `document_chunks` (recommended — rebuilt
   with the chunks for free), or separate side tables?
6. **Shadow first:** measure the verifier change offline before enforcing it (recommended)?
7. **Hand-checked label set:** I prepare it and keep the real text in a gitignored folder; you only skim
   a short list of the hardest rows. Is that acceptable?
8. **Paid run:** approve one `eval:answers` run after P4, with the dollar estimate stated before it runs.
9. **First enforcement scope:** engine only (recommended), with the other axes reported but not
   enforced until P5.

---

## 10. What this design cannot do

- It reads **marker words**, not meaning. Applicability written in prose ("on models with the larger
  engine") is `not_stated`.
- Scope **extent** is a heuristic (next marker, structural break, page end). P1's hand-checked set is
  what proves it; if the measurement disagrees, the rule changes before anything is enforced.
- OCR'd pages misread codes ("2ZA-FE" was seen 3 times). Misread codes fall to `unresolved`, not
  `applies`.
- "1.8L" / "2.4L" designations are not used as engine aliases in v1. Most "1.8L" occurrences are the
  account header; measure before adding them.
- Identical values printed for both engines are refused when cited from the other engine's block (§6.2).
- The semantic retrieval path was not measured here, because it needs a paid query embedding.

---

## 11. Reproducing the measurements

All scripts were read-only, used no API, and lived in a temporary session folder outside the
repository, so they will not survive; P1 turned the useful parts into the committed
`diagnose:applicability` report and `check:applicability-labels` check.

| Script | Produces |
| --- | --- |
| `snapshot.mjs` | Read-only `VACUUM INTO` copy (`corpus-copy.db`) |
| `inventory.mjs` | §2.2 counts |
| `classify.mjs`, `classify2.mjs` | §2.3–§2.4 (`classify2.mjs` excludes the account header) |
| `articles.mjs` | Breadcrumb-vs-link and article-title scope (§2.3, weakness 4) |
| `otheronly.mjs` | The 17 incompatible-only documents (§2.4) |
| `probe.mjs`, `scenarios.mjs` | §4 retrieval probe on a throwaway copy (`probe.db`) |
| `folders.mjs` | §2.1 folder matching (filenames only) |
| `inherit.mjs` | **Superseded.** It treated brackets as headers; kept only as the record of that mistake |
