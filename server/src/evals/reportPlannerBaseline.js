// The baseline report (docs/planner-eval-spec.md, section 11; Phase 5): Tables 0 to
// 3, the critical-findings line, the one-line invariants and operations totals, and
// the REQUIRED block "verified/ready plans lacking essential confirmed facts".
//
// It reads a planner capture (plannerCapture.js) and judges every run with the
// judge (plannerJudge.js). It is PURE and offline: no model, no retriever, no
// network, no database, and it imports neither config.js nor database.js.
//
// TWO OUTPUTS FROM ONE ANALYSIS, so nothing is hand-typed:
//
//   report   aggregates only: counts, ids, statuses, reason codes, the short
//            concept names the scenarios already carry. NEVER a claim, a quote, or
//            a passage. The printed report and the committed log section are both
//            rendered from this object ALONE, which is how the log cannot quote a
//            manual: the formatters are never handed anything that holds one.
//   perRun   every run with its full judgment, claims and quotes included. That
//            quotes real manual text, so it goes only to the gitignored
//            server/data/captures/ (buildPerRunJson).
//
// WHAT THE REQUIRED BLOCK IS FOR. `verified` and `ready` are the planner's own
// words, and one grounded sentence per task can earn both (spec F1, F2). So the
// block asks the question the planner's labels cannot answer: of the plans that
// carry those words, how many omit a confirmed essential fact? Rules, from the spec:
//
//   - a run counts if EITHER `verified` or `ready` applies (ready in either
//     acknowledgment state), and its own words are printed, never re-labelled;
//   - C is printed even when it is 0;
//   - a run in a scenario with no essential confirmed fact is NOT assessable (D):
//     it is counted and the scenario named, so it can never read as complete.
//
// FAIL CLOSED. Every confirmed fact of every run must land in exactly one outcome
// (I-7). If it does not -- or a table's columns do not add up to confirmed facts
// times runs -- the report refuses to print rather than print a number it cannot
// stand behind.

import { estimateSpend } from "./plannerCaptureSession.js";
import { judgeRun, reconcileFactLedger } from "./plannerJudge.js";
import { SCENARIO_SET_VERSION, getPlannerScenario, isScorable } from "./plannerScenarios.js";

/** The report would not be trustworthy, so it was not built. */
export class BaselineReportRefused extends Error {
  /**
   * @param {string} message
   * @param {string[]} [problems]
   */
  constructor(message, problems = []) {
    super(message);
    this.name = "BaselineReportRefused";
    this.problems = problems;
  }
}

export const PER_RUN_FORMAT = "corolla-fix-helper/planner-baseline";
export const PER_RUN_VERSION = 1;

/** The hard invariants a single recorded run can check (spec 7.2). The rest are asserted by the test suite. */
const CAPTURE_INVARIANTS = ["I-1", "I-2", "I-3", "I-4", "I-7"];
const LEVELS = ["ready", "almost_ready", "not_ready"];
/** An outcome that satisfies an essential fact: the figure was stated, or the absence was respected. */
const SATISFIED = new Set(["COVERED", "CORRECTLY_ABSENT"]);
const NO_SCENARIO = Object.freeze({ id: null, facts: [] });
const NO_SCENARIO_LABEL = "(no scenario)";

// ---- Small helpers ----------------------------------------------------------------------

const plural = (count, singular, pluralForm = `${singular}s`) => (count === 1 ? singular : pluralForm);
const sum = (values) => values.reduce((total, value) => total + value, 0);
const idOf = (record) => record.run.scenarioId ?? NO_SCENARIO_LABEL;
const levelOf = (record) => record.run.outputs?.readiness?.level ?? null;
const acknowledgedLevelOf = (record) => record.captured?.readinessAcknowledged?.level ?? null;

/** @param {Array<"unscored" | { covered: number, total: number }>} values */
function summarizeRatios(values) {
  const scored = /** @type {Array<{ covered: number, total: number }>} */ (values.filter((value) => value !== "unscored"));

  if (scored.length === 0) {
    return "unscored";
  }
  const sorted = [...scored].sort((a, b) => a.covered / a.total - b.covered / b.total);

  return { min: sorted[0], median: sorted[Math.floor((sorted.length - 1) / 2)], max: sorted[sorted.length - 1], runs: scored.length };
}

