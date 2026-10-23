// Offline replay of an answer capture (audit Stage 1b, 4B-11).
//
// Re-judges every captured model reply with the CURRENT validator and verifier
// and reports each verdict that moved. It is the free first look at a verifier
// change: no model call, no database, no API key. A replay shows what the new
// code decides about OLD replies; it cannot show how the model would answer
// today, which is what eval:answers (paid) is for.
//
// The unit of comparison is one item of one reply -- a claim, a general-guidance
// line, or a gap -- keyed by its channel and its index in the validated reply,
// the key verifyEvidence reports rejections by. Answer statuses are compared
// too, but counted separately: one rejected claim can flip a status, and a
// status line is not a second verdict.

import { INVALID_REPLY, judgeReply } from "./answerCapture.js";

const TEXT_LIMIT = 160;

function itemText(value, channel, itemIndex) {
  const item = value?.[channel]?.[itemIndex];

  if (channel === "documentSupported") {
    return item && typeof item === "object" ? String(item.claim ?? "") : "";
  }

  return typeof item === "string" ? item : "";
}

function itemSourceId(value, itemIndex) {
  const item = value?.documentSupported?.[itemIndex];
  return item && typeof item === "object" && typeof item.sourceId === "string" ? item.sourceId : null;
}

function describeSource(sourceId, chunks) {
  if (!sourceId) {
    return null;
  }

  const match = /^S(\d{1,4})$/i.exec(sourceId.trim());
  const chunk = match ? chunks[Number(match[1]) - 1] : null;

  if (!chunk) {
    return `${sourceId} (no such source)`;
  }

  const title = chunk.documentTitle || chunk.originalFilename || "untitled document";
  return `${sourceId}, ${title}, page ${chunk.pageNumber ?? "?"}`;
}

function statusLabel(status, invalidReason) {
  return status === INVALID_REPLY && invalidReason ? `${status} (${invalidReason})` : status;
}

function verdictKey(channel, itemIndex) {
  return `${channel}[${itemIndex}]`;
}

/**
 * Replay parsed capture records.
 *
 * `judge` is injectable so a test can stand in for a changed verifier; the CLI
 * always uses the real one.
 *
 * @param {any[]} records - from parseCaptureText
 * @param {{ judge?: typeof judgeReply }} [options]
 */
export function replayRecords(records, { judge = judgeReply } = {}) {
  const verdictChanges = [];
  const statusChanges = [];
  const errors = [];
  let verdictTotal = 0;

  for (const record of records) {
    let judged;

    try {
      judged = judge(record.reply, record.chunks);
    } catch (error) {
      errors.push({ line: record.line, message: `the verifier threw: ${error?.message || error}` });
      continue;
    }

    const before = new Map(
      record.captured.verdicts.map((entry) => [
        verdictKey(entry.channel, entry.itemIndex),
        entry,
      ])
    );
    const after = new Map(
      judged.verdicts.map((entry) => [verdictKey(entry.channel, entry.itemIndex), entry])
    );
    const keys = [...new Set([...before.keys(), ...after.keys()])];
    // Text for the report: the reply as validated now, else the raw reply.
    const value = judged.value ?? record.reply;

    verdictTotal += keys.length;

    for (const key of keys) {
      const old = before.get(key);
      const current = after.get(key);
      const oldVerdict = old?.verdict ?? null;
      const newVerdict = current?.verdict ?? null;

      if (oldVerdict === newVerdict) {
        continue;
      }

      const { channel, itemIndex } = current || old;
      verdictChanges.push({
        line: record.line,
        caseId: record.caseId,
        turn: record.turn || "primary",
        channel,
        itemIndex,
        before: oldVerdict,
        after: newVerdict,
        text: itemText(value, channel, itemIndex),
        source:
          channel === "documentSupported"
            ? describeSource(itemSourceId(value, itemIndex), record.chunks)
            : null,
      });
    }

    const oldStatus = statusLabel(record.captured.status, record.captured.invalidReason);
    const newStatus = statusLabel(judged.status, judged.invalidReason);

    if (oldStatus !== newStatus) {
      statusChanges.push({
        line: record.line,
        caseId: record.caseId,
        turn: record.turn || "primary",
        before: oldStatus,
        after: newStatus,
      });
    }
  }

  return {
    recordCount: records.length,
    verdictTotal,
    verdictChanges,
    statusChanges,
    errors,
  };
}

function truncate(text) {
  const flat = String(text || "").replace(/\s+/g, " ").trim();
  return flat.length > TEXT_LIMIT ? `${flat.slice(0, TEXT_LIMIT - 1)}…` : flat;
}

function plural(count, singular, pluralForm = `${singular}s`) {
  return count === 1 ? singular : pluralForm;
}

/**
 * The printed report. Ends with "N verdicts changed of M", the line a change
 * is judged by.
 *
 * @param {{ header?: any, source?: string, parseErrors?: any[], result: ReturnType<typeof replayRecords> }} report
 */
export function formatReplayReport({ header = null, source = "capture", parseErrors = [], result }) {
  const lines = [];
  const capturedAt = header?.capturedAt ? `captured ${header.capturedAt}` : "capture time unknown";
  const revision = header?.revision
    ? ` at revision ${header.revision}${header.dirty ? " (uncommitted changes)" : ""}`
    : "";

  lines.push(
    `Replaying ${source}: ${result.recordCount} ${plural(result.recordCount, "record")}, ${capturedAt}${revision}.`,
    "Offline: the current validator and verifier re-judge each captured reply. No model call is made.",
    ""
  );

  for (const change of result.verdictChanges) {
    lines.push(
      `${change.caseId} (${change.turn}) ${verdictKey(change.channel, change.itemIndex)}: ` +
        `${change.before ?? "(no such item)"} → ${change.after ?? "(no such item)"}`
    );

    if (change.text) {
      lines.push(`    ${change.channel === "documentSupported" ? "claim" : "text"}: ${truncate(change.text)}`);
    }

    if (change.source) {
      lines.push(`    source: ${change.source}`);
    }
  }

  for (const change of result.statusChanges) {
    lines.push(`${change.caseId} (${change.turn}) status: ${change.before} → ${change.after}`);
  }

  const problems = [...parseErrors, ...result.errors];

  if (problems.length) {
    if (lines[lines.length - 1] !== "") {
      lines.push("");
    }

    lines.push(`${problems.length} ${plural(problems.length, "line")} could not be replayed:`);

    for (const problem of problems) {
      lines.push(`  line ${problem.line}: ${problem.message}`);
    }
  }

  if (result.verdictChanges.length || result.statusChanges.length || problems.length) {
    lines.push("");
  }

  const statusCount = result.statusChanges.length;
  lines.push(
    `${statusCount} answer ${plural(statusCount, "status", "statuses")} changed of ${result.recordCount} ${plural(
      result.recordCount,
      "record"
    )}`,
    `${result.verdictChanges.length} ${plural(result.verdictChanges.length, "verdict")} changed of ${
      result.verdictTotal
    }`
  );

  return lines.join("\n");
}
