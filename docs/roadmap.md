# Roadmap — Corolla Fix Helper

> **This is the current roadmap.** It is the only forward plan for this project.
> Anything else that looks like a roadmap lives in [`docs/archive/`](archive/) and is history, not a plan.
>
> - **Covers:** August 2026 → August 2027
> - **Last reviewed:** 16 August 2026
> - **Supersedes:** [`docs/archive/roadmap-v1.md`](archive/roadmap-v1.md) and the strategy review in [`docs/archive/strategy-review-2026-08.pdf`](archive/strategy-review-2026-08.pdf)
>
> **16 August 2026 correction.** An audit checked this document's claims against the
> code and the live database. Most held exactly. Two did not, and both were
> understatements of how weak the foundations are — the eval set is smaller than
> claimed (8 gating cases, not 13) and 128 documents are silently unreadable by Ask.
> Section 2 and items **N1** and **N8** are rewritten below with measured numbers.

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

**Genuinely weak, and the reason for the ordering in section 4:**

- **The answer-quality eval set barely exists.** Not "too small" — measured on
  16 August 2026, **8 of 35 cases are verified** and gate the build; the other 27 are
  unconfirmed templates that report but never fail. Worse than the count: of those 8,
  four are refusals of nonsense (`refuse-flux-capacitor`, `refuse-boeing-tire`,
  `refuse-warp-core`, `refuse-turbo-boost-pressure`), two are verifier-rejection probes
  with a stubbed model, and the remaining two — `oil-drain-plug-torque` and
  `oil-drain-plug-torque-citation-support` — check **the same single fact**.
  So the gating suite proves the app refuses nonsense and rejects a forged citation, and
  verifies exactly **one** real specification from the manuals. Almost every remaining
  idea in this roadmap is a change whose value can only be judged by that suite, and
  right now that suite can detect a regression in one torque figure.
- **128 documents are phantom inventory — Ask AI cannot read them at all.** Measured
  against the live database on 16 August 2026: **128 of 1,443 documents (8.9%) have zero
  chunks.** They are listed on the Documents page, they are counted in the library total,
  they can be linked to a symptom — and they can never appear in an answer, because
  retrieval only ever sees chunks. 137 documents carry the status `no_text_found`
  (image-only scans, contributing 17 chunks between them), one failed to parse, one was
  never attempted. The library reports 1,443 documents; roughly one in eleven of them is
  a document the app cannot read a single word of, and nothing in the UI says so. This
  was previously folded into N8 as a reporting gap. It is not a reporting gap — it is a
  correctness bug with a reporting symptom, and it is now item **N0**.

- **Four pages still download the whole document library.** Documents, Symptoms,
  Procedures, and Notes each fetch every record with no limit. Ask AI's document card was
  fixed; these were not.
- **The repair record stops at the plan.** A saved checklist has no link back to the plan,
  the symptom, or the documents that produced it, and there is nowhere to record mileage,
  parts, cost, or the result. The app answers "how do I fix this?" and then forgets that
  you did.
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
| **N0** | **Make the 128 unreadable documents readable (or visibly broken)** | **Blocker** | Slight increase |
| **N1** | **Grow the verified answer-eval set** | **Emergency** | Slight increase (test data only) |
| N2 | Repair the eval suite's own defects | High | Reduces |
| N3 | Repair history and maintenance records | Critical | Increase (one migration, one page) |
| N4 | Close the two named evidence gaps | High | Slight increase |
| N5 | Applicability: say which variant a spec belongs to | High | Slight increase |
| N6 | Retire dormant flags and the legacy Ask path | Medium | **Reduces** |
| N7 | Stop the four pages downloading the whole library | High | Slight increase |
| N8 | Document-health report | High | Slight increase |

**N0 — Make the 128 unreadable documents readable, or make them visibly broken. Priority: Blocker.**
*Problem it solves:* 128 of 1,443 documents (8.9%) have zero chunks and cannot appear in
any answer, while the app presents them as ordinary library members. This is the worst
failure shape the app has: not a wrong answer, but a **silently incomplete** one. Ask says
"the documents do not cover that" while holding a document that does cover it, in a picture
the app never converted to text. The owner cannot tell that apart from a genuine gap.
*Diagnosis, already done — do not re-derive it:*

- Poppler is installed and working (`pdftoppm` 25.07.0). **Tesseract is not installed at
  all** — running the current extractor over `Alarm_Module-8618784e.pdf` fails with
  `spawn tesseract ENOENT`, and it only reaches Tesseract *because* Poppler succeeded.
- Every affected document predates working OCR. Their stored status is a bare
  `no_text_found`, which `buildExtractionStatus` only returns when **no OCR warning was
  recorded at all** — so OCR never ran on them. If OCR had run and the tools were missing,
  the status would read `ocr_unavailable: …`. Not one document in the corpus carries any
  OCR status: no `completed_with_ocr`, no `ocr_unavailable`, no `ocr_failed`.
- The stored statuses are therefore **stale**, not current truth. The extractor as it
  stands today returns `completed_with_warning: ocr_unavailable: …` for these files.

