# Ask/RAG Iteration Log

Date: 2026-07-07

Goal: improve Ask/RAG answer quality while keeping the app local-first, small, and reviewable.

## Inspection Summary

- Ask API route: `server/src/routes/ask.js`
- Answer generation and citation assembly: `server/src/services/aiAnswerService.js`
- Chunk retrieval: `server/src/services/chunkRetrievalService.js`
- Optional reranking: `server/src/services/chunkRerankService.js`
- PDF chunk creation: `server/src/services/documentChunkService.js`
- Ask UI citation display: `client/src/pages/SearchPage.jsx`
- Existing evals: `npm run eval:retrieval`, `npm run eval:rerank`, `npm run eval:answers`

## Baseline

Commands run before changing behavior:

```powershell
git status --short --branch
npm run eval:retrieval
npm run eval:rerank
npm run eval:answers
npm run test:server
npm run typecheck
```

Results:

- `git status --short --branch`: `## main...origin/main` plus untracked `.claude/worktrees/`
- `npm run eval:retrieval`: passed. 12 eval cases, 12 keyword-wrong cases fixed by hybrid retrieval, 0 hybrid-wrong cases.
- `npm run eval:rerank`: passed. OpenAI key was present; 12 both-right, 0 rerank-fixed, 0 rerank-broke, 0 both-wrong.
- `npm run eval:answers`: blocked as a live quality baseline in this environment. The sandbox run failed every case with `fetch failed`; the unsandboxed rerun request was rejected because it would send local document-derived content to OpenAI.
- `npm run test:server`: passed 212/212 backend tests.
- `npm run typecheck`: passed.

## Iteration 1

Weakness found:

- The existing answer prompt was grounded and citation-focused, but it did not explicitly ask for beginner-safe structure or for separating manual-supported facts from general safety reminders.

Focused change:

- Added a failing test in `server/test/aiAnswerService.test.js` that checks the OpenAI prompt includes beginner-safe, document-grounded structure instructions.
- Added three prompt instructions in `server/src/services/aiAnswerService.js`:
  - write for a beginner DIY mechanic
  - separate document-supported facts from general safety reminders
  - label safety reminders as general safety guidance when not stated in the chunks

Verification:

```powershell
cd server
node --test test/aiAnswerService.test.js
npm run eval:retrieval
npm run eval:rerank
npm run test:server
npm run typecheck
```

Result:

- Red: the new test failed before the prompt change because the prompt did not include the beginner-safe instruction.
- Green: after the prompt change, `test/aiAnswerService.test.js` passed 7/7.
- Final verification passed:
  - `npm run eval:retrieval`: 12/12 keyword-wrong cases fixed by hybrid retrieval, 0 hybrid-wrong cases.
  - `npm run eval:rerank`: 12 both-right, 0 rerank-broke.
  - `npm run test:server`: 213/213 backend tests passed.
  - `npm run typecheck`: passed.

## Current Limits

- This log does not claim live OpenAI answer quality improved, because the live answer eval could not be run under the current external-data policy.
- The verified proof is narrower: the generated answer prompt now contains explicit beginner-safe and support-boundary instructions, and existing focused Ask answer tests still pass.

---

## Milestone 1 — grounding-audit containment (2026-07-31)

Branch: `claude/rag-audit-milestone-1`. Commit at `main @ 5172fef`.

Unlike the earlier entries above, `npm run eval:answers` **was** runnable this time: the
real corpus (1443 documents / 19636 chunks) and an API key were both present locally.

### Verified-case gate: 4/4 -> 6/6

Two cases were promoted from `verified: false` after confirming them against the corpus
itself, not merely because they passed a run:

- **`oil-drain-plug-torque-citation-support`** — chunks 14359 (doc 748) and 14369 (doc 749)
  both read `"Torque : 37 Nm (377 kgf-cm, 27 ft-lbf)"` within the 217-char citation snippet
  window, cross-corroborated by chunk 18772 (`Engine Mechanical Torque Specifications`,
  page 3: `"Oil pan drain plug x Oil pan 37 377 27"`). Scanning all 19636 chunk snippets,
  exactly 2 match `citationSupportsAny` and both are genuine drain-plug statements — there
  are **zero** coincidental matches corpus-wide, so this assertion cannot pass on a
  laundered citation.
