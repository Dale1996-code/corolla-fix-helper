// Live answer-quality eval. Asks each case in answerQualityCases.js against your
// REAL embedded database and scores the answers. Run on the machine that has your
// documents imported, embedded, and an OPENAI_API_KEY set:
//
//   npm run eval:answers
//
// Verified cases gate the result (exit code 1 on any verified failure). Unverified
// template cases are reported for information only.

import { config } from "../config.js";

if (!config.openAiApiKey) {
  console.log("Answer-quality eval skipped: OPENAI_API_KEY is not set.");
  console.log("Run it on the machine with your real embedded database and API key:");
  console.log("  npm run eval:answers");
  process.exit(0);
}

// Importing database.js initializes the (real) database from config.
const { db } = await import("../database.js");
const { askQuestionUsingDocuments } = await import("../services/aiAnswerService.js");
const { answerQualityCases } = await import("../evals/answerQualityCases.js");
const { evaluateAnswerCase, summarize } = await import("../evals/answerQualityScoring.js");
const { createRejectionProbe } = await import("../evals/answerRejectionProbes.js");
const { validateAskResponse } = await import("../services/askResponseContract.js");
const { NEGATIVE_CASE_PRECONDITIONS } = await import(
  "../evals/negativeCorpusPreconditions.js"
);

// A verified must-refuse case is only valid while the corpus still lacks the
// fact. The corpus is mutable, so check before trusting the expectation: if real
// evidence has appeared, the case needs a human, not a silent green tick.
const staleNegativeCases = new Set();

for (const [caseId, check] of Object.entries(NEGATIVE_CASE_PRECONDITIONS)) {
  const testCase = answerQualityCases.find((entry) => entry.id === caseId);

  if (!testCase || !testCase.verified) {
    continue;
  }

  const { stale, matches } = check(db);

  if (!stale) {
    continue;
  }

  staleNegativeCases.add(caseId);
  console.log("");
  console.log(`!! NEEDS HUMAN RE-VERIFICATION: ${caseId}`);
  console.log(
    "   This case expects a refusal because the corpus had no such specification."
  );
  console.log("   Evidence suggesting the corpus now DOES contain one:");

  for (const match of matches.slice(0, 5)) {
    console.log(`   - [${match.ruleId}] ${match.documentTitle}, page ${match.pageNumber}`);
    console.log(`     ...${match.excerpt}...`);
  }

  if (matches.length > 5) {
    console.log(`   - ...and ${matches.length - 5} more`);
  }

  console.log("   See docs/evals/ask-rag-iteration-log.md for the re-verification steps.");
  console.log("");
}

const results = [];

// Pacing. Running every case back-to-back exceeds the account's tokens-per-minute
// tier (observed: 30000 TPM), and a 429 then looks exactly like a product
// regression in the results table. Space the cases out, and retry a rate-limited
// case rather than recording a false failure.
const CASE_DELAY_MS = Number(process.env.EVAL_CASE_DELAY_MS || 2000);
const MAX_RATE_LIMIT_RETRIES = 4;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Rate limiting is infrastructure, not a product signal. Tell them apart. */
function isRateLimited(error) {
  return Number(error?.failure?.httpStatus) === 429;
}

/**
 * The client-facing message is deliberately generic, because provider bodies
 * must never reach a browser. This is a local developer tool, so surface the
 * bounded internal diagnostic here -- otherwise a failing eval is undebuggable.
 */
function describeError(error) {
  const parts = [error.message];

  if (error?.failure?.httpStatus) {
    parts.push(`[http ${error.failure.httpStatus}]`);
  }

  if (error?.failure?.diagnostic) {
    parts.push(`diagnostic: ${error.failure.diagnostic}`);
  }

  return parts.join(" ");
}

async function askWithRetry(question, options) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await askQuestionUsingDocuments(question, options);
    } catch (error) {
      if (!isRateLimited(error) || attempt >= MAX_RATE_LIMIT_RETRIES) {
        throw error;
      }

      const backoffMs = 5000 * (attempt + 1);
      console.log(`    - rate limited, retrying in ${backoffMs / 1000}s`);
      await sleep(backoffMs);
    }
  }
}

let rateLimitedCases = 0;
let caseIndex = 0;