*The trap, and the reason ordering matters:* these PDFs are not textless. They carry a
tiny title-only text layer — `"Alarm Module"` is 12 characters, `"Ampli fi er"` is 11 —
which is below the 20-character `OCR_MIN_TEXT_CHARACTERS` threshold, so OCR is correctly
attempted. But that title text is enough to make `extractedText` non-empty. **Re-extracting
before Tesseract is installed would flip all 128 from "0 chunks, `no_text_found`" to
"1 title-only chunk, `completed_with_warning`" — a state that looks repaired, pollutes
retrieval with meaningless chunks, and still contains none of the wiring-diagram content.**
Install Tesseract first, prove it on one page, then re-extract. Never the other way round.
*Scope:* 137 candidate documents, 705 pages total — small enough to re-run in one sitting.
*Acceptance:* no document in the library has zero chunks without the UI saying so. A scan
that genuinely cannot be read after OCR is an acceptable outcome; a scan that is silently
absent from retrieval is not.

**N1 — Grow the verified answer-eval set from 8 to about 30 cases. Priority: Emergency.**
*Problem it solves:* right now most quality changes cannot be judged. Every retrieval,
prompt, chunking, and model change below is a coin flip without this.
*The real starting position, stated plainly:* the suite has **8 gating cases, and exactly
one verified fact** — oil drain plug torque, checked twice. Four cases refuse invented
nonsense, two drive a stubbed model through the verifier. Those are worth keeping and they
prove real properties, but none of them reads a number out of your manuals. A retrieval
change that broke every specification lookup except the oil drain plug would pass this
suite clean. That is not a safety net; it is a single tripwire across one doorway.
*Why it is an emergency rather than merely critical:* it is not the highest-value feature
in this document — it is the item without which the value of every other item is unknowable.
N4, N5, N6's reranker decision, and all of M2 are gated on it. Building features on top of
a suite this thin means shipping changes whose effect on answer quality is literally
unmeasured, in an app whose entire premise is trustworthy answers.
*How to do it:* target the failure classes that actually occur on this corpus — the correct
number attached to the wrong component, two manual sections that disagree, table-derived
values, OCR-noisy pages, follow-up questions, and questions the manuals genuinely do not
answer. Convert the 27 existing templates first: each already has a question and a shape,
and needs only a value confirmed against the cited page. Do not chase a case count — stop
when the failure classes are covered.
*Sequencing note:* N0 changes what is retrievable, so cases written against the corpus
before the OCR re-extraction may need re-confirming after it. Do N0 first, or write cases
that avoid the 137 affected documents until it lands.
*Budget the run, not just the writing:* `evalAnswers.js` deliberately paces itself
(`EVAL_CASE_DELAY_MS`, default 2 s per case, plus 429 backoff) because running cases
back-to-back trips the account's tokens-per-minute tier and a 429 reads exactly like a
product regression. That pacing is linear in case count, so growing the suite grows every
future run's wall-clock and spend. It is worth it — but it means "run the evals" stops
being free, which is the practical argument for N2's written rule about *when* they run.

**N2 — Repair the eval suite's own defects. Partly done, 16 August 2026.**
*Problem it solves:* red that means nothing teaches you to ignore red. Two instances of
that were fixed on 16 August 2026:

- The vision case `vision-refuses-unsupported-spec` sent a 1×1 PNG — structurally a valid
  PNG, but not a usable photograph. It now loads a real 512×512 fixture from
  `server/src/evals/fixtures/vision-placeholder.png`, swappable for an actual photo of the
  car by overwriting the file. It stays `verified: false` until it has been observed
  passing against the real model with a key; flip it to `true` then, because it tests a
  safety property — a photo must never become a source for a specification.
- The client test suite had no `testTimeout`, so vitest's 5000 ms default applied to files
  that take 40–70 seconds. It failed 2–9 tests per run with a *different* set each time,
  always a bare timeout and never an assertion, while CI's faster runner stayed green.
  `client/vite.config.js` now sets `testTimeout` and `hookTimeout` to 30000; the suite went
  from 2–9 spurious failures to 337/337 passing.

*Still to do:* write down when evals run. The answer eval costs money and needs the real
corpus, so it cannot live in CI, which means the rule has to be explicit: run it before
merging any retrieval, prompt, chunking, or model change, and record the result in
[`docs/evals/ask-rag-iteration-log.md`](evals/ask-rag-iteration-log.md).

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
*Scope changed 16 August 2026:* the "128 documents Ask cannot read" problem was pulled out
of this item into **N0**, because it is a correctness bug that happens to be invisible, not
a reporting gap. N8 is now the standing instrument, and N0 is the one-time repair. Build N0
first: fixing the documents does not need a dashboard, and a dashboard whose first render
lists 128 broken documents is a worse outcome than one that lists none.
*Problem it solves:* there is no way to answer "why didn't Ask find that?" Flag documents
and pages that are low-text, OCR'd, missing embeddings, failed to parse, look like a table,
or contain overprinted duplicate text. Present it as a maintenance view listing only what
needs attention.
*One hard requirement carried over from N0:* zero chunks must be a first-class, loud state —
it is the condition under which the app confidently tells you it has nothing while holding
a document that does. A stale `extraction_status` is not sufficient evidence of health; N0
established that the stored statuses are historical artifacts of whatever extractor version
ran at import time, and disagree with what the current extractor produces. Derive health
from the chunk and embedding rows, not from the stored status string.
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

1. **Where does mileage live?** An odometer reading on the vehicle record, a reading per
   repair record, or both? This shapes N3's migration.
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
