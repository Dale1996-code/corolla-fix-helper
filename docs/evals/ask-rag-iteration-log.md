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
