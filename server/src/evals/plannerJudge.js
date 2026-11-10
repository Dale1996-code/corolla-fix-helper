// The Repair Planner judge (docs/planner-eval-spec.md, Phase 2b; sections 5, 7
// and 16.1).
//
// It reads ONE recorded run (plannerCaseRunner.js) and the scenario it ran, and
// produces:
//
//   - a CLAIM ledger: one verdict per submitted claim (accepted or rejected, the
//     verifier's reason, which confirmed facts it bears on, and what that makes
//     it: covered, false acceptance, false rejection, ...);
//   - a FACT ledger: exactly one outcome per confirmed golden fact (I-7), by the
//     decision procedure of section 5.1;
//   - the metrics of section 7.1 that the committed facts can support, with
//     `unscored` wherever a metric would depend on an unconfirmed fact;
//   - the hard invariants of section 7.2 that a single record can check.
//
// It is PURE and offline. It imports the planner's own verifier and output
// builders, because re-verifying a captured run with the CURRENT code is the
// point (I-1, and Phase 3's replay), and those modules touch neither config nor
// a database. It never calls a model, a retriever, or the network.
//
// Three rules hold everywhere (owner decisions, section 16.1):
//
//   1. Only a CONFIRMED fact is scored. An unconfirmed one is reported as
//      `unscored` and can cause neither a pass nor a failure.
//   2. Unknown stays unknown. A survey field that is null is never read as
//      clean; a missed fact whose cause depends on it is UNDETERMINED, with the
//      missing fields named.
//   3. A correct claim never hides a critical finding. An accepted wrong figure
//      or fabrication makes the fact V:false_acceptance even beside a correct
//      claim, and such a fact counts in no success numerator.
//
// What the matcher can and cannot see is stated beside it. It is an oracle for
// the scenario data's labelled examples, which were written first; it is not a
// second verifier, and nothing it reports is ever used to loosen the real one
// (section 13, R10).

import { extractSpecNumbers } from "../services/askEvidenceContract.js";
import {
  assessTaskCoverage,
  buildRepairPlanEvidence,
  buildRequirementGroups,
  renderPlanText,
  validateFinalizerPayload,
  verifyClaims,
} from "../services/agent/repairPlanEvidenceContract.js";
import { buildPlannerChecklistDraft } from "../services/agent/plannerChecklistDraft.js";
import {
  buildOwnerChecklist,
  createSourceRegistry,
  draftHandoffNotes,
  parseInventory,
} from "../services/agent/repairTools.js";
import { isScorable } from "./plannerScenarios.js";

/** The vehicle label the agent prints by default (repairPlannerAgent.js). */
export const DEFAULT_VEHICLE_LABEL = "2009 Toyota Corolla LE 1.8L";

export const CLAIM_LABELS = [
  "covers",
  "partial_figure",
  "wrong_figure",
  "other_fact",
  "unrelated",
  "forbidden",
  "not_forbidden",
];

const OK_OUTCOMES = ["COVERED", "PARTIALLY_COVERED", "CORRECTLY_ABSENT"];

/** Every outcome a scored fact can have. `null` is the unscored fact's. */
export const FACT_OUTCOMES = [
  ...OK_OUTCOMES,
  "V:false_acceptance",
  "V:false_rejection",
  "G:omission",
  "G:no_search",
  "G:query_formulation",
  "G:run_failure",
  "R:retrieval_miss",
  "S:cap_truncated",
  "S:source_unusable",
  "L0:job_not_derived",
  "L0:no_canonical_task",
  "I:infrastructure",
  "UNDETERMINED",
  "REFUSED",
];

const WRONG_LABELS = new Set(["wrong_figure", "forbidden"]);
const SUPPORT_LABELS = new Set(["covers", "partial_figure"]);
const SEARCHED_DISPOSITIONS = new Set(["retrieved", "retriever_error", "empty_query"]);
const UNUSABLE_QUALITIES = new Set(["garbled", "flattened_table", "ocr_unusable", "truncated", "condition_missing"]);
const RUN_FAILURE_REASONS = new Set(["invalid_final_contract", "turn_limit", "malformed_tool_arguments", "empty_output"]);

/**
 * The layer an outcome belongs to: OK, V, G, R, S, L0, I, UNDETERMINED, or
 * REFUSED. UNDETERMINED is an attribution status, not a layer: it says the
 * evidence for choosing a layer is missing.
 *
 * @param {string | null} outcome
 */
export function layerOf(outcome) {
  if (outcome === null || outcome === undefined) {
    return null;
  }
  if (OK_OUTCOMES.includes(outcome)) {
    return "OK";
  }
  if (outcome === "UNDETERMINED" || outcome === "REFUSED") {
    return outcome;
  }
  return outcome.split(":")[0];
}

// ---- The claim matcher ---------------------------------------------------------

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const NUMBER = String.raw`(-?\d+(?:,\d{3})*(?:\.\d+)?)`;
// A figure never starts inside a word or another number: "2ZR" is a code.
const NUMBER_START = String.raw`(?<![\w.,])`;
const RANGE_JOIN = String.raw`\s*(?:to|-|–|—|~)\s*`;

