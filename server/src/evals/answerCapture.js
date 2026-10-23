// Answer captures: what the model said, what it was shown, and what the Ask
// verifier decided, written down so a later verifier can be judged against it
// for free (audit Stage 1b, 4B-11).
//
// Every verifier change so far (N4, audit Stage 2, Stage 5-E2) was judged by a
// replay script in %TEMP% that was then deleted, along with the capture it read.
// This module is the format those scripts never had. eval:capture (paid) writes
// it; eval:replay (free, offline) reads it back through answerReplay.js.
//
// A capture is JSON Lines: one header line, then one record per model reply.
//
//   {"type":"header","format":"corolla-fix-helper/answer-capture","version":1,...}
//   {"type":"ask","caseId":"...","turn":"primary","reply":{...},"chunks":[...],
//    "captured":{"status":"partial","verdicts":[...]}}
//
// `reply` is the model's PARSED reply before validation, so a replay re-runs the
// shape validator as well as verifyEvidence: a change to either can move a
// verdict. `chunks` are the passages the model was shown, in S1..Sn order.
// `captured` is what judgeReply decided at capture time.
//
// Captures quote real manual text, which is why server/data/captures/ is
// gitignored. Never commit one; the test fixture is invented text.
//
// Imports nothing that reads config or opens the database, so eval:replay can
// load it with OPENAI_API_KEY unset and no database at all.

import {
  ASK_REJECTION_CHANNELS,
  deriveEvidenceStatus,
  validateEvidencePayload,
  verifyEvidence,
} from "../services/askEvidenceContract.js";
import { readOpenAiResponse } from "../services/openAiResponsePayload.js";
import { describeError, runAnswerCase } from "./answerCaseRunner.js";

export const CAPTURE_FORMAT = "corolla-fix-helper/answer-capture";
export const CAPTURE_VERSION = 1;

/** The verdict for an item the verifier kept. Every other verdict is a reason. */
export const ACCEPTED = "accepted";

/** The status a reply gets when the shape validator refuses it outright. */
export const INVALID_REPLY = "invalid_reply";

/**
 * Judge one model reply the way the Ask pipeline does: validate the shape,
 * verify every item, derive the status.
 *
 * Returns one verdict per item of the VALIDATED reply, in channel order, keyed
 * by (channel, itemIndex) -- the same index verifyEvidence reports rejections
 * by. A reply the validator refuses gets no item verdicts and the status
 * `invalid_reply`, with the validator's reason.
 *
 * @param {unknown} reply
 * @param {any[]} chunks
 * @returns {{
 *   status: string,
 *   invalidReason?: string,
 *   verdicts: Array<{ channel: string, itemIndex: number, verdict: string }>,
 *   value: any,
 * }}
 */
export function judgeReply(reply, chunks) {
  const validated = validateEvidencePayload(reply);

  if (!validated.ok) {
    return { status: INVALID_REPLY, invalidReason: validated.reason, verdicts: [], value: null };
  }

  const verification = verifyEvidence(validated.value, chunks);
  const reasons = new Map();

  for (const rejection of verification.rejected) {
    const key = `${rejection.channel}:${rejection.itemIndex}`;

    if (!reasons.has(key)) {
      reasons.set(key, rejection.reason);
    }
  }

  const verdicts = [];

  for (const channel of ASK_REJECTION_CHANNELS) {
    for (let itemIndex = 0; itemIndex < validated.value[channel].length; itemIndex += 1) {
      verdicts.push({
        channel,
        itemIndex,
        verdict: reasons.get(`${channel}:${itemIndex}`) ?? ACCEPTED,
      });
    }
  }

  return { status: deriveEvidenceStatus(verification), verdicts, value: validated.value };
}

