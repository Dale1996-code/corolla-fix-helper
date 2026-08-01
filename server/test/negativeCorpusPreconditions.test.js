import assert from "node:assert/strict";
import test from "node:test";

// Pure logic, exercised against a fake database. The real check runs only in the
// live eval (scripts/evalAnswers.js) because it reads the mutable local corpus;
// these tests pin the DETECTION RULES with no database and no network.
import {
  checkTurboRefusalPrecondition,
  NEGATIVE_CASE_PRECONDITIONS,
} from "../src/evals/negativeCorpusPreconditions.js";

/** Minimal stand-in for the node:sqlite handle the checker uses. */
function fakeDb(rows) {
  return {
    prepare: () => ({
      all: () => rows.map((row, index) => ({ page_number: index + 1, ...row })),
    }),
  };
}

const row = (chunk_text, title = "Some Manual") => ({ chunk_text, title });

test("the known distractor classes do NOT trigger re-verification", () => {
  // These are exactly what the real corpus contains, confirmed during
  // verification. A false alarm here would make the check noise, and noise gets
  // ignored -- which would defeat the purpose.
  const { stale, matches } = checkTurboRefusalPrecondition(
    fakeDb([
      row("TC Turbocharger TCC Torque Converter Clutch TCM Transmission Control Module"),
      row("BACS Boost Altitude Compensation System BAT Battery BDC Bottom Dead Center"),
      row("Start the engine and check the brake booster function before driving."),
      row("CAC Charge Air Cooler Intercooler CARB Carburetor CFI Continuous Fuel Injection"),
      row("SC Supercharger SCB Supercharger Bypass E-ABV SFI Sequential Multiport Fuel Injection"),
    ])
  );

  assert.equal(stale, false, `unexpected matches: ${JSON.stringify(matches)}`);
});

test("a real boost-pressure specification triggers re-verification", () => {
  const { stale, matches } = checkTurboRefusalPrecondition(
    fakeDb([row("Standard boost pressure: 85 kPa at 3000 rpm.", "Turbo Engine Supplement")])
  );

  assert.equal(stale, true);
  assert.equal(matches[0].documentTitle, "Turbo Engine Supplement");
  assert.match(matches[0].excerpt, /boost pressure/i);
});

test("a wastegate reference triggers re-verification", () => {
  const { stale } = checkTurboRefusalPrecondition(
    fakeDb([row("Inspect the turbo wastegate actuator rod for free movement.")])
  );

  assert.equal(stale, true);
});

test("a turbo term next to a pressure figure triggers re-verification", () => {
  for (const text of [
    "Turbocharger outlet should read 120 kPa under load.",
    "Measured 14.5 psi at the turbo inlet during the road test.",
    "Maximum boost 1.2 bar.",
  ]) {
    const { stale } = checkTurboRefusalPrecondition(fakeDb([row(text)]));
    assert.equal(stale, true, `expected drift detection for: ${text}`);
  }
});

test("a pressure figure with no forced-induction context does not trigger", () => {
  // The corpus is full of unrelated pressures (fuel, tires, brakes).
  const { stale, matches } = checkTurboRefusalPrecondition(
    fakeDb([
      row("Fuel pressure should be 304 to 343 kPa with the engine idling."),
      row("Inflate the tires to 32 psi cold."),
    ])
  );

  assert.equal(stale, false, `unexpected matches: ${JSON.stringify(matches)}`);
});

test("an empty corpus is not stale", () => {
  assert.equal(checkTurboRefusalPrecondition(fakeDb([])).stale, false);
});

test("the turbo refusal case is registered as having a precondition", () => {
  // If the case is verified but nothing guards its premise, corpus drift would
  // go unnoticed.
  assert.equal(
    typeof NEGATIVE_CASE_PRECONDITIONS["refuse-turbo-boost-pressure"],
    "function"
  );
});
