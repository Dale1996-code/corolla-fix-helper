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
//   1. Only facts already CONFIRMED in the Ask eval cases are committed. An
//      unconfirmed golden fact is never introduced here, so it can never reach
//      a scored result. What is not assessed is named in `unassessedAreas`
//      (a name and nothing else), never as a placeholder fact.
//   2. "Unknown" is a value, not a default. `sourceQuality` and
//      `goldenQueryRetrieves` stay null until the Phase 4 survey, and null is
//      never read as clean. Confirming a fact against the rendered PDF page
//      says the manual states it; it says nothing about whether the extracted
//      text is usable. An ABSENT fact says `not_applicable` explicitly.
//   3. `desiredJobs` describe what the brief ASKS FOR, written from its meaning
//      and unconfirmed until reviewed, and are kept apart from the vehicle
//      `premise`. S8 asks for a repair this engine does not need: deriving that
//      task is correct decomposition, not an L0 defect.
//
// Everything here is public: concept-level facts and short figures only, no
// manual passages, and vehicle metadata only where it is plain metadata.

export const SCENARIO_SET_VERSION = 1;

export const NOT_APPLICABLE = "not_applicable";
export const INVENTORY_PROFILE_ID = "stocked-home-garage-v1";

// A kind is added together with its matcher (plannerJudge.js); a kind without a
// matcher would be data nobody can score. `procedure_step` arrived with the
// Phase 2b judge for the negative tests' own scenarios: no committed scenario
// has a confirmed procedure step yet (decision D11 is still open), so C1 stays
// `unscored` for S1, S2, and S8.
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
  if (!isObject(fact.confirmedBy) || !isText(fact.confirmedBy.askCaseId)) {
    problems.push(`${where}: confirmedBy must name the Ask case that confirmed the fact`);
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
      // Only COVERED counts toward P1: a contradicted or partly covered fact
      // stays in the denominator, so it can never inflate the success rate.
      if (expected.inP1Numerator !== (expected.outcome === "COVERED")) {
        problems.push(`${at}/${factId}: inP1Numerator must be ${expected.outcome === "COVERED"} (only COVERED counts in P1)`);
      }
    } else if ("inP1Numerator" in expected) {
      problems.push(`${at}/${factId}: a non-essential fact is outside P1, so it has no inP1Numerator`);
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
    { id: "filter-cap-torque", area: "the oil filter cap tightening torque" },
    { id: "fluid-capacities", area: "the engine oil capacity" },
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
    { id: "torque-specifications", area: "any tightening torque in the procedure" },
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
