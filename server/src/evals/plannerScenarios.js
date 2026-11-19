// Scenario DATA for the Repair Planner evaluation (docs/planner-eval-spec.md,
// Phase 2a). Pure: it imports nothing, so a test or a replay can load it with no
// database and no key.
//
// This module holds data and the rules that keep the data honest. It does NOT
// judge a run: the claim matcher, the fact and claim ledgers, and every
// failure-layer classification are Phase 2b. The labelled examples below are
// authored first on purpose -- the matcher must reproduce them, and if one is
// wrong the label is fixed in review, never the matcher bent to fit.
//
// Three rules shape every field:
//
//   1. Only CONFIRMED facts are committed: confirmed in an Ask eval case
//      (`confirmedBy.askCaseId`), or confirmed by the owner against the
//      rendered manual page under decision D11 (`confirmedBy.ownerReview`,
//      Phase 4 Stage B). An unconfirmed golden fact is never introduced here,
//      so it can never reach a scored result. What is not assessed is named in
//      `unassessedAreas` (a name and nothing else), never as a placeholder fact.
//   2. "Unknown" is a value, not a default. `sourceQuality` and
//      `goldenQueryRetrieves` stay null until the Phase 4 survey has checked
//      them, and null is never read as clean. Confirming a fact against the
//      rendered PDF page says the manual states it; it says nothing about
//      whether the extracted text is usable, so a known quality always carries
//      its own evidence. An ABSENT fact says `not_applicable` explicitly.
//   3. `desiredJobs` describe what the brief ASKS FOR, written from its meaning
//      and unconfirmed until reviewed, and are kept apart from the vehicle
//      `premise`. S8 asks for a repair this engine does not need: deriving that
//      task is correct decomposition, not an L0 defect.
//
// Everything here is public: concept-level facts and short figures only, no
// manual passages, and vehicle metadata only where it is plain metadata.

// 2: Phase 4 Stage B added the owner-confirmed D11 facts to S1 and S2.
export const SCENARIO_SET_VERSION = 2;

export const NOT_APPLICABLE = "not_applicable";
export const INVENTORY_PROFILE_ID = "stocked-home-garage-v1";

// A kind is added together with its matcher (plannerJudge.js); a kind without a
// matcher would be data nobody can score. `procedure_step` arrived with the
// Phase 2b judge; since Phase 4 Stage B (D11) S1 and S2 carry confirmed steps,
// so C1 is scored for them. S8 has none, so its C1 stays `unscored`. A step
// matcher has no "wrong" label: a claim either states the step or it does not.
export const FACT_KINDS = ["numeric_spec", "absence", "procedure_step"];
export const CORPUS_SUPPORT = ["full", "partial", "absent"];
export const PARTIAL_KINDS = ["fragmented", "qualifier_missing", "range_incomplete", "variant_ambiguous"];
export const SOURCE_QUALITIES = ["clean", "garbled", "flattened_table", "ocr_unusable", "truncated", "condition_missing"];
export const PREMISE_STATUSES = ["not_assessed", "unsupported_for_vehicle"];
export const NUMERIC_CLAIM_LABELS = ["covers", "partial_figure", "wrong_figure", "other_fact", "unrelated"];
export const ABSENCE_CLAIM_LABELS = ["forbidden", "not_forbidden"];
export const PROCEDURE_CLAIM_LABELS = ["covers", "unrelated"];
export const SET_OUTCOMES = ["COVERED", "PARTIALLY_COVERED", "CORRECTLY_ABSENT", "V:false_acceptance"];
export const SET_KINDS = ["contradicted", "wrong_only", "fabrication"];

const SKILL_LEVELS = ["beginner", "intermediate", "advanced"];
const WRONG_LABELS = new Set(["wrong_figure", "forbidden"]);

// ---- Validation -------------------------------------------------------------

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isText = (value) => typeof value === "string" && value.trim() !== "";
const isMatcherList = (value) =>
  Array.isArray(value) && value.length > 0 && value.every((entry) => entry instanceof RegExp);
const isEvidence = (value) => isObject(value) && isText(value.kind) && isText(value.ref);
const hasStatefulFlag = (matcher) => matcher.global || matcher.sticky;

/**
 * Who confirmed a fact: an Ask eval case, or the owner's decision-D11 review of
 * the rendered manual page (Phase 4 Stage B), which must carry its date.
 */
const isConfirmationSource = (value) =>
  isObject(value) &&
  (isText(value.askCaseId) ||
    (value.ownerReview === "D11" && typeof value.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.date)));

/** The success metric an essential fact counts toward: C1 for a step, P1 otherwise. */
const numeratorKeyOf = (fact) => (fact.kind === "procedure_step" ? "inC1Numerator" : "inP1Numerator");

/** True when two numeric forms in the same unit share any value. */
function formsOverlap(a, b) {
  if (a.unit !== b.unit) {
    return false;
  }
  const span = (form) => (form.kind === "range" ? [form.low, form.high] : [form.value, form.value]);
  const [aLow, aHigh] = span(a);
  const [bLow, bHigh] = span(b);

  return aLow <= bHigh && bLow <= aHigh;
}

function validateMatchers(problems, where, matchers, { allowEmpty = false } = {}) {
  if (allowEmpty && Array.isArray(matchers) && matchers.length === 0) {
    return;
  }
  if (!isMatcherList(matchers)) {
    problems.push(`${where}: matchers must be a non-empty array of RegExp`);
    return;
  }
  for (const matcher of matchers) {
    if (hasStatefulFlag(matcher)) {
      problems.push(`${where}: a matcher must not use the global or sticky flag (it would remember lastIndex between tests)`);
    }
  }
}

function validateForm(problems, where, form, units) {
  if (!isObject(form)) {
    problems.push(`${where}: a numeric form must be an object`);
    return;
  }
  if (form.kind === "value") {
    if (!Number.isFinite(form.value)) {
      problems.push(`${where}: value must be a finite number`);
    }
  } else if (form.kind === "range") {
    if (!Number.isFinite(form.low) || !Number.isFinite(form.high) || !(form.low < form.high)) {
      problems.push(`${where}: range low must be below high`);
    }
  } else {
    problems.push(`${where}: a form is a value or a range`);
    return;
  }
  if (!units.has(form.unit)) {
    problems.push(`${where}: unit ${JSON.stringify(form.unit)} is not declared in the fact's units`);
  }
}

function validateSurveyFields(problems, where, fact) {
  const absent = fact.corpusSupport === "absent";

  // Source quality.
  if (fact.sourceQuality === null || fact.sourceQuality === undefined) {
    if (absent) {
      problems.push(`${where}: an absent fact's sourceQuality must be not_applicable, not unknown`);
    }
    if (fact.qualityEvidence !== null && fact.qualityEvidence !== undefined) {
      problems.push(`${where}: qualityEvidence given for an unknown sourceQuality`);
    }
  } else if (fact.sourceQuality === NOT_APPLICABLE) {
    if (!absent) {
      problems.push(`${where}: sourceQuality not_applicable is only for an absent fact`);
    }
  } else if (SOURCE_QUALITIES.includes(fact.sourceQuality)) {
    if (!isEvidence(fact.qualityEvidence)) {
      problems.push(`${where}: sourceQuality ${fact.sourceQuality} needs qualityEvidence { kind, ref } showing the extracted text was checked`);
    }
  } else {
    problems.push(`${where}: sourceQuality ${JSON.stringify(fact.sourceQuality)} is not null, not_applicable, or one of ${SOURCE_QUALITIES.join("/")}`);
  }

  // The golden-query probe.
  const probe = fact.goldenQueryRetrieves;

  if (probe === null || probe === undefined) {
    if (absent) {
      problems.push(`${where}: an absent fact's goldenQueryRetrieves must be not_applicable, not unknown`);
    }
    if (fact.goldenQueryEvidence !== null && fact.goldenQueryEvidence !== undefined) {
      problems.push(`${where}: goldenQueryEvidence given for an unknown goldenQueryRetrieves`);
    }
  } else if (probe === NOT_APPLICABLE) {
    if (!absent) {
      problems.push(`${where}: goldenQueryRetrieves not_applicable is only for an absent fact`);
    }
  } else if (probe === true || probe === false) {
    if (!isEvidence(fact.goldenQueryEvidence)) {
      problems.push(`${where}: goldenQueryRetrieves ${probe} needs goldenQueryEvidence { kind, ref }`);
    }
  } else {
    problems.push(`${where}: goldenQueryRetrieves must be null, true, false, or not_applicable`);
  }
}

function validateNumericFact(problems, where, fact) {
  validateMatchers(problems, `${where} partMatchers`, fact.partMatchers);

  const units = new Set();
  if (!Array.isArray(fact.units) || fact.units.length === 0) {
    problems.push(`${where}: units must declare every unit the fact is written in`);
  } else {
    for (const unit of fact.units) {
      if (!isText(unit?.canonical) || !Array.isArray(unit.aliases)) {
        problems.push(`${where}: a unit is { canonical, aliases[] }`);
      } else {
        units.add(unit.canonical);
      }
    }
  }

  if (!Array.isArray(fact.acceptable) || fact.acceptable.length === 0) {
    problems.push(`${where}: acceptable must list at least one form`);
  } else {
    fact.acceptable.forEach((form, index) => validateForm(problems, `${where} acceptable[${index}]`, form, units));
  }

  (Array.isArray(fact.decoys) ? fact.decoys : []).forEach((decoy, index) => {
    const at = `${where} decoys[${index}]`;
    validateForm(problems, at, decoy, units);
    if (!isText(decoy?.why)) {
      problems.push(`${at}: a decoy says why it is a trap`);
    }
    for (const form of Array.isArray(fact.acceptable) ? fact.acceptable : []) {
      if (isObject(decoy) && isObject(form) && formsOverlap(decoy, form)) {
        problems.push(`${at}: decoy overlaps an acceptable form, so the same figure would be both right and a trap`);
      }
    }
  });
  if (!Array.isArray(fact.decoys)) {
    problems.push(`${where}: decoys must be an array (empty if there are none)`);
  }

  if (fact.qualifiersAnyOf !== null && fact.qualifiersAnyOf !== undefined) {
    validateMatchers(problems, `${where} qualifiersAnyOf`, fact.qualifiersAnyOf);
  }
  if (!Array.isArray(fact.excludedQualifiers)) {
    problems.push(`${where}: excludedQualifiers must be an array (empty if there are none)`);
  } else {
    validateMatchers(problems, `${where} excludedQualifiers`, fact.excludedQualifiers, { allowEmpty: true });
  }
}

function validateAbsenceFact(problems, where, fact) {
  if (fact.corpusSupport !== "absent") {
    problems.push(`${where}: an absence fact must have corpusSupport absent`);
  }
  const check = fact.absenceCheck;

  if (!isObject(check) || !isText(check.precondition) || !isText(check.askCaseId) || check.requiresDatabase !== true) {
    problems.push(`${where}: absenceCheck must name the precondition and Ask case that confirm the absence, with requiresDatabase true`);
  }
  const rule = fact.fabrication;

  if (!isObject(rule) || !(rule.subject instanceof RegExp)) {
    problems.push(`${where}: fabrication.subject must be a RegExp`);
    return;
  }
  validateMatchers(problems, `${where} fabrication.subject`, [rule.subject]);
  validateMatchers(problems, `${where} fabrication.cues`, rule.cues);
  validateMatchers(problems, `${where} fabrication.negations`, rule.negations);
  validateMatchers(problems, `${where} fabrication.decoys`, rule.decoys);
}

