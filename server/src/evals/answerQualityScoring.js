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

/**
 * Split an answer into the units a qualification has to hold WITHIN.
 *
 * "96 mm applies to the 2AZ-FE" and "the height is 96 mm" are different claims,
 * and whole-answer matching cannot tell them apart: an answer that names the
 * other engine anywhere would launder every value in the reply. A sentence (or
 * a rendered claim line, which is how the evidence contract emits them) is the
 * smallest unit where a value and its condition are actually asserted together.
 *
 * A boundary is a newline, or sentence punctuation followed by whitespace --
 * except after "No." / "NO.", which in these manuals is a part number and not a
 * sentence end. Splitting on every period-space would cut
 * "For 2AZ-FE, the No. 1 clearance is 96 mm." in half and fail a correctly
 * qualified statement.
 *
 * The exception is measured, not guessed: "No."/"NO." followed by a space
 * appears in 2,958 of 20,447 chunks, far ahead of any other abbreviation
 * ("approx." 57, "Fig." 46, "Ref." 0). An earlier attempt required the next
 * sentence to start with a CAPITAL instead, which fixed the same abbreviation
 * but silently stopped splitting sentences that open with a digit or a
 * lowercase word -- so "This car may be a 2AZ-FE. 96 mm is the front figure."
 * became ONE segment and the stale qualifier laundered a bare value. Excluding
 * one measured abbreviation is narrower than a rule about every sentence.
 *
 * Known and deliberate limits: an abbreviation that is NOT "No." and is followed
 * by a capital still splits ("see Fig. A for ..."), and a sentence genuinely
 * ending in the word "No" does not. Both are rare in a repair manual, and
 * neither is worth growing this into an abbreviation dictionary or a sentence
 * parser.
 */
