// Offline replay of a planner capture (docs/planner-eval-spec.md, section 10.1).
//
// Re-derives what a recorded run would be with the CURRENT code -- every claim's
// verdict, the evidence status, readiness in both acknowledgment states, the
// checklist draft, the rendered plan -- and reports what moved. It is the free
// first look at a verifier change: no model call, no database, no API key. It
// shows what new code decides about OLD runs; it cannot show how the model
// would plan today.
//
// It re-uses the judge's own re-verification (plannerJudge.js: reverifyRun,
// rebuildEvidence) rather than writing a second one, so the chunk ordering the
// agent had when it finalized is reproduced in exactly one place. Every piece it
// calls is a seam with the production function as its default, so a test can
// stand a changed verifier in for the real one.
//
// Imports nothing that reads config or opens the database. plannerReplay.test.js
// walks the import graph to keep it so.

import { buildPlannerChecklistDraft } from "../services/agent/plannerChecklistDraft.js";
import { buildRepairPlanEvidence, verifyClaims } from "../services/agent/repairPlanEvidenceContract.js";
import { checkRepairReadiness } from "../services/agent/repairTools.js";
import { rebuildEvidence, reverifyRun } from "./plannerJudge.js";

/** The verdict for a claim the verifier kept. Every other verdict is a rejection reason. */
export const ACCEPTED = "accepted";

/**
 * @typedef {{
 *   verifyClaims?: typeof verifyClaims,
 *   buildEvidence?: typeof buildRepairPlanEvidence,
 *   readiness?: typeof checkRepairReadiness,
 *   buildDraft?: typeof buildPlannerChecklistDraft,
 * }} ReplaySeams
 */

/** Just the part of a readiness result a replay compares. */
function levelAndScore(readiness) {
  return readiness && typeof readiness === "object"
    ? { level: readiness.level ?? null, score: readiness.score ?? null }
    : null;
}

/**
 * What one recorded run is, re-derived with the code passed in (the current
 * code by default).
 *
 * Readiness is derived in BOTH acknowledgment states. The agent only ever builds
 * the unacknowledged one: acknowledgment arrives later, through a separate
 * route, from the server's own copy of the run. The acknowledged state is what a
 * capture has to compute for itself.
 *
 * @param {any} run  A record from recordPlannerRun (plannerCaseRunner.js).
 * @param {ReplaySeams} [seams]
 */
export function rederiveRun(
  run,
  {
    verifyClaims: verify = verifyClaims,
    buildEvidence = buildRepairPlanEvidence,
    readiness = checkRepairReadiness,
    buildDraft = buildPlannerChecklistDraft,
  } = {}
) {
  const tasks = run.tasks ?? [];
  const reverified = reverifyRun(run, { verifyClaims: verify });

  const finalizers = reverified.finalizers.map((finalizer) => {
    // The verifier hands back the very claim objects it rejected, so identity is
    // exact even when two claims share a text.
    const reasons = new Map(finalizer.rejected.map((entry) => [entry.claim, entry.reason]));

    return {
      turn: finalizer.turn,
      callOrdinal: finalizer.callOrdinal,
      valid: finalizer.valid,
      errors: finalizer.errors,
      // A finalizer the validator refused was never verified: it has no verdicts.
      verdicts: finalizer.valid
        ? finalizer.claims.map((claim, claimIndex) => ({
            claimIndex,
            taskId: claim.taskId,
            verdict: reasons.get(claim) ?? ACCEPTED,
          }))
        : [],
      // For printing a changed row. Not part of what a capture stores.
      claims: finalizer.claims,
      sources: finalizer.sources,
    };
  });

  const decisive = reverified.decisive === null ? null : reverified.finalizers[reverified.decisive];

  /** @type {any} */
  let evidence = null;
  let evidenceStatus = null;
  let acknowledged = null;
  let unacknowledged = null;
  let draftNotes = null;
  let text = null;

  if (decisive) {
    evidence = rebuildEvidence(
      decisive.payload,
      { tasks, chunks: decisive.chunks, request: run.request },
      { buildEvidence }
    );

    if (evidence?.valid) {
      evidenceStatus = evidence.evidenceStatus;
      text = evidence.text ?? null;

      const base = {
        tasks,
        // The agent defaults an unrecognized level to beginner, and so does the
        // readiness check itself.
        skillLevel: run.request?.skillLevel ?? "beginner",
        requirements: evidence.requirements,
        evidenceStatus: evidence.evidenceStatus,
      };

      unacknowledged = levelAndScore(readiness({ ...base, ackSafety: false }));
      acknowledged = levelAndScore(readiness({ ...base, ackSafety: true }));
      draftNotes =
        buildDraft({
          tasks,
          evidenceStatus: evidence.evidenceStatus,
          verifiedClaims: evidence.verifiedClaims,
          citations: evidence.citations,
          requirements: evidence.requirements,
        })?.notes ?? null;
    } else {
      evidenceStatus = "invalid_finalizer";
    }
  }

  return {
    finalizers,
    decisive: reverified.decisive,
    evidence,
    evidenceStatus,
    readiness: { unacknowledged, acknowledged },
    draftNotes,
    text,
  };
}