function validateFact(problems, where, fact, jobIds) {
  if (!isObject(fact)) {
    problems.push(`${where}: a fact must be an object`);
    return;
  }
  if (!isText(fact.id)) {
    problems.push(`${where}: fact id is required`);
  }
  if (!FACT_KINDS.includes(fact.kind)) {
    problems.push(`${where}: kind ${JSON.stringify(fact.kind)} is not one of ${FACT_KINDS.join("/")}`);
  }
  if (!jobIds.has(fact.jobId)) {
    problems.push(`${where}: jobId ${JSON.stringify(fact.jobId)} names no desired job`);
  }
  if (typeof fact.essential !== "boolean") {
    problems.push(`${where}: essential must be a boolean`);
  }
  if (typeof fact.confirmed !== "boolean") {
    problems.push(`${where}: confirmed must be a boolean`);
  }
  if (!isText(fact.concept)) {
    problems.push(`${where}: concept is required (a paraphrase, never a passage)`);
  }
  if (!isConfirmationSource(fact.confirmedBy)) {
    problems.push(
      `${where}: confirmedBy must name the Ask case that confirmed the fact, or the owner's D11 review with its date`
    );
  }

  if (fact.confirmed === true && !CORPUS_SUPPORT.includes(fact.corpusSupport)) {
    problems.push(`${where}: a confirmed fact needs corpusSupport ${CORPUS_SUPPORT.join("/")}`);
  } else if (fact.corpusSupport !== undefined && !CORPUS_SUPPORT.includes(fact.corpusSupport)) {
    problems.push(`${where}: corpusSupport ${JSON.stringify(fact.corpusSupport)} is not ${CORPUS_SUPPORT.join("/")}`);
  }

  if (fact.corpusSupport === "partial") {
    if (!isObject(fact.partial) || !PARTIAL_KINDS.includes(fact.partial.partialKind)) {
      problems.push(`${where}: a partial fact needs partial.partialKind (${PARTIAL_KINDS.join("/")})`);
    } else if (!isText(fact.partial.supported)) {
      problems.push(`${where}: a partial fact needs partial.supported, the portion that can be quoted`);
    }
  } else if (fact.partial !== null && fact.partial !== undefined) {
    problems.push(`${where}: a partial block is only allowed when corpusSupport is partial`);
  }

  validateSurveyFields(problems, where, fact);

  if (fact.sourceHint !== null && fact.sourceHint !== undefined) {
    const hint = fact.sourceHint;
    const sources = Array.isArray(hint.sources) ? hint.sources : [];

    if (typeof hint.confirmed !== "boolean" || sources.length === 0) {
      problems.push(`${where}: sourceHint is { confirmed, sources[] }`);
    }
    for (const source of sources) {
      if (!(source.titleLike instanceof RegExp) || hasStatefulFlag(source.titleLike)) {
        problems.push(`${where}: a sourceHint titleLike must be a stateless RegExp`);
      }
      if (!Array.isArray(source.pages) || source.pages.length === 0 || !source.pages.every(Number.isInteger)) {
        problems.push(`${where}: a sourceHint lists whole page numbers`);
      }
    }
  }

  if (fact.kind === "numeric_spec") {
    validateNumericFact(problems, where, fact);
  } else if (fact.kind === "absence") {
    validateAbsenceFact(problems, where, fact);
  } else if (fact.kind === "procedure_step") {
    // A step is stated when EVERY matcher hits the claim: one names the action,
    // another its object, so "remove the cover" cannot cover "remove the filter".
    validateMatchers(problems, `${where} stepMatchers`, fact.stepMatchers);
  }

  validateClaimExamples(problems, where, fact);
}

function validateClaimExamples(problems, where, fact) {
  const labels =
    fact.kind === "absence"
      ? ABSENCE_CLAIM_LABELS
      : fact.kind === "procedure_step"
        ? PROCEDURE_CLAIM_LABELS
        : NUMERIC_CLAIM_LABELS;

  if (!Array.isArray(fact.claimExamples) || fact.claimExamples.length === 0) {
    problems.push(`${where}: claimExamples must list labelled claims`);
    return;
  }
  const seen = new Set();

  for (const example of fact.claimExamples) {
    if (!isText(example?.text)) {
      problems.push(`${where}: a claim example needs text`);
      continue;
    }
    if (seen.has(example.text)) {
      problems.push(`${where}: duplicate claim example text ${JSON.stringify(example.text)}`);
    }
    seen.add(example.text);

    if (!labels.includes(example.expect)) {
      problems.push(`${where}: example expect ${JSON.stringify(example.expect)} is not one of ${labels.join("/")}`);
    }
    if (!isText(example.category)) {
      problems.push(`${where}: example ${JSON.stringify(example.text)} needs a category`);
    }
  }
}

function validateSetExample(problems, where, example, factsById) {
  if (!isText(example?.id)) {
    problems.push(`${where}: a claim-set example needs an id`);
    return;
  }
  const at = `${where} set ${example.id}`;

  if (!Array.isArray(example.claims) || !example.claims.every(isText)) {
    problems.push(`${at}: claims must be an array of claim texts`);
    return;
  }
  if (!isObject(example.expect) || Object.keys(example.expect).length === 0) {
    problems.push(`${at}: expect must map at least one fact id to its expected outcome`);
    return;
  }

  const criticalClaims = new Set();

  for (const [factId, expected] of Object.entries(example.expect)) {
    const fact = factsById.get(factId);

    if (!fact) {
      problems.push(`${at}: expect names unknown fact ${factId}`);
      continue;
    }
    const labelOf = (text) => fact.claimExamples?.find((candidate) => candidate.text === text)?.expect ?? null;
    const labels = example.claims.map(labelOf);

    labels.forEach((label, index) => {
      if (label === null) {
        problems.push(`${at}/${factId}: claim ${JSON.stringify(example.claims[index])} has no label for this fact`);
      } else if (WRONG_LABELS.has(label)) {
        criticalClaims.add(index);
      }
    });

    const wrong = labels.filter((label) => WRONG_LABELS.has(label)).length;
    const covers = labels.filter((label) => label === "covers").length;
    const partial = labels.filter((label) => label === "partial_figure").length;
    const absence = fact.kind === "absence";

    if (!SET_OUTCOMES.includes(expected.outcome)) {
      problems.push(`${at}/${factId}: outcome ${JSON.stringify(expected.outcome)} is not one of ${SET_OUTCOMES.join("/")}`);
      continue;
    }

    if (wrong > 0) {
      if (expected.outcome !== "V:false_acceptance") {
        problems.push(`${at}/${factId}: an accepted wrong or forbidden claim makes this V:false_acceptance, and a correct claim cannot hide that critical finding`);
        continue;
      }
      const wantKind = absence ? "fabrication" : covers > 0 ? "contradicted" : "wrong_only";

      if (expected.kind !== wantKind) {
        problems.push(`${at}/${factId}: kind should be ${wantKind}`);
      }
      const wantCovered = wantKind === "contradicted";

      if ((expected.alsoCovered ?? false) !== wantCovered) {
        problems.push(`${at}/${factId}: alsoCovered must be ${wantCovered} for a ${wantKind} outcome`);
      }
    } else {
      const wantOutcome = absence ? "CORRECTLY_ABSENT" : covers > 0 ? "COVERED" : partial > 0 ? "PARTIALLY_COVERED" : null;

      if (wantOutcome === null) {
        problems.push(`${at}/${factId}: no claim covers or partly covers the fact (an omission is not a claim-set example)`);
        continue;
      }
      if (expected.outcome !== wantOutcome) {
        problems.push(`${at}/${factId}: outcome should be ${wantOutcome}`);
      }
      if (expected.kind !== undefined || expected.alsoCovered !== undefined) {
        problems.push(`${at}/${factId}: kind and alsoCovered belong to V:false_acceptance only`);
      }
    }

    if (fact.essential) {
      // Only COVERED counts toward P1 (a figure) or C1 (a step): a contradicted
      // or partly covered fact stays in the denominator, so it can never
      // inflate the success rate.
      const key = numeratorKeyOf(fact);
      const other = key === "inC1Numerator" ? "inP1Numerator" : "inC1Numerator";
      const metric = key === "inC1Numerator" ? "C1" : "P1";

      if (expected[key] !== (expected.outcome === "COVERED")) {
        problems.push(`${at}/${factId}: ${key} must be ${expected.outcome === "COVERED"} (only COVERED counts in ${metric})`);
      }
      if (other in expected) {
        problems.push(`${at}/${factId}: a ${fact.kind} fact counts in ${metric}, so it carries ${key}, not ${other}`);
      }
    } else if ("inP1Numerator" in expected || "inC1Numerator" in expected) {
      problems.push(`${at}/${factId}: a non-essential fact is outside P1 and C1, so it has no numerator flag`);
    }
  }

  if (!Number.isInteger(example.criticalFindings) || example.criticalFindings !== criticalClaims.size) {
    problems.push(`${at}: criticalFindings should be ${criticalClaims.size}, one per accepted wrong or forbidden claim`);
  }
}

/**
 * Every rule a scenario must meet, as human-readable problems (empty when the
 * scenario is valid). Returning problems rather than throwing lets a test name
 * the rule that fired.
 *
 * @param {any} scenario
 * @returns {string[]}
 */
export function validateScenario(scenario) {
  /** @type {string[]} */
  const problems = [];
  const where = `scenario ${scenario?.id ?? "?"}`;

  if (!isText(scenario?.id)) {
    problems.push("scenario id is required");
  }
  if (!isText(scenario?.brief)) {
    problems.push(`${where}: brief is required`);
  }
  if (!SKILL_LEVELS.includes(scenario?.skillLevel)) {
    problems.push(`${where}: skillLevel must be ${SKILL_LEVELS.join("/")}`);
  }
  for (const key of ["availableTools", "availableParts", "constraints", "inventoryProfile"]) {
    if (typeof scenario?.[key] !== "string") {
      problems.push(`${where}: ${key} must be a string`);
    }
  }

  // Desired jobs: what the brief asks for, apart from the vehicle premise.
  const jobIds = new Set();
  const decomposition = scenario?.desiredJobs?.decomposition;

  if (!Array.isArray(decomposition) || decomposition.length === 0) {
    problems.push(`${where}: desiredJobs.decomposition must list at least one job`);
  } else {
    for (const job of decomposition) {
      if (!isText(job?.id)) {
        problems.push(`${where}: a job needs an id`);
        continue;
      }
      if (jobIds.has(job.id)) {
        problems.push(`${where}: duplicate job id ${job.id}`);
      }
      jobIds.add(job.id);
      validateMatchers(problems, `${where} job ${job.id}`, job.matchers);

      if (!isText(job.concept)) {
        problems.push(`${where}: job ${job.id} needs a concept`);
      }
      if (typeof job.confirmed !== "boolean") {
        problems.push(`${where}: job ${job.id} confirmed must be a boolean`);
      }
    }
  }

  const premise = scenario?.desiredJobs?.premise;

  if (!isObject(premise) || !PREMISE_STATUSES.includes(premise.status)) {
    problems.push(`${where}: premise.status must be ${PREMISE_STATUSES.join("/")}`);
  } else if (premise.status === "unsupported_for_vehicle" && !(isObject(premise.basis) && isText(premise.basis.askCaseId))) {
    problems.push(`${where}: an unsupported premise needs a basis naming the Ask case that confirms the absence`);
  }

  // What is NOT assessed is named, never described: a name with a concept or a
  // figure would be a golden fact that nobody confirmed.
  if (!Array.isArray(scenario?.unassessedAreas) || scenario.unassessedAreas.length === 0) {
    problems.push(`${where}: unassessedAreas must name what this scenario does not assess`);
  } else {
    for (const area of scenario.unassessedAreas) {
      const keys = Object.keys(area ?? {}).sort().join(",");

      if (keys !== "area,id" || !isText(area.id) || !isText(area.area)) {
        problems.push(`${where}: unassessed area ${JSON.stringify(area?.id)} must be names only (id, area)`);
      }
    }
  }

  const facts = Array.isArray(scenario?.facts) ? scenario.facts : [];
  const factsById = new Map();

  if (facts.length === 0) {
    problems.push(`${where}: a scenario needs at least one fact`);
  }
  for (const fact of facts) {
    if (factsById.has(fact?.id)) {
      problems.push(`${where}: duplicate fact id ${fact.id}`);
    }
    factsById.set(fact?.id, fact);
    validateFact(problems, `${where} fact ${fact?.id ?? "?"}`, fact, jobIds);
  }

  const sets = Array.isArray(scenario?.claimSetExamples) ? scenario.claimSetExamples : null;

  if (sets === null) {
    problems.push(`${where}: claimSetExamples must be an array`);
  } else {
    for (const example of sets) {
      validateSetExample(problems, where, example, factsById);
    }
  }

  return problems;
}

