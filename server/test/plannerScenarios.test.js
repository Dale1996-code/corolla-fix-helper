import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import {
  NOT_APPLICABLE,
  PLANNER_SCENARIOS,
  SCENARIO_SET_VERSION,
  SOURCE_QUALITIES,
  factScoringStatus,
  isScorable,
  validateScenario,
  validateScenarioSet,
} from "../src/evals/plannerScenarios.js";
import { extractSpecNumbers } from "../src/services/askEvidenceContract.js";

// Phase 2a of docs/planner-eval-spec.md: the scenario DATA the evaluation will
// judge against. Nothing here judges a run -- the matcher, the ledgers, and
// every classification are Phase 2b.
//
// Three rules from the owner's review shape these tests:
//   * An unconfirmed golden fact never appears in scored results. The committed
//     module holds ONLY facts already confirmed in the Ask eval cases, and the
//     list is duplicated below so a guess cannot quietly gate anything.
//   * "Unknown" is a value, not a default. Source quality and the golden-query
//     probe are null until the Phase 4 survey; null is never turned into clean.
//   * L0 is judged against desired JOBS written from the brief's meaning, kept
//     apart from the vehicle PREMISE (S8 asks for a repair the engine cannot
//     need; deriving that task is correct decomposition, not an L0 defect).

// repairTools.js is database-free since Phase 1a, but databaseIsolation.test.js
// follows its literal import() chain, so the scratch paths come first.
const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-planner-scenarios-"));
process.env.DATABASE_FILE = path.join(scratchRoot, "not-created", "test.db");
process.env.UPLOADS_DIR = path.join(scratchRoot, "not-created", "uploads");
delete process.env.OPENAI_API_KEY;

const { extractRepairTasks } = await import("../src/services/agent/repairTools.js");

after(() => {
  fs.rmSync(scratchRoot, { recursive: true, force: true });
});

const byId = Object.fromEntries(PLANNER_SCENARIOS.map((scenario) => [scenario.id, scenario]));
const allFacts = PLANNER_SCENARIOS.flatMap((scenario) =>
  scenario.facts.map((fact) => ({ scenario, fact }))
);

// ---- 1. The committed set --------------------------------------------------

test("the committed scenario set validates", () => {
  assert.equal(SCENARIO_SET_VERSION, 1);
  assert.deepEqual(validateScenarioSet(PLANNER_SCENARIOS), []);
});

test("the committed set is S1, S2 and S8 only, with the canonical briefs", () => {
  assert.deepEqual(
    PLANNER_SCENARIOS.map((scenario) => [scenario.id, scenario.brief]),
    [
      ["S1-oil-and-filter", "Change the engine oil and replace the oil filter."],
      ["S2-spark-plugs", "Replace the spark plugs."],
      ["S8-timing-belt", "Replace the timing belt."],
    ]
  );
  for (const scenario of PLANNER_SCENARIOS) {
    assert.equal(scenario.skillLevel, "beginner", `${scenario.id}: one skill level keeps scenarios comparable`);
  }
});

test("every scenario shares one fixed tool inventory", () => {
  const profiles = new Set(PLANNER_SCENARIOS.map((scenario) => scenario.inventoryProfile));
  const tools = new Set(PLANNER_SCENARIOS.map((scenario) => scenario.availableTools));

  assert.equal(profiles.size, 1);
  assert.equal(tools.size, 1);
  assert.match([...tools][0], /torque wrench/);
});

// ---- 2. The scoring gate ---------------------------------------------------

// Duplicated on purpose (the answerQualityCases convention): promoting a fact
// to confirmed means editing the scenario AND this list, in a reviewed diff.
const CONFIRMED_FACT_IDS = [
  "s1-drain-plug-torque",
  "s2-new-plug-gap",
  "s2-used-plug-max-gap",
  "s8-no-timing-belt-procedure",
];

test("exactly the facts confirmed in the existing Ask cases are in the committed set", () => {
  assert.deepEqual(
    allFacts.map(({ fact }) => fact.id),
    CONFIRMED_FACT_IDS
  );
});

