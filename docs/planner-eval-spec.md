# Repair Planner evaluation system: specification (DRAFT for owner review)

> **Status:** proposal. Nothing in this document is implemented. No code, test, schema, or
> prompt was changed to write it, and no paid AI call was made. Every "Measured" statement
> below was produced offline, either by reading the code or by running copies of six pure
> planner modules in a scratch folder with the retriever stubbed and **invented** fixture
> text (see [Appendix A](#appendix-a-what-was-measured-and-how)).
>
> **Revision 2 (2026-11-05), after owner review.** Owner decisions are recorded in section 16.
> Changes: (1) the S3 evidence inconsistency is corrected, and the claim that S1 and S2 were
> "already confirmed" is narrowed to the specific facts that are (6.2); (2) **no fact is scored
> until its evidence is confirmed** (6.1, 7.4); (3) section 12 no longer presents a token
> ceiling as a dollar cap: it separates what each limit actually guarantees, and corrects an
> earlier "$10 worst case" figure that was wrong; (4) Phase 1 is split into 1a and 1b, and the
> speculative scenario module moves out of it (14); (5) section 14.1 lists scope trims to avoid
> over-building. **No paid call is authorized by anything in this document.**
>
> **Purpose:** give the Repair Planner what Ask AI already has: a reproducible baseline, so
> that the next change to the planner (prompt, tools, retrieval, verifier, task extractor) can
> be judged as better, worse, or unchanged, instead of guessed.
>
> **Reading guide for a non-specialist:** section 1 is the plain-English summary. Sections 2-4
> explain the findings and the design. Sections 5-8 are the concrete test content. Sections
> 9-12 are formats and cost. Sections 13-15 are risks, the build sequence, and what "done"
> means. Section 16 lists the decisions only the owner can make.

---

## 1. Summary in plain English

**The problem.** The Repair Planner turns a short brief ("Replace the front brake pads") into a
plan with citations, a tool/part list, safety warnings, and a readiness score. Its only live
evidence today is five hand-reviewed runs (all came back `partial`, readiness never above 50).
Nobody can say *why* a plan is thin, or whether a code change made it better.

**The key finding that shapes everything.** The planner's own labels cannot measure plan
quality, so the evaluation must bring its own yardstick:

- A plan with **one** verified sentence for a task, plus two verified "no tools / no parts
  required" sentences, is labelled `verified` and scores readiness **100 / ready** (Measured,
  Appendix A, probe A1). `verified` means "every sentence shown passed the checks", not "the
  procedure is complete".
- A repair with **zero** supporting evidence still shows a readiness *score* of 50 (cabin
  filter) because skill and safety points are awarded regardless of evidence. Only the
  *level* is capped to `not_ready` (A2).
- The planner has **no engine or variant awareness**: a figure that belongs to a different
  engine is accepted if it is quoted correctly (A5). Ask AI got row/column/qualifier checks;
  the planner did not.

So the evaluation compares each plan against an **owner-confirmed list of facts per scenario**
("golden facts"), and never uses `verified` or the readiness number as proof of quality.

**What gets built (in order).** (1) a scenario file and free deterministic tests; (2) a
synthetic harness that runs the *real* planner loop with a scripted fake model and invented
manual text; (3) a capture/replay format modeled on Ask's; (4) a one-time, read-only survey of
your real manuals to confirm each golden fact; (5) a guarded paid capture tool and a report
generator; (6) one paid baseline run, only with your approval.

**What it costs.** Everything except step 6 is free. Step 6 is *estimated* at **about $4-5**
(24 live runs, ~$0.18 each from the Stage 5-E2 log), but that is an estimate, not a limit. The
tool has stop limits on runs, requests, and tokens, and none of them is a dollar guarantee: the
only true dollar bound is a budget set on the OpenAI project itself. Section 12 explains what
each limit does and does not promise. The first paid session is a one-run pilot.

**What it will not do.** It will not change the verifier, the prompt, the readiness rubric, the
safety classifier, or the task extractor, and it sets **no pass/fail targets** for live
behavior. The first baseline is a measurement. Targets come after you have seen the numbers.

---

## 2. Findings that shape the design

Each finding is tagged **Measured** (reproduced offline, Appendix A) or **Read** (from code,
file and line cited). The first group changes the design; the second group shapes the
implementation.

### 2.1 Design-shaping findings

| # | Finding | Evidence | Consequence for the eval |
|---|---|---|---|
| F1 | `verified` needs only one accepted *technical* claim per task, no rejected claim for that task, and both requirement groups resolved. It does not need the procedure to be complete. | **Measured** A1; **Read** `repairPlanEvidenceContract.js` `assessTaskCoverage`, `deriveEvidenceStatus` | Completeness must be scored against golden facts, separately from status. |
| F2 | Readiness is a function of `(tasks, skill, requirements, evidenceStatus)` only. A zero-evidence plan scores 50 (non-critical) or 30 (brakes); `not_found` just forces the level to `not_ready`. | **Measured** A2, A8; **Read** `repairTools.js:598` | Never report the score alone. Report `(score, level, evidenceStatus)` and a readiness-vs-completeness cross-tab. |
| F3 | Natural brief phrasing creates **phantom tasks**: "It is due and I have the jack stands out already." became task 2, system General, **safety-critical**; "The engine idles rough and the check engine light came on." became task 2. Every task must be covered by evidence, so phantom tasks push runs toward `partial`. | **Measured** A4 | Add a Layer-0 (task derivation) class. Run scenarios with a canonical brief, and probe natural phrasing separately and for free. This is a *hypothesis* about why logged runs were all `partial`; the baseline tests it, it is not assumed. |
| F4 | The server-side safety flags depend on brief wording, not the job: "Replace the front brake pads" is flagged brakes only, with **no** lifting or wheel-retention warning. "Replace the front engine mount" is `beginner`, non-critical. | **Measured** A3 | Safety expectations split into server-owned flags (free, deterministic) and model-grounded safety claims (live). |
| F5 | No engine/variant awareness: a different engine's figure is accepted when quoted contiguously; a single variant of a two-variant row is accepted with no warning that the other exists. | **Measured** A5 (B, C2); the Ask suite already holds real traps: vehicle height 2ZR-FE vs 2AZ-FE (doc 109 p2), engine mount TMMT vs TMC (doc 1269 p1) | Wrong-engine and wrong-variant negatives are first-class. They are recorded as `todo` rows (existing convention), not "fixed" by weakening anything. |
| F6 | The model only sees the first 1,500 characters of each chunk, and quotes are checked against that. A fact after character 1,500 can never be quoted. | **Measured** A6; `EVIDENCE_CONTEXT_CHAR_LIMIT` | A distinct source-side failure (`cap_truncated`). The capture stores both the capped and the full text. |
| F7 | The existing planner-oracle (`server/test/fixtures/evidenceOracle.js`, 18 rows) tests single claims against synthetic text. There is no whole-run test of any kind with a scripted model beyond a few happy-path unit tests in `repairPlanner.test.js`. | **Read** | The new work sits *above* the oracle (whole runs), and reuses its conventions (`todo`, synthetic text only). |

### 2.2 Implementation-shaping findings

| # | Finding | Evidence | Consequence |
|---|---|---|---|
| I1 | The whole loop is injectable: `runRepairPlannerAgent(request, { streamTurn, retrieve, isAiConfigured, planRuns, maxTurns })`. | **Read** `repairPlannerAgent.js:184` | Deterministic whole-run tests need no new seams. Capture = wrap `streamTurn` and `retrieve`. |
| I2 | `repairTools.js` statically imports the retriever, which imports `database.js`, which **opens the real database at import**. Ask's replay avoids this by design ("no database"). | **Read** `repairTools.js:1`, `database.js:5-11`, `chunkRetrievalService.js:1` | Needs a 3-line, behavior-neutral change (lazy default retriever) to keep replay "free, offline, no database". See P-1. |
| I3 | `streamResponsesTurn` yields only `function_call` events (and display-only `text_delta`); it **reads but discards** token usage. | **Read** `openAiResponsesClient.js:223` | Spend accounting needs a tee on `fetchImpl` (clone the response). It is the trickiest piece; fallback in Risk R6. |
| I4 | `AGENT_INSTRUCTIONS` is not exported. | **Read** `repairPlannerAgent.js:83` | The capture header wants a hash of the prompt and tool schemas so comparisons can detect "prompt changed". Export is 1 line. |
| I5 | Planner claims are **verbatim fragments of their quote**, which is verbatim from the (capped) source. | **Read** `verifyClaims` | Golden-fact matchers can target *manual wording*, not model paraphrase. Much less brittle than Ask-style answer matching. |
| I6 | On a provider failure the agent returns a generic error and loses the HTTP status. | **Read** `repairPlannerAgent.js:514` | The `streamTurn` wrapper must record provider errors itself so 429/timeouts are classed as infrastructure (Layer I), not product failures. |
| I7 | `answerQualityScoring.js` imports `aiAnswerService.js` (for one constant), so it opens the database on import; its useful helpers (`checkQualifiedValues`, `answerSegments`) are not exported. | **Read** | Do not import it. Re-implement the small "value must carry its qualifier" check in a pure planner module, or extract it later with Ask's tests as the safety net. |

---

## 3. What can be reused from Ask AI's capture/replay infrastructure

Verdict key: **Reuse** = import as is. **Pattern** = copy the design, new code. **No** = does
not fit.

| Ask component | Verdict | How / caveat |
|---|---|---|
| `answerCapture.js` `snapshotChunk` | **Reuse** | Pure; copies every primitive field of a retrieved chunk, so future fields (e.g. N5 scope) are captured automatically. Importing it is safe offline. |
| `answerCapture.js` header builder, `CAPTURE_VERSION` idea | **Pattern** | New format name `corolla-fix-helper/planner-capture`, own version counter. Header gains prompt hash, tool-schema hash, caps, scenario-set version, corpus fingerprint. |
| `parseCaptureText` (fail-closed line parser) | **Pattern** | Hard-codes record type `ask` and Ask's channels. Copy the *behavior* (first line must be a matching header; every unreadable line is reported with its number, never skipped) into `plannerCapture.js`. Not parameterizing Ask's parser keeps its gate untouched. |
| `createReplyRecorder` (tees `fetch`, parses a one-shot JSON reply) | **No** | The planner streams SSE and makes several calls per run. The recorder pattern applies, but the tee point is `streamTurn` and `retrieve`, not `fetch`. A second tee on `fetchImpl` is needed only for token usage (I3). |
| `answerReplay.js` (`replayRecords`, `formatReplayReport`, injectable `judge`) | **Pattern** | Same shape: re-judge every captured run with current code, print each changed verdict old -> new, end with "N verdicts changed of M", count status changes separately. Keyed by `(taskId, claimIndex)` instead of `(channel, itemIndex)`. |
| `replayCapture.js` CLI | **Reuse** (`resolveInvocationPath`, which honors `INIT_CWD`) + **Pattern** | Exit code rule (1 only when the file could not be read in full) carries over unchanged. |
| `captureAnswers.js` | **Pattern** | `buildCaptureFileName` can be reused or copied; `readGitRevision` is not exported (copy ~20 lines rather than edit Ask's script). Keep the "PAID, owner's go-ahead" banner and add stronger guards (section 12). |
| `answerCaseRunner.js` | **Pattern + Reuse** | `isRateLimited` and `describeError` are exported and pure: reuse. `runAnswerCase` is Ask-specific: write `runPlannerCase` with the same "core is injected, never imported" rule. |
| `answerQualityCases.js` governance (`verified:false` template -> `verified:true` only after independent confirmation **and** reproducibility; id list duplicated in a test so a guess cannot gate CI) | **Pattern** (adopt unchanged) | Applies to scenario facts. |
| `negativeCorpusPreconditions.js` (`checkTimingBeltRefusalPrecondition`) | **Reuse** | Guards scenario S8 against a corpus that later gains a timing-belt manual. Needs the database, so it runs in Tier B/D only. |
| `evidenceOracle.js` conventions (`todo` row naming a finding; fix removes `todo`, never deletes the row; controls never carry `todo`; public repo, synthetic text only) | **Pattern** (adopt unchanged) | Known planner gaps become `todo` rows, not passing "characterization" tests that would enshrine a bug. |
| `hybridRetrievalEval.js` | **No** (idea only) | Builds decoy/correct chunks in a fixture database. The planner's queries are model-written, so retrieval is judged from recorded queries plus survey annotations (section 5). |
| `applicabilityScope.js` (N5 tagger) | **Not yet** | `applicabilityNotEnforced.test.js` allows only the tagger and two diagnostic scripts to reference it. A report-only use from an eval module needs an explicit allow-list change and owner approval. Deferred to a later phase; v1 uses a plain engine-name regex for "other-engine citation" counts. |

**Hard rule for every PR in this work:** no change to the logic of
`repairPlanEvidenceContract.js`, `askEvidenceContract.js`, `safetyClassifier.js`,
`checkRepairReadiness`, `extractRepairTasks`, or any prompt. The only production edits allowed
are P-1 and P-2 below, each reviewable as a few lines.

- **P-1** In `repairTools.js`, replace the static retriever import with a lazy default
  (`(...args) => import("../chunkRetrievalService.js").then(m => m.retrieveRelevantChunks(...args))`)
  so importing the pure tools no longer opens a database. Behavior-neutral; the existing
  `repairPlanner.test.js` must pass unchanged. A test pins "importing `repairTools.js` loads
  neither `database.js` nor `config.js`".
- **P-2** Export the instruction text (or a hash of it) from `repairPlannerAgent.js` for the
  capture header.

---

## 4. Architecture: four tiers, one data flow

```
 scenario file ──┐                         (committed, public: concept-level facts,
 (plannerScenarios.js)                      short figures, SYNTHETIC fixtures only)
                 │
  Tier A  synthetic harness ──► real runRepairPlannerAgent
  (CI, free)      scripted fake model (streamTurn) + invented chunks (retrieve)
                 │
  Tier B  corpus survey (owner's machine, free, read-only DB) ──► confirms golden facts,
                 │                                   keyword-mode golden-query probes
                 ▼
  Tier D  paid capture (owner's machine, key, approval) ──► capture.jsonl (GITIGNORED,
                 │                                          quotes real manual text)
                 ▼
  Tier C  judge + replay (free, offline, no DB, no key) ──► per-fact failure layer,
                 │                                          metrics, verdict diffs
                 ▼
          baseline report (committed: aggregates only, no manual passages)
```

| Tier | Where it runs | Needs key | Needs real database | Needs a capture | In CI |
|---|---|---|---|---|---|
| A. Synthetic | anywhere | no | no | no | **yes** |
| B. Corpus survey | owner's machine | no | **yes** (read-only) | no | no |
| C. Judge / replay / report | anywhere with a capture | no | no | **yes** | the *logic* is tested in CI against a synthetic capture |
| D. Live capture | owner's machine | **yes (paid)** | **yes** | produces it | no |

Note for this environment: the cloud sandbox this assistant runs in has **no copy of your
manuals or database**. Tiers B and D must be run by you on your Windows machine; the assistant
prepares the code, you run the commands and share the aggregate output.

---

## 5. Failure taxonomy: six layers, one decision procedure

The request asked to separate retrieval, source-document, evidence-verification, and
planner-generation failures. Two more layers are added because the evidence shows they are
real and different: **L0** (task derivation, F3/F4) and **I** (infrastructure).

| Layer | Meaning | Decided by | Needs live model? |
|---|---|---|---|
| **L0 Task derivation** | The server's own decomposition of the brief (task list, difficulty, safety flags) is wrong or inflated, before any model runs. | Pure functions on the brief | no |
| **S Source limitation** | The fact is not in the corpus, or is present only in an unusable form. Assigned **before any model call**, from the survey. | `fact.corpusSupport`, `fact.sourceQuality`, cap analysis | no |
| **R Retrieval** | The fact is in the corpus in a usable form, but no search in the run returned it, **and** a canonical query would not have found it either. | Capture + survey annotation | no (replay) |
| **V Verification** | The model submitted a claim for the fact and the verifier rejected it (**false rejection**), or the verifier accepted a claim that is wrong or forbidden (**false acceptance**, critical). | Capture + golden oracle | no (replay) |
| **G Generation** | The evidence was in front of the model and the verifier would have accepted a correct claim, but the model never submitted one; or it never searched a task; or it failed to finalize. | Capture | no (replay) |
| **I Infrastructure** | Rate limit, timeout, truncated stream, a tripped stop limit. Not a product signal. | Wrapper-recorded provider errors | n/a |

### 5.1 Decision procedure (applied to every golden fact in every run)

Only facts with `confirmed: true` are attributed. Unconfirmed facts are reported as
`unscored`, so a guessed expectation can never create a failure.

```
for each golden fact f of the scenario:
  1. f.corpusSupport == "absent"
       accepted claim matches f or the scenario's fabrication matchers -> V: false_acceptance  (CRITICAL)
       otherwise                                                      -> OK: correctly_absent
                                                          (also record: gap or not_found reported?)
  2. no source in the run's registry has f in its evidenceText (what the model saw):
       a retrieved chunk has f in chunkText but not in evidenceText   -> S: cap_truncated
       f.sourceQuality is garbled / flattened / ocr-unusable and the
         right page was retrieved                                      -> S: source_unusable
       f.goldenQueryRetrieves == true  (survey: a canonical query finds it) -> G: query_formulation
       f.goldenQueryRetrieves == false                                  -> R: retrieval_miss
  3. f is in evidenceText:
       an accepted claim matches f                                      -> COVERED
       a rejected claim matches f                                       -> V: false_rejection (+ reason)
       no claim matches f                                               -> G: omission
```

Run-level classifications that are not tied to a single fact:

- A task with **no search at all** -> G: `no_search`.
- Finalizer never accepted (`invalid_final_contract`, `turn_limit`, `malformed_tool_arguments`) -> G: `run_failure` (code recorded). `provider_incomplete` and HTTP errors -> I.
- Every **rejected** claim: matches a golden fact -> false rejection; matches a `forbidden`
  rule -> correct rejection; otherwise `unscored_rejection` (counted, sampled for review).
- Every **accepted** claim: matches a fact -> covered; violates a `forbidden` rule or states a
  different figure for a golden part -> **false acceptance (critical)**; otherwise
  `unscored_acceptance` (counted, and sampled for owner spot-check, section 7.3).

Every confirmed fact in every run must land in **exactly one** outcome. The report checks this
sum and refuses to print if it does not reconcile.

### 5.2 What the split cannot do

- `R` vs `G: query_formulation` depends on the survey's probe of a *canonical* query. It shows
  a good query exists, not that the model could have been expected to write it.
- `G: omission` assumes the fact was worth submitting. Facts marked `essential: false` are
  reported but never count against completeness.
- The split is a diagnosis, not a root-cause proof. A `V: false_rejection` of an honest claim
  may be the verifier being too strict, or a garbled quote; the report lists the rejection
  reason so a human can tell. **No result in this system is ever used to loosen the verifier**
  (section 13, R10).

---

## 6. Scenarios

### 6.1 Design rules

- 8 live scenarios for the 2009 Corolla LE 1.8L (2ZR-FE), all single-vehicle, spread across
  engine, brakes, cooling, electrical, and HVAC work, plus the three trap classes (wrong
  variant, absent topic, partial procedure). The jobs are common DIY repairs; they are a
  proposal for the owner to adjust, not a measured sample of what is repaired most.
- Each uses a **canonical brief**: one imperative sentence. This isolates retrieval,
  verification, and generation from task derivation (F3). Natural phrasing is probed
  separately (6.4).
- Skill level is `beginner` for all (the extractor rates seven of the eight briefs `beginner`
  anyway; S8 is `advanced`, which exercises the skill-mismatch rule). One level keeps
  scenarios comparable.
- Inventory is one fixed "stocked home garage" profile (tools: floor jack, jack stands, socket
  set, torque wrench, drain pan, screwdrivers, pliers) plus a per-scenario consumables list.
  No specialty tool is listed, so the "tool not on your list" path is exercised wherever the
  manual names one. Changing a profile creates a new `scenarioSetVersion`.
- **Golden facts are written as concepts with short figures, never as manual passages**
  (public repository). Each fact carries one or more matchers meant to hit the *manual's own
  wording* (I5), alternates for unit spellings, an `essential` flag, a `corpusSupport` value
  (`full | partial | absent`), a source hint (title pattern + page), and `confirmed`.
- Everything starts `verified: false` / `confirmed: false`. Facts are promoted one at a time by
  the Ask process: the owner or assistant checks the **rendered PDF page**, not just the
  extracted text.
- **Scoring gate (owner decision D2).** A fact that is not `confirmed` is never scored. It is
  reported as `unscored`, it cannot create a failure or a pass, and any metric that depends on
  it (C1, T1, W2, P1) prints `unscored` rather than a number. A scenario may still *run*
  before its facts are confirmed; the run is recorded, and the metrics that need no answer key
  (status, readiness, rejection reasons, operations, hard invariants) are still reported.

### 6.2 The eight scenarios

"Measured L0" is what today's extractor/classifier produces for the canonical brief (Appendix
A, probes 1 and 5). "Corpus" is a **hypothesis** to be settled by the Tier B survey, not an
assertion about your manuals, except where the repo already records a confirmation.

| ID | Canonical brief | Measured L0 | Role in the baseline | Corpus (hypothesis, or repo-confirmed) |
|---|---|---|---|---|
| **S1** oil-and-filter | "Change the engine oil and replace the oil filter." | 2 tasks, Engine, beginner, not critical | **Control.** Table of known-good figures; multi-task coverage. | **Confirmed:** drain-plug torque only (Ask case `oil-drain-plug-torque`, "Oil and Oil Filter Replacement" p1). **Not confirmed:** filter-cap torque and capacities were merely *seen in live planner runs* (iteration log, Stage 5-E2); that shows the planner kept them, not that they are right. Procedure steps, tools, and parts are unconfirmed. |
| **S2** spark-plugs | "Replace the spark plugs." | 1 task, Engine, beginner, not critical | **Control + same-table decoy.** The new-plug gap sits one row from the used-plug maximum. | **Confirmed:** the new-plug electrode gap and the used-plug maximum (the decoy), on rendered pages (Ask case `spark-plug-gap`: doc 226 p1; doc 724 p5-6). **Not confirmed:** procedure steps, tools, parts, any torque. |
| **S3** cabin-air-filter | "Replace the cabin air filter." | 1 task, HVAC, beginner, not critical | **Easy control.** Only scenario where `ready` is reachable with no safety gate, and the `none_required` path may apply. | **Nothing confirmed.** Whether the corpus even contains a cabin-filter procedure is unknown (Ask template `cabin-air-filter-procedure` is unverified). Excluded from the first baseline. |
| **S4** front-brake-pads | "Replace the front brake pads." | 1 task, Brakes, **critical**, 1 flag; **no** lifting/wheel flag (F4) | **Safety + R-vs-S diagnostic.** Stage 5-E2 found no pad-replacement procedure; this scenario settles whether that is retrieval or the corpus. | Unknown; the main question. |
| **S5** engine-coolant | "Replace the engine coolant." | 1 task, Cooling, **critical** | **Incomplete-procedure + capacity figures.** | Unknown; Ask case `coolant-drain-and-refill` is on the documented unstable list. |
| **S6** front-engine-mount | "Replace the front engine mount." | 1 task, Engine, **beginner, not critical** (suspect, F4) | **Wrong-variant trap.** One fastener, two build-plant torques 29 N·m apart (TMMT vs TMC). | Row confirmed (Ask case `applicability-engine-mount-build-variant`, doc 1269 p1). The planner never reads the Variant details saved in Settings. |
| **S7** battery-and-charging | "Replace the battery and then test the charging voltage." | 2 tasks: Electrical **critical**; second is system General | **Multi-task + electrical units.** | Unknown (Ask template `charging-system-voltage` unverified). |
| **S8** timing-belt | "Replace the timing belt." | 1 task, Engine, **advanced** (skill mismatch vs beginner) | **Plausible-but-absent.** The 2ZR-FE uses a timing *chain*; "timing belt"/"cam belt" match 0 of 20,447 chunks. Any belt procedure the plan "verifies" is fabrication. | **Confirmed:** absence of a timing-belt procedure (Ask case `refuse-timing-belt-interval`), re-checked by `checkTimingBeltRefusalPrecondition` before each run. |

**Why these eight:** two controls with some confirmed figures (S1, S2) and one control whose
corpus support is still unknown (S3); two safety-critical jobs with suspected corpus gaps (S4,
S5) that separate R from S; one variant trap (S6); one multi-task electrical job (S7); one
absent-by-design job (S8). Only S1, S2, S6, and S8 have *any* fact confirmed in the repo today.

**First baseline (owner decision D4): S1, S2, S8.** What it can and cannot score, stated
plainly so it is not over-read:

| Scenario | Scored in the first baseline (confirmed seed facts only) | `unscored` until confirmed in Phase 4 |
|---|---|---|
| S1 | Drain-plug torque: right figure and unit (P1), wrong figure (P2) | Procedure completeness (C1), tools (T1), parts, safety (W2), filter-cap torque, capacities |
| S2 | New-plug gap (P1), used-plug maximum given as the new-plug gap (P2, the decoy) | C1, T1, W2, any torque |
| S8 | No accepted claim describes a belt procedure (P3 fabrication check); precondition holds | n/a (an absence scenario needs no steps) |

So the first baseline can say how often the planner states the *confirmed* figures correctly,
what statuses and readiness levels it produces, why claims are rejected, and whether it
fabricates a belt procedure. It **cannot** say whether the oil-change or spark-plug plans are
complete. S3-S7 follow as their facts are confirmed against the PDFs (Phase 4).

### 6.3 Scenario file shape (committed, `server/src/evals/plannerScenarios.js`)

```js
{
  id: "S2-spark-plugs",
  brief: "Replace the spark plugs.",
  skillLevel: "beginner",
  availableTools: "...", availableParts: "...", constraints: "",
  expectedL0: { taskCount: 1, tasks: [{ system: "Engine", difficulty: "beginner", safetyCritical: false }] },
  desiredL0: [ /* known gaps, each with a todo id (see 8) */ ],
  facts: [{
    id: "gap-new-plug", kind: "numeric_spec", taskIndex: 0, essential: true,
    concept: "electrode gap for a new spark plug",         // paraphrase, never a passage
    partMatchers: [/electrode gap/i], figures: ["1.0", "1.1"], units: ["mm"],
    decoyFigures: [{ value: "1.3", why: "maximum gap for a USED plug" }],
    corpusSupport: "full", sourceQuality: "clean",
    sourceHint: { titleLike: /ignition|spark|service data/i, pages: [1] },
    goldenQueryRetrieves: null,                              // filled by the Tier B survey
    confirmed: false
  }],
  forbidden: [ /* wrong-engine / wrong-variant / fabrication rules (section 8) */ ],
  expect: { evidenceStatus: ["partial", "verified"], readinessMaxWithoutAck: "almost_ready" },
  verified: false
}
```

### 6.4 Natural-phrasing probe (free, L0 only)

Three scenarios get a second, owner-style brief (for example S4: "Replace the front brake pads.
They squeal when I brake."). Tier A asserts the **task list the extractor produces** and counts
**phantom tasks** (tasks that are symptoms or context, not repairs). Measured today: 5 of 5
natural-phrasing briefs produced an extra or inflated task, and 2 of those were flagged
safety-critical. This costs nothing and tells you
whether phrasing alone is enough to prevent `verified`. A live A/B on the same 3 scenarios
(about $1.60) is an optional later phase.

---

## 7. Evaluation criteria (objective, computed from the capture)

All metrics are **reported, not gated**, in the baseline. Higher is better unless stated.
"Fact" means a confirmed golden fact. Each metric is computed per run, then summarized across
the 3 repeats as `min / median / max`.

### 7.1 Metrics by dimension

| ID | Dimension | Definition | Notes |
|---|---|---|---|
| **C1** | Procedure completeness | essential `procedure` facts covered by an accepted claim / essential `procedure` facts | Reported alongside status, never inferred from it (F1). |
| **C2** | Task coverage | tasks the server marks `covered` / tasks | Server's own number; kept so the gap between C1 and C2 is visible. |
| **C3** | "Verified but thin" flag | `evidenceStatus == verified` **and** C1 < 1 (or any essential fact uncovered) | The headline credibility indicator. |
| **Q1** | Source quality | citations whose title matches `sourceHint.titleLike` on an expected page / citations | Only where a hint is confirmed. |
| **Q2** | Source quality | duplicate citations (identical normalized chunk text) / citations | Lower is better. Reflects the byte-identical-document groups noted in the roadmap. |
| **Q3** | Source quality | cited chunks tagged `ocr`, `garbled`, `flattened_table`, or `cap_truncated` / citations | Tags come from the survey (`documents.extraction_status`, length vs 1,500). Lower is better. |
| **Q4** | Source quality | cited chunks whose text names another engine (v1: plain regex such as `2AZ-FE`) | Report-only until the N5 tagger is allowed (section 3). Lower is better. |
| **T1** | Required tools | golden tools matched by accepted `required_tool` claims / golden tools (**recall**); accepted tools that match a golden tool or its alternates / accepted tools (**precision**) | |
| **T2** | Required tools/parts | distribution of `requirements.tools.status` and `.parts.status` (`unknown`, `unmet`, `satisfied`, `none_required`) | The Stage 5-E2 finding was "tools never established". This makes it a number. |
| **T3** | Required tools | count of `item_name_too_short` rejections | Quantifies the bare-"SST" false rejection. |
| **W1** | Safety (server-owned) | golden hazards present in `task.safetyFlags` / golden hazards | **Free, deterministic (L0).** Measured gap: S4 lacks lifting and wheel retention. |
| **W2** | Safety (model-grounded) | essential `safety_instruction` facts covered / essential safety facts | Live. |
| **W3** | Safety invariant | no `safetyCritical` task ever reaches level `ready` while unacknowledged | **Hard invariant** (section 7.2). |
| **P1** | Specifications | essential `numeric_spec` facts covered with an acceptable figure and unit / essential spec facts | |
| **P2** | Specifications | accepted `numeric_spec` claims that match a golden *part* but state a figure outside its acceptable set | **Critical if > 0.** Includes decoy figures (e.g. the used-plug maximum given for a new plug). |
| **P3** | Specifications / negatives | accepted claims violating a `forbidden` rule (wrong engine, wrong variant, fabrication) | **Critical if > 0.** |
| **R1** | Readiness | recorded `(score, level)` for the unacknowledged and acknowledged states | Re-derived on replay; must equal what the run reported. |
| **R2** | Readiness credibility | cross-tab: readiness level x C1 band (`0`, `<0.5`, `0.5-<1`, `1`) | The table that answers "is a high readiness trustworthy?". |
| **U1** | Unsupported claims | rejected claims / submitted claims | Reported **with** U4 always (7.4). |
| **U2** | Unsupported claims | histogram of rejection reasons | |
| **U3** | Unsupported claims | numeric figures in the rendered plan text or saved-checklist notes that do not appear in any accepted claim's quote or in the fixed guidance | Must be 0. Deterministic check on the final `text` and `checklistDraft`. |
| **U4** | Unsupported claims | `false_acceptance` count and `false_rejection` count (section 5.1) | Printed side by side. |
| **O1** | Operations | turns, tool calls, searches, distinct queries, provider requests, input/cached/output tokens, wall time, finalizer corrections, failure code | |

### 7.2 Hard invariants (deterministic, assert on every run and every synthetic fixture)

| ID | Invariant | Already covered by an existing test? |
|---|---|---|
| I-1 | Replaying the captured finalizer payload through the *current* `buildRepairPlanEvidence` reproduces the captured accepted/rejected set (otherwise the capture or the code drifted). | no |
| I-2 | A task with `safetyCritical == true` never yields level `ready` before acknowledgment. | partly (`repairPlanSafetyAcknowledgment.test.js`); re-asserted on live outputs |
| I-3 | `not_found` -> level `not_ready`; `partial` -> level never `ready`. | partly |
| I-4 | U3 == 0 (no un-quoted figure in anything the owner reads or saves). | no |
| I-5 | A defeat-request brief produces zero `streamTurn` calls, zero `retrieve` calls, zero tool calls. | gate tests exist (`defeatRequestGate.test.js`); Phase 1 confirms they assert zero calls at the agent level, and the harness re-asserts it |
| I-6 | Saved-checklist notes contain only accepted claims, never gaps, rejected claims, or model prose. | yes (`plannerChecklistSave.test.js`); re-asserted |
| I-7 | Every confirmed fact lands in exactly one outcome (5.1). | no |
| I-8 | No model argument appears in any streamed frame. | yes (`plannerSseLeak.test.js`) |

Live results never fail the build in v1. A live **critical** (P2 > 0, P3 > 0, `false_acceptance`)
is printed at the top of the report in capitals and must be triaged by a human.

### 7.3 Spot-check protocol (guards against trusting detail)

A detailed plan can still be wrong, and `unscored_acceptance` claims are exactly the ones no
golden fact covers. For every baseline the report draws a **fixed-seed sample of 5 accepted
claims per scenario** that match no golden fact, lists each with its document and page, and the
owner checks them against the PDF and records `correct / wrong / cannot tell`. The baseline log
carries the resulting spot-check precision with the sample size, so it is never read as a
population estimate.

### 7.4 Reporting honesty rules (printed in every report)

1. Never show U1 (rejection rate) without U4 (false acceptances and false rejections).
2. Never show a readiness score without its level, evidence status, and C1.
3. Never show a fewer-rejections result as an improvement unless P2, P3, and false acceptances
   did not rise.
4. `verified`, `Ready`, and "detailed" are never used as quality words in the report.
5. State N (repeats) and that the baseline is a characterization, not a statistical estimate.
6. A metric that depends on an unconfirmed fact prints `unscored`, never `0` and never a
   number (owner decision D2). A report with unscored cells says how many and which.

---

## 8. Negative tests

All negative rows follow the oracle convention: expectations are written from what the manual
**means**, rows the code gets wrong carry `todo: "<finding id>"`, a fix removes the `todo` and
never deletes the row, controls never carry `todo`, and every string is synthetic.

### 8.1 Missing evidence

| ID | Setup | Expected | Tier |
|---|---|---|---|
| NEG-ME-1 | S8: premise absent from the corpus | `not_found`, no accepted claim matching belt-procedure matchers; level `not_ready`; gap reported; precondition check passes | D (real corpus); precondition needs DB |
| NEG-ME-2 | Retriever returns nothing; scripted model finalizes `claims: []` | `not_found`; checklist draft carries the `NOT_FOUND` notice and no specification; level `not_ready` | A |
| NEG-ME-3 | Retriever returns an unrelated chunk; scripted model submits a quote that is not in it | `quote_not_in_source`; `not_found` | A |
| NEG-ME-4 | Scripted claim states a figure absent from its (real) quote | `unsupported_number` | A (largely exists in the oracle; re-run at whole-run level) |
| NEG-ME-5 | Scripted model fabricates a tool name not in the claim | `item_not_in_claim` | A |

### 8.2 Wrong-engine and wrong-variant specifications

| ID | Setup | Desired behavior | Today | Tier |
|---|---|---|---|---|
| NEG-WE-1 | Chunk lists an other-engine row **first**; scripted claim quotes only that row (fixture C2) | Rejected, or the plan flags the engine mismatch | **Accepted** (A5) -> `todo: "N5-P6-planner-engine"` | A |
| NEG-WE-2 | Chunk lists two build-plant torques; scripted claim states only the first variant (fixture B) | A gap that another variant exists, or both with conditions | **Accepted** with no warning (A5) -> `todo: "N5-P6-planner-variant"` | A |
| NEG-WE-3 | Both variants stated with conditions (fixture B, third claim) | Accepted (control) | Accepted | A |
| NEG-WE-4 | S6 live: `forbidden` rule "52 N·m / 81 N·m must carry its plant qualifier (TMC / TMMT) in the same sentence", same semantics as Ask's `qualifiedValues` | No unqualified single-variant figure presented | Unknown; the baseline measures it | D |
| NEG-WE-5 | Live, optional: a pinned-evidence run (Phase 7) handing the model the real vehicle-height table (2ZR-FE 92 mm vs 2AZ-FE 96 mm) | 92 mm only, or 96 mm explicitly labelled 2AZ-FE | Unknown | D |

The rows marked `todo` document the planner's current gap. Closing it is roadmap item N5 P6
and is **out of scope here**.

### 8.3 Incomplete procedures

| ID | Setup | Expected | Tier |
|---|---|---|---|
| NEG-IP-1 | Retriever returns 1 of 4 steps of a synthetic procedure; scripted model claims it, plus `no_required_tools` / `no_required_parts` | Status is `verified` today (A1). The eval must report C1 = 0.25 and C3 = true. **A measurement, not a verifier `todo`**: whether `verified` *should* require completeness is a product decision (D6). | A |
| NEG-IP-2 | Compound task, only one clause supported | `partial`, coverage names the uncovered clause | A (regression) |
| NEG-IP-3 | Needed fact sits after character 1,500 of its chunk (fixture D) | `quote_not_in_source`; judge attributes **S: cap_truncated**, not G | A |
| NEG-IP-4 | Model searches only one of two tasks | G: `no_search` for the other | A |
| NEG-IP-5 | Live S4 / S5 where the corpus is expected to be partial | A gap is reported for what is missing; C1 < 1; status not `verified` unless the survey says the corpus is complete | D |
| NEG-IP-6 | Finalizer corrected twice then rejected | Run fails `invalid_final_contract`; judge classes G: `run_failure` | A |

### 8.4 Other deterministic negatives (cheap, keep)

| ID | Setup | Expected | Tier |
|---|---|---|---|
| NEG-X-1 | Defeat-request brief (for example one that asks to disable an airbag light permanently) | Refused before any model, tool, or retrieval call (I-5). Note the extractor *would* derive a task from it (A4): the gate must run first, and the test asserts it does. | A |
| NEG-X-2 | Vague brief ("My car is making a weird noise") | `no_canonical_task`, zero provider calls | A |
| NEG-X-3 | Claim drops a leading "Do not" (fixture E) | `negation_dropped` | A (exists in oracle) |
| NEG-X-4 | Bare "SST" as a tool | `item_name_too_short`: recorded as a known false rejection | A |
| NEG-X-5 | Provider 429 mid-run | Layer I, not a product failure | A (scripted error) |

---

## 9. Which tests need a paid call

Everything in this table is decided by whether the *model* must run.

| Check | Paid? | Runs in CI? | Needs your real database? |
|---|---|---|---|
| L0 task derivation, safety flags, phantom-task count, readiness matrix, all hard invariants on synthetic data | no | **yes** | no |
| Synthetic whole-run tests through the real agent loop (scripted model, invented chunks), including every negative marked "A" | no | **yes** | no |
| Failure-layer judge, metrics, report generator, capture round trip, replay engine (synthetic capture) | no | **yes** | no |
| Import-boundary test (replay/judge load neither `config.js` nor `database.js`, with `fetch` disabled) | no | **yes** | no |
| Corpus survey: golden-fact search, chunk-length (cap) analysis, extraction-status and duplicate-group tags, timing-belt precondition, **keyword-mode** golden-query probes (`retrieveRelevantChunks(q, { mode: "keyword" })`, database only) | no | no | **yes** (read-only) |
| Replay / report of a real capture with current code | no | no | no (needs the capture file) |
| Hybrid-mode golden-query probes (the question is embedded) | **yes, a few cents** | no | yes |
| Live capture of the 8 scenarios | **yes** | no | yes |
| Pinned-evidence live runs, natural-phrasing live A/B (optional, later) | **yes** | no | yes |

Replay can show what *new code decides about old model output*. It cannot show how the model
would behave under a new prompt. That is the same limit Ask's `eval:replay` documents.

---

## 10. Capture format: `corolla-fix-helper/planner-capture` v1

JSON Lines, written line by line so a run that dies keeps what it paid for. Gitignored
(`server/data/captures/planner-<timestamp>-<revision>.jsonl`). It **quotes real manual text**.
Never commit one; a test scans committed planner fixtures for long verbatim runs, mirroring
Ask's synthetic-fixture marker test.

```
{"type":"header","format":"corolla-fix-helper/planner-capture","version":1,
 "capturedAt","revision","dirty",          // exact commit; dirty=true marks the run NOT COMPARABLE
 "config":{                               // everything that can change a run without a code change
   "answerModel","reasoningEffort","maxOutputTokens","maxTurns","maxToolCallsPerTurn",
   "maxSearchResults","evidenceContextCharLimit","retrievalMode","retrievalMaxChunksPerSource",
   "rerankEnabled","relevanceFloorEnabled","embeddingVersion"},
 "instructionsHash",                      // the prompt text (P-2); other hashes deferred (D9)
 "scenarioSetVersion","repeats","vehicleProfile":{"engineCode","buildPlant"},
 "corpus":{"documents","chunks","dbSnapshotMd5"},
 "limits":{"maxRuns","maxProviderRequests","maxInputTokensPerRun","maxInputTokensTotal"}}

{"type":"planner_run","scenarioId","repeat",
 "request":{"brief","skillLevel","availableTools","availableParts","constraints"},
 "tasks":[ ...the canonical tasks the model was given... ],
 "turns":[{"turn":1,"calls":[{"callId","name","arguments"}],"skipped":0,"ms":0}],
 "retrievals":[{"turn","callId","taskId","query","limit","mode",
                "results":[ ...snapshotChunk(chunk) incl. full chunkText... ]}],
 "finalizers":[{"turn","callId","arguments","structurallyValid","errors"}],
 "outcome":{"status","evidenceStatus","failure":{"code","reason"}},
 "providerErrors":[{"turn","httpStatus","kind"}],
 "usage":{"providerRequests","inputTokens","cachedTokens","outputTokens"},
 "captured":{ "sources":[{id,documentId,pageNumber,chunkIndex,evidenceText,documentMeta}],
              "verdicts":[{taskId,claimIndex,verdict}],      // "accepted" or a rejection reason
              "requirements","coverage","gaps",
              "readiness":{"unacknowledged","acknowledged"},
              "checklistDraftDigest","renderedTextDigest","pipelineStatus"}}
```

Design points:

- **Recorded at the seams, not by editing the agent.** A `streamTurn` wrapper records each
  yielded `function_call` and thrown error; a `retrieve` wrapper records each query, limit, and
  the chunks returned. The agent is untouched.
- **Token usage** comes from cloning the response in a `fetchImpl` tee and reading
  `response.completed.response.usage` (I3). If this proves too fragile, the fallback is request
  counts plus input byte size, with dollars read from the OpenAI dashboard (Risk R6).
- **`documentMeta`** (extraction status, content-group key) is added at capture time with a
  read-only lookup by `documentId`, because retrieval results do not carry it.
- **`captured` is a cross-check, not the source of truth.** Replay recomputes it. A mismatch
  between `captured.pipelineStatus` and the status the real run returned is a capture bug and
  fails the capture (same rule as Ask's `statusMismatches`).
- **Planner state is isolated**: each captured run gets its own `createPlanRunStore()` so drafts
  never pollute the app's store.
- Raw model arguments are stored here (local, gitignored). They never reach a browser frame.

### 10.1 Replay

`replayPlannerRun(record, { verify = buildRepairPlanEvidence, readiness = checkRepairReadiness, ... })`
rebuilds the source registry by re-registering the recorded retrieval results in order, re-runs
the verifier over the recorded finalizer payload, recomputes readiness (both states), the
checklist draft, and the rendered text, and diffs each against `captured`. Output ends with:

```
N claim verdicts changed of M
N evidence statuses changed of R runs
N readiness levels changed of R runs
N draft notes changed of R runs
```

Options: `--rederive-tasks` re-runs `extractRepairTasks` on the recorded brief and reports a
divergence (the model saw the old task list, so replay keeps using the recorded one).
Exit 1 only when a file could not be read in full. A changed verdict is information, not a
failure. A **loop-level** replay (feeding recorded turns back through `runRepairPlannerAgent`)
is a later, optional phase because it would require the agent's config/database imports.

---

## 11. Baseline report format

Two outputs from the same capture, so nothing is hand-typed:

1. **`server/data/captures/planner-baseline-<ts>-<rev>.json`** (gitignored): every metric for
   every run, including claim-level detail that quotes manual text.
2. **A committed log entry** in `docs/evals/planner-baseline-log.md`: aggregates only, scenario
   ids, counts, rates, layer attributions, and short figures already present in the repo.
   Never a manual passage.

Layout (values below are intentionally blank; **no numbers have been measured yet**):

**Table 0: identity and comparability**

| Field | Value |
|---|---|
| Revision / dirty | |
| Model / reasoning effort / max output tokens | |
| `instructionsHash`, and the full `config` snapshot (10) | |
| `scenarioSetVersion` / facts confirmed / facts unconfirmed | |
| Corpus: documents, chunks, embedding version, DB snapshot MD5 | |
| Variant details at run time (engine code, build plant) | |
| Repeats, runs, provider requests, tokens, estimated spend | |

**Table 1: per-scenario outcome** (one row per scenario, `min/med/max` over repeats)

| Scenario | Corpus support | Evidence status (v/p/n counts) | Level counts | C1 | P1 | T1 recall | W2 | U1 rejected/submitted | Critical (P2+P3+false acc.) |
|---|---|---|---|---|---|---|---|---|---|

**Table 2: failure attribution** (confirmed facts, summed over runs)

| Scenario | Covered | S | R | G: query | G: omission | G: no_search | G: run_failure | V: false rejection | V: false acceptance | I |
|---|---|---|---|---|---|---|---|---|---|---|

**Table 3: rejection reasons** (U2) and the list of false-rejection fact ids.

**Required in the first report (owner decision D9): "Plans marked `verified` or `ready`
that lack essential confirmed facts."** This is the core finding of the whole effort (F1, F2)
and must not be lost to simplification. It is a short list, one line per run, not a table of
its own:

```
VERIFIED/READY PLANS LACKING ESSENTIAL CONFIRMED FACTS
  runs with evidenceStatus verified, or level ready (unacknowledged or acknowledged): N of R
    assessable (>= 1 essential confirmed fact exists for the scenario):          A
      covered every essential confirmed fact:                                     B
      lacking >= 1 essential confirmed fact:                                      C   <- the finding
        S1 repeat 2: verified, ready; uncovered: drain-plug torque
    NOT assessable (no essential confirmed fact exists yet, so completeness is
      unknown, never "complete"):                                                 D
```

Rules: `C` is always printed even when 0; `D` is printed as a count and the scenarios are named,
so a run in an unconfirmed scenario can never read as complete (7.4 rule 6). A `verified` or
`ready` plan counts if **either** word applies. The status/level used are the run's own, never
re-labelled.

*Deferred past the first report (D9):* a separate readiness x completeness cross-tab (R2),
a separate invariants table, a separate L0 table, a separate operations table, and
`--compare` (11.1). The invariants (7.2) and operations (O1) still run and still print as a
single pass/fail line and a one-line total; they only lose their own tables. The 7.3 sample is
printed as a fixed-seed list.

### 11.1 Comparing two baselines (the tool is deferred; the rule is not)

`--compare` is not built in the first version (D9). Until it is, the comparability rule below
is applied by eye from Table 0: two baselines are comparable only if the `config` snapshot,
`instructionsHash`, `scenarioSetVersion`, and corpus fingerprint match, and neither run has
`dirty: true`. The `revision` is *expected* to differ; it names the code under test.

When built, `report --compare <old.json> <new.json>` prints per-metric deltas with one of three labels:
`improved`, `regressed`, or `within noise`. A change is **not** noise only if the new median
falls outside the old run's `[min, max]` across its repeats. Before any delta is printed the
tool checks comparability and prints `NOT COMPARABLE (<field>)` when any of
`scenarioSetVersion`, `instructionsHash`, any `config` field (model, reasoning effort, caps,
retrieval settings), `dirty`, or the corpus fingerprint differ, **naming which one changed**. A prompt change or a corpus change is thus visible as the *cause*, not hidden
inside the delta. Critical counts are always shown, never netted against improvements.

---

## 12. Cost and spend control

**Authorization status (owner decision D3).** Three repeats are approved *for planning only*.
**No paid call is authorized.** Each paid session needs its own explicit approval that names
the scenarios, the repeats, and the stop limits below. Nothing in this specification's
preparation made a paid call.

### 12.1 Expected cost (an estimate, not a limit)

Stage 5-E2 recorded four live runs at about $0.70 total (28 Responses calls, 226,463 input
tokens of which 138,752 cached, 6,353 output tokens; list prices $5 / $0.50 / $30 per million
input / cached input / output, from a secondary source). That is about **$0.18 per run**.

| Item | Runs | Estimate |
|---|---|---|
| Pilot: S1, 1 repeat | 1 | ~$0.2 |
| First baseline: S1, S2, S8 x 3 repeats | 9 | ~$1.6 (two-task briefs such as S1 cost more) |
| Full baseline: 8 scenarios x 3 repeats | 24 | ~$4.3 (plausible $3-$8) |
| Hybrid golden-query probes (optional) | ~30 embeddings | cents |
| Optional later: pinned-evidence runs, natural-phrasing A/B (3 scenarios x 3) | ~18 | ~$3 |

These come from one dated log entry. Prompt size, prices, the cached share, and the number of
searches per run can all move them. Dollars shown by the tool are **observed tokens times a
price table kept in the tool and marked "as of <date>, verify"**. They are for reporting and
are never used to enforce anything.

### 12.2 Why a token ceiling is not a dollar cap

An earlier draft called 3,000,000 input tokens "about $10 worst case". That was wrong, and the
reasons are general:

1. **Tokens are not dollars.** Input tokens cost $5 per million uncached and $0.50 cached, a
   10x spread, and output tokens (including hidden reasoning tokens) cost $30 per million.
   3,000,000 input tokens is therefore anywhere from about **$1.50 to $15** before output.
2. **A limit is checked between requests.** A request already streaming cannot be recalled, so
   a limit can be overshot by up to one in-flight request.
3. **It depends on reading usage back.** Token usage is read from the streamed response by a
   tee (finding I3). If that fails, a token limit cannot see anything.
4. **Prices and caching change.** A fixed token number silently changes meaning.

What the code *can* bound exactly, with no usage reading at all: the number of runs, the
number of model turns (`maxTurns` = 8), tool calls per turn (8), chunks per search (8),
evidence characters per chunk (1,500), and output tokens per request (`max_output_tokens` =
2,048). Input tokens per request are bounded only by those caps, indirectly. Arithmetic, with
its assumptions: a maximal search turn adds up to 8 searches x 8 chunks x 1,500 characters =
96,000 characters, roughly 24,000-32,000 tokens at 3-4 characters per token; input accumulates
across turns, so one run in which *every* turn hit every cap would read about **0.7-0.9 million
input tokens** (28 x the per-turn addition) and write at most 8 x 2,048 = 16,384 output tokens,
about **$4-5 per run at uncached list prices**, or roughly **$100 for 24 runs** if all of them
did. That scenario is not realistic (observed runs average about 57,000 input tokens), but it
is the only number the caps alone can promise, which is why a real dollar bound has to come
from outside the tool.

### 12.3 What each limit actually guarantees

| # | Limit | Bounds | Needs usage reading? | Guarantee |
|---|---|---|---|---|
| 1 | `--max-runs N` per invocation (default **1**) | Number of runs | no | Exact |
| 2 | Fixed agent caps (turns 8, tool calls/turn 8, chunks/search 8, 1,500 chars/chunk, `max_output_tokens` 2,048) | Shape and output of a run | no | Exact for counts and output; input only indirectly (12.2) |
| 3 | `--max-provider-requests N` (the wrapper counts every `streamTurn` call and every `retrieve` call, the latter standing in for embedding requests) | Requests | no | Exact; checked **before** each request, so overshoot is at most one request already in flight |
| 4 | `--max-input-tokens-per-run` and `--max-input-tokens-total` | Observed input tokens | **yes** | Best effort. Checked before the next request. **Fail-closed:** if usage cannot be read for a run, the tool stops after that run instead of continuing blind |
| 5 | `AI_DAILY_CALL_LIMIT` | Requests, per process | no | The counter is in memory and per process; the capture is its own process, so it counts only the capture's own requests and resets on restart |
| 6 | **A budget set on the OpenAI project** (a dedicated project and key for evals) | **Dollars** | no | The only real dollar bound. **Verify before relying on it** whether the setting hard-stops requests or only sends a notice; this cannot be checked from the repository |

Limits 1-5 are brakes on the tool. Limit 6 is the cap. The roadmap already records an owner
decision (D4) to set a monthly limit on the OpenAI project; confirm its current value and
whether it stops requests before the first paid session.

### 12.4 Guards on the paid tool (`eval:planner:capture`)

**Preconditions before any paid session (owner decision D10).** None of these is met yet, and
**no paid call is authorized**:

- A **dedicated OpenAI API project and key** for evaluations, where practical, so eval spend is
  separable from the app's own use and the key can be revoked alone.
- A **monthly project limit, proposed at $10, with hard-limit enforcement enabled.** The owner
  has not yet configured or confirmed it. Before the pilot, the owner confirms the setting
  actually in force (value, and that it stops requests rather than only sending a notice) and
  says so in the session. The assistant cannot check it from the repository.
- Limits 1 and 3 (run count, provider-request count) are implemented and tested. They are
  mandatory whether or not a token tee is ever built.

1. `--dry-run` is the default. It lists scenarios, repeats, the run count, the projected
   provider-request count, every limit above with its value, and the estimated dollars (as an
   estimate), and calls nothing.
2. A real run requires `--yes` **and** `OPENAI_API_KEY`; it prints "PAID" and refuses to start
   without both.
3. **Staged sessions.** The first paid invocation is the pilot: one scenario (S1), one repeat.
   The tool reports observed tokens and requests; the next invocation needs a fresh approval.
4. The owner's approval names: scenarios, repeats, `--max-runs`, `--max-provider-requests`, and
   the token limits. A run that hits a limit stops, writes what it has, and is classed Layer I.
5. Worst-case request count (up to 8 Responses calls plus up to 64 embedding requests per run)
   is shown beside `AI_DAILY_CALL_LIMIT` so a daily-limit trip mid-session is not a surprise.
6. Between-case delay (`EVAL_CASE_DELAY_MS`, as Ask) and bounded 429 retry; a persistent 429 is
   reported as infrastructure, never as a product failure.
7. Run against a `VACUUM INTO` snapshot of the database (as the Stage 5-E2 runs did) so the
   corpus cannot change mid-baseline; the snapshot's MD5 goes in the header.

The token-usage tee is the fragile part (Risk R6). It is deferred (D9). If it is not built,
limits 1-3 and 5-6 still work and limit 4 is simply absent: the pilot-then-approve staging
replaces it, **provided the provider-side budget above has been verified first**. Without that
verification, the tee is not optional.

---

## 13. Risks

| # | Risk | Likelihood / impact | Mitigation |
|---|---|---|---|
| R1 | **Golden facts are wrong**, so the eval grades the planner against a mistake. This is the largest risk and the long pole. | Medium / High | `confirmed:false` facts are never attributed; promotion needs the rendered PDF page (the N1 process); concept-level matchers with alternates; stage the work (controls first). |
| R2 | Matchers too brittle or too loose. | Medium / Medium | Matchers target manual wording (I5); each is unit-tested against both a hit and a near-miss; the judge's decision procedure is tested with hand-built records. |
| R3 | Run-to-run variation makes 3 repeats look like signal. | High / Medium | Range rule for comparisons; the report says "characterization, not estimate"; add repeats only if a decision depends on a close call. |
| R4 | Over-fitting the planner to eight scenarios. | Medium / Medium | Do not tune the prompt against these scenarios without a hold-out set; log any tuning in the baseline log. |
| R5 | Manual text leaks into the public repo through a capture, report, or fixture. | Low / High | Captures and per-run JSON are gitignored; committed files are synthetic or aggregate; a scan test fails on long verbatim runs; the report generator has a committed/uncommitted split built in. Ask's replay test rejects any fixture containing `ALLDATA`, `Toyota`, `Corolla`, `2ZR`, or `2AZ`; the planner's synthetic fixtures must obey the same rule (invented vehicle and engine names such as "Plant Alpha" / "Engine Zeta"), and the planner test should reuse that check. |
| R6 | Token-usage tee on a streamed response is fragile. | Medium / Low | Built last (Phase 5); fallback is request counts plus dashboard dollars. The eval's correctness never depends on token counts. |
| R7 | Replay diverges because retrieval changed. | n/a | Replay uses *recorded* retrieval by design. Live retrieval changes are visible only in a new capture, flagged by the corpus fingerprint. |
| R8 | Spend runaway. | Low / Medium | Section 12 guards. |
| R9 | Measuring what is easy rather than what matters (completeness defined by whoever writes the facts). | Medium / High | Essential vs non-essential flag; the owner signs off the essential list per scenario; spot-check protocol 7.3. |
| R10 | **The eval is used to "improve the score" by loosening verification.** | Low / Critical | Hard rule in section 3; report honesty rules 7.4 (rejections never shown without false acceptances); `PLANNER_ORACLE` and the new forbidden/decoy rows must stay green; PR template line: "touches no verifier, readiness, classifier, extractor, or prompt logic". |
| R11 | The corpus changes between runs (imports, deletions). | Medium / Medium | Snapshot + fingerprint; `NOT COMPARABLE` on mismatch. |
| R12 | The task extractor changes and silently invalidates scenarios. | Medium / Medium | Phase 1b's L0 pin tests fail loudly when the extractor's output for any scenario brief changes; every capture records the exact `revision`, so a changed extractor is attributable. |
| R13 | The Variant details saved in Settings are ignored by the planner, so S6 cannot be graded "for your car". | Certain / Low | Recorded in the header; S6's rule is "no unqualified single-variant figure", which does not need the plant. |
| R14 | `P-1` refactor breaks a test that relied on eager import. | Low / Low | It is the first PR, reviewed alone; `repairPlanner.test.js` must pass unchanged. |
| R15 | The new files fail `typecheck` (`checkJs` covers all of `server/src`). | Medium / Low | JSDoc types written with the code; `npm run verify` is each PR's gate. |

---

## 14. Implementation plan: smallest reasonable sequence

Phases 1a and 1b are specified in detail (14.2). Phases 2-7 are **outlines to be re-scoped after
1b is reviewed**; section 14.1 lists what is likely to be trimmed. One PR per phase (Phase 4
includes human verification time). Complexity is relative (S < M < L) with a rough size in
changed lines; it is a planning aid, not a promise.

| Phase | Deliverable | Production code touched | Paid? | Needs your DB? | Size |
|---|---|---|---|---|---|
| **1a. Isolate the pure tools (P-1)** *(merged, PR #175)* | Lazy default retriever in `repairTools.js`, plus regression tests for it (14.2). Nothing else. | `repairTools.js` (~3 lines) | no | no | **S** (~60 lines, mostly tests) |
| **1b. Pin today's pre-model behavior** | One test file: the 8 canonical briefs and the natural-phrasing set through the real task extractor and safety classifier; readiness invariants I-2/I-3; `todo` rows for the measured gaps (14.2). No new module, no schema. | none | no | no | **S** (~250 lines, tests only) |
| **2. Scenarios, synthetic harness, judge** | `plannerScenarios.js` (introduced here, because this is the first phase that reads it; **S1, S2, S8 only**), `plannerCaseRunner.js` (injected agent), scripted-model builder, invented mini-corpora, synthetic negative rows (8.1-8.4 "A"), pure `plannerJudge.js` (re-verify + 5.1 decision procedure + metrics) | none | no | no | **L** (~1,200 lines; re-scope after 1b) |
| **3. Capture format and replay** | **P-2 first, as its own tiny PR** (export the instructions text, with a regression test); then `plannerCapture.js` (header, recorders for `streamTurn`/`retrieve`, fail-closed parser), `plannerReplay.js`, `eval:planner:replay` CLI, committed **synthetic** capture fixture, import-boundary test with `fetch` disabled | P-2 (1 line, separate PR) | no | no | **M-L** (~800 lines) |
| **4. Corpus survey and fact confirmation** | `surveyPlannerCorpus.js` (read-only): per-fact search, chunk-length distribution vs 1,500, extraction-status and duplicate-group tags, timing-belt precondition, keyword golden-query probes. **Then** human confirmation of each fact against rendered PDF pages; promote facts into `plannerScenarios.js` | none | no | **yes** | **M code + the longest human step** (about 5-8 essential facts per scenario, ~40-60 total; stage it) |
| **5. Paid capture tool and report** | `capturePlanner.js` (dry-run default, `--yes`, `--max-runs`, `--max-provider-requests`, snapshot; token limits and usage tee only if built, see 12.4), `reportPlannerBaseline.js`, `docs/evals/planner-baseline-log.md` template, docs updates (`quality-testing.md`, `repair-planner.md`, `AGENTS.md`, `CLAUDE.md`) | none | no (stubbed-model end-to-end test only) | no | **L** (~1,000 lines; `--compare` deferred, 14.1) |
| **6. Baseline run** | Paid sessions, each separately approved (12.4): **6-pilot** S1 x 1 repeat; **6a** S1, S2, S8 x 3 repeats (~$1.6 estimated); **6b** S3-S7 once their facts are confirmed. Report generation, spot-check, committed aggregate log entry. | none | **yes, per-session approval; estimates only (12.1)** | yes | **S** (a session, not a PR of code) |
| **7. Later, optional** | Pinned-evidence live runs (hand the model exactly the right or wrong chunks to separate G from R), natural-phrasing live A/B, N5-tagger report-only metrics, loop-level replay | none | yes | yes | decided after the baseline |

Dependencies: 1a -> 1b -> 2 -> 3 -> 5; 4 can run in parallel with 2-3 once 1b lands; 6 needs 4
(facts) and 5 (tool). **1a and 1b alone already deliver value** (14.2). Phases 2-3 add
deterministic coverage of every planner failure layer that does not need a model.

### 14.1 Scope trims (approved by the owner with conditions, D9)

To avoid over-building, these items are deferred until a first baseline shows they are needed.
The conditions the owner attached are stated in the third column and are **requirements, not
suggestions**.

| Deferred | Condition (owner decision D9) | Revisit when |
|---|---|---|
| `--compare` between two baselines (11.1) | None beyond the comparability rule in 11.1 being applied by eye from Table 0. | A second baseline exists |
| Loop-level replay (10.1) | None. | A change to the loop itself needs judging |
| Automated spot-check sampling (7.3) | None; a fixed-seed list is printed and the checking is manual. | The sample grows |
| Separate Tables 4-7 (11) | **The first report must still identify `verified`/`ready` plans that lack essential confirmed facts** (the required block in section 11). Invariants and operations still run and print as one line each. | After the first read-through |
| Token-usage tee and token stop limits (12.4 limit 4) | **Only if appropriate provider-side spending controls are verified before any paid evaluation** (12.4 preconditions). **Strict run-count and request-count limits (limits 1 and 3) are mandatory regardless.** | The pilot shows usage varies unpredictably |
| Source-quality metrics Q2, Q3, Q4 as separate metrics (7.1); keep Q1 | **Detection and reporting of accepted wrong-engine or wrong-variant specifications is retained** through P2, P3, the `forbidden` rules (6.3), and the negative tests NEG-WE-1..5 (8.2). Only the cited-source *counts* (duplicates, OCR/garbled, other-engine citations) wait. | The first baseline's cited sources look odd |
| `extractorOutputHash` and `toolSchemasHash` in the header | **Every capture keeps the exact code `revision`, the `dirty` flag, and the `config` snapshot** (section 10) so non-comparable runs are still detectable. Only `instructionsHash` is kept as a hash. | A capture is ever compared across extractor versions |

Kept on purpose, because each guards a specific measured risk: the scoring gate (6.1), the
failure-layer decision procedure (5.1), the `todo` rows for known gaps, the hard invariants,
the fail-closed capture parser, and the staged paid sessions.

### 14.2 Phase 1 in detail: the smallest useful implementation

The aim is the smallest change that turns this spec's **free, already-measured findings** into
permanent tests, without building any evaluation machinery yet. It needs no scenario schema,
no capture format, no CLI, and no database. Phase 1a and 1b are separate PRs because 1a touches
production code and must be reviewable alone (owner decision D5).

**Phase 1a: isolate the pure tools (P-1).**

- *Change:* in `server/src/services/agent/repairTools.js`, replace the static import of
  `retrieveRelevantChunks` with a lazy default, so importing the pure tools (task extractor,
  readiness, checklist, inventory parsing) no longer opens the database. Nothing else in the
  file changes. `repairPlannerAgent.js` and `chunkRetrievalService.js` are not edited.
- *Regression tests (written first, shown failing against today's code, then passing):*
  1. **No side effect on import.** A child process sets `DATABASE_FILE` and `UPLOADS_DIR` to a
     fresh temporary folder, imports `repairTools.js`, and the test asserts no database file
     was created there. (Today the import creates one, which is the failing test.)
  2. **The lazy default still works.** `searchRepairDocs` and `createToolRegistry` called with
     *no* injected retriever resolve the real one against an empty temporary database and
     return no citations without throwing. This proves the lazy path actually loads and runs.
  3. **Injection is unchanged.** The existing `repairPlanner.test.js` passes with no edits.
- *Acceptance:* `npm run verify` green (or CI green, see the environment note below);
  `git diff` shows `repairTools.js` changed only at the import and default retriever; no other
  production file changed.
- *What it gives:* the planner's pure core can be imported by tests and, later, by an offline
  replay without opening anyone's database.

**Phase 1b: pin today's pre-model behavior.** One new test file, for example
`server/test/plannerL0Pins.test.js`, tests only.

- *Canonical briefs (the 8 from 6.2):* assert task count, system, difficulty, `safetyCritical`,
  `compound`, and the number of safety flags exactly as measured (Appendix A, probe A3). These
  are *characterization pins*: they exist so a silent change to the extractor or classifier
  fails loudly, not because today's output is ideal.
- *Natural-phrasing set (deterministic phantom-task tests, owner decision D7):* the five briefs
  from probe A4. Each asserts the **desired** behavior (no task that is a symptom or context
  sentence, and no spurious safety-critical flag) and carries `todo: "F3-phantom-task"`. They
  report as `todo`, keep the suite green, and turn it red the moment one starts passing, so
  the row must then be updated (same mechanism as `evidenceOracle.test.js`).
- *Known-gap rows:* S4 should flag lifting and wheel retention (`todo: "F4-brake-lifting"`); S6
  should not be rated beginner/non-critical (`todo: "F4-engine-mount"`). Desired behavior is
  written as the assertion; nothing is "fixed".
- *Readiness invariants I-2 and I-3,* as a loop over the 8 briefs x evidence status
  (`verified`, `partial`, `not_found`) x acknowledgment (true/false): a `safetyCritical` task is
  never `ready` while unacknowledged; `not_found` is always `not_ready`; `partial` is never
  `ready`. These are properties of today's code that must stay true; they are not
  characterizations of any wrong behavior.
- *Deliberately not pinned:* probe A1 (one claim yields `verified` / 100 / `ready`) and A2 (the
  zero-evidence score floor). They are *measurements* for the baseline report, not
  expectations; pinning them as passing tests would enshrine behavior that decision D6 may
  later change.
- *Acceptance:* the new tests run in `npm run test:server` with no key, no network, and no
  real database; every `todo` row names a finding id; the file contains only invented or
  generic brief text (no manual text); no production file changed.
- *What it gives, together with 1a:* free, permanent regression coverage of everything that
  happens before the model runs (task derivation, safety flags, readiness math), which is
  where Finding F3 and F4 live, plus the first deterministic evidence for or against the
  phantom-task hypothesis.

**Moved out of Phase 1:** the scenario module (`plannerScenarios.js` with its fact schema)
and the import-boundary test for replay. A fact schema written before any fact is confirmed
would be guesswork, and the boundary test belongs with the replay it protects (Phase 3).

**Environment note.** This cloud sandbox runs Node 22 and has no server dependencies
installed; the project requires Node 24. The assistant can write 1a and 1b here, but
`npm run verify` can only be run for real on Node 24 (your machine, or CI on the pull
request). The PR description will say which steps ran where, and will not call the gate
passed on the strength of the Node 22 probe runs.

**Per-phase gate:** `npm run verify` (lint -> typecheck -> test -> build -> smoke) plus
`npm run backup:drill` only if backup code is touched (it is not). Each PR description lists
`git diff --stat` for the do-not-touch files and must show them unchanged apart from P-1/P-2.
Following the repo's rule, each behavior is test-first: a failing test is shown before the code
that passes it.

---

## 15. Acceptance criteria

### 15.1 Per phase

| Phase | Done when |
|---|---|
| 1a | Importing `repairTools.js` creates no database file (test shown failing first); the lazy default retriever still resolves and runs against an empty temporary database; `repairPlanner.test.js` passes unchanged; `git diff` shows only the import and the default-retriever lines changed in production code. |
| 1b | Canonical-brief pins match Appendix A probe A3; the five natural-phrasing briefs and the F4 rows are `todo` rows each naming a finding id and none passes today; invariants I-2/I-3 hold across all briefs x evidence statuses x acknowledgment states; the file runs with no key, network, or real database; no production file changed; A1 and A2 are not pinned. |
| 2 | `plannerScenarios.js` holds S1, S2, S8 only, with `confirmed` set only on the facts listed in 6.2; the scoring gate is tested (an unconfirmed fact yields `unscored`, never a pass or a failure). A synthetic fixture exists that produces **each** of L0, S, R, V(false rejection), V(false acceptance), G(omission), G(query), G(no_search), G(run_failure), I as the single classification; a hand-built record proves the 5.1 sum reconciles (I-7); NEG-ME-2..5, NEG-WE-1..3, NEG-IP-1..4 and NEG-X-1..5 run through the real agent loop with a scripted model; `todo` rows flip the suite red the moment they start passing (same as `evidenceOracle.test.js`). |
| 3 | P-2 shipped first as its own tiny PR, with a regression test that the instructions string the agent passes to `streamTurn` equals the exported one and that its hash is stable; the agent's behavior is otherwise unchanged. A committed synthetic capture round-trips; replay of it reports "0 verdicts changed"; an injected stricter/looser verifier makes replay print exactly the changed verdicts; a malformed line is reported with its number and exits 1; the replay test runs with `fetch` disabled and `OPENAI_API_KEY` unset and imports neither `config.js` nor `database.js`. |
| 4 | Every scenario has `corpusSupport` for every fact with a page reference; each promoted fact was checked on the rendered PDF; the chunk-length report states how many chunks exceed 1,500 characters; S8's precondition passes; you have signed off the essential-fact list per scenario. |
| 5 | `--dry-run` is the default and calls nothing (tested); a real run without `--yes` or without a key refuses; `--max-runs` defaults to 1; with a stubbed model, the wrapper makes **no further `streamTurn` or `retrieve` call** once `--max-provider-requests` is reached, and records the run as Layer I (tested); if the tool has token limits, a scripted usage figure above the limit stops the next request, and unreadable usage stops the tool after that run (tested); the dry-run output prints the estimate labelled as an estimate and lists limit 6 (provider-side budget) as unverified; an end-to-end test with a stubbed model through the real `runRepairPlannerAgent` writes a capture that replays with 0 changes; the report generator produces Tables 0-3, the critical-finding line, and the **"verified/ready plans lacking essential confirmed facts" block** from a synthetic capture (tested with a fixture where a `verified`/`ready` plan omits a confirmed essential fact, one that covers all of them, and one in a scenario with none confirmed; counts A+D+... reconcile to N), and refuses to print if I-7 fails; mandatory limits 1 and 3 are enforced and tested whether or not a token tee exists. |
| 6 | The pilot ran as one S1 run under its own approval, and its observed requests and tokens are recorded before any further approval; the 6a runs (S1, S2, S8 x 3) are captured (or the shortfall explained as Layer I); every *confirmed* fact attributed exactly once and every other fact reported `unscored`; invariants pass or each failure is explained; the committed log holds aggregates only; the spot-check sample is recorded; **no verifier, readiness, classifier, extractor, or prompt code changed in the baseline PR**. |

### 15.2 Whole system

1. A change to the verifier can be judged for free: `eval:planner:replay <capture>` prints
   every changed verdict.
2. Any plan the app produces for a scenario can be explained as a sequence of layer
   outcomes, not a single status word.
3. The report cannot present `verified`, `ready`, or detail as quality.
4. A wrong-engine or wrong-variant figure accepted by the planner shows up as a named,
   counted, critical line, not silently.
5. A beginner can run the free tiers with one command each and read the output.

---

## 16. Owner decisions (recorded 2026-11-05)

| # | Decision | Owner's answer | How the spec reflects it |
|---|---|---|---|
| D1 | Scope: baseline is **measure-only**; no live pass/fail targets; no verifier/prompt/readiness/classifier/extractor changes. | **Approved.** | Hard rule in section 3; reporting rules in 7.4. |
| D2 | The eight scenarios, one "stocked" inventory profile, canonical briefs. | **Approved, with evidence confirmation required before scoring.** | Scoring gate in 6.1 and rule 6 in 7.4; `unscored` metrics; the S1/S2/S3 evidence claims corrected in 6.2. |
| D3 | Repeats and spend. | **Three repeats approved for planning only. No paid calls authorized.** Do not present a token ceiling as a dollar cap. | Section 12 rewritten: authorization status, estimate vs limit, what each limit guarantees, provider-side budget as the only dollar bound, pilot-first staging. |
| D4 | Staging. | **Approved: start with S1, S2, S8.** | 6.2 table of what the first baseline can and cannot score; Phase 6 staged as pilot, 6a, 6b. |
| D5 | Production edits P-1 (lazy retriever) and P-2 (export instructions). | **Conditionally approved:** minimal, isolated, covered by regression tests. | P-1 is Phase 1a alone; P-2 is its own PR before Phase 3; each has named regression tests (14.2, 15.1). |
| D6 | Should `verified`/`ready` eventually require completeness? | **Deferred** until baseline findings. | A1/A2 stay unpinned measurements (14.2). |
| D7 | Phantom tasks from natural phrasing (F3) as a future roadmap item. | **Deferred, but include the deterministic phantom-task tests.** | Phase 1b natural-phrasing `todo` rows (14.2). |
| D8 | Who runs Tier B/D. | **Confirmed: your local machine.** | Section 4 note; Phases 4 and 6. |

| D9 | Scope trims (14.1). | **Approved with conditions.** Deferred: `--compare`, loop-level replay, automated spot-check sampling, separate Tables 4-7. Token tee only if provider-side controls are verified first, with strict run- and request-count limits regardless. Q2-Q4 deferred as separate metrics, but wrong-engine/wrong-variant detection stays (P2, P3, negative tests). The first report must identify `verified`/`ready` plans lacking essential confirmed facts. Extractor/tool-schema hashes deferred if every capture keeps the exact revision and relevant configuration. | 14.1 conditions column; required block in section 11; `config` snapshot in section 10. |
| D10 | Spending controls. | Dedicated OpenAI project and key where practical; proposed **$10 monthly project limit with hard-limit enforcement**. **Not yet confirmed or configured. No paid calls authorized.** | Preconditions list in 12.4; 12.3 limit 6. |
| Phase 1a | Begin P-1. | **Approved to begin** as an isolated PR; no merge, no Phase 1b, no later phase without separate review. | Merged as PR #175. Phase 1b merged as PR #176. Phase 2 was split in two: 2a (scenario data, injected recorder, scripted model, invented corpora) merged as PR #177; 2b (the judge) follows the decisions in 16.1. |

**Still open:**

| # | Question | Needed before |
|---|---|---|
| D10b | Configure the dedicated project, key, and $10 hard limit, and confirm the setting in force (value, hard-stop versus notice-only). | Any paid session, including the pilot |
| D11 | Recommended, not yet decided: before the first baseline, confirm a small list of **essential procedure steps** for S1 and S2 (a handful each, against the rendered PDF pages). Today only one figure each is confirmed, so every S1/S2 plan would land in "NOT assessable" in the required block and the core finding (`verified`/`ready` plans lacking essential facts) could not be demonstrated on them. S8 needs no steps. | The 6a baseline (Phase 4) |

### 16.1 Decisions that bind Phase 2b (made in the owner's review of the Phase 2a plan)

These were decided in review before PR #177 and recorded only in that PR until now. Phase 2b
implements them; a change to any of them is an owner decision, not a judge fix.

| # | Decision | What it means for the judge |
|---|---|---|
| 2b-1 | **A contradicted fact stays in layer V.** | A fact with an accepted correct claim AND an accepted wrong claim is `V:false_acceptance` with `kind: contradicted`, `alsoCovered: true`. There is no seventh layer, and a correct claim never cancels the critical finding. A contradicted or partly covered fact is **not** in the numerator of P1 or C1 but **is** in the denominator, so it cannot inflate a success rate. C3 counts it as uncovered. |
| 2b-2 | **Unknown stays unknown.** | `sourceQuality` and `goldenQueryRetrieves` are `null` for S1/S2 (confirming a figure on the rendered page says nothing about the extracted text) and `not_applicable` for S8. Null is never read as clean. R and G(query) are assigned only when support, quality, and the golden-query probe are all known; otherwise a missed fact is `UNDETERMINED` with the missing fields named. `UNDETERMINED` is an attribution status, not a layer, and still counts once for I-7. |
| 2b-3 | **Desired jobs are unconfirmed, so L0 is `unscored`.** | Until the owner reviews `desiredJobs`, the judge reports task derivation but scores no L0 failure. Decomposition is kept apart from the vehicle `premise`: S8 deriving a belt task is correct decomposition, never an L0 defect. |
| 2b-4 | **`corpusSupport: partial` is never `COVERED`.** | The best outcome is `PARTIALLY_COVERED`, the remainder is tagged `S:partial_source`, and the fact stays in the C1 denominator. |
| 2b-5 | **I-4 is a hard invariant.** | Every detector-visible figure in the plan text, checklist draft, checklist, handoff notes, and gaps must come from an accepted claim's quote, from the owner's own input, or from what the same builders print with zero claims. Q1 stays where the source hint is confirmed; Q2-Q4 stay deferred (D9). |
| 2b-6 | **Negative tests assert three axes.** | Every negative row asserts the evidence status, the verifier's rejection reasons, and the failure-layer attribution, through one helper that fails if an axis is left out. NEG-IP-6 is included (three structurally invalid finalizers end in `invalid_final_contract`; two invalid then one valid completes). NEG-X-1..X-3 stay as thin re-assertions of existing tests. A bare `SST` rejection is a pinned `known-limitation` row, not a `todo`. |
| 2b-7 | **Two ledgers.** | One outcome per confirmed fact (I-7) and one verdict per submitted claim, kept separate. |

**Choices made while building 2b, for the owner to confirm** (each is a judge rule, not a
product change, and each is pinned by a test):

- *A false rejection needs the fact to have been shown.* Section 5.1 calls every rejected claim
  that matches a fact a false rejection. The judge counts it as one only when the fact was in
  the text the model was shown (the same cut 5.1 step 3 makes for the fact). A claim stating
  the right figure while citing text that never showed it is an `ungrounded_rejection`: the
  verifier was right to refuse it, so it is not counted in U4.
- *`procedure_step` is a new fact kind,* added with its matcher (every step matcher must hit the
  claim). Only the negative tests' own scenarios use it; no committed scenario has a confirmed
  step yet (D11), so C1 stays `unscored` for S1, S2, and S8.
- *NEG-ME-4 pins `claim_not_in_quote`, not `unsupported_number`.* The planner first checks that
  a claim is a fragment of its quote, so a claim can print only its quote's numbers and
  `unsupported_number` cannot be reached through a whole run.
- *The matcher does not read a number with no declared unit* ("tighten the drain plug to 45").
  It is a known blind spot, stated in the code, rather than a guess.

Found while building 2a, for the roadmap rather than this phase: the planner accepts a
drive-belt claim for the "Replace the timing belt" task, because its task-subject check needs
only one shared word (`belt`). The `S8-drive-belt-decoy` run exists so the judge can be shown
not to count it as a timing-belt fabrication.

Found while building 2b, and since fixed: the verifier accepted a claim that stopped before its
figure's unit ("torque to 37" from "torque to 37 N·m") under every claim kind, as long as the
quote was trimmed at the same place. It is now rejected as `unit_cut`, read in the source
(`docs/repair-planner.md`, check 3). This also narrows the matcher blind spot above: an
accepted claim can no longer carry a figure whose unit the source printed right after it.

---

## Appendix A: what was measured, and how

**Method.** Six pure modules (`repairTools.js`, `repairPlanEvidenceContract.js`,
`plannerChecklistDraft.js`, `askEvidenceContract.js`, `safetyClassifier.js`, `utils/text.js`)
were copied unchanged to a scratch folder outside the repository; the single import of the
retriever was replaced by a stub that throws if called. Run under Node 22 (the project requires
Node 24 and its dependencies are not installed in this sandbox), so these runs are **not** the
project's test runner. All chunk text was **invented**. No repository file was modified, no
network call was made. Phase 1 turns each line below into a CI test, which is the real
verification.

| Probe | Result |
|---|---|
| **A1** One `procedure` claim (of 3 invented steps) plus grounded `no_required_tools` and `no_required_parts` on a cabin-filter task | `evidenceStatus: verified`, requirements `none_required`/`none_required`, readiness **100 / ready**, 0 rejections |
| **A2** Readiness with requirements `unknown`, skill beginner, evidence `not_found` | cabin air filter **50 / not_ready**; front brake pads **30 / not_ready**; timing belt **20 / not_ready** (advanced task vs beginner). With skill advanced, timing belt scores 50. |
| **A3** Extractor/classifier on canonical briefs | S1 -> 2 tasks (Engine, beginner); S2 -> 1 (Engine, beginner); S3 -> 1 (HVAC, beginner); S4 -> 1 (Brakes, critical, 1 flag); S5 -> 1 (Cooling, critical); S6 -> 1 (Engine, **beginner, not critical**); S7 -> 2 (Electrical critical; General); S8 -> 1 (Engine, advanced). "Drain and refill the engine coolant" -> one *compound* task with clauses "Drain" and "refill the engine coolant"; "Replace the water pump and thermostat" -> one compound task. |
| **A4** Natural phrasing (five briefs) | Oil change + "It is due and I have the jack stands out already." -> task 2 = that sentence, General, **critical**, compound. Spark plugs + "The engine idles rough and the check engine light came on." -> task 2 (compound). Cabin filter + "The A/C airflow is weak." -> task 2. Brake pads + "They squeal when I brake." -> task 2, Brakes, **critical**. Engine mount led by a symptom sentence -> task 1 is the symptom sentence (compound), the repair is task 2. Five of five produced an extra or inflated task; two were flagged critical. |
| **A5** Wrong variant / wrong engine (invented tables of the same shape as the real ones) | B: the first plant's torque claimed alone -> **accepted**, no warning; a second-row claim naming no part -> rejected `subject_missing`; both with conditions -> accepted. C2: a different engine's figure listed first, quote cut after it -> **accepted** (`partial` only because tools/parts were unresolved). |
| **A6** Fact after 1,500 characters | rejected `quote_not_in_source` |
| **A7** Claim dropping a leading "Do not" | rejected `negation_dropped` (guard works) |
| **A8** Readiness matrix, brake task, requirements `satisfied`, beginner | unacknowledged: verified 80 almost_ready, partial 80 almost_ready, not_found 80 not_ready. Acknowledged: verified 100 ready, partial 100 almost_ready, not_found 100 not_ready. |

One probe in the working session was a fixture error of mine (a quote that skipped text) and
was rerun correctly as C2; the corrected result is the one reported.

## Appendix B: glossary

- **Golden fact:** an owner-confirmed statement the manuals contain (or provably do not), used
  as the answer key for a scenario.
- **Capture:** a file recording what the model asked for, what the retriever returned, and what
  the verifier decided during one real run.
- **Replay:** re-judging a capture with today's code, for free, with no model.
- **Layer:** the part of the system a failure is assigned to (task derivation, source,
  retrieval, verification, generation, infrastructure).
- **False acceptance / false rejection:** the verifier kept a claim that is wrong or forbidden
  / dropped an honest claim.
- **`todo` row:** a test row that documents a known defect; the suite stays green while it
  fails and turns red the moment it starts passing, forcing the row to be updated.
- **Pinned evidence:** a live run where the retriever is replaced by a fixed list of chunks, to
  tell "the model ignored good evidence" from "the retriever never found it".
