# TODO-test audit — 2026-11-28

A read-only review of every `todo` test on `main` at `2b90e4b` (after PR #207), to decide what to build
next. Nothing in production code or tests changed during the audit. It ranks the gaps by what they could
do to a repair decision, not by how many rows they would clear. A row stays `todo` until a reviewed fix
lands; the stale-todo guards (`evidenceOracle.test.js`, `plannerL0Pins.test.js`,
`plannerNegatives.test.js`, `repairPlanEvidenceContract.test.js`) fail the suite the moment one passes.

**Baseline.** Server 2,656 tests: 2,616 pass, 0 fail, 0 skipped, 40 todo (the same on Node 24.15.0 and
24.22.3). Client 549 tests: on a clean full run 5 failed (4 Vitest timeouts in `SymptomsPagination`, 1
in `UrlViewState`), and each file passes alone, which is the known heavy-test timeout pattern, not
investigated further. Every todo row still reproduced: the stale-todo guards passed.

## The 40 rows, by root cause

"Direction" is the error the row records: a **false accept** shows something as verified that is wrong
or ambiguous; a **false reject** refuses a correct claim (the safe direction).

| Group | Rows | Where | Direction | What happens | Priority |
| --- | --- | --- | --- | --- | --- |
| A. Unit-column fallback | 1 | `askEvidenceContract.test.js` | False accept of a **wrong figure** | Any bare number in the quote verified under any header unit: "377 N·m" (the kgf·cm cell) passed | P1 — **fixed by N4-U** (see the iteration log), which leaves one pinned limit, row `N4-U9` |
| B1. F4 inherited header, no column named | 1 | `evidenceOracle.js` `F4-L2` | False accept, ambiguous | A header printed once is not read for later rows | P2 |
| B2. F4 inherited header, right column | 1 | `F4-L1` | False reject | Same cause as B1 | P3, with B1 |
| B3. F4 unaligned (footnoted) cells | 1 | `F4-A9` | False accept, wrong column | A fail-closed rule was measured: one correct torque row lost, none protected | Deferred |
| B4. F4 cut quote; part-name header | 2 | `F4-C1`, `F4-L3` | False reject | No safe narrower rule found; the part-name shape is not in the library | Deferred |
| C. R3 "comparison about another component" | 6 | `R3-C-*` | False reject | The word-overlap tie was removed because its errors went the unsafe way | Deferred |
| D. R3 limit-reading misses | 4 | `R3-L-*` | False accept: a limit read as the normal value | Each wider reading was recorded as reading the wrong figure more often; none shown in the library | P3 / Deferred |
| E. Planner phantom tasks | 5 | `plannerL0Pins.test.js` `F3-phantom-task` | Noise; extra safety-critical tasks | A symptom or context sentence ("They squeal when I brake.") becomes a task, in every natural brief | P2, deferred by planner spec decision D7 |
| F. Planner safety flags | 2 | `F4-brake-lifting`, `F4-engine-mount` | Missing warnings | Brake pads get no lifting or lug-nut warning (already safety-critical, so readiness is unaffected); an engine mount is rated beginner and not critical, so it can be Ready with no acknowledgement | P2, XS |
| G. Planner wrong engine or variant | 2 | `plannerNegatives.test.js` `N5-P6-*` | False accept of a wrong figure | A claim that drops "2AZ-FE engine:" from its quote is accepted | P1, roadmap N5 P6 |
| H1. Planner claim-kind bypass | 1 | `repairPlanEvidenceContract.test.js` `S-1` | Coverage inflated | An off-task figure filed as a procedure covers the task | P2, S |
| H2. Planner shared modifier / other task word | 6 | `S-2.*`, `S-3` | Coverage inflated | Largest measured gap (952 figure sentences); requiring the task's last word was measured unsafe | P2, needs design |
| H3. Planner reversed wording | 2 | `S-4.*` | Coverage inflated | Not in the library | Deferred |
| H4. Planner synonyms; heading punctuation | 6 | `S-5.*`, `S-6` | False reject | "Serpentine" vs "V-ribbed" belt, "transmission" vs "transaxle", … | P3 |

**Ask false accepts and planner false accepts carry different risks.** An Ask claim is the model's own
wording, so a wrong figure can read exactly like a right one. A planner claim is a verbatim fragment of
the manual, so an off-task claim still prints its real part name. The planner's harm is a plan that looks
more complete or more ready than it is, which is planner spec decision D6, so most of H2 should wait for
the planner baseline (N9 6a).

## Found during the audit, not pinned by any row

Ask accepts "For the 2ZR-FE, the oil drain plug torque is 40 N·m" against a quote reading "2AZ-FE engine:
oil drain plug 40 N·m": engine codes are not in the condition vocabulary. This belongs to roadmap N5 P3,
whose design calls for new oracle rows; none exists yet.

Smaller: the brake-work warning tells the owner to bleed the system even for a pad-only job.

## Recommended order (as of the audit)

1. **Unit-column alignment (group A).** Done as N4-U, measured offline. Its remainder, **N4-U9** (rows
   the reader cannot place still verify a number in the wrong unit), is a safety-relevant follow-up
   tracked under roadmap N4 and pinned by the oracle row `N4-U9-unaligned-row-wrong-unit`.
2. **Planner safety rules (group F).** XS, deterministic, only stricter.
3. **The task-subject check for every claim carrying a figure (H1).** S; measure on the planner's
   fragment probe.
4. **N5 P3, first slice:** Ask wrong-engine oracle rows, then "the claim names engine X while the
   figure's sentence prints only engine Y → reject".
5. **Phantom tasks (E):** only when another sentence is a repair, so symptom-only briefs keep working;
   needs D7 revisited, after the 6a baseline.

Leave alone: B3, B4, C, D, H3. Each fix was either measured as costing more than it saves or targets text
the library does not contain. The rows document the limit and fail loudly if behavior changes.