- **`refuse-turbo-boost-pressure`** — `/boost\s*pressure/i` matches 0 chunks; so does
  `/turbo\w*\s+(boost|pressure)/i` and `wastegate`. All 24 `/turbo/i`, 24 `/supercharg/i`,
  and 12 `/intercooler/i` hits are SAE/Toyota abbreviation-glossary rows, and all 18
  `/boost/i` hits are that glossary or the vacuum **brake booster**. The corpus therefore
  contains plausible distractors but no spec, which makes this a stronger refusal than the
  three fictional ones.

Closing run after `temperature: 0` landed: **6/6 verified cases still pass.**

### Deferred / recorded issues

1. **Deferred eval investigation — procedure-category movement.** Between the pre-change
   baseline and the closing run, the `procedure` category moved 2/6 -> 1/6 and `behavior`
   2/2 -> 1/2. The behavior delta is explained (item 2 below). The procedure delta is
   **not attributed**: only the tail of the closing run's output was captured, so the
   per-case diff cannot be reconstructed. Deliberately **not** re-run, to avoid ~30
   additional model calls purely for attribution. All affected cases are unverified
   templates and do not gate the result. Attribute this on the next full eval run by
   saving complete output to a file first.

2. **429 TPM pacing.** `startup-squeal-belt-triage` failed the closing run with
   `rate_limit_exceeded` — `gpt-4.1` at 30000 tokens/min, 27464 used. Running all 28 cases
   back-to-back exceeds the tier limit; this is an infrastructure artifact, not a
   regression (the case passed both earlier runs). `scripts/evalAnswers.js` needs simple
   pacing (or a retry on 429) before the eval can be trusted end-to-end.

3. **Invalid vision fixture.** `vision-refuses-unsupported-spec` fails in every run with
   OpenAI 400 `"The image data you provided does not represent a valid image"`. The 1x1
   placeholder PNG data URI in `answerQualityCases.js` is not accepted. This is a fixture
   bug, independent of Milestone 1, and the case stays unverified until a real image is
   substituted.

4. **`citations` is NOT a dead parameter — the audit and its review both got this wrong.**
   Milestone 1 planned to delete both `history` and `citations` from the
   `generateAnswerText` call in `aiAnswerService.js`, on the grounds that
   `generateAnswerTextFromOpenAi` destructures neither. That is true of the *default
   implementation* but false of the *seam*: four injected test doubles read `citations`
   (`test/app.test.js` x3, `test/pdfOcr.test.js` x1). Removing it broke those tests, which
   under the milestone's additive-only rule is the signal to stop and re-justify rather
   than edit them. Resolution: `history` deleted (genuinely zero readers anywhere),
   `citations` retained as part of the dependency-injection contract. Pinned by a test
   asserting exactly that split. **Lesson: check the injection seam's consumers, not just
   the default implementation, before calling a parameter dead.**

5. **`shock` produced no safety flag.** Not in the audit, the review, or the plan. Found by
   a new invariant test asserting every `SAFETY_CRITICAL_KEYWORDS` entry yields at least
   one warning: a shock-absorber task blocked "Ready" while showing the owner no reason
   why — the same latent class as the documented airbag gap. Fixed.

### Milestone 1, round 2 — independent review response

Three blocking findings, fixed on the same branch as a second commit.

1. **`retrievedContext` never reached the client.** `routes/ask.js` rebuilds the
   response from an explicit allowlist and dropped the field, so the service
   produced it and the route discarded it. The client test that "proved" the
   feature used a hand-built payload the server could not actually emit — a real
   gap in how that change was verified. Fixed additively (allowlist kept, field
   attached only on `not_found` with a non-empty array) and now covered by route
   tests that run the **real** `askQuestionUsingDocuments` behind the route, plus
   a test pinning the exact response key set against a future "spread the
   service result" refactor. Documented in `docs/api.md`.

2. **The payload parser was fail-open.** It accepted any payload with text,
   inferring success from content rather than from status. Rewritten to succeed
   only on `status: "completed"` **with** at least one well-formed non-empty
   `output_text` string, and to classify `in_progress` / `queued` / `cancelled` /
   `failed` / `incomplete` (with defensive truncation-reason variants), refusals,
   malformed text, and empty output. Object- and array-valued text are rejected
   rather than coerced — `String({})` would have rendered `"[object Object]"` as
   an answer. Failures now carry a SAFE `message` (never provider text) separate
   from an internal, length-capped `diagnostic`; nothing is logged. Legacy test
   doubles gained `status: "completed"` rather than the parser being relaxed.
   Notably this also closes a quieter hole: an empty or malformed reply used to
   become `""`, which `isNotFoundAnswer()` turned into an ordinary `not_found` —
   an infrastructure failure presented to the owner as an honest "not in
   documents".

