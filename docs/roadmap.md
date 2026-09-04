# Roadmap — Corolla Fix Helper

> **This is the current roadmap.** It is the only forward plan for this project.
> Anything else that looks like a roadmap lives in [`docs/archive/`](archive/) and is history, not a plan.
>
> - **Covers:** August 2026 → August 2027
> - **Last reviewed:** 10 August 2026
> - **Supersedes:** [`docs/archive/roadmap-v1.md`](archive/roadmap-v1.md) and the strategy review in [`docs/archive/strategy-review-2026-08.pdf`](archive/strategy-review-2026-08.pdf)

**Naming rule so this never gets confusing again:** the current roadmap is always this
file, `docs/roadmap.md`, with no date in the filename. A roadmap file *with* a date in its
name is a historical snapshot and lives in `docs/archive/`.

---

## 1. What this app is for

Corolla Fix Helper turns a personally owned pile of repair PDFs into fast, trustworthy,
actionable repair guidance — with a visible trail back to the exact page it came from.

That sentence is the test for every item below. Work that makes the trail stronger, the
answer faster to reach, or the job easier to finish while standing next to the car earns
its place. Work that mainly adds capability does not.

The project stays inside the boundaries already documented in
[`AGENTS.md`](../AGENTS.md) and [`docs/architecture.md`](architecture.md): one vehicle,
local-first, SQLite plus local files, no login, no cloud sync, no vector database. Nothing
in this roadmap changes those.

## 2. Where the project actually stands

Written down because several items below only make sense against the real state, not the
state a plan imagined.

**Strong, and already done:**

- The evidence contract is the most developed part of the app. Both AI features ask the
  model for atomic claims carrying a verbatim quote and a server-assigned source id, verify
  those server-side, and derive the answer status themselves. Only passages that actually
  backed a verified claim become citations.
- Ask AI's rejection paths are now observable (`ASK_DEBUG_METRICS`), have deterministic eval
  probes, and share a machine-readable response schema (`askResponseContract.js`).
- The subject guard is no longer torque-only: torque, capacity, pressure, clearance, and
  thickness are all checked so a matching number cannot certify the wrong component.
- Backups snapshot a live database correctly, restore validates and rolls back, and a drill
  proves the round trip.
- CI runs lint, typecheck, both test suites, the production build, and a smoke test.
- The 2026-06-20 health report's findings are, with two exceptions noted below, shipped.
- **The corpus is no longer silently incomplete.** 128 documents held zero chunks and were
  invisible to Ask regardless of how good their PDFs were. That is now diagnosed, recovered,
  and embedded — see **N0**, which is complete.
- **The repair record no longer stops at the plan.** It used to: a saved checklist kept no
  stored link back to the plan, the symptom, or the documents that produced it, and there
  was nowhere to record mileage or the result. Completing a checklist now writes a durable
  repair carrying the date, odometer, outcome, symptom, checklist, and the exact document
  pages that backed it, readable on the **Repair History** page after the symptom is
  renamed, the checklist is edited, or the document is deleted — see **N3**, which is
  complete. Recording a repair stays a deliberate act: `status = 'done'` on a checklist is
  an organizational state and still records nothing.

**Genuinely weak, and the reason for the ordering in section 4:**

- **The answer-quality eval set is too small to steer by.** 8 of 35 cases were verified
  against the real manuals before N1; the other 27 were unconfirmed templates that report
  but do not gate. A text search for `verified: true` returned 13 because five matches
  occurred inside instructional comments; the runtime `VERIFIED_IDS` set is the gating
  authority. N1 raised the suite to 14 verified of 43, then back to 13 when
  `applicability-engine-mount-build-variant` was demoted for varying at the product level.
  Almost every remaining idea in this roadmap is a change whose value can only be judged by
  that suite.
- **Four pages still download the whole document library.** Documents, Symptoms,
  Procedures, and Notes each fetch every record with no limit. Ask AI's document card was
  fixed; these were not.
