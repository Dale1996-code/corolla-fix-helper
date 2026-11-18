// npm run eval:planner:replay -- <capture.jsonl>
//
// FREE AND OFFLINE (docs/planner-eval-spec.md, section 10.1). Re-derives every
// run in a planner capture with the current verifier, readiness check, and
// checklist builder, prints each verdict that changed (old → new, with the
// rejection reason), and ends with four lines:
//
//   N claim verdicts changed of M
//   N evidence statuses changed of R runs
//   N readiness levels changed of R runs
//   N draft notes changed of R runs
//
// It makes no network call and needs no API key and no database: it imports
// neither config.js (which reads server/.env) nor database.js. That is what
// makes it the free first check on a verifier change. plannerReplay.test.js
// runs this file with fetch disabled and OPENAI_API_KEY unset, and walks its
// import graph, to keep it so.
//
// It shows what new code decides about OLD runs. It cannot show how the model
// would plan under a new prompt or a new verifier: that is a paid capture.
//
// Exit code 0 when every line was replayed, whatever changed; 1 when the
// capture could not be read in full.

import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parsePlannerCaptureText } from "../evals/plannerCapture.js";
import { formatPlannerReplayReport, replayPlannerRecords } from "../evals/plannerReplay.js";
// Ask's replay CLI already resolves a path the way the owner typed it (INIT_CWD,
// because the root script runs this from server/) and parses arguments.
import { parseArguments, resolveInvocationPath } from "./replayCapture.js";

const USAGE = "Usage: npm run eval:planner:replay -- <path to a planner capture .jsonl>";

/**
 * @param {string[]} [argv]
 * @param {{ log?: (line: string) => void, error?: (line: string) => void }} [io]
 */
export async function runCli(argv = process.argv.slice(2), { log = console.log, error = console.error } = {}) {
  const options = parseArguments(argv);

  if (options.help) {
    log(USAGE);
    return null;
  }

  if (options.unknown.length || options.paths.length !== 1) {
    error(options.unknown.length ? `Unknown option: ${options.unknown.join(", ")}` : USAGE);
    process.exitCode = 1;
    return null;
  }

  const capturePath = resolveInvocationPath(options.paths[0]);
  let text;

  try {
    text = await fs.readFile(capturePath, "utf8");
  } catch (readError) {
    error(`Cannot read the capture: ${/** @type {any} */ (readError)?.message || readError}`);
    process.exitCode = 1;
    return null;
  }

  const parsed = parsePlannerCaptureText(text);
  const result = replayPlannerRecords(parsed.records);

  log(
    formatPlannerReplayReport({
      header: parsed.header,
      source: path.basename(capturePath),
      parseErrors: parsed.errors,
      result,
    })
  );

  if (parsed.errors.length || result.errors.length) {
    process.exitCode = 1;
  }

  return { parsed, result };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCli();
}