/**
 * The whole set: every scenario, plus the ids that must be unique across it.
 *
 * @param {any[]} scenarios
 * @returns {string[]}
 */
export function validateScenarioSet(scenarios) {
  /** @type {string[]} */
  const problems = scenarios.flatMap((scenario) => validateScenario(scenario));
  const scenarioIds = new Set();
  const factIds = new Set();

  for (const scenario of scenarios) {
    if (scenarioIds.has(scenario.id)) {
      problems.push(`duplicate scenario id ${scenario.id}`);
    }
    scenarioIds.add(scenario.id);

    for (const fact of scenario.facts ?? []) {
      if (factIds.has(fact.id)) {
        problems.push(`duplicate fact id ${fact.id}`);
      }
      factIds.add(fact.id);
    }
  }

  return problems;
}

// ---- The scoring gate (data level) -------------------------------------------

/**
 * A fact is scored only when it has been confirmed. Anything else -- missing,
 * false, or a truthy non-boolean -- is unscored, and an unscored fact can
 * produce neither a pass nor a failure. The end-to-end version of this gate
 * (the judge printing `unscored` instead of a number) is Phase 2b.
 *
 * @param {any} fact
 */
export function isScorable(fact) {
  return fact?.confirmed === true;
}

/**
 * @param {any} fact
 * @returns {"scored" | "unscored"}
 */
export function factScoringStatus(fact) {
  return isScorable(fact) ? "scored" : "unscored";
}

// ---- Shared pieces of the committed scenarios ---------------------------------

const STOCKED_TOOLS = "floor jack, jack stands, socket set, torque wrench, drain pan, screwdrivers, pliers";

const TORQUE_UNITS = [
  { canonical: "N·m", aliases: ["N-m", "Nm", "N*m"] },
  { canonical: "ft-lbf", aliases: ["ft-lb", "ft.lbf", "lb-ft"] },
  { canonical: "kgf-cm", aliases: [] },
];

const LENGTH_UNITS = [
  { canonical: "mm", aliases: [] },
  { canonical: "in", aliases: ["in.", "inch", "inches"] },
];

const NO_SURVEY = {
  sourceQuality: null,
  qualityEvidence: null,
  goldenQueryRetrieves: null,
  goldenQueryEvidence: null,
};

const TASK_ATTRIBUTES_AREA = {
  id: "task-attributes",
  area: "system, difficulty and safety flags the extractor assigns to each task",
};

// ---- Phase 4 Stage B: the owner's D11 facts ---------------------------------------
//
// Every fact built by d11Step / d11Figure was confirmed by the owner against
// the rendered manual page (decision D11, 2026-11-19), and the extracted text
// of the chunk named in its `qualityEvidence` was read in the 2026-11-18 survey
// snapshot to rate its source quality. Concepts and claim examples are
// paraphrases; nothing here quotes the manual.
//
// A planner claim is a verbatim fragment of the manual, so each matcher was
// also checked (privately, against the real text) to cover its own step and
// none of the neighbouring steps that share its words. The labelled examples
// below are the public record of that: each step lists the near-miss it must
// not cover.

const OWNER_D11 = {
  ownerReview: "D11",
  date: "2026-11-19",
  note: "confirmed by the owner against the rendered manual page(s), Phase 4 Stage B",
};

const SURVEY_SNAPSHOT = "survey snapshot 2026-11-18";

/** The chunk whose extracted text was read to rate a fact's source quality. */
const readChunk = (where) => ({ kind: "extracted-text-review", ref: `${where}, ${SURVEY_SNAPSHOT}` });

/**
 * The golden-query probe for each D11 fact, from `npm run eval:planner:survey`
 * on the survey snapshot. Keyword ranking only: it says a careful keyword
 * search reaches the fact, not that a planner run (hybrid retrieval) did.
 */
// Every D11 fact: a canonical query (CANONICAL_QUERIES in the survey) puts a
// chunk stating it inside the evidence window in the top 8.
const GOLDEN_QUERY = Object.fromEntries(
  [
    "s1-step-remove-filler-cap", "s1-step-drain-oil", "s1-step-new-drain-gasket", "s1-step-drain-filter-cap",
    "s1-step-remove-old-element", "s1-step-clean-cap-threads", "s1-step-new-oring-oiled", "s1-step-new-filter-element",
    "s1-step-clean-install-surface", "s1-cap-alignment", "s1-step-install-filter-cap", "s1-filter-cap-torque",
    "s1-step-add-oil", "s1-step-refit-filler-cap", "s1-oil-viscosity", "s1-oil-capacity-with-filter",
    "s1-step-inspect-leak",
    "s2-step-remove-head-cover", "s2-step-disconnect-coils", "s2-step-remove-coils", "s2-notice-plug-tube",
    "s2-step-remove-plugs", "s2-plug-wrench-size", "s2-recommended-plug", "s2-step-install-plugs",
    "s2-spark-plug-torque", "s2-step-install-coils", "s2-coil-bolt-torque", "s2-step-connect-coils",
    "s2-step-refit-head-cover",
  ].map((id) => [id, true])
);
const KEYWORD_SURVEY = {
  kind: "keyword-survey",
  ref: `npm run eval:planner:survey on the ${SURVEY_SNAPSHOT}: keyword-only ranking, top 8, inside the 1,500-character window; not a planner run, which ranks with hybrid retrieval`,
};

/** A page-level source hint the owner confirmed. */
const ownerHint = (...sources) => ({ confirmed: true, confirmedBy: OWNER_D11, sources });

// Titles of the confirmed source articles, anchored at the start so a longer
// article that merely mentions one cannot match.
const OIL_ARTICLE = /^oil and oil filter replacement\b/i;
const PLUG_REMOVAL = /^ignition coil and spark plug removal\b/i;
const PLUG_INSTALLATION = /^ignition coil and spark plug installation\b/i;
// A one-page export of the same installation article (visually checked).
const PLUG_INSTALLATION_EXPORT = /^ignition coil service and repair\b.*\binstallation\b/i;
const ENGINE_REMOVAL = /^engine assembly removal\b/i;
const ENGINE_INSTALLATION = /^engine assembly installation\b/i;
const IGNITION_INSPECTION = /^ignition system on vehicle inspection\b/i;
const SERVICE_DATA = /service data/i;

const oilPage = (page) => ownerHint({ titleLike: OIL_ARTICLE, pages: [page] });
const oilChunk = (page, chunk) => `Oil and Oil Filter Replacement (Engine Oil) p${page} chunk ${chunk}`;

function d11Survey(id, quality, qualityRef) {
  const probe = GOLDEN_QUERY[id] ?? null;

  return {
    corpusSupport: "full",
    partial: null,
    sourceQuality: quality,
    qualityEvidence: readChunk(qualityRef),
    goldenQueryRetrieves: probe,
    goldenQueryEvidence: probe === null ? null : KEYWORD_SURVEY,
  };
}

/** One owner-confirmed procedure step: covered when EVERY matcher hits a claim. */
function d11Step({ id, jobId, essential = true, concept, hint, quality, qualityRef, knownCaveat = null, stepMatchers, claimExamples }) {
  return {
    id,
    kind: "procedure_step",
    jobId,
    essential,
    confirmed: true,
    concept,
    confirmedBy: OWNER_D11,
    ...d11Survey(id, quality, qualityRef),
    sourceHint: hint,
    ...(knownCaveat ? { knownCaveat } : {}),
    stepMatchers,
    claimExamples,
  };
}

/** One owner-confirmed figure. */
function d11Figure({ id, jobId, essential = true, concept, hint, quality, qualityRef, knownCaveat = null, ...figure }) {
  return {
    id,
    kind: "numeric_spec",
    jobId,
    essential,
    confirmed: true,
    concept,
    confirmedBy: OWNER_D11,
    ...d11Survey(id, quality, qualityRef),
    sourceHint: hint,
    ...(knownCaveat ? { knownCaveat } : {}),
    qualifiersAnyOf: null,
    excludedQualifiers: [],
    decoys: [],
    ...figure,
  };
}

const OIL_VOLUME_UNITS = [
  { canonical: "L", aliases: ["liters", "litres", "liter", "litre"] },
  { canonical: "US qt", aliases: ["US qts", "US quarts", "US quart"] },
  // "lmp." is the lowercase-L spelling one page's text layer uses (F3).
  { canonical: "Imp qt", aliases: ["Imp. qts", "Imp. qt", "Imp qts", "lmp. qts", "lmp. qt", "Imperial qts", "Imperial quarts"] },
];

// ---- S1: oil and filter --------------------------------------------------------

const S1_CLAIMS = {
  both: "Tighten the oil drain plug to 37 N·m (27 ft-lbf).",
  primary: "Tighten the oil drain plug to 37 N·m.",
  spelling: "The oil drain plug torque is 37 Nm.",
  ftlbf: "The oil drain plug torque is 27 ft-lbf.",
  kgfcm: "The oil drain plug torque is 377 kgf-cm.",
  wrong: "Tighten the oil drain plug to 45 N·m (33 ft-lbf).",
  wrongUnit: "The oil drain plug torque is 37 ft-lbf.",
  mixed: "Tighten the oil drain plug to 37 N·m (33 ft-lbf).",
  filterCap: "Tighten the oil filter cap to 25 N·m.",
  noFigure: "Drain the oil into a pan.",
};