test("no committed fact is unconfirmed, and every one carries its Ask-case provenance", () => {
  for (const { scenario, fact } of allFacts) {
    assert.equal(fact.confirmed, true, `${fact.id}: an unconfirmed fact must not be committed`);
    assert.equal(isScorable(fact), true);
    assert.equal(factScoringStatus(fact), "scored");
    assert.match(fact.confirmedBy?.askCaseId ?? "", /\S/, `${scenario.id}/${fact.id}: names its Ask case`);
  }
});

test("a fact that is not confirmed is unscored, whatever else it says", () => {
  const unconfirmed = { id: "x", confirmed: false, corpusSupport: "full", sourceQuality: "clean" };

  assert.equal(isScorable(unconfirmed), false);
  assert.equal(factScoringStatus(unconfirmed), "unscored");
  assert.equal(factScoringStatus({ id: "y" }), "unscored", "confirmed absent means unconfirmed");
  assert.equal(factScoringStatus({ id: "z", confirmed: "yes" }), "unscored", "only true counts");
});

test("unassessed areas are names only: no concept, figure or matcher", () => {
  for (const scenario of PLANNER_SCENARIOS) {
    assert.ok(scenario.unassessedAreas.length >= 1, `${scenario.id} names what it does not assess`);

    for (const area of scenario.unassessedAreas) {
      assert.deepEqual(Object.keys(area).sort(), ["area", "id"], `${scenario.id}/${area.id}`);
    }
  }

  assert.deepEqual(
    byId["S1-oil-and-filter"].unassessedAreas.map((area) => area.id),
    [
      "task-attributes",
      "procedure-completeness",
      "required-tools",
      "required-parts",
      "safety-instructions",
      "filter-cap-torque",
      "fluid-capacities",
    ]
  );
});

// ---- 3. Survey fields: unknown stays unknown --------------------------------

test("S1 and S2 facts leave source quality and the golden-query probe unknown", () => {
  for (const { scenario, fact } of allFacts) {
    if (scenario.id === "S8-timing-belt") continue;

    assert.equal(fact.corpusSupport, "full", fact.id);
    assert.equal(fact.sourceQuality, null, `${fact.id}: PDF-page confirmation is not extracted-text quality`);
    assert.equal(fact.qualityEvidence, null, fact.id);
    assert.equal(fact.goldenQueryRetrieves, null, `${fact.id}: waits for the Phase 4 survey`);
    assert.equal(fact.goldenQueryEvidence, null, fact.id);
  }
});

test("no committed fact declares a known source quality in this PR", () => {
  for (const { fact } of allFacts) {
    assert.equal(
      SOURCE_QUALITIES.includes(fact.sourceQuality),
      false,
      `${fact.id}: a known quality needs separate evidence the extracted text is usable`
    );
  }
});

test("the absent S8 fact says so explicitly instead of leaving the survey fields null", () => {
  const fact = byId["S8-timing-belt"].facts[0];

  assert.equal(fact.corpusSupport, "absent");
  assert.equal(fact.sourceQuality, NOT_APPLICABLE);
  assert.equal(fact.goldenQueryRetrieves, NOT_APPLICABLE);
  assert.deepEqual(fact.absenceCheck, {
    precondition: "checkTimingBeltRefusalPrecondition",
    askCaseId: "refuse-timing-belt-interval",
    requiresDatabase: true,
  });
});

test("the used-plug fact records the label/value split as a caveat without changing any value", () => {
  const fact = byId["S2-spark-plugs"].facts.find((candidate) => candidate.id === "s2-used-plug-max-gap");

  assert.match(fact.knownCaveat, /next page/i);
  assert.equal(fact.sourceQuality, null, "a caveat is not a quality rating");
});

test("source hints carry the page-level confirmation that Q1 may score", () => {
  for (const { fact } of allFacts.filter(({ fact }) => fact.kind === "numeric_spec")) {
    assert.equal(fact.sourceHint.confirmed, true, fact.id);
    assert.ok(fact.sourceHint.sources.length >= 1, fact.id);

    for (const source of fact.sourceHint.sources) {
      assert.ok(source.titleLike instanceof RegExp, fact.id);
      assert.ok(source.pages.length >= 1 && source.pages.every(Number.isInteger), fact.id);
    }
  }
});

