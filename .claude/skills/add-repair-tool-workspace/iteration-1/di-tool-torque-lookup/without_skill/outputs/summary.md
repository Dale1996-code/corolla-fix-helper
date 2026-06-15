# lookup_torque_spec — Implementation Summary

## Tool name

`lookup_torque_spec`

## What it does

Given a part or fastener name (e.g. "caliper bolt", "oil drain plug"), it:

1. Appends "torque spec" to the part name and calls the injected `retrieve` function (same `retrieveRelevantChunks` used by `search_repair_docs`).
2. Filters the returned chunks to only those that contain a recognisable torque value (ft-lb / ft·lbf / Nm / newton-metre variants, matched by a regex).
3. Extracts every torque value from each passing chunk into a deduplicated `torqueValues` array.
4. Returns `{ part, matches, found }` where each match carries the same citation fields as `search_repair_docs` plus `torqueValues`.

Document retrieval is **fully injected** via the second options argument `{ retrieve }`, exactly like `searchRepairDocs`. The default falls back to `retrieveRelevantChunks` from `chunkRetrievalService.js`. No new npm dependencies.

## Files touched and why

| File | Change |
| --- | --- |
| `server/src/services/agent/repairTools.js` | Added `TORQUE_PATTERN` regex, `extractTorqueValues` helper, and `lookupTorqueSpec` exported function; added the JSON schema entry to `repairToolSchemas`; registered `lookup_torque_spec` in `createToolRegistry` with the injected retriever. |
| `server/src/services/agent/repairPlannerAgent.js` | Added `torqueSpecs: []` to the `artifacts` object; added an accumulation branch for `lookup_torque_spec` tool results; added a `summarizeToolResult` case that extracts the found torque values into a human-readable summary; updated `AGENT_INSTRUCTIONS` to guide the model to call this tool for torque-critical fasteners. |
| `server/test/repairPlanner.test.js` | Imported `lookupTorqueSpec`; added two mock retrievers (one with torque values, one without); added five new tests covering happy path, no-torque-in-chunk, blank part, missing param, and agent-loop artifact accumulation. |
| `docs/repair-planner.md` | Added `lookup_torque_spec` row to the tools table. |

## Assumptions

- The tool is intentionally **not** a replacement for `search_repair_docs`; the agent instructions ask for `search_repair_docs` first, then `lookup_torque_spec` when a specific fastener needs a confirmed figure.
- The torque-value regex covers common automotive manual notations (ft-lb, ft·lb, ft lbf, Nm, N·m, Newton metre). Unicode en-dash ranges (e.g. "10–12 Nm") are included.
- Chunks that pass the retriever but contain no torque value are silently dropped (`found: false` if all are dropped). This keeps the tool signal clean.
- The `torqueSpecs` artifact is an array (not a single object) because the agent may call this tool multiple times for different parts in one session.