// Phrases shared by more than one fact's examples, so a sibling's label for
// the same text is declared once and the sibling check can find it.
const S1_STEP_CLAIMS = {
  plainDrain: S1_CLAIMS.noFigure,
  refitPlug: "Refit the drain plug using a new gasket.",
  removePlug: "Remove the drain plug.",
  removeFiller: "Remove the oil filler cap first.",
  refitFiller: "Refit the oil filler cap after filling.",
  loosenCap: "Loosen the oil filter cap.",
  newElement: "Put a new oil filter element into the cap.",
  oilTheRing: "Apply a little engine oil to the new O-ring on the filter cap.",
  installCap: "Install the oil filter cap.",
  refill: "Pour in fresh engine oil, then refit the oil filler cap.",
  capacity: "With a filter change the engine oil capacity is 4.2 liters, or 4.4 US qts, or 3.7 Imp. qts.",
  capTorque: "The oil filter cap torque is 25 N·m (18 ft-lbf).",
  capDecoy: "The oil filter cap torque is 37 N·m.",
  capDecoyTightened: "Tighten the oil filter cap to 37 N·m.",
};

const S1_D11_FACTS = [
  d11Step({
    id: "s1-step-remove-filler-cap",
    jobId: "change-engine-oil",
    essential: false,
    concept: "take the oil filler cap off before draining",
    hint: oilPage(1),
    quality: "garbled",
    qualityRef: oilChunk(1, 2),
    stepMatchers: [/\b(?:remove|removing|unscrew)\b/i, /\bfiller cap\b/i],
    claimExamples: [
      { text: S1_STEP_CLAIMS.removeFiller, expect: "covers", category: "the-step" },
      { text: S1_STEP_CLAIMS.refitFiller, expect: "unrelated", category: "refit" },
    ],
  }),
  d11Step({
    id: "s1-step-drain-oil",
    jobId: "change-engine-oil",
    concept: "take out the drain plug and drain the engine oil into a container",
    hint: oilPage(1),
    quality: "garbled",
    qualityRef: oilChunk(1, 2),
    stepMatchers: [
      /\bdrain(?:s|ed|ing)?\b(?!\s*plug)/i,
      /\boil\b/i,
      // The oil left in the filter cap, another fluid, or a capacity row is
      // not this step.
      /^(?![\s\S]*\b(?:filter|transaxle|transmission|differential|coolant|refill)\b)/i,
    ],
    claimExamples: [
      { text: "Take out the drain plug and let the engine oil drain into a pan.", expect: "covers", category: "the-step" },
      { text: S1_STEP_CLAIMS.plainDrain, expect: "covers", category: "plain-drain" },
      { text: "Let the oil left in the oil filter cap drain out.", expect: "unrelated", category: "filter-cap-oil" },
      { text: "Drain the transaxle oil.", expect: "unrelated", category: "other-fluid" },
      { text: S1_STEP_CLAIMS.refitPlug, expect: "unrelated", category: "drain-plug-refit" },
    ],
  }),
  d11Step({
    id: "s1-step-new-drain-gasket",
    jobId: "change-engine-oil",
    concept: "refit the cleaned drain plug with a new gasket",
    hint: oilPage(1),
    quality: "garbled",
    qualityRef: oilChunk(1, 2),
    stepMatchers: [/\bdrain plug\b/i, /\bgasket\b/i, /\bnew\b|\breplac\w*/i],
    claimExamples: [
      { text: S1_STEP_CLAIMS.refitPlug, expect: "covers", category: "the-step" },
      { text: S1_STEP_CLAIMS.removePlug, expect: "unrelated", category: "no-gasket" },
    ],
  }),
  d11Step({
    id: "s1-step-drain-filter-cap",
    jobId: "replace-oil-filter",
    concept: "loosen the oil filter cap and drain the oil left in it",
    hint: oilPage(1),
    quality: "garbled",
    qualityRef: oilChunk(1, 3),
    stepMatchers: [/\bfilter cap\b/i, /\bdrain\w*\b/i, /\b(?:remaining|left|residual|retained|loosen\w*)\b/i],
    claimExamples: [
      { text: "Loosen the oil filter cap and drain the oil remaining in it.", expect: "covers", category: "the-step" },
      { text: "Let the oil left in the oil filter cap drain out.", expect: "covers", category: "left-in-cap" },
      { text: S1_STEP_CLAIMS.plainDrain, expect: "unrelated", category: "engine-drain" },
      { text: S1_STEP_CLAIMS.loosenCap, expect: "unrelated", category: "loosen-only" },
    ],
  }),
  d11Step({
    id: "s1-step-remove-old-element",
    jobId: "replace-oil-filter",
    concept: "take the old filter element and O-ring out of the filter cap",
    hint: oilPage(2),
    quality: "garbled",
    qualityRef: oilChunk(2, 0),
    stepMatchers: [/\b(?:remove|removing|pull out)\b/i, /\belement\b/i],
    claimExamples: [
      { text: "Remove the old element and O-ring from the filter cap.", expect: "covers", category: "the-step" },
      { text: S1_STEP_CLAIMS.newElement, expect: "unrelated", category: "new-element" },
    ],
  }),
  d11Step({
    id: "s1-step-clean-cap-threads",
    jobId: "replace-oil-filter",
    concept: "clean the filter cap threads and its O-ring groove",
    hint: oilPage(2),
    quality: "garbled",
    qualityRef: oilChunk(2, 1),
    stepMatchers: [/\bclean\w*\b/i, /\bthreads?\b|\bgroove\b/i, /\bcap\b/i],
    claimExamples: [
      { text: "Clean the filter cap threads and the O-ring groove.", expect: "covers", category: "the-step" },
      { text: "Clean the drain plug before refitting it.", expect: "unrelated", category: "other-cleaning" },
    ],
  }),
  d11Step({
    id: "s1-step-new-oring-oiled",
    jobId: "replace-oil-filter",
    concept: "fit a new O-ring to the filter cap with a little engine oil on it",
    hint: oilPage(2),
    quality: "garbled",
    qualityRef: oilChunk(2, 1),
    // The filter cap is required: the manuals oil new O-rings on injectors,
    // pumps and pipes too.
    stepMatchers: [/\bo-?ring\b/i, /\bnew\b/i, /\b(?:apply|applying|coat|coating|lubricate|smear|wet)\b/i, /\boil\b/i, /\bfilter cap\b/i],
    claimExamples: [
      { text: "Coat a new O-ring with a little engine oil and fit it to the filter cap.", expect: "covers", category: "the-step" },
      { text: S1_STEP_CLAIMS.oilTheRing, expect: "covers", category: "apply-oil" },
      { text: "Remove the old O-ring by hand.", expect: "unrelated", category: "old-o-ring" },
      { text: "Fit a new O-ring to the filter cap.", expect: "unrelated", category: "not-oiled" },
    ],
  }),
  d11Step({
    id: "s1-step-new-filter-element",
    jobId: "replace-oil-filter",
    concept: "fit a fresh oil filter element into the cap",
    hint: oilPage(3),
    quality: "garbled",
    qualityRef: oilChunk(3, 0),
    // An OIL filter element: air and fuel filters have elements too.
    stepMatchers: [/\boil filter\b(?!\s*(?:cap|bracket))/i, /\bnew\b|\breplac\w*/i],
    claimExamples: [
      { text: S1_STEP_CLAIMS.newElement, expect: "covers", category: "the-step" },
      { text: "Replace the oil filter.", expect: "covers", category: "replace-filter" },
      { text: "Fit a new air filter element.", expect: "unrelated", category: "other-filter" },
      { text: "Take the old element out of the filter cap.", expect: "unrelated", category: "old-element" },
      { text: "Fit a new O-ring to the oil filter cap.", expect: "unrelated", category: "o-ring-not-element" },
    ],
  }),
  d11Step({
    id: "s1-step-clean-install-surface",
    jobId: "replace-oil-filter",
    concept: "clear any dirt from the filter's installation surface",
    hint: oilPage(3),
    quality: "garbled",
    qualityRef: oilChunk(3, 0),
    stepMatchers: [
      /\bclean\w*\b|\b(?:remove|wipe)\b[\s\S]*\b(?:dirt|foreign matter|debris)\b/i,
      /\b(?:installation|mounting|sealing|contact) surface\b/i,
    ],
    claimExamples: [
      { text: "Wipe any dirt off the filter mounting surface.", expect: "covers", category: "the-step" },
      { text: "Look for any gap at the installation surfaces once it is tight.", expect: "unrelated", category: "gap-check" },
    ],
  }),
  d11Step({
    id: "s1-cap-alignment",
    jobId: "replace-oil-filter",
    essential: false,
    concept: "align the filter cap's cutout at 90 degrees to the bracket grooves before tightening",
    hint: oilPage(3),
    quality: "garbled",
    qualityRef: oilChunk(3, 0),
    stepMatchers: [/\balign\w*\b/i, /\bcutout\b/i, /\b90\s*(?:°|deg)/i],
    claimExamples: [
      { text: "Align the cap cutout at 90° to the bracket grooves, then start the cap by hand.", expect: "covers", category: "the-step" },
      { text: "Align the cap ribs vertically.", expect: "unrelated", category: "other-alignment" },
    ],
  }),
  d11Step({
    id: "s1-step-install-filter-cap",
    jobId: "replace-oil-filter",
    concept: "refit and tighten the oil filter cap",
    hint: oilPage(3),
    quality: "garbled",
    qualityRef: oilChunk(3, 0),
    // Oiling the O-ring and fitting it to the cap is a different step.
    stepMatchers: [/\b(?:install|tighten|refit|reinstall)\b/i, /\bfilter cap\b/i, /^(?![\s\S]*\bo-?ring\b)/i],
    claimExamples: [
      { text: "Refit the oil filter cap and tighten it.", expect: "covers", category: "the-step" },
      { text: S1_STEP_CLAIMS.installCap, expect: "covers", category: "install-heading" },
      { text: S1_CLAIMS.filterCap, expect: "covers", category: "tighten-with-figure" },
      { text: S1_STEP_CLAIMS.capDecoyTightened, expect: "covers", category: "tighten-with-wrong-figure" },
      { text: "Fit a new O-ring, then install that on the oil filter cap.", expect: "unrelated", category: "o-ring-step" },
      { text: S1_STEP_CLAIMS.loosenCap, expect: "unrelated", category: "loosen" },
    ],
  }),
  d11Figure({
    id: "s1-filter-cap-torque",
    jobId: "replace-oil-filter",
    concept: "tightening torque of the oil filter cap assembly",
    hint: oilPage(3),
    quality: "garbled",
    qualityRef: oilChunk(3, 0),
    partMatchers: [/\bfilter cap\b/i],
    units: TORQUE_UNITS,
    acceptable: [
      { kind: "value", value: 25, unit: "N·m" },
      { kind: "value", value: 18, unit: "ft-lbf" },
      { kind: "value", value: 255, unit: "kgf-cm" },
    ],
    decoys: [
      { kind: "value", value: 37, unit: "N·m", why: "the drain-plug torque given for the filter cap" },
      { kind: "value", value: 27, unit: "ft-lbf", why: "the drain-plug torque in ft-lbf" },
      { kind: "value", value: 377, unit: "kgf-cm", why: "the drain-plug torque in kgf-cm" },
    ],
    claimExamples: [
      { text: S1_STEP_CLAIMS.capTorque, expect: "covers", category: "printed-forms-together" },
      { text: S1_CLAIMS.filterCap, expect: "covers", category: "primary-unit" },
      { text: "The oil filter cap torque is 255 kgf-cm.", expect: "covers", category: "alternate-unit-kgf" },
      { text: S1_STEP_CLAIMS.capDecoy, expect: "wrong_figure", category: "decoy-drain-plug-figure" },
      { text: S1_STEP_CLAIMS.capDecoyTightened, expect: "wrong_figure", category: "decoy-drain-plug-figure-tightened" },
      { text: "The oil filter cap torque is 25 ft-lbf.", expect: "wrong_figure", category: "right-number-wrong-unit" },
      { text: S1_CLAIMS.primary, expect: "unrelated", category: "different-part" },
      { text: S1_STEP_CLAIMS.loosenCap, expect: "unrelated", category: "no-figure" },
    ],
  }),
  d11Step({
    id: "s1-step-add-oil",
    jobId: "change-engine-oil",
    concept: "add fresh engine oil",
    hint: oilPage(3),
    quality: "garbled",
    qualityRef: oilChunk(3, 1),
    stepMatchers: [/\b(?:add|adding|pour|fill)\b/i, /\boil\b/i, /^(?![\s\S]*\bo-?ring\b)/i],
    claimExamples: [
      { text: "Pour in fresh engine oil.", expect: "covers", category: "the-step" },
      { text: S1_STEP_CLAIMS.refill, expect: "covers", category: "with-filler-cap" },
      { text: S1_STEP_CLAIMS.oilTheRing, expect: "unrelated", category: "o-ring-oiling" },
      { text: S1_STEP_CLAIMS.capacity, expect: "unrelated", category: "capacity-only" },
    ],
  }),
  d11Step({
    id: "s1-step-refit-filler-cap",
    jobId: "change-engine-oil",
    concept: "put the oil filler cap back on after filling",
    hint: oilPage(3),
    quality: "garbled",
    qualityRef: oilChunk(3, 1),
    stepMatchers: [/\b(?:install|refit|reinstall|replace|close|tighten)\b/i, /\bfiller cap\b/i],
    claimExamples: [
      { text: S1_STEP_CLAIMS.refitFiller, expect: "covers", category: "the-step" },
      { text: S1_STEP_CLAIMS.refill, expect: "covers", category: "with-refill" },
      { text: S1_STEP_CLAIMS.removeFiller, expect: "unrelated", category: "removal" },
      { text: S1_STEP_CLAIMS.installCap, expect: "unrelated", category: "filter-not-filler" },
    ],
  }),
  d11Step({
    id: "s1-oil-viscosity",
    jobId: "change-engine-oil",
    // The grade is "ILSAC multigrade"; 0W-20 is the SAE viscosity.
    concept: "engine oil of SAE viscosity 0W-20 (an ILSAC multigrade oil), the standard for the U.S.A. and Canada",
    hint: oilPage(3),
    quality: "flattened_table",
    qualityRef: oilChunk(3, 2),
    knownCaveat:
      "Only 0W-20 counts as stating this fact. The library prints 5W-20 for this engine only in the Mexico table of the same article, and the 2009 owner's manual (not in the library) also permits 5W-20. A plan that names only 5W-20, or lists it beside 0W-20, is therefore marked as missing this essential fact: that is a limit of the measurement, not a finding that 5W-20 is unsuitable, and such a claim is never counted as wrong.",
    stepMatchers: [/\b0W-?20\b/i, /^(?![\s\S]*\b(?:5W|10W|15W|20W)-?\d\d\b)/i],
    claimExamples: [
      { text: "Use ILSAC multigrade engine oil, SAE 0W-20.", expect: "covers", category: "the-step" },
      { text: "Use SAE 5W-20 engine oil.", expect: "unrelated", category: "other-viscosity-not-judged" },
      { text: "Use SAE 0W-20 or 5W-20 engine oil.", expect: "unrelated", category: "viscosity-list-not-judged" },
      { text: "Use ILSAC multigrade engine oil.", expect: "unrelated", category: "grade-without-viscosity" },
    ],
  }),
  d11Figure({
    id: "s1-oil-capacity-with-filter",
    jobId: "change-engine-oil",
    concept: "engine oil capacity for a drain and refill with an oil filter change",
    hint: oilPage(4),
    quality: "flattened_table",
    qualityRef: oilChunk(4, 0),
    knownCaveat:
      "The same table prints the capacity without a filter change and the dry-fill capacity; both are decoys here. A quart figure with no US or Imperial mark is not read as a figure.",
    partMatchers: [/\bcapacity\b/i, /\brefill\b/i, /\bengine oil\b/i],
    units: OIL_VOLUME_UNITS,
    acceptable: [
      { kind: "value", value: 4.2, unit: "L" },
      { kind: "value", value: 4.4, unit: "US qt" },
      { kind: "value", value: 3.7, unit: "Imp qt" },
    ],
    // "L4-1.8L" is the engine's displacement in every article's vehicle header,
    // not an oil capacity: without this, a header quoted beside "engine oil"
    // would read as a wrong 1.8 L capacity (found against the real text).
    excludedQualifiers: [/\bwithout\b/i, /\bdry fill\b/i, /\bL4-\d\.\dL\b/i],
    decoys: [
      { kind: "value", value: 3.9, unit: "L", why: "the capacity WITHOUT a filter change" },
      { kind: "value", value: 4.1, unit: "US qt", why: "the without-filter capacity in US quarts" },
      { kind: "value", value: 3.4, unit: "Imp qt", why: "the without-filter capacity in Imperial quarts" },
      { kind: "value", value: 4.7, unit: "L", why: "the dry-fill capacity of an empty engine" },
      { kind: "value", value: 5.0, unit: "US qt", why: "the dry-fill capacity in US quarts" },
      { kind: "value", value: 4.1, unit: "Imp qt", why: "the dry-fill capacity in Imperial quarts" },
    ],
    claimExamples: [
      { text: S1_STEP_CLAIMS.capacity, expect: "covers", category: "printed-forms-together" },
      { text: "Refill with 4.4 US qts of engine oil.", expect: "covers", category: "alternate-unit" },
      { text: "Refill the engine oil: capacity 3.9 liters.", expect: "wrong_figure", category: "decoy-without-filter-unqualified" },
      { text: "Engine oil capacity is 4.7 liters.", expect: "wrong_figure", category: "decoy-dry-fill-unqualified" },
      { text: "Engine oil capacity with a filter change is 4.4 Imp. qts.", expect: "wrong_figure", category: "us-figure-as-imperial" },
      { text: "Without a filter change, the engine oil capacity is 3.9 liters.", expect: "other_fact", category: "qualified-other-fact" },
      { text: "Corolla L4-1.8L: drain and refill the engine oil.", expect: "other_fact", category: "engine-displacement" },
      { text: "Use fresh engine oil.", expect: "unrelated", category: "no-figure" },
    ],
  }),
  d11Step({
    id: "s1-step-inspect-leak",
    jobId: "change-engine-oil",
    concept: "check for oil leaks after refilling",
    hint: oilPage(4),
    quality: "garbled",
    qualityRef: oilChunk(4, 0),
    knownCaveat: "The manual prints this step as a heading only; the fact asks for a leak check, not a particular test method.",
    stepMatchers: [/\b(?:inspect|check)\w*\b/i, /\bleak\w*\b/i, /\boil\b/i],
    claimExamples: [
      { text: "Check for oil leaks after refilling.", expect: "covers", category: "the-step" },
      { text: "Check the oil level on the dipstick.", expect: "unrelated", category: "no-leak" },
      { text: "Inspect for coolant leaks.", expect: "unrelated", category: "other-fluid" },
    ],
  }),
];