- **Electrical and rpm/temperature specifications have no subject guard.** Volts, ohms,
  rpm, and temperature keep the numeric check only, so a matching number can still attach
  to the wrong component for those families.
- **Two dormant feature flags are carrying maintenance cost.** The reranker
  (`RERANK_ENABLED`) has never been measured on the real manuals with a key. The legacy
  non-evidence Ask path (`ASK_EVIDENCE_CONTRACT=false`) is the only route by which model
  prose still reaches the browser, and it exists for a backwards compatibility that has no
  consumer.

## 3. How this roadmap differs from the August 2026 strategy review

The strategy review ([`docs/archive/strategy-review-2026-08.pdf`](archive/strategy-review-2026-08.pdf))
is a good document and its strategic direction — deepen before broadening — is kept
unchanged. The changes made here are corrections of fact and scope, recorded so the
reasoning is not lost:

| Change | Why |
| --- | --- |
| Its priority 2, "finish evidence integrity", is mostly **already done** | Rejection metrics, the rejection evals, the shared response schema, and the generalized subject guard all shipped in PRs #122 and #123 on 9–10 August 2026. What remains is narrow and is restated precisely in item **N4**. |
| "Finish open evidence-hardening issues" is **removed** | There are no open issues in the repository. Issues #103, #105, #106, and #107 all closed before this roadmap took effect. |
| The 35/20/20/10/5/5/5 investment table is **removed** | Percentages of a single person's evenings are false precision. Section 4 is an ordered list instead. |
| Multi-vehicle moved from "delay, eventually high" to **not planned, with a trigger** | For a single-owner single-vehicle app it is not "eventually high" value; it becomes valuable the day a second vehicle exists and not before. |
| A local LLM provider moved to **not planned, with a trigger** | The review itself rated it high effort, high maintenance, medium value, and separately recommends against offline AI as a headline feature. Those two positions are reconciled here. |
| Diagnostic sessions **reduced in scope** | The smallest useful version is a searchable trouble-code field, not a session subsystem with freeze-frame values and PIDs. |
| Four items **added** that the review missed | Applicability handling (**N5**), corpus re-processing (**N9**), retiring dormant flags (**N6**), and the odometer gap inside repair history (**N3**). |
| Two items **carried forward** from the V1 roadmap | The bulk chunk-rebuild path and incremental typecheck strictness were dropped between roadmap versions; both are still valid. |

## 4. The plan

Priority is **Critical / High / Medium / Low**. "Maintenance" says whether the item makes
the codebase heavier or lighter to look after — a real cost for one person maintaining
this alone.

### Now — next 3 months: make quality measurable, then finish what is half-done

| # | Item | Priority | Maintenance |
| --- | --- | --- | --- |
| N0 | Recover the zero-chunk corpus | **Done** | Neutral (on-demand batch tooling) |
| N1 | Grow the verified answer-eval set | Critical — **in progress** (8 → 13 verified) | Slight increase (test data only) |
| N2 | Repair the eval suite's own defects | **Done** | Reduces |
| N2.5 | Enforce T4 safety-system defeat refusal | **Done** | Slight increase (one leaf module) |
| N3 | Repair history and maintenance records | **Done** | Increase (two migrations, one page) |
| N4 | Close the two named evidence gaps | High | Slight increase |
| N5 | Applicability: say which variant a spec belongs to | High | Slight increase |
| N6 | Retire dormant flags and the legacy Ask path | Medium | **Reduces** |
| N7 | Stop the four pages downloading the whole library | High | Slight increase |
| N8 | Document-health report | High | Slight increase |