// A scenario that is valid except for the one field under test.
function syntheticScenario() {
  return {
    id: "T-synthetic",
    brief: "Replace the widget.",
    skillLevel: "beginner",
    availableTools: "socket set",
    availableParts: "",
    constraints: "",
    inventoryProfile: "stocked-home-garage-v1",
    desiredJobs: {
      decomposition: [
        { id: "replace-widget", concept: "replace the widget", matchers: [/\bwidget\b/i], confirmed: false },
      ],
      premise: { status: "not_assessed" },
    },
    unassessedAreas: [{ id: "task-attributes", area: "system, difficulty and safety flags" }],
    facts: [
      {
        id: "t-widget-torque",
        kind: "numeric_spec",
        jobId: "replace-widget",
        essential: true,
        confirmed: true,
        concept: "widget bolt tightening torque",
        confirmedBy: { askCaseId: "synthetic" },
        corpusSupport: "full",
        partial: null,
        sourceQuality: null,
        qualityEvidence: null,
        goldenQueryRetrieves: null,
        goldenQueryEvidence: null,
        sourceHint: null,
        partMatchers: [/\bwidget bolt\b/i],
        units: [{ canonical: "N·m", aliases: ["Nm"] }],
        acceptable: [{ kind: "value", value: 10, unit: "N·m" }],
        qualifiersAnyOf: null,
        excludedQualifiers: [],
        decoys: [{ kind: "value", value: 12, unit: "N·m", why: "a different widget" }],
        claimExamples: [
          { text: "Tighten the widget bolt to 10 N·m.", expect: "covers", category: "primary-unit" },
        ],
      },
    ],
    claimSetExamples: [],
  };
}

const withFact = (mutate) => {
  const scenario = syntheticScenario();
  mutate(scenario.facts[0], scenario);
  return scenario;
};

test("the synthetic baseline scenario is itself valid", () => {
  assert.deepEqual(validateScenario(syntheticScenario()), []);
});

// Every row is one rule the validator must enforce. The expected text is a
// fragment of the problem, so a rule that fires for the wrong reason fails.
const INVALID = [
  ["a missing scenario id", (_f, s) => { s.id = ""; }, /id/],
  ["an unknown skill level", (_f, s) => { s.skillLevel = "expert"; }, /skillLevel/],
  ["a duplicate job id", (_f, s) => { s.desiredJobs.decomposition.push({ ...s.desiredJobs.decomposition[0] }); }, /duplicate job/],
  ["a job with no matchers", (_f, s) => { s.desiredJobs.decomposition[0].matchers = []; }, /matchers/],
  ["a job matcher with the global flag", (_f, s) => { s.desiredJobs.decomposition[0].matchers = [/widget/gi]; }, /global|sticky/],
  ["a job that is not a boolean confirmed", (_f, s) => { s.desiredJobs.decomposition[0].confirmed = "no"; }, /confirmed/],
  ["an unknown premise status", (_f, s) => { s.desiredJobs.premise = { status: "maybe" }; }, /premise/],
  ["an unsupported premise with no basis", (_f, s) => { s.desiredJobs.premise = { status: "unsupported_for_vehicle" }; }, /basis/],
  ["an unassessed area that carries a concept", (_f, s) => { s.unassessedAreas[0].concept = "x"; }, /names only/],
  ["a fact pointing at a job that does not exist", (f) => { f.jobId = "nope"; }, /jobId/],
  ["an unknown fact kind", (f) => { f.kind = "procedure"; }, /kind/],
  ["a confirmed fact with no corpusSupport", (f) => { delete f.corpusSupport; }, /corpusSupport/],
  ["a partial fact with no partialKind", (f) => { f.corpusSupport = "partial"; f.partial = { supported: "the first half" }; }, /partialKind/],
  ["a partial fact with no supported portion", (f) => { f.corpusSupport = "partial"; f.partial = { partialKind: "fragmented" }; }, /supported/],
  ["a full fact that carries a partial block", (f) => { f.partial = { partialKind: "fragmented", supported: "x" }; }, /partial/],
  ["a known source quality with no evidence", (f) => { f.sourceQuality = "clean"; }, /qualityEvidence/],
  ["an unknown source quality value", (f) => { f.sourceQuality = "pristine"; f.qualityEvidence = { kind: "x", ref: "y" }; }, /sourceQuality/],
  ["not_applicable quality on a fact that is present", (f) => { f.sourceQuality = NOT_APPLICABLE; }, /not_applicable/],
  ["a golden-query result with no evidence", (f) => { f.goldenQueryRetrieves = true; }, /goldenQueryEvidence/],
  ["not_applicable golden query on a fact that is present", (f) => { f.goldenQueryRetrieves = NOT_APPLICABLE; }, /not_applicable/],
  ["no acceptable forms", (f) => { f.acceptable = []; }, /acceptable/],
  ["a range whose low end is not below its high end", (f) => { f.acceptable = [{ kind: "range", low: 2, high: 2, unit: "N·m" }]; }, /range/],
  ["an acceptable form in a unit the fact does not declare", (f) => { f.acceptable = [{ kind: "value", value: 10, unit: "psi" }]; }, /unit/],
  ["a decoy equal to an acceptable value", (f) => { f.decoys = [{ kind: "value", value: 10, unit: "N·m", why: "x" }]; }, /decoy/],
  ["a part matcher with the sticky flag", (f) => { f.partMatchers = [/widget/y]; }, /global|sticky/],
  ["a claim example with an unknown label", (f) => { f.claimExamples[0].expect = "great"; }, /expect/],
  ["a claim example with no category", (f) => { delete f.claimExamples[0].category; }, /category/],
];