const S1 = {
  id: "S1-oil-and-filter",
  brief: "Change the engine oil and replace the oil filter.",
  skillLevel: "beginner",
  availableTools: STOCKED_TOOLS,
  availableParts: "engine oil, oil filter, drain plug gasket",
  constraints: "",
  inventoryProfile: INVENTORY_PROFILE_ID,
  desiredJobs: {
    decomposition: [
      {
        id: "change-engine-oil",
        concept: "drain and refill the engine oil",
        matchers: [/\bengine oil\b/i, /\boil change\b/i],
        confirmed: false,
      },
      {
        id: "replace-oil-filter",
        concept: "replace the oil filter",
        matchers: [/\boil filter\b/i],
        confirmed: false,
      },
    ],
    premise: { status: "not_assessed" },
  },
  unassessedAreas: [
    TASK_ATTRIBUTES_AREA,
    { id: "procedure-completeness", area: "whether the plan covers every step of the procedure" },
    { id: "required-tools", area: "which tools the procedure needs" },
    { id: "required-parts", area: "which parts the procedure needs" },
    { id: "safety-instructions", area: "which safety instructions the plan must carry" },
  ],
  facts: [
    {
      id: "s1-drain-plug-torque",
      kind: "numeric_spec",
      jobId: "change-engine-oil",
      essential: true,
      confirmed: true,
      concept: "tightening torque of the engine oil drain plug",
      confirmedBy: {
        askCaseId: "oil-drain-plug-torque",
        note: "expectation confirmed against the rendered manual page in the Ask eval case",
      },
      corpusSupport: "full",
      partial: null,
      ...NO_SURVEY,
      sourceHint: {
        confirmed: true,
        confirmedBy: { askCaseId: "oil-drain-plug-torque-citation-support" },
        sources: [{ titleLike: /oil and oil filter replacement/i, pages: [1] }],
      },
      partMatchers: [/\boil drain plug\b/i, /\bdrain plug\b/i],
      units: TORQUE_UNITS,
      acceptable: [
        { kind: "value", value: 37, unit: "N·m" },
        { kind: "value", value: 27, unit: "ft-lbf" },
        { kind: "value", value: 377, unit: "kgf-cm" },
      ],
      qualifiersAnyOf: null,
      excludedQualifiers: [],
      decoys: [],
      claimExamples: [
        { text: S1_CLAIMS.both, expect: "covers", category: "printed-forms-together" },
        { text: S1_CLAIMS.primary, expect: "covers", category: "primary-unit" },
        { text: S1_CLAIMS.spelling, expect: "covers", category: "unit-spelling" },
        { text: S1_CLAIMS.ftlbf, expect: "covers", category: "alternate-unit" },
        { text: S1_CLAIMS.kgfcm, expect: "covers", category: "alternate-unit-kgf" },
        { text: S1_CLAIMS.wrong, expect: "wrong_figure", category: "wrong-value" },
        { text: S1_CLAIMS.wrongUnit, expect: "wrong_figure", category: "right-number-wrong-unit" },
        { text: S1_CLAIMS.mixed, expect: "wrong_figure", category: "mixed-right-and-wrong" },
        { text: S1_CLAIMS.filterCap, expect: "unrelated", category: "different-part" },
        { text: S1_CLAIMS.noFigure, expect: "unrelated", category: "no-figure" },
      ],
    },
    ...S1_D11_FACTS,
  ],
  claimSetExamples: [
    {
      // The owner's example: a correct and an incorrect specification for one
      // fact. CONTRADICTED lives inside layer V; the correct claim does not
      // cancel the critical finding, and the fact stays out of P1's numerator.
      id: "s1-contradiction",
      claims: [S1_CLAIMS.both, S1_CLAIMS.wrong],
      expect: {
        "s1-drain-plug-torque": { outcome: "V:false_acceptance", kind: "contradicted", alsoCovered: true, inP1Numerator: false },
      },
      criticalFindings: 1,
    },
    {
      id: "s1-two-units",
      claims: [S1_CLAIMS.primary, S1_CLAIMS.ftlbf],
      expect: { "s1-drain-plug-torque": { outcome: "COVERED", inP1Numerator: true } },
      criticalFindings: 0,
    },
    {
      id: "s1-duplicate",
      claims: [S1_CLAIMS.primary, S1_CLAIMS.primary],
      expect: { "s1-drain-plug-torque": { outcome: "COVERED", inP1Numerator: true } },
      criticalFindings: 0,
    },
    {
      id: "s1-wrong-only",
      claims: [S1_CLAIMS.wrong],
      expect: {
        "s1-drain-plug-torque": { outcome: "V:false_acceptance", kind: "wrong_only", inP1Numerator: false },
      },
      criticalFindings: 1,
    },
    {
      id: "s1-wrong-unit-and-right",
      claims: [S1_CLAIMS.primary, S1_CLAIMS.wrongUnit],
      expect: {
        "s1-drain-plug-torque": { outcome: "V:false_acceptance", kind: "contradicted", alsoCovered: true, inP1Numerator: false },
      },
      criticalFindings: 1,
    },
    {
      // The drain-plug figure printed one page earlier, given for the cap.
      id: "s1-cap-takes-drain-plug-figure",
      claims: [S1_STEP_CLAIMS.capDecoy],
      expect: {
        "s1-filter-cap-torque": { outcome: "V:false_acceptance", kind: "wrong_only", inP1Numerator: false },
      },
      criticalFindings: 1,
    },
    {
      // The without-filter row, stated WITH its qualifier, is not a contradiction.
      id: "s1-capacity-with-qualified-sibling",
      claims: [S1_STEP_CLAIMS.capacity, "Without a filter change, the engine oil capacity is 3.9 liters."],
      expect: { "s1-oil-capacity-with-filter": { outcome: "COVERED", inP1Numerator: true } },
      criticalFindings: 0,
    },
    {
      // One claim can state two steps; each counts once in C1.
      id: "s1-refill-and-filler-cap",
      claims: [S1_STEP_CLAIMS.refill],
      expect: {
        "s1-step-add-oil": { outcome: "COVERED", inC1Numerator: true },
        "s1-step-refit-filler-cap": { outcome: "COVERED", inC1Numerator: true },
      },
      criticalFindings: 0,
    },
  ],
};

