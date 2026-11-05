# Repair Planner evaluation system: specification (DRAFT for owner review)

> **Status:** proposal. Nothing in this document is implemented. No code, test, schema, or
> prompt was changed to write it, and no paid AI call was made. Every "Measured" statement
> below was produced offline, either by reading the code or by running copies of six pure
> planner modules in a scratch folder with the retriever stubbed and **invented** fixture
> text (see [Appendix A](#appendix-a-what-was-measured-and-how)).
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

**What it costs.** Everything except step 6 is free. Step 6 is estimated at **about $4-5**
(24 live runs, ~$0.18 each from the Stage 5-E2 log) with a hard token ceiling and a recommended
cap of **$10**. Section 12 shows the arithmetic and its uncertainty.

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
| **I Infrastructure** | Rate limit, timeout, truncated stream, spend ceiling. Not a product signal. | Wrapper-recorded provider errors | n/a |

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

### 6.2 The eight scenarios

"Measured L0" is what today's extractor/classifier produces for the canonical brief (Appendix
A, probes 1 and 5). "Corpus" is a **hypothesis** to be settled by the Tier B survey, not an
assertion about your manuals, except where the repo already records a confirmation.

| ID | Canonical brief | Measured L0 | Role in the baseline | Corpus (hypothesis, or repo-confirmed) |
|---|---|---|---|---|
| **S1** oil-and-filter | "Change the engine oil and replace the oil filter." | 2 tasks, Engine, beginner, not critical | **Control.** Table of known-good figures; multi-task coverage. | Drain-plug torque confirmed (Ask case `oil-drain-plug-torque`, "Oil and Oil Filter Replacement" p1). Filter-cap torque and capacities were seen in live planner runs (iteration log, Stage 5-E2). |
| **S2** spark-plugs | "Replace the spark plugs." | 1 task, Engine, beginner, not critical | **Control + same-table decoy.** The new-plug gap sits one row from the used-plug maximum. | Both gap figures confirmed on rendered pages (Ask case `spark-plug-gap`: doc 226 p1; doc 724 p5-6). |
| **S3** cabin-air-filter | "Replace the cabin air filter." | 1 task, HVAC, beginner, not critical | **Easy control.** Only scenario where `ready` is reachable with no safety gate, and the `none_required` path may apply. | Unknown (Ask template `cabin-air-filter-procedure` is unverified). |
| **S4** front-brake-pads | "Replace the front brake pads." | 1 task, Brakes, **critical**, 1 flag; **no** lifting/wheel flag (F4) | **Safety + R-vs-S diagnostic.** Stage 5-E2 found no pad-replacement procedure; this scenario settles whether that is retrieval or the corpus. | Unknown; the main question. |
| **S5** engine-coolant | "Replace the engine coolant." | 1 task, Cooling, **critical** | **Incomplete-procedure + capacity figures.** | Unknown; Ask case `coolant-drain-and-refill` is on the documented unstable list. |
| **S6** front-engine-mount | "Replace the front engine mount." | 1 task, Engine, **beginner, not critical** (suspect, F4) | **Wrong-variant trap.** One fastener, two build-plant torques 29 N·m apart (TMMT vs TMC). | Row confirmed (Ask case `applicability-engine-mount-build-variant`, doc 1269 p1). The planner never reads the Variant details saved in Settings. |
| **S7** battery-and-charging | "Replace the battery and then test the charging voltage." | 2 tasks: Electrical **critical**; second is system General | **Multi-task + electrical units.** | Unknown (Ask template `charging-system-voltage` unverified). |
| **S8** timing-belt | "Replace the timing belt." | 1 task, Engine, **advanced** (skill mismatch vs beginner) | **Plausible-but-absent.** The 2ZR-FE uses a timing *chain*; "timing belt"/"cam belt" match 0 of 20,447 chunks. Any belt procedure the plan "verifies" is fabrication. | Absence confirmed (Ask case `refuse-timing-belt-interval`), re-checked by `checkTimingBeltRefusalPrecondition` at each run. |

**Why these eight:** three controls whose evidence is already confirmed (S1-S3) so the
baseline is trustworthy on day one; two safety-critical jobs with suspected corpus gaps (S4,
S5) that separate R from S; one variant trap (S6); one multi-task electrical job (S7); one
absent-by-design job (S8).

**Smallest useful first baseline:** S1, S2, S8 (all with evidence already confirmed in the
repo). S3-S7 follow once their golden facts are confirmed against the PDFs (Phase 4).

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
 "capturedAt","revision","dirty","answerModel","reasoningEffort","maxOutputTokens",
 "maxTurns","maxToolCallsPerTurn","maxSearchResults","evidenceContextCharLimit",
 "instructionsHash","toolSchemasHash","extractorOutputHash",
 "scenarioSetVersion","repeats","vehicleProfile":{"engineCode","buildPlant"},
 "corpus":{"documents","chunks","embeddingVersion","dbSnapshotMd5"},
 "tokenCeilings":{"perRunInput","totalInput"}}

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
| `instructionsHash` / `toolSchemasHash` / `extractorOutputHash` | |
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
**Table 4: readiness x completeness cross-tab** (R2).
**Table 5: invariants** (I-1..I-8) pass/fail with counts.
**Table 6: L0** (task counts, phantom tasks, W1 server-flag recall).
**Table 7: operations** (turns, tool calls, searches, tokens, wall time).
**Section: spot-check results** (7.3) with sample size.