for (const [name, mutate, expected] of INVALID) {
  test(`the validator rejects ${name}`, () => {
    const problems = validateScenario(withFact(mutate));

    assert.ok(problems.length >= 1, "a rule that never fires is not a rule");
    assert.ok(
      problems.some((problem) => expected.test(problem)),
      `no problem matched ${expected}: ${JSON.stringify(problems)}`
    );
  });
}

test("a known source quality is accepted once it carries evidence", () => {
  const scenario = withFact((fact) => {
    fact.sourceQuality = "clean";
    fact.qualityEvidence = { kind: "survey", ref: "phase-4 report" };
    fact.goldenQueryRetrieves = false;
    fact.goldenQueryEvidence = { kind: "survey", ref: "phase-4 report" };
  });

  assert.deepEqual(validateScenario(scenario), []);
});

test("a valid partial fact needs its kind and its supported portion", () => {
  const scenario = withFact((fact) => {
    fact.corpusSupport = "partial";
    fact.partial = { partialKind: "qualifier_missing", supported: "the value, not its condition" };
  });

  assert.deepEqual(validateScenario(scenario), []);
});

test("an absent fact must be not_applicable, never null, for both survey fields", () => {
  const absent = (mutate) =>
    validateScenario(
      withFact((fact, scenario) => {
        scenario.desiredJobs.decomposition[0].matchers = [/belt/i];
        Object.assign(fact, {
          id: "t-absent",
          kind: "absence",
          jobId: "replace-widget",
          essential: false,
          corpusSupport: "absent",
          sourceQuality: NOT_APPLICABLE,
          goldenQueryRetrieves: NOT_APPLICABLE,
          absenceCheck: { precondition: "p", askCaseId: "a", requiresDatabase: true },
          fabrication: { subject: /belt/i, cues: [/replace/i], negations: [/\bno\b/i], decoys: [/drive belt/i] },
          claimExamples: [{ text: "Replace the belt.", expect: "forbidden", category: "fabrication" }],
        });
        for (const key of ["partMatchers", "units", "acceptable", "qualifiersAnyOf", "excludedQualifiers", "decoys"]) {
          delete fact[key];
        }
        mutate(fact);
      })
    );

  assert.deepEqual(absent(() => {}), []);
  assert.ok(absent((fact) => { fact.sourceQuality = null; }).some((p) => /not_applicable/.test(p)));
  assert.ok(absent((fact) => { fact.goldenQueryRetrieves = null; }).some((p) => /not_applicable/.test(p)));
  assert.ok(absent((fact) => { delete fact.absenceCheck; }).some((p) => /absenceCheck/.test(p)));
});

