import {
  checkClaimNumbers,
  quoteAppearsInChunk,
  redactSpecNumbers,
} from "../askEvidenceContract.js";

// Repair-plan evidence contract.
//
// The problem this exists for: the planner used to stream the model's prose
// straight to the browser. A sentence containing an invented torque value
// rendered exactly like one copied from the owner's manual, and readiness was
// scored from free-text inventory strings that nothing checked against the
// repair's real requirements.
//
// The contract instead asks the model for ATOMIC CLAIMS, each carrying a
// verbatim `evidenceQuote` and a run-wide source id (S1, S2, ...). The server:
//   1. validates the shape (hand-written; no new dependency),
//   2. maps each source id back to the chunk it was built from,
//   3. verifies the quote really appears in what the model was shown,
//   4. verifies the claim itself appears within that quote,
//   5. runs the numeric anomaly detector over the claim,
//   6. derives verified / partial / not_found ITSELF,
//   7. renders the final text from accepted claims only.
//
// It deliberately does NOT reuse Ask's schema, renderer, or "answered" status.
// Ask answers a question; the planner covers a task list, so its states and its
// coverage rules are different. Only the three neutral, config-free helpers are
// shared.

/**
 * Technical claims naming an item the repair REQUIRES. They are grouped into
 * requirement rows rather than read as statements about the repair, so anything
 * that renders claims must partition on this list rather than inventing its own
 * copy -- two modules disagreeing about what counts as "a verified statement" is
 * how a checklist ended up saying nothing was verified directly above a list of
 * verified requirements.
 */
export const REQUIREMENT_CLAIM_KINDS = ["required_tool", "required_part"];

/** Technical claims that state something about the repair itself. */
export const STATEMENT_CLAIM_KINDS = [
  "procedure",
  "numeric_spec",
  "safety_instruction",
  "vehicle_fact",
];

/** Claims that describe the repair itself. Coverage requires one of these. */
export const TECHNICAL_CLAIM_KINDS = [...STATEMENT_CLAIM_KINDS, ...REQUIREMENT_CLAIM_KINDS];

/** Grounded assertions that a requirement group is empty. */
export const NEGATIVE_CLAIM_KINDS = ["no_required_tools", "no_required_parts"];

export const CLAIM_KINDS = [...TECHNICAL_CLAIM_KINDS, ...NEGATIVE_CLAIM_KINDS];

// Same list, as a set: a requirement claim is exactly the kind that must name
// the item it requires.
const ITEM_NAME_KINDS = new Set(REQUIREMENT_CLAIM_KINDS);

const ALLOWED_CLAIM_FIELDS = new Set([
  "taskId",
  "kind",
  "claim",
  "sourceId",
  "evidenceQuote",
  "itemName",
  "clauseIndex",
]);

// Fixed, server-authored guidance. It describes how to organize the job, never
// what the vehicle requires, so it needs no citation and can never carry an
// invented specification.
export const ORGANIZATIONAL_GUIDANCE = [
  "Work on level ground with the vehicle secured before starting.",
  "Read every cited procedure end to end before touching a fastener.",
  "Confirm part numbers against the vehicle before buying.",
];

/** Normalizes a requirement or inventory phrase for exact-phrase matching. */
export function normalizeRequirementName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Validates the finalizer payload's SHAPE against the canonical task list.
 *
 * Structural problems are returned as errors rather than thrown so the agent
 * can hand them back to the model for a bounded number of corrections.
 *
 * @param {any} payload
 * @param {{ tasks?: any[], sourceIds?: Set<string> }} [context]
 */
