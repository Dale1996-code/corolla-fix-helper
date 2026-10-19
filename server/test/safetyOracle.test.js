import assert from "node:assert/strict";
import test from "node:test";

// Pure classification: no database, no network. Safe to import directly.
import { classifyDefeatRequest } from "../src/services/defeatRequestClassifier.js";
import { classifyRepairTask, isSafetyCriticalTask } from "../src/services/safetyClassifier.js";
import { SAFETY_ORACLE } from "./fixtures/safetyOracle.js";

// Drives every row of the safety oracle through the real classifiers. Rows the
// classifiers get wrong today are todo under their audit finding; the last test
// turns red as soon as one starts passing, so a fix must also remove its `todo`.

function outcomeOf(row) {
  if (row.classifier === "defeat") {
    const verdict = classifyDefeatRequest(row.text);
    return {
      verdict: verdict.refuse ? "refuse" : "allow",
      detail: JSON.stringify(verdict),
    };
  }

  const classified = classifyRepairTask(row.text);
  // The planner reads the same table through two entry points. If they ever
  // disagreed, the row would be neither verdict.
  const viaTask = isSafetyCriticalTask({ title: row.text });
  const verdict =
    classified.safetyCritical !== viaTask
      ? "inconsistent"
      : classified.safetyCritical
        ? "critical"
        : "not_critical";

  return { verdict, detail: `rules=${JSON.stringify(classified.ruleIds)}` };
}

test("every safety oracle row is well formed", () => {
  const ids = new Set();
  const allowed = { defeat: ["refuse", "allow"], safety: ["critical", "not_critical"] };

  for (const row of SAFETY_ORACLE) {
    assert.ok(!ids.has(row.id), `duplicate oracle id ${row.id}`);
    ids.add(row.id);
    assert.ok(allowed[row.classifier]?.includes(row.expect), `${row.id}: expect`);
    assert.ok(row.text && row.note && row.finding, `${row.id}: text, note, finding`);

    if (row.finding === "control") {
      assert.equal(row.todo, undefined, `${row.id}: a control row never carries todo`);
    }
    if (row.todo !== undefined) {
      assert.equal(row.todo, row.finding, `${row.id}: todo names its own finding`);
    }
  }
});

for (const row of SAFETY_ORACLE) {
  test(
    `${row.classifier} oracle ${row.id} [${row.finding}] must be ${row.expect}`,
    { todo: row.todo },
    () => {
      const outcome = outcomeOf(row);
      assert.equal(
        outcome.verdict,
        row.expect,
        `${JSON.stringify(row.text)} -> ${outcome.verdict} (${outcome.detail})\n  note: ${row.note}`
      );
    }
  );
}

test("every todo row still reproduces its finding (remove todo when a fix lands)", () => {
  const nowPassing = SAFETY_ORACLE.filter((row) => row.todo !== undefined)
    .filter((row) => outcomeOf(row).verdict === row.expect)
    .map((row) => `${row.id} [${row.todo}]`);

  assert.deepEqual(
    nowPassing,
    [],
    "These rows now get the right verdict. Remove their `todo` so they gate from here on."
  );
});
