# Repair Planner Agent

The Repair Planner turns a rough, free-text repair brief for the 2009 Toyota
Corolla into an actionable plan: a prioritized narrative, a readiness score, an
owner checklist, and handoff drafts. It streams its progress (tool calls, not
model text) to the browser as it works; the narrative itself arrives whole in
the final `done` frame, rendered server-side from verified claims. A brief too
vague to plan fails outright with `no_canonical_task` rather than prompting the
owner with follow-up questions.

It is the agent-shaped sibling of Ask AI: where Ask AI
answers one question from PDF chunks, the Repair Planner runs a multi-step
tool-calling loop and assembles structured artifacts.

## Why it is built this way

This repo deliberately avoids heavy dependencies — `aiAnswerService.js` already
calls the OpenAI Responses API directly with `fetch` and uses dependency
injection for testability. The Repair Planner follows the same conventions
instead of pulling in a separate agents framework:

- The same tool-calling loop, deterministic tools, and streamed deltas an agent
  SDK would give us, implemented in ~3 small modules.
- Every external dependency (the model client, the document retriever) is
  injectable, so the whole pipeline is testable with Node's built-in test runner
  and no live API key.

## File map

| File | Responsibility |
| --- | --- |
| `server/src/services/agent/repairTools.js` | Deterministic tools + JSON schemas + tool registry |
| `server/src/services/agent/openAiResponsesClient.js` | Streaming Responses API client (`stream: true`, SSE parsing) — the only key-dependent piece |
| `server/src/services/agent/repairPlannerAgent.js` | The tool-calling loop; emits ordered events |
| `server/src/services/agent/tracing.js` | Lightweight span tracer (observability hook) |
| `server/src/services/agent/planRunStore.js` | In-memory, bounded, TTL'd store for readiness inputs (`planRunId`) and checklist drafts (`checklistDraftId`) |
| `server/src/services/agent/plannerChecklistDraft.js` | Builds the checklist a completed run can be saved as |
| `server/src/routes/repairPlan.js` | `POST /api/repair-plan` Server-Sent-Events route |
| `server/src/routes/repairChecklists.js` | Checklist CRUD **and** `POST /api/repair-checklists/from-planner` |
| `client/src/pages/RepairPlannerPage.jsx` | Frontend form + live stream consumer + result cards |

## Tools

Each tool is a plain, deterministic function with a JSON schema so the model
knows how to call it. Keeping the executors deterministic means the structured
artifacts the UI renders never depend on model randomness.

| Tool | What it does |
| --- | --- |
| `extract_repair_tasks` | Returns the canonical, server-derived task list. Takes **no arguments** |
| `search_repair_docs` | Retrieves relevant chunks from uploaded PDFs (reuses `chunkRetrievalService`). Requires a canonical `taskId` |
| `check_repair_readiness` | Skill and safety picture for the canonical tasks. Takes **no arguments** |
| `build_owner_checklist` | Produces a prioritized checklist with DIY vs professional-shop assignment. Takes **no arguments** |
| `draft_handoff_notes` | Drafts channel-specific copy: a parts shopping list, a mechanic handoff, and a maintenance-log entry |
| `finalize_repair_plan` | Submits the finished plan as atomic, individually-cited claims. Required before a run can complete |

### Trust boundary

No model-facing schema exposes `brief`, `tasks`, `skillLevel`, `availableTools`,
`availableParts`, or `ackSafety`. Those are owner facts: the server builds a
frozen trusted context from the request, derives canonical tasks from the
trusted brief before the loop starts, and the executors read that context
instead of the model's arguments. Arguments attempting to set them are ignored.
Safety acknowledgment is always `false` during generation — no model-facing
schema can set it, so a generated plan is never pre-acknowledged and
safety-critical work starts as `Shop Recommended`.

### Safety acknowledgment

The readiness rubric charges 20 points for "Safety-critical work acknowledged"
and refuses to report `ready` without it. That requirement used to have no
control anywhere that could satisfy it, so a safety-critical plan could never
reach Ready. The owner now supplies it **after** reading the plan:

