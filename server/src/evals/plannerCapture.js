// Planner captures (docs/planner-eval-spec.md, section 10): a recorded run, plus
// what the current code made of it, written down so a later verifier can be
// judged against it for free.
//
// A capture is JSON Lines: one header line, then one line per recorded run.
//
//   {"type":"header","format":"corolla-fix-helper/planner-capture","version":1,...}
//   {"type":"planner_run","run":{...},"captured":{...}}
//
// There is deliberately ONE recorder. `run` is exactly what recordPlannerRun
// (plannerCaseRunner.js) returned, carried verbatim: this module wraps that
// record and never builds a second one. Nesting it (rather than flattening it
// into the line, as the section 10 sketch does) means the judge's functions take
// `line.run` unchanged, and a field the recorder gains later travels without an
// edit here -- the same idea as answerCapture.js's snapshotChunk.
//
// `captured` holds only what `run` cannot: each claim's verdict ("accepted" or
// the verifier's rejection reason, which the agent never keeps), which
// finalizer decided the plan, and readiness in the ACKNOWLEDGED state (the agent
// only builds the unacknowledged one). Everything else a replay compares against
// is already in `run.outputs` and `run.outcome`, in full rather than as digests.
//
// Captures quote real manual text, which is why server/data/captures/ is
// gitignored. Never commit one; the replay fixture is invented text.
//
// Imports no config and no database, so the replay CLI can load it with
// OPENAI_API_KEY unset and no database at all. The header takes every setting as
// a parameter for the same reason: the paid capture tool (a later phase) reads
// config.js and hands the values in.

import { createHash } from "node:crypto";
import { rederiveRun } from "./plannerReplay.js";

export const PLANNER_CAPTURE_FORMAT = "corolla-fix-helper/planner-capture";
export const PLANNER_CAPTURE_VERSION = 1;

/**
 * The settings that can change a run without a code change (spec section 10).
 * All of them must be PRESENT in a header; a value may be null for "unknown".
 * A header that silently omitted `rerankEnabled` could not say whether two
 * captures are comparable.
 */
export const PLANNER_CAPTURE_CONFIG_KEYS = [
  "answerModel",
  "reasoningEffort",
  "maxOutputTokens",
  "maxTurns",
  "maxToolCallsPerTurn",
  "maxSearchResults",
  "evidenceContextCharLimit",
  "retrievalMode",
  "retrievalMaxChunksPerSource",
  "rerankEnabled",
  "relevanceFloorEnabled",
  "embeddingVersion",
];

/** A capture bug, not a verifier change: what the real run produced and what its own record re-derives to disagree. */
export class PlannerCaptureMismatch extends Error {
  /**
   * @param {string} message
   * @param {string[]} [problems]
   */
  constructor(message, problems = []) {
    super(message);
    this.name = "PlannerCaptureMismatch";
    this.problems = problems;
  }
}

const isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const isIndex = (value) => Number.isInteger(value) && value >= 0;

/**
 * sha256 of the planner's instruction text, as lowercase hex.
 *
 * @param {string} instructions  AGENT_INSTRUCTIONS (repairPlannerAgent.js, P-2).
 */
export function hashInstructions(instructions) {
  if (typeof instructions !== "string") {
    throw new TypeError("hashInstructions needs the instruction text as a string");
  }
  return createHash("sha256").update(instructions, "utf8").digest("hex");
}

// ---- Header ---------------------------------------------------------------------

/** Why a header cannot be used, or null when it can. */
function headerProblem(header) {
  if (typeof header.capturedAt !== "string" || !header.capturedAt) {
    return "capturedAt must be a timestamp string";
  }
  if (typeof header.revision !== "string" || !header.revision) {
    return "revision must be the exact code revision (a non-empty string)";
  }
  if (typeof header.dirty !== "boolean") {
    return "dirty must be true or false: it says whether the run is comparable";
  }
  if (typeof header.instructionsHash !== "string" || !/^[0-9a-f]{64}$/.test(header.instructionsHash)) {
    return "instructionsHash must be a 64-character sha256 hex string";
  }
  if (!isPlainObject(header.config)) {
    return "config must be an object holding the settings snapshot";
  }
  for (const key of PLANNER_CAPTURE_CONFIG_KEYS) {
    if (header.config[key] === undefined) {
      return `config.${key} is missing (use null for unknown)`;
    }
  }
  return null;
}

/**
 * The header line. Fails rather than writing a header that cannot tell a later
 * reader which code, prompt, and settings produced the runs below it.
 *
 * @param {{
 *   capturedAt?: string, revision: string, dirty: boolean, config: Record<string, any>,
 *   instructionsHash: string, scenarioSetVersion?: any, repeats?: any,
 *   vehicleProfile?: any, corpus?: any, limits?: any,
 * }} fields
 */
