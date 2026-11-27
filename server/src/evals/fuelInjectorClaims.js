import { renderEvidenceAnswer } from "../services/askEvidenceContract.js";

// fuel-injector-resistance: a structured check of the VERIFIED CLAIMS.
//
// Why it exists. Whole-answer regexes (qualifiedValues) cannot say which part
// owns a figure once an answer holds several sentences, and they accept a
// figure with no unit or no test temperature. The verifier cannot say either:
// it proves a claim is printed in its quote, in the same unit, about a part
// the quote names. It does not prove the answer is the COMPLETE, QUALIFIED
// statement the owner needs. This check reads `result.evidence`, the server's
// own list of verified atomic claims, which is exactly what the renderer prints.
// Pure and deterministic: no database, no network, no model.
//
// THE CONTRACT (three records, each failing closed when the evidence is unreadable)
//   1. Rendering. `result.answer` must equal `renderEvidenceAnswer(evidence)`,
//      so the claims judged here are the claims the owner saw.
//   2. Credit. One verified claim must name the injector, give its range in
//      ohms, and give the test temperature, and must name no other part.
//   3. No contradiction. In EVERY rendered line (claims, guidance, gaps), a line
//      that names the injector may print no other resistance, no other
//      temperature, and the injector's range only in ohms.
//
// DESIGN CHOICE: lexical and conservative. It reads words, not meaning, so it
// prefers rejecting a correct answer to passing a wrong one. Each limit is
// pinned by a test in fuelInjectorClaims.test.js.
//   Fails a correct answer:
//   - one claim that names the injector and another part ("the injector is X
//     and the pump is Y"): ask for atomic claims;
//   - a harness or circuit-check figure (below 1 Ω, 10 kΩ or higher) in a line
//     that also names the injector;
//   - a temperature written in words ("room temperature").
//   Passes a wrong answer:
//   - a pronoun-only claim ("It reads 12 Ω") names no injector, so it is not
//     judged at all;
//   - a figure the verifier accepts and this check cannot place (a part named
//     only by a code or a synonym).

/** What the question asks for. The default is the 2009 Corolla 1.8L service-data row. */
export const FUEL_INJECTOR_EXPECTATION = Object.freeze({
  low: 11.6,
  high: 12.4,
  celsius: 20,
  fahrenheit: 68,
});

const OTHER_PART = /\b(?:pump|sender|gauge|float|sensor|relay|coil\s+pack|ignition)\b/i;
const INJECTOR = /\binjectors?\b/i;
const NUMBER = String.raw`\d+(?:[.,]\d+)?`;
// Both ohm code points: U+03A9 (Greek capital omega) and U+2126 (the ohm sign) print identically.
const OHM_UNIT = String.raw`(?:k|m|M)?\s*(?:\u03A9|\u2126|ohms?\b)`;
const RESISTANCE = new RegExp(String.raw`(${NUMBER})\s*(?:(?:to|-|–|—|and)\s*(${NUMBER})\s*)?(${OHM_UNIT})`, "giu");
const TEMPERATURE = new RegExp(String.raw`(-?${NUMBER})\s*[°º]\s*([CF])\b`, "giu");

const RENDERING = "fuel injector claims: the answer is exactly its verified evidence, rendered";
const CREDIT = "fuel injector claims: one verified claim names the injector, its range in ohms, and the test temperature";
const CONTRADICTION = "fuel injector claims: no other resistance, unit, or test temperature for the injector";

function toNumber(text) {
  return Number(String(text).replace(",", "."));
}

function sameNumber(a, b) {
  return Math.abs(a - b) < 1e-9;
}

/** The resistances a line prints, as { low, high, unit } with high === low for a single figure. */
function resistancesIn(line) {
  return [...line.matchAll(RESISTANCE)].map((match) => {
    const low = toNumber(match[1]);
    return { low, high: match[2] === undefined ? low : toNumber(match[2]), unit: match[3].replace(/\s+/g, "") };
  });
}

function isOhms(unit) {
  return unit === "\u03A9" || unit === "\u2126" || /^ohms?$/i.test(unit);
}

function isInjectorRange(figure, expectation) {
  return sameNumber(figure.low, expectation.low) && sameNumber(figure.high, expectation.high);
}

function isTestTemperature(match, expectation) {
  const degrees = toNumber(match[1]);
  return match[2].toUpperCase() === "C"
    ? sameNumber(degrees, expectation.celsius)
    : sameNumber(degrees, expectation.fahrenheit);
}

