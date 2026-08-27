# Quality Testing The Chatbot

This is how you check that the Ask chatbot gives **correct, well-cited answers** — and
catch it if a future change quietly makes answers worse. There are three checks: two you
run regularly, and one you run only when tuning a specific setting.

## 1. Retrieval check (cheap)

```powershell
npm run eval:retrieval
```

This proves the search step finds the right passage. It runs on its own temporary data and
needs no API key. Use it to confirm the hybrid (keyword + meaning) search still beats plain
keyword search.

### Reranker A/B (optional)

```powershell
npm run eval:rerank
```

This compares plain hybrid/fusion retrieval against the optional LLM reranker on the same
temporary corpus, and labels each case `both_right`, `rerank_fixed` (fusion wrong, rerank
right), `rerank_broke` (fusion right, rerank wrong), or `both_wrong`. Without an
`OPENAI_API_KEY` the reranker is a safe no-op (every case stays `both_right`), so it is honest
to run with no key — set a key locally to see whether reranking actually helps before turning
`RERANK_ENABLED` on.

## 2. Answer check (the real quality test)

```powershell
npm run eval:answers
```

This asks a list of real repair questions against **your actual embedded documents** and
checks each answer. Run it on the machine where you imported and embedded your PDFs, with
your `OPENAI_API_KEY` set (it costs a few cents per full run). For each question it checks:

- **Answer questions** (torque specs, capacities, procedures): does the answer contain the
  exact expected value, and does it cite the right document?
- **Refusal questions** (things not in your manuals): does it correctly say
  `not in documents` instead of inventing an answer? This is the most important safety check.
- **Follow-up questions**: does a vague follow-up ("what about the torque?") get rewritten to
  include what it refers to before searching?
- **Citation grounding** (optional, `citationSupportsAny`): does at least one cited snippet
  actually contain the asserted value, so a confidently-worded answer cannot pass on a
  citation that does not back it up?

It prints a scorecard and **fails if any verified case fails.** New template cases (including
the broader engine/brakes/cooling/electrical/suspension/transmission/fuel/HVAC coverage and a
Vision Ask refusal guard) stay `verified: false` until you confirm them, so they report but
never gate the run.

### When to run it, and how to record it

`eval:answers` is **not part of CI, and cannot be.** It needs your real embedded corpus,
which exists only on your machine, and every run spends real money at the model provider. CI
runs lint, typecheck, both test suites, the build, and the smoke test — none of which call the
answer model. This eval is a **pre-merge step you run by hand.**

Run it before merging a change to any of these four things:

- **retrieval** — fusion, result diversity, reranking, the relevance floor, chunk selection
- **answer prompting** — the Ask prompt, the evidence contract, how accepted claims are rendered
- **chunking** — how PDFs become `document_chunks`
- **the answer model** — `OPENAI_ANSWER_MODEL`, `OPENAI_VISION_MODEL`, or their sampling settings

Changes elsewhere — UI copy, routes, unrelated services, documentation — do not need a paid run.

Then record the run in [`docs/evals/ask-rag-iteration-log.md`](evals/ask-rag-iteration-log.md),
with enough detail that the next run can be *compared* against it instead of guessed against:

- the **revision** the eval ran at — and separately the revision of the *product* code, when a
  change touched only evals or docs and left retrieval untouched
- the **configuration**: the model pins, `RETRIEVAL_MAX_CHUNKS_PER_SOURCE`, `RERANK_ENABLED`,
  `ASK_RELEVANCE_FLOOR`, `OPENAI_MAX_OUTPUT_TOKENS`
- the **result**: verified passes out of the verified total, plus which templates moved
- anything that was **noise rather than signal** — rate limiting, a bad fixture, output-token
  truncation — named as such, so a later reader does not mistake it for a quality regression

An unrecorded run is worse than no run. It produces a number that a future comparison treats as
a baseline and cannot reproduce.

### What may gate the build, and what may not

- **The runtime verified set is the gating authority.** That is the cases actually carrying
  `verified: true` in `answerQualityCases.js`, pinned by `VERIFIED_IDS` in
  `server/test/answerQualityCases.test.js`. Do not count them with a text search — some matches
  sit inside instructional comments, which is how the count was once overstated by five.
- **A failing template is not a build-gating failure.** Templates run and report so movement is
  visible; they never fail the run. Treating them as red is how a suite becomes noise people
  learn to skip — which is exactly what the permanently-failing vision fixture was doing.
- **Never promote a case to `verified: true` to make a run look better.** A case earns the gate
  only when both hold: its expectation has been **independently confirmed** (against the cited
  PDF page, or by proving absence across the whole corpus for a refusal), and its product
  behavior is **reproducible enough to gate on**.
- A case can satisfy the first and fail the second. That is not a defeat, and demotion is a
  normal outcome: `applicability-engine-mount-build-variant` was promoted on 2026-08-20 and
  demoted on 2026-08-22 — its expectations were never weakened, it simply varied at the product
  level, and a gate that flickers is worse than no gate.

## 3. Relevance-floor calibration (only when tuning `ASK_RELEVANCE_FLOOR`)

```powershell
npm run eval:relevance-floor
```

Ask has an optional filter that throws away weakly-matching passages before they reach the
answer step. It is **off by default and does nothing** — it currently just reports what it
*would* drop. This script is how you decide whether turning it on is safe.

