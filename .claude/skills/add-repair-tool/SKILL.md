---
name: add-repair-tool
description: Scaffold a new deterministic tool for the Repair Planner agent, end to end. Walks every edit site — executor + JSON schema + registry (repairTools.js), optional artifact accumulation (repairPlannerAgent.js) and UI panel (RepairPlannerPage.jsx), a unit test, and a docs row — so none is missed. Use when adding or wiring up a new agent tool / function-call for the repair planner.
disable-model-invocation: true
---

# Add a Repair Planner tool

Adding a tool to the Repair Planner is a fixed, multi-file ritual. Miss one site and
the tool either never gets called, throws at runtime, or silently produces an artifact
the UI never shows. This skill walks every site in order so the change is complete.

Read `docs/repair-planner.md` first if you haven't — it is the source of truth for the
agent's design. This skill operationalizes its "Extending it" section.

## Before you start

Get these from the user (ask if not given — don't guess):

- **What the tool does** — the deterministic computation, in one sentence.
- **Inputs** — the arguments the model will pass (names, types, which are required).
- **Output shape** — the plain object it returns.
- **Does it produce a UI artifact?** i.e. should the result render as its own card on
  the Repair Planner page, or is it just intermediate data the model reasons over?
  This decides whether steps 4–5 apply.
- **Does it need an external dependency?** (document retrieval, etc.) If so it must be
  *injectable*, like `search_repair_docs` is with `{ retrieve }`.

## Non-negotiable conventions

These are what keep the agent testable and the artifacts stable. Honor them or the
change will not fit the codebase.

- **Determinism.** The executor must be a pure function of its arguments — no
  randomness, no clocks, no network except through an injected dependency. The whole
  point is that the structured artifacts the UI renders never depend on model
  randomness, and the pipeline is testable with no API key.
- **No new dependencies, no SDK.** Stay inside the repo's hand-rolled approach. If you
  reach for a package, stop.
- **Two naming forms.** The tool's wire name is `snake_case` (the schema `name`, the
  registry key, and the `toolCall.name` checks). The JS function is `camelCase` and
  exported. Example: schema/registry `estimate_repair_cost` → function
  `estimateRepairCost`. Keep them consistent everywhere.
- **Inject external deps via a second options arg with a default**, and wire the
  default in `createToolRegistry`. See how `searchRepairDocs(args, { retrieve })` does
  it. Never import-and-call a live dependency straight from the executor body.
- **Tolerate bad/partial args.** The model controls the arguments and the loop calls
  `executor(toolCall.arguments || {})`. Default every field
  (`export function fooTool({ brief } = {})`), normalize strings, and return a safe
  empty-ish shape instead of throwing when input is missing.
- **Return plain JSON-serializable objects.** The result is `JSON.stringify`'d back
  into the model's input as `function_call_output`, so keep it compact — truncate long
  text like `search_repair_docs` does with its snippets.
- **An artifact key and its UI panel are a matched pair — never ship one without the
  other.** If you add a key to the `artifacts` object (step 4), you must render it in
  `RepairPlannerPage.jsx` (step 5); if you're not adding a panel, do not add an
  artifacts key. An accumulated artifact that nothing renders is dead plumbing — the
  most common miss when the tool is intermediate-only. Decide once, up front: *does
  this tool produce a card?* Yes → do steps 4 **and** 5. No → skip **both**.

## The ritual

All paths are under `server/src/services/agent/` unless noted. Do the steps in order;
later steps reference names you define in earlier ones.

### 1. Executor — `repairTools.js`

Add an exported `camelCase` function near the other `// --- Tool: ... ---` blocks.
Reuse the existing helpers (`normalizeText`, etc.) rather than re-implementing them.

```js
// --- Tool: estimate_repair_cost -------------------------------------------

export function estimateRepairCost({ tasks = [] } = {}) {
  // deterministic computation only; return a plain object
  return { estimates: [/* ... */], total: 0 };
}
```

If it needs an external dependency, take it as a second arg with a default:

```js
export function fooTool({ query } = {}, { retrieve = retrieveRelevantChunks } = {}) { ... }
```

### 2. JSON schema — `repairTools.js`

