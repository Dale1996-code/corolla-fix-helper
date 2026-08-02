import assert from "node:assert/strict";
import test from "node:test";

// End-to-end safety consistency through the ACTUAL planner flow:
//   extractRepairTasks -> checkRepairReadiness -> buildOwnerChecklist
//
// The unit tests in safetyClassifier.test.js prove the rule table is right. These
// prove the three planner stages all read that same decision -- the failure this
// suite exists for is a task being blocked ("Shop Recommended", not Ready) while
// the owner is shown no warning, or shown a warning for the wrong hazard.
import {
  buildOwnerChecklist,
  checkRepairReadiness,
  extractRepairTasks,
} from "../src/services/agent/repairTools.js";

/** Run one phrase through the whole planner path. */
function runFlow(phrase) {
  const { tasks } = extractRepairTasks({ brief: phrase });
  assert.equal(tasks.length, 1, `expected one task for: ${phrase}`);

  const task = tasks[0];
  // This matrix isolates the SAFETY dimension of readiness, so the tool and
  // part groups are handed in already satisfied. Readiness now scores validated
  // requirement groups rather than raw inventory strings; without these the
  // whole matrix would sit at almost_ready for reasons unrelated to safety.
  const readiness = checkRepairReadiness({
    tasks,
    skillLevel: "advanced",
    requirements: {
      tools: { status: "satisfied", required: ["socket set"], satisfied: ["socket set"], missing: [] },
      parts: { status: "satisfied", required: ["the part"], satisfied: ["the part"], missing: [] },
    },
    evidenceStatus: "verified",
  });
  const { checklist } = buildOwnerChecklist({ tasks, skillLevel: "advanced" });

  assert.equal(checklist.length, 1);

  return { task, readiness, item: checklist[0] };
}

// phrase -> expected system, whether it blocks Ready, and a pattern the warning
// text must match (so the warning matches the ACTUAL hazard, not just any hazard)
const MATRIX = [
  {
    phrase: "Replace the steering wheel audio switch",
    system: "General",
    critical: false,
  },
  {
    phrase: "Replace the front brake pads carefully",
    system: "Brakes",
    critical: true,
    warning: /Brake work affects stopping safety/,
  },
  {
    phrase: "Replace a shock absorber",
    system: "Suspension",
    critical: true,
    warning: /Suspension components carry/,
    // The old substring matcher hit "abs" inside "absorber" and warned about brakes.
    forbidden: /Brake work|Disconnect the battery/,
  },
  {
    phrase: "Replace a tie rod end",
    system: "Suspension",
    critical: true,
    warning: /Steering components and the joints/,
  },
  {
    phrase: "Replace a water pump",
    system: "Cooling",
    critical: true,
    warning: /hot cooling system is pressurized/,
  },
  {
    phrase: "Diagnose engine overheating",
    // The hazard rule is authoritative: this is Cooling work even though the
    // word "engine" appears and Engine used to win the keyword scan.
    system: "Cooling",
    critical: true,
    warning: /hot cooling system is pressurized/,
  },
  {
    phrase: "Replace an airbag module",
    system: "Restraints",
    critical: true,
    warning: /SRS\/airbag components can deploy/,
  },
  {
    phrase: "Replace a seat-belt pretensioner",
    system: "Restraints",
    critical: true,
    warning: /SRS\/airbag components can deploy/,
  },
  {
    phrase: "Replace a spring-loaded trim clip",
    system: "General",
    critical: false,
  },
  {
    phrase: "Adjust valve lift on the engine",
    system: "Engine",
    critical: false,
  },
];

for (const { phrase, system, critical, warning, forbidden } of MATRIX) {
  test(`end-to-end: "${phrase}"`, () => {
    const { task, readiness, item } = runFlow(phrase);

    // 1. System classification agrees across extraction and the checklist.
    assert.equal(task.system, system, `task system for "${phrase}"`);
    assert.equal(item.system, system, `checklist system for "${phrase}"`);

    // 2. Safety-critical status agrees across all three stages.
    assert.equal(task.safetyCritical, critical, `task.safetyCritical for "${phrase}"`);
    assert.equal(readiness.safetyCritical, critical, `readiness for "${phrase}"`);
    assert.equal(item.safetyCritical, critical, `checklist for "${phrase}"`);

    if (!critical) {
      assert.deepEqual(task.safetyFlags, [], `"${phrase}" must not carry warnings`);
      assert.deepEqual(item.safetyFlags, []);
      assert.equal(item.safetyReason, "");
      // Skill is "advanced" and nothing is hazardous, so this must reach Ready.
      assert.equal(readiness.level, "ready", `"${phrase}" should be Ready`);
      assert.notEqual(item.owner, "Shop Recommended");
      return;
    }

    // 3. Critical work ALWAYS carries at least one warning, at every stage.
    assert.ok(task.safetyFlags.length > 0, `"${phrase}" blocked with no task warning`);
    assert.ok(readiness.safetyFlags.length > 0, `"${phrase}" blocked with no readiness warning`);
    assert.ok(item.safetyFlags.length > 0, `"${phrase}" Shop Recommended with no warning`);

    // 4. The warning matches the ACTUAL hazard category.
    assert.match(task.safetyFlags.join(" "), warning, `wrong hazard warning for "${phrase}"`);
    assert.match(item.safetyFlags.join(" "), warning);

    if (forbidden) {
      assert.doesNotMatch(
        task.safetyFlags.join(" "),
        forbidden,
        `"${phrase}" showed an unrelated hazard warning`
      );
    }

    // 5. Blocking behavior and its stated reason travel together.
    assert.equal(item.owner, "Shop Recommended");
    assert.ok(item.safetyReason, `"${phrase}" is Shop Recommended with no stated reason`);
    assert.notEqual(readiness.level, "ready", `"${phrase}" must not reach Ready unacknowledged`);
    assert.ok(
      readiness.gaps.some((gap) => /Safety-critical work detected/.test(gap)),
      `"${phrase}" blocked without a readiness gap explaining it`
    );
  });
}