const toNumber = (raw) => Number(raw.replace(/,/g, ""));
const same = (a, b) => Math.abs(a - b) < 1e-9;

/**
 * Every figure the claim states in one of the fact's declared units, as values
 * and ranges. A number with no declared unit after it is not read: the matcher
 * judges the fact's own specification, and a count or a step number is not one.
 * That is a known blind spot -- "tighten the drain plug to 45" states no unit
 * and is not flagged here -- left visible rather than guessed at.
 *
 * @param {string} text
 * @param {Array<{ canonical: string, aliases: string[] }>} units
 */
function parseFigures(text, units) {
  const spellings = units
    .flatMap((unit) => [unit.canonical, ...unit.aliases].map((spelling) => ({ spelling, canonical: unit.canonical })))
    .sort((a, b) => b.spelling.length - a.spelling.length);
  const unitPattern = spellings.map((entry) => escapeRegex(entry.spelling)).join("|");
  const canonicalOf = (found) =>
    spellings.find((entry) => entry.spelling.toLowerCase() === found.toLowerCase())?.canonical ?? null;
  const unitEnd = String.raw`(?![A-Za-z])`;

  /** @type {any[]} */
  const figures = [];
  let rest = String(text);

  const range = new RegExp(`${NUMBER_START}${NUMBER}${RANGE_JOIN}${NUMBER}\\s*(${unitPattern})${unitEnd}`, "gi");
  rest = rest.replace(range, (_match, low, high, unit) => {
    figures.push({ kind: "range", low: toNumber(low), high: toNumber(high), unit: canonicalOf(unit) });
    return " ";
  });

  const value = new RegExp(`${NUMBER_START}${NUMBER}\\s*(${unitPattern})${unitEnd}`, "gi");
  rest.replace(value, (_match, number, unit) => {
    figures.push({ kind: "value", value: toNumber(number), unit: canonicalOf(unit) });
    return " ";
  });

  return figures;
}

/** right | endpoint | wrong, for one figure against one fact's acceptable forms. */
function classifyFigure(figure, acceptable) {
  const forms = acceptable.filter((form) => form.unit === figure.unit);

  if (figure.kind === "range") {
    return forms.some((form) => form.kind === "range" && same(form.low, figure.low) && same(form.high, figure.high))
      ? "right"
      : "wrong";
  }
  if (forms.some((form) => form.kind === "value" && same(form.value, figure.value))) {
    return "right";
  }
  if (forms.some((form) => form.kind === "range" && (same(form.low, figure.value) || same(form.high, figure.value)))) {
    return "endpoint";
  }
  return "wrong";
}

function isDecoyFigure(figure, decoys) {
  return decoys.some((decoy) => {
    if (decoy.unit !== figure.unit) {
      return false;
    }
    if (decoy.kind === "range") {
      return figure.kind === "range" && same(decoy.low, figure.low) && same(decoy.high, figure.high);
    }
    return figure.kind === "value" && same(decoy.value, figure.value);
  });
}

const anyMatch = (matchers, text) => (matchers ?? []).some((matcher) => matcher.test(text));

function labelNumericClaim(text, fact) {
  if (!anyMatch(fact.partMatchers, text)) {
    return "unrelated";
  }
  // A qualifier that belongs to a sibling fact ("used", "maximum") makes the
  // claim about that fact, whatever its figure.
  if (anyMatch(fact.excludedQualifiers, text)) {
    return "other_fact";
  }

  const figures = parseFigures(text, fact.units);

  // A fact that needs a qualifier ("maximum ... used plug") is not what an
  // unqualified claim is about. If that claim's figures are exactly this
  // fact's decoys, it is stating the sibling fact; otherwise it is unrelated.
  if (fact.qualifiersAnyOf && !anyMatch(fact.qualifiersAnyOf, text)) {
    return figures.length > 0 && figures.every((figure) => isDecoyFigure(figure, fact.decoys ?? []))
      ? "other_fact"
      : "unrelated";
  }
  if (figures.length === 0) {
    return "unrelated";
  }

  const classes = figures.map((figure) => classifyFigure(figure, fact.acceptable));

  // One wrong figure is enough: "37 N·m (33 ft-lbf)" is a wrong claim, not a
  // half-right one, because the owner may work to either figure.
  if (classes.includes("wrong")) {
    return "wrong_figure";
  }
  return classes.includes("right") ? "covers" : "partial_figure";
}

