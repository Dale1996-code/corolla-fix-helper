# Repair Planner baseline log

> **TEMPLATE. No baseline has been captured.** Every value below is blank on purpose: nothing has
> been measured, and nothing here may be filled in by hand. Each baseline is the section that
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

## Baseline: (not yet captured)

CRITICAL FINDINGS:

```text
VERIFIED/READY PLANS LACKING ESSENTIAL CONFIRMED FACTS
  runs with evidenceStatus verified, or level ready (unacknowledged or acknowledged):  of
    assessable (>= 1 essential confirmed fact exists for the scenario):
      covered every essential confirmed fact:
      lacking >= 1 essential confirmed fact:   <- the finding
    NOT assessable (no essential confirmed fact exists yet, so completeness is
      unknown, never "complete"):
```

### Table 0: identity and comparability

| Field | Value |
| --- | --- |
| Capture | |
| Revision / dirty | |
| Model / reasoning effort / max output tokens | |
| instructionsHash | |
| Config snapshot | |
| Scenarios | |
| Corpus | |
| Variant details at run time | |
| Repeats, runs, requests, tokens, spend | |

### Table 1: per-scenario outcome

| Scenario | Corpus support | Evidence status (v/p/n) | Level counts | C1 | P1 | T1 recall | W2 | U1 rejected/submitted | Critical (P2, P3, false acc.) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| | | | | | | | | | |

### Table 2: failure attribution

| Scenario | Confirmed facts x runs | Covered | Partial | Correctly absent | S | R | G: query | G: omission | G: no_search | G: run_failure | L0 | V: false rejection | V: false acceptance | I | Undetermined | Refused |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| | | | | | | | | | | | | | | | | |

### Table 3: rejection reasons

| Reason | Rejected claims |
| --- | --- |
| | |

False rejections:

Invariants:

Operations:

Spot-check (spec 7.3), recorded by the owner against the rendered PDF pages: *(not done)*