function answerSegments(text) {
  return String(text || "")
    .split(/\n+|(?<!\b(?:No|NO)\.)(?<=[.;!?])\s+/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

/** Escape a literal string so it can be scanned with the same code path as a regex. */
function escapeForRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Every position at which `pattern` occurs in `text`.
 *
 * Builds its own scanner rather than reusing the caller's regex, because
 * `RegExp.prototype.exec` mutates `lastIndex` on a global pattern and a shared
 * one would give different answers depending on what was scanned before it.
 * Case definitions are separately forbidden from declaring `g` or `y` (see
 * answerQualityCases.test.js) so an author gets a loud failure rather than
 * relying on this to quietly compensate.
 */
function matchPositions(text, pattern) {
  const source = pattern instanceof RegExp ? pattern.source : escapeForRegExp(pattern);
  const flags =
    pattern instanceof RegExp ? `${pattern.flags.replace(/[gy]/g, "")}g` : "gi";
  const scanner = new RegExp(source, flags);
  const positions = [];

  for (let match = scanner.exec(text); match; match = scanner.exec(text)) {
    positions.push(match.index);

    if (match.index === scanner.lastIndex) {
      scanner.lastIndex += 1; // a zero-width pattern would otherwise never advance
    }
  }

  return positions;
}

/** Distance from `at` to the closest of `positions`, or Infinity if there are none. */
function nearestDistance(positions, at) {
  return positions.reduce((best, position) => Math.min(best, Math.abs(position - at)), Infinity);
}

/**
 * Check "this value may only be stated when this condition is stated with it".
 *
 * The applicability contract, expressed once instead of per case. Each entry is
 * `{ value, qualifier, required, label }`:
 *
 *   - Wherever `value` appears, the SAME segment must carry `qualifier`, and no
 *     competing qualifier declared by this case may sit closer to it. An answer
 *     may therefore quote another variant's figure -- which a correct
 *     multi-variant answer has to do -- but never as a bare assertion, and never
 *     attached to the wrong condition.
 *   - `required: true` additionally demands the pairing be present at all. That
 *     is what stops an answer satisfying an applicability case by mentioning one
 *     variant and silently dropping the other.
 *
 * WHY NEAREST WINS RATHER THAN A DISTANCE BOUND. Same-segment membership alone
 * accepts "81 N*m for TMC-made and 52 N*m for TMMT-made", which is both values,
 * both plants, and exactly backwards. A configurable proximity bound cannot fix
 * it either: measured on the real phrasing, TMMT sits 31 characters from "81 N"
 * in the correct live answer AND 31 characters from it in the swapped sentence,
 * so no threshold separates them. What does separate them is that the swap puts
 * a COMPETING qualifier (TMC, 7 characters away) nearer than the declared one.
 * Competitors are taken from the case's own other rules, so a case declaring a
 * single condition is unaffected, and there is no constant to tune.
 *
 * Deliberately lexical and deliberately not entailment. It cannot tell that
 * "for the 2AZ-FE and 2ZR-FE the height is 96 mm" is wrong, because the
 * qualifier really is in the segment and really is nearest. That is the same
 * boundary the evidence contract's subject guard documents, and the same reason:
 * a probabilistic judge would trade a deterministic guarantee for a guess. What
 * it does catch is the failure actually observed on this corpus -- a
 * variant-specific number restated as though it were unconditional.
 */
function checkQualifiedValues(result, spec, label) {
  if (!Array.isArray(spec.qualifiedValues) || !spec.qualifiedValues.length) {
    return [];
  }

  const segments = answerSegments(result?.answer);
  const checks = [];

  for (const rule of spec.qualifiedValues) {
    const name = rule.label || `${String(rule.value)} qualified by ${String(rule.qualifier)}`;
    // Compared by pattern text, not object identity: the vehicle-height case
    // writes /2AZ-FE/i three times, and three separate literals with the same
    // source are one condition, not three rivals.
    const competing = spec.qualifiedValues
      .map((entry) => entry.qualifier)
      .filter((qualifier) => String(qualifier) !== String(rule.qualifier));

    let qualified = 0;
    const misqualified = [];

    for (const segment of segments) {
      const valueAt = matchPositions(segment, rule.value);

      if (!valueAt.length) {
        continue;
      }

      const ownAt = matchPositions(segment, rule.qualifier);
      const rivalAt = competing.flatMap((qualifier) => matchPositions(segment, qualifier));

      for (const at of valueAt) {
        if (nearestDistance(ownAt, at) < nearestDistance(rivalAt, at)) {
          qualified += 1;
        } else {
          misqualified.push(segment);
        }
      }
    }

    if (rule.required) {
      checks.push({
        name: `${label}: states ${name}`,
        pass: qualified > 0,
        detail: qualified
          ? `${qualified} correctly qualified statement(s)`
          : "never stated with its own condition nearest",
      });
    }

    checks.push({
      name: `${label}: never states ${String(rule.value)} without ${String(rule.qualifier)}`,
      pass: misqualified.length === 0,
      detail: misqualified.length
        ? `wrongly qualified in: "${misqualified[0].slice(0, 120)}"`
        : `${qualified} statement(s), all qualified`,
    });
  }

  return checks;
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

  // Claims that must NOT appear in the answer.
  //
  // Scope is deliberately narrower than the rejection-case version, which scans
  // the whole serialized response. An answered case cites real pages, and a real
  // page routinely contains the very value that would be wrong for this car --
  // the alignment table prints the 2ZR-FE and 2AZ-FE vehicle heights two lines
  // apart, so a whole-response scan would fail every applicability case for
  // quoting its own evidence correctly. What must not happen is the ANSWER
  // ASSERTING the wrong figure, so that is what is checked.
  //
  // This only ever adds a way to fail. Cases without the field are unchanged.
  if (Array.isArray(spec.mustNotIncludeAny) && spec.mustNotIncludeAny.length) {
    for (const pattern of spec.mustNotIncludeAny) {
      const found = textMatches(result?.answer, pattern);
      checks.push({
        name: `${label}: does not assert ${String(pattern)}`,
        pass: !found,
        detail: found ? "present in the answer" : "absent",
      });
    }
  }

  checks.push(...checkQualifiedValues(result, spec, label));

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