3. **Safety warnings and readiness blocking were still two systems.** Round 1
   moved them into one module but kept a keyword list and a separate rule table.
   Now a single `SAFETY_RULES` table drives both, so "blocked with no warning"
   and "warned but not blocking" are structurally impossible. Patterns are
   word-bounded and context-specific instead of substring matches, which fixed a
   pre-existing false positive: the bare substring `abs` matched "shock
   ABSorber", so replacing a shock absorber raised a **brake-bleeding** warning.
   Phrase-matrix tests cover false negatives and false positives together.

   **Documented policy:** ordinary suspension work (including shock-absorber
   replacement) IS treated as safety-critical, because a mis-torqued suspension
   joint fails at speed. It receives a suspension-specific warning; the
   electrical-shock warning is now reachable only from genuinely electrical text.

**Eval scoring — cross-citation laundering.** `citationDocLike` and
`citationSupportsAny` were evaluated independently across all citations, so with
eight chunks all becoming citations, one citation could supply the document match
and an unrelated one the number. When a case constrains both, a single citation
must now satisfy them together. Pinned by a regression test that passes under the
old logic and fails under the new one.

**Deterministic preflight.** The live gate needs the real corpus and an API key.
`answerQualityScoring.test.js` now scores both verified cases against fixed
citation fixtures with no database and no network, including the turbo case's
known distractor classes (SAE glossary rows, and the vacuum brake booster), so
those cannot quietly come to satisfy a boost-pressure request. The live-corpus
evidence stays recorded on the cases themselves; the unit suite does not depend
on the mutable local corpus.

### Corrections to the round 1 report

- **"No existing test was edited" was inaccurate.** `test/answerQualityCases.test.js`
  is a pre-existing file and its `VERIFIED_IDS` expectation was extended from four
  entries to six. No existing *assertion* was weakened or removed, and no test was
  changed to accommodate a code change — but the claim as written was too strong.
  Round 2 also legitimately changed test doubles: `status: "completed"` was added
  to two OpenAI mocks, and one round-1 test that asserted a status-less payload is
  "treated as complete" was replaced, because the fail-closed contract inverts it.
- **"43 new tests" was a hand count and should not be treated as precise.**
  Describe it as new and expanded coverage; the authoritative numbers are the
  suite totals reported by the runners.
- **Several new exports are internal testing seams, not stable public APIs.**
  `readOpenAiUsage`, `parseOpenAiRefusal`, `describeOpenAiFailure`,
  `matchedSafetyRuleIds`, `SAFETY_RULES`, and `MINIMUM_SEMANTIC_SCORE` exist for
  cross-module reuse and invariant testing. The stable surfaces are the HTTP API
  and `parseCompleteOpenAiOutputText` / `readOpenAiResponse` /
  `detectSafetyFlags` / `isSafetyCriticalTask`.

### Milestone 1, round 3 — second review response

**Safety classification unified across the real planner flow.** Round 2 unified the
rule table, but `extractRepairTasks`, `checkRepairReadiness`, and
`buildOwnerChecklist` still reached their own conclusions: flags were computed
from the full fragment while criticality was re-derived from the truncated title
plus the system name. `classifyRepairTask` is now the single entry point, and its
result supplies the system, the critical verdict, the warnings, and the blocking
reason together. `detectSystem` became a bounded-regex fallback used only when no
hazard rule claims the task, so a hazard rule's system is authoritative
("diagnose engine overheating" is Cooling, not Engine). Checklist rows now carry
`safetyFlags` and `safetyReason`, and the Repair Planner page renders them, so
"Shop Recommended" can never appear without the hazard that justifies it.
The readiness gap names the hazards actually detected instead of a fixed example
list. End-to-end tests run all ten review phrases through extraction → readiness
→ checklist and assert system, flags, readiness, and checklist text together.