/** @param {any} summary */
function describeRatios(summary) {
  if (summary === "unscored") {
    return "unscored";
  }
  const show = (ratio) => `${ratio.covered}/${ratio.total}`;

  return show(summary.min) === show(summary.max)
    ? show(summary.min)
    : `${show(summary.min)} .. ${show(summary.max)} (med ${show(summary.median)})`;
}

/** @param {Array<number | "unscored">} values */
function sumOrUnscored(values) {
  const numbers = /** @type {number[]} */ (values.filter((value) => typeof value === "number"));

  return numbers.length === 0 ? "unscored" : sum(numbers);
}

/** A critical finding as an identifier, never as the judge's prose, which can carry a claim's figures. */
function safeCritical(text) {
  const invariant = /^(INVARIANT \S+ FAILED)/.exec(text);

  return invariant ? invariant[1] : text;
}

// ---- Building the analysis ----------------------------------------------------------------

/** Why a judgment's fact ledger cannot be trusted, or an empty list. */
function ledgerProblems(judgment, scenario) {
  const problems = reconcileFactLedger({ facts: judgment.facts ?? [] }, scenario ?? NO_SCENARIO);
  const reported = judgment.invariants?.["I-7"];

  if (reported?.status === "fail") {
    problems.push(...(reported.problems?.length ? reported.problems : ["the judge reports I-7 failed"]));
  }
  return [...new Set(problems)];
}

/** @param {any} judgment @param {string} factId */
const factOutcome = (judgment, factId) => judgment.facts.find((entry) => entry.factId === factId)?.outcome ?? null;

/**
 * Judge every run and aggregate.
 *
 * @param {{
 *   header: any, records: any[], source?: string,
 *   judge?: (run: any, scenario: any) => any,
 *   resolveScenario?: (id: string) => any,
 * }} input
 */
