// npm run eval:replay -- <capture.jsonl>
//
// FREE AND OFFLINE (audit Stage 1b, 4B-11). Re-judges every model reply in an
// answer capture (written by `npm run eval:capture`) with the current Ask
// validator and verifier, prints each verdict that changed -- old → new, with
// the rejection reason -- and ends with "N verdicts changed of M".
//
// It makes no network call and needs no API key and no database: it imports
// neither config.js (which reads server/.env) nor database.js. That is what
// makes it the free first check on a verifier change, before a paid
// eval:answers run. replayCapture.test.js runs this file with fetch disabled
// and OPENAI_API_KEY unset to keep it that way.
//
// Exit code 0 when every line was replayed, whatever changed; 1 when the
// capture could not be read in full.

import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseCaptureText } from "../evals/answerCapture.js";
import { formatReplayReport, replayRecords } from "../evals/answerReplay.js";

const USAGE = "Usage: npm run eval:replay -- <path to a capture .jsonl>";

/**
 * Resolve a path the way the owner typed it. The root script delegates with
 * `npm --prefix server`, which runs this file from server/, so a relative path
 * must be read from where npm was invoked (INIT_CWD), not from process.cwd():
 * otherwise "server/data/captures/x.jsonl" becomes server/server/data/...
 */
export function resolveInvocationPath(target, env = process.env) {
  return path.resolve(env.INIT_CWD || process.cwd(), target);
}

/** @param {string[]} argv */
export function parseArguments(argv = []) {
  const paths = [];
  const unknown = [];

  for (const argument of argv) {
    if (argument === "--help" || argument === "-h") {
      return { help: true, paths, unknown };
    }

    if (argument.startsWith("-")) {
      unknown.push(argument);
    } else {
      paths.push(argument);
    }
  }

  return { help: false, paths, unknown };
}

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
    error(`Cannot read the capture: ${readError?.message || readError}`);
    process.exitCode = 1;
    return null;
  }

  const parsed = parseCaptureText(text);
  const result = replayRecords(parsed.records);

  log(
    formatReplayReport({
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
