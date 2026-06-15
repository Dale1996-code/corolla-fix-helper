# Tool: lookup_torque_spec

## Names

- Wire name (schema / registry / toolCall.name): `lookup_torque_spec`
- JS function (exported): `lookupTorqueSpec`
- Artifact key: `torqueSpecs` (array — accumulates across multiple calls)

## What it does

Searches the owner's uploaded PDF manuals for torque specification snippets for a named part or fastener. Takes `part` (required string) and optional `limit` (integer, default 5). Builds a focused retrieval query (`"<part> torque spec ft-lb nm"`) and returns `{ part, snippets, context }`. Each snippet carries `documentId`, `documentTitle`, `originalFilename`, `pageNumber`, `chunkIndex`, and a truncated `snippet` string (max 220 chars, matching `buildSnippet` used by `searchRepairDocs`).

## Dependency injection

`retrieve` is injected via a second options argument with `retrieveRelevantChunks` as the default — exactly the same pattern as `searchRepairDocs(args, { retrieve })`. In `createToolRegistry` the live default is passed as `lookup_torque_spec: (args) => lookupTorqueSpec(args, { retrieve })`. Tests inject the existing `mockRetrieve` stub.

## Files touched and why

| File | Change |
| --- | --- |
| `server/src/services/agent/repairTools.js` | Added `lookupTorqueSpec` executor, JSON schema entry in `repairToolSchemas`, and registry mapping in `createToolRegistry`. |
| `server/src/services/agent/repairPlannerAgent.js` | Added `torqueSpecs: []` artifact key; added `else if` accumulation branch (deduplicates by documentId/pageNumber/chunkIndex and tags each snippet with its `part`); added `summarizeToolResult` case; added step 5 to `AGENT_INSTRUCTIONS`. |
| `client/src/pages/RepairPlannerPage.jsx` | Added `TorqueSpecsPanel` component (returns null when empty; renders each snippet with part name + source badge + snippet text); rendered `<TorqueSpecsPanel torqueSpecs={artifacts?.torqueSpecs} />` between `ChecklistPanel` and `TasksPanel`. |
| `server/test/repairPlanner.test.js` | Added `lookupTorqueSpec` to the import; added two unit tests (happy path with mock retriever, safe empty shape on missing part); added `lookup_torque_spec` function_call to `createMockStreamTurn` turn 1; added three assertions to the agent-loop test verifying the `torqueSpecs` artifact. |
| `docs/repair-planner.md` | Added `lookup_torque_spec` row to the Tools table and a checklist item to the validation checklist. |

## Assumptions

- The tool is artifact-producing: the model may call it multiple times (once per fastener), so the agent accumulates results into `torqueSpecs[]` rather than replacing. Deduplication uses the same documentId/pageNumber/chunkIndex key already used by `mergeCitations`.
- The query augmentation (`"torque spec ft-lb nm"`) is purely a hint to bias the embedding/keyword retriever toward spec tables; if the repo's retriever ignores extra terms, the query still works (it falls back to the part name).
- No new npm packages were introduced. The executor reuses `buildSnippet` and `normalizeText` helpers already in `repairTools.js`.