export function buildBaselineReport({
  header,
  records,
  source = "capture",
  judge = judgeRun,
  resolveScenario = getPlannerScenario,
}) {
  const perRun = records.map((record) => {
    const scenario = record.run.scenarioId ? resolveScenario(record.run.scenarioId) ?? null : null;

    return { record, scenario, judgment: judge(record.run, scenario) };
  });

  // I-7, checked here from the ledger itself and not only from what the judge says.
  const refusals = perRun.flatMap(({ record, scenario, judgment }) =>
    ledgerProblems(judgment, scenario).map((problem) => `${idOf(record)} repeat ${record.run.repeat ?? 1}: ${problem}`)
  );

  if (refusals.length > 0) {
    throw new BaselineReportRefused(
      `Not printing the report: a confirmed fact does not land in exactly one outcome (I-7). First problem: ${refusals[0]}`,
      refusals
    );
  }

  /** @type {Map<string, typeof perRun>} */
  const groups = new Map();

  for (const entry of perRun) {
    const id = idOf(entry.record);

    groups.set(id, [...(groups.get(id) ?? []), entry]);
  }

  const table1 = [];
  const table2 = [];
  /** @type {Record<string, number>} */ const reasons = {};
  /** @type {Array<{ scenarioId: string, repeat: number, factId: string, reasons: string[] }>} */ const falseRejections = [];

  for (const [scenarioId, entries] of groups) {
    const scenario = entries[0].scenario;
    const scored = scenario ? scenario.facts.filter(isScorable) : [];
    const supports = [...new Set(scored.map((fact) => fact.corpusSupport))].sort();
    const levels = { ready: 0, almost_ready: 0, not_ready: 0 };
    const levelsAcknowledged = { ready: 0, almost_ready: 0, not_ready: 0 };
    const evidence = { verified: 0, partial: 0, not_found: 0, noPlan: 0 };

    for (const { record } of entries) {
      const status = record.run.outcome?.evidenceStatus;

      if (status === "verified" || status === "partial" || status === "not_found") {
        evidence[status] += 1;
      } else {
        evidence.noPlan += 1;
      }
      if (LEVELS.includes(levelOf(record))) {
        levels[levelOf(record)] += 1;
        levelsAcknowledged[LEVELS.includes(acknowledgedLevelOf(record)) ? acknowledgedLevelOf(record) : levelOf(record)] += 1;
      }
    }

    const metrics = entries.map(({ judgment }) => judgment.metrics);

    table1.push({
      scenarioId,
      runs: entries.length,
      corpusSupport: supports.length > 0 ? supports.join("/") : "unscored",
      evidence,
      levels,
      levelsAcknowledged,
      C1: describeRatiosCell(summarizeRatios(metrics.map((metric) => metric.C1))),
      P1: describeRatiosCell(summarizeRatios(metrics.map((metric) => metric.P1))),
      // No golden tool and no model-grounded safety fact exists in the committed facts yet.
      T1: "unscored",
      W2: "unscored",
      U1: {
        submitted: sum(metrics.map((metric) => metric.U1.submitted)),
        rejected: sum(metrics.map((metric) => metric.U1.rejected)),
        falseAcceptances: sum(metrics.map((metric) => metric.U4.falseAcceptances)),
        falseRejections: sum(metrics.map((metric) => metric.U4.falseRejections)),
      },
      critical: {
        P2: sumOrUnscored(metrics.map((metric) => metric.P2)),
        P3: sumOrUnscored(metrics.map((metric) => metric.P3)),
        falseAcceptances: sum(metrics.map((metric) => metric.U4.falseAcceptances)),
      },
    });

    /** @type {Record<string, number>} */ const outcomes = {};

    for (const { record, judgment } of entries) {
      for (const fact of judgment.facts.filter((entry) => entry.scoring === "scored")) {
        outcomes[fact.outcome] = (outcomes[fact.outcome] ?? 0) + 1;

        if (fact.outcome === "V:false_rejection") {
          falseRejections.push({ scenarioId, repeat: record.run.repeat ?? 1, factId: fact.factId, reasons: fact.reasons ?? [] });
        }
      }
      for (const [reason, count] of Object.entries(judgment.metrics.U2 ?? {})) {
        reasons[reason] = (reasons[reason] ?? 0) + /** @type {number} */ (count);
      }
    }
    table2.push({
      scenarioId,
      runs: entries.length,
      factsScored: scored.length,
      total: sum(Object.values(outcomes)),
      outcomes,
    });
  }

  // The columns must add up to confirmed facts times runs, or the table is wrong.
  const unbalanced = table2.filter((row) => row.total !== row.factsScored * row.runs);

  if (unbalanced.length > 0) {
    const row = unbalanced[0];

    throw new BaselineReportRefused(
      `Not printing the report: Table 2 for ${row.scenarioId} holds ${row.total} outcomes for ${row.factsScored} confirmed fact(s) x ${row.runs} run(s).`,
      unbalanced.map((entry) => entry.scenarioId)
    );
  }

  const block = buildBlock(perRun);
  const critical = perRun.flatMap(({ record, judgment }) =>
    (judgment.critical ?? []).map((text) => ({ scenarioId: idOf(record), repeat: record.run.repeat ?? 1, text: safeCritical(text) }))
  );
  const invariantFailures = perRun.flatMap(({ record, judgment }) =>
    CAPTURE_INVARIANTS.filter((id) => judgment.invariants?.[id]?.status === "fail").map((id) => ({
      scenarioId: idOf(record),
      repeat: record.run.repeat ?? 1,
      id,
    }))
  );
  const invariantChecks = sum(
    perRun.map(({ judgment }) => CAPTURE_INVARIANTS.filter((id) => ["pass", "fail"].includes(judgment.invariants?.[id]?.status)).length)
  );
  const metricsOf = perRun.map(({ judgment }) => judgment.metrics.O1);
  const providerRequests = sum(
    perRun.map(({ record }) => record.session?.providerRequests ?? record.run.turns.length + record.run.retrievals.length)
  );
  const unscoredCells = table1.flatMap((row) =>
    ["C1", "P1", "T1", "W2"].filter((column) => row[column] === "unscored").map((column) => `${row.scenarioId} ${column}`)
  );

  const scenarios = [...new Map(perRun.filter((entry) => entry.scenario).map((entry) => [entry.scenario.id, entry.scenario])).values()];
  const factsConfirmed = sum(scenarios.map((scenario) => scenario.facts.filter(isScorable).length));
  const factsUnconfirmed = sum(scenarios.map((scenario) => scenario.facts.filter((fact) => !isScorable(fact)).length));
  const notComparable = [
    ...(header.dirty ? ["the code had uncommitted changes"] : []),
    ...(typeof header.scenarioSetVersion === "number" && header.scenarioSetVersion !== SCENARIO_SET_VERSION
      ? [`the scenario data changed (capture v${header.scenarioSetVersion}, current v${SCENARIO_SET_VERSION})`]
      : []),
  ];

  const report = {
    source,
    identity: {
      capturedAt: header.capturedAt,
      revision: header.revision,
      dirty: header.dirty,
      notComparable,
      instructionsHash: header.instructionsHash,
      config: header.config,
      scenarioSetVersion: header.scenarioSetVersion,
      currentScenarioSetVersion: SCENARIO_SET_VERSION,
      factsConfirmed,
      factsUnconfirmed,
      corpus: header.corpus,
      vehicleProfile: header.vehicleProfile,
      repeats: header.repeats,
      limits: header.limits,
      runs: records.length,
      providerRequests,
      rateLimitedRuns: perRun.filter(({ record }) => (record.session?.attempts ?? 1) > 1).length,
      limitReachedRuns: perRun.filter(({ record }) => record.session?.limitReached === true).length,
      tokens: null,
      estimate: estimateSpend({ runs: records.length, maxOutputTokens: header.config?.maxOutputTokens ?? 2048 }),
    },
    runCount: records.length,
    critical,
    block,
    table1,
    table2,
    table3: { reasons, falseRejections },
    invariants: { checked: invariantChecks, failures: invariantFailures },
    operations: {
      runs: records.length,
      noPlan: table1.reduce((total, row) => total + row.evidence.noPlan, 0),
      modelTurns: sum(metricsOf.map((metric) => metric.modelTurns)),
      toolCalls: sum(metricsOf.map((metric) => metric.toolCalls)),
      searches: sum(metricsOf.map((metric) => metric.searches)),
      retrievals: sum(metricsOf.map((metric) => metric.retrievals)),
      finalizerCorrections: sum(metricsOf.map((metric) => metric.finalizerCorrections)),
      providerRequests,
    },
    unscored: { cells: unscoredCells.length, which: unscoredCells },
    unscoredAcceptances: sum(
      perRun.map(({ judgment }) => judgment.claims.filter((claim) => claim.classification === "unscored_acceptance").length)
    ),
  };

  return { header, report, perRun };
}