**Provider HTTP bodies redacted.** `createRedactedOpenAiHttpError` gives the
client a fixed generic message and keeps the body only as a bounded internal
diagnostic the route never reads. Applied to all five non-2xx sites, not just the
two named in the review — `chunkEmbeddingService` is on the Ask retrieval path
and its throw propagates uncaught to `ask.js`, so it leaked identically, and its
prompt is the question plus chunk text. Question-rewrite failures now fall back
to the user's own question on HTTP errors too, matching the parse-failure path;
answer-generation failures still surface as a 500 so they stay distinguishable
from an honest `not_found`.

**Nested output messages validated.** A top-level `completed` no longer licenses
rendering text from an output message whose own status is `incomplete`,
`cancelled`, or anything else non-completed. Nested validation now runs *before*
the flattened field is read, so a nonblank `output_text` cannot paper over bad
nested output, and the two representations must agree (whitespace-insensitive) or
the response fails closed as `flattened_nested_mismatch`.

**Hardening.** `retrievedContext` is de-duplicated by chunk id (falling back to
document+page+index), capped at the configured chunk limit, and safe against
malformed rows. Non-object rows are dropped immediately after retrieval, because
the relevance gate dereferences `chunks[0]` and a null row surfaced as a 500
rather than an honest not-found. `buildCitationsFromChunks` now filters rows with
no document identity and no text, which turns the previously unreachable
empty-citations guard into a real contract with a test.

#### Re-verifying `refuse-turbo-boost-pressure` after corpus drift

A verified must-refuse case is only valid while the corpus still lacks the fact,
and the corpus is mutable. `npm run eval:answers` now runs
`src/evals/negativeCorpusPreconditions.js` against the live database before
scoring. If it finds a turbo/boost term next to a real pressure figure, a
`boost pressure` phrase, or a wastegate reference, it prints the matching
documents and pages and **fails the run even when every case passed** — a stale
refusal expectation that stays green is worse than a red one, because nobody
looks at it again.

The known distractors (SAE/Toyota abbreviation glossary rows, and the vacuum
brake booster) are deliberately excluded so the check does not cry wolf; that
exclusion is pinned by unit tests against a fake database, which keeps the normal
suite independent of the corpus.

When it fires:

1. Open each reported document and page and decide whether it is genuine
   forced-induction evidence or a new distractor class.
2. If it is a **distractor**, add it to the exclusions in
   `negativeCorpusPreconditions.js` with a test, and record why here.
3. If it is **genuine** (e.g. a turbocharged-engine manual was imported), the
   case's premise is dead. Set `verified: false`, remove it from `VERIFIED_IDS`
   in `test/answerQualityCases.test.js`, and either retire the case or rewrite it
   against a fact the corpus still lacks — then re-verify from the corpus the way
   the round-1 entry above describes.
4. Never re-green the case by loosening the check.

---

## Milestone 2 — evidence contract (ASK_EVIDENCE_CONTRACT)

One vertical slice behind one flag, following the `rerankEnabled` pattern
(`config.askEvidenceContract` plus default-parameter injection), so tests and
evals toggle it without env vars. **Flag off is byte-identical**, pinned by a
test that also fails if the evidence path runs at all.

`server/src/services/askEvidenceContract.js` (leaf module, no dependencies):

- **Structured output** via `text.format` json_schema, with prompt-local source
  ids (`S1`..`Sn`). Never database row ids -- re-extraction recreates chunk ids,
  so a row id in a model reply is meaningless the moment a document is
  re-extracted.
- **Atomic claims with a verbatim `evidenceQuote`**, verified server-side as a
  real substring of the mapped chunk (whitespace/case-insensitive because PDF
  extraction spacing is erratic, but no paraphrase passes). A chunk id proves
  retrieval; a quote proves support.
- **Hand-written validator** (~60 lines). No runtime schema dependency, per the
  repo's documented no-heavy-dependencies convention.
- **Numeric anomaly detector**, named honestly: presence-matching cannot prove a
  number belongs to the right fastener, only that it is absent from the cited
  text. Scoped to unit-bearing specifications, so step numbers, fastener counts,
  page references, and ordinals pass untouched -- a blanket digit ban would
  mangle ordinary procedure prose.
