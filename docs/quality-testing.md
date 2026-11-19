# Quality Testing The Chatbot

This is how you check that the Ask chatbot gives **correct, well-cited answers** — and
catch it if a future change quietly makes answers worse. There are three checks: two you
run regularly, and one you run only when tuning a specific setting. The answer check also has
a free, offline companion, the **replay**, for judging a change to the verifier before you pay
for a run.

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
  citation that does not back it up? The snippet it reads is the citation's 220-character
  *preview* — the start of the chunk — not the whole verified passage. A value further into
  its chunk is invisible to it, and that is where almost every row of a specification table
  sits, behind the page's breadcrumb header. Leave the check off such a case rather than let
  it fail correct answers; `spark-plug-gap` and `fuel-pressure-spec` explain the measurement.

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

### Judging a verifier change for free: capture, then replay

The verifier (`server/src/services/askEvidenceContract.js`) decides which of the model's claims
survive. Every change to it, such as a new rejection rule or a stricter number match, changes
that. `eval:answers` shows what a change does to *today's* answers, but every run costs money
and asks the model again. A different reply can hide a difference or invent one. A replay asks
the other question, for free: *what does the new verifier decide about replies we already have?*

It comes in two halves.

**1. Capture (paid, once in a while):**

```powershell
npm run eval:capture
```

This runs the same cases as `eval:answers`, the same way, and saves each raw model reply. With
each reply it saves the manual passages the model was shown and what the verifier decided about
each claim at the time. The file goes in `server/data/captures/`, named after the time and the
code revision, for example `2026-10-23T04-12-33Z-e4c66eb.jsonl`. A capture costs about what one
`eval:answers` run costs, so run it only when you have agreed to the spend. To capture only some
cases, add `-- --case <id>` (repeat `--case` for more).

**A capture quotes your manuals word for word.** The folder is ignored by git and must stay
that way, because the repository is public. Don't commit a capture, and don't paste its passages
into a committed doc.

A capture does not score answers, so it is not an `eval:answers` run. Don't record it as one in
the iteration log.

**2. Replay (free, as often as you like):**

```powershell
npm run eval:replay -- server/data/captures/2026-10-23T04-12-33Z-e4c66eb.jsonl
```

This re-checks every saved reply with the verifier as it is now. It needs no API key, no
database, and no network. It prints every verdict that changed. Here is the shape, from the
invented test fixture with one claim edited:

```
synthetic-widget-torque (primary) documentSupported[0]: accepted → numeric_anomaly
    claim: The widget housing bolt torque is 25 N*m.
    source: S1, Synthetic Widget Manual (invented text), page 3

0 answer statuses changed of 4 records
1 verdict changed of 9
```

How to read it:

- A **verdict** belongs to one claim, one general-guidance line, or one gap. It is either
  `accepted` or the reason the item was removed (`numeric_anomaly`, `quote_not_in_source`, and the
  other reasons the verifier can give).
- **The last line is the one a change is judged by.** `0 verdicts changed` means the change makes
  no difference to the captured replies.
- **Read every changed line.** Each one should be a row the change was *meant* to move. A change
  anywhere else is a regression to fix before you spend anything. The N5 P3 engine check has
  exactly this as its acceptance test: verdicts change only on applicability rows.
- **Then run `eval:answers` as usual.** The replay does not replace it. It can't see how the model
  answers today, and model answers drift.

What a replay cannot do:

- **It can only replay checks whose inputs the capture holds.** Each passage is saved with every
  simple field the search returned. A check that needs a field the search only returns later
  works on captures taken after that, not before.
- **`eval:replay` does not cover the Repair Planner's verifier.** The planner has its own
  replay, `eval:planner:replay`, described below.
- **It refuses a file it can't read in full.** If it reports lines that "could not be
  replayed", it exits with an error, and its totals don't cover the whole file. That usually
  means a capture from an older format version: take a new capture.

**The Repair Planner has its own replay.**

```powershell
npm run eval:planner:replay -- server/data/captures/planner-<time>-<revision>.jsonl
```

It is free and offline in the same way (no key, no database, no network). For every planner
run in the file it re-checks each claim with the planner's verifier as it is now, and re-works
out the evidence status, the readiness rating (before and after the owner acknowledges the safety
warning), and the saved-checklist notes. It prints each change, then four lines:

```
0 claim verdicts changed of 11
0 evidence statuses changed of 8 runs
0 readiness levels changed of 8 runs
0 draft notes changed of 8 runs
```

Read them as you read `eval:replay`: every changed row should be one the change was meant to
move. A planner capture quotes the manuals just as an Ask capture does, so
`server/data/captures/` stays ignored by git. The capture committed for the tests is invented
(`server/test/fixtures/synthetic-planner-capture.jsonl`).