**N0 — Recover the zero-chunk corpus. Done, August 2026.**
*Problem it solved:* 128 of 1,443 documents held zero `document_chunks`. A document with no
chunks is invisible to Ask no matter how good its PDF is, so the corpus was quietly smaller
than the library implied — and nothing in the app said so.
*What the diagnosis actually found:* not one problem but four. 120 scanned electrical wiring
diagrams with no text layer at all, needing OCR; one real 34-page DTC chart (doc #9) whose
stored text was already correct and simply had never been chunked; six dev/test fixtures;
and one malformed PDF. An important secondary finding: the scanned diagrams are **not**
duplicates of prose already in the corpus. Where a text "twin" exists it is a 593–725
character stub — breadcrumb, title, `Locations:` — so the scans are the only source of the
component, connector and signal names on those sheets.
*Measured outcome:* zero-chunk **128 → 13**. Doc #9 recovered by re-chunking its existing
text, no OCR. The scanned diagrams recovered through the production extractor with local
OCR: a single resumable batch processed 115 candidates to 109 recovered, 6 needs-review,
**0 failed, 0 OCR warnings**. The corpus went from 19,742 to **20,447 chunks** and from 5 to
**114** `completed_with_ocr` documents. All 20,447 chunks are embedded on the current
contract (`text-embedding-3-small@512`) with **0 missing**, and database integrity is `ok`.
*Why the OCR chunks were embedded whole, with no quality filter:* a noise gate was designed
and then rejected on measurement. Embedding all 757 OCR chunks costs about $0.002 in total,
so there was no spend to protect; meanwhile a gate would have dropped chunks carrying real
connector IDs and signal labels, 20 of which were the only chunk representing their page.
Filtering would have cost evidence to save nothing.
***What "complete" means here, because it is not "every PDF produced chunks":*** the 13
documents still holding zero chunks are all explained — 1 malformed source, 6 dev/test
fixtures, and 6 genuinely sparse diagrams whose OCR yield (165–239 characters) fell under the
recovery confidence threshold and were therefore **deliberately left unrecovered**. The
recovery contract only ever persists a `recovered` verdict; `needs-review`, `failed`, and
`skipped` write nothing at all. A document that stays visibly unrecovered is the safety
system working, not a gap. Forcing thin or meaningless extractions through to make the count
reach zero would make the corpus look healthier than it is, which is the failure this item
existed to prevent.
*What it deliberately did not touch, and what it surfaced for later:* retrieval was measured
but not tuned. Two findings belong to **M2**: one wiring diagram can occupy several top
retrieval slots because its title repeats on every page (an "interior light wiring" query
returned only 4 distinct documents across 8 hybrid results), and the corpus contains
duplicate-text document groups (#835/#836/#837 and #839/#840) that amplify the same effect.
Neither was fixed here — both are now fixed under **M2's result-diversity item**, August 2026.

**N1 — Grow the verified answer-eval set from 8 toward about 30 cases.**
*Problem it solves:* right now most quality changes cannot be judged. Every retrieval,
prompt, chunking, and model change below is a coin flip without this.
*Why it matters:* it is the single highest-leverage engineering task in this document,
because it is what makes all the others decidable. Target the failure classes that actually
occur on this corpus: the correct number attached to the wrong component, two manual
sections that disagree, table-derived values, OCR-noisy pages, follow-up questions, and
questions the manuals genuinely do not answer. Do not chase a case count — stop when the
failure classes are covered.
*Status: in progress, not complete.* The verified gate went from 8 to 13 of 43 cases, which
is real progress and is what made the M2 and Experiment B comparisons readable. It is **not**
the finish line: this item ends when the failure classes above are covered, not at a case
count, and several are still represented only by unverified templates. Experiment B's own
conclusion — that the suite is now the limiting instrument — is the argument for continuing
N1, not for declaring it done.

**N2 — Repair the eval suite's own defects. Done, August 2026.**
*Problem it solves:* the vision case `vision-refuses-unsupported-spec` fails every run
because its 1×1 placeholder image is not a valid image, so a permanently red case sits in
the suite teaching everyone to ignore red. Replace the fixture with a real photo or delete
the case. Alongside it, write down when evals run — the answer eval costs money and needs
the real corpus, so it cannot live in CI, which means the rule has to be explicit: run it
before merging any retrieval, prompt, chunking, or model change, and record the result in
[`docs/evals/ask-rag-iteration-log.md`](evals/ask-rag-iteration-log.md).
*What shipped:* the placeholder was replaced with a committed 288×216 PNG loaded through
`server/src/evals/visionFixtures.js`, which validates the PNG signature, the IHDR chunk, and
a 32px minimum edge — so a degenerate fixture now fails loudly at load instead of quietly at
the provider. The cadence rule is written down in [`docs/quality-testing.md`](quality-testing.md).
`vision-refuses-unsupported-spec` stays `verified: false` on purpose: the fixture is sound,
but the behaviour under test has still never been observed on a live run.

**N2.5 — Enforce T4 safety-system defeat refusal. Done, August 2026 (PR #132).**
*Why this is inserted here rather than queued behind N3:* it is a **measured safety-policy
gap**, found during the post-N2 / Experiment B analysis rather than assumed. Milestone 5
wrote down a four-tier hazard policy and implemented only three tiers of it. `hazardTier`
appears nowhere in `server/src` outside the eval fixtures, so nothing in production enforces
T4 at all. Milestone 5 recorded both T4 cases passing on `gpt-4.1-2025-04-14`; they stopped
passing when the model was pinned to `gpt-5.5`, because the old model happened to refuse and
the code never did. `hazard-t4-disable-airbag-permanently` and `hazard-t4-bypass-brake-warning`
have returned `status: partial` — grounded, cited content — on all three live answer-eval runs.
*Why it belongs before N3:* it is small, deterministic, reversible, needs no schema change and
no owner decision, and it is one of the few remaining changes the current eval suite can judge
reliably, because those two cases fail *stably* rather than intermittently.
*What T4 means:* a request whose goal is to **permanently defeat, bypass, disable, neutralize,
or suppress a vehicle safety system or safety warning**. Nothing else.
*What stays allowed — this is the load-bearing half:* T1, T2, and T3 repair guidance is
unchanged. Brake and airbag work is exactly what this app exists to help with, so a dangerous
*topic* must never trigger a refusal. Temporary service and diagnostic steps stay answerable,
including the OEM SRS disarm sequence (disconnect the battery, wait the required period),
unplugging a sensor for diagnosis, replacing an airbag or ABS component, diagnosing a warning
light, and restoring a system that was previously disabled. The distinguishing signal is the
owner's **goal** — temporary service, diagnosis, or restoration is allowed; permanent defeat
is refused.
*Constraints:* implementation is **deterministic ordinary code** — no model, no embeddings, no
retrieval, no extra API call, no probabilistic scoring, and no feature flag (a safety refusal
behind an off-by-default flag is not a safety feature; `git revert` is the reversal path). This
is **not** a general-purpose safety-classifier rewrite and must not grow into a safety-policy
engine: [`safetyClassifier.js`](../server/src/services/safetyClassifier.js) keeps its existing
invariant and its two existing consumers untouched, because it classifies *task hazard* and
this classifies *request intent* — a different question.
*Stop condition:* if deterministic rules cannot separate permanent defeat from legitimate
temporary service, stop and report rather than reaching for a model.
*Position of N3 is unchanged.* N2.5 is a small insert, not a re-prioritization: **N3 remains
the next major product initiative** once this lands.

**N3 — Repair history and maintenance records.**
*Problem it solves:* the app forgets what you did. A completed job should record date,
odometer reading, what the symptom was, which plan or checklist was followed, which
documents backed it, parts used, cost, result, and any follow-up.
*Why it matters:* this is the largest product gap and the clearest thing that makes the app
worth keeping for years rather than months. Second-largest benefit: it closes the evidence
trail. Today a plan saved as a checklist keeps its citations only as plain note text, with
no stored relationship back to the plan or the documents — so the trail this whole app is
built around breaks at exactly the moment work starts.
*Note the hidden dependency:* the `vehicles` table has no mileage column, so "track mileage"
needs a decision (see section 6) and a migration before any of this is buildable.
*Explicitly not in scope:* customers, invoicing, labor billing, technician scheduling,
parts stock levels, suppliers, purchase orders.

*Status: done, August 2026.* Three slices landed — two server-side, then the UI that made them usable:

- **N3.1 — Repair history foundation. Done, August 2026 (PR #133).** Migration
  `004_repair_history` adds `repair_history` and `repair_history_documents`, plus the CRUD
  service and `/api/repair-history`. The mileage decision was resolved by putting the
  odometer on the repair record and adding **no** `vehicles.current_odometer`: a reading is
  a historical fact, a "current" odometer is a derived maximum, and storing both would
  create two writable sources of truth for one number.
- **N3.2 — Planner evidence into repair history. Done, August 2026.** Migration
  `005_repair_checklist_provenance` adds `repair_checklist_documents`, so a planner
  citation's `documentId` + `pageNumber` stops being discarded at the moment a checklist is
  saved. `POST /api/repair-checklists/:id/complete` then turns that checklist into a
  `repair_history` record and copies its provenance across. The evidence now survives
  plan-run expiry, a server restart, a document rename, and a document deletion, which are
  the four things that used to break the trail. One checklist records one repair, enforced
  by a partial unique index rather than an application check.
- **N3.3 — Repair history UI. Done, August 2026.** No migration: the schema N3.1 and N3.2
  built was already the right shape, and this slice is the owner-facing end of it. A
  **Repair History** navigation destination and page (`/repair-history`) reading
  `GET /api/repair-history` through the shared list/detail layout, with the open record in
  the query string (`?repairHistoryId=`); and a **Record completed repair** form on the
  Repair Checklists page, which is the one place a repair gets created. The page is a read
  surface on purpose: a hand-typed "create a repair" form would be a record with no
  provenance, which is the one thing this chain exists to prevent. The only server change
  was one additive field, `repairHistoryId`, on the checklist payload — completion state a
  client genuinely cannot derive, since `status = 'done'` still records nothing, so a
  reloaded page shows "Recorded in Repair History" instead of a blank form inviting a
  second record of the same job.

*What the whole initiative answers now:* what did I do, when, at what mileage, why, which
checklist did I follow, how did it turn out, is there follow-up, and which manual pages
backed it — with every one of those readable after the symptom is renamed, the checklist is
edited, or the document is deleted. `status = 'done'` on a checklist remains an
organizational state and deliberately does not record a repair.
*Still out of scope for every N3 slice, and not a condition of it being done:* parts used,
cost tracking, maintenance reminders, service intervals, dashboard history widgets, and a
vehicle-level current odometer.

**N4 — Close the two named evidence gaps.**
*Problem it solves:* electrical and rpm/temperature specifications (volts, ohms, rpm,
degrees) still pass on a numeric match alone, with no check that the number belongs to the
component being asked about. Extend the existing subject machinery to those families the
same way PR #122 extended it to volume, pressure, and length. Second: the verification
boundary — that this proves quote presence and lexical subject agreement, not that a claim
follows from its evidence — is documented for developers but is not visible to the person
reading an answer. Make that boundary legible in the UI rather than only in the docs.
*What this is not:* an attempt to make verification into semantic entailment. Adding a
model to judge whether a claim follows from its quote would replace a deterministic
guarantee with a probabilistic one. Do not.

**N5 — Applicability: say which variant a specification belongs to.**
*Problem it solves:* a measured, real defect on this exact corpus. One uploaded factory
manual carries different values for the same fastener across 2ZR-FE and 2AZ-FE engines,
ABS and non-ABS, and US and Canada trim. Single-vehicle scope does not fix this, because
the ambiguity is inside one manual. An answer that silently picks one variant is the most
dangerous failure this app can produce, because it looks exactly like a correct one.
*Why it matters:* this is the difference between "the app gave me a torque figure" and
"the app gave me *my car's* torque figure." Two eval cases already check that an answer
names the condition it is scoped to; make that a property of the answer rather than a
thing the model may or may not mention.

**N6 — Retire dormant flags and the legacy Ask path.**
*Problem it solves:* three code paths are being maintained for no current benefit. Decide
the reranker (`RERANK_ENABLED`): measure it once on the real manuals with a key, then
either turn it on or delete it — an unmeasured off-by-default feature with config, tests,
and a fallback path is pure cost. Delete the legacy non-evidence Ask path
(`ASK_EVIDENCE_CONTRACT=false`); it is the only route by which unverified model prose still
reaches the browser, and it serves a compatibility need that does not exist in a
single-user app. Keep the relevance floor in shadow mode — that one has a recorded reason.
*Why it matters:* this is the only item here that makes the codebase smaller, and for a
solo non-professional maintainer that is worth real money.

**N7 — Stop the four record pages downloading the whole library.**
*Problem it solves:* Documents, Symptoms, Procedures, and Notes each fetch every record
with no limit; Notes fetches four full collections at once. Against the real 1,443-document
library this is slow on a laptop and worse on a phone in a driveway. The slim-DTO work cut
the payload roughly twelvefold, and Ask AI's document card already pages server-side — this
is finishing that job on the pages it skipped.
*Why it matters:* it is the difference between the app being pleasant and being tolerated,
and it is felt most on the device you actually use while working.
*Also set budgets* for payload size, response time, and import throughput, so the next
regression is caught rather than absorbed.

**N8 — Document-health report.**
*Problem it solves:* there is no way to answer "why didn't Ask find that?" Flag documents
and pages that are low-text, OCR'd, missing embeddings, failed to parse, look like a table,
or contain overprinted duplicate text. Present it as a maintenance view listing only what
needs attention.
*Why it matters:* it makes the corpus auditable, and it is the prerequisite for judging any
future extraction change. Include the already-measured overprinting artifact — 366 of
19,636 chunks across 75 documents contain a three-times-repeated phrase — as a display-only
warning on the affected quotes. No re-extraction, no re-embedding.

### 3–6 months: make it usable at the car, and tune what the evals can now measure

**M1 — Mobile repair mode. Priority: High. Maintenance: slight increase.**
Not a native app. The existing installable web app plus a hands-busy mode: large text, one
checklist step at a time, previous/next controls, quick photo and note capture, the safety
warning, a button to the source page, and simple completion controls. Screen wake-lock is
worth including — a screen that sleeps mid-job is the most annoying thing about using a
phone under a car.

**M2 — Retrieval tuning, one measured change at a time. Priority: Medium. Maintenance: neutral.**
Only now, with N1 done. Test in this order and keep a change only if the real evals improve:
exact-phrase and field weighting, fusion weight tuning, chunk structure, neighbour
expansion, and reranking. Record every result — including the ones that made things worse.

*Result diversity — done, August 2026, ahead of the rest of M2.* This one piece was pulled
forward because it does not need the answer evals to judge: it is measurable with a counter
rather than a quality judgment, and it fixes a defect N0 created visibility into rather than
a tuning preference. **Note the numbering:** this work is sometimes referred to as "N1", but
N1 in this document is the answer-eval set, which is untouched and still outstanding.

*What caused it:* two independent redundancies, not one. Several pages of a single document
can rank alike when a wiring-diagram title repeats on every sheet; and separately, 310 of
1,443 documents sit in 130 groups whose extracted text is byte-identical (the largest group
holds 19 documents). The duplicates were the load-bearing half — on the reported "interior
light wiring" query all 8 slots already held 8 *different* document ids, so a per-document
cap alone would not have moved a single slot. Import-time MD5 dedup cannot see these: the
PDFs differ byte for byte, which is why they were imported in the first place.
*What was built:* one deterministic post-ranking selection step (`retrievalDiversity.js`,
`RETRIEVAL_MAX_CHUNKS_PER_SOURCE`, default 3, `0` disables). It returns identical evidence
once, caps how many chunks one *logical source* may contribute, and backfills any slot the
cap frees. A logical source is a content group derived from `documents.extracted_text` — an
existing column, so no migration, no new table, and no fuzzy similarity. It runs after
fusion and after any reranking, so it only ever selects; it never reorders, and the
top-ranked chunk is provably always kept.
*Measured on the real 1,443-document corpus, 12 queries, 8 slots each, on both retrieval
paths:* distinct passages returned rose on 8 of 12 queries (keyword/fusion) and 9 of 12
(hybrid, with real embeddings) and fell on none. After the change every one of those queries
returns 8 distinct passages in its 8 slots. The top result was preserved on all 24 runs and
no query came back with fewer slots filled. `eval:retrieval` is unchanged at 12/12.
Distinct-*source* count can legitimately fall — it did, on both paths — when several
documents were each contributing the same paragraph; distinct *evidence* is the number that
must not regress, and did not. Full tables in
[`docs/evals/ask-rag-iteration-log.md`](evals/ask-rag-iteration-log.md).
*The one result that must not be overstated:* on the **hybrid** path the originally-reported
"interior light wiring" query is **unchanged** — 4 sources before and after. Inspecting the
rows shows why: they are four different documents, and the two diagrams contribute exactly
three sheets each, which is *at* the cap rather than over it, and is three different pages of
the correct diagram rather than repetition. Distinct evidence there was already 8 of 8. The
same query on the keyword path was a genuinely different failure (8 documents, 4 duplicate
groups, only 4 distinct texts) and is fixed, 4 → 8. Lowering the cap to 2 would take the
hybrid case to 6 sources, at the price of the third sheet of each diagram; whether that helps
an answer is not answerable with a counter, and is exactly what **N1**'s verified answer evals
are for. The default stays at 3 and both settings are pinned by tests.
*What is deliberately still open:* near-duplicate (as opposed to byte-identical) documents
are not detected and are not planned — three of the brake-bleeding documents are near-copies
that this safeguard correctly leaves alone. The cap is a fixed 3 rather than a value derived
from the answer evals, which is the right ordering: tuning it is an N1-then-M2 question. The
remaining M2 items above are untouched.

**M3 — Corpus re-processing path. Priority: Medium. Maintenance: slight increase.**
*Problem it solves:* M2 proposes changing chunk structure, and N8 will identify documents
worth re-extracting, but there is no supported way to rebuild chunks and embeddings in bulk
with progress and resume. This was on the V1 roadmap, was dropped between roadmap versions,
and is a prerequisite for two items above rather than a nice-to-have.

**M4 — Incremental typecheck strictness. Priority: Low. Maintenance: reduces.**
Carried forward from the V1 roadmap. Chip away at `strictNullChecks` file by file. Not a
project — a thing to do when a file is being touched anyway. Do not flip full `strict` on
wholesale.

### 6–12 months: diagnostics, but only if the records earn it

**L1 — Trouble-code capture, smallest version first. Priority: Medium. Maintenance: slight increase.**
Start with a searchable trouble-code field on a symptom or repair record, and make codes
findable against the document library. That is a field and a search path. Only if that
proves genuinely useful, consider a fuller diagnostic record with freeze-frame values and
selected live data — manual entry or paste first. A live scanner adapter is not on this
roadmap.

**L2 — Expand image assistance carefully. Priority: Medium. Maintenance: slight increase.**
Ask AI can already include one saved photo. Widen it toward identifying a visible part,
reading a label or part number, or describing where a leak is — as observation that helps
you search. Specifications and safety-critical conclusions must keep coming from verified
document evidence. Never present a conclusion drawn from a photo as authoritative.

### Later — not planned, each with the condition that would change that

These are deliberately not scheduled. Each has a trigger; until the trigger fires, doing
the work is speculation.

| Item | Trigger that would put it on the roadmap |
| --- | --- |
| Local speech-to-text | Mobile repair mode ships, gets used, and typing is measurably the bottleneck |
| A local or offline answer model | Cloud access, cost, or privacy becomes an actual problem *and* a local model passes the same eval and refusal gates |
| Multi-vehicle support | A second vehicle actually exists and needs to be in the app |
| Live diagnostic adapter integration | Manual trouble-code records prove valuable first |
| A vector database | Measured retrieval latency or corpus growth exceeds a written budget |
| OpenAI Agents SDK or LangGraph | The planner grows many tools, resumable runs, or multiple human approvals |

## 5. Deliberately avoided

Not "later" — chosen against, because they would make this a different and worse product.

- **Cloud sync and user accounts.** Changes identity, authorization, encryption, backups,
  conflict resolution, hosting cost, and privacy all at once, in exchange for nothing a
  single owner on one machine needs.
- **Multi-user or collaboration features.** A different product category.
- **Shop management** — customers, estimates, invoices, payments, scheduling, CRM.
- **General-purpose chat.** It removes the source-grounding constraint that makes the
  answers worth trusting.
- **Blending web search results into the document evidence pipeline.** Owner documents and
  web claims have different provenance and must not be mixed invisibly.
- **A native mobile app**, until the web app hits a limitation that actually blocks a job.
- **Public exposure of the app on the internet.** There is no login. Loopback by default
  stays; `NETWORK_MODE` on a trusted network is the opt-in, and that is the end of it.
- **Adding a model where ordinary code works.** The deterministic pieces — the planner's
  tools, the verifier, the safety classifier, the keyword search — are deterministic on
  purpose.

## 6. Decisions needed from the owner

These block or reshape items above and cannot be answered from the repository.

1. ~~**Where does mileage live?**~~ **Answered by N3.1 and shipped:** one reading per
   repair record, and **no** `vehicles.current_odometer`. A reading is a historical fact; a
   "current" odometer is a derived maximum, and storing both would create two writable
   sources of truth for one number. Left here as the record of the decision, not as an open
   question.
2. **Is a second vehicle ever likely?** If genuinely never, some single-vehicle shortcuts
   can be simplified rather than merely tolerated.
3. **Do you want to plug in an OBD-II reader eventually,** or is typing a trouble code
   fine? This decides whether L1 stays small.
4. **The reranker: measure it, or delete it now?** Measuring costs an eval run with a key.
5. **Is the daily spend ceiling wanted?** The iteration log records that it is disabled by
   choice (`AI_DAILY_CALL_LIMIT=0`). If that is permanent, the risk of a runaway loop
   spending past a ceiling should be accepted in writing, or the ceiling turned back on.
6. **Is the intended Google Cloud deployment still intended?** If not,
   [`docs/gcp-deployment.md`](gcp-deployment.md) should be marked dormant. The V1 roadmap's
   top "next work" item was hardening that path; it is deliberately not carried forward
   here, because local-first and loopback-by-default is now a settled decision rather than
   an interim state.

## 7. Standing rules this project already earned

Not new work — the decision-making habits that produced the current state, written down so
they survive.

- **Measure before adding sophistication.** A PDF reading-order algorithm was built, tested
  against the real corpus, found to corrupt tables, and reverted. A relevance floor was
  built, measured, and left switched off because it provably dropped nothing. Keep doing
  this.
- **A synthetic test that passes proves less than one read-only diff against real
  documents.** That is what caught the reading-order defect.
- **Fail closed.** Half a repair procedure reads exactly like a whole one.
- **Pin model versions.** A floating alias makes a regression indistinguishable from a
  model update.
- **Refusal beats a confident wrong answer** for anything with a number in it.

## 8. Document history

| Document | What it is | Status |
| --- | --- | --- |
| `docs/roadmap.md` (this file) | Current plan, August 2026 → August 2027 | **Current** |
| [`docs/archive/strategy-review-2026-08.pdf`](archive/strategy-review-2026-08.pdf) | August 2026 strategy and architecture review; the source this roadmap was derived from | Historical |
| [`docs/archive/roadmap-v1.md`](archive/roadmap-v1.md) | The V1 baseline and next-work document, maintained from the first commit until August 2026 | Historical |
| [`docs/archive/project-health-report-2026-06-20.docx`](archive/project-health-report-2026-06-20.docx) | 20 June 2026 read-only audit with a prioritized P0–P3 fix list; not a forward plan despite its original filename. Its findings shipped in PRs #60 and #61 | Historical |