- **Unit-family conversion.** A torque table prints "37 (377, 27)", so a claim
  stating the ft-lbf figure is grounded by a chunk stating the N·m figure.
  Conversion is within a family only: applying every factor to every number
  falsely grounded an invented 54 N·m, because 377 kgf-cm times the kPa->psi
  factor is 54.7. Caught by a test during implementation.
- **Server-derived status** (`answered` / `partial` / `not_found`), never taken
  from a model-supplied field that could contradict its own claims.
- **Citations are earned.** Only chunks that actually backed a verified claim are
  cited, which fixes "every retrieved chunk becomes a citation" (audit F1).

**Gap text never reprints the failing value.** An early implementation echoed the
rejected number into the gap ("Removed unsourced specification (30 Nm)"), which
put the ungrounded value back on screen under a different heading -- exactly what
failing closed is supposed to prevent. Values are redacted to
`[unverified value]` in anything the owner reads, and retained server-side in
`rejected` for diagnosis.

Client: `SearchPage` renders three visually distinct blocks (document-supported
with the quote shown, general guidance explicitly labeled as not from the
documents, and gaps) instead of one `whitespace-pre-line` blob. The legacy prose
path is still selected when no `evidence` field is present.

Decision kept from the plan: the labeled general-guidance channel stays, rather
than being deleted. Deleting it would not stop the model producing general
knowledge -- it would only remove the label, making the output less honest. The
numeric rule is what makes the channel safe.

---

## Milestone 3 — relevance floor: calibrated, and deliberately NOT activated

The audit proposed dropping every retrieved chunk below `MINIMUM_SEMANTIC_SCORE`
as a same-day, "near-zero-risk" fix. Milestone 3 built the floor and the harness
to justify it. The harness says: **do not turn it on.**

### Why a new eval was needed

`npm run eval:retrieval` structurally cannot observe this filter. It imports only
the retrieval layer, while the filter sits above it in `askQuestionUsingDocuments`
-- a green retrieval eval would have proved nothing about the floor. So
`npm run eval:relevance-floor` runs the REAL Ask pipeline against the REAL corpus
with a stub answer generator: retrieval and scoring are genuine, no answer-model
tokens are spent, and the whole sweep costs only the query embeddings.

### Measured result (26 text cases, 208 chunks reaching the answer stage)

```
with body-text keyword hit: 208  (exempt from the floor)
semantic-only:                0
no semantic score:            0
semantic score min/p25/median/p75/max: 0.281 / 0.488 / 0.524 / 0.567 / 0.719
```

Threshold sweep from 0 to 0.5: **0 chunks dropped at every threshold**, positive
or negative.

The floor is inert here for two independent reasons:

1. Every chunk that reaches the answer stage has a real body-text keyword hit, so
   nothing is judged on semantics alone.
2. Even ignoring that, the **minimum observed semantic score is 0.281**, already
   above the proposed 0.2 threshold. A 0.2 floor could not have dropped anything
   regardless.

This turns §5's "possibly near-inert" concern into a measurement. Shipping the
floor as an immediate fix would have added a filter, a config flag, and a code
path that provably do nothing on this corpus -- while carrying the risk that a
future corpus change silently starts dropping evidence.

**Decision: `ASK_RELEVANCE_FLOOR` stays off.** The floor ships in SHADOW MODE --
it computes what it would drop and reports that through the existing log-safe
Ask metrics (`metrics.relevanceFloor`, numeric references and scores only, no
document text) so the picture can be re-checked cheaply after any corpus change.

### Contract change made during calibration

The first implementation exempted any chunk with `keywordScore > 0`. That made
the floor inert by construction, because `scoreChunkForTerms` awards +2 for a
title hit, +1 filename, +1 system -- so `keywordScore > 0` can mean nothing more
than "this document is named after your question" while the chunk body matched no
term at all. That is precisely the laundering vector the audit flagged.

The exemption now keys on `chunkMatchedTerms > 0` (real body-text hits). One
Milestone 3 test was updated to match; the new behavior is pinned by a test
showing a title-only match is now droppable while a body match is not. The sweep
was re-run after the change and the result was unchanged, which is what
established finding (1) above rather than assuming it.

### Safety properties pinned by test

- Shadow mode changes nothing.
- A chunk with no semantic score is never dropped (protects unembedded and
  stale-embedding-version chunks, so a newly uploaded PDF cannot vanish from Ask).
- The floor never empties the context: dropping everything would turn a weak but
  real answer into a not_found with no evidence to show.
