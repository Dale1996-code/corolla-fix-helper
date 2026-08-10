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

// True when at least one cited snippet text matches the pattern. This is the
// grounding check: it confirms the cited chunk text actually contains the
// asserted spec / supporting term, not just that *an* answer mentioned it.
function citationSnippetSupports(citations, pattern) {
  if (!Array.isArray(citations)) {
    return false;
  }

  return citations.some((citation) => textMatches(citation?.snippet || "", pattern));
}

export function isRefusal(result) {
  const answer = String(result?.answer || "").trim().toLowerCase();
  return result?.status === "not_found" || answer === NOT_FOUND_MESSAGE.toLowerCase();
}

function checkAnswered(result, spec, label) {
  const checks = [];

  // "partial" counts as answered.
  //
  // The evidence contract (Milestone 2) added a third status that did not exist
  // when this check was written: `partial` means at least one claim VERIFIED
  // against its cited chunk, alongside one or more gaps. That is a successful,
  // grounded answer that also reports what it could not support -- refusing it
  // here would penalize the contract for being honest.
  //
  // Observed live: for the drain-plug case the model emitted three correct
  // torque claims plus a meta-claim about which document states them, whose
  // quote was not literally on the page. The verifier rejected the meta-claim
  // into a gap, which is exactly right, and the status became `partial`.
  //
  // This does NOT weaken the gate. `not_found` still fails an answered
  // expectation, and the value, citation, and conjunctive
  // document-plus-value checks below all still have to pass on their own.
  const answeredStatuses = ["answered", "partial"];

  checks.push({
    name: `${label}: status is answered or partial`,
    pass: answeredStatuses.includes(result?.status),
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

  const supportsAny =
    Array.isArray(spec.citationSupportsAny) && spec.citationSupportsAny.length
      ? spec.citationSupportsAny
      : null;

  // When a case constrains BOTH the document and the supporting value, ONE
  // citation must satisfy both together.
  //
  // Checking them independently allowed cross-citation laundering: with the
  // eight retrieved chunks all becoming citations, citation A could supply the
  // document match while unrelated citation B happened to contain the number,
  // and the case would pass without any single source actually backing the
  // claim. That is precisely the failure this assertion exists to catch.
  if (spec.citationDocLike && supportsAny) {
    const citations = Array.isArray(result?.citations) ? result.citations : [];
    const grounding = citations.find(
      (citation) =>
        (textMatches(citation?.documentTitle || "", spec.citationDocLike) ||
          textMatches(citation?.originalFilename || "", spec.citationDocLike)) &&
        supportsAny.some((pattern) => textMatches(citation?.snippet || "", pattern))
    );

    checks.push({
      name: `${label}: one citation both cites the expected document and supports the value`,
      pass: Boolean(grounding),
      detail: grounding
        ? `${grounding.documentTitle || grounding.originalFilename}, page ${grounding.pageNumber}`
        : `no single citation matched ${String(spec.citationDocLike)} AND one of [${supportsAny
            .map(String)
            .join(", ")}]`,
    });

    return checks;
  }

  if (spec.citationDocLike) {
    checks.push({
      name: `${label}: cites the expected document`,
      pass: citationsMatch(result?.citations, spec.citationDocLike),
      detail: String(spec.citationDocLike),
    });
  }

  // Citation grounding: at least one cited snippet must actually contain a
  // supporting term, so a confidently-worded answer cannot pass on a citation
  // that does not back it up.
  if (supportsAny) {
    const pass = supportsAny.some((pattern) =>
      citationSnippetSupports(result?.citations, pattern)
    );
    checks.push({
      name: `${label}: a cited snippet supports the expected value`,
      pass,
      detail: pass
        ? "matched"
        : `no citation snippet matched [${supportsAny.map(String).join(", ")}]`,
    });
  }

  return checks;
}

/**
 * Score a verifier-rejection case.
 *
 * Distinct from a refusal on purpose. A refusal means retrieval found nothing to
 * support an answer; a rejection means a claim arrived WITH evidence and the
 * server threw it out. Both end at `not_found`, so checking the status alone
 * would let one silently stand in for the other — which is the whole reason this
 * path was invisible in production before metrics.rejected existed.
 */
function checkRejected(result, spec) {
  const checks = [];
  const status = result?.status;

  // Must never be `answered`: a rejected claim reaching the owner as a confirmed
  // answer is the failure this case exists to catch.
  checks.push({
    name: `status is ${spec.expectedStatus} and not answered`,
    pass: status === spec.expectedStatus && status !== "answered",
    detail: `status=${status}`,
  });

  const citationCount = Array.isArray(result?.citations) ? result.citations.length : 0;
  checks.push({
    name: "no citations survive when every claim was rejected",
    pass: citationCount === 0,
    detail: `${citationCount} citations`,
  });

  // The metrics channel is the point of the exercise: without it, a rejection is
  // indistinguishable from an ordinary retrieval miss.
  const rejected = Array.isArray(result?.metrics?.rejected) ? result.metrics.rejected : null;
  checks.push({
    name: "metrics report the rejection",
    pass: Boolean(rejected && rejected.length),
    detail: rejected ? `${rejected.length} rejected` : "metrics.rejected missing",
  });

  for (const reason of spec.requiredRejectedReasons || []) {
    checks.push({
      name: `metrics.rejected includes ${reason}`,
      pass: Boolean(rejected?.some((entry) => entry?.reason === reason)),
      detail: rejected ? rejected.map((entry) => entry?.reason).join(", ") || "(none)" : "(no metrics)",
    });
  }

  // Scan the WHOLE serialized response, not just `answer`. A rejected
  // specification that reappears inside a gap, a citation snippet, or the
  // evidence block is just as much on screen as one in the answer text.
  if (Array.isArray(spec.mustNotIncludeAny) && spec.mustNotIncludeAny.length) {
    const serialized = JSON.stringify(result ?? null);

    for (const pattern of spec.mustNotIncludeAny) {
      const found = textMatches(serialized, pattern);
      checks.push({
        name: `the rejected value ${String(pattern)} appears nowhere in the response`,
        pass: !found,
        detail: found ? "LEAKED into the response" : "absent",
      });
    }
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
  } else if (testCase.expect === "rejected") {
    checks.push(...checkRejected(primaryResult, testCase));
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