function printsTestTemperature(line, expectation) {
  return [...line.matchAll(TEMPERATURE)].some((match) => isTestTemperature(match, expectation));
}

function givesRangeInOhms(line, expectation) {
  return resistancesIn(line).some((figure) => isOhms(figure.unit) && isInjectorRange(figure, expectation));
}

/** Why `line` contradicts the expectation, or "" when it does not. Only lines naming the injector are judged. */
function contradiction(line, expectation) {
  if (!INJECTOR.test(line)) {
    return "";
  }

  for (const figure of resistancesIn(line)) {
    if (isInjectorRange(figure, expectation) && !isOhms(figure.unit)) {
      return "the injector's range in a unit other than ohms";
    }
    if (!isInjectorRange(figure, expectation)) {
      return "another resistance beside the injector";
    }
  }

  for (const match of line.matchAll(TEMPERATURE)) {
    if (!isTestTemperature(match, expectation)) {
      return "a temperature other than the test temperature beside the injector";
    }
  }

  return "";
}

function evidenceProblem(result) {
  const evidence = result?.evidence;

  if (!evidence || typeof evidence !== "object") {
    return "the result carries no structured evidence (legacy path or a refusal)";
  }
  if (typeof result.answer !== "string") {
    return "the result has no answer text";
  }
  const { documentSupported, generalGuidance, gaps } = evidence;
  if (!Array.isArray(documentSupported) || !Array.isArray(generalGuidance) || !Array.isArray(gaps)) {
    return "the evidence is not three lists";
  }
  if (
    documentSupported.some((item) => !item || typeof item.claim !== "string") ||
    [...generalGuidance, ...gaps].some((line) => typeof line !== "string")
  ) {
    return "the evidence holds an entry that is not text";
  }
  return "";
}

/**
 * Build the check for the scorer's `resultChecks`. Returns one record per rule.
 *
 * @param {{ low: number, high: number, celsius: number, fahrenheit: number }} [expectation]
 * @returns {(result: any) => { name: string, pass: boolean, detail: string }[]}
 */
export function createFuelInjectorClaimsCheck(expectation = FUEL_INJECTOR_EXPECTATION) {
  return function checkFuelInjectorClaims(result) {
    const unreadable = evidenceProblem(result);
    if (unreadable) {
      return [
        { name: RENDERING, pass: false, detail: unreadable },
        { name: CREDIT, pass: false, detail: `not checked: ${unreadable}` },
        { name: CONTRADICTION, pass: false, detail: `not checked: ${unreadable}` },
      ];
    }

    const { documentSupported, generalGuidance, gaps } = result.evidence;
    const rendered = renderEvidenceAnswer({ documentSupported, generalGuidance, gaps });
    const renderedOk = rendered === result.answer;

    // Credit only from a claim whose own rendered line is in the answer the owner saw.
    const answerLines = new Set(result.answer.split("\n"));
    const credited = documentSupported
      .filter((item) =>
        answerLines.has(renderEvidenceAnswer({ documentSupported: [item], generalGuidance: [], gaps: [] }))
      )
      .map((item) => item.claim)
      .find(
        (claim) =>
          INJECTOR.test(claim) &&
          !OTHER_PART.test(claim) &&
          givesRangeInOhms(claim, expectation) &&
          printsTestTemperature(claim, expectation)
      );

    const problems = [documentSupported.map((item) => item.claim), generalGuidance, gaps]
      .flat()
      .flatMap((line) => {
        const why = contradiction(line, expectation);
        // A line that names the injector AND another part is judged as the injector's.
        return why ? [`${why}: "${line.slice(0, 100)}"`] : [];
      });

    return [
      {
        name: RENDERING,
        pass: renderedOk,
        detail: renderedOk
          ? `${documentSupported.length} verified claim(s)`
          : "the answer differs from the rendering of result.evidence",
      },
      {
        name: CREDIT,
        pass: credited !== undefined,
        detail: credited ?? "no rendered verified claim ties the injector to its range in ohms and the test temperature",
      },
      {
        name: CONTRADICTION,
        pass: problems.length === 0,
        detail: problems.length ? `${problems.length}: ${problems[0]}` : "none",
      },
    ];
  };
}

/** The check for the shipped case: the default expectation above (its range in ohms, its test temperature). */
export const checkFuelInjectorClaims = createFuelInjectorClaimsCheck();
