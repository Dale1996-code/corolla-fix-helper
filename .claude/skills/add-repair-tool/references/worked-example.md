# Worked example: `estimate_repair_cost`

A complete, end-to-end example of adding an **artifact-producing** tool to the Repair
Planner. It estimates a rough DIY-vs-shop budget per task from difficulty — deterministic,
no external dependency, no new packages. Copy it as a template and adapt.

Wire name (schema / registry / `toolCall.name`): `estimate_repair_cost`.
JS function: `estimateRepairCost`. Artifact key: `costEstimate`.

---

## 1–3. `server/src/services/agent/repairTools.js`

### Executor (add near the other `// --- Tool: ... ---` blocks)

```js
// --- Tool: estimate_repair_cost -------------------------------------------

const LABOR_HOURS = { beginner: 1, intermediate: 2.5, advanced: 5 };
const PARTS_ALLOWANCE = { beginner: 30, intermediate: 90, advanced: 250 };
const SHOP_LABOR_RATE = 110; // USD per hour, local indie-shop ballpark

export function estimateRepairCost({ tasks = [] } = {}) {
  const estimates = tasks.map((task) => {
    const difficulty = DIFFICULTY_RANK[task.difficulty] ? task.difficulty : "beginner";
    const laborHours = LABOR_HOURS[difficulty];
    const partsEstimate = PARTS_ALLOWANCE[difficulty];
    const diyTotal = partsEstimate;
    const shopTotal = partsEstimate + laborHours * SHOP_LABOR_RATE;

    return {
      taskId: task.id,
      task: task.title,
      difficulty,
      laborHours,
      partsEstimate,
      diyTotal,
      shopTotal,
    };
  });

  const diyTotal = estimates.reduce((sum, line) => sum + line.diyTotal, 0);
  const shopTotal = estimates.reduce((sum, line) => sum + line.shopTotal, 0);

  return { estimates, diyTotal, shopTotal };
}
```

Notes:
- `tasks` defaults to `[]` and an unknown `difficulty` falls back to `beginner`, so a
  garbage or partial call returns `{ estimates: [], diyTotal: 0, shopTotal: 0 }` instead
  of throwing.
- It reuses the existing `DIFFICULTY_RANK` map. Pure function of its input — same tasks
  in, same numbers out.

### Schema (add an entry to the `repairToolSchemas` array)

```js
{
  type: "function",
  name: "estimate_repair_cost",
  description:
    "Estimate a rough parts + labor budget per task from its difficulty, with DIY and professional-shop totals. Use after tasks are extracted.",
  parameters: {
    type: "object",
    properties: {
      tasks: {
        type: "array",
        items: { type: "object" },
        description: "Tasks from extract_repair_tasks.",
      },
    },
    required: ["tasks"],
    additionalProperties: false,
  },
},
```

### Registry (add to `createToolRegistry`)

```js
estimate_repair_cost: (args) => estimateRepairCost(args),
```

---

## 4. `server/src/services/agent/repairPlannerAgent.js`

### a. Add the artifact key

```js
const artifacts = {
  tasks: [],
  citations: [],
  readiness: null,
  checklist: [],
  handoffNotes: null,
  costEstimate: null, // <-- add
};
```

### b. Accumulate the result (add a branch in the artifact-accumulation `if/else if` chain)

```js
} else if (toolCall.name === "estimate_repair_cost" && Array.isArray(result.estimates)) {
  artifacts.costEstimate = result;
}
```

### c. Summarize for the activity log (add a case in `summarizeToolResult`, before the final `return "Done."`)

```js
if (name === "estimate_repair_cost") {
  return `Estimated ${result.estimates?.length || 0} cost line(s); DIY ~$${result.diyTotal ?? 0}.`;
}
```

---

## 5. `client/src/pages/RepairPlannerPage.jsx`

### a. Add a panel component (follow the existing `Card`-based panels)

```jsx
function CostPanel({ costEstimate }) {
  if (!costEstimate?.estimates?.length) {
    return null;
  }

  return (
    <Card title="Cost estimate">
      <div className="flex flex-wrap items-center gap-4 text-sm">
        <span className="font-semibold text-slate-900">DIY ~${costEstimate.diyTotal}</span>
        <span className="font-semibold text-slate-900">Shop ~${costEstimate.shopTotal}</span>
      </div>
      <ul className="space-y-2">
        {costEstimate.estimates.map((line) => (
          <li
            key={line.taskId}
            className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700"
          >
            <span className="font-medium text-slate-900">{line.task}</span>
            <span className="text-xs text-slate-500">
              {line.difficulty} · DIY ${line.diyTotal} · Shop ${line.shopTotal}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
```

### b. Render it in the JSX list at the bottom of `RepairPlannerPage`

```jsx
<ChecklistPanel checklist={artifacts?.checklist} />
<CostPanel costEstimate={artifacts?.costEstimate} /> {/* <-- add */}
<TasksPanel tasks={artifacts?.tasks} />
```

---

## 6. `server/src/services/agent/repairPlannerAgent.js` — `AGENT_INSTRUCTIONS`

Add a step so the model actually calls the tool (a tool the instructions never mention
may never be called):

```js
"4. Call build_owner_checklist and draft_handoff_notes to produce the checklist and copy.",
"5. Call estimate_repair_cost with the tasks so the owner sees a rough DIY-vs-shop budget.",
```

(Renumber the trailing narrative instruction accordingly.)

---

## 7. `server/test/repairPlanner.test.js`

### Unit test for the executor

```js
test("estimate_repair_cost totals parts and labor by difficulty", () => {
  const { estimates, diyTotal, shopTotal } = estimateRepairCost({
    tasks: [
      { id: 1, title: "Replace cabin filter", difficulty: "beginner" },
      { id: 2, title: "Replace timing chain", difficulty: "advanced" },
    ],
  });

  assert.equal(estimates.length, 2);
  // beginner parts 30 + advanced parts 250
  assert.equal(diyTotal, 280);
  // 30 + 1*110  +  250 + 5*110  = 140 + 800
  assert.equal(shopTotal, 940);
});
```

Remember to add `estimateRepairCost` to the destructured import from
`../src/services/agent/repairTools.js` at the top of the test file.

### Exercise the artifact through the agent loop

Extend `createMockStreamTurn` so turn 1 also requests the new tool:

```js
yield {
  type: "function_call",
  callId: "call_cost",
  name: "estimate_repair_cost",
  arguments: {
    tasks: [{ id: 1, title: "Replace front brake pads", difficulty: "intermediate" }],
  },
};
```

Then assert in the agent-loop test that the artifact arrived:

```js
assert.ok(result.artifacts.costEstimate);
assert.ok(result.artifacts.costEstimate.estimates.length >= 1);
```

---

## 8. `docs/repair-planner.md`

Add a row to the **Tools** table:

```md
| `estimate_repair_cost` | Estimates a rough parts + labor budget per task (DIY vs professional shop) from difficulty |
```

If you keep an artifacts list elsewhere in the doc, note the new `costEstimate` artifact
and its "Cost estimate" card too.

---

## Verify

```
npm --prefix server test
npm --prefix client test
```

Both suites run without an API key (the model client is mocked / injected). Read the
output and confirm the new unit test and the agent-loop artifact assertion pass before
calling it done.