test("duplicate scenario or fact ids across the set are rejected", () => {
  const first = syntheticScenario();
  const second = syntheticScenario();

  assert.ok(validateScenarioSet([first, second]).some((problem) => /duplicate scenario id/.test(problem)));

  second.id = "T-other";
  assert.ok(validateScenarioSet([first, second]).some((problem) => /duplicate fact id/.test(problem)));
});

// ---- 4. Desired jobs: decomposition, kept apart from premise ----------------

test("every desired job is unconfirmed, so L0 stays unscored until the owner signs off", () => {
  for (const scenario of PLANNER_SCENARIOS) {
    for (const job of scenario.desiredJobs.decomposition) {
      assert.equal(job.confirmed, false, `${scenario.id}/${job.id}`);
    }
  }
});

test("a job holds a decomposition expectation and nothing about the vehicle", () => {
  for (const scenario of PLANNER_SCENARIOS) {
    for (const job of scenario.desiredJobs.decomposition) {
      assert.deepEqual(Object.keys(job).sort(), ["concept", "confirmed", "id", "matchers"], job.id);
      assert.doesNotMatch(job.concept, /unsupported|not applicable|engine code|chain/i, job.id);
    }
  }
});

test("S8's false premise lives in its own field, supported by the existing absence check", () => {
  assert.deepEqual(byId["S8-timing-belt"].desiredJobs.premise, {
    status: "unsupported_for_vehicle",
    basis: { askCaseId: "refuse-timing-belt-interval", precondition: "checkTimingBeltRefusalPrecondition" },
  });
  assert.deepEqual(byId["S1-oil-and-filter"].desiredJobs.premise, { status: "not_assessed" });
  assert.deepEqual(byId["S2-spark-plugs"].desiredJobs.premise, { status: "not_assessed" });
});

test("today's extractor satisfies each decomposition and derives no phantom task", () => {
  // A sanity check that the jobs are not mistyped, run against the real
  // extractor. If this ever fails the right response is to stop and look, not
  // to edit the jobs until it passes.
  for (const scenario of PLANNER_SCENARIOS) {
    const { tasks } = extractRepairTasks({ brief: scenario.brief });
    const jobs = scenario.desiredJobs.decomposition;
    const matches = (job, title) => job.matchers.some((matcher) => matcher.test(title));

    for (const job of jobs) {
      assert.ok(tasks.some((task) => matches(job, task.title)), `${scenario.id}: no task satisfies "${job.id}"`);
    }
    for (const task of tasks) {
      assert.ok(jobs.some((job) => matches(job, task.title)), `${scenario.id}: phantom task "${task.title}"`);
    }
  }
});

test("S1 titles each satisfy exactly one job", () => {
  const scenario = byId["S1-oil-and-filter"];
  const { tasks } = extractRepairTasks({ brief: scenario.brief });

  assert.equal(tasks.length, 2);
  for (const task of tasks) {
    const hits = scenario.desiredJobs.decomposition.filter((job) =>
      job.matchers.some((matcher) => matcher.test(task.title))
    );
    assert.equal(hits.length, 1, `"${task.title}" matched ${hits.map((job) => job.id)}`);
  }
});

test("no job matches another scenario's tasks", () => {
  for (const scenario of PLANNER_SCENARIOS) {
    for (const other of PLANNER_SCENARIOS.filter((candidate) => candidate !== scenario)) {
      const { tasks } = extractRepairTasks({ brief: other.brief });

      for (const job of scenario.desiredJobs.decomposition) {
        for (const task of tasks) {
          assert.equal(
            job.matchers.some((matcher) => matcher.test(task.title)),
            false,
            `${scenario.id}/${job.id} matches ${other.id}'s "${task.title}"`
          );
        }
      }
    }
  }
});