export function validateFinalizerPayload(payload, { tasks = [], sourceIds = new Set() } = {}) {
  const errors = [];

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { valid: false, errors: ["finalize_repair_plan expects an object."], claims: [] };
  }

  for (const key of Object.keys(payload)) {
    if (key !== "claims") {
      errors.push(`Unknown field "${key}". Only "claims" is accepted.`);
    }
  }

  if (!Array.isArray(payload.claims)) {
    errors.push('"claims" must be an array. Send [] when nothing could be grounded.');
    return { valid: false, errors, claims: [] };
  }

  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const claims = [];

  payload.claims.forEach((claim, index) => {
    const label = `claims[${index}]`;

    if (!claim || typeof claim !== "object" || Array.isArray(claim)) {
      errors.push(`${label} must be an object.`);
      return;
    }

    for (const key of Object.keys(claim)) {
      if (!ALLOWED_CLAIM_FIELDS.has(key)) {
        errors.push(`${label} has unknown field "${key}".`);
      }
    }

    const task = tasksById.get(claim.taskId);

    if (!task) {
      errors.push(`${label}.taskId ${JSON.stringify(claim.taskId)} is not a canonical task id.`);
    }

    if (!CLAIM_KINDS.includes(claim.kind)) {
      errors.push(`${label}.kind ${JSON.stringify(claim.kind)} is not a recognized kind.`);
    }

    if (typeof claim.claim !== "string" || !claim.claim.trim()) {
      errors.push(`${label}.claim must be a non-empty string.`);
    }

    if (typeof claim.sourceId !== "string" || !sourceIds.has(claim.sourceId)) {
      errors.push(`${label}.sourceId ${JSON.stringify(claim.sourceId)} is not a retrieved source.`);
    }

    if (typeof claim.evidenceQuote !== "string" || !claim.evidenceQuote.trim()) {
      errors.push(`${label}.evidenceQuote must be a non-empty verbatim excerpt.`);
    }

    if (ITEM_NAME_KINDS.has(claim.kind) && (typeof claim.itemName !== "string" || !claim.itemName.trim())) {
      errors.push(`${label}.itemName is required for ${claim.kind}.`);
    }

    // A compound task covers more than one clause. Requiring the model to say
    // WHICH clause a claim supports is what stops one brake citation from
    // certifying an ungrounded steering diagnosis in the same task.
    if (task?.compound) {
      const clauseCount = task.clauses?.length || 0;

      if (
        !Number.isInteger(claim.clauseIndex) ||
        claim.clauseIndex < 0 ||
        claim.clauseIndex >= clauseCount
      ) {
        errors.push(
          `${label}.clauseIndex must be an integer 0-${clauseCount - 1} because task ${
            claim.taskId
          } covers ${clauseCount} clauses.`
        );
      }
    }

    claims.push(claim);
  });

  return { valid: errors.length === 0, errors, claims };
}

/**
 * Verifies each validated claim against the source it cites.
 *
 * Fails CLOSED: a claim whose quote is not in the source, whose text is not in
 * its own quote, or whose numbers are not supported becomes a GAP rather than
 * rendered content. Rejected claims never disappear silently -- if they did, a
 * model could submit one easy claim, omit everything hard, and still look
 * fully grounded.
 *
 * @param {any[]} claims
 * @param {{ sourcesById: Map<string, any> }} context
 */
export function verifyClaims(claims, { sourcesById }) {
  const accepted = [];
  const rejected = [];

  for (const claim of claims) {
    const source = sourcesById.get(claim.sourceId);
    // Verify against exactly what the model was shown, not the full stored
    // chunk: a quote can only be honest if it came from visible text.
    const evidenceText = source?.evidenceText || "";

    if (!quoteAppearsInChunk(claim.evidenceQuote, evidenceText)) {
      rejected.push({ claim, reason: "quote_not_in_source" });
      continue;
    }

    if (!quoteAppearsInChunk(claim.claim, claim.evidenceQuote)) {
      // Paraphrase. The quote may be real while the sentence built from it is
      // not, which is exactly how an invented spec acquires a citation.
      rejected.push({ claim, reason: "claim_not_in_quote" });
      continue;
    }

    const numbers = checkClaimNumbers(claim.claim, claim.evidenceQuote);

    if (!numbers.grounded) {
      rejected.push({ claim, reason: "unsupported_number" });
      continue;
    }

    if (ITEM_NAME_KINDS.has(claim.kind)) {
      const itemName = normalizeRequirementName(claim.itemName);

      if (!itemName || !normalizeRequirementName(claim.claim).includes(itemName)) {
        rejected.push({ claim, reason: "item_not_in_claim" });
        continue;
      }
    }

    accepted.push({ ...claim, source });
  }

  return { accepted, rejected };
}

const REJECTION_TEXT = {
  quote_not_in_source: "the quoted text was not found in the cited document",
  claim_not_in_quote: "the statement was not supported word-for-word by its quote",
  unsupported_number: "a number in the statement was not present in the cited text",
  item_not_in_claim: "the named item did not appear in the supporting statement",
};

/**
 * Turns rejections into owner-readable gaps.
 *
 * Numbers are redacted: reprinting "torque to 54 Nm" inside a gap that says the
 * value was unverified still puts the invented number in front of the owner.
 */
