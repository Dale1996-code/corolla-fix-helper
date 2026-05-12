# Project state snapshot - refreshed 2026-05-11

## Purpose
This document summarizes the current observed project state, readiness commands, and remaining validation notes after rerunning the V1 checks under Node.js 24.

## Current state snapshot
- Product scope and docs position the app as a polished local-first V1 with Dashboard, Documents, Search, Symptoms, Procedures, Notes, and Settings.
- Runtime validation requires Node.js >=24 <25. Node 20 is not supported for backend validation because the backend uses `node:sqlite` with `DatabaseSync`.
- Validation on 2026-05-11 used Node.js `v24.15.0` and npm `11.4.2`.
- `npm run install:all` completed successfully for the root, server, and client packages.
- `npm run build` completed successfully.
- `npm run test` completed successfully, including backend and frontend suites.
- `npm run test:server` completed successfully when rerun directly.
- `npm run test:client` completed successfully when rerun directly.
- No repo lint or typecheck scripts are currently defined in the root, server, or client package scripts.

## V1 readiness status
V1 is ready to tag from a Node.js >=24 <25 validation run. Do not tag V1 from a Node 20 run, because that runtime cannot validate the current backend `node:sqlite` / `DatabaseSync` implementation.

## Remaining blockers
No build or automated test blockers were observed under Node.js `v24.15.0`.

Known non-blocking validation notes:
- `npm run install:all` reported one moderate client dependency audit finding. The audit finding did not block install, build, or tests.
- npm printed `Unknown env config "http-proxy"` warnings in this environment. The warnings did not block install, build, or tests.
- The client test run printed a jsdom navigation warning for one Settings test. The Vitest run still completed with all 18 frontend tests passing.
- No automated end-to-end/browser smoke script is wired into the current package scripts; use `QA_CHECKLIST.md` for manual acceptance checks.

## Required commands for V1 verification
Run from the repository root with Node.js >=24 <25:

```bash
node --version
npm --version
npm run install:all
npm run build
npm run test
```

The root `npm run test` command runs both suites. If separate confirmation is needed, run:

```bash
npm run test:server
npm run test:client
```

## Manual acceptance checks
Run through `QA_CHECKLIST.md`, with extra attention to:
- Settings backup export flow.
- Document delete cleanup across linked symptoms/procedures/notes.
- Document extraction re-run feedback.
- Notes linked-item details for document/symptom/procedure links.

## Commands used for this refreshed assessment
- `pwd`
- `git status --short`
- `node --version`
- `npm --version`
- `cat package.json`
- `cat server/package.json`
- `cat client/package.json`
- `npm run install:all`
- `npm run build`
- `npm run test`
- `npm run test:server`
- `npm run test:client`
- `rg --files -g '*.md' -g '!node_modules' -g '!client/node_modules' -g '!server/node_modules'`
- `rg -n "Node|node:sqlite|DatabaseSync|install:all|npm run build|npm run test|V1|ready|readiness|tag|blocker|lint|typecheck" -g '*.md' -g '!node_modules' -g '!client/node_modules' -g '!server/node_modules'`