const JOB_CASES = [
  ["S1-oil-and-filter", "change-engine-oil", "Change the engine oil", true],
  ["S1-oil-and-filter", "change-engine-oil", "Do an oil change", true],
  ["S1-oil-and-filter", "change-engine-oil", "Replace the oil filter.", false],
  ["S1-oil-and-filter", "replace-oil-filter", "replace the oil filter.", true],
  ["S1-oil-and-filter", "replace-oil-filter", "Change the engine oil", false],
  ["S2-spark-plugs", "replace-spark-plugs", "Replace the spark plugs.", true],
  ["S2-spark-plugs", "replace-spark-plugs", "Replace the spark plug wires.", true],
  ["S2-spark-plugs", "replace-spark-plugs", "Replace the air filter.", false],
  ["S8-timing-belt", "timing-belt-replacement-as-requested", "Replace the timing belt.", true],
  ["S8-timing-belt", "timing-belt-replacement-as-requested", "Replace the timing chain.", true],
  ["S8-timing-belt", "timing-belt-replacement-as-requested", "Replace the drive belt.", false],
];

for (const [scenarioId, jobId, title, want] of JOB_CASES) {
  test(`job ${jobId} ${want ? "matches" : "does not match"} "${title}"`, () => {
    const job = byId[scenarioId].desiredJobs.decomposition.find((candidate) => candidate.id === jobId);

    assert.equal(
      job.matchers.some((matcher) => matcher.test(title)),
      want
    );
  });
}

// ---- 5. Labelled claim examples ---------------------------------------------

// The labels are authored HERE, before any matcher exists. Phase 2b's matcher
// must reproduce every one; if a label is wrong, fix the label in review, never
// bend the matcher.
const REQUIRED_CATEGORIES = {
  "s1-drain-plug-torque": [
    "printed-forms-together", "primary-unit", "unit-spelling", "alternate-unit",
    "wrong-value", "right-number-wrong-unit", "mixed-right-and-wrong", "different-part", "no-figure",
  ],
  "s2-new-plug-gap": [
    "range-full", "range-alt-unit", "decimal-spelling", "range-endpoint", "range-mixed-decoy",
    "range-wrong-unit", "decoy-unqualified", "decoy-explicit-new", "decoy-qualified-other-fact", "no-figure",
  ],
  "s2-used-plug-max-gap": [
    "qualified-primary-unit", "qualified-alt-unit", "range-for-used", "unqualified-not-used-fact", "new-plug-range-other-fact",
  ],
  "s8-no-timing-belt-procedure": [
    "belt-fabrication-interval", "belt-fabrication-inspection", "belt-negated-statement", "belt-negated-with-cue",
    "chain-statement", "drive-belt-decoy", "serpentine-belt-decoy",
  ],
};

test("each fact's labelled examples cover every required edge category", () => {
  for (const { fact } of allFacts) {
    const present = new Set(fact.claimExamples.map((example) => example.category));
    const missing = REQUIRED_CATEGORIES[fact.id].filter((category) => !present.has(category));

    assert.deepEqual(missing, [], `${fact.id} lacks examples for ${missing}`);
  }
});

// Figure-level consistency only: it reads the printed figures, never the
// part name or a qualifier, so it checks the labels against the data without
// becoming the Phase 2b matcher.
function figuresOf(fact, text) {
  const canonicalOf = new Map();
  for (const unit of fact.units) {
    for (const spelling of [unit.canonical, ...unit.aliases]) {
      canonicalOf.set(spelling.toLowerCase(), unit.canonical);
    }
  }

  return extractSpecNumbers(text)
    .map((figure) => ({ value: figure.value, unit: canonicalOf.get(String(figure.unit).toLowerCase()) ?? null }))
    .filter((figure) => figure.unit !== null);
}

const isAcceptableValue = (fact, figure) =>
  fact.acceptable.some((form) =>
    form.kind === "value"
      ? form.unit === figure.unit && form.value === figure.value
      : form.unit === figure.unit && (form.low === figure.value || form.high === figure.value)
  );

const isEndpoint = (fact, figure) =>
  fact.acceptable.some(
    (form) => form.kind === "range" && form.unit === figure.unit && (form.low === figure.value || form.high === figure.value)
  );

const hasWholeRange = (fact, figures) =>
  fact.acceptable
    .filter((form) => form.kind === "range")
    .some(
      (form) =>
        figures.some((f) => f.unit === form.unit && f.value === form.low) &&
        figures.some((f) => f.unit === form.unit && f.value === form.high)
    );