const WORD = /[\p{L}\p{N}'-]+/gu;
const NEGATION_WINDOW = 3;

/**
 * A fabrication: a claim about the absent subject (a timing belt) that states
 * an action, interval, or mileage for it, where no negation comes in the three
 * words right before the subject.
 *
 * Any un-negated mention is enough. "There is no timing belt; replace the
 * timing belt every 90,000 miles" is still a fabrication.
 *
 * The rule's `decoys` (drive belt, timing chain, ...) are not read here: the
 * subject pattern can never match them, which a test checks, so a decoy cannot
 * trigger the rule. A negation AFTER the subject ("the timing belt is not
 * fitted; replace the chain") is not seen and reads as a fabrication -- the
 * safe direction, since a false critical finding is triaged by a human and a
 * missed one is not.
 */
function labelAbsenceClaim(text, fact) {
  const rule = fact.fabrication;
  const cleaned = String(text);

  if (!anyMatch(rule.cues, cleaned)) {
    return "not_forbidden";
  }

  const subject = new RegExp(rule.subject.source, `${rule.subject.flags.replace(/[gy]/g, "")}g`);

  for (const match of cleaned.matchAll(subject)) {
    const before = cleaned.slice(0, match.index).match(WORD) ?? [];
    const window = before.slice(-NEGATION_WINDOW).join(" ");

    if (!anyMatch(rule.negations, window)) {
      return "forbidden";
    }
  }
  return "not_forbidden";
}

function labelProcedureClaim(text, fact) {
  return (fact.stepMatchers ?? []).length > 0 && fact.stepMatchers.every((matcher) => matcher.test(text))
    ? "covers"
    : "unrelated";
}

/**
 * What one claim's text means for one golden fact.
 *
 * @param {string} text
 * @param {any} fact
 * @returns {string} one of CLAIM_LABELS
 */
export function labelClaimForFact(text, fact) {
  if (fact.kind === "absence") {
    return labelAbsenceClaim(text, fact);
  }
  if (fact.kind === "procedure_step") {
    return labelProcedureClaim(text, fact);
  }
  return labelNumericClaim(text, fact);
}

// ---- Claim sets -------------------------------------------------------------------

/** The numerator flag a fact carries, if it is in a success metric at all. */
function numeratorFlag(fact, outcome) {
  if (!fact.essential) {
    return {};
  }
  if (fact.kind === "numeric_spec") {
    return { inP1Numerator: outcome === "COVERED" };
  }
  if (fact.kind === "procedure_step") {
    return { inC1Numerator: outcome === "COVERED" };
  }
  return {};
}

/**
 * The outcome a set of ACCEPTED claims gives one fact, or null when no claim
 * bears on it (an omission, which only a whole run can attribute).
 *
 * @param {string[]} labels
 * @param {any} fact
 * @returns {any}
 */
function outcomeFromLabels(labels, fact) {
  const wrong = labels.filter((label) => WRONG_LABELS.has(label)).length;
  const covers = labels.filter((label) => label === "covers").length;
  const partial = labels.filter((label) => label === "partial_figure").length;

  if (fact.kind === "absence") {
    return wrong > 0
      ? { outcome: "V:false_acceptance", kind: "fabrication" }
      : { outcome: "CORRECTLY_ABSENT" };
  }
  if (wrong > 0) {
    const contradicted = covers > 0;
    return {
      outcome: "V:false_acceptance",
      kind: contradicted ? "contradicted" : "wrong_only",
      ...(contradicted ? { alsoCovered: true } : {}),
      ...numeratorFlag(fact, "V:false_acceptance"),
    };
  }
  if (covers > 0) {
    return { outcome: "COVERED", ...numeratorFlag(fact, "COVERED") };
  }
  if (partial > 0) {
    return { outcome: "PARTIALLY_COVERED", ...numeratorFlag(fact, "PARTIALLY_COVERED") };
  }
  return null;
}

/**
 * Judge a set of claim texts as if all were accepted: the labelled-set
 * examples of the scenario data. Only confirmed facts get an outcome.
 *
 * @param {string[]} claims
 * @param {any} scenario
 */
export function judgeClaimSet(claims, scenario) {
  /** @type {Record<string, any>} */
  const facts = {};
  const critical = new Set();

  for (const fact of scenario.facts.filter(isScorable)) {
    const labels = claims.map((text) => labelClaimForFact(text, fact));

    labels.forEach((label, index) => {
      if (WRONG_LABELS.has(label)) {
        critical.add(index);
      }
    });
    facts[fact.id] = outcomeFromLabels(labels, fact) ?? { outcome: null };
  }

  return { facts, criticalFindings: critical.size };
}

// ---- Re-verification ----------------------------------------------------------------

/**
 * Rebuild the evidence the agent built, with the CURRENT contract code, from
 * the payload and the chunks retrieved before it.
 *
 * @param {any} payload
 * @param {{ tasks: any[], chunks: any[], request: any }} context
 */
export function rebuildEvidence(payload, { tasks, chunks, request }) {
  const registry = createSourceRegistry();
  chunks.forEach((chunk) => registry.register(chunk));

  return buildRepairPlanEvidence(payload, {
    tasks,
    sources: registry.list(),
    availableTools: parseInventory(request?.availableTools ?? ""),
    availableParts: parseInventory(request?.availableParts ?? ""),
  });
}

const before = (retrieval, finalizer) =>
  retrieval.turn < finalizer.turn || (retrieval.turn === finalizer.turn && retrieval.callOrdinal < finalizer.callOrdinal);

/**
 * Every finalizer re-verified against the sources the agent held when it ran.
 * The agent keeps the LAST valid finalizer of the turn that ends the run.
 *
 * @param {any} record
 */
export function reverifyRun(record) {
  const tasks = record.tasks ?? [];
  const finalizers = (record.finalizers ?? []).map((finalizer) => {
    const chunks = (record.retrievals ?? [])
      .filter((retrieval) => Array.isArray(retrieval.results) && before(retrieval, finalizer))
      .flatMap((retrieval) => retrieval.results);
    const registry = createSourceRegistry();
    chunks.forEach((chunk) => registry.register(chunk));
    const sources = registry.list();
    const validation = validateFinalizerPayload(finalizer.arguments ?? {}, {
      tasks,
      sourceIds: new Set(sources.map((source) => source.id)),
    });
    const verified = validation.valid
      ? verifyClaims(validation.claims, { sourcesById: new Map(sources.map((source) => [source.id, source])), tasks })
      : { accepted: [], rejected: [] };

    return {
      turn: finalizer.turn,
      callOrdinal: finalizer.callOrdinal,
      valid: validation.valid,
      errors: validation.errors,
      claims: validation.claims,
      accepted: verified.accepted,
      rejected: verified.rejected,
      chunks,
      sources,
      payload: finalizer.arguments ?? {},
    };
  });

  let decisive = null;
  if (record.outcome?.status === "completed") {
    for (let index = finalizers.length - 1; index >= 0; index -= 1) {
      if (finalizers[index].valid) {
        decisive = index;
        break;
      }
    }
  }

  return { finalizers, decisive };
}

// ---- Task derivation (L0) ---------------------------------------------------------

/**
 * Which derived task answers which desired job, and which task answers none.
 * Scored only when every job is confirmed (owner decision 2b-3); the
 * observation is reported either way.
 *
 * @param {any[]} tasks
 * @param {any} scenario
 */
export function evaluateTaskDerivation(tasks, scenario) {
  const jobs = scenario.desiredJobs.decomposition.map((job) => ({
    id: job.id,
    confirmed: job.confirmed === true,
    taskIds: tasks.filter((task) => anyMatch(job.matchers, task.title ?? "")).map((task) => task.id),
  }));
  const claimed = new Set(jobs.flatMap((job) => job.taskIds));
  const phantomTaskIds = tasks.map((task) => task.id).filter((id) => !claimed.has(id));
  const scored = jobs.length > 0 && jobs.every((job) => job.confirmed);

  return {
    scoring: scored ? "scored" : "unscored",
    jobs,
    phantomTaskIds,
    premise: scenario.desiredJobs.premise?.status ?? null,
    defects: scored
      ? [
          ...jobs.filter((job) => job.taskIds.length === 0).map((job) => `job_not_derived:${job.id}`),
          ...phantomTaskIds.map((id) => `phantom_task:${id}`),
        ]
      : [],
  };
}

// ---- Evidence presence ------------------------------------------------------------

/** Sentences, split where a sentence-ending mark is followed by a capital. */
const sentencesOf = (text) => String(text ?? "").split(/(?<=[.!?;])\s+(?=[A-Z(])/);

/** True when some sentence of the text states the fact as the fact needs. */
function statesFact(text, fact) {
  return sentencesOf(text).some((sentence) => labelClaimForFact(sentence, fact) === "covers");
}

function onHintedSource(source, fact) {
  const hint = fact.sourceHint;
  if (!hint?.confirmed) {
    return false;
  }
  return hint.sources.some(
    (entry) => entry.titleLike.test(source.documentTitle ?? "") && entry.pages.includes(source.pageNumber)
  );
}

// ---- The run-level failure, if any ------------------------------------------------

function runFailureLayer(record) {
  const { status, reason } = record.outcome ?? {};

  if (status === "completed") {
    return null;
  }
  if (reason === "defeat_request") {
    return "REFUSED";
  }
  if (reason === "no_canonical_task") {
    return "L0:no_canonical_task";
  }
  // Checked before provider errors: a malformed tool argument arrives as a
  // typed stream error but is the model's output, not the network's.
  if (RUN_FAILURE_REASONS.has(reason)) {
    return "G:run_failure";
  }
  // Provider errors, truncated streams, aborts, a missing key, and anything
  // unexplained: not a product signal.
  return "I:infrastructure";
}

// ---- The fact ledger ----------------------------------------------------------------

function factLedgerEntry(fact, outcome, extras = {}) {
  return {
    factId: fact.id,
    factKind: fact.kind,
    essential: fact.essential === true,
    scoring: isScorable(fact) ? "scored" : "unscored",
    outcome,
    ...extras,
  };
}

/** UNDETERMINED for a missed fact whose survey fields are not all known. */
function missingSurveyFields(fact) {
  return [
    fact.sourceQuality === null || fact.sourceQuality === undefined ? "sourceQuality" : null,
    fact.goldenQueryRetrieves === null || fact.goldenQueryRetrieves === undefined ? "goldenQueryRetrieves" : null,
  ].filter((field) => field !== null);
}

function judgeFact(fact, context) {
  if (!isScorable(fact)) {
    return factLedgerEntry(fact, null);
  }

  const job = context.scenario.desiredJobs.decomposition.find((candidate) => candidate.id === fact.jobId);
  const jobTaskIds = job ? context.l0.jobs.find((entry) => entry.id === job.id)?.taskIds ?? [] : [];

  // 1. A run with no plan: every fact shares the run's outcome.
  if (context.runLayer !== null) {
    if (context.runLayer === "L0:no_canonical_task" && job?.confirmed !== true) {
      return factLedgerEntry(fact, "UNDETERMINED", { missing: ["desiredJobs"] });
    }
    return factLedgerEntry(fact, context.runLayer);
  }

  // 2. What the accepted claims say about the fact. A wrong or fabricated
  //    claim is decided here, before any question of where the fact was, so a
  //    critical finding can never be hidden behind a retrieval or source label.
  const labels = context.accepted.map((claim) => labelClaimForFact(claim.claim, fact));
  const fromClaims = outcomeFromLabels(labels, fact);

  if (fact.kind === "absence") {
    return factLedgerEntry(fact, fromClaims.outcome, {
      ...(fromClaims.kind ? { kind: fromClaims.kind } : {}),
      ...(fromClaims.outcome === "CORRECTLY_ABSENT"
        ? { refusalReported: context.evidenceStatus === "not_found" || context.gaps.length > 0 }
        : {}),
    });
  }

  const partialSupport = fact.corpusSupport === "partial";

  if (fromClaims) {
    const { outcome: rawOutcome, ...extras } = fromClaims;
    // Owner decision 2b-4: a fact the corpus only partly supports is never
    // COVERED; the rest of it is a source limitation.
    const outcome = partialSupport && rawOutcome === "COVERED" ? "PARTIALLY_COVERED" : rawOutcome;
    return factLedgerEntry(fact, outcome, {
      ...extras,
      ...numeratorFlag(fact, outcome),
      ...(partialSupport && OK_OUTCOMES.includes(outcome) ? { tags: ["S:partial_source"] } : {}),
    });
  }

  // 3. No accepted claim bears on the fact. Where was it?
  if (jobTaskIds.length === 0) {
    return job?.confirmed === true
      ? factLedgerEntry(fact, "L0:job_not_derived", numeratorFlag(fact, "L0:job_not_derived"))
      : factLedgerEntry(fact, "UNDETERMINED", { missing: ["desiredJobs"], ...numeratorFlag(fact, "UNDETERMINED") });
  }

  const flags = numeratorFlag(fact, "missed");

  if (!jobTaskIds.some((taskId) => context.searchedTaskIds.has(taskId))) {
    return factLedgerEntry(fact, "G:no_search", flags);
  }

  if (context.sources.some((source) => statesFact(source.evidenceText, fact))) {
    const reasons = context.rejected
      .filter((entry) => SUPPORT_LABELS.has(labelClaimForFact(entry.claim.claim, fact)))
      .map((entry) => entry.reason);

    return reasons.length > 0
      ? factLedgerEntry(fact, "V:false_rejection", { reasons, ...flags })
      : factLedgerEntry(fact, "G:omission", flags);
  }

  if (context.sources.some((source) => statesFact(source.chunkText, fact))) {
    return factLedgerEntry(fact, "S:cap_truncated", flags);
  }

  const quality = fact.sourceQuality;

  if (UNUSABLE_QUALITIES.has(quality) && context.sources.some((source) => onHintedSource(source, fact))) {
    return factLedgerEntry(fact, "S:source_unusable", flags);
  }

  const missing = missingSurveyFields(fact);

  if (missing.length > 0) {
    return factLedgerEntry(fact, "UNDETERMINED", { missing, ...flags });
  }
  if (fact.goldenQueryRetrieves === true) {
    return factLedgerEntry(fact, "G:query_formulation", flags);
  }
  if (fact.goldenQueryRetrieves === false) {
    return factLedgerEntry(fact, "R:retrieval_miss", flags);
  }
  // goldenQueryRetrieves is not_applicable only for an absent fact, handled above.
  return factLedgerEntry(fact, "UNDETERMINED", { missing: ["goldenQueryRetrieves"], ...flags });
}

// ---- The claim ledger -----------------------------------------------------------------

function classifyClaim(verdict, labels) {
  const values = Object.values(labels);
  const supports = values.some((label) => SUPPORT_LABELS.has(label));
  const wrong = values.some((label) => WRONG_LABELS.has(label));

  if (verdict === "accepted") {
    if (wrong) {
      return "false_acceptance";
    }
    return supports ? "covered" : "unscored_acceptance";
  }
  if (supports) {
    return "false_rejection";
  }
  return wrong ? "correct_rejection" : "unscored_rejection";
}

function buildClaimLedger(finalizer, scoredFacts) {
  if (!finalizer) {
    return [];
  }
  // The verifier hands back the very claim objects it rejected, so identity is
  // exact even when two claims share a text.
  const rejectedReason = new Map(finalizer.rejected.map((entry) => [entry.claim, entry.reason]));

  return finalizer.claims.map((claim, index) => {
    const reason = rejectedReason.get(claim) ?? null;
    const verdict = rejectedReason.has(claim) ? "rejected" : "accepted";
    const labels = Object.fromEntries(scoredFacts.map((fact) => [fact.id, labelClaimForFact(claim.claim, fact)]));

    return {
      index,
      taskId: claim.taskId,
      kind: claim.kind,
      claim: claim.claim,
      sourceId: claim.sourceId,
      verdict,
      reason,
      labels,
      classification: classifyClaim(verdict, labels),
    };
  });
}

// ---- Invariants ----------------------------------------------------------------------

const pass = () => ({ status: "pass", problems: [] });
const notApplicable = (why) => ({ status: "not_applicable", problems: [], why });
const result = (problems) => (problems.length === 0 ? pass() : { status: "fail", problems });

/** Every string inside a value, however deeply nested. */
function stringsIn(value, out = []) {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    value.forEach((entry) => stringsIn(entry, out));
  } else if (value && typeof value === "object") {
    Object.values(value).forEach((entry) => stringsIn(entry, out));
  }
  return out;
}

const figureKey = (spec) => `${spec.value}|${spec.unit}`;

/**
 * I-4 (owner decision 2b-5): every figure the production detector reads in
 * what the owner reads or saves must come from an accepted claim's quote (or
 * the title of the document it cites), the owner's own request, or what the
 * same builders print with no claims at all.
 */
function checkUnquotedFigures(record, finalizer, { vehicleLabel }) {
  const outputs = record.outputs;
  const tasks = record.tasks ?? [];
  const request = record.request ?? {};
  const availableTools = parseInventory(request.availableTools ?? "");
  const availableParts = parseInventory(request.availableParts ?? "");
  const requirements = buildRequirementGroups({ accepted: [], availableTools, availableParts });

  const baseline = [
    renderPlanText({
      tasks,
      accepted: [],
      coverage: assessTaskCoverage({ tasks, accepted: [], rejected: [] }),
      requirements,
      gaps: [],
    }),
    buildOwnerChecklist({ tasks, skillLevel: request.skillLevel ?? "beginner", ackSafety: false }),
    draftHandoffNotes({ tasks, vehicle: vehicleLabel, partsNeeded: "" }),
    buildPlannerChecklistDraft({ tasks, evidenceStatus: "not_found", verifiedClaims: [], citations: [], requirements }),
  ];
  const allowedTexts = [
    ...(finalizer?.accepted ?? []).flatMap((claim) => [claim.evidenceQuote, claim.claim, claim.source?.documentTitle ?? ""]),
    request.brief,
    request.availableTools,
    request.availableParts,
    request.constraints,
    vehicleLabel,
    ...stringsIn(baseline),
  ];
  const allowed = new Set(allowedTexts.flatMap((text) => extractSpecNumbers(String(text ?? ""))).map(figureKey));

  const read = {
    text: outputs.text,
    checklistDraft: outputs.checklistDraft,
    checklist: outputs.checklist,
    handoffNotes: outputs.handoffNotes,
    gaps: outputs.evidence?.gaps,
  };
  const problems = [];

  for (const [where, value] of Object.entries(read)) {
    for (const text of stringsIn(value)) {
      for (const spec of extractSpecNumbers(text)) {
        if (!allowed.has(figureKey(spec))) {
          problems.push(`${where} prints ${spec.raw}, which no accepted quote, request field, or zero-claim builder prints`);
        }
      }
    }
  }
  return result(problems);
}

function checkReverification(record, finalizer) {
  if (!finalizer) {
    return notApplicable("no accepted finalizer to re-verify");
  }
  const rebuilt = rebuildEvidence(finalizer.payload, {
    tasks: record.tasks ?? [],
    chunks: finalizer.chunks,
    request: record.request,
  });
  const problems = [];

  if (!rebuilt.valid) {
    problems.push("the decisive finalizer no longer validates");
    return result(problems);
  }
  if (rebuilt.evidenceStatus !== record.outcome.evidenceStatus) {
    problems.push(`evidence status was ${record.outcome.evidenceStatus}, re-verifies as ${rebuilt.evidenceStatus}`);
  }
  if (JSON.stringify(rebuilt.verifiedClaims) !== JSON.stringify(record.outputs?.evidence?.verifiedClaims ?? null)) {
    problems.push("the accepted claims differ from what the current verifier accepts");
  }
  if (JSON.stringify(rebuilt.gaps) !== JSON.stringify(record.outputs?.evidence?.gaps ?? null)) {
    problems.push("the gaps differ from what the current contract writes");
  }
  if (rebuilt.text !== record.outputs?.text) {
    problems.push("the plan text differs from what the current contract renders");
  }
  return result(problems);
}

function checkReadiness(record) {
  const level = record.outputs?.readiness?.level;

  if (!record.outputs || level === undefined) {
    return { i2: notApplicable("no readiness was produced"), i3: notApplicable("no readiness was produced") };
  }
  const i2 = (record.tasks ?? []).some((task) => task.safetyCritical) && level === "ready"
    ? ["a safety-critical task reached ready before acknowledgment"]
    : [];
  const status = record.outcome.evidenceStatus;
  const i3 = [];

  if (status === "not_found" && level !== "not_ready") {
    i3.push(`not_found must be not_ready, was ${level}`);
  }
  if (status === "partial" && level === "ready") {
    i3.push("partial must never be ready");
  }
  return { i2: result(i2), i3: result(i3) };
}

/**
 * I-7: exactly one entry per fact of the scenario, a known outcome for every
 * confirmed fact, and none for an unconfirmed one.
 *
 * @param {any} judgment
 * @param {any} scenario
 * @returns {string[]}
 */
export function reconcileFactLedger(judgment, scenario) {
  const problems = [];
  const factsById = new Map(scenario.facts.map((fact) => [fact.id, fact]));
  const seen = new Map();

  for (const entry of judgment.facts) {
    const fact = factsById.get(entry.factId);

    if (!fact) {
      problems.push(`${entry.factId} is not a fact of ${scenario.id}`);
      continue;
    }
    seen.set(entry.factId, (seen.get(entry.factId) ?? 0) + 1);

    if (isScorable(fact)) {
      if (entry.scoring !== "scored") {
        problems.push(`${entry.factId} is confirmed but scored as unscored`);
      }
      if (!FACT_OUTCOMES.includes(entry.outcome)) {
        problems.push(`${entry.factId}: ${JSON.stringify(entry.outcome)} is not a known outcome`);
      }
      if (entry.outcome === "UNDETERMINED" && !(Array.isArray(entry.missing) && entry.missing.length > 0)) {
        problems.push(`${entry.factId} is UNDETERMINED without naming what is missing`);
      }
    }
    if ((entry.scoring === "unscored" || !isScorable(fact)) && entry.outcome !== null) {
      problems.push(`${entry.factId} is unscored but has an outcome`);
    }
  }

  for (const fact of scenario.facts) {
    const count = seen.get(fact.id) ?? 0;
    if (count === 0) {
      problems.push(`${fact.id} has no outcome`);
    } else if (count > 1) {
      problems.push(`${fact.id} has more than one outcome (${count})`);
    }
  }
  return problems;
}

// ---- Metrics --------------------------------------------------------------------------

function ratio(entries, numeratorKey) {
  if (entries.length === 0) {
    return "unscored";
  }
  return { covered: entries.filter((entry) => entry[numeratorKey] === true).length, total: entries.length };
}

function computeMetrics(record, scenario, facts, claims, finalizerInfo) {
  const scored = scenario.facts.filter(isScorable);
  const anyScored = scored.length > 0;
  const entry = (id) => facts.find((candidate) => candidate.factId === id);
  const essentialOf = (kind) => scored.filter((fact) => fact.essential && fact.kind === kind).map((fact) => entry(fact.id));
  const accepted = claims.filter((claim) => claim.verdict === "accepted");
  const rejected = claims.filter((claim) => claim.verdict === "rejected");
  const falseAcceptances = claims.filter((claim) => claim.classification === "false_acceptance").length;
  const falseRejections = claims.filter((claim) => claim.classification === "false_rejection").length;

  const P2 = anyScored
    ? accepted.filter((claim) => Object.values(claim.labels).includes("wrong_figure")).length
    : "unscored";
  const P3 = anyScored ? accepted.filter((claim) => Object.values(claim.labels).includes("forbidden")).length : "unscored";

  const evidenceStatus = record.outcome?.evidenceStatus ?? null;
  /** @type {boolean | "not_assessable"} */
  let C3 = false;
  if (evidenceStatus === "verified") {
    const essentialMissed = scored.filter((fact) => fact.essential).some((fact) => entry(fact.id).outcome !== "COVERED");
    const completenessUnassessed = (scenario.unassessedAreas ?? []).some((area) => area.id === "procedure-completeness");
    C3 = essentialMissed ? true : completenessUnassessed ? "not_assessable" : false;
  }

  const hinted = scored.filter((fact) => fact.sourceHint?.confirmed);
  const citations = record.outputs?.citations ?? [];
  const Q1 =
    hinted.length === 0 || citations.length === 0
      ? "unscored"
      : {
          onHintedSource: citations.filter((citation) => hinted.some((fact) => onHintedSource(citation, fact))).length,
          citations: citations.length,
        };

  const U2 = {};
  for (const claim of rejected) {
    U2[claim.reason] = (U2[claim.reason] ?? 0) + 1;
  }

  const calls = (record.turns ?? []).flatMap((turn) => turn.calls);
  const searches = calls.filter((call) => call.name === "search_repair_docs" && SEARCHED_DISPOSITIONS.has(call.disposition));

  return {
    P1: ratio(essentialOf("numeric_spec"), "inP1Numerator"),
    P2,
    P3,
    C1: ratio(essentialOf("procedure_step"), "inC1Numerator"),
    C3,
    Q1,
    // U1 and U4 travel together (7.4 rule 1).
    U1: {
      submitted: claims.length,
      rejected: rejected.length,
      rate: claims.length === 0 ? null : rejected.length / claims.length,
      falseAcceptances,
      falseRejections,
    },
    U2,
    U4: { falseAcceptances, falseRejections },
    T2: record.outputs?.requirements
      ? { tools: record.outputs.requirements.tools?.status ?? null, parts: record.outputs.requirements.parts?.status ?? null }
      : null,
    T3: rejected.filter((claim) => claim.reason === "item_name_too_short").length,
    R1: record.outputs?.readiness
      ? { score: record.outputs.readiness.score ?? null, level: record.outputs.readiness.level ?? null, evidenceStatus }
      : null,
    O1: {
      modelTurns: (record.turns ?? []).length,
      toolCalls: calls.filter((call) => call.frameName !== null).length,
      searches: searches.length,
      distinctQueries: new Set((record.retrievals ?? []).map((retrieval) => retrieval.query)).size,
      retrievals: (record.retrievals ?? []).length,
      finalizerCorrections: finalizerInfo.finalizers.filter((finalizer) => !finalizer.valid).length,
      failureCode: record.outcome?.reason ?? null,
    },
  };
}

// ---- The whole judgment ------------------------------------------------------------------

/**
 * Judge one recorded run.
 *
 * @param {any} record      A record from recordPlannerRun.
 * @param {any} scenario    The scenario it ran (may be null for a run judged
 *                          only at run level, such as a refused brief).
 * @param {{ vehicleLabel?: string }} [options]
 */
export function judgeRun(record, scenario, { vehicleLabel = DEFAULT_VEHICLE_LABEL } = {}) {
  const effective = scenario ?? {
    id: null,
    facts: [],
    unassessedAreas: [],
    desiredJobs: { decomposition: [], premise: { status: "not_assessed" } },
  };
  const tasks = record.tasks ?? [];
  const finalizerInfo = reverifyRun(record);
  const decisive = finalizerInfo.decisive === null ? null : finalizerInfo.finalizers[finalizerInfo.decisive];
  const runLayer = runFailureLayer(record);
  const l0 = evaluateTaskDerivation(tasks, effective);

  const searchedTaskIds = new Set(
    (record.turns ?? [])
      .flatMap((turn) => turn.calls)
      .filter((call) => call.name === "search_repair_docs" && SEARCHED_DISPOSITIONS.has(call.disposition))
      .map((call) => call.taskId)
  );

  // Every source the agent held when the plan was decided (or, for a run that
  // never decided one, every source it ever retrieved).
  const allChunks = (record.retrievals ?? []).filter((r) => Array.isArray(r.results)).flatMap((r) => r.results);
  const registry = createSourceRegistry();
  (decisive ? decisive.chunks : allChunks).forEach((chunk) => registry.register(chunk));

  const context = {
    scenario: effective,
    l0,
    runLayer,
    accepted: decisive?.accepted ?? [],
    rejected: decisive?.rejected ?? [],
    sources: registry.list(),
    searchedTaskIds,
    evidenceStatus: record.outcome?.evidenceStatus ?? null,
    gaps: record.outputs?.evidence?.gaps ?? [],
  };

  const scoredFacts = effective.facts.filter(isScorable);
  const facts = effective.facts.map((fact) => judgeFact(fact, context));
  const claims = buildClaimLedger(decisive, scoredFacts);
  const metrics = computeMetrics(record, effective, facts, claims, finalizerInfo);

  const readiness = checkReadiness(record);
  const partial = { facts };
  const invariants = {
    "I-1": checkReverification(record, decisive),
    "I-2": readiness.i2,
    "I-3": readiness.i3,
    "I-4": record.outputs ? checkUnquotedFigures(record, decisive, { vehicleLabel }) : notApplicable("no outputs"),
    "I-7": result(reconcileFactLedger(partial, effective)),
  };

  const critical = [
    ...facts
      .filter((fact) => fact.outcome === "V:false_acceptance")
      .map((fact) => `FALSE ACCEPTANCE (${fact.kind}) for fact ${fact.factId}`),
    ...claims
      .filter((claim) => claim.classification === "false_acceptance")
      .map((claim) => `ACCEPTED WRONG CLAIM #${claim.index} (task ${claim.taskId}, ${claim.kind})`),
    ...Object.entries(invariants)
      .filter(([, value]) => value.status === "fail")
      .map(([id, value]) => `INVARIANT ${id} FAILED: ${value.problems[0]}`),
  ];

  const unscoredMetrics = Object.entries(metrics)
    .filter(([, value]) => value === "unscored")
    .map(([name]) => name);

  return {
    scenarioId: effective.id,
    repeat: record.repeat ?? 1,
    run: {
      status: record.outcome?.status ?? "unknown",
      code: record.outcome?.code ?? null,
      reason: record.outcome?.reason ?? null,
      evidenceStatus: record.outcome?.evidenceStatus ?? null,
      layer: runLayer,
      noSearchTaskIds: runLayer === null ? tasks.map((task) => task.id).filter((id) => !searchedTaskIds.has(id)) : [],
      decisiveFinalizer: finalizerInfo.decisive,
    },
    l0,
    claims,
    facts,
    metrics,
    invariants,
    critical,
    unscored: {
      facts: facts.filter((fact) => fact.scoring === "unscored").map((fact) => fact.factId),
      metrics: unscoredMetrics,
    },
  };
}

