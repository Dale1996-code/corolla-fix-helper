# Ask/RAG Iteration Log

Date: 2026-07-07

Goal: improve Ask/RAG answer quality while keeping the app local-first, small, and reviewable.

## Inspection Summary

- Ask API route: `server/src/routes/ask.js`
- Answer generation and citation assembly: `server/src/services/aiAnswerService.js`
- Chunk retrieval: `server/src/services/chunkRetrievalService.js`
- Optional reranking: `server/src/services/chunkRerankService.js`
- PDF chunk creation: `server/src/services/documentChunkService.js`
- Ask UI citation display: `client/src/pages/SearchPage.jsx`
- Existing evals: `npm run eval:retrieval`, `npm run eval:rerank`, `npm run eval:answers`

## Baseline

Commands run before changing behavior:

```powershell
git status --short --branch
npm run eval:retrieval
npm run eval:rerank
npm run eval:answers
npm run test:server
npm run typecheck
```

Results:

- `git status --short --branch`: `## main...origin/main` plus untracked `.claude/worktrees/`
- `npm run eval:retrieval`: passed. 12 eval cases, 12 keyword-wrong cases fixed by hybrid retrieval, 0 hybrid-wrong cases.
- `npm run eval:rerank`: passed. OpenAI key was present; 12 both-right, 0 rerank-fixed, 0 rerank-broke, 0 both-wrong.
- `npm run eval:answers`: blocked as a live quality baseline in this environment. The sandbox run failed every case with `fetch failed`; the unsandboxed rerun request was rejected because it would send local document-derived content to OpenAI.
- `npm run test:server`: passed 212/212 backend tests.
- `npm run typecheck`: passed.

## Iteration 1

Weakness found:

- The existing answer prompt was grounded and citation-focused, but it did not explicitly ask for beginner-safe structure or for separating manual-supported facts from general safety reminders.

Focused change:

- Added a failing test in `server/test/aiAnswerService.test.js` that checks the OpenAI prompt includes beginner-safe, document-grounded structure instructions.
- Added three prompt instructions in `server/src/services/aiAnswerService.js`:
  - write for a beginner DIY mechanic
  - separate document-supported facts from general safety reminders
  - label safety reminders as general safety guidance when not stated in the chunks

Verification:

```powershell
cd server
node --test test/aiAnswerService.test.js
npm run eval:retrieval
npm run eval:rerank
npm run test:server
npm run typecheck
```

Result:

- Red: the new test failed before the prompt change because the prompt did not include the beginner-safe instruction.
- Green: after the prompt change, `test/aiAnswerService.test.js` passed 7/7.
- Final verification passed:
  - `npm run eval:retrieval`: 12/12 keyword-wrong cases fixed by hybrid retrieval, 0 hybrid-wrong cases.
  - `npm run eval:rerank`: 12 both-right, 0 rerank-broke.
  - `npm run test:server`: 213/213 backend tests passed.
  - `npm run typecheck`: passed.

## Current Limits

- This log does not claim live OpenAI answer quality improved, because the live answer eval could not be run under the current external-data policy.
- The verified proof is narrower: the generated answer prompt now contains explicit beginner-safe and support-boundary instructions, and existing focused Ask answer tests still pass.
