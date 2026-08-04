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

## 3. Relevance-floor calibration (only when tuning `ASK_RELEVANCE_FLOOR`)

```powershell
npm run eval:relevance-floor
```

Ask has an optional filter that throws away weakly-matching passages before they reach the
answer step. It is **off by default and does nothing** — it currently just reports what it
*would* drop. This script is how you decide whether turning it on is safe, and at what
threshold.

Run it only if you are considering setting `ASK_RELEVANCE_FLOOR=true`. It is not part of the
routine quality loop.

**Why it needs its own script:** `eval:retrieval` cannot see this filter. That check only
exercises the search step, and the filter sits above it, in the Ask pipeline. Any threshold
picked without this harness is a guess.

**What it costs:** it needs `OPENAI_API_KEY` — the passage scores it calibrates come from
embedding your question — but it stubs out the answer model, so you pay only for the query
embeddings, not for generated answers. It reads your corpus and writes nothing. With no key
set it prints a note and exits cleanly.

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
0.25      |    59 |        3 |    28 |       27 |         49.1% | NO
```

The column that decides everything is **`DROPPED+`** — good evidence that threshold would
have thrown away. A row is `safe` only when that column is zero. The script then recommends
the highest safe threshold that actually removes noise, or tells you to leave the floor off
because nothing can be removed safely on your corpus.

Treat the recommendation as a starting point, not an instruction: read the table, then set
`ASK_RELEVANCE_FLOOR=true` only if you are satisfied that no answer you care about loses its
source. A non-zero `DROPPED+` means real repair evidence disappears from answers.

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