export function describeRejections(rejected) {
  return rejected.map((entry) => {
    const detail = REJECTION_TEXT[entry.reason] || "the statement could not be verified";
    return `Dropped an unverified statement for task ${entry.claim.taskId}: ${detail} (${redactSpecNumbers(
      entry.claim.claim
    )}).`;
  });
}

/**
 * Which canonical tasks are covered by accepted evidence.
 *
 * A task is covered when it has at least one accepted TECHNICAL claim and no
 * rejected claims. A compound task needs one per clause.
 */
export function assessTaskCoverage({ tasks, accepted, rejected }) {
  const rejectedTaskIds = new Set(rejected.map((entry) => entry.claim.taskId));

  return tasks.map((task) => {
    const technical = accepted.filter(
      (claim) => claim.taskId === task.id && TECHNICAL_CLAIM_KINDS.includes(claim.kind)
    );

    const hasRejection = rejectedTaskIds.has(task.id);
    let clausesCovered = true;

    if (task.compound) {
      const covered = new Set(technical.map((claim) => claim.clauseIndex));
      clausesCovered = (task.clauses || []).every((_clause, index) => covered.has(index));
    }

    return {
      taskId: task.id,
      title: task.title,
      claimCount: technical.length,
      covered: technical.length > 0 && !hasRejection && clausesCovered,
      hasRejection,
      clausesCovered,
    };
  });
}

/**
 * Derives the run's evidence status.
 *
 * `verified` is a claim about THIS RUN, not about the manuals: every displayed
 * statement passed the exact checks above. It does not mean the uploaded PDFs
 * are complete.
 */
export function deriveEvidenceStatus({ coverage, accepted, requirements }) {
  const technicalAccepted = accepted.filter((claim) =>
    TECHNICAL_CLAIM_KINDS.includes(claim.kind)
  );

  // An empty claims array is the honest "nothing could be grounded" result and
  // may only ever be not_found.
  if (!technicalAccepted.length) {
    return "not_found";
  }

  const everyTaskCovered = coverage.length > 0 && coverage.every((entry) => entry.covered);
  const requirementsResolved =
    requirements.tools.status !== "unknown" && requirements.parts.status !== "unknown";

  return everyTaskCovered && requirementsResolved ? "verified" : "partial";
}

/**
 * Groups accepted requirement claims and matches them against trusted inventory.
 *
 * Matching is exact-phrase on normalized text. No fuzzy or embedding guesses:
 * an uncertain match here becomes readiness points, and a wrongly-awarded point
 * tells an owner they are ready for a brake job they cannot finish.
 */
export function buildRequirementGroups({ accepted, availableTools, availableParts }) {
  const group = (itemKind, negativeKind, inventory) => {
    const required = [
      ...new Set(
        accepted
          .filter((claim) => claim.kind === itemKind)
          .map((claim) => normalizeRequirementName(claim.itemName))
          .filter(Boolean)
      ),
    ];

    const declaredNone = accepted.some((claim) => claim.kind === negativeKind);

    if (!required.length) {
      // A grounded "no tools required" satisfies the group. An EMPTY list does
      // not: silence is not evidence that nothing is needed.
      return declaredNone
        ? { status: "none_required", required: [], satisfied: [], missing: [] }
        : { status: "unknown", required: [], satisfied: [], missing: [] };
    }

    const satisfied = [];
    const missing = [];

    for (const item of required) {
      const owned = inventory.some((entry) => entry.includes(item));
      (owned ? satisfied : missing).push(item);
    }

    return {
      status: missing.length ? "unmet" : "satisfied",
      required,
      satisfied,
      missing,
    };
  };

  return {
    tools: group("required_tool", "no_required_tools", availableTools),
    parts: group("required_part", "no_required_parts", availableParts),
  };
}

/**
 * Renders the plan the owner reads.
 *
 * Built from accepted claims plus fixed organizational guidance only. The
 * model's own prose never reaches this string.
 */