/** @param {any} summary */
function describeRatiosCell(summary) {
  return summary === "unscored" ? "unscored" : { text: describeRatios(summary), ...summary };
}

/**
 * The required block's numbers (spec section 11).
 *
 * @param {Array<{ record: any, scenario: any, judgment: any }>} perRun
 */
function buildBlock(perRun) {
  const block = {
    runs: perRun.length,
    total: 0,
    assessable: 0,
    covered: 0,
    lacking: 0,
    notAssessable: 0,
    lackingRuns: /** @type {any[]} */ ([]),
    notAssessableScenarios: /** @type {Record<string, number>} */ ({}),
    // Scenarios and essential facts behind the "covered" count, and the scenarios
    // that say outright that completeness is unassessed. "Covered" is a statement
    // about these few confirmed facts, never about the repair procedure.
    coveredScenarios: /** @type {string[]} */ ([]),
    coveredFactIds: /** @type {string[]} */ ([]),
    caveatScenarios: /** @type {string[]} */ ([]),
  };

  for (const { record, scenario, judgment } of perRun) {
    const evidenceStatus = record.run.outcome?.evidenceStatus ?? null;
    const level = levelOf(record);
    const levelAcknowledged = acknowledgedLevelOf(record);

    // Either word applies. The planner's own words are used, never re-labelled.
    if (!(evidenceStatus === "verified" || level === "ready" || levelAcknowledged === "ready")) {
      continue;
    }
    block.total += 1;

    const essential = scenario ? scenario.facts.filter((fact) => isScorable(fact) && fact.essential === true) : [];

    if (essential.length === 0) {
      block.notAssessable += 1;
      block.notAssessableScenarios[idOf(record)] = (block.notAssessableScenarios[idOf(record)] ?? 0) + 1;
      continue;
    }
    block.assessable += 1;

    const uncovered = essential
      .filter((fact) => !SATISFIED.has(factOutcome(judgment, fact.id)))
      .map((fact) => ({ factId: fact.id, concept: fact.concept ?? "", outcome: factOutcome(judgment, fact.id) }));

    if (uncovered.length === 0) {
      block.covered += 1;

      if (!block.coveredScenarios.includes(scenario.id)) {
        block.coveredScenarios.push(scenario.id);
        block.coveredFactIds.push(...essential.map((fact) => fact.id));
      }

      const unassessed = (scenario.unassessedAreas ?? []).some((area) => area.id === "procedure-completeness");

      if (unassessed && !block.caveatScenarios.includes(scenario.id)) {
        block.caveatScenarios.push(scenario.id);
      }
    } else {
      block.lacking += 1;
      block.lackingRuns.push({
        scenarioId: idOf(record),
        repeat: record.run.repeat ?? 1,
        evidenceStatus,
        level,
        levelAcknowledged,
        uncovered,
      });
    }
  }
  return block;
}