### 11.1 Comparing two baselines

`report --compare <old.json> <new.json>` prints per-metric deltas with one of three labels:
`improved`, `regressed`, or `within noise`. A change is **not** noise only if the new median
falls outside the old run's `[min, max]` across its repeats. Before any delta is printed the
tool checks comparability and prints `NOT COMPARABLE (<field>)` when any of
`scenarioSetVersion`, `instructionsHash`, `toolSchemasHash`, `answerModel`,
`reasoningEffort`, `extractorOutputHash`, or the corpus fingerprint differ, **naming which one
changed**. A prompt change or a corpus change is thus visible as the *cause*, not hidden
inside the delta. Critical counts are always shown, never netted against improvements.

---

## 12. Cost and spend control

**Estimate.** Stage 5-E2 recorded four live runs at about $0.70 total (28 Responses calls,
226,463 input tokens of which 138,752 cached, 6,353 output tokens; $5 / $0.50 / $30 per million
input / cached / output, secondary-source list prices). That is about **$0.18 per run**.

| Item | Runs | Estimate |
|---|---|---|
| Baseline: 8 scenarios x 3 repeats | 24 | ~$4.3 (plausible range $3-$8: two-task briefs cost more; prices and prompt size can change) |
| Free-cost negatives (defeat, vague) | 2 | $0 |
| Hybrid golden-query probes (optional) | ~30 embeddings | cents |
| Optional later: pinned-evidence runs, natural-phrasing A/B (3 scenarios x 3) | ~18 | ~$3 |

This is an estimate from one dated log entry, not a guarantee. The capture tool prints a
projection from the *actual* token counts of the first run and asks to continue.

**Guards on the paid tool (`eval:planner:capture`):**

1. `--dry-run` is the default: it lists scenarios, repeats, the projected provider-request
   count, and the ceilings, and calls nothing.
2. A real run requires `--yes` **and** `OPENAI_API_KEY`; it prints "PAID" and refuses to start
   without both. As with Ask, it is run only with your approval in the session.
3. Per-run input-token ceiling (350,000, as used in Stage 5-E2) and a total ceiling
   (suggested 3,000,000 input tokens, about 2x the expected 1.4M). On breach the run stops and
   writes what it has.
4. `AI_DAILY_CALL_LIMIT` is per process and the capture is its own process. The tool computes
   the worst case (up to 8 Responses calls plus up to 64 embedding requests per run) and warns
   if the configured limit could trip mid-baseline. A tripped limit is classed Layer I.
