import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

// Same isolation as answerQualityScoring.test.js: the scorer imports modules that
// open the database at import time, so point them at a scratch directory first.
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-fix-helper-injector-claims-"));

process.env.DATABASE_FILE = path.join(tempRoot, "injector-claims.db");
process.env.UPLOADS_DIR = path.join(tempRoot, "uploads");

const { evaluateAnswerCase } = await import("../src/evals/answerQualityScoring.js");
const { answerQualityCases } = await import("../src/evals/answerQualityCases.js");
const { createFuelInjectorClaimsCheck, checkFuelInjectorClaims, FUEL_INJECTOR_EXPECTATION } = await import(
  "../src/evals/fuelInjectorClaims.js"
);
const { validateEvidencePayload, verifyEvidence, renderEvidenceAnswer, deriveEvidenceStatus } = await import(
  "../src/services/askEvidenceContract.js"
);
const { db } = await import("../src/database.js");

after(() => {
  if (typeof db.close === "function") {
    db.close();
  }

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

// ---- The material: ENTIRELY INVENTED. Nothing below comes from a manual. ----
//
// fixtures/invented-injector-chunks.json holds two made-up pages and made-up
// figures (7.7 to 8.3 ohms at 25°C), so the rule is proven by its structure --
// which part owns a figure, the unit, the test temperature -- and not by any
// real page. The scorer takes its expectation as a parameter for that reason.

const FIXTURE = JSON.parse(
  fs.readFileSync(new URL("./fixtures/invented-injector-chunks.json", import.meta.url), "utf8")
);
const CHUNKS = FIXTURE.chunks;
const check = createFuelInjectorClaimsCheck(FIXTURE.expectation);

const OHM = "Ω";
const DEG = "°";
const INJECTOR_ROW = `Fuel injector assembly coil resistance 7.7 to 8.3 ${OHM} at 25${DEG}C (77${DEG}F)`;
const PUMP_ROW = `Fuel pump motor coil resistance 1.4 to 2.6 ${OHM} at 25${DEG}C (77${DEG}F)`;
const SENDER_ROW = `Fuel level sender track resistance 21.5 to 24.5 ${OHM} with the float high`;
const HARNESS_SENTENCE = `the wire between pin 4 and the controller should read below 2 ${OHM}`;

const CORRECT = `The fuel injector assembly coil resistance is 7.7 to 8.3 ${OHM} at 25${DEG}C (77${DEG}F).`;

/** One claim as a model reply: [claim, sourceId, evidenceQuote]. */
const injectorClaim = [CORRECT, "S1", INJECTOR_ROW];

/**
 * An Ask result built the way the server builds one under the evidence contract:
 * the model's reply through the REAL validator and verifier, the answer rendered
 * by the real renderer. Returns the verifier's rejections too, so a test can pin
 * what the CURRENT verifier does with each wrong answer.
 */
function ask(claims, { generalGuidance = [], gaps = [] } = {}) {
  const validated = validateEvidencePayload({
    documentSupported: claims.map(([claim, sourceId, evidenceQuote]) => ({ claim, sourceId, evidenceQuote })),
    generalGuidance,
    gaps,
  });
  assert.ok(validated.ok, validated.reason);

  const verified = verifyEvidence(validated.value, CHUNKS);
  const evidence = {
    documentSupported: verified.documentSupported,
    generalGuidance: verified.generalGuidance,
    gaps: verified.gaps,
  };

  return {
    rejected: verified.rejected.map((entry) => (entry.detail ? `${entry.reason}/${entry.detail}` : entry.reason)),
    result: {
      status: deriveEvidenceStatus(evidence),
      answer: renderEvidenceAnswer(evidence),
      citations: verified.documentSupported.map(({ documentTitle, pageNumber }) => ({ documentTitle, pageNumber })),
      evidence,
    },
  };
}

const names = {
  rendered: "fuel injector claims: the answer is exactly its verified evidence, rendered",
  credit: "fuel injector claims: one verified claim names the injector, its range in ohms, and the test temperature",
  contradiction: "fuel injector claims: no other resistance, unit, or test temperature for the injector",
};

/** The names of the records that fail, in order. */
function failing(result, run = check) {
  return run(result)
    .filter((record) => !record.pass)
    .map((record) => record.name);
}

// ---- Fixture honesty ----

test("the fixture is invented: its own notice says so, and it has no corpus markers", () => {
  const text = JSON.stringify(FIXTURE);

  assert.match(FIXTURE.about, /INVENTED/);
  assert.ok(!/alldata|toyota|corolla|2ZR|fileMd5/i.test(text), "the fixture must not carry corpus markers");
  assert.ok(CHUNKS.every((chunk) => chunk.documentId >= 9000), "invented documents use ids no real import produces");
});

// ---- Correct, complete answers ----

test("a correct, complete answer passes, and so does one with the other parts attributed to themselves", () => {
  const { rejected, result } = ask([injectorClaim]);
  assert.deepEqual(rejected, []);
  assert.deepEqual(failing(result), []);

  const withOthers = ask([
    injectorClaim,
    [`The fuel pump motor coil resistance is 1.4 to 2.6 ${OHM} at 25${DEG}C (77${DEG}F).`, "S1", PUMP_ROW],
    [`The fuel level sender track resistance is 21.5 to 24.5 ${OHM} with the float high.`, "S1", SENDER_ROW],
  ]);
  assert.deepEqual(withOthers.rejected, []);
  assert.deepEqual(failing(withOthers.result), []);
});

test("the temperature may be stated in Fahrenheit alone, and the unit may be spelled out", () => {
  for (const claim of [
    `The fuel injector assembly coil resistance is 7.7 to 8.3 ohms at 77${DEG}F.`,
    `The fuel injector coil resistance is 7.7 to 8.3 ${OHM} at 25${DEG}C.`,
  ]) {
    const { result } = ask([[claim, "S1", INJECTOR_ROW]]);
    // The verifier may or may not accept the reworded claim; what matters here is
    // that the scorer accepts whatever the verifier accepted.
    if (result.evidence.documentSupported.length) {
      assert.deepEqual(failing(result), [], claim);
    }
  }
});

// ---- Incorrect values, missing units: the verifier now stops these before the eval sees them ----

test("a wrong value, a wrong temperature, a dropped unit, and kilo-ohms are all REJECTED by the verifier, so no claim earns credit", () => {
  for (const [claim, reason] of [
    [`The fuel injector assembly coil resistance is 7.9 to 8.5 ${OHM} at 25${DEG}C (77${DEG}F).`, "numeric_anomaly"],
    [`The fuel injector assembly coil resistance is 7.7 to 8.3 ${OHM} at 20${DEG}C (68${DEG}F).`, "numeric_anomaly"],
    [`The fuel injector assembly coil resistance is 7.7 to 8.3 at 25${DEG}C (77${DEG}F).`, "unrecognized_figure/unit_missing"],
    [`The fuel injector assembly coil resistance is 7.7 to 8.3 k${OHM} at 25${DEG}C (77${DEG}F).`, "numeric_anomaly"],
  ]) {
    const { rejected, result } = ask([[claim, "S1", INJECTOR_ROW]]);

    assert.deepEqual(rejected, [reason], claim);
    assert.deepEqual(result.evidence.documentSupported, [], "a rejected claim is never a verified claim");
    assert.ok(failing(result).includes(names.credit), `no credit for: ${claim}`);
  }
});

// ---- Incorrect components ----

test("another part's figures given to the injector are REJECTED by the verifier, whatever quote supports them", () => {
  const pumpFigures = `The fuel injector assembly coil resistance is 1.4 to 2.6 ${OHM} at 25${DEG}C (77${DEG}F).`;

  for (const [quote, reason] of [
    [INJECTOR_ROW, "numeric_anomaly"],
    [PUMP_ROW, "subject_mismatch"],
    [`${INJECTOR_ROW}. ${PUMP_ROW}`, "row_mismatch/subject_not_in_row"],
  ]) {
    const { rejected, result } = ask([[pumpFigures, "S1", quote]]);

    assert.deepEqual(rejected, [reason], quote);
    assert.ok(failing(result).includes(names.credit));
  }

  const sender = ask([[`The fuel injector assembly track resistance is 21.5 to 24.5 ${OHM}.`, "S1", SENDER_ROW]]);
  assert.deepEqual(sender.rejected, ["subject_mismatch"]);
  assert.ok(failing(sender.result).includes(names.credit));
});

test("a rejected claim does not turn into credit through the gap it leaves behind", () => {
  const { result } = ask([[`The fuel injector assembly coil resistance is 7.9 to 8.5 ${OHM} at 25${DEG}C (77${DEG}F).`, "S1", INJECTOR_ROW]]);

  assert.equal(result.evidence.gaps.length, 1);
  assert.deepEqual(failing(result), [names.credit]);
});

// ---- What the verifier ACCEPTS and only the eval can catch ----

test("a missing temperature condition is ACCEPTED by the verifier and FAILS the eval on credit", () => {
  const { rejected, result } = ask([[`The fuel injector assembly coil resistance is 7.7 to 8.3 ${OHM}.`, "S1", INJECTOR_ROW]]);

  assert.deepEqual(rejected, [], "the verifier proves the claim is printed, not that it is complete");
  assert.deepEqual(failing(result), [names.credit]);
});

test("the test temperature stated in another claim does not complete a range stated without it", () => {
  const { rejected, result } = ask([
    [`The fuel injector assembly coil resistance is 7.7 to 8.3 ${OHM}.`, "S1", INJECTOR_ROW],
    [`The fuel pump motor coil resistance is 1.4 to 2.6 ${OHM} at 25${DEG}C (77${DEG}F).`, "S1", PUMP_ROW],
  ]);

  assert.deepEqual(rejected, []);
  assert.deepEqual(failing(result), [names.credit]);
});

test("a claim naming the injector and another part earns no credit (ask for atomic claims)", () => {
  const { result } = ask([
    [
      `The fuel injector assembly is 7.7 to 8.3 ${OHM} and the fuel pump motor is 1.4 to 2.6 ${OHM} at 25${DEG}C (77${DEG}F).`,
      "S1",
      `${INJECTOR_ROW}. ${PUMP_ROW}`,
    ],
  ]);

  // Whether or not the verifier accepts the combined claim, the eval does not credit it.
  assert.ok(failing(result).includes(names.credit));
});

test("a verified claim that gives the injector's range but also names another part earns no credit", () => {
  // Built by hand: it isolates the scorer's own rule from whatever the verifier decides.
  const body = {
    documentSupported: [
      {
        claim: `The fuel injector assembly coil resistance is 7.7 to 8.3 ${OHM} at 25${DEG}C (77${DEG}F), like the pump.`,
        documentTitle: "Invented Workshop Sheet A",
        pageNumber: 1,
      },
    ],
    generalGuidance: [],
    gaps: [],
  };
  const result = { status: "answered", answer: renderEvidenceAnswer(body), citations: [], evidence: body };

  assert.deepEqual(failing(result), [names.credit]);
});

test("a harness figure attributed to the injector is ACCEPTED by the verifier and FAILS the eval as a contradiction", () => {
  const { rejected, result } = ask([
    injectorClaim,
    [`The fuel injector assembly wire should read below 2 ${OHM}.`, "S2", HARNESS_SENTENCE],
  ]);

  assert.deepEqual(rejected, []);
  assert.deepEqual(failing(result), [names.contradiction]);
});

test("a harness check that does not name the injector is not judged", () => {
  const { rejected, result } = ask([
    injectorClaim,
    [`The wire between pin 4 and the controller should read below 2 ${OHM}.`, "S2", HARNESS_SENTENCE],
  ]);

  assert.deepEqual(rejected, []);
  assert.deepEqual(failing(result), []);
});

// ---- Guidance and gaps are rendered too, so they are judged too ----

/** The result with these sections added by hand, bypassing the verifier (defense in depth). */
function withSections(result, { generalGuidance = [], gaps = [] }) {
  const evidence = { ...result.evidence, generalGuidance, gaps };
  return { ...result, answer: renderEvidenceAnswer(evidence), evidence };
}

test("the current verifier already moves a guidance line carrying a resistance out of general guidance", () => {
  const { result } = ask([injectorClaim], { generalGuidance: ["Many fuel injectors read about 16 ohms."] });

  assert.deepEqual(result.evidence.generalGuidance, []);
  assert.deepEqual(failing(result), []);
});

test("if such a line ever reached the evidence, general guidance and gaps that give the injector another resistance or temperature FAIL", () => {
  const { result } = ask([injectorClaim]);

  for (const sections of [
    { generalGuidance: ["Many fuel injectors read about 16 ohms."] },
    { generalGuidance: ["A fuel injector reads 3 ohms when cold."] },
    { gaps: [`The manual does not say whether the fuel injector reads 8 ${OHM} at 80${DEG}C.`] },
  ]) {
    assert.deepEqual(failing(withSections(result, sections)), [names.contradiction], JSON.stringify(sections));
  }

  const clean = withSections(result, { generalGuidance: ["Let the engine cool before removing a fuel injector."] });
  assert.deepEqual(failing(clean), []);
});

// ---- Fail closed ----

test("without readable evidence, every record fails, even when the text reads right", () => {
  const { result } = ask([injectorClaim]);
  const { evidence, ...withoutEvidence } = result;
  assert.ok(evidence);

  for (const broken of [
    withoutEvidence,
    { ...withoutEvidence, evidence: null },
    { ...withoutEvidence, evidence: {} },
    { ...result, evidence: { ...evidence, gaps: "none" } },
    { ...result, evidence: { ...evidence, documentSupported: [{ claim: 7 }] } },
    { ...result, answer: undefined },
    null,
  ]) {
    assert.deepEqual(failing(broken), [names.rendered, names.credit, names.contradiction]);
  }
});

test("an answer that is not exactly the rendering of its evidence FAILS the rendering record", () => {
  const { result } = ask([injectorClaim]);

  assert.deepEqual(failing({ ...result, answer: `${result.answer}\nAlso, the fuel injector is 3 ${OHM}.` }), [names.rendered]);
  assert.deepEqual(failing({ ...result, answer: "" }), [names.rendered, names.credit]);
});

// ---- The shipped case ----

const shippedCase = answerQualityCases.find((entry) => entry.id === "fuel-injector-resistance");

test("the shipped case carries the structured check, keeps its regex rules, and stays a template", () => {
  assert.deepEqual(shippedCase.resultChecks, [checkFuelInjectorClaims]);
  assert.equal(shippedCase.verified, false);
  assert.equal(shippedCase.qualifiedValues.length, 3);
  assert.deepEqual(FUEL_INJECTOR_EXPECTATION, { low: 11.6, high: 12.4, celsius: 20, fahrenheit: 68 });
});

test("the shipped check, with the real expectation, passes a complete answer and fails an incomplete one", () => {
  const evidence = (claim) => {
    const body = { documentSupported: [{ claim, documentTitle: "Invented Workshop Sheet A", pageNumber: 1 }], generalGuidance: [], gaps: [] };
    return { status: "answered", answer: renderEvidenceAnswer(body), citations: [], evidence: body };
  };

  assert.deepEqual(
    failing(evidence(`The fuel injector assembly standard resistance is 11.6 to 12.4 ${OHM} at 20${DEG}C (68${DEG}F).`), checkFuelInjectorClaims),
    []
  );
  assert.deepEqual(
    failing(evidence(`The fuel injector assembly standard resistance is 11.6 to 12.4 ${OHM}.`), checkFuelInjectorClaims),
    [names.credit]
  );
  assert.deepEqual(
    failing(evidence(`The fuel injector assembly standard resistance is 11.6 to 12.4 k${OHM} at 20${DEG}C (68${DEG}F).`), checkFuelInjectorClaims),
    [names.credit, names.contradiction]
  );
});

// ---- The scorer hook (resultChecks) ----

function scoredWith(resultChecks, result = ask([injectorClaim]).result, overrides = {}) {
  return evaluateAnswerCase(
    { id: "hook", category: "capacity", expect: "answered", mustCite: false, verified: false, resultChecks, ...overrides },
    result
  );
}

test("scorer: resultChecks become ordinary checks, and the case passes only when they all pass", () => {
  const scored = scoredWith([check]);

  assert.equal(scored.pass, true, scored.checks.filter((entry) => !entry.pass).map((entry) => entry.name).join("; "));
  assert.equal(scored.checks.filter((entry) => entry.name.includes("fuel injector claims")).length, 3);

  const incomplete = scoredWith([check], ask([[`The fuel injector assembly coil resistance is 7.7 to 8.3 ${OHM}.`, "S1", INJECTOR_ROW]]).result);
  assert.equal(incomplete.pass, false);
});

test("scorer: a check that throws, returns a promise or junk, repeats a name, or is not deterministic FAILS, never passes silently", () => {
  let flip = 0;
  const cases = [
    [() => { throw new Error("boom"); }, /threw: boom/],
    [async () => [{ name: "a", pass: true }], /promise/],
    [() => "yes", /not a list/],
    [() => [], /no check records/],
    [() => [{ name: "a", pass: "true" }], /pass that is not true or false/],
    [() => [{ name: "a", pass: true }, { name: "a", pass: true }], /repeats the name/],
    [() => [{ name: "a", pass: true, extra: 1 }], /unknown field/],
    [() => [{ name: "a", pass: flip++ % 2 === 0 }], /different records/],
    ["not a function", /is not a function/],
  ];

  for (const [bad, pattern] of cases) {
    const scored = scoredWith([bad]);
    const failed = scored.checks.filter((entry) => !entry.pass);

    assert.equal(scored.pass, false);
    assert.ok(failed.some((entry) => pattern.test(entry.detail)), `${pattern}: ${JSON.stringify(failed)}`);
  }
});

test("scorer: a check cannot change the result the rest of the scorer reads", () => {
  const result = ask([injectorClaim]).result;
  const before = JSON.stringify(result);
  const scored = scoredWith([(seen) => { seen.answer = "tampered"; return [{ name: "t", pass: true }]; }], result);

  assert.equal(scored.pass, false);
  assert.equal(JSON.stringify(result), before);
});

test("scorer: resultChecks on a refused or rejected case are reported, not silently skipped", () => {
  for (const expect of ["refused", "rejected"]) {
    const scored = scoredWith([check], ask([injectorClaim]).result, { expect, expectedStatus: "not_found" });

    assert.ok(scored.checks.some((entry) => entry.name === "resultChecks are only scored on answered cases" && !entry.pass), expect);
  }
});

test("scorer: a case without resultChecks scores exactly as before", () => {
  const scored = scoredWith(undefined);

  assert.ok(!scored.checks.some((entry) => /result check/.test(entry.name)));
});