// ---- Rendering ------------------------------------------------------------------------------

/** @param {string[]} headers @param {string[][]} rows */
function table(headers, rows) {
  const clean = (cell) => String(cell).replace(/\|/g, "/");

  return [
    `| ${headers.map(clean).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(clean).join(" | ")} |`),
  ];
}

const usd = (value) => `$${value.toFixed(2)}`;
const countText = (counts, keys) => keys.map(([key, label]) => `${label} ${counts[key]}`).join(", ");

function renderBlock(block) {
  const width = 78;
  const row = (label, value, suffix = "") => `${label.padEnd(width)}${value}${suffix}`;
  const lines = [
    "VERIFIED/READY PLANS LACKING ESSENTIAL CONFIRMED FACTS",
    `  runs with evidenceStatus verified, or level ready (unacknowledged or acknowledged): ${block.total} of ${block.runs}`,
    row("    assessable (>= 1 essential confirmed fact exists for the scenario):", block.assessable),
    row("      covered every essential confirmed fact:", block.covered),
  ];

  // Printed whenever any run is counted as covered, whatever the scenario data says:
  // covering the few confirmed facts is not completeness of the repair.
  if (block.covered > 0) {
    const facts = block.coveredFactIds.length;
    const scenarios = block.coveredScenarios.length;

    lines.push(
      `        Covered means the CONFIRMED essential facts only (${facts} ${plural(facts, "fact")} across ${scenarios} ${plural(scenarios, "scenario")}: ${block.coveredScenarios.join(", ")}). ` +
        "It does not mean the repair procedure is complete: a covered run is not shown to be complete."
    );
  }
  if (block.caveatScenarios.length > 0) {
    lines.push(
      `        ${block.caveatScenarios.join(", ")} ${plural(block.caveatScenarios.length, "lists", "list")} procedure-completeness as unassessed.`
    );
  }
  lines.push(row("      lacking >= 1 essential confirmed fact:", block.lacking, "   <- the finding"));

  for (const run of block.lackingRuns) {
    const level =
      run.levelAcknowledged && run.levelAcknowledged !== run.level
        ? `${run.level} / ${run.levelAcknowledged} once acknowledged`
        : `${run.level}`;
    const uncovered = run.uncovered.map((fact) => (fact.concept ? `${fact.factId} (${fact.concept})` : fact.factId)).join("; ");

    lines.push(`        ${run.scenarioId} repeat ${run.repeat}: evidenceStatus ${run.evidenceStatus}, level ${level}; uncovered: ${uncovered}`);
  }

  lines.push(
    "    NOT assessable (no essential confirmed fact exists yet, so completeness is",
    row('      unknown, never "complete"):', block.notAssessable)
  );
  for (const [scenarioId, count] of Object.entries(block.notAssessableScenarios)) {
    lines.push(`        ${scenarioId}: ${count} ${plural(count, "run")}`);
  }
  return ["```text", ...lines, "```"];
}