function isJsonPrimitive(value) {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

/**
 * A JSON-safe copy of a retrieved chunk: every primitive field, and arrays of
 * primitives. Objects, buffers, and embedding vectors are left out.
 *
 * Deliberately not a fixed list of the fields verifyEvidence reads today. A
 * later verifier may read a field retrieval adds later (N5 P3 will need the
 * scope P2 stores on each chunk); copying what retrieval returned means a
 * capture taken after that field exists already carries it.
 */
export function snapshotChunk(chunk) {
  const copy = {};

  for (const [key, value] of Object.entries(chunk || {})) {
    if (isJsonPrimitive(value)) {
      copy[key] = value;
    } else if (Array.isArray(value) && value.every(isJsonPrimitive)) {
      copy[key] = [...value];
    }
  }

  return copy;
}

/**
 * The header line. `revision` and `dirty` say which code the replies were
 * judged by; the models say what produced them.
 */
export function buildCaptureHeader({
  capturedAt = new Date().toISOString(),
  revision = null,
  dirty = null,
  answerModel = null,
  visionModel = null,
  caseCount = 0,
} = {}) {
  return {
    type: "header",
    format: CAPTURE_FORMAT,
    version: CAPTURE_VERSION,
    capturedAt,
    revision,
    dirty,
    answerModel,
    visionModel,
    caseCount,
  };
}

/**
 * One record: a model reply, what it was shown, and the verdict judged now.
 *
 * `pipelineStatus` is the status the Ask pipeline itself returned for the same
 * reply, kept as a cross-check: it should always equal `captured.status`, and
 * the capture warns when it does not.
 */
export function buildCaptureRecord({
  caseId,
  turn = "primary",
  question,
  standaloneQuestion = question,
  hasImage = false,
  replySource = "model",
  reply,
  chunks,
  pipelineStatus = null,
}) {
  const snapshots = (Array.isArray(chunks) ? chunks : []).map(snapshotChunk);
  const judged = judgeReply(reply, snapshots);

  return {
    type: "ask",
    caseId,
    turn,
    question,
    standaloneQuestion,
    hasImage: Boolean(hasImage),
    replySource,
    reply,
    chunks: snapshots,
    captured: {
      status: judged.status,
      ...(judged.invalidReason ? { invalidReason: judged.invalidReason } : {}),
      verdicts: judged.verdicts,
      pipelineStatus,
    },
  };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Why a parsed `ask` record cannot be replayed, or null when it can. */
function recordProblem(record) {
  if (typeof record.caseId !== "string" || !record.caseId) {
    return "caseId is missing";
  }

  if (typeof record.question !== "string") {
    return "question is missing";
  }

  if (!("reply" in record)) {
    return "reply is missing";
  }

  if (!Array.isArray(record.chunks) || record.chunks.some((chunk) => !isPlainObject(chunk))) {
    return "chunks must be an array of objects";
  }

  if (record.chunks.some((chunk) => typeof chunk.chunkText !== "string")) {
    return "every chunk needs its chunkText";
  }

  const captured = record.captured;

  if (!isPlainObject(captured) || typeof captured.status !== "string") {
    return "captured.status is missing";
  }

  if (!Array.isArray(captured.verdicts)) {
    return "captured.verdicts is missing";
  }

  for (const entry of captured.verdicts) {
    if (
      !isPlainObject(entry) ||
      !ASK_REJECTION_CHANNELS.includes(entry.channel) ||
      !Number.isInteger(entry.itemIndex) ||
      entry.itemIndex < 0 ||
      typeof entry.verdict !== "string"
    ) {
      return "captured.verdicts holds a malformed entry";
    }
  }

  return null;
}

/**
 * Read a capture file's text.
 *
 * Fails closed: the first non-blank line must be a header naming this format
 * and version, and every line that cannot be replayed is reported with its line
 * number instead of being skipped. A replay that quietly dropped records would
 * print "0 verdicts changed" over a capture it never read.
 *
 * @param {string} text
 * @returns {{ header: any, records: any[], errors: Array<{ line: number, message: string }> }}
 */
export function parseCaptureText(text) {
  const records = [];
  const errors = [];
  let header = null;
  let sawContent = false;

  const lines = String(text ?? "").split(/\r?\n/);

  for (const [index, rawLine] of lines.entries()) {
    const line = index + 1;
    const content = rawLine.trim();

    if (!content) {
      continue;
    }

    let parsed;

    try {
      parsed = JSON.parse(content);
    } catch {
      errors.push({ line, message: "not valid JSON" });
      sawContent = true;
      continue;
    }

    if (!sawContent) {
      sawContent = true;

      if (!isPlainObject(parsed) || parsed.type !== "header" || parsed.format !== CAPTURE_FORMAT) {
        errors.push({ line, message: `the first line must be a ${CAPTURE_FORMAT} header` });
        return { header: null, records: [], errors };
      }

      if (parsed.version !== CAPTURE_VERSION) {
        errors.push({
          line,
          message: `capture version ${parsed.version} is not supported (expected ${CAPTURE_VERSION})`,
        });
        return { header: null, records: [], errors };
      }

      header = parsed;
      continue;
    }

    if (!isPlainObject(parsed) || parsed.type !== "ask") {
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

/**
 * Wrap an evidence generator so the reply it gets back is kept.
 *
 * For the real OpenAI generator, the provider response is teed through the
 * `fetchImpl` seam and its output text parsed here, so the record holds the
 * reply BEFORE validation -- including claims the validator would drop. A
 * generator that makes no request (a rejection probe) is recorded by its return
 * value. `last` is set even when the generator then throws on an invalid reply:
 * that reply is still worth replaying against a later validator.
 *
 * @param {(args: any) => Promise<any>} generate
 * @param {{ fetchImpl?: typeof fetch }} [options]
 */
export function createReplyRecorder(generate, { fetchImpl = fetch } = {}) {
  /**
   * @typedef {{
   *   question: string,
   *   originalQuestion: string,
   *   chunks: any[],
   *   hasImage: boolean,
   *   reply?: unknown,
   *   replyError?: string,
   * }} RecordedReply
   */
  const recorder = {
    /** @type {RecordedReply | null} */
    last: null,
    generate: async (args) => {
      /** @type {RecordedReply} */
      const entry = {
        question: args.question,
        originalQuestion: args.originalQuestion,
        chunks: args.chunks,
        hasImage: Boolean(args.image),
      };
      recorder.last = entry;

      const teeFetch = async (url, init) => {
        const response = await fetchImpl(url, init);

        if (response?.ok && typeof response.clone === "function") {
          const read = readOpenAiResponse(await response.clone().json().catch(() => null));

          if (read.ok) {
            try {
              entry.reply = JSON.parse(read.text);
            } catch {
              entry.replyError = "evidence_not_json";
            }
          }
        }

        return response;
      };

      const value = await generate({ ...args, fetchImpl: teeFetch });

      if (!("reply" in entry)) {
        entry.reply = value;
      }

      return value;
    },
  };

  return recorder;
}

/**
 * Run answer-quality cases through an injected Ask core and write one record
 * per model reply.
 *
 * Paid when `askQuestion` is the real pipeline: the CLI (captureAnswers.js)
 * injects it, and only with the owner's go-ahead. Tests inject a stub.
 *
 * The evidence contract is pinned on for every turn: a reply in the legacy
 * prose shape has no claims, so there would be nothing to replay. A turn that
 * ends before the model is asked (the defeat gate, nothing retrieved, the
 * relevance gate) has no reply and writes no record.
 *
 * @param {{
 *   cases: any[],
 *   askQuestion: (question: string, options: any) => Promise<any>,
 *   generateEvidenceAnswer: (args: any) => Promise<any>,
 *   writeLine: (line: string) => void,
 *   header?: any,
 *   fetchImpl?: typeof fetch,
 *   caseDelayMs?: number,
 *   sleep?: (ms: number) => Promise<void>,
 *   log?: (line: string) => void,
 * }} options
 */
export async function captureAnswerCases({
  cases,
  askQuestion,
  generateEvidenceAnswer,
  writeLine,
  header = buildCaptureHeader({ caseCount: cases.length }),
  fetchImpl = fetch,
  caseDelayMs = 0,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = console.log,
}) {
  writeLine(JSON.stringify(header));

  const summary = { records: 0, noReply: 0, failedCases: 0, statusMismatches: 0 };

  for (const [caseIndex, testCase] of cases.entries()) {
    if (caseIndex > 0 && caseDelayMs > 0) {
      await sleep(caseDelayMs);
    }

    const recorders = {};
    const adjustOptions = (options, turn) => {
      const recorder = createReplyRecorder(options.generateEvidenceAnswer || generateEvidenceAnswer, {
        fetchImpl,
      });
      recorders[turn] = recorder;

      return { ...options, evidenceContract: true, generateEvidenceAnswer: recorder.generate };
    };

    let results = {};
    let failure = null;

    try {
      results = await runAnswerCase(testCase, { askQuestion, adjustOptions, sleep, log });
    } catch (error) {
      failure = error;
      summary.failedCases += 1;
    }

    for (const turn of ["primary", "followUp"]) {
      const recorder = recorders[turn];

      if (!recorder) {
        continue;
      }

      const entry = recorder.last;

      if (!entry || !("reply" in entry)) {
        summary.noReply += 1;
        const detail = entry?.replyError ? ` (${entry.replyError})` : "";
        log(`${testCase.id} (${turn}): no model reply to record${detail}`);
        continue;
      }

      const result = turn === "primary" ? results.primary : results.followUp;
      const record = buildCaptureRecord({
        caseId: testCase.id,
        turn,
        question: entry.originalQuestion,
        standaloneQuestion: entry.question,
        hasImage: entry.hasImage,
        replySource: testCase.rejectionProbe && turn === "primary" ? "rejection_probe" : "model",
        reply: entry.reply,
        chunks: entry.chunks,
        pipelineStatus: typeof result?.status === "string" ? result.status : null,
      });

      writeLine(JSON.stringify(record));
      summary.records += 1;

      const accepted = record.captured.verdicts.filter((item) => item.verdict === ACCEPTED);
      log(
        `${testCase.id} (${turn}): ${record.captured.status}, ` +
          `${accepted.length}/${record.captured.verdicts.length} items accepted`
      );

      if (record.captured.pipelineStatus && record.captured.pipelineStatus !== record.captured.status) {
        summary.statusMismatches += 1;
        log(
          `    ! the pipeline returned ${record.captured.pipelineStatus}; ` +
            "the recorded verdict was judged on the same reply and chunks"
        );
      }
    }

    if (failure) {
      log(`${testCase.id}: failed -- ${describeError(failure)}`);
    }
  }

  return summary;
}
