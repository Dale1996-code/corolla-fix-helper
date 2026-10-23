// How one answer-quality case is asked: shared by eval:answers and eval:capture.
//
// A capture is only worth replaying if it recorded what eval:answers would have
// asked. Both scripts therefore run a case through runAnswerCase -- the same
// options for the first question (image, metrics, rejection probe), the same
// follow-up history, and the same rate-limit retry -- and differ only in the
// Ask core they inject. Copying this into the capture script would let the two
// drift until a replay judged replies to questions eval:answers never asks.
//
// The Ask core is injected, never imported: aiAnswerService.js opens the real
// database at import, and this module must stay loadable by tests that have
// neither a database nor an API key.

import { createRejectionProbe } from "./answerRejectionProbes.js";

export const MAX_RATE_LIMIT_RETRIES = 4;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Rate limiting is infrastructure, not a product signal. Tell them apart. */
export function isRateLimited(error) {
  return Number(error?.failure?.httpStatus) === 429;
}

/**
 * The client-facing message is deliberately generic, because provider bodies
 * must never reach a browser. This is a local developer tool, so surface the
 * bounded internal diagnostic here -- otherwise a failing eval is undebuggable.
 */
export function describeError(error) {
  const parts = [error.message];

  if (error?.failure?.httpStatus) {
    parts.push(`[http ${error.failure.httpStatus}]`);
  }

  if (error?.failure?.diagnostic) {
    parts.push(`diagnostic: ${error.failure.diagnostic}`);
  }

  return parts.join(" ");
}

/**
 * The options a case's first question is asked with.
 *
 * Vision cases attach an image so the run exercises the same not-found gate
 * with a photo present; text cases pass image: null and are unchanged.
 * includeMetrics surfaces log-safe timing/size numbers (no document text) so a
 * run doubles as a retrieval/answer performance check. Rejection cases replace
 * the model reply with a probe crafted to fail one specific check, and pin the
 * contract on so the local ASK_EVIDENCE_CONTRACT setting cannot quietly route
 * the case past the verifier it is testing.
 */
export function buildPrimaryAskOptions(testCase) {
  return {
    image: testCase.image || null,
    includeMetrics: true,
    ...(testCase.rejectionProbe
      ? {
          evidenceContract: true,
          generateEvidenceAnswer: createRejectionProbe(testCase.rejectionProbe),
        }
      : {}),
  };
}

export async function askWithRetry(
  askQuestion,
  question,
  options,
  { sleep = defaultSleep, log = console.log, maxRetries = MAX_RATE_LIMIT_RETRIES } = {}
) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await askQuestion(question, options);
    } catch (error) {
      if (!isRateLimited(error) || attempt >= maxRetries) {
        throw error;
      }

      const backoffMs = 5000 * (attempt + 1);
      log(`    - rate limited, retrying in ${backoffMs / 1000}s`);
      await sleep(backoffMs);
    }
  }
}

/**
 * Ask a case's question, then its follow-up (if any) with the first answer as
 * history.
 *
 * `adjustOptions(options, turn)` lets a caller add to what each turn is asked
 * with -- eval:capture uses it to record the model reply -- without restating
 * the options themselves. `turn` is "primary" or "followUp".
 *
 * @param {any} testCase
 * @param {{
 *   askQuestion: (question: string, options: any) => Promise<any>,
 *   adjustOptions?: (options: any, turn: "primary" | "followUp") => any,
 *   sleep?: (ms: number) => Promise<void>,
 *   log?: (line: string) => void,
 * }} deps
 */
export async function runAnswerCase(
  testCase,
  { askQuestion, adjustOptions = (options) => options, sleep = defaultSleep, log = console.log }
) {
  const retry = { sleep, log };
  const primary = await askWithRetry(
    askQuestion,
    testCase.question,
    adjustOptions(buildPrimaryAskOptions(testCase), "primary"),
    retry
  );

  let followUp = null;

  if (testCase.followUp) {
    const history = [
      { role: "user", content: testCase.question },
      { role: "assistant", content: primary.answer },
    ];
    followUp = await askWithRetry(
      askQuestion,
      testCase.followUp.question,
      adjustOptions({ history }, "followUp"),
      retry
    );
  }

  return { primary, followUp };
}
