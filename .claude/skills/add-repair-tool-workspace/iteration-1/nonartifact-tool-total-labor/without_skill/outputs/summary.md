# Summary: estimate_labor_hours tool

## Tool name

`estimate_labor_hours`

## What it does

A deterministic tool that accepts the task list produced by `extract_repair_tasks` and returns:
- `totalHours` — a single number the model can quote in its narrative ("budget about 4.25 hours")
- `breakdown` — a per-task array of `{ taskId, task, system, difficulty, estimatedHours }`

Estimates are based on a two-table lookup: a base figure per difficulty tier (beginner 1 h, intermediate 2.5 h, advanced 5 h) plus a per-system surcharge (e.g. Transmission +2 h, Engine +1.5 h, Brakes +0.25 h). Both lookups default gracefully when unknown values arrive. All arithmetic is rounded to one decimal place to avoid floating-point noise.

## Files touched and why

| File | Reason |
|---|---|
| `server/src/services/agent/repairTools.js` | Added `estimateLaborHours` executor, `BASE_HOURS_BY_DIFFICULTY` and `SYSTEM_HOUR_ADJUSTMENTS` lookup tables, the JSON schema entry in `repairToolSchemas`, and the registration in `createToolRegistry`. |
| `server/src/services/agent/repairPlannerAgent.js` | Added `laborEstimate: null` to the initial artifacts object; added an `else if` branch to accumulate the result when the model calls the tool; added a case to `summarizeToolResult`; updated `AGENT_INSTRUCTIONS` to number step 4 as `estimate_labor_hours` (old step 4 became step 5) and direct the model to use the result for time framing. |
| `server/test/repairPlanner.test.js` | Imported `estimateLaborHours`; added three unit tests (normal case with two tasks, empty task list, unknown difficulty/system fallback); extended `createMockStreamTurn` to yield an `estimate_labor_hours` function call so the agent-loop integration test exercises the new artifact path; added three assertions to the agent-loop test verifying `result.artifacts.laborEstimate`. |

## UI artifact

No. The tool result is stored in `artifacts.laborEstimate` so the model can read it when composing the narrative, but no new card or UI component was added. The existing `RepairPlannerPage.jsx` is unchanged.

## Assumptions

- DIY-bench hour figures are intentionally rough (designed to set expectations, not replace a shop's flat-rate book). Advanced jobs cover anything involving timing, transmission, or head-gasket work.
- Per-system surcharges are additive on top of the difficulty base; combined figures stay reasonable for the home-mechanic context.
- The tool is called with the task objects exactly as `extract_repair_tasks` returns them. Unknown `difficulty` or `system` values fall back silently (beginner base, zero surcharge) rather than erroring.
- `maxTurns` is 6, which is sufficient for the extended tool sequence (extract + search x N + readiness + labor + checklist + handoff + narrative).