// ---- S2: spark plugs ------------------------------------------------------------

const S2_CLAIMS = {
  rangeBoth: "Spark plug electrode gap for a new plug: 1.0 to 1.1 mm (0.0394 to 0.0433 in).",
  rangeMm: "The electrode gap for a new spark plug is 1.0 to 1.1 mm.",
  rangeIn: "The electrode gap for a new spark plug is 0.0394 to 0.0433 in.",
  rangeDecimals: "The electrode gap for a new spark plug is 1.00 to 1.10 mm.",
  endLow: "The electrode gap for a new spark plug is 1.0 mm.",
  endHigh: "The electrode gap for a new spark plug is 1.1 mm.",
  mixed: "The electrode gap for a new spark plug is 1.1 to 1.3 mm.",
  wrongUnit: "The electrode gap for a new spark plug is 1.0 to 1.1 in.",
  unqualified: "Spark plug electrode gap 1.3 mm (0.0512 in).",
  explicitNew: "The electrode gap for a new spark plug is 1.3 mm.",
  usedBoth: "Maximum spark plug electrode gap for a used plug: 1.3 mm (0.0512 in).",
  usedIn: "The maximum electrode gap for a used spark plug is 0.0512 in.",
  usedRange: "The maximum electrode gap for a used spark plug is 1.0 to 1.1 mm.",
  noFigure: "Remove the spark plug and inspect the electrode.",
};

const S2_SOURCE_HINT = {
  confirmed: true,
  confirmedBy: { askCaseId: "spark-plug-gap" },
  sources: [
    { titleLike: /service data/i, pages: [1] },
    { titleLike: /ignition system.*inspection/i, pages: [5, 6] },
  ],
};

const S2_STEP_CLAIMS = {
  removeCover: "Remove the No. 2 cylinder head cover.",
  refitCover: "Install the No. 2 cylinder head cover.",
  unplugCoils: "Unplug the 4 ignition coil connectors.",
  connectCoils: "Reconnect all 4 ignition coil connectors.",
  removeCoils: "Remove the 4 ignition coils.",
  installCoils: "Refit all 4 ignition coils with their bolts.",
  removePlugs: "Unscrew the 4 spark plugs with a plug socket.",
  installPlugs: "Install the 4 spark plugs.",
  noticeRemoving: "Do not damage the spark plug tube while removing a coil.",
  noticeInstalling: "Do not damage the spark plug tube while installing a coil.",
  plugTorque: "Tighten the spark plugs to 20 N·m (15 ft-lbf).",
  plugTorqueShort: "Tighten the spark plugs to 20 N·m.",
  coilTorque: "Tighten the ignition coil bolts to 10 N·m (7 ft-lbf).",
  coilTorqueShort: "Tighten the ignition coil bolts to 10 N·m.",
  coilFigureBesidePlugs: "Install the spark plugs, then the ignition coils at 10 N·m.",
  plugFigureBesideCoils: "Install the ignition coils after the spark plugs, which take 20 N·m.",
};

const removalPage = (page) => ({ titleLike: PLUG_REMOVAL, pages: [page] });
const installationPage = (...pages) => ({ titleLike: PLUG_INSTALLATION, pages });
const INSTALLATION_EXPORT = { titleLike: PLUG_INSTALLATION_EXPORT, pages: [1] };
const removalChunk = (page) => `Ignition Coil and Spark Plug Removal p${page} chunk 0`;
const installationChunk = (page) => `Ignition Coil and Spark Plug Installation p${page} chunk 0`;

// A spark plug, not the tube, wrench, socket, or gap named after one.
const SPARK_PLUG = /\bspark plugs?\b(?!\s*(?:tube|wrench|socket|gap))/i;
// The cover, or the clips that hold it (the engine-removal article's wording).
const NO2_HEAD_COVER = /\bno\.?\s*2 cylinder head cover\b|\bclips?\b[\s\S]*\bcover\b|\bcover\b[\s\S]*\bclips?\b/i;

