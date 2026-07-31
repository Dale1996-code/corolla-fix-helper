import assert from "node:assert/strict";
import test from "node:test";

// Pure classification: no database, no network. Safe to import directly.
import {
  detectSafetyFlags,
  isSafetyCriticalTask,
  matchedSafetyRuleIds,
  SAFETY_RULES,
} from "../src/services/safetyClassifier.js";

// ---- Structural invariants: the two halves cannot disagree ----

test("every rule that blocks readiness also produces a warning", () => {
  for (const rule of SAFETY_RULES) {
    if (!rule.blocksReadiness) {
      continue;
    }

    assert.ok(rule.flag && rule.flag.trim(), `rule "${rule.id}" blocks Ready with no warning`);
  }
});

test("every blocking warning explains why readiness is blocked", () => {
  for (const rule of SAFETY_RULES) {
    if (!rule.blocksReadiness) {
      continue;
    }

    assert.match(
      rule.flag,
      /cannot be marked Ready/,
      `rule "${rule.id}" blocks Ready without telling the owner why`
    );
  }
});

test("anything classified safety-critical always yields at least one flag", () => {
  // Structural now that both read one table, but pinned so a future refactor
  // cannot reintroduce the split that let "airbag" and "shock" block silently.
  for (const rule of SAFETY_RULES) {
    const probe = `${rule.id} work`;
    if (!isSafetyCriticalTask({ title: probe })) {
      continue;
    }

    assert.ok(detectSafetyFlags(probe).length > 0, `"${probe}" blocked Ready with no warning`);
  }
});

test("rule ids are unique", () => {
  const ids = SAFETY_RULES.map((rule) => rule.id);
  assert.equal(new Set(ids).size, ids.length);
});

// ---- Phrase matrix: expected CRITICAL / blocking ----

const EXPECTED_CRITICAL = [
  ["replace water pump", "cooling"],
  ["diagnose overheating engine", "cooling"],
  ["airbag module", "srs"],
  ["air bag module", "srs"],
  ["seat-belt pretensioner", "srs"],
  ["tie rod end", "steering"],
  ["steering rack", "steering"],
  ["ball joint", "steering"],
  ["coil spring", "spring"],
  ["jacking or supporting the vehicle", "lifting"],
  ["fuel-line work", "fuel"],
  ["electrical shock hazard", "electrical"],
];

for (const [phrase, expectedRuleId] of EXPECTED_CRITICAL) {
  test(`critical: "${phrase}" blocks Ready via the ${expectedRuleId} rule`, () => {
    assert.equal(isSafetyCriticalTask({ title: phrase }), true, `"${phrase}" should block Ready`);
    assert.ok(detectSafetyFlags(phrase).length > 0, `"${phrase}" produced no warning`);
    assert.ok(
      matchedSafetyRuleIds(phrase).includes(expectedRuleId),
      `"${phrase}" matched ${JSON.stringify(matchedSafetyRuleIds(phrase))}, expected ${expectedRuleId}`
    );
  });
}

// ---- Phrase matrix: expected NON-critical (false-positive guards) ----

const EXPECTED_NOT_CRITICAL = [
  "steering wheel audio switch",
  "radiator support panel",
  "valve lift",
  "spring-loaded clip",
  "replace the cabin air filter",
  "clean the interior trim",
];

for (const phrase of EXPECTED_NOT_CRITICAL) {
  test(`not critical: "${phrase}"`, () => {
    assert.equal(
      isSafetyCriticalTask({ title: phrase }),
      false,
      `"${phrase}" should NOT block Ready, matched ${JSON.stringify(matchedSafetyRuleIds(phrase))}`
    );
    assert.deepEqual(detectSafetyFlags(phrase), []);
  });
}

// ---- Documented policy: suspension work IS critical, with the right warning ----

