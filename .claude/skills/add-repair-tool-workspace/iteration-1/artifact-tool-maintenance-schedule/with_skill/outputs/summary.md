# Summary: sort_maintenance_schedule tool

## Tool identity

- Wire name (schema / registry / toolCall.name): `sort_maintenance_schedule`
- JS function name: `sortMaintenanceSchedule`
- Artifact key on the `artifacts` object: `maintenanceSchedule`

## What the tool does

Classifies each extracted task into one of two buckets — **do now** or **can wait** — using three deterministic signals:

1. Safety flags (any task with safetyFlags.length > 0 → critical → do now)
2. System urgency (Brakes, Cooling, Fuel, Electrical are treated as urgent; beginner-difficulty tasks on those systems become critical, intermediate or harder become "soon")
3. Difficulty (intermediate tasks on any system go to "soon" → do now; beginner tasks on non-critical systems are "routine" → can wait)

Within the do-now bucket, critical items sort before soon items; within each tier, tasks sort by taskId for stable output. Pure function, no external dependency, no new packages.

## Files touched and why

| File | Why |
|------|-----|
| `server/src/services/agent/repairTools.js` | Steps 1–3: added `classifyUrgency` helper, `sortMaintenanceSchedule` executor, JSON schema entry in `repairToolSchemas`, and registry entry in `createToolRegistry`. |
| `server/src/services/agent/repairPlannerAgent.js` | Steps 4 and 6: added `maintenanceSchedule: null` to the artifacts object; added the accumulation branch (`else if (toolCall.name === "sort_maintenance_schedule" ...)`); added the summarize case; added instruction step 5 to `AGENT_INSTRUCTIONS`. |
| `client/src/pages/RepairPlannerPage.jsx` | Step 5: added `URGENCY_BADGE` color map, `MaintenanceSchedulePanel` component (renders "Do now" / "Can wait" sub-sections with urgency badges), and the render call between `<ChecklistPanel>` and `<TasksPanel>`. |
| `server/test/repairPlanner.test.js` | Step 7: added `sortMaintenanceSchedule` to the import; extended `createMockStreamTurn` to yield a `sort_maintenance_schedule` function_call in turn 1; added three unit tests (safety-flagged routing, empty input, urgency ordering); added artifact assertions to the agent-loop integration test. |
| `docs/repair-planner.md` | Step 8: added a row to the Tools table and updated the validation checklist. |

## UI artifact

Yes. The tool produces a UI artifact. The panel component is `MaintenanceSchedulePanel`. It renders a "Maintenance schedule" card with two labeled sub-sections ("Do now" / "Can wait"). Each row shows the task name, a human-readable reason, a system+difficulty badge, and an urgency-coloured badge (red=critical, amber=soon, emerald=routine). The panel returns null until the artifact is present.

## Assumptions and shortcuts

- No new npm packages introduced.
- The urgency classification uses existing `DIFFICULTY_RANK` (already in scope in repairTools.js) and a new `URGENT_SYSTEMS` Set. No clock, no randomness.
- "soon" tasks land in `do_now` because the instruction is to surface anything that is system-critical even if not immediately dangerous — the distinction between critical and soon is shown by the badge colour and the reason text, so the owner can still make a judgement call.
- Tests were not executed (npm not installed in worktree per task instructions); code was written to match the repo's existing test patterns exactly.
