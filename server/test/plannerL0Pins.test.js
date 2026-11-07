import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

// Phase 1b of docs/planner-eval-spec.md: pin what the Repair Planner decides
// BEFORE any model runs (task derivation, safety flags, readiness math).
//
// Pure code only: no database, no network, no API key. Importing repairTools.js
// is side-effect free since Phase 1a. Brief text below is invented or generic.
//
// Three kinds of test live here:
//   1. Characterization pins -- today's output, so a silent change fails loudly.
//      They are not claims that today's output is ideal.
//   2. `todo` rows -- the DESIRED behavior, known to fail today. node:test
//      reports them as todo without failing the run. The guard test at the
//      bottom goes red the moment one starts passing, so the row must then be
//      updated (remove its `todo`). Never delete or relabel a row to pass.
//   3. Readiness invariants that hold today and must keep holding.
//
// Deliberately NOT pinned (spec 14.2): probe A1 (one claim => verified / 100 /
// ready) and A2 (zero-evidence score floors). They are measurements, not
// expectations.

// The database and uploads paths point INSIDE a scratch folder that does not
// exist yet, before anything is imported (databaseIsolation.test.js requires
// this of every suite that statically reaches repairTools.js). If an import
// ever opened a database, the folder would appear -- the first test checks.
const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-l0-pins-"));
process.env.DATABASE_FILE = path.join(scratchRoot, "not-created", "test.db");
process.env.UPLOADS_DIR = path.join(scratchRoot, "not-created", "uploads");
delete process.env.OPENAI_API_KEY;

const { checkRepairReadiness, extractRepairTasks } = await import(
  "../src/services/agent/repairTools.js"
);
const { SAFETY_RULES } = await import("../src/services/safetyClassifier.js");

after(() => {
  fs.rmSync(scratchRoot, { recursive: true, force: true });
});

test("importing the pure planner tools creates no database or uploads folder", () => {
  assert.deepEqual(fs.readdirSync(scratchRoot), []);
});

// ---- 1. Canonical briefs (spec 6.2, probe A3) ----

const task = (title, system, difficulty, safetyCritical, flagCount, compound = false) => ({
  title,
  system,
  difficulty,
  safetyCritical,
  compound,
  flagCount,
});

const CANONICAL = [
  {
    id: "S1",
    brief: "Change the engine oil and replace the oil filter.",
    tasks: [
      task("Change the engine oil", "Engine", "beginner", false, 0),
      task("replace the oil filter.", "Engine", "beginner", false, 0),
    ],
  },
  {
    id: "S2",
    brief: "Replace the spark plugs.",
    tasks: [task("Replace the spark plugs.", "Engine", "beginner", false, 0)],
  },
  {
    id: "S3",
    brief: "Replace the cabin air filter.",
    tasks: [task("Replace the cabin air filter.", "HVAC", "beginner", false, 0)],
  },
  {
    id: "S4",
    brief: "Replace the front brake pads.",
    tasks: [task("Replace the front brake pads.", "Brakes", "beginner", true, 1)],
  },
  {
    id: "S5",
    brief: "Replace the engine coolant.",
    tasks: [task("Replace the engine coolant.", "Cooling", "beginner", true, 1)],
  },
  {
    id: "S6",
    brief: "Replace the front engine mount.",
    tasks: [task("Replace the front engine mount.", "Engine", "beginner", false, 0)],
  },
  {
    id: "S7",
    brief: "Replace the battery and then test the charging voltage.",
    tasks: [
      task("Replace the battery", "Electrical", "beginner", true, 1),
      task("test the charging voltage.", "General", "beginner", false, 0),
    ],
  },
  {
    id: "S8",
    brief: "Replace the timing belt.",
    tasks: [task("Replace the timing belt.", "Engine", "advanced", false, 0)],
  },
];

const summarize = (brief) =>
  extractRepairTasks({ brief }).tasks.map((t) => ({
    title: t.title,
    system: t.system,
    difficulty: t.difficulty,
    safetyCritical: t.safetyCritical,
    compound: t.compound,
    flagCount: t.safetyFlags.length,
  }));

for (const row of CANONICAL) {
  test(`L0 pin ${row.id}: "${row.brief}"`, () => {
    assert.deepEqual(summarize(row.brief), row.tasks);
  });
}

// ---- 2 & 3. Rows asserting DESIRED behavior that fails today ----

const flagFor = (ruleId) => SAFETY_RULES.find((rule) => rule.id === ruleId).flag;