// ---- Replay -----------------------------------------------------------------------

const TEXT_LIMIT = 160;

const runLabel = (run) => `${run.scenarioId ?? "(no scenario)"} #${run.repeat ?? 1}`;
const claimKey = (finalizer, claimIndex) => `${finalizer.turn}.${finalizer.callOrdinal}#${claimIndex}`;
const sameLevelAndScore = (a, b) => (a?.level ?? null) === (b?.level ?? null) && (a?.score ?? null) === (b?.score ?? null);

/** `S2, Title, page 4` for a source id, from the sources the finalizer was shown. */
function describeSource(sourceId, sources) {
  if (typeof sourceId !== "string") {
    return null;
  }
  const source = (sources ?? []).find((entry) => entry.id === sourceId);

  if (!source) {
    return `${sourceId} (no such source)`;
  }
  return `${source.id}, ${source.documentTitle || source.originalFilename || "untitled document"}, page ${source.pageNumber ?? "?"}`;
}

/**
 * Replay ONE captured run: re-derive it and compare with what was recorded.
 *
 * Verdicts are compared with `captured`; the evidence status, readiness
 * (unacknowledged), checklist draft, and plan text with what the real run
 * produced (`run.outputs`); readiness (acknowledged) with `captured`.
 *
 * @param {any} record  A record from parsePlannerCaptureText.
 * @param {ReplaySeams} [seams]
 */
