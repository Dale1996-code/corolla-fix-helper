// npm run eval:planner:report -- <capture.jsonl> [--output-dir DIR]
//
// FREE AND OFFLINE (docs/planner-eval-spec.md, section 11). Turns a planner capture
// into the baseline report: Tables 0 to 3, the critical-findings line, the
// invariants and operations lines, and the REQUIRED block "verified/ready plans
// lacking essential confirmed facts". It makes no network call and needs no API
// key and no database: it imports neither config.js nor database.js, and
// plannerBaselineReport.test.js runs it with fetch disabled and walks its import
// graph to keep it so.
//
// Two files are written beside each other, named from the capture's own time and
// revision:
//
//   planner-baseline-<time>-<revision>.json   every metric for every run, claims and
//                                             quotes included. It QUOTES REAL MANUAL
//                                             TEXT: gitignored, never commit it.
//   planner-baseline-<time>-<revision>.md     the aggregates-only section to paste
//                                             into docs/evals/planner-baseline-log.md.
//                                             Nothing here is a claim, quote, or passage.
//
// It REFUSES (exit 1, nothing written) when the capture could not be read in full,
// or when a confirmed fact does not land in exactly one outcome (I-7). A report
// over part of a capture would understate its runs, so a partial read is not
// reported on. It never uses its findings to loosen the verifier.
//
// Exit code 0 when the report was produced, 1 otherwise.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parsePlannerCaptureText } from "../evals/plannerCapture.js";
import {
  BaselineReportRefused,
  buildBaselineReport,
  buildPerRunJson,
  formatBaselineLogSection,
  formatBaselineReport,
} from "../evals/reportPlannerBaseline.js";
import { resolveInvocationPath } from "./replayCapture.js";

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The gitignored folder the capture tool writes to; the report lands beside the captures. */
export const DEFAULT_REPORT_DIR = path.join(SERVER_DIR, "data", "captures");

const USAGE = "Usage: npm run eval:planner:report -- <path to a planner capture .jsonl> [--output-dir DIR]";

/** `2026-11-18T09-30-15Z-abc1234`: the capture's own time and revision. */
function stemOf(header) {
  const stamp = `${String(header.capturedAt).slice(0, 19).replace(/:/g, "-")}Z`;

  return `planner-baseline-${stamp}-${header.revision || "unknown"}`;
}

/** @param {string[]} argv */
function parseArguments(argv) {
  const options = { paths: /** @type {string[]} */ ([]), outputDir: /** @type {string | undefined} */ (undefined), unknown: /** @type {string[]} */ ([]), help: false };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--output-dir") {
      options.outputDir = String(argv[index + 1] ?? "");
      index += 1;
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else if (argument.startsWith("-")) {
      options.unknown.push(argument);
    } else {
      options.paths.push(argument);
    }
  }
  return options;
}

/**
 * @param {string[]} [argv]
 * @param {{
 *   log?: (line: string) => void, error?: (line: string) => void,
 *   judge?: (run: any, scenario: any) => any,
 * }} [io]
 */
export async function runCli(argv = process.argv.slice(2), { log = console.log, error = console.error, judge } = {}) {
  const options = parseArguments(argv);

  if (options.help) {
    log(USAGE);
    return { exitCode: 0 };
  }
  if (options.unknown.length > 0 || options.paths.length !== 1) {
    error(options.unknown.length > 0 ? `Unknown option: ${options.unknown.join(", ")}` : USAGE);
    return { exitCode: 1 };
  }

  const capturePath = resolveInvocationPath(options.paths[0]);
  let text;

  try {
    text = fs.readFileSync(capturePath, "utf8");
  } catch (readError) {
    error(`Cannot read the capture: ${/** @type {any} */ (readError)?.message || readError}`);
    return { exitCode: 1 };
  }

  const parsed = parsePlannerCaptureText(text);

  if (parsed.errors.length > 0 || !parsed.header) {
    for (const problem of parsed.errors) {
      error(`line ${problem.line}: ${problem.message}`);
    }
    error("The capture could not be read in full, so no report was produced: a report over part of a capture would understate its runs.");
    return { exitCode: 1 };
  }

  let analysis;

  try {
    analysis = buildBaselineReport({
      header: parsed.header,
      records: parsed.records,
      source: path.basename(capturePath),
      ...(judge ? { judge } : {}),
    });
  } catch (reportError) {
    if (!(reportError instanceof BaselineReportRefused)) {
      throw reportError;
    }
    error(reportError.message);
    for (const problem of reportError.problems.slice(0, 10)) {
      error(`  ${problem}`);
    }
    return { exitCode: 1 };
  }

  const outputDir = options.outputDir ? resolveInvocationPath(options.outputDir) : DEFAULT_REPORT_DIR;
  const stem = stemOf(parsed.header);
  const jsonPath = path.join(outputDir, `${stem}.json`);
  const markdownPath = path.join(outputDir, `${stem}.md`);

  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(jsonPath, `${JSON.stringify(buildPerRunJson(analysis), null, 2)}\n`, "utf8");
  fs.writeFileSync(markdownPath, formatBaselineLogSection(analysis.report), "utf8");

  log(formatBaselineReport(analysis.report));
  log(`Per-run JSON (every metric for every run; it quotes real manual text: keep it out of git): ${jsonPath}`);
  log(`Aggregates-only section for docs/evals/planner-baseline-log.md: ${markdownPath}`);
  return { exitCode: 0, analysis, jsonPath, markdownPath };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runCli();

  process.exitCode = result.exitCode;
}