// Natural phrasing: a repair sentence plus a symptom/context sentence (probe A4).
// Desired: the context sentence is not a task, and nothing safety-critical
// comes from it. `repair` identifies the real repair task; `criticalRepair`
// says whether that repair is legitimately safety-critical.
const NATURAL = [
  {
    id: "N1-oil-jack-stands",
    brief: "Change the engine oil. It is due and I have the jack stands out already.",
    repair: /oil/i,
    context: /jack stands out/i,
    criticalRepair: false,
  },
  {
    id: "N2-plugs-rough-idle",
    brief: "Replace the spark plugs. The engine idles rough and the check engine light came on.",
    repair: /spark plugs/i,
    context: /idles rough/i,
    criticalRepair: false,
  },
  {
    id: "N3-cabin-filter-weak-airflow",
    brief: "Replace the cabin air filter. The A/C airflow is weak.",
    repair: /cabin air filter/i,
    context: /airflow is weak/i,
    criticalRepair: false,
  },
  {
    id: "N4-pads-squeal",
    brief: "Replace the front brake pads. They squeal when I brake.",
    repair: /brake pads/i,
    context: /squeal/i,
    criticalRepair: true,
  },
  {
    id: "N5-mount-symptom-first",
    brief: "The engine shakes at idle and vibrates in the cabin. Replace the front engine mount.",
    repair: /engine mount/i,
    context: /shakes at idle/i,
    criticalRepair: false,
  },
];

const ROWS = [
  ...NATURAL.map((row) => ({
    id: row.id,
    todo: "F3-phantom-task",
    check() {
      const { tasks } = extractRepairTasks({ brief: row.brief });
      const phantom = tasks.filter((t) => row.context.test(t.title)).map((t) => t.title);
      const critical = tasks.filter((t) => t.safetyCritical).map((t) => t.title);
      const strayCritical = critical.filter((title) => !row.repair.test(title));
      assert.deepEqual(phantom, [], "a symptom/context sentence became a task");
      assert.deepEqual(strayCritical, [], "a safety-critical task came from a non-repair sentence");
      assert.equal(
        critical.length,
        row.criticalRepair ? 1 : 0,
        "the repair's own safety-critical status changed"
      );
    },
  })),
  {
    id: "S4-brake-pads-flags-lifting-and-wheel-retention",
    todo: "F4-brake-lifting",
    check() {
      const [t] = extractRepairTasks({ brief: "Replace the front brake pads." }).tasks;
      assert.ok(t.safetyFlags.includes(flagFor("lifting")), "no vehicle-lifting flag");
      assert.ok(t.safetyFlags.includes(flagFor("wheel-retention")), "no wheel-retention flag");
    },
  },
  {
    id: "S6-engine-mount-not-beginner-and-noncritical",
    todo: "F4-engine-mount",
    check() {
      const [t] = extractRepairTasks({ brief: "Replace the front engine mount." }).tasks;
      assert.ok(
        !(t.difficulty === "beginner" && !t.safetyCritical),
        `rated ${t.difficulty}, safetyCritical=${t.safetyCritical}`
      );
    },
  },
];

for (const row of ROWS) {
  test(`desired behavior ${row.id} [${row.todo}]`, { todo: row.todo }, () => row.check());
}

// ---- Stale-todo guard ----

test("every todo row still fails (remove todo when a fix lands)", () => {
  const ids = new Set();
  const nowPassing = [];

  for (const row of ROWS) {
    assert.ok(row.todo, `${row.id}: every desired-behavior row names a finding id`);
    assert.ok(!ids.has(row.id), `duplicate row id ${row.id}`);
    ids.add(row.id);

    try {
      row.check();
      nowPassing.push(`${row.id} [${row.todo}]`);
    } catch {
      // Still failing: the finding still reproduces.
    }
  }

  assert.deepEqual(
    nowPassing,
    [],
    "These rows now pass. Remove their `todo` so they gate from here on."
  );
});

// ---- 5. Readiness invariants (I-2, I-3) ----

const STATUSES = ["verified", "partial", "not_found"];
const requirements = {
  tools: { status: "satisfied", required: [], missing: [] },
  parts: { status: "satisfied", required: [], missing: [] },
};

test("readiness invariants hold for every brief x evidence status x acknowledgment", () => {
  let reachedReady = 0;

  for (const row of CANONICAL) {
    const { tasks } = extractRepairTasks({ brief: row.brief });

    for (const evidenceStatus of STATUSES) {
      for (const ackSafety of [true, false]) {
        // Advanced skill so "ready" is reachable even for S8; otherwise the
        // invariants would hold vacuously.
        const result = checkRepairReadiness({
          tasks,
          skillLevel: "advanced",
          ackSafety,
          requirements,
          evidenceStatus,
        });
        const where = `${row.id} ${evidenceStatus} ack=${ackSafety} -> ${result.level}`;

        if (result.level === "ready") reachedReady += 1;

        if (tasks.some((t) => t.safetyCritical) && !ackSafety) {
          assert.notEqual(result.level, "ready", `I-2: unacknowledged safety-critical: ${where}`);
        }
        if (evidenceStatus === "not_found") {
          assert.equal(result.level, "not_ready", `I-3: not_found: ${where}`);
        }
        if (evidenceStatus === "partial") {
          assert.notEqual(result.level, "ready", `I-3: partial: ${where}`);
        }
      }
    }
  }

  assert.ok(reachedReady > 0, "no combination reached ready, so the invariants proved nothing");
});