for (const testCase of answerQualityCases) {
  if (caseIndex > 0 && CASE_DELAY_MS > 0) {
    await sleep(CASE_DELAY_MS);
  }
  caseIndex += 1;

  try {
    // Vision cases attach an image so the run exercises the same not-found gate
    // with a photo present; text cases pass image: null and are unchanged.
    // includeMetrics surfaces log-safe timing/size numbers (no document text)
    // so a run doubles as a retrieval/answer performance check.
    const primary = await askWithRetry(testCase.question, {
      image: testCase.image || null,
      includeMetrics: true,
      // Rejection cases replace the model reply with a probe crafted to fail one
      // specific check, and pin the contract on so the local ASK_EVIDENCE_CONTRACT
      // setting cannot quietly route the case past the verifier it is testing.
      ...(testCase.rejectionProbe
        ? {
            evidenceContract: true,
            generateEvidenceAnswer: createRejectionProbe(testCase.rejectionProbe),
          }
        : {}),
    });

    // Validate against the shared contract before scoring. The eval calls the
    // service directly rather than over HTTP, so `question` (which the route
    // adds) is supplied here; everything else is the payload as-is. A scorer
    // reading a malformed response would report a product regression for what is
    // really a shape bug, so name it as the shape bug it is.
    const contract = validateAskResponse({ question: testCase.question, ...primary });

    if (!contract.ok) {
      console.log(`    ! response contract: ${contract.errors.join("; ")}`);
    }

    let followUp = null;
    if (testCase.followUp) {
      const history = [
        { role: "user", content: testCase.question },
        { role: "assistant", content: primary.answer },
      ];
      followUp = await askWithRetry(testCase.followUp.question, { history });
    }

    results.push({ ...evaluateAnswerCase(testCase, primary, followUp), metrics: primary.metrics });
  } catch (error) {
    if (isRateLimited(error)) {
      rateLimitedCases += 1;
    }

    results.push({
      id: testCase.id,
      category: testCase.category,
      verified: Boolean(testCase.verified),
      pass: false,
      checks: [{ name: "ran without error", pass: false, detail: describeError(error) }],
      metrics: null,
    });
  }
}

console.log("Answer-quality eval\n");
console.log("id | category | verified | result");
console.log("--- | --- | --- | ---");

for (const result of results) {
  console.log(
    [
      result.id,
      result.category,
      result.verified ? "yes" : "no (template)",
      result.pass ? "PASS" : "FAIL",
    ].join(" | ")
  );

  if (result.metrics) {
    const m = result.metrics;
    console.log(
      `    · ${m.totalMs}ms total (retrieval ${m.retrievalMs}ms, answer ${m.answerMs}ms), ` +
        `${m.chunkCount} chunks, ~${m.approxContextTokens} context tokens`
    );
  }

  if (!result.pass) {
    for (const check of result.checks.filter((check) => !check.pass)) {
      console.log(`    - ${check.name}: ${check.detail}`);
    }
  }
}

const summary = summarize(results);

console.log("");
console.log(`Verified cases passed: ${summary.verifiedPassed}/${summary.verifiedTotal}`);
console.log("Template (unverified) cases are informational and do not gate the result.");
for (const [category, bucket] of Object.entries(summary.byCategory)) {
  console.log(
    `  ${category}: ${bucket.passed}/${bucket.total} passed ` +
      `(${bucket.verifiedPassed}/${bucket.verified} verified)`
  );
}

if (rateLimitedCases) {
  // Never let an infrastructure failure read as a green run OR as a product
  // regression. Say exactly what happened.
  console.log(
    `\nWARNING: ${rateLimitedCases} case(s) still hit the provider rate limit after retries.`
  );
  console.log("Those are infrastructure failures, not product regressions.");
  console.log("Raise EVAL_CASE_DELAY_MS and re-run before drawing conclusions.");
}

if (!summary.allVerifiedPass) {
  console.log("\nFAIL: one or more verified cases did not pass.");
  process.exitCode = 1;
} else if (staleNegativeCases.size) {
  // The cases passed, but at least one passed on a premise the corpus no longer
  // supports. Failing here is the point: a stale refusal expectation that stays
  // green is worse than a red one, because nobody looks at it again.
  console.log(
    `\nFAIL: verified cases passed, but ${[...staleNegativeCases].join(
      ", "
    )} needs human re-verification (see above).`
  );
  process.exitCode = 1;
} else {
  console.log("\nOK: all verified cases passed.");
}