Add an entry to the `repairToolSchemas` array. The `name` is `snake_case`. Describe
the tool and each parameter clearly — this text is how the model decides when and how
to call it. Mark genuinely required params in `required`, and set
`additionalProperties: false`.

```js
{
  type: "function",
  name: "estimate_repair_cost",
  description: "Estimate parts + labor cost per task from its difficulty. Returns a per-task and total estimate.",
  parameters: {
    type: "object",
    properties: {
      tasks: { type: "array", items: { type: "object" }, description: "Tasks from extract_repair_tasks." },
    },
    required: ["tasks"],
    additionalProperties: false,
  },
},
```

### 3. Registry — `repairTools.js`

Map the `snake_case` name to the executor inside `createToolRegistry`. Pass injected
deps here if the executor takes them.

```js
estimate_repair_cost: (args) => estimateRepairCost(args),
// or, with an injected dependency:
foo_tool: (args) => fooTool(args, { retrieve }),
```

At this point the model *can* call the tool. The next steps make it actually get
called and make its output visible.

### 4. (Artifact only) Accumulate in `repairPlannerAgent.js`

Skip this **and step 5 together** if the tool is intermediate data with no card of its
own — adding an `artifacts` key here without the matching panel in step 5 leaves an
orphan artifact that nothing renders. A summary line in `summarizeToolResult` (edit 3
below) is still worth adding for an intermediate tool so its activity-log entry reads
well; the artifacts key and accumulation branch (edits 1–2) are the artifact-only part.

Three edits in `repairPlannerAgent.js`:

1. Add a key to the `artifacts` object (the one initialized with `tasks`, `citations`,
   `readiness`, `checklist`, `handoffNotes`).
2. Add an `else if (toolCall.name === "estimate_repair_cost")` branch in the artifact
   accumulation block to store `result` onto that key. Validate the shape first
   (`Array.isArray(result.estimates)`) the way the existing branches do.
3. Add a case in `summarizeToolResult` so the streamed `tool_result` / activity log
   reads well (e.g. `` `Estimated ${result.estimates?.length || 0} cost line(s).` ``).

### 5. (Artifact only) Render in `client/src/pages/RepairPlannerPage.jsx`

1. Add a panel component following the existing `Card`-based pattern. Return `null`
   when the artifact is empty so it stays hidden until `done`.
2. Render it in the JSX list at the bottom of `RepairPlannerPage` alongside
   `<ReadinessPanel .../>`, `<ChecklistPanel .../>`, etc., reading from
   `artifacts?.yourKey`.

### 6. Teach the agent to call it — `repairPlannerAgent.js`

If the tool belongs in the standard flow, add a numbered line to `AGENT_INSTRUCTIONS`
telling the model when to call it. A tool the instructions never mention may never be
called. Keep the ordering sensible (e.g. cost estimation after tasks exist).

### 7. Tests — `server/test/repairPlanner.test.js`

Tests run with `OPENAI_API_KEY=""` — no live model. Add:

- A unit test for the executor asserting the deterministic output for a known input.
- If injectable, a test passing a mock dependency (mirror the `search_repair_docs`
  test that injects `mockRetrieve`).
- If it produces an artifact, extend `createMockStreamTurn` to also yield a
  `function_call` for your tool, so the agent-loop test exercises accumulation and the
  `done` artifacts include it.

### 8. Docs — `docs/repair-planner.md`

Add a row to the **Tools** table. If it emits an artifact, mention it in the streaming/
artifacts notes so the doc stays the source of truth.

## Verify (do not skip)

Run and read the output before claiming done — evidence, not assertion:

```
npm --prefix server test     # tools, agent loop, SSE route
npm --prefix client test     # only needed if you touched the page
```

Note: `npm run lint` covers the whole `server/` tree and `npm run typecheck`
(`tsconfig.json`) covers the whole `server/src` tree, so `repairTools.js` and
`repairPlannerAgent.js` are both checked. Typecheck still runs with full `strict`
off, so the test suites remain your real safety net for logic and null/any bugs.

## Full worked example

For a complete, copy-paste-ready example that adds an artifact-producing
`estimate_repair_cost` tool end to end — every edit site with real code, the test, and
the doc row — read `references/worked-example.md`.