Run it only if you are considering setting `ASK_RELEVANCE_FLOOR=true`. It is not part of the
routine quality loop.

**Why it needs its own script:** `eval:retrieval` cannot see this filter. That check only
exercises the search step, and the filter sits above it, in the Ask pipeline. Any threshold
picked without this harness is a guess.

**What it costs:** it needs `OPENAI_API_KEY` — the passage scores it calibrates come from
embedding your question — but it stubs out the answer model, so you pay only for the query
embeddings, not for generated answers. It does not modify any corpus rows — it only reads
your documents. (Opening the database is not literally inert: it creates the data and uploads
folders if missing and applies the usual PRAGMAs, including WAL sidecar files. Your documents,
chunks, and embeddings are untouched.) With no key set it prints a note and exits cleanly.

It reuses the same text questions from `answerQualityCases.js` (see below), so the more real
questions you have added there, the more trustworthy its verdict. A passage counts as **good
evidence** when it comes from the document the case expects, or contains a value the case
expects. Refusal cases have no good passages by design — everything they retrieve is noise,
which is exactly what a floor should be able to remove.

You get two tables. The first shows what actually reaches the answer stage (shape shown here
with made-up numbers — your run prints its own):

```
--- What reaches the answer stage ---
total chunks:               240
with body-text keyword hit: 180  (exempt from the floor)
semantic-only (floor can act on these): 55
no semantic score:          5
semantic score min/p25/median/p75/max: 0.061 / 0.184 / 0.243 / 0.318 / 0.612
```

This matters because a sweep full of zeros is otherwise ambiguous — it could mean the
threshold is well chosen, or that the filter has almost nothing it is allowed to touch.
Passages matched on keywords are exempt, and passages with no score are never dropped (that
is deliberate: dropping them would make newly-imported documents vanish from Ask before you
have run `npm run embed:backfill`).

The second table sweeps candidate thresholds from 0 to 0.5 (again, illustrative rows — the
real run prints ten):

```
threshold | kept+ | DROPPED+ | kept- | dropped- | noise removed | safe
0.15      |    62 |        0 |    41 |       14 |         25.5% | yes
0.2       |    62 |        0 |    34 |       21 |         38.2% | yes
0.25      |    59 |        3 |    28 |       27 |         49.1% | NO
```

The column that decides everything is **`DROPPED+`** — good evidence that threshold would
have thrown away. A row is `safe` only when that column is zero.

### Read the `0.2` row, and only the `0.2` row

**The threshold is not a setting you can change.** `ASK_RELEVANCE_FLOOR` is an on/off switch,
and when it is on Ask always uses `0.2`. The sweep prints ten thresholds because that is what
makes the shape of your corpus visible, and it names a "recommended" one — but the only row
that describes what you would actually get is **`0.2`**.

So do this, exactly:

1. Find the `0.2` row.
2. **`DROPPED+` is not `0`?** Leave `ASK_RELEVANCE_FLOOR` off. Real repair evidence would
   vanish from answers. Nothing else in the table changes this.
3. **`DROPPED+` is `0` but `dropped-` is also `0`?** Leave it off. It has nothing to remove on
   your corpus, so turning it on only adds a moving part.
4. **`DROPPED+` is `0` and `dropped-` is above `0`?** Set `ASK_RELEVANCE_FLOOR=true` in
   `server/.env`, then run `npm run eval:answers` and confirm every verified case still
   passes. If any regresses, turn it back off — the answer check outranks the sweep.

If the script recommends a threshold other than `0.2`, that is a finding to report, not a
setting to change: acting on it requires a code change (`MINIMUM_SEMANTIC_SCORE` in
`server/src/services/chunkRetrievalService.js`), so open an issue rather than editing it to
match one calibration run.

Re-run the calibration after importing a substantially different set of PDFs. The verdict is
specific to the corpus it measured, so a much larger or more varied library can flip it.

Two behaviors mean an enabled floor is less risky than it sounds, and neither is a reason to
skip the steps above. Passages whose own body text matched your search terms are exempt
regardless of score. And if the floor would drop *everything* for a question, it is skipped
for that question — Ask would rather answer weakly than answer with no evidence to show.

If any question errors, the script says so and exits non-zero; the sweep excludes those cases.

## The test questions live in one file

Edit `server/src/evals/answerQualityCases.js`. Each question is either:

- `verified: true` — confirmed against your manual. These **gate** the result.
- `verified: false` — a **template**. It runs and reports, but does not fail the run. The
  values in templates are common published figures used as a starting point — **confirm them
  against your own documents before trusting them.**

### Adding your own verified question

1. Ask the question in the app and open the cited PDF page to confirm the number.
2. Add it to `answerQualityCases.js`:
   ```js
   {
     id: "rear-brake-caliper-torque",
     question: "What is the rear brake caliper bolt torque?",
     category: "torque",
     expect: "answered",
     mustIncludeAny: [/\b34\s*N/i, /\b25\s*ft/i], // the exact value from YOUR manual
     citationDocLike: /brake/i,                    // part of the source document name
     verified: true,
   },
   ```
3. Re-run `npm run eval:answers`.

Aim for ~15–20 verified cases covering the specs and procedures you care about most, plus a
few refusal cases. That set becomes your safety net for every future change.