export function replayPlannerRun(record, seams = {}) {
  const { run, captured } = record;
  const derived = rederiveRun(run, seams);
  const base = { line: record.line ?? null, scenarioId: run.scenarioId ?? null, repeat: run.repeat ?? 1 };

  const result = {
    verdictTotal: 0,
    verdictChanges: /** @type {any[]} */ ([]),
    validityChanges: /** @type {any[]} */ ([]),
    decisiveChanges: /** @type {any[]} */ ([]),
    statusChanges: /** @type {any[]} */ ([]),
    readinessChanges: /** @type {any[]} */ ([]),
    draftNoteChanges: /** @type {any[]} */ ([]),
    textChanges: /** @type {any[]} */ ([]),
  };

  // Claim verdicts, keyed by (finalizer, claim index): one finalizer per
  // `finalize_repair_plan` call, which a run can make more than once.
  const before = new Map();
  const after = new Map();

  for (const finalizer of captured.finalizers) {
    finalizer.verdicts.forEach((entry) => before.set(claimKey(finalizer, entry.claimIndex), { finalizer, entry }));
  }
  for (const finalizer of derived.finalizers) {
    finalizer.verdicts.forEach((entry) => after.set(claimKey(finalizer, entry.claimIndex), { finalizer, entry }));
  }

  const keys = [...new Set([...before.keys(), ...after.keys()])];
  result.verdictTotal = keys.length;

  for (const key of keys) {
    const old = before.get(key);
    const current = after.get(key);

    if ((old?.entry.verdict ?? null) === (current?.entry.verdict ?? null)) {
      continue;
    }
    const { finalizer, entry } = /** @type {any} */ (current ?? old);
    const recorded = run.finalizers.find(
      (candidate) => candidate.turn === finalizer.turn && candidate.callOrdinal === finalizer.callOrdinal
    );
    const claim = recorded?.arguments?.claims?.[entry.claimIndex];
    const shown = derived.finalizers.find(
      (candidate) => candidate.turn === finalizer.turn && candidate.callOrdinal === finalizer.callOrdinal
    );

    result.verdictChanges.push({
      ...base,
      turn: finalizer.turn,
      callOrdinal: finalizer.callOrdinal,
      claimIndex: entry.claimIndex,
      taskId: entry.taskId,
      before: old?.entry.verdict ?? null,
      after: current?.entry.verdict ?? null,
      text: typeof claim?.claim === "string" ? claim.claim : "",
      source: describeSource(claim?.sourceId, shown?.sources),
    });
  }

  // A finalizer the validator now accepts or refuses.
  for (const finalizer of captured.finalizers) {
    const now = derived.finalizers.find(
      (candidate) => candidate.turn === finalizer.turn && candidate.callOrdinal === finalizer.callOrdinal
    );

    if (now && now.valid !== finalizer.valid) {
      result.validityChanges.push({
        ...base,
        turn: finalizer.turn,
        callOrdinal: finalizer.callOrdinal,
        before: finalizer.valid ? "valid" : "invalid",
        after: now.valid ? "valid" : "invalid",
      });
    }
  }

  if ((captured.decisive ?? null) !== (derived.decisive ?? null)) {
    result.decisiveChanges.push({ ...base, before: captured.decisive ?? null, after: derived.decisive ?? null });
  }

  const statusBefore = run.outcome?.evidenceStatus ?? null;

  if (statusBefore !== derived.evidenceStatus) {
    result.statusChanges.push({ ...base, before: statusBefore, after: derived.evidenceStatus });
  }

  const readinessBefore = {
    unacknowledged: run.outputs?.readiness
      ? { level: run.outputs.readiness.level ?? null, score: run.outputs.readiness.score ?? null }
      : null,
    acknowledged: captured.readinessAcknowledged ?? null,
  };

  for (const state of /** @type {const} */ (["unacknowledged", "acknowledged"])) {
    const was = readinessBefore[state];
    const now = derived.readiness[state];

    if (!sameLevelAndScore(was, now)) {
      result.readinessChanges.push({
        ...base,
        state,
        before: was,
        after: now,
        levelChanged: (was?.level ?? null) !== (now?.level ?? null),
      });
    }
  }

  const notesBefore = run.outputs?.checklistDraft?.notes ?? null;

  if (notesBefore !== derived.draftNotes) {
    result.draftNoteChanges.push({ ...base, before: notesBefore, after: derived.draftNotes });
  }

  const textBefore = run.outputs?.text ?? null;

  if (textBefore !== derived.text) {
    result.textChanges.push({ ...base, before: textBefore, after: derived.text });
  }

  return result;
}

/**
 * Replay parsed capture records.
 *
 * A run whose re-derivation throws is reported with its line and does not stop
 * the rest, so one bad record cannot hide the others.
 *
 * @param {any[]} records  From parsePlannerCaptureText.
 * @param {ReplaySeams} [seams]
 */
export function replayPlannerRecords(records, seams = {}) {
  const total = {
    runCount: records.length,
    verdictTotal: 0,
    verdictChanges: /** @type {any[]} */ ([]),
    validityChanges: /** @type {any[]} */ ([]),
    decisiveChanges: /** @type {any[]} */ ([]),
    statusChanges: /** @type {any[]} */ ([]),
    readinessChanges: /** @type {any[]} */ ([]),
    draftNoteChanges: /** @type {any[]} */ ([]),
    textChanges: /** @type {any[]} */ ([]),
    errors: /** @type {Array<{ line: number | null, message: string }>} */ ([]),
  };

  for (const record of records) {
    let one;

    try {
      one = replayPlannerRun(record, seams);
    } catch (error) {
      total.errors.push({
        line: record.line ?? null,
        message: `re-deriving the run threw: ${/** @type {any} */ (error)?.message || error}`,
      });
      continue;
    }

    total.verdictTotal += one.verdictTotal;
    total.verdictChanges.push(...one.verdictChanges);
    total.validityChanges.push(...one.validityChanges);
    total.decisiveChanges.push(...one.decisiveChanges);
    total.statusChanges.push(...one.statusChanges);
    total.readinessChanges.push(...one.readinessChanges);
    total.draftNoteChanges.push(...one.draftNoteChanges);
    total.textChanges.push(...one.textChanges);
  }

  return total;
}

// ---- Report -------------------------------------------------------------------------

const plural = (count, singular, pluralForm = `${singular}s`) => (count === 1 ? singular : pluralForm);

function truncate(text) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > TEXT_LIMIT ? `${flat.slice(0, TEXT_LIMIT - 1)}…` : flat;
}