export function buildPlannerCaptureHeader({
  capturedAt = new Date().toISOString(),
  revision,
  dirty,
  config,
  instructionsHash,
  scenarioSetVersion = null,
  repeats = null,
  vehicleProfile = null,
  corpus = null,
  limits = null,
}) {
  const header = {
    type: "header",
    format: PLANNER_CAPTURE_FORMAT,
    version: PLANNER_CAPTURE_VERSION,
    capturedAt,
    revision,
    dirty,
    config,
    instructionsHash,
    scenarioSetVersion,
    repeats,
    vehicleProfile,
    corpus,
    limits,
  };
  const problem = headerProblem(header);

  if (problem) {
    throw new TypeError(`Cannot build a planner capture header: ${problem}`);
  }
  return header;
}

// ---- Records ---------------------------------------------------------------------

/**
 * What the real run produced against what its own record re-derives to. Any
 * difference is a CAPTURE bug (a chunk field the snapshot dropped, a recorder
 * that missed a retrieval), never a verifier change, so it fails the capture:
 * a replay of such a record would report changes that are not changes.
 */
function findCaptureProblems(run, derived) {
  const problems = [];
  const outputs = run.outputs;

  if (run.outcome?.status === "completed" && derived.decisive === null) {
    problems.push("the run completed but no recorded finalizer is valid when re-derived");
  }
  if (!outputs) {
    return problems;
  }

  if (derived.evidenceStatus !== (run.outcome?.evidenceStatus ?? null)) {
    problems.push(
      `evidence status was ${run.outcome?.evidenceStatus}, the record re-derives ${derived.evidenceStatus}`
    );
  }

  const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const recordedReadiness = outputs.readiness
    ? { level: outputs.readiness.level ?? null, score: outputs.readiness.score ?? null }
    : null;

  if (!same(derived.readiness.unacknowledged, recordedReadiness)) {
    problems.push("readiness differs from what the record re-derives");
  }
  if (!same(derived.evidence?.verifiedClaims, outputs.evidence?.verifiedClaims)) {
    problems.push("the accepted claims differ from what the record re-derives");
  }
  if (!same(derived.draftNotes, outputs.checklistDraft?.notes)) {
    problems.push("the checklist draft notes differ from what the record re-derives");
  }
  if (!same(derived.text, outputs.text)) {
    problems.push("the plan text differs from what the record re-derives");
  }
  return problems;
}

/**
 * One capture line: the recorder's run, verbatim, and what the code passed in
 * (the current code by default) makes of it.
 *
 * Throws PlannerCaptureMismatch when the run's own outputs and their
 * re-derivation disagree, because writing that line would write a capture bug.
 *
 * @param {any} run  A record from recordPlannerRun.
 * @param {import("./plannerReplay.js").ReplaySeams} [seams]
 */
export function buildPlannerCaptureRecord(run, seams) {
  const derived = rederiveRun(run, seams);
  const problems = findCaptureProblems(run, derived);

  if (problems.length > 0) {
    throw new PlannerCaptureMismatch(
      `The recorded run ${run.scenarioId ?? "(no scenario)"} #${run.repeat ?? 1} does not match its own re-derivation: ${problems[0]}`,
      problems
    );
  }

  return {
    type: "planner_run",
    run,
    captured: {
      decisive: derived.decisive,
      finalizers: derived.finalizers.map(({ turn, callOrdinal, valid, errors, verdicts }) => ({
        turn,
        callOrdinal,
        valid,
        errors,
        verdicts,
      })),
      readinessAcknowledged: derived.readiness.acknowledged,
    },
  };
}

/**
 * The capture file's text: the header, then one line per record.
 *
 * @param {{ header: any, records: any[] }} capture
 */
export function serializePlannerCapture({ header, records }) {
  const lines = [header, ...records].map((entry) => {
    // A record read back by parsePlannerCaptureText carries its line number,
    // which is where it was read from, not part of the record.
    const rest = { ...entry };
    delete rest.line;
    return JSON.stringify(rest);
  });
  return `${lines.join("\n")}\n`;
}

// ---- Parser -----------------------------------------------------------------------