- The shadow report contains no document text, titles, or filenames.

---

## Milestone 4 — PDF reading-order experiment REJECTED; atomic rebuild verified

**Status: the proposed column-aware reordering was implemented, tested against
the real corpus, and reverted. No extraction behavior changed.** The
independently valuable half of this milestone -- proving the chunk rebuild is
atomic -- was kept.

### What was proposed

Audit F3 observed that `pdfService` builds page text with
`items.map(str).join(" ")`, discarding every `transform` coordinate, and argued
this destroys reading order on two-column pages. The proposed fix segmented
columns first, then ordered by y within each column.

It was built (`services/pdfTextLayout.js`), and it passed twelve synthetic tests
including the "column 1 fully precedes column 2" property.

### Why it was rejected

Before re-extracting anything, a READ-ONLY dry run compared the new extractor
against the stored chunks for a real document (1323, "Terminal and Connector
Repair", 48 pages). The result killed the change:

**The reordering corrupted tables.** Page 1 is a four-column parts table whose
cells wrap to two lines. Real geometry:

```
x=140 y=473  "09991-00500"          Part number, line 1
x=140 y=456  "09991-00510"          Part number, line 2
x=229 y=464  "SST"                  Part name, centred between the two
x=376 y=473  "To remove the 0.64"   Notes, line 1
x=376 y=456  "connector terminal"   Notes, line 2
```

- Currently stored (native pdf.js order):
  `09991-00500 09991-00510 SST To remove the 0.64 connector terminal` -- correct,
  cell by cell.
- Produced by the new code:
  `09991-00500 To remove the 0.64 SST 09991-00510 connector terminal` -- a part
  number silently associated with the wrong description.

The y-band line grouping merges y=473/464/456 into one visual row and reads
straight across multi-line cells. The interleaving the module existed to prevent
was simply moved from columns to table cells.

Three further facts made the change indefensible:

1. **The premise was wrong for this corpus.** These are ALLDATA exports, and
   pdf.js already emits their items in reading order. The naive join was
   correct; there was no disorder to fix.
2. **The blast radius was inverted.** 47 of 48 pages changed, while only 5 were
   multi-column at all -- rewriting 96% of pages to address 10%.
3. **The benefit was unproven even where it applied.** The diff on the
   multi-column pages was not clearly better either.

The synthetic tests missed all of this because they used clean two-column prose
with single-line cells. No fixture had a wrapped table cell with a
vertically-centred neighbour.

### What was kept

- `test/pdfReadingOrder.test.js` -- a regression guard built from the real
  geometry above, exercising production `extractPdfData` against a synthesized
  PDF with positioned text runs. It pins the native cell-wise order and asserts
  the exact interleaved string can never reappear.
- `test/documentChunkAtomicRebuild.test.js` -- see below.

`pdfService.js` is byte-identical to `main`. `pdfTextLayout.js` and its tests are
deleted. **No replacement heuristic, feature flag, or partial gutter detector was
substituted**: without evidence that reordering helps this corpus, any variant
would be speculation carrying the same class of risk.

No document was re-extracted, so no stored chunk was ever affected. The
experiment cost nothing but the time to disprove it.

### F12 / atomic swap: the plan's concern was already obsolete

The plan flagged `rebuildDocumentChunksFromPages` as a data-loss risk -- "hard
DELETEs before rebuilding, so a partial failure leaves a document unusable". That
is **not true**: the DELETE and the INSERTs already run inside one
`BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK` transaction, and the chunks are built
before the transaction opens, so a build failure never reaches the DELETE.

Rather than rewrite working code for a stale finding, the property is pinned by
tests: a mid-insert failure (two pages with the same number colliding on
`UNIQUE(document_id, page_number, chunk_index)`, which fails *after* the DELETE)
rolls back and leaves the original chunks byte-identical, and a rebuild never
touches another document.

### Lesson

Synthetic fixtures validated the algorithm against the shape I imagined. The
real corpus falsified it in one dry run. For anything that rewrites stored
document text, a read-only before/after diff against real data belongs *before*
the implementation is considered done -- not after it ships.


## Milestone 5 — evals, applicability, spend durability

### Pinned model snapshot

The answer model defaulted to the floating `gpt-4.1` alias. An alias changes
behavior underneath the eval suite, so a green run proves nothing about the next
one and a real regression cannot be told apart from a model update. The default
is now the `gpt-4.1-2025-04-14` snapshot; `OPENAI_ANSWER_MODEL` still overrides
it, so moving forward is a deliberate act. Verified against the live API before
committing (both the alias and the snapshot return 200 for this account).

### Hazard tiers: resolving the audit's internal contradiction

F9 said warnings must be purely additive and never alter the answer. Section 8.G
said dangerous requests must be "refusal-or-redirect... never a procedure". Both
cannot hold. The rule adopted, applied to the REQUEST rather than the topic:

| Tier | Example | Behavior |
| --- | --- | --- |
| T1 routine | cabin filter | answer normally |
| T2 hazardous but documented | brake pads | answer, plus the document's own safety text |
| T3 specialist | airbag control module | answer as preparation only, with a shop referral |
| T4 defeat / unsafe | permanently disable the airbag | refuse the procedure |

Only T4 refuses. Brake and airbag work are exactly what this app exists to help
with, so "dangerous topic" alone must never trigger a refusal -- an owner who is
going to do the job anyway is safer with the manual's warnings than without them.
T4 also refuses on grounding, not just policy: the manual does not document how
to defeat a restraint system, so there is nothing to cite.

Four new template cases cover the tiers. Both T4 cases (disable airbag, bypass
brake fluid warning) PASS on the live corpus.

### Applicability (F19), rated higher than "Low"

One uploaded FSM legitimately carries different values for the same fastener
across 2ZR-FE/2AZ-FE, ABS/non-ABS, and US/Canada trim. Single-vehicle scope does
not solve this -- the ambiguity is inside one manual. Two template cases now
check that an answer names the applicability condition it is scoped to rather
than silently picking one variant. Both PASS on the live corpus.

### Daily spend ceiling: NOT persisted (planned item removed by owner decision)

Milestone 5 originally persisted the existing daily model-call ceiling to SQLite
via migration `004_ai_usage_daily`, per the plan's "persist the daily budget in
SQLite (a new numbered migration)".

**That work was removed before merge at the owner's direction.** The owner does
not want an application-level spend cap and disables it with
`AI_DAILY_CALL_LIMIT=0`, so making it durable was overhead with no benefit --
and persistence would have made the ceiling accumulate across eval runs that
restarts previously cleared.

`aiUsageBudget.js` is byte-identical to `main` again: the counter is back in
module memory and resets on restart. The **pre-existing** cap itself is
untouched and still enforced at both call sites; it predates this branch
(commit `5fbf664`) and removing it would be a separate change.

Known consequence, accepted: a crash-restart loop resets the counter and can
spend past the ceiling. With the cap disabled by configuration this is moot; if
it is ever re-enabled and that matters, this section is the record of what was
removed and why.

### Eval pacing: infrastructure failures no longer read as regressions

Adding six cases pushed the suite past the account's 30000 TPM tier, and the
first paced-less run reported **5/6 verified** with two cases failing on
"The AI service rejected the request" -- which looks exactly like a product
regression caused by the model pin. It was not: a direct probe confirmed both the
alias and the pinned snapshot return 200.

`evalAnswers.js` now spaces cases (`EVAL_CASE_DELAY_MS`, default 2000ms), retries
a 429 with backoff, counts rate-limited cases separately, and prints an explicit
warning that those are infrastructure failures rather than product regressions.
It also surfaces the bounded internal `failure.diagnostic` -- the client-facing
message stays generic because provider bodies must never reach a browser, but a
local developer tool that cannot see why it failed is not usable.

Re-run with pacing: **6/6 verified**, and `procedure` went 1/9 -> 4/9 with
`capacity` 6/9 -> 7/9.

**This also explains the deferred "unattributed procedure-category movement" from
Milestone 1.** That movement was almost certainly rate limiting too, not a
product change. Closing that follow-up.

### Deferred: JSONL telemetry

Not implemented, as planned. Per-request JSONL logging needs a rotation and
retention policy first -- these logs would describe which repair documents the
owner consults, and an unbounded append-only file of that on a personal machine
is a privacy liability, not an observability win. The log-safe `metrics` object
(counts, durations, numeric refs, and now the relevance-floor shadow report)
already covers the diagnostic need without persisting anything.

---

## Source-quality limitation: overprinted text in ALLDATA PDFs (non-blocking)

Found during the manual `ASK_EVIDENCE_CONTRACT=true` Ask check. The check passed
overall; this is a **source-data limitation**, not a pipeline defect, and it is
recorded here rather than fixed.

### What was seen

A supported disposal claim rendered this evidence quote:

> "used oil and used oil filters filters filters must be disposed at designated
> must be disposed of at designated must be disposed of at designated disposal
> sites."

### Where the repetition originates

**Stage 1 -- the original PDF's text layer.** The PDF *overprints*: identical
text runs are drawn at identical coordinates. Raw pdf.js items for document 748,
page 1:

```
#42  x= 66 y=460  "For environmental protection, used oil and used oil filters"
#43  x=339 y=460  "filters"
#44  x=339 y=460  "filters"                                    <- same x,y
#45  x=339 y=460  "filters must be disposed of at designated"  <- same x,y
#46  x=373 y=460  "must be disposed of at designated"
#47  x=373 y=460  "must be disposed of at designated"          <- same x,y
#48  x=373 y=460  "must be disposed of at designated"          <- same x,y
#49  x= 66 y=443  "disposal sites."
#50-52 x=66 y=443 "disposal sites." x3                         <- same x,y
```

A human reads one copy because the duplicates are painted on top of each other.
Any extractor reading the content stream sees all four. It is not isolated to
this sentence -- items #70-73 repeat "REMOVE OIL FILTER CAP ASSEMBLY" x4 the same
way. This is characteristic of ALLDATA's HTML-to-PDF export (faux-bold or
layered rendering).