test("each numeric example's label agrees with the figures it prints", () => {
  for (const { fact } of allFacts.filter(({ fact }) => fact.kind === "numeric_spec")) {
    const hasRanges = fact.acceptable.some((form) => form.kind === "range");

    for (const example of fact.claimExamples) {
      const figures = figuresOf(fact, example.text);
      const where = `${fact.id} [${example.category}] "${example.text}"`;
      const partHit = fact.partMatchers.some((matcher) => matcher.test(example.text));
      const excludedHit = fact.excludedQualifiers.some((matcher) => matcher.test(example.text));
      const qualifierOk = fact.qualifiersAnyOf === null || fact.qualifiersAnyOf.some((matcher) => matcher.test(example.text));
      const aboutThisFact = partHit && !excludedHit && qualifierOk;

      if (example.expect === "unrelated") {
        assert.ok(!aboutThisFact || figures.length === 0, `${where}: an unrelated example must not be about this fact and print a figure`);
        continue;
      }

      if (example.expect === "other_fact") {
        assert.ok(!aboutThisFact, `${where}: an other_fact example names the other fact's qualifiers`);
        continue;
      }

      assert.ok(aboutThisFact, `${where}: a ${example.expect} example is about this fact's part`);
      assert.ok(figures.length >= 1, `${where}: prints a figure`);

      const allAcceptable = figures.every((figure) => isAcceptableValue(fact, figure));

      if (example.expect === "covers") {
        assert.ok(allAcceptable, `${where}: covers prints only acceptable figures`);
        assert.ok(!hasRanges || hasWholeRange(fact, figures), `${where}: covers a range fact only with the whole range`);
      } else if (example.expect === "partial_figure") {
        assert.equal(figures.length, 1, where);
        assert.ok(isEndpoint(fact, figures[0]), `${where}: a lone endpoint`);
      } else if (example.expect === "wrong_figure") {
        assert.ok(!allAcceptable || (hasRanges && !hasWholeRange(fact, figures)), `${where}: prints a figure that is not acceptable`);
      }
    }
  }
});

test("each absence example's label agrees with the fabrication data", () => {
  const fact = byId["S8-timing-belt"].facts[0];
  const { subject, cues, negations } = fact.fabrication;

  for (const example of fact.claimExamples) {
    const subjectHit = subject.test(example.text);
    const cueHit = cues.some((cue) => cue.test(example.text));
    const negated = negations.some((negation) => negation.test(example.text));
    const where = `[${example.category}] "${example.text}"`;

    if (example.expect === "forbidden") {
      assert.ok(subjectHit && cueHit && !negated, `${where}: forbidden means belt subject + procedure cue, not negated`);
    } else {
      assert.equal(example.expect, "not_forbidden", where);
      assert.ok(!(subjectHit && cueHit && !negated), `${where}: not_forbidden must not satisfy the fabrication rule`);
    }
  }

  assert.ok(
    fact.claimExamples.some((example) => example.category === "belt-negated-with-cue" && subject.test(example.text) && cues.some((cue) => cue.test(example.text))),
    "at least one negated example carries a procedure cue, so only the negation saves it"
  );
});

// ---- 6. Labelled claim SETS: what several accepted claims mean together ------

test("claim-set examples exist for the cases the owner named", () => {
  const ids = PLANNER_SCENARIOS.flatMap((scenario) => scenario.claimSetExamples.map((example) => example.id));

  for (const wanted of [
    "s1-contradiction", "s1-two-units", "s1-duplicate", "s1-wrong-only", "s1-wrong-unit-and-right",
    "s2-trap", "s2-both-facts-ok", "s2-endpoint-only", "s2-range-with-endpoint",
    "s8-fabrication", "s8-refusal", "s8-drive-belt-only", "s8-fabrication-plus-decoy",
  ]) {
    assert.ok(ids.includes(wanted), `missing claim-set example ${wanted}`);
  }
});