export function renderPlanText({ tasks, accepted, coverage, requirements, gaps }) {
  const lines = [];
  const coverageById = new Map(coverage.map((entry) => [entry.taskId, entry]));

  lines.push("Repair plan");
  lines.push("");

  for (const task of tasks) {
    const entry = coverageById.get(task.id);
    lines.push(`${task.id}. ${task.title}${task.safetyCritical ? "  [safety-critical]" : ""}`);

    const claims = accepted.filter(
      (claim) => claim.taskId === task.id && TECHNICAL_CLAIM_KINDS.includes(claim.kind)
    );

    if (!claims.length) {
      lines.push("   No statement from your documents could be verified for this task.");
    } else {
      for (const claim of claims) {
        const { source } = claim;
        lines.push(`   - ${claim.claim} [${claim.sourceId}: ${source.documentTitle} p.${source.pageNumber}]`);
      }
    }

    if (entry && !entry.covered && claims.length) {
      lines.push("   Coverage for this task is incomplete.");
    }

    lines.push("");
  }

  const describeGroup = (label, groupData) => {
    if (groupData.status === "none_required") {
      return `${label}: the cited procedures state none are required.`;
    }
    if (groupData.status === "unknown") {
      return `${label}: not established from your documents.`;
    }
    if (groupData.status === "satisfied") {
      return `${label}: all verified items are on your list (${groupData.required.join(", ")}).`;
    }
    return `${label}: missing ${groupData.missing.join(", ")}.`;
  };

  lines.push("Requirements");
  lines.push(`   ${describeGroup("Tools", requirements.tools)}`);
  lines.push(`   ${describeGroup("Parts", requirements.parts)}`);
  lines.push("");

  lines.push("Before you start");
  for (const guidance of ORGANIZATIONAL_GUIDANCE) {
    lines.push(`   - ${guidance}`);
  }

  if (gaps.length) {
    lines.push("");
    lines.push("Gaps");
    for (const gap of gaps) {
      lines.push(`   - ${gap}`);
    }
  }

  return lines.join("\n").trim();
}

/**
 * The whole contract in one call.
 *
 * @param {any} payload  Raw `finalize_repair_plan` arguments from the model.
 * @param {{ tasks: any[], sources: any[], availableTools: string[], availableParts: string[] }} context
 */
export function buildRepairPlanEvidence(payload, { tasks, sources, availableTools, availableParts }) {
  const sourcesById = new Map(sources.map((source) => [source.id, source]));
  const validation = validateFinalizerPayload(payload, {
    tasks,
    sourceIds: new Set(sourcesById.keys()),
  });

  if (!validation.valid) {
    return { valid: false, errors: validation.errors };
  }

  const { accepted, rejected } = verifyClaims(validation.claims, { sourcesById });
  const requirements = buildRequirementGroups({ accepted, availableTools, availableParts });
  const coverage = assessTaskCoverage({ tasks, accepted, rejected });

  const gaps = [...describeRejections(rejected)];

  for (const entry of coverage) {
    if (!entry.covered && !entry.hasRejection) {
      gaps.push(
        entry.claimCount === 0
          ? `No verified evidence was found for task ${entry.taskId} ("${entry.title}").`
          : `Task ${entry.taskId} ("${entry.title}") is only partly covered by verified evidence.`
      );
    }
  }

  if (requirements.tools.status === "unknown") {
    gaps.push("Required tools could not be established from your documents.");
  } else if (requirements.tools.status === "unmet") {
    gaps.push(`Tools not on your list: ${requirements.tools.missing.join(", ")}.`);
  }

  if (requirements.parts.status === "unknown") {
    gaps.push("Required parts could not be established from your documents.");
  } else if (requirements.parts.status === "unmet") {
    gaps.push(`Parts not on your list: ${requirements.parts.missing.join(", ")}.`);
  }

  const evidenceStatus = deriveEvidenceStatus({ coverage, accepted, requirements });

  // Only sources that actually support shown content become citations. A chunk
  // retrieved and then unused is not evidence for anything.
  const citedIds = new Set(accepted.map((claim) => claim.sourceId));
  const citations = sources
    .filter((source) => citedIds.has(source.id))
    .map((source) => ({
      sourceId: source.id,
      documentId: source.documentId,
      documentTitle: source.documentTitle,
      originalFilename: source.originalFilename,
      pageNumber: source.pageNumber,
      chunkIndex: source.chunkIndex,
      snippet: source.snippet,
    }));

  return {
    valid: true,
    evidenceStatus,
    requirements,
    coverage,
    citations,
    gaps,
    verifiedClaims: accepted.map((claim) => ({
      taskId: claim.taskId,
      kind: claim.kind,
      claim: claim.claim,
      sourceId: claim.sourceId,
    })),
    rejectedCount: rejected.length,
    text: renderPlanText({ tasks, accepted, coverage, requirements, gaps }),
  };
}