### Stage-by-stage trace

| Stage | Duplicated | Note |
| --- | --- | --- |
| 1. Original PDF page | yes -- **origin** | Overprinted runs at identical coordinates |
| 2. `documents.extracted_text` | yes | Faithful copy |
| 3. Chunk text | yes | Faithful copy |
| 4. Retrieved chunk | yes | Same stored text |
| 5. Structured evidence | quote only | The model quoted a contiguous substring VERBATIM, as the contract requires |
| 6. Client render | quote only | Displayed the quote as-is |

**Extraction, chunking, retrieval, evidence verification, and rendering all
preserved the source faithfully.** Nothing in the pipeline introduced or
amplified the repetition.

### The claim itself stayed clean

The generated claim was correct and readable -- "The documents say used oil and
used oil filters must be disposed of at designated disposal sites." Only the
evidence *quote* shows the artifact, because a quote must be a verbatim
substring of the chunk to pass verification. That is the contract working as
designed. No specification value was affected.

### Identifiers

- Document **748** -- *Oil and Oil Filter Replacement [12 2007] (Engine Oil) ALLDATA diy*
- Page **1**, chunk id **14358**, chunk_index **2**
- Clean visible wording: *"For environmental protection, used oil and used oil
  filters must be disposed of at designated disposal sites."*
