# Maintenance Schedule Tool — Implementation Summary

## Tool name

`sort_maintenance_schedule`

## What it does

Classifies a list of extracted repair tasks into two buckets:

- **now** — tasks that carry active symptoms, safety flags, or urgency keywords (squeaking, grinding, leaking, misfiring, etc.) that should be addressed before the next drive or as soon as possible.
- **defer** — routine maintenance items (filter replacements, fluid flushes, scheduled intervals, etc.) that are safe to hold until the next service appointment.

Each entry in both buckets includes:
- `taskId`, `task`, `system`, `difficulty` — copied from the source task.
- `bucket` — `"now"` or `"defer"`.
- `rationale` — a single plain-language sentence explaining the classification.

Within each bucket tasks are sorted hardest-first so the owner sees what needs the most preparation at the top.

Classification rules (all deterministic, no model randomness):
1. Any task with a non-empty `safetyFlags` array → `now` (safety first).
2. Any task whose title or system name matches more `NOW_TERMS` keywords than `DEFER_TERMS` keywords → `now`.
3. Everything else → `defer`.

## Files touched and why

| File | Why |
|------|-----|
| `server/src/services/agent/repairTools.js` | Added `sortMaintenanceSchedule` executor + `NOW_TERMS`/`DEFER_TERMS` keyword lists + `classifyUrgency`/`urgencyRationale` helpers; added JSON schema to `repairToolSchemas`; registered in `createToolRegistry`. |
| `server/src/services/agent/repairPlannerAgent.js` | Added `maintenanceSchedule: null` to the `artifacts` object; added accumulation branch for `sort_maintenance_schedule`; added summary string in `summarizeToolResult`; updated `AGENT_INSTRUCTIONS` to include step 4 (call `sort_maintenance_schedule`) and renumbered step 5. |
| `client/src/pages/RepairPlannerPage.jsx` | Added `MaintenanceSchedulePanel` component (two-section card: "Do now" in red, "Can defer" in slate); wired it between `ChecklistPanel` and `TasksPanel` in the render output. |
| `client/src/pages/RepairPlannerPage.test.jsx` | Added `maintenanceSchedule` fixture to the `completedRun` done event; added two assertions: heading "Maintenance schedule" appears and the rationale text is rendered. |
| `server/test/repairPlanner.test.js` | Imported `sortMaintenanceSchedule`; added two unit tests (classifies symptoms as now, returns empty buckets for empty input); added `sort_maintenance_schedule` call to `createMockStreamTurn`; added three assertions to the agent loop test verifying `artifacts.maintenanceSchedule` is populated. |
| `docs/repair-planner.md` | Added the tool to the tools table; updated the frontend checklist; added two tool-output checklist items. |

## UI artifact

Yes — renders as its own card titled **"Maintenance schedule"** between the Owner checklist and the Extracted tasks cards. Tasks in the "now" bucket are shown in red-tinted rows with a "Do now" label; tasks in the "defer" bucket are shown in slate rows with a "Can defer" label. The panel is hidden when `maintenanceSchedule` is null (pre-run) or when both buckets are empty.

## Assumptions and shortcuts

- Classification is purely keyword-based (matching the pattern already used by `detectSystem`, `detectDifficulty`, and `detectSafetyFlags`). No external calls or model inference is needed.
- The safety-flag rule (any flag → "now") is intentionally conservative: the existing `detectSafetyFlags` already fires on brake, fuel, electrical, lifting, and coolant work, so this covers all safety-critical systems without additional logic.
- `DEFER_TERMS` includes `"replace"` as a weak routine signal; the `nowScore >= deferScore` tie-break means a task like "replace brake pads (squeaking)" still lands in "now" because `"squeak"` and `"brake"` each score a now-point while `"replace"` scores one defer-point.
- No new npm dependencies were introduced.
