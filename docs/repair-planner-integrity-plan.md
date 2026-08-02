# Corrected Plan — Repair Planner Integrity Fixes

Supersedes both the "Grounded Plan Contract and Real Readiness" proposal and the two competing
replacement plans (Claude's revised plan and the Codex plan). This document is the single
implementable source of truth.

It takes Claude's revised plan as the base, folds in the three corrections raised in review, and
adds a fourth correction found by executing the code rather than reading it.

> **The two pull requests below are one safety milestone.** PR 1 is independently testable and
> reviewable, but it is **not release-complete**. The Repair Planner must not be considered
> trustworthy for readiness or grounded repair guidance until PR 2 also merges and the full test
> suite passes. Do not cut a release on the intermediate PR 1 state.

---

## 1. Verified baseline

Everything below was confirmed by executing the code on `main` @ `4e95ebf`, not by reading it.
These results are the justification for the plan; keep them when re-reviewing.

### 1.1 Readiness is falsely optimistic today

```
"Swap the front pads."       tools="none" parts="n/a"  -> score=100  level=ready
"Replace front brake pads."  tools="none" parts="n/a"  -> score=80   level=almost_ready
"Replace front brake pads."  + model sets ackSafety:true -> score=100  level=ready
```

Three separate defects produce this:

1. `"none"` / `"n/a"` earn the full 50 tools+parts points
   ([repairTools.js:263-264](../server/src/services/agent/repairTools.js#L263)); nothing compares
   listed items against what the repair requires.
2. The model can set `ackSafety`, `skillLevel`, `availableTools`, `availableParts`, and the task
   list through tool arguments
   ([repairTools.js:492-504](../server/src/services/agent/repairTools.js#L492),
   [repairTools.js:514-523](../server/src/services/agent/repairTools.js#L514)), and the registry
   executes them verbatim
   ([repairPlannerAgent.js:162](../server/src/services/agent/repairPlannerAgent.js#L162)).
3. `"Swap the front pads."` is not classified safety-critical at all, so the existing `ready` cap
   at [repairTools.js:340-342](../server/src/services/agent/repairTools.js#L340) never fires.

### 1.2 The safety classifier misses bare "pads" / "shoes"

[safetyClassifier.js:53](../server/src/services/safetyClassifier.js#L53) reads:

```js
/\bbrakes?\b|\bbraking\b|\babs\b|\bcalipers?\b|\brotors?\b|\bmaster cylinder\b|\bbrake booster\b|\bbrake (line|fluid|pads?|shoes?)\b/
```

`pads` and `shoes` only match when literally preceded by `brake`. Standalone `\brotors?\b` matches;
standalone `"front pads"` does not. One word separates a brake job scoring `almost_ready` from the
same job scoring `ready`.

### 1.3 Canonical task extraction does not behave as either plan assumed

`extractRepairTasks` ([repairTools.js:131](../server/src/services/agent/repairTools.js#L131)) is
**deterministic and pure** — a function of `brief` alone, with no model-supplied task arguments.
That part of the review concern is resolved. Its *output*, however, breaks two rules the plans
depend on:

| Input | Assumed | Actual |
| --- | --- | --- |
| `"Replace the front brakes and diagnose a steering shake."` | 2 tasks | **1 task** |
| `"Replace the front brakes. Diagnose a steering shake."` | 2 tasks | 2 tasks ✓ |
| `"help"` | no valid task | **1 task, titled `"help"`** |
| `"Replace front brake pads."` ×2 in one brief | 1 task (deduped) | **2 tasks, ids 1 and 2** |
| `"   "` (blank) | 0 tasks | 0 tasks ✓ |

Causes:

- The fragment splitter
  ([repairTools.js:119](../server/src/services/agent/repairTools.js#L119)) is
  `/\r?\n|(?<=[.!?])\s+|;|•|\s-\s/` — it never splits on a coordinating conjunction.
- `source = fragments.length ? fragments : [normalizedBrief]`
  ([repairTools.js:139](../server/src/services/agent/repairTools.js#L139)) guarantees at least one
  task for any non-blank brief. The only zero-task input is whitespace-only, which the agent
  already rejects earlier at
  [repairPlannerAgent.js:86](../server/src/services/agent/repairPlannerAgent.js#L86).
- No normalization or deduplication of task titles.

### 1.4 Remaining confirmed behavior

| Behavior | Evidence |
| --- | --- |
| Route forwards owner fields with no acknowledgment field and no `skillLevel` validation | [repairPlan.js:81-90](../server/src/routes/repairPlan.js#L81) |
| Raw model text streamed to the browser unvalidated | [repairPlannerAgent.js:137-139](../server/src/services/agent/repairPlannerAgent.js#L137) |
| Empty, turn-limited run still emits `done.status: "completed"` | [repairPlannerAgent.js:212-220](../server/src/services/agent/repairPlannerAgent.js#L212) |
| Malformed function arguments silently become `{}`; no `response.completed` requirement; `response.incomplete` unhandled | [openAiResponsesClient.js:158-174](../server/src/services/agent/openAiResponsesClient.js#L158) |
| Client ignores `done.status`; bare EOF becomes success | [RepairPlannerPage.jsx:345-352](../client/src/pages/RepairPlannerPage.jsx#L345), [RepairPlannerPage.jsx:430-432](../client/src/pages/RepairPlannerPage.jsx#L430) |
| Truncation test currently *asserts* the false success | [repairPlanner.test.js:645-664](../server/test/repairPlanner.test.js#L645) |
| Client fixture marks unacknowledged brake work `ready` + `DIY` | [RepairPlannerPage.test.jsx:57-72](../client/src/pages/RepairPlannerPage.test.jsx#L57) |
| Docs drifted: rubric row says the safety row is met when "tasks exist" | [repair-planner.md:58](repair-planner.md#L58) — code requires `!hasSafetyCritical \|\| safetyAcknowledged` |
| Reusable, config-free evidence helpers exist | [askEvidenceContract.js:222](../server/src/services/askEvidenceContract.js#L222), [:415](../server/src/services/askEvidenceContract.js#L415), [:456](../server/src/services/askEvidenceContract.js#L456) |

**Confirmed:** `askEvidenceContract.js` imports no config and reads none — only a stale comment on
line 1 mentions the flag. `ASK_EVIDENCE_CONTRACT=false` gates Ask's *answer path* only. Reusing
`quoteAppearsInChunk` / `checkClaimNumbers` / `redactSpecNumbers` is safe and carries no flag
dependency.

> Line references in this document were re-checked against `4e95ebf`. Do not carry line numbers
> over from the superseded plans — several were stale (the readiness rubric table is at
> `repair-planner.md:51-60`, not `:57-64`; the truncation test is at `repairPlanner.test.js:645`,
> not `:633`).

### 1.5 Turn budget is per round trip, not per tool call

The agent loop collects **all** function calls emitted in a turn and executes them before the next
model call ([repairPlannerAgent.js:141](../server/src/services/agent/repairPlannerAgent.js#L141),
[:151](../server/src/services/agent/repairPlannerAgent.js#L151)). N searches can therefore share one
turn. Raising `maxTurns` 6 → 8 is adequate; note that 2 correction retries plus the finalize turn
consume 3 of the 8.

---

## 2. Problem statement

The Repair Planner presents model-generated content with the authority of verified manual data. It
must instead:

1. Keep owner facts and safety state outside model control.
2. Derive a trustworthy canonical task list from the trusted brief.
3. Verify every technical claim and requirement against retrieved manual text.
4. Compute readiness only from what verified.
5. Report evidence as `verified` / `partial` / `not_found` under explicit rules.
6. Treat malformed or incomplete generation as failure, never success.

**Decisions confirmed with the user:** raw model prose is suppressed entirely (no `text_delta`); the
contract ships unconditionally with no env flag; no acknowledgment checkbox in this milestone.

---

## 3. Corrections folded in

### Correction 1 — PR 1 is not release-complete (accepted, with an amended remedy)

The review's conclusion is correct and §1.1 makes it sharper than the review argued: after PR 1 as
originally scoped, `"Swap the front pads."` with `"none"` inventories still scores **100/`ready`**,
byte-identical to today, because PR 1 deliberately left the rubric alone.

Amendments to the proposed remedy:

- **Adopted:** treat `""`, `none`, `n/a`, `unknown`, `not sure` as no inventory. Small, contained,
  and the single highest-value protection. Moves into PR 1.
- **Rejected as redundant:** "safety-critical jobs cannot become `ready`" is *already* in `main` at
  [repairTools.js:340-342](../server/src/services/agent/repairTools.js#L340). What is broken is
  that `ackSafety` is model-settable. PR 1's trust boundary is precisely what makes the existing
  cap effective — a real gain the review did not credit. No new code needed.
- **Added:** neither protection catches `"Swap the front pads."` — with the inventory fix it still
  reaches 50/`almost_ready`. The classifier fix (§1.2) is required and also moves into PR 1.
- **Adopted:** stacked PRs (PR 2 branches from PR 1), reviewed separately, merged back-to-back, no
  release on the intermediate state.

### Correction 2 — Evidence-status rules must be explicit (accepted, one clause made implementable)

Codified in §7 below. One change from the review's wording: *"rejected claims must not disappear
when they represent requested information"* is not implementable — there is no server-side notion of
"requested information." The decidable equivalent, adopted in §7, is: **any task carrying ≥1
rejected claim cannot count as covered, and every rejection emits a gap.**

### Correction 3 — Canonical task extraction must be verified (accepted; verification performed)

Determinism confirmed clean (§1.3). Output quality is the problem, which leads to:

### Correction 4 — Fix the canonical-task layer before building per-task coverage on it (new)

Both plans build per-task evidence coverage, per-task readiness, and per-task gaps on top of
`extractRepairTasks`. Given §1.3 that foundation does not hold:

- A compound `"...brakes and...steering shake"` brief is **one** task, so a single accepted brake
  claim marks the steering half covered and the run can still reach `verified`. This is exactly the
  cherry-picking the review wanted to prevent, and the review's own `verified` rule does not stop
  it.
- Because a non-blank brief always yields ≥1 task, the readiness rule *"no canonical tasks → 0 /
  `not_ready`"* is **unreachable dead code** as written.
- Duplicate tasks inflate the gap list and consume search budget.

This correction lands in **PR 1**, which is where task extraction becomes server-owned and
canonical; PR 2's evidence contract consumes the result.

---

## 4. In-scope changes

- Immutable, server-owned planning context built from the request.
- Canonical tasks extracted server-side from the trusted brief, with conjunction splitting,
  deduplication, and degenerate-task rejection.
- Safety classifier recognizes "pads" / "shoes" in brake context, without mis-filing seat, pedal,
  or polishing pads.
- Inventory sentinels (`none`, `n/a`, …) treated as empty.
- Model-facing tools reduced to `search_repair_docs` and `finalize_repair_plan`.
- Structured claims validated against exact retrieved source text.
- Readiness recomputed from validated requirements plus trusted owner inventory.
- Raw model prose no longer reaches the browser.
- Provider and planner completion signals enforced.
- Evidence-status banner and incomplete-stream handling on the existing page.
- Focused tests and doc updates.

## 5. Explicit non-goals

No persistent plan runs, checklist conversion, "Start job", Planner-to-Job handoff, specification or
Quick Specs tables, diagnostic sessions, offline mode, voice/camera/multimodal, OBD, comparison
tools, general agent framework, database migrations, UI redesign, unrelated refactoring, or new
dependencies. The existing checklist and handoff artifacts get safer inputs but no new
functionality. No env flag. No acknowledgment checkbox.

---

## 6. Response and data contracts

### Request (unchanged shape)

```jsonc
{ "brief": "…", "skillLevel": "beginner|intermediate|advanced",
  "availableTools": "…", "availableParts": "…", "constraints": "…" }
```

`skillLevel` is validated against the enum (400 on a bad value) instead of silently defaulting.
Safety acknowledgment is **server-owned and always `false`** — no request field, no model field.

### `finalize_repair_plan` (model-facing)

```jsonc
{ "claims": [ {
    "taskId": 1,
    "kind": "procedure|numeric_spec|safety_instruction|vehicle_fact|required_tool|required_part|no_required_tools|no_required_parts",
    "claim": "verbatim technical statement",
    "sourceId": "S1",
    "evidenceQuote": "verbatim source excerpt",
    "itemName": "required only for required_tool / required_part"
} ] }
```

`claims` is required and may be empty — that is the honest `not_found` result. Unknown fields,
unknown task IDs, unrecognized kinds, or malformed entries make the call structurally invalid.

Source IDs are **run-wide**: any retrieved source may support any claim, since one chunk can
legitimately serve two tasks.

### Successful `done` frame

```jsonc
{ "type": "done", "status": "completed",
  "evidenceStatus": "verified|partial|not_found",
  "text": "server-rendered plan",
  "artifacts": {
    "tasks": [], "readiness": {}, "checklist": [], "handoffNotes": {},
    "citations": [],                                  // only sources supporting shown claims
    "requirements": { "tools": {}, "parts": {} },
    "evidence": { "verifiedClaims": [], "gaps": [] }
  } }
```

The narrative ships in `done.text` only — no synthetic `text_delta`.

### Failed run — `error` frame, no `done`

```jsonc
{ "type": "error",
  "code": "planner_incomplete|planner_invalid_output",
  "reason": "provider_incomplete|missing_terminal_event|malformed_tool_arguments|invalid_final_contract|turn_limit|no_canonical_task",
  "message": "fixed, safe user-facing message" }
```

`ai_not_configured` and the quiet client-disconnect path are unchanged.

---

## 7. Evidence-status rules (explicit)

A claim is **accepted** only when it passes every check in §8 rule 2. Otherwise it is **rejected**.

A canonical task is **covered** when it has ≥1 accepted technical claim **and** zero rejected
claims. A task marked `compound: true` (§9.1) is covered only when **each** of its action clauses
has ≥1 accepted claim.

| Status | Condition |
| --- | --- |
| `verified` | Every canonical task is covered, every displayed technical claim passed validation, and no required coverage gap remains. |
| `partial` | ≥1 accepted technical claim exists, but ≥1 task, requirement, or requested technical area is uncovered. |
| `not_found` | No technical claims were accepted from retrieved evidence. |

Binding sub-rules:

1. An empty `claims` array may only produce `not_found`. Never `verified`.
2. Every rejected claim emits an explicit gap naming what failed, and disqualifies its task from
   `covered`. Rejected claims must never silently vanish in a way that lets the surviving
   cherry-picked claims reach `verified`.
3. A **failed** search may never be reported as `not_found`. Empty search *results* may.
4. `verified` is a claim about **this run**, not about the manuals: it means every displayed claim
   passed the exact evidence checks. It does not mean the uploaded PDFs are complete. The banner
   must say so.

---

## 8. Readiness-calculation rules

1. Parse trusted inventories on commas, semicolons, and newlines; normalize case, spacing, and
   punctuation. Treat empty, `none`, `n/a`, `unknown`, and `not sure` as **no inventory**.
2. A requirement is usable only when its task and source IDs are valid, its quote appears in the
   retrieved chunk, its claim appears within that quote, `itemName` appears within the verified
   claim, and any number or unit in the claim is supported by the quote.
3. Inventory satisfies a requirement only when the complete normalized requirement phrase occurs in
   one inventory entry. No fuzzy or embedding matching.
4. Points: **25** complete verified tool group available · **25** complete verified part group
   available · **30** canonical tasks exist and none exceeds trusted skill · **20** canonical tasks
   exist and none is safety-critical.
5. A verified `no_required_tools` / `no_required_parts` claim satisfies that group. An empty
   requirement list alone never means "none required".
6. Any rejected, missing, conflicting, or unverified requirement zeroes that group and adds an
   explicit gap naming the missing items.
7. Thresholds stay 80 → `ready`, 50 → `almost_ready`, else `not_ready`, with hard caps:
   `not_found` → `not_ready`; `partial` → at most `almost_ready`; safety-critical work with server
   acknowledgment false → at most `almost_ready`; **no canonical task → 0 / `not_ready`** (now
   reachable, see §9.2).
8. `ready` therefore requires `verified` evidence, verified tool and part groups matched to
   inventory, adequate skill, and no unacknowledged safety-critical work.

---

## 9. Canonical task rules (Correction 4)

### 9.1 Splitting and deduplication

Existing delimiters (`\r?\n`, sentence-ending punctuation, `;`, `•`, ` - `) are unchanged.

#### Conjunction splitting

A fragment splits at a coordinating conjunction (`and`, `then`, `also`, `plus`, `as well as`) only
when **every** test passes. Word count and an automotive noun are not sufficient — an object list
and a procedure step both satisfy those and must not become tasks.

1. **Both sides ≥3 words** after trimming the conjunction and leading articles.
2. **Each side independently reads as a repair, inspection, or diagnostic action.** It must carry
   its own action verb — repair (`replace`, `swap`, `change`, `install`, `rebuild`, `bleed`,
   `flush`, `service`, `repair`, `fix`, `adjust`, `align`, `rotate`), inspection (`inspect`,
   `check`, `measure`, `test`), or diagnostic (`diagnose`, `troubleshoot`, `trace`, `scan`) — or a
   nominalized job (`oil change`, `brake job`, `alignment`, `tune-up`). A side made only of nouns is
   a continuation of the left side's verb.
3. **Each side has its own object** — an automotive component noun or a symptom phrase. A verb with
   no object of its own is a step, not a task.

Vehicle-handling verbs (`lift`, `raise`, `lower`, `support`, `secure`, `place`, `set`, `park`) are
deliberately **excluded** from the action set: they are setup steps within one repair, never
independent tasks.

**Default: do not split.** When any test is inconclusive, keep one task.

#### Required tests

Must split:

| Input | Result |
| --- | --- |
| `Replace the front brakes and diagnose a steering shake.` | 2 tasks — both sides have own verb + object, different systems |
| `Change the oil and rotate the tires.` | 2 tasks |

Must **not** split — object lists:

| Input | Why |
| --- | --- |
| `Replace the pads, rotors, and calipers.` | `and` terminates a noun list; right side has no verb (test 2) |
| `Replace the pads, rotors, and the front calipers.` | right side reaches 3 words but still has no verb (test 2) |
| `Remove the caliper and bracket.` | right side is a bare object (tests 1, 2) |
| `Check the pads and shims for wear.` | right side is a bare object (test 2) |

Must **not** split — procedure phrases:

| Input | Why |
| --- | --- |
| `Lift the car and support it on stands.` | `support` is a handling verb, object is a pronoun (tests 2, 3) |
| `Replace the front brakes and torque to spec.` | `torque to spec` is a step with no component object (tests 2, 3) |
| `Bleed the brakes and top off the reservoir.` | second clause is a step of the same job (test 2) |

#### Deduplication and IDs

- Normalize titles (lowercase, collapse whitespace, strip terminal punctuation) and
  **deduplicate**; a duplicate does not receive a second task ID.
- Task IDs remain stable, contiguous, and server-assigned.

#### Compound tasks: closing the hole strictness reopens

Strict splitting has a cost that must be paid explicitly. Under-splitting is **not** the safe
direction for evidence: an unsplit `"...brakes and...steering shake"` is one task, so §7 needs only
one accepted claim to mark it covered — the exact cherry-picking §1.3 identified. Over-splitting is
merely noisy (more gaps, lower readiness); under-splitting is unsound.

So when a fragment is **not** split but still contains a coordinating conjunction joining two action
clauses, mark the task `compound: true` and record its clauses. A compound task counts as
**covered** only when each of its action clauses has ≥1 accepted claim.

This keeps the displayed task list conservative and honest while preventing a single brake citation
from certifying an ungrounded steering diagnosis. Add a test: a compound task with evidence for only
one clause yields `partial`, never `verified`.

### 9.2 Degenerate-task rejection

A fragment becomes a canonical task only when it survives a validity test: it contains ≥3 words
**and** at least one automotive noun or repair verb. A brief that yields no valid task
(`"help"`, `"car makes noise"`) must **not** silently become a task titled after the brief.

- The run ends with `error` / `reason: "no_canonical_task"` and a message asking the owner to name
  the part or symptom.
- This is what makes §8 rule 7's zero-task branch reachable rather than dead code.

### 9.3 Safety classifier — context-aware `pads` / `shoes`

A global bare `\bpads?\b` was considered and **rejected**: it mis-files seat pads, pedal pads, and
polishing pads as brake work, which is exactly the substring over-matching the `\babs\b` comment in
that file warns against. Use a context-aware cue instead.

#### What the current rule already covers

Measured against `4e95ebf`, the existing pattern at
[safetyClassifier.js:53](../server/src/services/safetyClassifier.js#L53) already matches
`rear brake shoes`, `brake pads`, `pads and rotor`, and `caliper and pads` — because `brake`,
`rotor`, and `caliper` are standalone alternatives. The genuinely uncovered cases are **`front
pads`, `replace the pads`, `swap the pads`, and anything qualified only by `drum`** (which is not in
the pattern at all).

#### The rule

A `pads?` / `shoes?` token counts as brake friction work when the exclusion test passes **and** at
least one qualifier applies.

**Step 1 — exclusion (immediate left neighbour).** If the token directly preceding `pads`/`shoes` is
`seat`, `pedal`, `jack`, `lift`, `polishing`, `buffing`, `sanding`, `floor`, `knee`, or `elbow`, the
cue does not fire. Exclusion always wins over Step 2.

**Step 2 — qualifier (any one).**

| # | Qualifier | Example |
| --- | --- | --- |
| a | Positional word immediately left: `front`, `rear`, `left`, `right`, `inner`, `outer`, `driver`, `passenger` | `front pads`, `rear shoes` |
| b | Repair verb within 3 tokens to the left (articles allowed): `replace`, `swap`, `change`, `install`, `inspect`, `check`, `measure` | `replace the pads`, `swap the pads` |
| c | Brake-context term anywhere in the fragment: `brake(s)`, `braking`, `rotor(s)`, `caliper(s)`, `drum(s)`, `abs` | `pads on the drum` |

Also add `\bdrums?\b` as its own alternative in the brakes rule — "drum" has no competing
automotive sense on this vehicle.

**Scope:** the exclusion suppresses only the pads/shoes cue. It never suppresses other rules or
other alternatives. `"replace the seat pads and bleed the brakes"` is still brake-critical, because
standalone `\bbrakes?\b` fires on its own.

#### Required tests

Positive — must classify as **Brakes** / safety-critical:

| Input | Covered today? |
| --- | --- |
| `front pads` | no — new |
| `replace the pads` | no — new |
| `swap the pads` | no — new |
| `pads on the drum` | no — new |
| `rear brake shoes` | yes — regression guard |
| `pads and rotor` | yes — regression guard |
| `caliper and pads` | yes — regression guard |

Negative — the **brakes** rule must not fire:

| Input | Expected |
| --- | --- |
| `seat pads` | not safety-critical |
| `pedal pads` | not safety-critical |
| `polishing pads` | not safety-critical |
| `jack pads` | **safety-critical via the `lifting` rule, not `brakes`** |

> `jack pads` is a measured exception. It already resolves to `safetyCritical: true` with hazard
> `vehicle lifting` on `4e95ebf` — a correct result for a different hazard, since jacking a car is
> genuinely dangerous. Assert on the **matched rule id**, not on `safetyCritical`. A test asserting
> `safetyCritical === false` for `jack pads` would fail, and making it pass would mean weakening the
> lifting rule — a safety regression.

---

## 10. Safety-acknowledgment trust boundary

- No model-facing schema carries an acknowledgment field, and none can set trusted owner inputs.
- The server creates `safetyAcknowledged: false` inside a frozen trusted context.
- Trusted values are merged **over** model arguments at execution, so extra or duplicate model
  fields cannot override brief, tasks, inventory, skill, vehicle, or acknowledgment.
- Safety-critical tasks stay `Shop Recommended`, earn no safety points, and cannot reach `ready`.
- `ackSafety` remains a parameter of `checkRepairReadiness` / `buildOwnerChecklist` so the
  acknowledged path stays unit-tested and a future informed-consent UI has somewhere to plug in —
  it is simply unreachable from the model and the route. Designing that UI is out of scope.

## 11. Truncation and invalid-output handling

- A model turn is valid only after the provider emits `response.completed`.
- A plan is valid only after `finalize_repair_plan` passes structural validation.
- Empty search results may produce a completed `not_found` plan; **failed** searches may not be
  mislabeled `not_found`.
- An invalid finalizer is returned to the model for correction at most **twice** while budget
  remains.
- Provider truncation, malformed SSE, malformed arguments, exhausted turns, a missing finalizer, or
  no canonical task emit `error` and no artifacts.
- Unvalidated model prose is discarded and never reaches the browser.
- The browser treats EOF without a recognized terminal event as incomplete.

---

## 12. Pull-request split

Two stacked PRs. **PR 2 branches from PR 1.** Review separately, merge back-to-back, release
neither alone.

### PR 1 — Trust boundary, canonical tasks, and completion integrity

Covers outcomes 1, 2 (partially), 3, and 6, plus Corrections 1 and 4. Larger than the original PR 1
because the canonical-task layer and the two smallest readiness protections moved in; that is the
right seam, since PR 2's per-task coverage model is meaningless without them.

- **[repairTools.js](../server/src/services/agent/repairTools.js)** — strip `ackSafety`,
  `skillLevel`, `availableTools`, `availableParts`, and `tasks` from `repairToolSchemas`; keep the
  same parameters on the exported functions (server-supplied only). Add required `taskId` to
  `search_repair_docs`. Add conjunction splitting, title dedupe, and degenerate-task rejection to
  `extractRepairTasks`. Treat `none` / `n/a` / `unknown` / `not sure` / blank as no inventory at
  [:263-264](../server/src/services/agent/repairTools.js#L263).
- **[safetyClassifier.js](../server/src/services/safetyClassifier.js)** — context-aware `pads` /
  `shoes` cue plus standalone `drums?`, per §9.3. No global bare `pads` match.
- **[repairPlannerAgent.js](../server/src/services/agent/repairPlannerAgent.js)** — build and
  `Object.freeze` a trusted context (`brief`, `skillLevel`, `availableTools`, `availableParts`,
  `vehicle`, `safetyAcknowledged: false`); call `extractRepairTasks` server-side from the trusted
  brief before the loop; merge trusted values **over** model arguments at execution. Raise
  `maxTurns` 6 → 8. Turn-limit exhaustion and no-canonical-task emit `error`, never `completed`.
- **[openAiResponsesClient.js](../server/src/services/agent/openAiResponsesClient.js)** — require a
  `response.completed` terminal event before a turn returns normally; treat `response.incomplete`,
  EOF-without-completion, and malformed function arguments as typed failures (no more silent `{}`
  at [:162](../server/src/services/agent/openAiResponsesClient.js#L162)). A function call observed
  before an incomplete terminal event is never executed.
- **[repairPlan.js](../server/src/routes/repairPlan.js)** — validate the `skillLevel` enum; forward
  `code`/`reason` unchanged through SSE.
- **[RepairPlannerPage.jsx](../client/src/pages/RepairPlannerPage.jsx)** — track whether a
  recognized terminal event arrived; bare EOF becomes an error; only `done.status === "completed"`
  renders results.

**PR 1 exit state, stated honestly. PR 1 is not release-complete.**

What PR 1 fixes: the trust boundary is closed, completion integrity is enforced, the canonical task
list is server-owned and sane, `"none"` inventories score zero, and safety-critical brake work can
no longer be model-unlocked to `ready`.

What PR 1 does **not** fix:

- **Raw model prose still streams to the browser, unvalidated.** `text_delta` suppression is a PR 2
  change ([repairPlannerAgent.js:137-139](../server/src/services/agent/repairPlannerAgent.js#L137)
  is untouched by PR 1). After PR 1 the owner still reads an ungrounded narrative that may contain
  invented torque specs and capacities, rendered with the same authority as sourced text. Nothing
  in PR 1 verifies, suppresses, or marks that prose.
- **Readiness points are still not matched against what the repair requires.** The rubric awards
  tools/parts credit for any non-sentinel inventory string; requirement-to-inventory matching
  arrives in PR 2.
- **There is no evidence status.** `verified` / `partial` / `not_found` does not exist until PR 2,
  so nothing tells the owner how much of the plan is grounded.

Until PR 2 lands, label readiness **provisional** in the UI and do not present the narrative as
document-grounded. This is why the two PRs are one milestone and why no release is cut between
them.

### PR 2 — Evidence contract and real readiness

Covers outcomes 4 and 5 and completes outcome 2, plus Correction 2.

- **New `server/src/services/agent/repairPlanEvidenceContract.js`** — validates finalizer shape,
  canonical task IDs, source ownership, quotes, claims, requirement names, and numbers; derives
  evidence status per §7, gaps, accepted citations, and requirement groups; renders the final text
  from accepted claims plus fixed organizational guidance. Reuses `quoteAppearsInChunk`,
  `checkClaimNumbers`, and `redactSpecNumbers` from `askEvidenceContract.js`. Does **not** reuse
  Ask's schema, renderer, or `"answered"` status.
- **[repairTools.js](../server/src/services/agent/repairTools.js)** — add the
  `finalize_repair_plan` schema; assign run-wide source IDs (`S1`, `S2`, …) and retain full chunk
  text server-side while returning full (length-capped) evidence context to the model and
  `buildSnippet` output for the citation UI; change `checkRepairReadiness` to accept validated
  requirement groups plus trusted inventory instead of raw strings.
- **[repairPlannerAgent.js](../server/src/services/agent/repairPlannerAgent.js)** — stop emitting
  `text_delta` entirely (discard model prose, including prose emitted before a tool call); require
  a valid finalizer before completion; return a structurally invalid finalizer to the model for
  correction at most twice while turn budget remains; build readiness, checklist, and handoff notes
  server-side from validated data and ship them in `done`.
- **[RepairPlannerPage.jsx](../client/src/pages/RepairPlannerPage.jsx)** — render the narrative from
  `done.text`; add a compact `verified` / `partial` / `not_found` banner; drop the provisional
  readiness label; keep the existing cards.
- **Docs** — [repair-planner.md](repair-planner.md) (rewrite the stale rubric table at
  [:51-60](repair-planner.md#L51) and the "Truncated runs" section at
  [:94-101](repair-planner.md#L94)), [api.md:332-348](api.md#L332), and
  [QA_CHECKLIST.md:130](../QA_CHECKLIST.md#L130) (drop "streams in progressively").

**Why full chunk text, not 220-char snippets:** quotes must be copied from what the model can
actually see. Ask already passes full `chunkText`
([askEvidenceContract.js:80](../server/src/services/askEvidenceContract.js#L80)); snippets would
cripple grounding coverage. `buildSnippet` stays for the citation UI.

---

## 13. Required automated tests

**New — `server/test/repairPlanEvidenceContract.test.js`**
- Exact source + quote + claim + number + task association passes.
- Unknown source, fabricated quote, paraphrased technical claim, and unsupported number all fail.
- A source containing `25 ft-lb` cannot verify `54 Nm`, and the unsupported value appears in neither
  the rendered text nor the gaps (redaction).
- §7 status derivation across single- and multi-task plans, including: empty `claims` → `not_found`
  only; one accepted claim plus one rejected claim on the same task → `partial`, never `verified`;
  every rejection produces a gap.
- Unsupported required tools/parts add zero readiness points.
- Server-authored organizational guidance ("prepare a workspace") needs no citation.

**New — canonical task tests (extend `repairPlanner.test.js` or a focused file)**
- `"Replace front brake pads."` → exactly 1 task.
- `"Replace the front brakes and diagnose a steering shake."` → **2** tasks (regression test for
  §9.1; currently 1).
- Duplicate wording in one brief → 1 task, not 2.
- `"help"` and `"car makes noise"` → `error` / `no_canonical_task`, not a vague completed task.
- A 7-clause brief → all tasks extracted; run completes within `maxTurns` 8 using batched
  per-turn tool calls; status is `partial` rather than a failure when coverage is incomplete.
- **Split negatives (§9.1)** — each stays **1** task: `"Replace the pads, rotors, and calipers."`,
  `"Replace the pads, rotors, and the front calipers."`, `"Remove the caliper and bracket."`,
  `"Check the pads and shims for wear."`, `"Lift the car and support it on stands."`,
  `"Replace the front brakes and torque to spec."`,
  `"Bleed the brakes and top off the reservoir."`
- **Compound coverage (§9.1)** — an unsplit compound task with evidence for only one clause yields
  `partial`, never `verified`.

**New — safety classifier tests (§9.3)**
- Positive, must be Brakes / safety-critical: `front pads`, `replace the pads`, `swap the pads`,
  `pads on the drum` (all new), plus regression guards `rear brake shoes`, `pads and rotor`,
  `caliper and pads`, `brake pads`.
- Negative, brakes rule must not fire: `seat pads`, `pedal pads`, `polishing pads`.
- `jack pads` → assert the matched rule is `lifting`, **not** `brakes`. Do not assert
  `safetyCritical === false`; it is legitimately critical for a different hazard (§9.3).

**Extend [repairPlanner.test.js](../server/test/repairPlanner.test.js)**
- A mock model sending `ackSafety: true`, replacement tasks, inflated inventories, and
  `skillLevel: "advanced"` changes nothing in the result.
- `"none"` / `"n/a"` inventories score zero.
- Missing, partial, fully matched, and explicitly-unnecessary requirement groups score correctly.
- `response.completed` succeeds; `response.incomplete`, malformed SSE, malformed function
  arguments, missing terminal event, missing finalizer, and turn exhaustion never emit `completed`
  — **replaces the current assertion at
  [:645-664](../server/test/repairPlanner.test.js#L645)**.
- No `text_delta` frame is emitted at all; retrieved-but-unused sources are absent from citations.
- Route: an invalid `skillLevel` returns 400.
- Rewrite the "streams ≥1 text delta" assertion at
  [:465](../server/test/repairPlanner.test.js#L465) to assert tool events and a `done.text` plan.

**Extend [repairSafetyEndToEnd.test.js](../server/test/repairSafetyEndToEnd.test.js)**
- Existing safety-classification matrix still passes; safety-critical work stays
  `Shop Recommended` under the server-owned false acknowledgment.

**Extend [RepairPlannerPage.test.jsx](../client/src/pages/RepairPlannerPage.test.jsx)**
- `verified` / `partial` / `not_found` banners render.
- Bare EOF, an unrecognized `done`, or an `error` frame shows failure rather than results.
- Update the brake fixture at [:57-72](../client/src/pages/RepairPlannerPage.test.jsx#L57) so
  unacknowledged brake work is neither `Ready` nor `DIY`.

**Commands**

```bash
npm --prefix server test -- test/repairPlanner.test.js test/repairPlanEvidenceContract.test.js test/repairSafetyEndToEnd.test.js test/askEvidenceContract.test.js
```

```bash
npm --prefix client test -- RepairPlannerPage
```

```bash
npm run lint && npm run typecheck && npm run test && npm run build && npm run smoke
```

---

## 14. Manual verification checklist

Run `npm run dev`, open `/repair-planner` (use a sample PDF so there is something to cite).

1. Brake repair with complete-looking tools and parts → stays below `Ready`, shows
   `Shop Recommended`.
2. `"Swap the front pads."` → classified safety-critical, does **not** reach `Ready`.
3. `"none"` for tools and parts → neither rubric item passes.
4. `"Replace the front brakes and diagnose a steering shake."` → two tasks listed, each with its own
   coverage state.
5. `"help"` → clear validation error naming what is missing; no plan rendered.
6. Repair with a known manual torque value → the displayed value matches an exact cited excerpt;
   status is `verified` only when every §7 rule passes.
7. Ask for a spec absent from the documents → omitted, status `partial` or `not_found`, readiness
   does not increase, and the number is not reprinted in the gaps.
8. Multi-repair brief where only one task has evidence → `partial`.
9. Empty workspace (no PDFs) → `not_found` + `not_ready` with a banner explaining why, not a blank
   panel.
10. Interrupt a stream mid-run → incomplete/error banner, no finished plan.
11. Source links still open the correct document and page.
12. No-key behavior unchanged (`ai_not_configured`).

---

## 15. Risks and backward compatibility

- **Strict matching produces false negatives.** Intentional — uncertain items become gaps rather
  than optimistic readiness.
- **`verified` will be rare, and `ready` rarer.** §7 requires every canonical task covered, and §8
  requires `verified` for `ready`. On a multi-repair brief against a thin document set, `partial` /
  `almost_ready` is the expected steady state. This is the correct safety posture but it should be
  a deliberate, communicated choice rather than a surprise.
- **Readiness scores will drop, often sharply**, and an empty workspace now yields `not_found` /
  `not_ready` for every brief. That is the intended correction, and the most visible change an owner
  will notice.
- **Degenerate briefs now fail instead of producing a vague plan.** Better than false confidence,
  but it is a new user-facing rejection path; the message must name what to add.
- **Strict conjunction splitting risks *under*-splitting**, which is the unsound direction: one task
  needs only one accepted claim, so a merged "brakes and steering" task could be certified by brake
  evidence alone. The `compound` coverage rule (§9.1) is what contains this, and it is load-bearing
  — if it is dropped during implementation, the strictness in §9.1 becomes a safety regression
  rather than a precision improvement.
- **The context-aware `pads` cue will still miss unusual phrasings** (e.g. "friction material" with
  no brake noun nearby). It is a precision/recall trade chosen to avoid mis-filing seat and
  polishing pads; the residual misses are narrower than the class it fixes.
- **Progressive narrative is gone** (user-confirmed). `status` / `tool_call` / `tool_result` still
  stream, so the run is not silent, but `QA_CHECKLIST.md:130` must be updated rather than left to
  fail.
- **Compatible:** `done.status: "completed"`, existing artifact keys, SSE event names, and request
  fields are unchanged. `evidenceStatus`, `requirements`, and `evidence` are additive. `text_delta`
  stays in the documented protocol but is no longer emitted by the planner.
- **Cost:** the finalize turn adds roughly one model call per run. The shared 20-req/min limiter and
  `AI_DAILY_CALL_LIMIT` are unchanged and still bound spend.
- Ask's public response format is untouched; only its config-free helper functions are reused.
- No database, uploads, backup, deployment, or dependency work.

## 16. Completion criteria

The milestone — **both PRs** — is complete when:

- No model-facing schema can set acknowledgment or any trusted owner readiness input.
- Safety-critical work cannot become `Ready` or `DIY` under the server-owned false acknowledgment,
  **including** briefs phrased as `front pads` or `swap the pads` — while `seat pads`,
  `pedal pads`, and `polishing pads` are not mis-filed as brake work.
- `"none"` / `"n/a"` / blank inventories earn zero readiness points.
- Compound briefs split only when each side is an independent repair, inspection, or diagnostic
  action; object lists and procedure steps stay one task; an unsplit compound task requires
  evidence for every clause. Duplicates collapse; degenerate briefs are rejected rather than
  silently planned.
- Tools and parts earn points only through validated requirements matched to trusted inventory.
- Every displayed technical claim is backed by an accepted source and quote; rejected claims and
  their numbers never appear as verified content, and every rejection produces a gap.
- Every complete result carries exactly one of `verified` / `partial` / `not_found` under §7.
- Truncated, malformed, failed, or structurally incomplete runs never emit
  `done.status: "completed"` and never render artifacts.
- All focused and full validation commands pass.
- `docs/api.md`, `docs/repair-planner.md`, and `QA_CHECKLIST.md` describe the new contract
  accurately.
- Neither PR contains any excluded feature or speculative infrastructure.
