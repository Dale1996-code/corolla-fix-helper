import { NOT_FOUND_MESSAGE } from "../services/aiAnswerService.js";

// Pure scoring helpers for the answer-quality eval.
// These have no database or network dependencies, so they are unit-tested in CI
// (see server/test/answerQualityScoring.test.js). The live runner that actually
// calls the chatbot is server/src/scripts/evalAnswers.js.

function textMatches(text, pattern) {
  const value = typeof text === "string" ? text : "";

  if (pattern instanceof RegExp) {
    return pattern.test(value);
  }

  return value.toLowerCase().includes(String(pattern).toLowerCase());
}

function citationsMatch(citations, pattern) {
  if (!Array.isArray(citations)) {
    return false;
  }

  return citations.some(
    (citation) =>
      textMatches(citation?.documentTitle || "", pattern) ||
      textMatches(citation?.originalFilename || "", pattern)
  );
}

export function isRefusal(result) {
  const answer = String(result?.answer || "").trim().toLowerCase();
  return result?.status === "not_found" || answer === NOT_FOUND_MESSAGE.toLowerCase();
}

function checkAnswered(result, spec, label) {
  const checks = [];

  checks.push({
    name: `${label}: status is "answered"`,
    pass: result?.status === "answered",
    detail: `status=${result?.status}`,
  });

  if (Array.isArray(spec.mustIncludeAny) && spec.mustIncludeAny.length) {
    const pass = spec.mustIncludeAny.some((pattern) => textMatches(result?.answer, pattern));
    checks.push({
      name: `${label}: contains the expected value`,
      pass,
      detail: pass ? "matched" : `none of [${spec.mustIncludeAny.map(String).join(", ")}]`,
    });
  }

  if (Array.isArray(spec.mustIncludeAll) && spec.mustIncludeAll.length) {
    for (const pattern of spec.mustIncludeAll) {
      checks.push({
        name: `${label}: contains ${String(pattern)}`,
        pass: textMatches(result?.answer, pattern),
        detail: "",
      });
    }
  }

  // Answered cases must cite a source unless the case opts out (mustCite: false).
  if (spec.mustCite !== false) {
    const count = Array.isArray(result?.citations) ? result.citations.length : 0;
    checks.push({
      name: `${label}: has at least one citation`,
      pass: count > 0,
      detail: `${count} citations`,
    });
  }

  if (spec.citationDocLike) {
    checks.push({
      name: `${label}: cites the expected document`,
      pass: citationsMatch(result?.citations, spec.citationDocLike),
      detail: String(spec.citationDocLike),
    });
  }

  return checks;
}

export function evaluateAnswerCase(testCase, primaryResult, followUpResult = null) {
  const checks = [];

  if (testCase.expect === "refused") {
    checks.push({
      name: "refuses with \"not in documents\"",
      pass: isRefusal(primaryResult),
      detail: `status=${primaryResult?.status}`,
    });
  } else {
    checks.push(...checkAnswered(primaryResult, testCase, "answer"));

    if (testCase.followUp) {
      const followUp = testCase.followUp;

      if (followUp.standaloneIncludes) {
        checks.push({
          name: "follow-up is rewritten into a standalone question",
          pass: textMatches(followUpResult?.standaloneQuestion, followUp.standaloneIncludes),
          detail: followUpResult?.standaloneQuestion || "(none)",
        });
      }

      checks.push(...checkAnswered(followUpResult, followUp, "follow-up"));
    }
  }

  return {
    id: testCase.id,
    category: testCase.category,
    verified: Boolean(testCase.verified),
    pass: checks.every((check) => check.pass),
    checks,
  };
}

export function summarize(results) {
  const verified = results.filter((result) => result.verified);
  const verifiedPassed = verified.filter((result) => result.pass).length;
  const byCategory = {};

  for (const result of results) {
    const bucket =
      byCategory[result.category] ||
      (byCategory[result.category] = { total: 0, passed: 0, verified: 0, verifiedPassed: 0 });

    bucket.total += 1;
    if (result.pass) {
      bucket.passed += 1;
    }
    if (result.verified) {
      bucket.verified += 1;
      if (result.pass) {
        bucket.verifiedPassed += 1;
      }
    }
  }

  return {
    total: results.length,
    verifiedTotal: verified.length,
    verifiedPassed,
    allVerifiedPass: verifiedPassed === verified.length,
    byCategory,
  };
}
