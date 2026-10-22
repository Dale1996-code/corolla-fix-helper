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
  // Near-misses for the 1A-19 rules below.
  "replace the USB hub",
  "replace the hub caps",
  "check the tire pressure",
  "inspect the tire tread depth",
  "replace the intake resonator",
  "adjust the exhaust valve clearance",
  "reorder the exhausted touch-up paint",
  "crimp the ground lug",
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

// ---- Wheel, tire, axle, hub, and exhaust jobs (audit 1A-19) ----
//
// None of these matched any rule, so the planner could rate them Ready with no
// warning. Each is done with the car lifted, a wheel off, or the exhaust hot,
// and lug nuts and studs are all that hold a wheel on. The rule sets are exact
// so a job cannot quietly gain or lose a warning: torquing lug nuts happens
// with the car on the ground, so it carries no lifting warning.

/** @type {Array<[string, string[]]>} */
const WHEEL_AND_EXHAUST_JOBS = [
  ["Rotate the tires", ["lifting", "wheel-retention"]],
  ["Tire rotation", ["lifting", "wheel-retention"]],
  ["Put on the spare tire", ["lifting", "wheel-retention"]],
  ["Replace the front tires", ["lifting", "wheel-retention"]],
  ["Torque the lug nuts", ["wheel-retention"]],
  ["Replace the lug studs", ["wheel-retention"]],
  ["Replace the CV axle", ["lifting"]],
  ["Replace the CV-axle boot", ["lifting"]],
  ["Remove the front drive shaft", ["lifting"]],
  ["Replace the hub bearing", ["lifting"]],
  ["Replace the rear hub assembly", ["lifting"]],
  ["Replace the exhaust muffler", ["exhaust"]],
  ["Fix the exhaust leak", ["exhaust"]],
  ["Replace the catalytic converter", ["exhaust"]],
  ["Replace the exhaust manifold gasket", ["exhaust"]],
];

for (const [phrase, expectedRuleIds] of WHEEL_AND_EXHAUST_JOBS) {
  test(`critical: "${phrase}" matches ${expectedRuleIds.join(" + ")}`, () => {
    assert.deepEqual(matchedSafetyRuleIds(phrase), expectedRuleIds);
    assert.equal(isSafetyCriticalTask({ title: phrase }), true, `"${phrase}" should block Ready`);
  });
}

test("the wheel-retention and exhaust warnings name their own hazard", () => {
  assert.ok(detectSafetyFlags("Torque the lug nuts").some((flag) => /lug nuts/i.test(flag)));
  assert.ok(
    detectSafetyFlags("Replace the exhaust muffler").some((flag) => /carbon monoxide/.test(flag))
  );
});

test("near-misses are not read as road-wheel, hub, or exhaust work", () => {
  // Rule ids rather than the whole verdict: removing a steering wheel is
  // airbag work, which the SRS rule catches (below), so pinning it as "not
  // critical" would be wrong. What must hold is that it is never mistaken for
  // taking a ROAD wheel off.
  /** @type {Array<[string, string[]]>} */
  const nearMisses = [
    ["remove the steering wheel", ["lifting", "wheel-retention"]],
    ["steering wheel removal", ["lifting", "wheel-retention"]],
    ["tighten the steering wheel nut", ["lifting", "wheel-retention"]],
    ["the steering wheel hub nut", ["lifting", "wheel-retention"]],
    // The hyphenated spelling once slipped past every one of these guards, and
    // past the steering rule's too.
    ["remove the steering-wheel", ["lifting", "wheel-retention", "steering"]],
    ["tighten the steering-wheel nut", ["lifting", "wheel-retention", "steering"]],
    ["the steering-wheel hub nut", ["lifting", "wheel-retention", "steering"]],
    ["replace the steering-wheel audio switch", ["lifting", "wheel-retention", "steering"]],
    ["replace the battery terminal lug", ["wheel-retention"]],
    ["replace the exhaust camshaft", ["exhaust"]],
    ["inspect the intake and exhaust valves", ["exhaust"]],
    ["the battery is exhausted", ["exhaust"]],
  ];

  for (const [phrase, forbidden] of nearMisses) {
    const ids = matchedSafetyRuleIds(phrase);

    for (const ruleId of forbidden) {
      assert.ok(!ids.includes(ruleId), `"${phrase}" matched ${ruleId}: ${JSON.stringify(ids)}`);
    }
  }
});

// ---- Steering-wheel removal and oxygen sensors ----
//
// Taking the steering wheel off means taking the driver airbag off first, yet
// it matched no rule: the SRS rule needed the word "airbag". An oxygen or A/F
// sensor screws into the exhaust manifold or pipe, so replacing one is hot
// exhaust work, and the downstream sensor is reached from under the car.