test("shock absorber replacement is critical by policy, with a SUSPENSION warning", () => {
  // Documented product decision: ordinary suspension work blocks Ready because a
  // mis-torqued joint fails at speed. The important part is that it gets the
  // suspension warning and NOT the electrical-shock one.
  const phrase = "shock absorber replacement";

  assert.equal(isSafetyCriticalTask({ title: phrase }), true);
  assert.deepEqual(matchedSafetyRuleIds(phrase), ["suspension"]);

  const flags = detectSafetyFlags(phrase);
  assert.ok(flags.some((flag) => /Suspension components carry/.test(flag)));
  assert.ok(
    !flags.some((flag) => /Disconnect the battery/.test(flag)),
    "a suspension shock must not raise the electrical-shock warning"
  );
});

test("electrical shock and suspension shocks are told apart", () => {
  assert.deepEqual(matchedSafetyRuleIds("electrical shock hazard"), ["electrical"]);
  assert.deepEqual(matchedSafetyRuleIds("replace the rear shocks"), ["suspension"]);
});

// ---- Regressions from the old substring matcher ----

test('"shock absorber" no longer raises a BRAKE warning', () => {
  // The old rule tested the bare substring "abs", which matched "shock
  // ABSorber" and produced a brake-bleeding warning for suspension work.
  assert.ok(!matchedSafetyRuleIds("shock absorber replacement").includes("brakes"));
  // ...while genuine ABS work still matches.
  assert.ok(matchedSafetyRuleIds("abs sensor fault").includes("brakes"));
});

test("the five original warning topics still fire on their original phrases", () => {
  const expectations = [
    ["Replace front brake pads", "brakes"],
    ["Replace the fuel injector", "fuel"],
    ["Replace the alternator", "electrical"],
    ["Replace a control arm", "suspension"],
    ["Flush the radiator", "cooling"],
  ];

  for (const [phrase, ruleId] of expectations) {
    assert.ok(
      matchedSafetyRuleIds(phrase).includes(ruleId),
      `"${phrase}" lost its ${ruleId} classification`
    );
  }
});

// ---- Gaps closed by unification ----

test("cooling work now blocks Ready, matching its own scalding warning", () => {
  for (const title of ["Drain and refill the coolant", "Replace the thermostat"]) {
    assert.ok(detectSafetyFlags(title).length > 0, `no flag for: ${title}`);
    assert.equal(isSafetyCriticalTask({ title }), true, `not critical: ${title}`);
  }
});

test("a clock spring is SRS, not a compressed suspension spring", () => {
  const ids = matchedSafetyRuleIds("replace the airbag clock spring");

  assert.ok(ids.includes("srs"));
  assert.ok(!ids.includes("spring"), "a clockspring is not a compressed coil spring");
});

test("a ball joint raises both the steering and lifting hazards", () => {
  const flags = detectSafetyFlags("replace the front lower ball joint and support the vehicle");

  assert.ok(flags.some((flag) => /Steering components/.test(flag)));
  assert.ok(flags.some((flag) => /jack stands/.test(flag)));
});

// ---- Input handling ----

test("detectSafetyFlags tolerates non-string input", () => {
  assert.deepEqual(detectSafetyFlags(/** @type {any} */ (null)), []);
  assert.deepEqual(detectSafetyFlags(/** @type {any} */ (undefined)), []);
});

test("isSafetyCriticalTask reads the system field as well as the title", () => {
  assert.equal(isSafetyCriticalTask({ title: "Inspect it", system: "Brakes" }), true);
  assert.equal(isSafetyCriticalTask({ title: "Inspect it", system: "HVAC" }), false);
  assert.equal(isSafetyCriticalTask(null), false);
});

test("flag order is deterministic and follows the rule table", () => {
  const flags = detectSafetyFlags("brake and airbag and coolant work");
  const ruleOrder = SAFETY_RULES.map((rule) => rule.flag);
  const sorted = [...flags].sort((a, b) => ruleOrder.indexOf(a) - ruleOrder.indexOf(b));

  assert.deepEqual(flags, sorted);
});