/** @param {any} identity */
function renderTable0(identity) {
  const config = identity.config ?? {};
  const corpus = identity.corpus
    ? `${identity.corpus.documents} documents, ${identity.corpus.chunks} chunks, embedding version ${config.embeddingVersion ?? "unknown"}, DB snapshot MD5 ${identity.corpus.dbSnapshotMd5}`
    : "not recorded";
  const vehicle = identity.vehicleProfile
    ? `engine ${identity.vehicleProfile.engineCode ?? "not saved"}, build plant ${identity.vehicleProfile.buildPlant ?? "not saved"}`
    : "not recorded";
  const comparable =
    identity.notComparable.length === 0 ? "comparable on its face" : `NOT COMPARABLE (${identity.notComparable.join("; ")})`;
  const requestText = `${identity.providerRequests} provider ${plural(identity.providerRequests, "request")}`;
  const extras = [
    identity.rateLimitedRuns ? `${identity.rateLimitedRuns} ${plural(identity.rateLimitedRuns, "run")} retried after a 429` : null,
    identity.limitReachedRuns ? `${identity.limitReachedRuns} ${plural(identity.limitReachedRuns, "run")} cut by the request limit` : null,
  ].filter(Boolean);

  return table(
    ["Field", "Value"],
    [
      ["Capture", `${identity.capturedAt}, ${identity.source ?? ""}`.replace(/, $/, "")],
      ["Revision / dirty", `${identity.revision} / ${identity.dirty ? "uncommitted changes" : "clean"}: ${comparable}`],
      ["Model / reasoning effort / max output tokens", `${config.answerModel} / ${config.reasoningEffort ?? "none"} / ${config.maxOutputTokens}`],
      ["instructionsHash", identity.instructionsHash],
      ["Config snapshot", Object.entries(config).map(([key, value]) => `${key}=${value}`).join(", ")],
      [
        "Scenarios",
        `scenarioSetVersion ${identity.scenarioSetVersion ?? "unknown"} (current ${identity.currentScenarioSetVersion}); ${identity.factsConfirmed} confirmed, ${identity.factsUnconfirmed} unconfirmed ${plural(identity.factsConfirmed + identity.factsUnconfirmed, "fact")}`,
      ],
      ["Corpus", corpus],
      ["Variant details at run time", vehicle],
      [
        "Repeats, runs, requests, tokens, spend",
        `repeats ${identity.repeats ?? "unknown"}, ${identity.runs} ${plural(identity.runs, "run")}, ${requestText}, tokens not recorded (the usage tee is deferred, D9), ` +
          `estimated spend about ${usd(identity.estimate.typicalUsd)} (${identity.estimate.label} from a price table as of ${identity.estimate.priceAsOf}, not measured: read dollars from the OpenAI dashboard)` +
          (extras.length ? `; ${extras.join("; ")}` : ""),
      ],
    ]
  );
}

function renderTable1(rows) {
  const cell = (value) => (value === "unscored" ? "unscored" : value.text);

  return table(
    [
      "Scenario",
      "Corpus support",
      "Evidence status (v/p/n)",
      "Level counts",
      "C1",
      "P1",
      "T1 recall",
      "W2",
      "U1 claims rejected/submitted",
      "Critical (P2, P3, false acc.)",
    ],
    rows.map((row) => {
      const levels = countText(row.levels, [["ready", "ready"], ["almost_ready", "almost"], ["not_ready", "not"]]);
      const acknowledged = countText(row.levelsAcknowledged, [["ready", "ready"], ["almost_ready", "almost"], ["not_ready", "not"]]);

      return [
        row.scenarioId,
        row.corpusSupport,
        `v${row.evidence.verified} p${row.evidence.partial} n${row.evidence.not_found}${row.evidence.noPlan ? `, no plan ${row.evidence.noPlan}` : ""}`,
        acknowledged === levels ? levels : `${levels} (acknowledged: ${acknowledged})`,
        cell(row.C1),
        cell(row.P1),
        row.T1,
        row.W2,
        `${row.U1.rejected}/${row.U1.submitted} claims (false acc ${row.U1.falseAcceptances}, false rej ${row.U1.falseRejections})`,
        `P2 ${row.critical.P2}, P3 ${row.critical.P3}, false acc ${row.critical.falseAcceptances}`,
      ];
    })
  );
}

