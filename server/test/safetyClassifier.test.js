import assert from "node:assert/strict";
import test from "node:test";

// Pure classification: no database, no network. Safe to import directly.
import {
  detectSafetyFlags,
  isSafetyCriticalTask,
  SAFETY_CRITICAL_KEYWORDS,
  SAFETY_FLAG_RULES,
} from "../src/services/safetyClassifier.js";

// ---- Behavior preserved from the original repairTools.js implementation ----

test("the five original rules still produce their original flag text", () => {
  const expectations = [
    ["Replace front brake pads", "Brake work affects stopping safety. Bleed and test before driving."],
    ["Replace the fuel injector", "Fuel system work is a fire hazard. Relieve pressure and avoid sparks."],
    ["Replace the alternator", "Disconnect the battery before electrical work."],
    ["Replace a control arm", "Use jack stands. Never work under a vehicle held only by a jack."],
    ["Flush the radiator", "Never open a hot cooling system. Let it cool to avoid burns."],
  ];

  for (const [task, flag] of expectations) {
    assert.ok(
      detectSafetyFlags(task).includes(flag),
      `expected "${task}" to still produce: ${flag}`
    );
  }
});

test("an unrelated task produces no flags", () => {
  assert.deepEqual(detectSafetyFlags("Replace the cabin air filter"), []);
  assert.equal(isSafetyCriticalTask({ title: "Replace the cabin air filter" }), false);
});

test("detectSafetyFlags tolerates non-string input", () => {
  assert.deepEqual(detectSafetyFlags(/** @type {any} */ (null)), []);
  assert.deepEqual(detectSafetyFlags(/** @type {any} */ (undefined)), []);
});

// ---- Gaps this module was extracted to close ----

test("SRS/airbag work now produces a flag (previously critical but silent)", () => {
  for (const task of [
    "Replace the airbag clock spring",
    "Diagnose the SRS warning light",
    "Replace the seat belt pretensioner",
  ]) {
    const flags = detectSafetyFlags(task);
    assert.ok(
      flags.some((flag) => /SRS\/airbag/.test(flag)),
      `expected an SRS warning for: ${task}`
    );
  }
});

test("steering and ball-joint work now produce a control-loss flag", () => {
  for (const task of [
    "Replace the outer tie rod end",
    "Replace the front lower ball joint",
    "Replace the steering rack",
  ]) {
    const flags = detectSafetyFlags(task);
    assert.ok(
      flags.some((flag) => /Steering and suspension joints/.test(flag)),
      `expected a steering/control warning for: ${task}`
    );
  }
});

test("spring work now warns about stored energy", () => {
  const flags = detectSafetyFlags("Replace the front strut coil spring");

  assert.ok(flags.some((flag) => /Compressed springs store enough energy/.test(flag)));
});

test("cooling work is now safety-critical, matching its own burn warning", () => {
  // The bug this closes: the task warned "never open a hot cooling system" yet
  // isSafetyCriticalTask returned false, so it could still be marked Ready.
  for (const title of ["Drain and refill the coolant", "Replace the radiator", "Replace the thermostat"]) {
    assert.ok(detectSafetyFlags(title).length > 0, `no flag for: ${title}`);
    assert.equal(isSafetyCriticalTask({ title }), true, `not safety-critical: ${title}`);
  }
});

test("every safety-critical keyword also produces at least one warning flag", () => {
  // The invariant that was broken. If a task is dangerous enough to block Ready,
  // it must be able to tell the owner WHY.
  for (const keyword of SAFETY_CRITICAL_KEYWORDS) {
    const flags = detectSafetyFlags(`Replace the ${keyword}`);
    assert.ok(
      flags.length > 0,
      `safety-critical keyword "${keyword}" produces no warning flag`
    );
  }
});

test("a ball joint task is both safety-critical and lifted safely", () => {
  const flags = detectSafetyFlags("Replace the front lower ball joint");

  assert.equal(isSafetyCriticalTask({ title: "Replace the front lower ball joint" }), true);
  // Both hazards apply: the car is in the air AND the joint carries control loads.
  assert.ok(flags.some((flag) => /jack stands/i.test(flag)));
  assert.ok(flags.some((flag) => /Steering and suspension joints/.test(flag)));
});

test("flag order is deterministic and follows the rule table", () => {
  const flags = detectSafetyFlags("brake and airbag and coolant work");
  const ruleOrder = SAFETY_FLAG_RULES.map((rule) => rule.flag);
  const sorted = [...flags].sort((a, b) => ruleOrder.indexOf(a) - ruleOrder.indexOf(b));

  assert.deepEqual(flags, sorted);
});

test("isSafetyCriticalTask reads the system field as well as the title", () => {
  assert.equal(isSafetyCriticalTask({ title: "Inspect it", system: "Brakes" }), true);
  assert.equal(isSafetyCriticalTask({ title: "Inspect it", system: "HVAC" }), false);
  assert.equal(isSafetyCriticalTask(null), false);
});

test("a clock spring gets the SRS warning, not the coil-spring one", () => {
  const flags = detectSafetyFlags("Replace the airbag clock spring");

  assert.ok(flags.some((flag) => /SRS\/airbag/.test(flag)));
  assert.ok(
    !flags.some((flag) => /Compressed springs/.test(flag)),
    "a clockspring is not a compressed suspension spring"
  );
  // ...but a real suspension spring still gets it.
  assert.ok(detectSafetyFlags("Replace the spring").some((f) => /Compressed springs/.test(f)));
});