/** @type {Array<[string, string[]]>} */
const AIRBAG_AND_EXHAUST_SENSOR_JOBS = [
  ["Remove the steering wheel", ["srs"]],
  ["Steering wheel removal", ["srs"]],
  ["Replace the steering wheel", ["srs"]],
  ["Install the steering-wheel assembly", ["srs"]],
  ["Take the steering wheel off", ["srs"]],
  ["Replace the oxygen sensor", ["exhaust"]],
  ["Replace the downstream O2 sensor", ["exhaust"]],
  ["Replace the bank 1 sensor 2 heated oxygen sensor", ["exhaust"]],
  ["Replace the A/F sensor", ["exhaust"]],
  ["Oxygen sensor replacement", ["exhaust"]],
];

for (const [phrase, expectedRuleIds] of AIRBAG_AND_EXHAUST_SENSOR_JOBS) {
  test(`critical: "${phrase}" matches ${expectedRuleIds.join(" + ")}`, () => {
    assert.deepEqual(matchedSafetyRuleIds(phrase), expectedRuleIds);
    assert.equal(isSafetyCriticalTask({ title: phrase }), true, `"${phrase}" should block Ready`);
  });
}

test("an air-fuel ratio sensor job is exhaust work too", () => {
  // Only the exhaust rule is asserted: the word "fuel" also matches the fuel
  // rule, which is a separate, older over-match this change does not touch.
  assert.ok(matchedSafetyRuleIds("Remove the upstream air-fuel ratio sensor").includes("exhaust"));
});

test("near-misses are not read as airbag or exhaust-sensor work", () => {
  // Rule ids rather than the whole verdict, as for the wheel near-misses above:
  // what must hold is that a part ON the wheel, a steering complaint, or work
  // on a sensor's signal or fuse is not taken for removing the airbag or
  // unscrewing a sensor from a hot pipe.
  /** @type {Array<[string, string[]]>} */
  const nearMisses = [
    ["replace the steering wheel audio switch", ["srs"]],
    ["replace the steering wheel cover", ["srs"]],
    ["the car pulls the steering wheel to the right", ["srs"]],
    ["steering wheel is off center after the alignment", ["srs"]],
    ["check the O2 sensor voltage", ["exhaust"]],
    ["diagnose the A/F sensor heater circuit", ["exhaust"]],
    ["replace the O2 sensor fuse", ["exhaust"]],
    ["read the oxygen sensor data", ["exhaust"]],
  ];

  for (const [phrase, forbidden] of nearMisses) {
    const ids = matchedSafetyRuleIds(phrase);

    for (const ruleId of forbidden) {
      assert.ok(!ids.includes(ruleId), `"${phrase}" matched ${ruleId}: ${JSON.stringify(ids)}`);
    }
  }
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

// ---- Brake friction parts named without the word "brake" ----
//
// "brake pads" always matched; a bare "front pads" or "swap the pads" did not,
// so a real brake job scored Ready with no safety flag. The fix cannot be a
// global \bpads?\b -- that re-creates the substring problem that once made
// "shock ABSorber" a brake job, this time via seat, pedal, and polishing pads.

test("brake friction parts are recognized without the word brake", () => {
  const brakeWork = [
    "front pads",
    "rear shoes",
    "replace the pads",
    "swap the pads",
    "swap out the worn pads",
    "pads on the drum",
  ];

  for (const task of brakeWork) {
    assert.ok(
      matchedSafetyRuleIds(task).includes("brakes"),
      `expected "${task}" to be recognized as brake work`
    );
    assert.equal(
      isSafetyCriticalTask({ title: task }),
      true,
      `expected "${task}" to block Ready`
    );
  }
});

test("phrasings that already worked keep working", () => {
  for (const task of ["brake pads", "rear brake shoes", "pads and rotor", "caliper and pads"]) {
    assert.ok(matchedSafetyRuleIds(task).includes("brakes"), `regression: "${task}"`);
  }
});

test("unrelated pads are not filed as brake work", () => {
  for (const task of [
    "seat pads",
    "pedal pads",
    "polishing pads",
    "front seat pads",
    "replace the polishing pads",
    "replace the front seat pads",
  ]) {
    assert.ok(
      !matchedSafetyRuleIds(task).includes("brakes"),
      `expected "${task}" NOT to be filed as brake work`
    );
  }
});

test("jack pads are a lifting hazard, not a brake job", () => {
  const ruleIds = matchedSafetyRuleIds("jack pads");

  assert.ok(!ruleIds.includes("brakes"), "jack pads must not match the brakes rule");
  // It IS safety-critical -- jacking a car is genuinely dangerous -- just for a
  // different hazard. Asserting `isSafetyCriticalTask === false` here would be
  // wrong, and "fixing" that assertion would mean weakening lifting detection.
  assert.ok(ruleIds.includes("lifting"), "jack pads must still raise the lifting hazard");
  assert.equal(isSafetyCriticalTask({ title: "jack pads" }), true);
});
