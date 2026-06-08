# Repair Planner Agent

The Repair Planner turns a rough, free-text repair brief for the 2009 Toyota
Corolla into an actionable plan: a prioritized narrative, a readiness score, an
owner checklist, handoff drafts, and follow-up questions when key details are
missing. It streams its progress (tool calls and model text) to the browser as
it works.

It is the agent-shaped sibling of the "Ask your documents" feature: where Ask
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
| `server/src/routes/repairPlan.js` | `POST /api/repair-plan` Server-Sent-Events route |
| `client/src/pages/RepairPlannerPage.jsx` | Frontend form + live stream consumer + result cards |

## Tools

Each tool is a plain, deterministic function with a JSON schema so the model
knows how to call it. Keeping the executors deterministic means the structured
artifacts the UI renders never depend on model randomness.

| Tool | What it does |
| --- | --- |
| `extract_repair_tasks` | Splits the brief into system-tagged tasks with difficulty, safety flags, and search keywords |
| `search_repair_docs` | Retrieves relevant chunks from uploaded PDFs (reuses `chunkRetrievalService`) and returns citations |
| `check_repair_readiness` | Scores tasks against a rubric (tools / parts / skill match / safety) and reports gaps |
| `build_owner_checklist` | Produces a prioritized checklist with DIY vs professional-shop assignment |
| `draft_handoff_notes` | Drafts channel-specific copy: a parts shopping list, a mechanic handoff, and a maintenance-log entry |

### Readiness rubric

| Item | Points | Met when |
| --- | --- | --- |
| Required tools listed | 25 | `availableTools` is non-empty |
| Required parts listed | 25 | `availableParts` is non-empty |
| Skill matches difficulty | 30 | No task is rated above the stated skill level |
| Safety steps identified | 20 | Tasks exist so safety flags can be surfaced |

Score ≥ 80 → `ready`, ≥ 50 → `almost_ready`, otherwise `not_ready`.

## Streaming protocol

`POST /api/repair-plan` responds with `text/event-stream`. Each agent event is
one `data: <json>\n\n` frame. Event types:

| `type` | Meaning |
| --- | --- |
| `status` | Human-readable progress message |
| `tool_call` | The model asked to run a tool (`name`, `arguments`) |
| `tool_result` | A tool finished (`name`, `summary`) |
| `text_delta` | A chunk of the model's narrative answer |
| `trace` | A finished tracing span (observability) |
| `ai_not_configured` | No `OPENAI_API_KEY` is set; the run stops gracefully |
| `error` | The run failed (`message`) |
| `done` | Final event with `status` and assembled `artifacts` |

Request body: `{ brief, skillLevel, availableTools, availableParts, constraints }`.
Only `brief` is required.

## Setup

Set the key in the server environment (see `.env.example`):

```
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4.1-mini
```

`gpt-4.1-mini` is a current, non-deprecated model on the Responses API and is a
cost-friendly default for a local single-vehicle tool. Any current Responses-API
model id works — see https://developers.openai.com/api/docs/models. Without a key
the feature still loads and returns the `ai_not_configured` event.

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
and asserts the stream contains at least one tool event and one model text delta.

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

Confirm the stream emits at least one `tool_call` and one `text_delta` frame and
ends with a `done` frame whose `artifacts` include citations. If you instead see
an `ai_not_configured` frame, the key is not reaching the server process; if the
stream errors, the server cannot reach the OpenAI API (check network egress).

## Validation checklist

Agent behavior:

- [ ] A detailed brief (symptom + tools + parts) yields a `ready` or
      `almost_ready` readiness score with no false gaps.
- [ ] A sparse brief produces follow-up questions in the narrative.
- [ ] A task above the stated skill level is assigned to a professional shop and
      flagged in the readiness gaps.
- [ ] Safety-critical work (brakes, fuel, electrical, lifting, cooling) surfaces
      a safety flag.

Frontend flow:

- [ ] The agent activity log shows tool calls and results as they stream.
- [ ] The plan narrative renders progressively (not only at the end).
- [ ] Readiness, owner checklist, extracted tasks, handoff drafts, and sources
      cards all appear after `done`.
- [ ] Source cards link to the correct document page.
- [ ] With no key, the AI-not-configured banner appears and nothing crashes.

Tool outputs:

- [ ] `extract_repair_tasks` tags the right system for each fragment.
- [ ] `search_repair_docs` returns citations only from uploaded PDFs.
- [ ] `check_repair_readiness` score matches the rubric table above.
- [ ] `draft_handoff_notes` returns all three drafts.