const describeReadiness = (readiness) => (readiness ? `${readiness.level} (${readiness.score})` : "(none)");

function firstDifference(before, after) {
  const a = String(before ?? "").split("\n");
  const b = String(after ?? "").split("\n");
  const at = a.findIndex((line, index) => line !== b[index]);
  const index = at === -1 ? Math.min(a.length, b.length) : at;

  return `- ${truncate(a[index] ?? "(nothing)")}\n    + ${truncate(b[index] ?? "(nothing)")}`;
}

/**
 * The printed report. Ends with the four lines of section 10.1, which a change
 * is judged by. Plan-text drift is shown above them but is not a fifth count.
 *
 * @param {{
 *   header?: any, source?: string,
 *   parseErrors?: Array<{ line: number | null, message: string }>,
 *   result: ReturnType<typeof replayPlannerRecords>,
 * }} report
 */
export function formatPlannerReplayReport({ header = null, source = "capture", parseErrors = [], result }) {
  const lines = [];
  const capturedAt = header?.capturedAt ? `captured ${header.capturedAt}` : "capture time unknown";
  const revision = header?.revision
    ? ` at revision ${header.revision}${header.dirty ? " (uncommitted changes)" : ""}`
    : "";

  lines.push(
    `Replaying ${source}: ${result.runCount} ${plural(result.runCount, "run")}, ${capturedAt}${revision}.`,
    "Offline: the current verifier, readiness check, and checklist builder re-derive each captured run. No model call is made.",
    ""
  );

  for (const change of result.verdictChanges) {
    lines.push(
      `${runLabel(change)} turn ${change.turn} call ${change.callOrdinal} claim[${change.claimIndex}] (task ${change.taskId}): ` +
        `${change.before ?? "(no such item)"} → ${change.after ?? "(no such item)"}`
    );
    if (change.text) {
      lines.push(`    claim: ${truncate(change.text)}`);
    }
    if (change.source) {
      lines.push(`    source: ${change.source}`);
    }
  }
  for (const change of result.validityChanges) {
    lines.push(
      `${runLabel(change)} turn ${change.turn} call ${change.callOrdinal} finalizer: ${change.before} → ${change.after}`
    );
  }
  for (const change of result.decisiveChanges) {
    lines.push(`${runLabel(change)} decisive finalizer: ${change.before ?? "none"} → ${change.after ?? "none"}`);
  }
  for (const change of result.statusChanges) {
    lines.push(`${runLabel(change)} evidence status: ${change.before ?? "(none)"} → ${change.after ?? "(none)"}`);
  }
  for (const change of result.readinessChanges) {
    lines.push(
      `${runLabel(change)} readiness (${change.state}): ${describeReadiness(change.before)} → ${describeReadiness(change.after)}` +
        (change.levelChanged ? "" : " [score only]")
    );
  }
  for (const change of result.draftNoteChanges) {
    lines.push(`${runLabel(change)} draft notes changed`, `    ${firstDifference(change.before, change.after)}`);
  }
  for (const change of result.textChanges) {
    lines.push(`${runLabel(change)} plan text changed`);
  }

  const problems = [...parseErrors, ...result.errors];

  if (problems.length > 0) {
    if (lines[lines.length - 1] !== "") {
      lines.push("");
    }
    lines.push(`${problems.length} ${plural(problems.length, "line")} could not be replayed:`);
    for (const problem of problems) {
      lines.push(`  line ${problem.line ?? "?"}: ${problem.message}`);
    }
  }

  if (lines[lines.length - 1] !== "") {
    lines.push("");
  }

  const readinessRuns = new Set(
    result.readinessChanges.filter((change) => change.levelChanged).map((change) => `${change.line}:${runLabel(change)}`)
  ).size;
  const runs = `${result.runCount} ${plural(result.runCount, "run")}`;

  lines.push(
    `${result.verdictChanges.length} claim ${plural(result.verdictChanges.length, "verdict")} changed of ${result.verdictTotal}`,
    `${result.statusChanges.length} evidence ${plural(result.statusChanges.length, "status", "statuses")} changed of ${runs}`,
    `${readinessRuns} readiness ${plural(readinessRuns, "level")} changed of ${runs}`,
    `${result.draftNoteChanges.length} draft ${plural(result.draftNoteChanges.length, "note")} changed of ${runs}`
  );

  return lines.join("\n");
}
