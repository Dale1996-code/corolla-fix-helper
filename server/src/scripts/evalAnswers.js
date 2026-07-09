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
await import("../database.js");
const { askQuestionUsingDocuments } = await import("../services/aiAnswerService.js");
const { answerQualityCases } = await import("../evals/answerQualityCases.js");
const { evaluateAnswerCase, summarize } = await import("../evals/answerQualityScoring.js");

const results = [];

for (const testCase of answerQualityCases) {
  try {
    // Vision cases attach an image so the run exercises the same not-found gate
    // with a photo present; text cases pass image: null and are unchanged.
    // includeMetrics surfaces log-safe timing/size numbers (no document text)
    // so a run doubles as a retrieval/answer performance check.
    const primary = await askQuestionUsingDocuments(testCase.question, {
      image: testCase.image || null,
      includeMetrics: true,
    });

    let followUp = null;
    if (testCase.followUp) {
      const history = [
        { role: "user", content: testCase.question },
        { role: "assistant", content: primary.answer },
      ];
      followUp = await askQuestionUsingDocuments(testCase.followUp.question, { history });
    }

    results.push({ ...evaluateAnswerCase(testCase, primary, followUp), metrics: primary.metrics });
  } catch (error) {
    results.push({
      id: testCase.id,
      category: testCase.category,
      verified: Boolean(testCase.verified),
      pass: false,
      checks: [{ name: "ran without error", pass: false, detail: error.message }],
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

if (!summary.allVerifiedPass) {
  console.log("\nFAIL: one or more verified cases did not pass.");
  process.exitCode = 1;
} else {
  console.log("\nOK: all verified cases passed.");
}