/** @type {Array<[string, (outcome: string) => boolean]>} */
const TABLE2_COLUMNS = [
  ["Covered", (outcome) => outcome === "COVERED"],
  ["Partial", (outcome) => outcome === "PARTIALLY_COVERED"],
  ["Correctly absent", (outcome) => outcome === "CORRECTLY_ABSENT"],
  ["S", (outcome) => outcome.startsWith("S:")],
  ["R", (outcome) => outcome.startsWith("R:")],
  ["G: query", (outcome) => outcome === "G:query_formulation"],
  ["G: omission", (outcome) => outcome === "G:omission"],
  ["G: no_search", (outcome) => outcome === "G:no_search"],
  ["G: run_failure", (outcome) => outcome === "G:run_failure"],
  ["L0", (outcome) => outcome.startsWith("L0:")],
  ["V: false rejection", (outcome) => outcome === "V:false_rejection"],
  ["V: false acceptance", (outcome) => outcome === "V:false_acceptance"],
  ["I", (outcome) => outcome.startsWith("I:")],
  ["Undetermined", (outcome) => outcome === "UNDETERMINED"],
  ["Refused", (outcome) => outcome === "REFUSED"],
];

function renderTable2(rows) {
  return table(
    ["Scenario", "Confirmed facts x runs", ...TABLE2_COLUMNS.map(([label]) => label)],
    rows.map((row) => [
      row.scenarioId,
      `${row.factsScored} x ${row.runs} = ${row.total}`,
      ...TABLE2_COLUMNS.map(([, matches]) =>
        String(sum(Object.entries(row.outcomes).filter(([outcome]) => matches(outcome)).map(([, count]) => /** @type {number} */ (count))))
      ),
    ])
  );
}

/**
 * The body both outputs share: everything below the title.
 *
 * @param {ReturnType<typeof buildBaselineReport>["report"]} report
 */
