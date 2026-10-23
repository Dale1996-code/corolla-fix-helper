// npm run eval:capture -- [--case <id>]... [--output-dir DIR]
//
// PAID (audit Stage 1b, 4B-11). Runs the answer-quality cases through the real
// Ask pipeline -- the same cases, options, and retries as eval:answers, through
// the shared runAnswerCase -- and writes every raw model reply, with the
// passages the model was shown and the verdict judged at capture time, to
//
//   server/data/captures/<timestamp>-<revision>.jsonl
//
// Each run spends real money at the model provider (about what one
// eval:answers run costs), so run it only with the owner's go-ahead in the
// session. Then judge any later verifier change for free:
//
//   npm run eval:replay -- server/data/captures/<file>.jsonl
//
// A capture QUOTES REAL MANUAL TEXT. server/data/captures/ is gitignored and the
// repository is public: never commit a capture, and never paste its passages
// into a committed file.
//
// It does not score the answers. A capture is not an eval:answers run and must
// not be recorded as one in docs/evals/ask-rag-iteration-log.md.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { config } from "../config.js";

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Not beside config.databaseFile: a capture run against a VACUUM INTO snapshot
 * in a temp folder would then be written there too, and lost with it -- the
 * fate of every capture before this script existed.
 */
export const DEFAULT_CAPTURE_DIR = path.join(SERVER_DIR, "data", "captures");

/** @param {string[]} argv */
export function parseArguments(argv = []) {
  /** @type {{ caseIds: string[], outputDir?: string, unknown: string[] }} */
  const options = { caseIds: [], unknown: [] };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--case") {
      options.caseIds.push(String(argv[index + 1] || ""));
      index += 1;
    } else if (argument === "--output-dir") {
      options.outputDir = String(argv[index + 1] || "");
      index += 1;
    } else {
      options.unknown.push(argument);
    }
  }

  return options;
}

/**
 * The cases to capture: all of them, or the named ones in the order listed.
 * Throws on an id no case has -- better than a paid run that silently skips it.
 */
export function selectCases(cases, caseIds = []) {
  if (!caseIds.length) {
    return cases;
  }

  const byId = new Map(cases.map((testCase) => [testCase.id, testCase]));
  const missing = caseIds.filter((id) => !byId.has(id));

  if (missing.length) {
    throw new Error(`No answer-quality case has the id: ${missing.join(", ")}`);
  }

  return caseIds.map((id) => byId.get(id));
}

/** `2026-10-23T04-12-33Z-abc1234.jsonl`: sortable, and safe in a Windows path. */
export function buildCaptureFileName({ capturedAt, revision }) {
  const stamp = `${capturedAt.slice(0, 19).replace(/:/g, "-")}Z`;
  return `${stamp}-${revision || "unknown"}.jsonl`;
}

function readGitRevision() {
  const repoRoot = path.resolve(SERVER_DIR, "..");

  try {
    const revision = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });

    return { revision: revision || null, dirty: status.trim().length > 0 };
  } catch {
    return { revision: null, dirty: null };
  }
}

/** @param {string[]} [argv] */
export async function runCli(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);

  if (options.unknown.length) {
    console.error(`Unknown option: ${options.unknown.join(", ")}`);
    process.exitCode = 1;
    return;
  }

  if (!config.openAiApiKey) {
    // A capture without a key would record nothing, so say so and fail rather
    // than exit green the way eval:answers does when it skips.
    console.error("eval:capture needs OPENAI_API_KEY: it records real, paid model replies.");
    console.error("To judge a verifier change for free, replay an existing capture:");
    console.error("  npm run eval:replay -- server/data/captures/<file>.jsonl");
    process.exitCode = 1;
    return;
  }

  const { answerQualityCases } = await import("../evals/answerQualityCases.js");
  let cases;

  try {
    cases = selectCases(answerQualityCases, options.caseIds);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }

  // Importing database.js opens the (real) database from config.
  await import("../database.js");
  const { askQuestionUsingDocuments, generateEvidenceAnswerFromOpenAi } = await import(
    "../services/aiAnswerService.js"
  );
  const { buildCaptureHeader, captureAnswerCases } = await import("../evals/answerCapture.js");

  const { revision, dirty } = readGitRevision();
  const header = buildCaptureHeader({
    revision,
    dirty,
    answerModel: config.openAiAnswerModel,
    visionModel: config.openAiVisionModel,
    caseCount: cases.length,
  });
  // A relative --output-dir is read from where npm was invoked, not from
  // server/ where `npm --prefix server` runs this file (see replayCapture.js).
  const outputDir = options.outputDir
    ? path.resolve(process.env.INIT_CWD || process.cwd(), options.outputDir)
    : DEFAULT_CAPTURE_DIR;
  const capturePath = path.join(outputDir, buildCaptureFileName(header));

  fs.mkdirSync(outputDir, { recursive: true });

  const followUps = cases.filter((testCase) => testCase.followUp).length;
  console.log(
    `Capturing ${cases.length} case(s), ${followUps} with a follow-up. This makes PAID model calls.`
  );
  console.log(`Writing ${capturePath}\n`);

  // Appended line by line, so a run that dies halfway keeps what it paid for.
  const summary = await captureAnswerCases({
    cases,
    askQuestion: askQuestionUsingDocuments,
    generateEvidenceAnswer: generateEvidenceAnswerFromOpenAi,
    writeLine: (line) => fs.appendFileSync(capturePath, `${line}\n`, "utf8"),
    header,
    caseDelayMs: Number(process.env.EVAL_CASE_DELAY_MS || 2000),
  });

  console.log("");
  console.log(`${summary.records} model replies recorded in ${capturePath}`);

  if (summary.noReply) {
    console.log(`${summary.noReply} turn(s) ended before the model was asked; nothing to record.`);
  }

  if (summary.failedCases) {
    console.log(`${summary.failedCases} case(s) failed; their recorded turns are still replayable.`);
    process.exitCode = 1;
  }

  if (summary.statusMismatches) {
    console.log(
      `${summary.statusMismatches} record(s) were judged differently from the pipeline's own status. ` +
        "That is a capture bug, not a model problem: investigate before replaying this capture."
    );
    process.exitCode = 1;
  }

  console.log("\nThe capture quotes real manual text. Keep it out of git and out of committed docs.");
  console.log(`Replay it for free: npm run eval:replay -- "${capturePath}"`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCli();
}