/** Why a parsed `planner_run` line cannot be replayed, or null when it can. */
function recordProblem(record) {
  const { run, captured } = record;

  if (!isPlainObject(run)) {
    return "run is missing";
  }
  if (!isPlainObject(run.request)) {
    return "run.request is missing";
  }
  for (const key of ["tasks", "turns", "retrievals", "finalizers"]) {
    if (!Array.isArray(run[key])) {
      return `run.${key} must be an array`;
    }
  }
  if (!isPlainObject(run.outcome) || typeof run.outcome.status !== "string") {
    return "run.outcome.status is missing";
  }
  if (run.outputs !== null && !isPlainObject(run.outputs)) {
    return "run.outputs must be an object, or null for a run that made no plan";
  }

  for (const [index, retrieval] of run.retrievals.entries()) {
    if (!isPlainObject(retrieval)) {
      return `run.retrievals[${index}] must be an object`;
    }
    if (retrieval.results === null) {
      continue;
    }
    if (!Array.isArray(retrieval.results)) {
      return `run.retrievals[${index}].results must be an array or null`;
    }
    for (const [at, chunk] of retrieval.results.entries()) {
      if (!isPlainObject(chunk) || typeof chunk.chunkText !== "string") {
        return `run.retrievals[${index}] result ${at} needs its chunkText`;
      }
    }
  }
  for (const [index, finalizer] of run.finalizers.entries()) {
    if (!isPlainObject(finalizer) || !isIndex(finalizer.turn) || !isIndex(finalizer.callOrdinal)) {
      return `run.finalizers[${index}] needs its turn and callOrdinal`;
    }
  }

  if (!isPlainObject(captured)) {
    return "captured is missing";
  }
  if (!Array.isArray(captured.finalizers)) {
    return "captured.finalizers is missing";
  }
  for (const [index, entry] of captured.finalizers.entries()) {
    const wellFormed =
      isPlainObject(entry) &&
      isIndex(entry.turn) &&
      isIndex(entry.callOrdinal) &&
      typeof entry.valid === "boolean" &&
      Array.isArray(entry.errors) &&
      Array.isArray(entry.verdicts) &&
      entry.verdicts.every(
        (verdict) => isPlainObject(verdict) && isIndex(verdict.claimIndex) && typeof verdict.verdict === "string"
      );

    if (!wellFormed) {
      return `captured.finalizers[${index}] is malformed`;
    }
  }
  if (captured.decisive !== null && !isIndex(captured.decisive)) {
    return "captured.decisive must be null or a finalizer index";
  }
  const acknowledged = captured.readinessAcknowledged;

  if (acknowledged !== null && !(isPlainObject(acknowledged) && typeof acknowledged.level === "string")) {
    return "captured.readinessAcknowledged must be null or hold a level and a score";
  }
  return null;
}

/**
 * Read a capture file's text.
 *
 * Fails closed: the first non-blank line must be a header naming this format, a
 * supported version, and every field that makes a capture comparable, and every
 * line after it that cannot be replayed is reported with its line number
 * instead of being skipped. A replay that quietly dropped runs would print
 * "0 changed" over a capture it never read.
 *
 * @param {string} text
 * @returns {{ header: any, records: any[], errors: Array<{ line: number, message: string }> }}
 */
export function parsePlannerCaptureText(text) {
  /** @type {any[]} */ const records = [];
  /** @type {Array<{ line: number, message: string }>} */ const errors = [];
  /** @type {any} */ let header = null;
  let sawContent = false;
  const firstLineMessage = `the first line must be a ${PLANNER_CAPTURE_FORMAT} header`;

  for (const [index, rawLine] of String(text ?? "").split(/\r?\n/).entries()) {
    const line = index + 1;
    const content = rawLine.trim();

    if (!content) {
      continue;
    }

    /** @type {any} */ let parsed;

    try {
      parsed = JSON.parse(content);
    } catch {
      if (!sawContent) {
        errors.push({ line, message: `${firstLineMessage} (this line is not valid JSON)` });
        return { header: null, records: [], errors };
      }
      errors.push({ line, message: "not valid JSON" });
      continue;
    }

    if (!sawContent) {
      sawContent = true;

      if (!isPlainObject(parsed) || parsed.type !== "header" || parsed.format !== PLANNER_CAPTURE_FORMAT) {
        errors.push({ line, message: firstLineMessage });
        return { header: null, records: [], errors };
      }
      if (parsed.version !== PLANNER_CAPTURE_VERSION) {
        errors.push({
          line,
          message: `capture version ${parsed.version} is not supported (expected ${PLANNER_CAPTURE_VERSION})`,
        });
        return { header: null, records: [], errors };
      }
      const problem = headerProblem(parsed);

      if (problem) {
        errors.push({ line, message: `the header cannot be used: ${problem}` });
        return { header: null, records: [], errors };
      }
      header = parsed;
      continue;
    }

    if (isPlainObject(parsed) && parsed.type === "header") {
      errors.push({ line, message: "more than one header in the capture" });
      continue;
    }
    if (!isPlainObject(parsed) || parsed.type !== "planner_run") {
      errors.push({ line, message: `unsupported record type ${JSON.stringify(parsed?.type)}` });
      continue;
    }

    const problem = recordProblem(parsed);

    if (problem) {
      errors.push({ line, message: problem });
      continue;
    }
    records.push({ ...parsed, line });
  }

  if (!sawContent) {
    errors.push({ line: 1, message: "the capture is empty" });
  }
  return { header, records, errors };
}
