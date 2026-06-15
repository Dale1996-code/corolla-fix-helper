# Tool: total_labor_hours

## Wire name and function name

- Wire name (schema / registry / toolCall.name): `total_labor_hours`
- JS function name: `totalLaborHours`

## Files touched

| File | Why |
| --- | --- |
| `server/src/services/agent/repairTools.js` | Added executor (`totalLaborHours`), JSON schema entry in `repairToolSchemas`, and registry entry in `createToolRegistry` |
| `server/src/services/agent/repairPlannerAgent.js` | Added step 5 to `AGENT_INSTRUCTIONS` so the model actually calls the tool; added a `summarizeToolResult` case for the activity log |
| `server/test/repairPlanner.test.js` | Imported `totalLaborHours`; extended `createMockStreamTurn` to yield a `total_labor_hours` function_call in turn 1; added two unit tests (normal case + graceful empty/unknown-difficulty handling) |
| `docs/repair-planner.md` | Added a row to the Tools table |

## UI artifact

No. This tool is intermediate data only — the model reads the result and factors total labor hours into its narrative. No artifact key is accumulated in `repairPlannerAgent.js` and no card is added to `RepairPlannerPage.jsx`.

## Assumptions

- Labor-hour estimates reuse the same difficulty tiers (`beginner: 1 h`, `intermediate: 2.5 h`, `advanced: 5 h`) as the worked example for `estimate_repair_cost`, since the repo has no other canonical source for these values.
- An unknown or missing `difficulty` value falls back to `"beginner"` (1 hour), consistent with the defensive-defaults convention used by all other tools.
- The tool is placed in the agent instructions as step 5 (after checklist/handoff notes), which is the earliest point where tasks are guaranteed to exist.
- No changes to `RepairPlannerPage.jsx` or any client file — the task explicitly requires no UI card.