5. Between-case delay (`EVAL_CASE_DELAY_MS`, as Ask) and bounded 429 retry; a persistent 429 is
   reported as infrastructure, never as a product failure.
6. Run against a `VACUUM INTO` snapshot of the database (as the Stage 5-E2 runs did) so the
   corpus cannot change mid-baseline; the snapshot's MD5 goes in the header.

Nothing in this specification's preparation made a paid call.

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
| R12 | The task extractor changes and silently invalidates scenarios. | Medium / Medium | `extractorOutputHash` in the header and an L0 pin test that fails loudly. |
| R13 | The Variant details saved in Settings are ignored by the planner, so S6 cannot be graded "for your car". | Certain / Low | Recorded in the header; S6's rule is "no unqualified single-variant figure", which does not need the plant. |
| R14 | `P-1` refactor breaks a test that relied on eager import. | Low / Low | It is the first PR, reviewed alone; `repairPlanner.test.js` must pass unchanged. |
| R15 | The new files fail `typecheck` (`checkJs` covers all of `server/src`). | Medium / Low | JSDoc types written with the code; `npm run verify` is each PR's gate. |

---

## 14. Implementation plan: smallest reasonable sequence

Seven phases, one PR each (Phase 4 includes human verification time). Complexity is relative
(S < M < L) with a rough size in changed lines; it is a planning aid, not a promise.

| Phase | Deliverable | Production code touched | Paid? | Needs your DB? | Size |
|---|---|---|---|---|---|
| **1. Foundations** | P-1 lazy retriever; `plannerScenarios.js` (8 scenarios, schema, `verified:false`); L0 tests (task derivation, safety flags, phantom-task counts, readiness matrix, invariants I-2/I-3 on all scenarios, `todo` rows for F3/F4); import-boundary test | `repairTools.js` (3 lines) | no | no | **M** (~700 lines, mostly tests) |
| **2. Synthetic harness and judge** | `plannerCaseRunner.js` (injected agent), scripted-model builder, invented mini-corpora, synthetic negative rows (8.1-8.4 "A"), pure `plannerJudge.js` (re-verify + 5.1 decision procedure + metrics) | none | no | no | **L** (~1,400 lines) |
| **3. Capture format and replay** | `plannerCapture.js` (header, recorders for `streamTurn`/`retrieve`, fail-closed parser), `plannerReplay.js`, `eval:planner:replay` CLI, committed **synthetic** capture fixture, boundary test with `fetch` disabled | P-2 (1 line) | no | no | **M-L** (~900 lines) |
| **4. Corpus survey and fact confirmation** | `surveyPlannerCorpus.js` (read-only): per-fact search, chunk-length distribution vs 1,500, extraction-status and duplicate-group tags, timing-belt precondition, keyword golden-query probes. **Then** human confirmation of each fact against rendered PDF pages; promote facts into `plannerScenarios.js` | none | no | **yes** | **M code + the longest human step** (about 5-8 essential facts per scenario, ~40-60 total; stage it) |
| **5. Paid capture tool and report** | `capturePlanner.js` (dry-run default, `--yes`, ceilings, snapshot, usage tee), `reportPlannerBaseline.js` (+ `--compare`), `docs/evals/planner-baseline-log.md` template, docs updates (`quality-testing.md`, `repair-planner.md`, `AGENTS.md`, `CLAUDE.md`) | none | no (stubbed-model end-to-end test only) | no | **L** (~1,300 lines) |
| **6. Baseline run** | One paid session (with your approval), report generation, spot-check, committed aggregate log entry. Staged: **6a** S1, S2, S8 (+S3 if confirmed); **6b** S4-S7 | none | **yes (~$4-5 total)** | yes | **S** (a session, not a PR of code) |
| **7. Later, optional** | Pinned-evidence live runs (hand the model exactly the right or wrong chunks to separate G from R), natural-phrasing live A/B, N5-tagger report-only metrics, loop-level replay | none | yes | yes | decided after the baseline |