- A completed run whose readiness is `safetyCritical` is recorded in
  `planRunStore.js` (in memory, bounded, TTL'd — never SQLite) and its
  `runId` ships to the browser as `artifacts.planRunId`. A plan with no
  safety-critical work gets no run id and never shows the control.
- `POST /api/repair-plan/:runId/safety-acknowledgment` takes `{ acknowledged:
  boolean }` and **nothing else**. Tasks, skill level, requirement groups, and
  evidence status all come back out of the server's own record, and
  `checkRepairReadiness` / `buildOwnerChecklist` re-run over them. A client
  cannot re-label brake work as non-critical, hand itself satisfied requirement
  groups, or raise its skill level to buy points.
- The route is outside the shared AI rate-limit window: it makes no model call,
  so ticking a box must not spend the budget shared with `/api/ask`.
- The acknowledgment is not persisted. It belongs to one generated plan: a new
  run mints a new id, and Clear, a regenerated plan, or a failed stream drops it
  with the run it belonged to.
- `RepairPlannerPage.jsx` renders the checkbox inside the readiness card,
  `aria-describedby` the rubric row it unlocks plus a statement that
  acknowledging does not mean the repair is safe, correct, or suited to the
  owner's skill. The checked state shown is the one the server scored, never a
  local guess.

### Saving a plan as a repair checklist

A finished plan is a good starting point for a checklist the owner actually
works from, so **every** completed run — `verified`, `partial`, and `not_found`
alike — can be saved as one. The mechanism is the same trust boundary as the
acknowledgment above, for the same reason: a saved checklist is a **durable
SQLite record**, and if its text arrived from the browser then a tampered
request could write an invented torque figure into permanent storage wearing the
planner's authority.

- When a run completes, `plannerChecklistDraft.js` builds the checklist from
  validated output only and `planRunStore.js` holds it under a
  `checklistDraftId`. The browser gets `artifacts.checklistDraft` to **preview**
  and `artifacts.checklistDraftId` to save it by.
- `checklistDraftId` is **separate from `planRunId`**. They authorize different
  things and are minted under different conditions: only a safety-critical plan
  has anything to acknowledge, while every completed plan is saveable. One id
  doing both jobs would leave non-safety-critical plans unsaveable.
- `POST /api/repair-checklists/from-planner` takes `{ checklistDraftId }` and
  nothing else. Task text, claims, warnings, evidence, and a `sources` array in
  the body are ignored. Keeping that boundary was a design constraint of N3.2:
  the browser must not become the authority for which document backed a repair.
- **In the draft:** a `planned` checklist titled from the canonical tasks, one
  normal item per high-level task, and notes carrying the accepted claims with
  their document and page, the verified tool/part requirements, and the safety
  warnings for those tasks. A `not_found` run saves the tasks and warnings plus
  an explicit notice that nothing was verified — an honest empty result is still
  worth keeping.
- **Also in the draft since N3.2:** `sources`, the *structured* twin of those
  citations — `documentId` + `documentTitle` snapshot + `pageNumber`, deduplicated
  first-seen. The prose citation stays; this is what a query can follow. It is
  written to `repair_checklist_documents` in the same transaction as the
  checklist and its items, and is later copied into a `repair_history` record by
  `POST /api/repair-checklists/:id/complete`. See `docs/api.md`.
- **Never durable provenance:** `sourceId` values (`S1`, `S2`, …), chunk ids,
  embedding ids, and the plan run id. Source ids are run-scoped, chunk rows are
  rebuilt on re-extraction, and the run expires in hours — none of the three can
  be resolved by someone reading the repair history weeks later.
- **Never in the draft:** model prose, the run's gaps, the placeholder
  owner-checklist steps, the handoff drafts, the readiness score or
  acknowledgment state, and every rejected claim. `plannerChecklistSave.test.js`
  asserts each of these against the database, not against the draft object.
- The checklist and all its items are written in **one transaction**: a plan is
  never saved as a titled checklist with half its tasks missing, which would
  look finished while silently dropping work.
- Saving the same draft twice returns the checklist it already became rather
  than creating a duplicate; the page also disables the button while the request
  is in flight and after it succeeds.
- Drafts expire with the run store (bounded, six hours, never SQLite). An
  unknown or expired id is a 404 whose message tells the owner to build the plan
  again. The saved checklist itself is permanent and unaffected.
- The result is an **ordinary** checklist — editable, deletable, with no stored
  link back to the plan. There is no migration and no planner-to-checklist
  relationship. The saved statements are reference notes, not check-off repair
  instructions.

### Canonical tasks

Tasks come from the brief, split on sentence punctuation **and** on coordinating
conjunctions — but only when both sides independently carry their own action
verb and object, so object lists ("pads, rotors, and calipers") and procedure
steps ("lift the car and support it on stands") stay one task. A fragment kept
whole despite a conjunction is marked `compound` with its `clauses`, and the
evidence contract then requires a claim per clause. Titles are deduplicated, and
a brief too vague to yield a task fails the run with `no_canonical_task` rather
than becoming a task named after the brief.

### Evidence contract

`finalize_repair_plan` takes `claims[]`, each with a `taskId`, a `kind`, the
`claim` text, a `sourceId` (`S1`, `S2`, … assigned run-wide, so one chunk can
support two tasks), and a verbatim `evidenceQuote`. Claims for a `compound` task
also carry a `clauseIndex`. `required_tool` / `required_part` add an `itemName`.

`server/src/services/agent/repairPlanEvidenceContract.js` then checks, in order:

1. the quote appears, on word and number boundaries, in the text the model was
   shown (`quote_not_in_source`);
2. the claim appears word-for-word inside its own quote (`claim_not_in_quote`);
3. where the claim sits (audit 1A-05, owner decision D2) — read in the
   **source**, so trimming the quote too does not get around it:
   - no "not", "no", "never", "without", "cannot", or "n't" in the three words
     before the claim within its clause (`negation_dropped`);
   - no cut through a range or a signed value: "14.8 V" from "13.2 to 14.8 V",
     "37 °C" from "-37 °C" (`range_cut`);
   - a `numeric_spec` or `safety_instruction` must be a whole clause of its
     quote, from one `.` `;` `:` `!` `?` or `|` boundary to the next
     (`not_whole_clause`). Other kinds may be any part of the quote that passes
     the two rules above;
4. every number in the claim is printed in the quote (`unsupported_number`);
5. the claim names what it is about (audit 1A-06/1B-01, `subject_missing`):
   - any claim carrying a figure, and every `numeric_spec`, must contain a word
     that is not a unit, a function word, a repair verb, a position, or
     "torque" — so a bare "37 N*m" never counts toward coverage;
   - a `numeric_spec` must also share such a word with its **task** (the
     clause its `clauseIndex` names, for a compound task), in the claim or in
     its quote. Ask's subject guard could not do this: a planner claim is a
     verbatim fragment of its quote, so its part is always "in the quote";
6. a `required_tool` / `required_part` `itemName` is at least two words or
   four letters (`item_name_too_short`) and appears in the claim as whole
   words (`item_not_in_claim`).

Anything that fails becomes a **gap** with its numbers redacted — reprinting an
unverified torque value inside a warning still puts it in front of the owner.
Structural problems are handed back for at most **two** corrections before the
run fails.

What these checks prove is where a statement came from, and that its value,
negation, and part survived the copy. They do **not** prove it is the whole
step or the right one: the whole-clause rule is measured against the quote, so
a quote that itself stops mid-sentence can leave out a trailing qualifier ("at
2,000 rpm"); a comma is not a boundary, so a later stage ("then a further 90°")
is not tied to the first; extracted tables carry no separators between rows, so
a table value is a whole clause only when its quote is that one row (the model
is told to quote it that way); and part matching is lexical, so it can reject an
honest claim whose quote does not repeat the task's wording, and cannot tell
two parts apart when both share a word with the task.

| Status | Meaning |
| --- | --- |
| `verified` | Every canonical task is covered, every displayed claim passed, and both requirement groups resolved |
| `partial` | At least one accepted claim, but some task, clause, or requirement is unresolved |
| `not_found` | No technical claim was accepted. An empty `claims` array can only ever be this |

`verified` describes **this run**, not the manuals: it means every displayed
statement passed the checks, not that the uploaded PDFs cover the whole repair.

### Readiness rubric

| Item | Points | Met when |
| --- | --- | --- |
| Required tools verified and on hand | 25 | Every verified `required_tool` name is owned per the inventory rule below, or a cited procedure states none are required |
| Required parts verified and on hand | 25 | Same rule for `required_part` |
| Skill matches difficulty | 30 | Canonical tasks exist and none is rated above the stated skill level |
| Safety-critical work acknowledged | 20 | Canonical tasks exist and none is safety-critical (acknowledgment is server-owned `false`) |

Score ≥ 80 → `ready`, ≥ 50 → `almost_ready`, otherwise `not_ready`, with hard
caps: `not_found` → `not_ready`; `partial` → at most `almost_ready`;
unacknowledged safety-critical work → at most `almost_ready`; no canonical task
→ 0 / `not_ready`.

Inventory matching is whole-word, with no fuzzy or embedding guesses, because a
wrongly-awarded point tells an owner they are ready for a brake job they cannot
finish (audit 1A-07; until then it was a raw substring test). Both the
requirement name and each inventory entry go through one normalizer
(`normalizeRequirementName`: lowercase, hyphens and punctuation to spaces,
parenthetical asides dropped, "n't" to "not", "&" to "and"). An entry owns an
item when the item's words appear whole and **end** a name in it — "3-ton floor
jack" owns a jack, but "jack stands" does not, nor does "110 mm wrench" own a
"10 mm wrench" — though a joiner (`and`, `or`, `plus`, `with`, `but`) may
follow, so "jack and jack stands" owns both. An entry with an absence word
before the item ("no torque wrench", "don't have a jack", "need brake pads")
counts as absent; "No. 2 Phillips" is a size, not a negation. This fails
closed: "torque wrench 1/2 drive" does not own a torque wrench (an aside in
parentheses would). `none`, `n/a`, `unknown`, and `not sure` are treated as an
empty inventory. An empty requirement list never means "none
required"; only a grounded `no_required_tools` / `no_required_parts` claim does.

## Streaming protocol

`POST /api/repair-plan` responds with `text/event-stream`. Each agent event is
one `data: <json>\n\n` frame. Event types:

| `type` | Meaning |
| --- | --- |
| `status` | Human-readable progress message |
| `tool_call` | The model asked to run a tool (`name`, `turn`, and `taskId` / `claimCount` where they apply — never its arguments) |
| `tool_result` | A tool finished (`name`, `summary`) |
| `trace` | A finished tracing span (observability) |
| `ai_not_configured` | No `OPENAI_API_KEY` is set; the run stops gracefully |
| `error` | The run failed (`code`, `reason`, fixed `message`) |
| `done` | Final event with `status`, `evidenceStatus`, the server-rendered `text`, and assembled `artifacts` (including `checklistDraft` / `checklistDraftId`, and `planRunId` when the plan is safety-critical) |

`text_delta` remains in the documented protocol but **the planner no longer
emits it**. Model prose is discarded, including prose emitted before a tool
call: the plan the owner reads is rendered by the server from validated claims.
`status`, `tool_call`, `tool_result`, and `trace` still stream, so a run is not
silent.

### What a tool frame may carry

**No frame carries a model argument.** `tool_call` used to forward the model's
raw `arguments`, so every claim submitted to `finalize_repair_plan` — including
the ones the evidence contract then rejected — reached the activity log looking
like part of the plan (audit 1A-15). The frame is now built from an allow-list
in `describeToolCall`:

```jsonc
{ "type": "tool_call", "name": "search_repair_docs", "turn": 1, "taskId": 1 }
{ "type": "tool_call", "name": "finalize_repair_plan", "turn": 2, "claimCount": 5 }
```

- `name` is one of the tools in `repairToolSchemas`. A function name the
  planner never offered is model text too, so it arrives as `unknown_tool`.
- `turn` is the 1-based model turn, counted by the server.
- `taskId` appears on a search only when it names a canonical task; an
  invented id is dropped, not coerced.
- `claimCount` appears on the finalizer: how many claims were submitted, before
  verification. The verified count is in `done.artifacts.evidence`.

The same rule covers the other frames. A search's `tool_result` summary names
the canonical task (`Retrieved 3 passages for "Replace the front brake pads".`)
rather than the model's query, error summaries never echo the value that was
rejected, and trace spans carry the same sanitized tool name. The
model still receives its full arguments and tool outputs; only the browser
copy is narrowed. `server/test/plannerSseLeak.test.js` asserts that a rejected
claim's value, and a marker planted in a query, an invalid task id, and an
invented tool name, appear in no frame at all.

Request body: `{ brief, skillLevel, availableTools, availableParts, constraints }`.
Only `brief` is required.

### Disconnect handling

The agent should be cancelled when the browser actually goes away, but **not**
when the request body simply finishes being read. The route therefore wires its
`AbortController` to the **response** stream's `"close"` event (guarded by
`response.writableFinished`), never to the request's `"close"` — Node fires the
latter as soon as `express.json()` has consumed the POST body, which would abort
the in-flight OpenAI request the instant streaming begins and surface a spurious
`error` frame reading "This operation was aborted". A genuine disconnect aborts
the OpenAI `fetch`; the resulting `AbortError` is treated as a quiet end (no
`error` frame), since there is no client left to receive one. Real model/network
failures (4xx/5xx, stream-parse errors) still surface verbatim through `error`.

### Incomplete runs

An incomplete run is a **failure**, not a success with less content. It emits an
`error` frame with a `code` and `reason` and **no** `done` frame and **no**
artifacts, so the browser can never render a readiness score for a run that
produced no plan.

| `reason` | Cause |
| --- | --- |
| `no_canonical_task` | The brief was too vague to yield a task. Fails before any model call |
| `turn_limit` | `maxTurns` (8) exhausted without a validated finalizer |
| `invalid_final_contract` | The model stopped without finalizing, or used up both correction attempts |
| `provider_incomplete` | The provider sent `response.incomplete` |
| `missing_terminal_event` | The stream ended without `response.completed` |
| `malformed_tool_arguments` | Tool arguments would not parse — previously silently became `{}` |

A model turn is valid only after `response.completed`. Function calls are
buffered until then, so a truncated turn executes none of them. On the browser
side, a stream that ends without a recognized terminal frame is treated as
incomplete, and only `done.status === "completed"` renders results.

## Setup

Set the key in the server environment (see `.env.example`):

```
OPENAI_API_KEY=sk-...
OPENAI_ANSWER_MODEL=gpt-5.5-2026-04-23
```

`gpt-5.5-2026-04-23` is the pinned repository default for the Responses API.
The app detects this GPT-5 reasoning-family model and sends `reasoning.effort`
instead of unsupported `temperature`. You can override it with any model ID
available to your OpenAI API account. Without a key the feature still loads and
returns the `ai_not_configured` event.

## Extending it

- **Add a tool:** add an executor + JSON schema in `repairTools.js`, register it
  in `createToolRegistry`, add the schema to `repairToolSchemas`, and (if it
  produces a UI artifact) accumulate it in `repairPlannerAgent.js` and render it
  in `RepairPlannerPage.jsx`.
- **Add a handoff target:** extend `draftHandoffNotes`.
- **Swap the model client:** anything matching the `streamTurn` async-generator
  interface can be injected via `runRepairPlannerAgent(..., { streamTurn })`.

## Local verification

Unit + integration tests (no API key needed — a mock model client is injected):

```
npm --prefix server test     # tools, agent loop, and the SSE route end-to-end
npm --prefix client test     # the page streams activity, text, and artifacts
```

The server suite includes an end-to-end test that POSTs to `/api/repair-plan`
and asserts the stream contains at least one tool event, **zero** `text_delta`
frames, and a `done` frame carrying the server-rendered plan text.

### Live end-to-end check (requires a real key + network egress)

The automated tests use a mock model, so run this once against the real API to
confirm key-backed streaming works in your environment:

```
# 1. Put OPENAI_API_KEY in server/.env (copied from .env.example)
# 2. Start both servers
npm run dev

# 3. In another terminal, stream a real run and watch the event types
curl -N -X POST http://localhost:4000/api/repair-plan \
  -H "Content-Type: application/json" \
  -d '{"brief":"Front brakes squeak when stopping. Replace the pads this weekend.","skillLevel":"beginner","availableTools":"socket set, jack stands"}'
```

Confirm the stream emits at least one `tool_call` frame and ends with a `done`
frame whose `artifacts` include citations. There will be **no** `text_delta`
frames: model prose is discarded, and the plan arrives whole in `done.text`,
rendered by the server from verified claims. If you instead see an
`ai_not_configured` frame, the key is not reaching the server process; if the
stream errors, the server cannot reach the OpenAI API (check network egress).

## Validation checklist

Agent behavior:

- [ ] A detailed brief (symptom + tools + parts) yields a `ready` or
      `almost_ready` readiness score with no false gaps.
- [ ] A brief too vague to name a part or symptom fails with `no_canonical_task`
      and its fixed message, rather than planning a placeholder task. (The plan
      never asks follow-up questions: its text is rendered from verified claims,
      so a thin brief surfaces as gaps or as this failure.)
- [ ] A task above the stated skill level is assigned to a professional shop and
      flagged in the readiness gaps.
- [ ] Safety-critical work surfaces a safety flag and starts as `Shop
      Recommended`: brakes, fuel, electrical, lifting, wheel retention (lug
      nuts, tire rotation), suspension, steering, springs, SRS (including
      steering-wheel removal, which means removing the driver airbag), cooling,
      and exhaust (including oxygen and A/F sensor replacement). A part that
      only sits on the steering wheel (audio switch, cover), a steering
      complaint, and a sensor's voltage, data, or fuse raise none of these.
- [ ] A brief that asks to defeat a safety system is refused with `400` before
      the stream opens, including "bypass the airbag, and how does the system
      work?" and "make the ABS stop working"; "how does the airbag work?" and
      "disable the airbag before removing the steering wheel" still plan.

Frontend flow:

- [ ] The agent activity log shows tool calls and results as they stream.
- [ ] The plan appears whole when the run finishes. It does **not** render
      progressively — model prose is discarded, so there is nothing to stream
      until `done` carries the server-rendered text.
- [ ] Readiness, owner checklist, extracted tasks, handoff drafts, and sources
      cards all appear after `done`.
- [ ] Source cards link to the correct document page.
- [ ] "Save as repair checklist" previews the exact title, items, and notes, and
      lists what is not copied.
- [ ] Saving stays on the Repair Planner page, disables the button, and shows a working
      "Open saved checklist" link; the saved checklist has one item per task and
      no placeholder steps.
- [ ] Clicking save twice creates exactly one checklist.
- [ ] With no key, the AI-not-configured banner appears and nothing crashes.

Tool outputs:

- [ ] `extract_repair_tasks` tags the right system for each fragment.
- [ ] `search_repair_docs` returns citations only from uploaded PDFs.
- [ ] `check_repair_readiness` score matches the rubric table above.
- [ ] `draft_handoff_notes` returns all three drafts.