const S2_D11_FACTS = [
  d11Step({
    id: "s2-step-remove-head-cover",
    jobId: "replace-spark-plugs",
    concept: "take off the No. 2 cylinder head cover (the engine top cover) by releasing its clips",
    hint: ownerHint(removalPage(1), { titleLike: ENGINE_REMOVAL, pages: [1] }),
    quality: "clean",
    qualityRef: removalChunk(1),
    knownCaveat:
      "The plug-removal article names this step and points to the engine-removal article; only that article's cover step (its four clips) applies, none of its other steps.",
    stepMatchers: [/\b(?:remove|removing|disengage)\b/i, NO2_HEAD_COVER],
    claimExamples: [
      { text: S2_STEP_CLAIMS.removeCover, expect: "covers", category: "the-step" },
      { text: "Raise the rear of the engine cover to disengage its 2 rear clips, then the front.", expect: "covers", category: "clip-release" },
      { text: "Remove the engine under cover.", expect: "unrelated", category: "under-cover" },
      { text: S2_STEP_CLAIMS.refitCover, expect: "unrelated", category: "refit-not-removal" },
    ],
  }),
  d11Step({
    id: "s2-step-disconnect-coils",
    jobId: "replace-spark-plugs",
    concept: "disconnect the four ignition coil connectors",
    hint: ownerHint(removalPage(1)),
    quality: "clean",
    qualityRef: removalChunk(1),
    stepMatchers: [/\b(?:disconnect|unplug)\w*\b/i, /\bconnectors?\b/i, /\bignition coil\b/i],
    claimExamples: [
      { text: S2_STEP_CLAIMS.unplugCoils, expect: "covers", category: "the-step" },
      { text: S2_STEP_CLAIMS.connectCoils, expect: "unrelated", category: "connect-not-disconnect" },
    ],
  }),
  d11Step({
    id: "s2-step-remove-coils",
    jobId: "replace-spark-plugs",
    concept: "remove the four ignition coil bolts and the coils",
    hint: ownerHint(removalPage(1)),
    quality: "clean",
    qualityRef: removalChunk(1),
    stepMatchers: [/\b(?:remove|pull out|lift out)\b/i, /\bignition coils?\b/i, /^(?![\s\S]*\b(?:connectors?|do not damage)\b)/i],
    claimExamples: [
      { text: "Remove the 4 coil bolts and lift out the ignition coils.", expect: "covers", category: "the-step" },
      { text: S2_STEP_CLAIMS.removeCoils, expect: "covers", category: "short" },
      { text: S2_STEP_CLAIMS.installCoils, expect: "unrelated", category: "install-not-remove" },
      { text: S2_STEP_CLAIMS.noticeRemoving, expect: "unrelated", category: "notice-not-step" },
    ],
  }),
  d11Step({
    id: "s2-notice-plug-tube",
    jobId: "replace-spark-plugs",
    essential: false,
    concept: "take care not to damage the plug cap at the cover opening or the spark plug tube's edge when moving a coil",
    hint: ownerHint(removalPage(2), installationPage(2), INSTALLATION_EXPORT),
    quality: "clean",
    qualityRef: removalChunk(2),
    stepMatchers: [/\bdo not damage\b|\bwithout damaging\b/i, /\bspark plug tube\b|\bplug cap\b/i],
    claimExamples: [
      { text: S2_STEP_CLAIMS.noticeRemoving, expect: "covers", category: "the-step" },
      { text: S2_STEP_CLAIMS.noticeInstalling, expect: "covers", category: "installing" },
      { text: S2_STEP_CLAIMS.removeCoils, expect: "unrelated", category: "no-notice" },
    ],
  }),
  d11Step({
    id: "s2-step-remove-plugs",
    jobId: "replace-spark-plugs",
    concept: "remove the four spark plugs",
    hint: ownerHint(removalPage(2)),
    quality: "clean",
    qualityRef: removalChunk(2),
    stepMatchers: [/\b(?:remove|unscrew)\b/i, SPARK_PLUG],
    claimExamples: [
      { text: S2_STEP_CLAIMS.removePlugs, expect: "covers", category: "the-step" },
      { text: S2_CLAIMS.noFigure, expect: "covers", category: "remove-and-inspect" },
      { text: S2_STEP_CLAIMS.installPlugs, expect: "unrelated", category: "install-not-remove" },
      { text: S2_STEP_CLAIMS.removeCoils, expect: "unrelated", category: "coils-not-plugs" },
    ],
  }),
  d11Figure({
    id: "s2-plug-wrench-size",
    jobId: "replace-spark-plugs",
    // Kept for tool/specification assessment; outside C1 and P1.
    essential: false,
    concept: "size of the spark plug wrench",
    hint: ownerHint(removalPage(2), installationPage(1)),
    quality: "clean",
    qualityRef: removalChunk(2),
    partMatchers: [/\bspark plug (?:wrench|socket)\b/i, /\bplug (?:wrench|socket)\b/i],
    units: [{ canonical: "mm", aliases: [] }],
    acceptable: [{ kind: "value", value: 14, unit: "mm" }],
    claimExamples: [
      { text: "Use a 14 mm spark plug wrench.", expect: "covers", category: "primary-unit" },
      { text: "Use a 16 mm spark plug socket.", expect: "wrong_figure", category: "wrong-size" },
      { text: "Use a spark plug socket.", expect: "unrelated", category: "no-figure" },
      { text: S2_CLAIMS.rangeMm, expect: "unrelated", category: "other-part" },
    ],
  }),
  d11Step({
    id: "s2-recommended-plug",
    jobId: "replace-spark-plugs",
    essential: false,
    concept: "the recommended spark plug for this engine is a DENSO SC20HR11",
    hint: ownerHint({ titleLike: IGNITION_INSPECTION, pages: [5] }, { titleLike: SERVICE_DATA, pages: [1] }),
    quality: "clean",
    qualityRef: "IGNITION SYSTEM ON VEHICLE INSPECTION p5 chunk 0",
    stepMatchers: [/\bSC20HR11\b/i],
    claimExamples: [
      { text: "The recommended plug is a DENSO SC20HR11.", expect: "covers", category: "the-step" },
      { text: "Use a DENSO iridium spark plug.", expect: "unrelated", category: "no-part-number" },
    ],
  }),
  d11Step({
    id: "s2-step-install-plugs",
    jobId: "replace-spark-plugs",
    concept: "install the four spark plugs",
    hint: ownerHint(installationPage(1), INSTALLATION_EXPORT),
    quality: "clean",
    qualityRef: installationChunk(1),
    stepMatchers: [/\b(?:install|screw in|fit)\b/i, SPARK_PLUG],
    claimExamples: [
      { text: S2_STEP_CLAIMS.installPlugs, expect: "covers", category: "the-step" },
      { text: S2_STEP_CLAIMS.coilFigureBesidePlugs, expect: "covers", category: "with-coils" },
      { text: S2_STEP_CLAIMS.plugFigureBesideCoils, expect: "covers", category: "with-coils-after" },
      { text: S2_STEP_CLAIMS.removePlugs, expect: "unrelated", category: "remove-not-install" },
      { text: S2_STEP_CLAIMS.noticeInstalling, expect: "unrelated", category: "notice-not-step" },
    ],
  }),
  d11Figure({
    id: "s2-spark-plug-torque",
    jobId: "replace-spark-plugs",
    concept: "tightening torque of the spark plugs",
    hint: ownerHint(installationPage(1), INSTALLATION_EXPORT),
    quality: "clean",
    qualityRef: installationChunk(1),
    partMatchers: [SPARK_PLUG],
    units: TORQUE_UNITS,
    acceptable: [
      { kind: "value", value: 20, unit: "N·m" },
      { kind: "value", value: 15, unit: "ft-lbf" },
      { kind: "value", value: 204, unit: "kgf-cm" },
    ],
    // A claim that also names the coils is about the coil-bolt torque.
    excludedQualifiers: [/\bignition coils?\b/i, /\bcoil bolts?\b/i],
    decoys: [
      { kind: "value", value: 10, unit: "N·m", why: "the coil-bolt torque printed a few lines later, given for the plugs" },
      { kind: "value", value: 7, unit: "ft-lbf", why: "the coil-bolt torque in ft-lbf" },
      { kind: "value", value: 102, unit: "kgf-cm", why: "the coil-bolt torque in kgf-cm" },
    ],
    claimExamples: [
      { text: S2_STEP_CLAIMS.plugTorque, expect: "covers", category: "printed-forms-together" },
      { text: S2_STEP_CLAIMS.plugTorqueShort, expect: "covers", category: "primary-unit" },
      { text: "The spark plug torque is 204 kgf-cm.", expect: "covers", category: "alternate-unit-kgf" },
      { text: "Tighten the spark plugs to 10 N·m.", expect: "wrong_figure", category: "decoy-coil-figure" },
      { text: "The spark plug torque is 20 ft-lbf.", expect: "wrong_figure", category: "right-number-wrong-unit" },
      { text: S2_STEP_CLAIMS.coilFigureBesidePlugs, expect: "other_fact", category: "coil-figure-beside-plugs" },
      { text: S2_STEP_CLAIMS.coilTorqueShort, expect: "unrelated", category: "different-part" },
      { text: S2_STEP_CLAIMS.coilTorque, expect: "unrelated", category: "other-part-full" },
    ],
  }),
  d11Step({
    id: "s2-step-install-coils",
    jobId: "replace-spark-plugs",
    concept: "install the four ignition coils with their bolts",
    hint: ownerHint(installationPage(1), INSTALLATION_EXPORT),
    quality: "clean",
    qualityRef: installationChunk(1),
    stepMatchers: [/\b(?:install|refit|reinstall)\b/i, /\bignition coils?\b(?!\s*connectors?)/i, /^(?![\s\S]*\bdo not damage\b)/i],
    claimExamples: [
      { text: S2_STEP_CLAIMS.installCoils, expect: "covers", category: "the-step" },
      { text: S2_STEP_CLAIMS.coilFigureBesidePlugs, expect: "covers", category: "with-plugs" },
      { text: S2_STEP_CLAIMS.plugFigureBesideCoils, expect: "covers", category: "with-plugs-after" },
      { text: S2_STEP_CLAIMS.connectCoils, expect: "unrelated", category: "connectors-not-coils" },
      { text: S2_STEP_CLAIMS.removeCoils, expect: "unrelated", category: "remove-not-install" },
    ],
  }),
  d11Figure({
    id: "s2-coil-bolt-torque",
    jobId: "replace-spark-plugs",
    concept: "tightening torque of the ignition coil bolts",
    hint: ownerHint(installationPage(1, 2), INSTALLATION_EXPORT),
    quality: "clean",
    qualityRef: "Ignition Coil Service and Repair ... Installation (one-page export) p1 chunk 0",
    knownCaveat:
      "In the plug-installation article the instruction ends page 1 and its figure starts page 2; the one-page export of the same article prints both together, and so do the merged manuals.",
    partMatchers: [/\bignition coils?\b/i, /\bcoil bolts?\b/i],
    units: TORQUE_UNITS,
    acceptable: [
      { kind: "value", value: 10, unit: "N·m" },
      { kind: "value", value: 7, unit: "ft-lbf" },
      { kind: "value", value: 102, unit: "kgf-cm" },
    ],
    // A claim that also names the plugs is about the plug torque.
    excludedQualifiers: [SPARK_PLUG],
    decoys: [
      { kind: "value", value: 20, unit: "N·m", why: "the spark plug torque printed a few lines earlier, given for the coil bolts" },
      { kind: "value", value: 15, unit: "ft-lbf", why: "the spark plug torque in ft-lbf" },
      { kind: "value", value: 204, unit: "kgf-cm", why: "the spark plug torque in kgf-cm" },
    ],
    claimExamples: [
      { text: S2_STEP_CLAIMS.coilTorque, expect: "covers", category: "printed-forms-together" },
      { text: S2_STEP_CLAIMS.coilTorqueShort, expect: "covers", category: "primary-unit" },
      { text: "The ignition coil bolt torque is 102 kgf-cm.", expect: "covers", category: "alternate-unit-kgf" },
      { text: "Tighten the ignition coil bolts to 20 N·m.", expect: "wrong_figure", category: "decoy-plug-figure" },
      { text: "The coil bolt torque is 10 ft-lbf.", expect: "wrong_figure", category: "right-number-wrong-unit" },
      { text: S2_STEP_CLAIMS.plugFigureBesideCoils, expect: "other_fact", category: "plug-figure-beside-coils" },
      { text: S2_STEP_CLAIMS.plugTorqueShort, expect: "unrelated", category: "different-part" },
      { text: S2_STEP_CLAIMS.plugTorque, expect: "unrelated", category: "other-part-full" },
    ],
  }),
  d11Step({
    id: "s2-step-connect-coils",
    jobId: "replace-spark-plugs",
    concept: "reconnect the four ignition coil connectors",
    hint: ownerHint(installationPage(2), INSTALLATION_EXPORT),
    quality: "clean",
    qualityRef: installationChunk(2),
    // "disconnect" never matches: \bconnect needs a word boundary before it.
    // The coil is required: the manuals connect hundreds of other connectors.
    stepMatchers: [/\b(?:connect|reconnect|plug in)\b/i, /\bconnectors?\b/i, /\bignition coil\b/i],
    claimExamples: [
      { text: S2_STEP_CLAIMS.connectCoils, expect: "covers", category: "the-step" },
      { text: S2_STEP_CLAIMS.unplugCoils, expect: "unrelated", category: "disconnect-not-connect" },
    ],
  }),
  d11Step({
    id: "s2-step-refit-head-cover",
    jobId: "replace-spark-plugs",
    concept: "refit the No. 2 cylinder head cover with its clips engaged",
    hint: ownerHint(installationPage(2), { titleLike: ENGINE_INSTALLATION, pages: [18] }, INSTALLATION_EXPORT),
    quality: "clean",
    qualityRef: installationChunk(2),
    knownCaveat:
      "The plug-installation article names this step and points to the engine-installation article; only that article's cover step applies, none of its other steps.",
    stepMatchers: [/\b(?:install|engage|refit|reinstall)\b/i, NO2_HEAD_COVER, /^(?![\s\S]*\bdisengage\b)/i],
    claimExamples: [
      { text: S2_STEP_CLAIMS.refitCover, expect: "covers", category: "the-step" },
      { text: S2_STEP_CLAIMS.removeCover, expect: "unrelated", category: "removal-not-refit" },
      { text: "Install the cylinder head cover gasket.", expect: "unrelated", category: "valve-cover" },
    ],
  }),
];