- Document **749** (the Oil Filter variant) carries the identical artifact at
  chunk **14368**

### Scope

**366 of 19636 chunks (1.9%) across 75 of 1443 documents** contain a
three-times-repeated phrase. Worst affected: doc 777 (95 chunks), doc 740 (47),
doc 632 (35), doc 750 (15), doc 739 (14).

### Targeted re-extraction would NOT fix this

Worth stating explicitly, because it is the intuitive first suggestion: the same
PDF through the same extractor produces the same overprinted runs. Re-extraction
changes nothing here, and it would cost a re-embed of the affected documents for
no benefit.

### Future work (low priority, deliberately not done in this branch)

1. **Evidence-quote quality warning** -- flag a quote containing a
   three-times-repeated phrase so the UI can label it "this source page contains
   overprinted text". Display-only: no corpus change, no extraction change, no
   re-embedding.
2. **Coordinate-aware extraction deduplication** -- drop identical text runs at
   identical coordinates during extraction. This is the only option that cleans
   stored data, but it changes extraction and requires re-extracting and
   re-embedding the 75 affected documents. Honest caveat measured on this
   sample: it would collapse #44, #47/48, and #50-52, but not #43 versus #45,
   which is a prefix rather than an exact duplicate -- so it reduces the artifact
   rather than eliminating it.

Neither is implemented. The corpus, extraction pipeline, evidence contract, and
UI are unchanged.