Dependencies: 1 -> 2 -> 3 -> 5; 4 can run in parallel with 2-3 once Phase 1 lands; 6 needs 4
(facts) and 5 (tool). **Phases 1-3 alone already deliver value:** deterministic coverage of
every planner failure layer that does not need a model, with the findings in section 2 turned
into permanent tests.

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
| 1 | `repairTools.js` imports no database/config (boundary test); all existing server tests pass unchanged; L0 tests pin the measured extractor/classifier output for all 8 canonical briefs and the natural-phrasing set; the F3/F4 gaps exist as `todo` rows naming a finding id; invariants I-2/I-3 hold for every scenario in both acknowledgment states. |
| 2 | A synthetic fixture exists that produces **each** of L0, S, R, V(false rejection), V(false acceptance), G(omission), G(query), G(no_search), G(run_failure), I as the single classification; a hand-built record proves the 5.1 sum reconciles (I-7); NEG-ME-2..5, NEG-WE-1..3, NEG-IP-1..4 and NEG-X-1..5 run through the real agent loop with a scripted model; `todo` rows flip the suite red the moment they start passing (same as `evidenceOracle.test.js`). |
| 3 | A committed synthetic capture round-trips; replay of it reports "0 verdicts changed"; an injected stricter/looser verifier makes replay print exactly the changed verdicts; a malformed line is reported with its number and exits 1; the replay test runs with `fetch` disabled and `OPENAI_API_KEY` unset and imports neither `config.js` nor `database.js`. |
| 4 | Every scenario has `corpusSupport` for every fact with a page reference; each promoted fact was checked on the rendered PDF; the chunk-length report states how many chunks exceed 1,500 characters; S8's precondition passes; you have signed off the essential-fact list per scenario. |
| 5 | `--dry-run` is the default and calls nothing (tested); a real run without `--yes` or without a key refuses; an end-to-end test with a stubbed model through the real `runRepairPlannerAgent` writes a capture that replays with 0 changes; the report generator produces Tables 0-7 from a synthetic capture and refuses to print if I-7 fails; `--compare` prints `NOT COMPARABLE (<field>)` for each differing identity field. |
| 6 | All 24 runs captured (or the shortfall explained as Layer I); every confirmed fact attributed exactly once; invariants pass or each failure is explained; the committed log holds aggregates only; the spot-check sample is recorded; **no verifier, readiness, classifier, extractor, or prompt code changed in the baseline PR**. |

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

## 16. Decisions needed from the owner

| # | Decision | Recommendation |
|---|---|---|
| D1 | Approve the scope: baseline is **measure-only**, with no live pass/fail targets and no verifier/prompt/readiness/classifier/extractor changes in these PRs. | Approve. |
| D2 | Approve the eight scenarios, the single "stocked" inventory profile, and canonical briefs (6.2). Swap any you would not actually do. | Approve; S6 and S8 are the traps, keep them. |
| D3 | Repeats and spend: 3 repeats per scenario, ceiling suggested at 3M input tokens (~$10 worst case), expected ~$4-5. | Approve; revisit only if results are inconclusive. |
| D4 | Staging: first baseline on S1, S2, S8 (evidence already confirmed in the repo), then S3-S7 after the survey. | Approve; this gets a trustworthy number soonest. |
| D5 | Permission for the P-1 lazy-import refactor and P-2 export in `repairTools.js` / `repairPlannerAgent.js`. | Approve; the alternative is an environment-variable workaround that is easier to get wrong. |
| D6 | Product question, **not** part of this work: should `verified`/`ready` eventually *require* procedure completeness? The baseline will show how often they currently do not. | Defer until the baseline is in. |
| D7 | Treat phantom tasks from natural phrasing (F3) as a separate future roadmap item if the L0 probe confirms it. | Defer; the free probe comes first. |
| D8 | Who runs Tier B/D: it must be your machine (the cloud sandbox has no manuals). | Confirm. |

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