function renderBody(report) {
  const lines = [];
  const add = (...entries) => lines.push(...entries);
  const runsWithCritical = new Set(report.critical.map((entry) => `${entry.scenarioId}#${entry.repeat}`)).size;

  // Critical findings first, in capitals (spec 7.2).
  if (report.critical.length === 0) {
    add("CRITICAL FINDINGS: none.");
  } else {
    add(
      `CRITICAL FINDINGS: ${report.critical.length} (in ${runsWithCritical} ${plural(runsWithCritical, "run")}). ` +
        "Each is triaged by hand; none is ever used to loosen the verifier.",
      ""
    );
    for (const entry of report.critical) {
      add(`- ${entry.scenarioId} repeat ${entry.repeat}: ${entry.text}`);
    }
  }

  add("", ...renderBlock(report.block), "");

  add("### Table 0: identity and comparability", "", ...renderTable0({ ...report.identity, source: report.source }), "");
  add("### Table 1: per-scenario outcome", "", ...renderTable1(report.table1), "");
  add(
    "### Table 2: failure attribution",
    "",
    "Confirmed facts only, summed over the runs of each scenario. Every fact of every run is in exactly one column.",
    "",
    ...renderTable2(report.table2),
    ""
  );

  const reasonRows = Object.entries(report.table3.reasons).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  add("### Table 3: rejection reasons", "", ...table(["Reason", "Rejected claims"], reasonRows.length ? reasonRows.map(([reason, count]) => [reason, String(count)]) : [["none", "0"]]), "");

  // Two counts, two units: the facts line counts confirmed FACTS (Table 2's
  // column); the claims line counts rejected CLAIMS (Table 1's U4). They differ
  // whenever a rejected claim's fact was covered by another, accepted claim.
  if (report.table3.falseRejections.length === 0) {
    add("Confirmed facts whose outcome is V: false rejection (Table 2): none.");
  } else {
    add(
      "Confirmed facts whose outcome is V: false rejection (Table 2), each stated in text the model was shown, with no claim for it accepted, and the reasons its claims were rejected:"
    );
    for (const entry of report.table3.falseRejections) {
      add(`- ${entry.scenarioId} repeat ${entry.repeat}: ${entry.factId} (${entry.reasons.join(", ") || "no reason recorded"})`);
    }
  }

  const falseRejectedClaims = sum(report.table1.map((row) => row.U1.falseRejections));

  add(
    `Rejected claims the judge counts as false rejections (Table 1, U1): ${falseRejectedClaims}. ` +
      "These are claims, not facts: a rejected claim counts when it states a confirmed fact from text the model was shown, " +
      "and its fact is Covered, not V: false rejection, when another claim for that fact was accepted."
  );

  const failures = report.invariants.failures;

  add("");
  add(
    failures.length === 0
      ? `Invariants: all pass (${CAPTURE_INVARIANTS.join(", ")} over ${report.runCount} ${plural(report.runCount, "run")}, ${report.invariants.checked} checks; I-5, I-6 and I-8 are asserted by the test suite, not by a capture).`
      : `Invariants: ${failures.length} of ${report.invariants.checked} checks FAILED: ${failures.map((failure) => `${failure.id} (${failure.scenarioId} repeat ${failure.repeat})`).join(", ")}. Triage each by hand.`
  );

  const ops = report.operations;

  add(
    `Operations: ${ops.runs} ${plural(ops.runs, "run")}, ${ops.modelTurns} model turns, ${ops.toolCalls} tool calls, ${ops.searches} searches, ` +
      `${ops.retrievals} retrievals, ${ops.finalizerCorrections} finalizer ${plural(ops.finalizerCorrections, "correction")}, ` +
      `${ops.providerRequests} provider ${plural(ops.providerRequests, "request")}, ${ops.noPlan} ${plural(ops.noPlan, "run")} without a plan.`
  );

  add(
    "",
    "### How to read this report",
    "",
    `- ${report.identity.repeats ?? "An unknown number of"} repeat(s) per scenario, ${report.runCount} ${plural(report.runCount, "run")} in all. Where repeats differ the cell shows min .. max (med). This baseline is a characterization, not a statistical estimate.`,
    "- `verified`, `ready`, and a long plan are the planner's own labels. They are not quality words here: quality is read against the confirmed facts only.",
    "- A rejection rate is never shown without the false acceptances and false rejections beside it. Fewer rejections is not an improvement unless the critical findings and the false acceptances did not rise.",
    report.unscored.cells === 0
      ? "- No cell is unscored."
      : `- ${report.unscored.cells} ${plural(report.unscored.cells, "cell")} print \`unscored\` because the fact they depend on has not been confirmed: ${report.unscored.which.join(", ")}.`,
    `- Spot-check (spec 7.3): automated sampling is deferred (owner decision D9). ${report.unscoredAcceptances} accepted ${plural(report.unscoredAcceptances, "claim")} matched no confirmed fact; they are in the per-run JSON for review against the rendered PDF pages.`
  );

  return lines;
}

/**
 * The printed report: aggregates only.
 *
 * @param {ReturnType<typeof buildBaselineReport>["report"]} report
 */
export function formatBaselineReport(report) {
  return ["# Repair Planner baseline report", "", ...renderBody(report), ""].join("\n");
}

/**
 * The section to paste into docs/evals/planner-baseline-log.md: the same body
 * under a dated heading. Aggregates only, by construction.
 *
 * @param {ReturnType<typeof buildBaselineReport>["report"]} report
 */
export function formatBaselineLogSection(report) {
  const { revision, capturedAt, dirty } = report.identity;

  return [`## Baseline ${capturedAt.slice(0, 10)} at ${revision}${dirty ? " (uncommitted changes)" : ""}`, "", ...renderBody(report), ""].join("\n");
}

/**
 * Everything, claim-level detail included. This QUOTES REAL MANUAL TEXT: it goes
 * only to the gitignored server/data/captures/ and never into a committed file.
 *
 * @param {ReturnType<typeof buildBaselineReport>} analysis
 */
export function buildPerRunJson({ header, report, perRun }) {
  return {
    format: PER_RUN_FORMAT,
    version: PER_RUN_VERSION,
    notice: "This file quotes real manual text. Keep it out of git and out of committed docs.",
    header,
    report,
    runs: perRun.map(({ record, judgment }) => ({
      scenarioId: record.run.scenarioId ?? null,
      repeat: record.run.repeat ?? 1,
      line: record.line ?? null,
      session: record.session ?? null,
      readiness: { level: levelOf(record), levelAcknowledged: acknowledgedLevelOf(record) },
      judgment,
    })),
  };
}
