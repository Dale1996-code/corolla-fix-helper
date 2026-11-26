# Repair Planner baseline log

> **One session so far: the 6-pilot (S1, one run, 2026-11-19).** No full baseline (6a) has been
> captured. No value in an entry may be filled in by hand. Each baseline is the section that
> `npm run eval:planner:report -- <capture.jsonl>` writes (the `.md` file beside its per-run JSON),
> pasted under the heading below. The tool produces **aggregates only**: counts, scenario and
> fact ids, statuses, rejection-reason codes. It never prints a claim, a quote, or a manual
> passage, because this repository is public. The per-run JSON, which does quote manuals, stays in
> the gitignored `server/data/captures/`.
>
> A baseline is a measurement, not a target. It sets no pass/fail line for live behavior
> (`docs/planner-eval-spec.md`, owner decision D1), and two baselines are comparable only if the
> `config` snapshot, `instructionsHash`, `scenarioSetVersion`, and corpus fingerprint in their Table 0
> match and neither has uncommitted changes (spec section 11.1; `--compare` is not built).
>
> Before any paid session: the owner confirms a dedicated OpenAI project with a hard monthly limit
> (decision D10b), and approves, in that session, the scenarios, repeats, `--max-runs`, and
> `--max-provider-requests` (spec section 12.4). The first session is a one-run pilot.

## How an entry is made

1. `npm run eval:planner:capture` (a dry run by default: it calls nothing and prints an
   *estimate*). A real run is paid and needs the owner's approval in the session.
2. Free: replay the capture with `npm run eval:planner:replay -- <capture.jsonl>` and confirm that
   nothing changed.
3. Free: run `npm run eval:planner:report -- <capture.jsonl>` to print the report and write the
   aggregates-only section.
4. Paste that section here, newest first, and record the spot-check the owner makes against the
   rendered PDF pages (spec 7.3).

## Baseline 2026-11-19 at 59f1135

> **Session 6-pilot** (spec section 13, Phase 6). Approved by the owner in the session: scenario
> `S1-oil-and-filter`, 1 repeat, `--max-runs 1`, `--max-provider-requests 72`, after the owner
> confirmed the D10b project limit the same day. It ran against a `VACUUM INTO` snapshot of the
> library. `npm run eval:planner:replay` on the capture: 0 of 23 claim verdicts, 0 evidence
> statuses, 0 readiness levels, and 0 draft notes changed. Everything from "CRITICAL FINDINGS"
> down to the spot-check line is the report's own section, pasted unedited.
>
> Notes, written by hand, not measured:
>
> - **Spend** is the tool's estimate. The provider dashboard is the only real figure, and it is
>   not recorded here.
> - **"False rejections: none." and Table 1's "false rej 1" count different things.** *(Corrected
>   the same day: the first version of this note said the claim matched no confirmed fact, which
>   was wrong.)* Table 1's U1 counts rejected *claims* the judge classes as false rejections. Here
>   that is one required-tool claim, turned down as `item_name_too_short`, that states the
>   confirmed fact `s1-step-drain-filter-cap` from text the model was shown. Another claim for that
>   fact was accepted, so the fact's outcome is Covered (Table 2). The line under Table 3 lists
>   only confirmed *facts* whose outcome is `V:false_rejection`, and there are none. Reports made
>   after this entry print the two counts as "Rejected claims the judge counts as false
>   rejections" and "Confirmed facts whose outcome is V: false rejection"; the section below is
>   left as the tool printed it then.
> - **The snapshot file changed when the run started.** The planner's normal database module
>   opens the file writable and sets `journal_mode = WAL`, which rewrites the file header. No
>   migration ran, and the corpus counts in Table 0 are unchanged. Table 0's MD5 was taken before
>   that, so it is the snapshot as made. The file the run left behind hashes differently, and a
>   second session against it would not match this Table 0. The capture tool has since been
>   changed: it reads the snapshot only, runs the agent against a checked copy, and re-hashes the
>   snapshot when the session ends. 6a needs a fresh snapshot.

CRITICAL FINDINGS: none.

```text
VERIFIED/READY PLANS LACKING ESSENTIAL CONFIRMED FACTS
  runs with evidenceStatus verified, or level ready (unacknowledged or acknowledged): 0 of 1
    assessable (>= 1 essential confirmed fact exists for the scenario):       0
      covered every essential confirmed fact:                                 0
      lacking >= 1 essential confirmed fact:                                  0   <- the finding
    NOT assessable (no essential confirmed fact exists yet, so completeness is
      unknown, never "complete"):                                             0
```