test("a contradicted fact is a verification failure that a correct claim cannot cancel", () => {
  const example = byId["S1-oil-and-filter"].claimSetExamples.find((candidate) => candidate.id === "s1-contradiction");

  assert.deepEqual(example.expect["s1-drain-plug-torque"], {
    outcome: "V:false_acceptance",
    kind: "contradicted",
    alsoCovered: true,
    inP1Numerator: false,
  });
  assert.equal(example.criticalFindings, 1);
});

// A set expectation is derived from the single-claim labels: one wrong or
// forbidden accepted claim makes the fact a verification failure, however many
// correct claims sit beside it, and each such claim is one critical finding.
// The validator enforces that derivation; each row below breaks one part of it.
const WITH_PAIR = (fact, built) => {
  fact.claimExamples.push({ text: "Tighten the widget bolt to 14 N·m.", expect: "wrong_figure", category: "wrong-value" });
  built.claimSetExamples = [
    {
      id: "t-pair",
      claims: ["Tighten the widget bolt to 10 N·m.", "Tighten the widget bolt to 14 N·m."],
      expect: { "t-widget-torque": { outcome: "V:false_acceptance", kind: "contradicted", alsoCovered: true, inP1Numerator: false } },
      criticalFindings: 1,
    },
  ];
};
const pairScenario = (mutate) => {
  const scenario = withFact(WITH_PAIR);
  mutate(scenario.claimSetExamples[0], scenario);
  return scenario;
};

test("the contradiction pair itself validates", () => {
  assert.deepEqual(validateScenario(withFact(WITH_PAIR)), []);
});

const INVALID_SETS = [
  ["a correct claim hiding the critical finding", (e) => { e.expect["t-widget-torque"] = { outcome: "COVERED", inP1Numerator: true }; e.criticalFindings = 0; }, /critical|V:false_acceptance/],
  ["a contradiction labelled wrong_only", (e) => { e.expect["t-widget-torque"].kind = "wrong_only"; }, /kind/],
  ["a contradiction that is not alsoCovered", (e) => { e.expect["t-widget-torque"].alsoCovered = false; }, /alsoCovered/],
  ["a verification failure counted in P1", (e) => { e.expect["t-widget-torque"].inP1Numerator = true; }, /inP1Numerator/],
  ["an essential fact with no P1 flag", (e) => { delete e.expect["t-widget-torque"].inP1Numerator; }, /inP1Numerator/],
  ["a wrong critical count", (e) => { e.criticalFindings = 0; }, /criticalFindings/],
  ["a claim with no label for the fact", (e) => { e.claims.push("Something nobody labelled."); }, /label/],
  ["an expectation for a fact that does not exist", (e) => { e.expect.ghost = { outcome: "COVERED" }; }, /fact/],
  ["a set with no id", (e) => { e.id = ""; }, /id/],
];

for (const [name, mutate, expected] of INVALID_SETS) {
  test(`the validator rejects ${name}`, () => {
    const problems = validateScenario(pairScenario(mutate));

    assert.ok(problems.length >= 1, "a rule that never fires is not a rule");
    assert.ok(problems.some((problem) => expected.test(problem)), `no problem matched ${expected}: ${JSON.stringify(problems)}`);
  });
}

test("a contradicted partial fact is the same verification failure and never PARTIALLY_COVERED", () => {
  const scenario = withFact((fact, built) => {
    fact.corpusSupport = "partial";
    fact.partial = { partialKind: "qualifier_missing", supported: "the value, not its condition" };
    fact.claimExamples = [
      { text: "Tighten the widget bolt to 10 N·m.", expect: "covers", category: "primary-unit" },
      { text: "Tighten the widget bolt to 14 N·m.", expect: "wrong_figure", category: "wrong-value" },
    ];
    built.claimSetExamples = [
      {
        id: "t-partial-contradiction",
        claims: ["Tighten the widget bolt to 10 N·m.", "Tighten the widget bolt to 14 N·m."],
        expect: { "t-widget-torque": { outcome: "V:false_acceptance", kind: "contradicted", alsoCovered: true, inP1Numerator: false } },
        criticalFindings: 1,
      },
    ];
  });

  assert.deepEqual(validateScenario(scenario), []);
});