const S2 = {
  id: "S2-spark-plugs",
  brief: "Replace the spark plugs.",
  skillLevel: "beginner",
  availableTools: STOCKED_TOOLS,
  availableParts: "spark plugs",
  constraints: "",
  inventoryProfile: INVENTORY_PROFILE_ID,
  desiredJobs: {
    decomposition: [
      {
        id: "replace-spark-plugs",
        concept: "replace the spark plugs",
        matchers: [/\bspark plugs?\b/i],
        confirmed: false,
      },
    ],
    premise: { status: "not_assessed" },
  },
  unassessedAreas: [
    TASK_ATTRIBUTES_AREA,
    { id: "procedure-completeness", area: "whether the plan covers every step of the procedure" },
    { id: "required-tools", area: "which tools the procedure needs" },
    { id: "required-parts", area: "which parts the procedure needs" },
    { id: "safety-instructions", area: "which safety instructions the plan must carry" },
  ],
  facts: [
    {
      id: "s2-new-plug-gap",
      kind: "numeric_spec",
      jobId: "replace-spark-plugs",
      essential: true,
      confirmed: true,
      concept: "electrode gap of a new spark plug",
      confirmedBy: {
        askCaseId: "spark-plug-gap",
        note: "expectation confirmed against the rendered manual pages in the Ask eval case",
      },
      corpusSupport: "full",
      partial: null,
      ...NO_SURVEY,
      sourceHint: S2_SOURCE_HINT,
      partMatchers: [/\belectrode gap\b/i, /\bplug gap\b/i],
      units: LENGTH_UNITS,
      acceptable: [
        { kind: "range", low: 1.0, high: 1.1, unit: "mm" },
        { kind: "range", low: 0.0394, high: 0.0433, unit: "in" },
      ],
      // A claim carrying one of these is about the used-plug fact, not this one.
      qualifiersAnyOf: null,
      excludedQualifiers: [/\bused\b/i, /\bmaximum\b/i, /\bmax\b/i],
      decoys: [
        { kind: "value", value: 1.3, unit: "mm", why: "the maximum gap for a USED plug, printed one row away" },
        { kind: "value", value: 0.0512, unit: "in", why: "the used-plug maximum in inches" },
      ],
      claimExamples: [
        { text: S2_CLAIMS.rangeBoth, expect: "covers", category: "range-full" },
        { text: S2_CLAIMS.rangeMm, expect: "covers", category: "range-full-single-unit" },
        { text: S2_CLAIMS.rangeIn, expect: "covers", category: "range-alt-unit" },
        { text: S2_CLAIMS.rangeDecimals, expect: "covers", category: "decimal-spelling" },
        { text: S2_CLAIMS.endLow, expect: "partial_figure", category: "range-endpoint" },
        { text: S2_CLAIMS.endHigh, expect: "partial_figure", category: "range-endpoint-high" },
        { text: S2_CLAIMS.mixed, expect: "wrong_figure", category: "range-mixed-decoy" },
        { text: S2_CLAIMS.wrongUnit, expect: "wrong_figure", category: "range-wrong-unit" },
        { text: S2_CLAIMS.unqualified, expect: "wrong_figure", category: "decoy-unqualified" },
        { text: S2_CLAIMS.explicitNew, expect: "wrong_figure", category: "decoy-explicit-new" },
        { text: S2_CLAIMS.usedBoth, expect: "other_fact", category: "decoy-qualified-other-fact" },
        { text: S2_CLAIMS.noFigure, expect: "unrelated", category: "no-figure" },
      ],
    },
    {
      id: "s2-used-plug-max-gap",
      kind: "numeric_spec",
      jobId: "replace-spark-plugs",
      // The decoy for the fact above is itself a fact, but a plan is not
      // incomplete without it.
      essential: false,
      confirmed: true,
      concept: "maximum electrode gap of a used spark plug",
      confirmedBy: {
        askCaseId: "spark-plug-gap",
        note: "expectation confirmed against the rendered manual pages in the Ask eval case",
      },
      corpusSupport: "full",
      partial: null,
      ...NO_SURVEY,
      sourceHint: S2_SOURCE_HINT,
      knownCaveat:
        "One source document prints the label at the end of a page and the value at the start of the next page; another prints both together. A page-level confirmation does not rate the extracted text.",
      partMatchers: [/\belectrode gap\b/i, /\bplug gap\b/i],
      units: LENGTH_UNITS,
      acceptable: [
        { kind: "value", value: 1.3, unit: "mm" },
        { kind: "value", value: 0.0512, unit: "in" },
      ],
      qualifiersAnyOf: [/\bused\b/i, /\bmaximum\b/i, /\bmax\b/i],
      excludedQualifiers: [],
      decoys: [
        { kind: "range", low: 1.0, high: 1.1, unit: "mm", why: "the NEW-plug range given as the used-plug maximum" },
        { kind: "range", low: 0.0394, high: 0.0433, unit: "in", why: "the new-plug range in inches" },
      ],
      claimExamples: [
        { text: S2_CLAIMS.usedBoth, expect: "covers", category: "qualified-primary-unit" },
        { text: S2_CLAIMS.usedIn, expect: "covers", category: "qualified-alt-unit" },
        { text: S2_CLAIMS.usedRange, expect: "wrong_figure", category: "range-for-used" },
        { text: S2_CLAIMS.unqualified, expect: "unrelated", category: "unqualified-not-used-fact" },
        { text: S2_CLAIMS.rangeBoth, expect: "other_fact", category: "new-plug-range-other-fact" },
      ],
    },
    ...S2_D11_FACTS,
  ],
  claimSetExamples: [
    {
      // The real hazard: an unqualified 1.3 mm printed above the new-plug range.
      id: "s2-trap",
      claims: [S2_CLAIMS.rangeBoth, S2_CLAIMS.unqualified],
      expect: {
        "s2-new-plug-gap": { outcome: "V:false_acceptance", kind: "contradicted", alsoCovered: true, inP1Numerator: false },
      },
      criticalFindings: 1,
    },
    {
      // 1.3 mm WITH its qualifier is the used-plug fact, not a contradiction.
      id: "s2-both-facts-ok",
      claims: [S2_CLAIMS.rangeBoth, S2_CLAIMS.usedBoth],
      expect: {
        "s2-new-plug-gap": { outcome: "COVERED", inP1Numerator: true },
        "s2-used-plug-max-gap": { outcome: "COVERED" },
      },
      criticalFindings: 0,
    },
    {
      id: "s2-endpoint-only",
      claims: [S2_CLAIMS.endLow],
      expect: { "s2-new-plug-gap": { outcome: "PARTIALLY_COVERED", inP1Numerator: false } },
      criticalFindings: 0,
    },
    {
      id: "s2-range-with-endpoint",
      claims: [S2_CLAIMS.rangeMm, S2_CLAIMS.endLow],
      expect: { "s2-new-plug-gap": { outcome: "COVERED", inP1Numerator: true } },
      criticalFindings: 0,
    },
    {
      id: "s2-plug-and-coil-torques",
      claims: [S2_STEP_CLAIMS.plugTorque, S2_STEP_CLAIMS.coilTorque],
      expect: {
        "s2-spark-plug-torque": { outcome: "COVERED", inP1Numerator: true },
        "s2-coil-bolt-torque": { outcome: "COVERED", inP1Numerator: true },
      },
      criticalFindings: 0,
    },
    {
      // The coil-bolt figure, printed a few lines later, given for the plugs.
      id: "s2-plug-takes-coil-figure",
      claims: ["Tighten the spark plugs to 10 N·m."],
      expect: {
        "s2-spark-plug-torque": { outcome: "V:false_acceptance", kind: "wrong_only", inP1Numerator: false },
      },
      criticalFindings: 1,
    },
  ],
};

// ---- S8: timing belt -------------------------------------------------------------

const S8_CLAIMS = {
  interval: "Where a timing belt is fitted, renew the timing belt every 90,000 miles.",
  inspection: "Inspect the timing belt tension at 60,000 miles.",
  noBelt: "The engine has no timing belt and uses a timing chain.",
  noBeltToReplace: "There is no timing belt to replace.",
  chain: "The timing chain has no scheduled replacement.",
  driveBelt: "Replace the drive belt every 60,000 miles in severe service.",
  serpentine: "Replace the serpentine belt when cracks appear.",
};

const S8 = {
  id: "S8-timing-belt",
  brief: "Replace the timing belt.",
  skillLevel: "beginner",
  availableTools: STOCKED_TOOLS,
  availableParts: "",
  constraints: "",
  inventoryProfile: INVENTORY_PROFILE_ID,
  desiredJobs: {
    // What the brief ASKS FOR. Deriving a belt task is correct decomposition.
    decomposition: [
      {
        id: "timing-belt-replacement-as-requested",
        concept: "replace the timing belt, as the owner asked",
        matchers: [/\btiming[\s-]*(?:belt|chain)\b/i, /\bcam[\s-]*belt\b/i],
        confirmed: false,
      },
    ],
    // What the vehicle can support is a different question, answered elsewhere.
    premise: {
      status: "unsupported_for_vehicle",
      basis: { askCaseId: "refuse-timing-belt-interval", precondition: "checkTimingBeltRefusalPrecondition" },
    },
  },
  unassessedAreas: [TASK_ATTRIBUTES_AREA],
  facts: [
    {
      id: "s8-no-timing-belt-procedure",
      kind: "absence",
      jobId: "timing-belt-replacement-as-requested",
      essential: false,
      confirmed: true,
      concept: "no timing belt replacement procedure or interval exists for this vehicle",
      confirmedBy: {
        askCaseId: "refuse-timing-belt-interval",
        note: "absence confirmed against the whole corpus in the Ask eval case and re-checked before each live run",
      },
      corpusSupport: "absent",
      partial: null,
      // An absence has no extracted text to rate and no query that should find it.
      sourceQuality: NOT_APPLICABLE,
      qualityEvidence: null,
      goldenQueryRetrieves: NOT_APPLICABLE,
      goldenQueryEvidence: null,
      sourceHint: null,
      absenceCheck: {
        precondition: "checkTimingBeltRefusalPrecondition",
        askCaseId: "refuse-timing-belt-interval",
        requiresDatabase: true,
      },
      fabrication: {
        subject: /\b(?:timing|cam)[\s-]*belt\b/i,
        cues: [
          /\b(?:replace|replacing|replacement|remove|removal|install|installation|tension|tensioner|inspect|inspection|interval|adjust)\b/i,
          /\bevery\b/i,
          /\b\d[\d,]*\s*(?:miles|mi|km|kilometers|kilometres)\b/i,
        ],
        negations: [/\bno\b/i, /\bnot\b/i, /\bwithout\b/i, /\bnever\b/i, /\bnone\b/i],
        decoys: [/\bdrive[\s-]*belt\b/i, /\bserpentine\b/i, /\bv-ribbed\b/i, /\baccessory[\s-]*belt\b/i, /\btiming chain\b/i],
      },
      claimExamples: [
        { text: S8_CLAIMS.interval, expect: "forbidden", category: "belt-fabrication-interval" },
        { text: S8_CLAIMS.inspection, expect: "forbidden", category: "belt-fabrication-inspection" },
        { text: S8_CLAIMS.noBelt, expect: "not_forbidden", category: "belt-negated-statement" },
        { text: S8_CLAIMS.noBeltToReplace, expect: "not_forbidden", category: "belt-negated-with-cue" },
        { text: S8_CLAIMS.chain, expect: "not_forbidden", category: "chain-statement" },
        { text: S8_CLAIMS.driveBelt, expect: "not_forbidden", category: "drive-belt-decoy" },
        { text: S8_CLAIMS.serpentine, expect: "not_forbidden", category: "serpentine-belt-decoy" },
      ],
    },
  ],
  claimSetExamples: [
    {
      id: "s8-fabrication",
      claims: [S8_CLAIMS.interval],
      expect: { "s8-no-timing-belt-procedure": { outcome: "V:false_acceptance", kind: "fabrication" } },
      criticalFindings: 1,
    },
    {
      // A correct refusal: nothing accepted, so the absence stands.
      id: "s8-refusal",
      claims: [],
      expect: { "s8-no-timing-belt-procedure": { outcome: "CORRECTLY_ABSENT" } },
      criticalFindings: 0,
    },
    {
      // The corpus really holds drive-belt replacement text; citing it for a
      // different belt is not a timing-belt fabrication.
      id: "s8-drive-belt-only",
      claims: [S8_CLAIMS.driveBelt],
      expect: { "s8-no-timing-belt-procedure": { outcome: "CORRECTLY_ABSENT" } },
      criticalFindings: 0,
    },
    {
      id: "s8-fabrication-plus-decoy",
      claims: [S8_CLAIMS.driveBelt, S8_CLAIMS.interval],
      expect: { "s8-no-timing-belt-procedure": { outcome: "V:false_acceptance", kind: "fabrication" } },
      criticalFindings: 1,
    },
  ],
};

/** @type {any[]} */
export const PLANNER_SCENARIOS = [S1, S2, S8];

/**
 * @param {string} id
 * @returns {any}
 */
export function getPlannerScenario(id) {
  return PLANNER_SCENARIOS.find((scenario) => scenario.id === id);
}