**Recording a live planner run (paid) and reading it (free).** Two commands finish the planner
evaluation's tooling. Nothing in the repository has ever run the first one against a real model.

```powershell
npm run eval:planner:capture      # a DRY RUN: calls nothing, prints the plan and an ESTIMATE
npm run eval:planner:report -- server/data/captures/planner-<time>-<revision>.jsonl
```

`eval:planner:capture` is **paid** when, and only when, it is run with `--no-dry-run --yes`. Run it
only with the owner's approval in the session, naming the scenarios, the repeats, `--max-runs`,
and `--max-provider-requests`. The default dry run lists the scenarios, the run count, the
worst-case request count beside `AI_DAILY_CALL_LIMIT`, every limit with its value, and an
estimate of the dollars from a price table marked with its date. The estimate is **not a limit**.
A real run refuses, and says why, unless all of these hold:

- `--no-dry-run` and `--yes` are both given, and `OPENAI_API_KEY` is set;
- `--max-provider-requests N` is given. It is mandatory. The tool counts every model turn and
  every retrieval, refuses the next one once the limit is reached, and records the run that hit
  it as infrastructure (Layer I), never as a product failure;
- the plan (scenarios × repeats) fits `--max-runs`, which defaults to 1. A plan that does not fit
  is refused, not trimmed, so name the scenarios with `--scenario <id>`;
- the database is a `VACUUM INTO` snapshot, not the default `server/data` one, and has no
  write-ahead log. Set it with `DATABASE_FILE`; `--allow-default-database` overrides it;
- if S8 is in the plan, the corpus still has no timing belt (the same check the Ask eval uses).

Token limits and the token-usage tee are **not built** (spec decision D9), so the tool cannot
measure spend. The only real dollar bound is a budget set on the OpenAI project itself, which the
dry run lists as **UNVERIFIED** until the owner confirms it. The first paid session is a one-run
pilot (`--scenario S1-oil-and-filter`).

`eval:planner:report` is free and offline (it imports neither `config.js` nor `database.js`). It
judges every run in a capture and writes two files beside it: a per-run JSON, which quotes the
manuals and stays out of git, and an aggregates-only section for
[`docs/evals/planner-baseline-log.md`](evals/planner-baseline-log.md). The first thing it prints
is the critical-findings line; the second is the block that matters most: **verified or ready
plans that lack essential confirmed facts**. A plan the planner labels `verified` and `ready` can
still omit a figure the manual prints, and a run in a scenario with no confirmed essential fact is
reported as *not assessable*, never as complete. The report refuses to print if any confirmed fact
fails to land in exactly one outcome (I-7), or if the capture could not be read in full. It
measures; it sets no pass or fail target, and nothing it reports is ever a reason to loosen the
verifier. The committed log is a blank template until the owner approves a paid baseline.

### The automated tests never read your `server/.env`

Your `server/.env` holds your real `OPENAI_API_KEY` and `NETWORK_MODE=1`. `npm run test` must
use neither of them. A test that reached the real key could spend real money, and a test that
saw `NETWORK_MODE=1` would check the phone-access binding instead of the safe default.

So the server's config loader skips `.env` completely whenever Node's test runner started the
process. The runner marks every test file it runs with an environment variable,
`NODE_TEST_CONTEXT`, and the loader checks for it. That covers `npm run test`,
`npm run test:server`, and a single file run with `cd server; node --test test/app.test.js`.
Everything else (`npm start`, `npm run dev`, the evals) still reads `.env` as before.

`server/test/envIsolation.test.js` guards this. It fails when:

- the test runner stops setting `NODE_TEST_CONTEXT`. Node does not document this variable, so
  an upgrade could rename it.
- any OpenAI key is visible to a test. That includes a key set in your terminal session, which
  skipping `.env` cannot block. If it fails for that reason, clear the key for the session
  (`Remove-Item Env:OPENAI_API_KEY`) and run the tests again.
- a `.env` planted next to a test probe gets read under the runner.

Two ways of running a test file skip the marker, so don't use them: `node test/x.test.js`
without `--test`, and `node --test --test-isolation=none`.

The check lives in the config loader rather than in a setup file attached to `npm test`, for
two reasons. A setup file would protect only that one npm script, not the single-file command
above. That command is what you use while writing a new test, which is exactly when a test is
most likely to be missing its own safety line. A setup file would also clear only the settings
it lists by name. Skipping `.env` keeps every setting in it away from the tests, including ones
like `RERANK_ENABLED`, `ASK_EVIDENCE_CONTRACT`, and `AI_DAILY_CALL_LIMIT`.

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