// ---- Cross-stage invariants ----

test("no checklist row is Shop Recommended without a warning and a reason", () => {
  const brief = MATRIX.map(({ phrase }) => phrase).join("\n");
  const { tasks } = extractRepairTasks({ brief });
  const { checklist } = buildOwnerChecklist({ tasks, skillLevel: "advanced" });

  assert.equal(checklist.length, MATRIX.length);

  for (const item of checklist) {
    if (item.owner !== "Shop Recommended" && !item.safetyCritical) {
      continue;
    }

    assert.ok(item.safetyFlags.length > 0, `"${item.task}" blocked with no warning`);
    assert.ok(item.safetyReason, `"${item.task}" blocked with no reason`);
  }
});

test("the readiness gap names the hazards actually detected", () => {
  const { tasks } = extractRepairTasks({ brief: "Replace an airbag module" });
  const readiness = checkRepairReadiness({ tasks, skillLevel: "advanced" });
  const gap = readiness.gaps.find((entry) => /Safety-critical work detected/.test(entry));

  assert.ok(gap);
  // Previously a hardcoded example list ("brakes, fuel, electrical, ...") that
  // could name hazards the tasks did not actually have.
  assert.match(gap, /SRS\/airbag/);
  assert.doesNotMatch(gap, /fuel/);
});

test("acknowledging safety clears the block but keeps the warnings", () => {
  const { tasks } = extractRepairTasks({ brief: "Replace the front brake pads carefully" });
  const readiness = checkRepairReadiness({
    tasks,
    skillLevel: "advanced",
    ackSafety: true,
    // Isolating the acknowledgment dimension: tool and part groups are handed
    // in satisfied so the only thing under test is the safety row.
    requirements: {
      tools: { status: "satisfied", required: ["socket set"], satisfied: ["socket set"], missing: [] },
      parts: { status: "satisfied", required: ["pads"], satisfied: ["pads"], missing: [] },
    },
    evidenceStatus: "verified",
  });
  const { checklist } = buildOwnerChecklist({
    tasks,
    skillLevel: "advanced",
    ackSafety: true,
  });

  assert.equal(readiness.level, "ready");
  assert.equal(readiness.safetyCritical, true);
  // The hazard does not disappear just because the owner accepted it.
  assert.ok(readiness.safetyFlags.length > 0);
  assert.equal(checklist[0].owner, "DIY");
  assert.ok(checklist[0].safetyFlags.length > 0);
});

test("a model-supplied task with only a system is still classified consistently", () => {
  // The agent may hand readiness/checklist its own task objects that never went
  // through extractRepairTasks.
  const tasks = [{ id: 1, title: "Inspect it", system: "Brakes", difficulty: "beginner" }];
  const readiness = checkRepairReadiness({ tasks, skillLevel: "advanced" });
  const { checklist } = buildOwnerChecklist({ tasks, skillLevel: "advanced" });

  assert.equal(readiness.safetyCritical, true);
  assert.ok(readiness.safetyFlags.length > 0, "blocked with no warning");
  assert.equal(checklist[0].owner, "Shop Recommended");
  assert.ok(checklist[0].safetyFlags.length > 0);
  assert.ok(checklist[0].safetyReason);
});

test("a hand-built task carrying flags but no hazard text still reports a reason", () => {
  const tasks = [
    { id: 1, title: "Inspect it", system: "HVAC", difficulty: "beginner", safetyFlags: ["x"] },
  ];
  const { checklist } = buildOwnerChecklist({ tasks, skillLevel: "advanced" });

  assert.equal(checklist[0].safetyCritical, true);
  assert.ok(checklist[0].safetyReason, "critical rows must always state a reason");
});