### Table 0: identity and comparability

| Field | Value |
| --- | --- |
| Capture | 2026-11-19T20:17:07.178Z, planner-2026-11-19T20-17-07Z-59f1135.jsonl |
| Revision / dirty | 59f1135 / clean: comparable on its face |
| Model / reasoning effort / max output tokens | gpt-5.5-2026-04-23 / low / 2048 |
| instructionsHash | c44aeb62ccb6e475ce2670820a332e22c81602339a8220e5b88ac2716454b666 |
| Config snapshot | answerModel=gpt-5.5-2026-04-23, reasoningEffort=low, maxOutputTokens=2048, maxTurns=8, maxToolCallsPerTurn=8, maxSearchResults=8, evidenceContextCharLimit=1500, retrievalMode=hybrid, retrievalMaxChunksPerSource=3, rerankEnabled=false, relevanceFloorEnabled=false, embeddingVersion=text-embedding-3-small@512 |
| Scenarios | scenarioSetVersion 2 (current 2); 18 confirmed, 0 unconfirmed facts |
| Corpus | 1443 documents, 20447 chunks, embedding version text-embedding-3-small@512, DB snapshot MD5 0ccb47a9879f256200e283a382f853b0 |
| Variant details at run time | engine not saved, build plant not saved |
| Repeats, runs, requests, tokens, spend | repeats 1, 1 run, 11 provider requests, tokens not recorded (the usage tee is deferred, D9), estimated spend about $0.17 (ESTIMATE from a price table as of 2026-11-05, not measured: read dollars from the OpenAI dashboard) |

### Table 1: per-scenario outcome

| Scenario | Corpus support | Evidence status (v/p/n) | Level counts | C1 | P1 | T1 recall | W2 | U1 rejected/submitted | Critical (P2, P3, false acc.) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| S1-oil-and-filter | full | v0 p1 n0 | ready 0, almost 1, not 0 | 8/13 | 3/3 | unscored | unscored | 1/23 (false acc 0, false rej 1) | P2 0, P3 0, false acc 0 |

### Table 2: failure attribution

Confirmed facts only, summed over the runs of each scenario. Every fact of every run is in exactly one column.

| Scenario | Confirmed facts x runs | Covered | Partial | Correctly absent | S | R | G: query | G: omission | G: no_search | G: run_failure | L0 | V: false rejection | V: false acceptance | I | Undetermined | Refused |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| S1-oil-and-filter | 18 x 1 = 18 | 12 | 0 | 0 | 0 | 0 | 3 | 3 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

### Table 3: rejection reasons

| Reason | Rejected claims |
| --- | --- |
| item_name_too_short | 1 |

False rejections: none.

Invariants: all pass (I-1, I-2, I-3, I-4, I-7 over 1 run, 5 checks; I-5, I-6 and I-8 are asserted by the test suite, not by a capture).
Operations: 1 run, 7 model turns, 8 tool calls, 4 searches, 4 retrievals, 0 finalizer corrections, 11 provider requests, 0 runs without a plan.

### How to read this report

- 1 repeat(s) per scenario, 1 run in all. Where repeats differ the cell shows min .. max (med). This baseline is a characterization, not a statistical estimate.
- `verified`, `ready`, and a long plan are the planner's own labels. They are not quality words here: quality is read against the confirmed facts only.
- A rejection rate is never shown without the false acceptances and false rejections beside it. Fewer rejections is not an improvement unless the critical findings and the false acceptances did not rise.
- 2 cells print `unscored` because the fact they depend on has not been confirmed: S1-oil-and-filter T1, S1-oil-and-filter W2.
- Spot-check (spec 7.3): automated sampling is deferred (owner decision D9). 8 accepted claims matched no confirmed fact; they are in the per-run JSON for review against the rendered PDF pages.

Spot-check (spec 7.3), recorded by the owner against the rendered PDF pages on 2026-11-26: all 8 accepted claims that matched no confirmed fact were reviewed (the report listed 8; the spec's sample is 5 per scenario). Correct 7, Wrong 1, Cannot Tell 0; spot-check precision 7/8 on N = 8, one run, not a population estimate. Wrong: SC-8 (`vehicle_fact`, Vehicle Maintenance Filters Parts and Labor p. 1): a figure from a parts table was accepted without its column heading, so its meaning (a price) was lost. The owner judged this a contextual verification failure, not a numerical error.
