import { retrieveRelevantChunks } from "../chunkRetrievalService.js";
import { normalizeText } from "../../utils/text.js";
// The safety rubric lives in its own module so the "is this safety critical"
// keyword list and the "which warnings apply" rule table stay in sync.
import { classifyRepairTask } from "../safetyClassifier.js";

// Deterministic tools the repair-planning agent can call.
//
// Each tool has a JSON schema (so the model knows how to call it) and a plain
// `execute` function that does real, testable work. Keeping the executors
// deterministic means the structured artifacts the UI renders do not depend on
// model randomness, and the whole pipeline can be tested without a live model.

// Fallback system detection, used ONLY when no safety rule claims the task.
//
// Bounded patterns, not substring `includes`. The old list matched substrings,
// which mis-filed real work: "abs" hit "shock ABSorber" (Brakes), and a bare
// "steering" made "steering wheel audio switch" Suspension repair. Anything
// hazardous is classified by safetyClassifier instead, so this table only has to
// name non-hazard systems.
const SYSTEM_PATTERNS = [
  {
    system: "Engine",
    pattern:
      /\bengines?\b|\bidles?\b|\bidling\b|\bmisfires?\b|\bspark plugs?\b|\bignition coils?\b|\btiming (chain|belt|cover)\b|\bengine oil\b|\boil (pan|filter|change|pressure)\b|\bvalves?\b|\bintake\b|\bthrottle\b|\bcamshafts?\b|\bhead gasket\b/,
  },
  {
    system: "Transmission",
    pattern:
      /\btransmissions?\b|\btransaxles?\b|\bclutch\b|\bgears?\b|\bshift(ing|er)?\b|\bsolenoids?\b|\batf\b/,
  },
  {
    system: "HVAC",
    pattern:
      /\bheaters?\b|\ba\/?c\b|\bair conditioning\b|\bblowers?\b|\bcabin (air )?filters?\b|\bvents?\b|\bdefrost(er)?\b|\brefrigerant\b/,
  },
  {
    system: "Electrical",
    pattern:
      /\bfuses?\b|\bsensors?\b|\bheadlights?\b|\btail ?lights?\b|\bcharging system\b|\brelays?\b|\bgrounds?\b/,
  },
];

const ADVANCED_TERMS = ["timing", "transmission", "clutch", "head gasket", "valve", "rebuild", "camshaft"];
const INTERMEDIATE_TERMS = ["alternator", "starter", "strut", "radiator", "water pump", "caliper", "injector"];

const SKILL_RANK = { beginner: 1, intermediate: 2, advanced: 3 };
const DIFFICULTY_RANK = { beginner: 1, intermediate: 2, advanced: 3 };

function detectFallbackSystem(text) {
  const lowered = String(text || "").toLowerCase();

  for (const entry of SYSTEM_PATTERNS) {
    if (entry.pattern.test(lowered)) {
      return entry.system;
    }
  }

  return "General";
}

/**
 * The one place a task's system, hazards, warnings, and readiness verdict are
 * decided. Everything downstream (extraction, readiness, checklist) reads this
 * result rather than re-deriving its own answer from different inputs.
 *
 * `text` is the full task text. An explicit `system` (present on model-supplied
 * tasks reaching checkRepairReadiness / buildOwnerChecklist) is included in the
 * hazard match so "system: Brakes" still counts, but the DERIVED system is never
 * fed back in -- that loop is what let a task be blocked with no matching hazard.
 */
function classifyTask(text, explicitSystem = "") {
  const hazardText = `${text || ""} ${explicitSystem || ""}`;
  const classification = classifyRepairTask(hazardText, {
    fallbackSystem: detectFallbackSystem(text),
  });

  return {
    ...classification,
    system: explicitSystem || classification.system || "General",
  };
}

function detectDifficulty(text) {
  const lowered = text.toLowerCase();

  if (ADVANCED_TERMS.some((term) => lowered.includes(term))) {
    return "advanced";
  }

  if (INTERMEDIATE_TERMS.some((term) => lowered.includes(term))) {
    return "intermediate";
  }

  return "beginner";
}

function buildKeywords(text, system) {
  const stopWords = new Set([
    "the", "and", "for", "with", "that", "this", "from", "when", "after", "before",
    "have", "has", "was", "are", "but", "not", "you", "your", "its", "car", "vehicle",
  ]);

  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 4 && !stopWords.has(word));

  const unique = [...new Set(words)].slice(0, 5);

  if (system && system !== "General") {
    unique.unshift(system.toLowerCase());
  }

  return [...new Set(unique)].slice(0, 6);
}

function splitBriefIntoFragments(brief) {
  return brief
    .split(/\r?\n|(?<=[.!?])\s+|;|•|\s-\s/)
    .map((fragment) => normalizeText(fragment))
    .filter((fragment) => fragment.split(/\s+/).length >= 3);
}

// --- Canonical task rules --------------------------------------------------
//
// The delimiters above never split on a conjunction, so "replace the front
// brakes and diagnose a steering shake" arrived as ONE task. That matters
// beyond tidiness: a task needs only one accepted claim to count as covered, so
// a single brake citation could certify an ungrounded steering diagnosis.
//
// Splitting on every "and" is worse -- it turns object lists ("pads, rotors,
// and calipers") and procedure steps ("lift the car and support it on stands")
// into fabricated tasks. So a split requires affirmative evidence on BOTH
// sides: each must carry its own action verb and its own object. When that
// evidence is missing the fragment stays whole and is marked `compound`, which
// the evidence contract uses to demand a claim per clause rather than one claim
// for the pair.

const REPAIR_ACTION_VERBS = [
  // Repair
  "replace", "swap", "change", "install", "rebuild", "bleed", "flush", "service",
  "repair", "fix", "adjust", "align", "rotate", "refill", "reseal", "resurface",
  // Inspection
  "inspect", "check", "measure", "test",
  // Diagnostic
  "diagnose", "troubleshoot", "trace", "scan",
];

// Setup verbs that describe positioning the car, never an independent job.
// Excluded deliberately: "lift the car and support it on stands" is one repair.
const HANDLING_VERBS = ["lift", "raise", "lower", "support", "secure", "place", "set", "park", "jack", "hold"];

// Jobs named as nouns rather than verb phrases.
const NOMINALIZED_JOBS = ["oil change", "brake job", "alignment", "tune-up", "tune up", "coolant flush"];

// Backstop for degenerate-task rejection when the system classifier returns
// "General" and no action verb is present. Deliberately excludes "car" and
// "vehicle" so "car makes noise" is still rejected as too vague to plan.
const COMPONENT_NOUNS = [
  "oil", "filter", "fluid", "belt", "hose", "battery", "tire", "tyre", "wheel", "bulb",
  "wiper", "mirror", "bumper", "door", "window", "mount", "bushing", "gasket", "seal",
  "pump", "pulley", "thermostat", "muffler", "exhaust", "axle", "bearing", "rotor",
  "drum", "pad", "shoe", "spark", "plug", "coil", "sensor", "fuse", "relay",
  "alternator", "starter", "radiator", "coolant", "transmission", "clutch", "brake",
  "caliper", "strut", "shock", "suspension", "steering", "engine", "injector",
];

// Words that cannot serve as a task's object.
const OBJECTLESS_WORDS = new Set([
  "the", "a", "an", "my", "its", "it", "them", "they", "this", "that", "these", "those",
  "and", "or", "then", "also", "plus", "for", "with", "to", "on", "in", "at", "of",
  "from", "into", "onto", "off", "out", "up", "down", "again", "spec", "specs", "both",
  "all", "car", "vehicle", "side", "sides",
]);

const CONJUNCTION_PATTERN = /\s+(?:as well as|and also|and then|and|then|also|plus)\s+/i;

const wordCount = (text) => (text.trim() ? text.trim().split(/\s+/).length : 0);

const buildWordListPattern = (words) => new RegExp(`\\b(?:${words.join("|")})\\b`, "i");

// Handling verbs need no pattern of their own: they are excluded simply by not
// appearing in REPAIR_ACTION_VERBS, so `hasRepairAction` never fires for them.
// The list is still used to keep them from counting as a task's object.
const ACTION_VERB_PATTERN = buildWordListPattern(REPAIR_ACTION_VERBS);
const NOMINALIZED_JOB_PATTERN = new RegExp(
  `(?:${NOMINALIZED_JOBS.map((job) => job.replace(/[-\s]/g, "[-\\s]")).join("|")})`,
  "i"
);
const COMPONENT_NOUN_PATTERN = buildWordListPattern(COMPONENT_NOUNS.map((noun) => `${noun}s?`));

/**
 * Does this text describe a repair, inspection, or diagnostic ACTION of its own?
 * A side made only of nouns is a continuation of the other side's verb.
 */
function hasRepairAction(text) {
  return ACTION_VERB_PATTERN.test(text) || NOMINALIZED_JOB_PATTERN.test(text);
}

/**
 * Does this text carry its own object? A verb aimed at a pronoun or a bare
 * adverb ("check them thoroughly", "torque to spec") is a step, not a task.
 */
function hasOwnObject(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .some(
      (word) =>
        word.length >= 3 &&
        !OBJECTLESS_WORDS.has(word) &&
        !word.endsWith("ly") &&
        !REPAIR_ACTION_VERBS.includes(word) &&
        !HANDLING_VERBS.includes(word)
    );
}

/** All three split tests. Both sides must pass or the fragment stays whole. */
function isIndependentRepairClause(side) {
  return wordCount(side) >= 3 && hasRepairAction(side) && hasOwnObject(side);
}

/**
 * Splits on a coordinating conjunction only when both sides independently read
 * as repair work. Default is NOT to split.
 */
function splitOnConjunctions(fragment, depth = 0) {
  if (depth >= 4) {
    return [fragment];
  }

  let searchFrom = 0;

  while (searchFrom < fragment.length) {
    const match = CONJUNCTION_PATTERN.exec(fragment.slice(searchFrom));

    if (!match) {
      break;
    }

    const splitAt = searchFrom + match.index;
    const left = fragment.slice(0, splitAt).trim();
    const right = fragment.slice(splitAt + match[0].length).trim();

    if (isIndependentRepairClause(left) && isIndependentRepairClause(right)) {
      return [...splitOnConjunctions(left, depth + 1), ...splitOnConjunctions(right, depth + 1)];
    }

    searchFrom = splitAt + match[0].length;
  }

  return [fragment];
}

/**
 * A fragment kept whole despite containing a conjunction may still cover two
 * things. Recording the clauses lets the evidence contract require a claim for
 * each instead of accepting one claim for the pair.
 */
function describeClauses(text) {
  const clauses = text
    .split(new RegExp(CONJUNCTION_PATTERN.source, "gi"))
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0);

  return clauses.length > 1 ? clauses : [];
}

/** Normalized form used only for duplicate detection. */
function taskDedupeKey(title) {
  return title.toLowerCase().replace(/[.!?]+$/, "").replace(/\s+/g, " ").trim();
}

/**
 * Is this fragment specific enough to plan against? "help" and "car makes
 * noise" are not: planning them produces a confident-looking task built on
 * nothing. Rejecting them is what makes the "no canonical tasks" readiness
 * branch reachable instead of dead code.
 */
function isPlannableTask(text, classification) {
  if (wordCount(text) < 3) {
    return false;
  }

  return (
    classification.system !== "General" ||
    classification.safetyCritical ||
    hasRepairAction(text) ||
    COMPONENT_NOUN_PATTERN.test(text)
  );
}

// --- Tool: extract_repair_tasks -------------------------------------------

/**
 * @param {{ brief?: string }} [args]
 */
export function extractRepairTasks({ brief } = {}) {
  const normalizedBrief = normalizeText(brief);

  if (!normalizedBrief) {
    return { tasks: [] };
  }

  // No fallback to the whole brief when nothing survives the fragment filter.
  // The old fallback guaranteed at least one task for ANY non-blank brief, so
  // "help" became a task titled "help" and the zero-task readiness branch could
  // never be reached.
  const fragments = splitBriefIntoFragments(normalizedBrief).flatMap((fragment) =>
    splitOnConjunctions(fragment)
  );

  const tasks = [];
  const seen = new Set();

  for (const fragment of fragments) {
    const classification = classifyTask(fragment);

    if (!isPlannableTask(fragment, classification)) {
      continue;
    }

    const title = fragment.length > 120 ? `${fragment.slice(0, 117)}...` : fragment;
    const key = taskDedupeKey(title);

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);

    const { system } = classification;
    const clauses = describeClauses(fragment);

    tasks.push({
      id: tasks.length + 1,
      title,
      system,
      difficulty: detectDifficulty(fragment),
      safetyFlags: classification.flags,
      // Carried on the task so readiness and the checklist reuse THIS decision
      // instead of re-classifying the (possibly truncated) title and reaching a
      // different answer.
      safetyCritical: classification.safetyCritical,
      // Kept whole despite joining two clauses: evidence must cover each.
      compound: clauses.length > 1,
      clauses,
      keywords: buildKeywords(fragment, system),
    });
  }

  return { tasks };
}

// --- Tool: search_repair_docs ---------------------------------------------

function buildSnippet(text) {
  const normalized = typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";

  if (!normalized) {
    return "";
  }

  return normalized.length > 220 ? `${normalized.slice(0, 217)}...` : normalized;
}

/**
 * @param {{ query?: string, limit?: number, taskId?: number }} [args]
 * @param {{ retrieve?: typeof retrieveRelevantChunks }} [deps]
 */
export async function searchRepairDocs(
  { query, limit = 4, taskId } = {},
  { retrieve = retrieveRelevantChunks } = {}
) {
  const normalizedQuery = normalizeText(query);

  if (!normalizedQuery) {
    return { query: "", taskId, citations: [], context: "" };
  }

  const rawChunks = await retrieve(normalizedQuery, { limit });
  const chunks = Array.isArray(rawChunks) ? rawChunks : [];

  const citations = chunks.map((chunk) => ({
    documentId: chunk.documentId,
    documentTitle: chunk.documentTitle,
    originalFilename: chunk.originalFilename,
    pageNumber: chunk.pageNumber,
    chunkIndex: chunk.chunkIndex,
    snippet: buildSnippet(chunk.chunkText),
  }));

  const context = chunks
    .map(
      (chunk, index) =>
        `[${index + 1}] ${chunk.documentTitle} (page ${chunk.pageNumber}): ${buildSnippet(
          chunk.chunkText
        )}`
    )
    .join("\n");

  return { query: normalizedQuery, taskId, citations, context };
}

// --- Tool: check_repair_readiness -----------------------------------------

// Owner inventories written as a denial. Treating these as "tools listed" is
// what let a brake job with "none" for both fields score 100/100.
const INVENTORY_SENTINELS = new Set([
  "none", "n/a", "na", "n a", "nil", "nothing", "no", "unknown", "not sure",
  "none yet", "dont know", "don't know", "tbd",
]);

/**
 * Splits a trusted owner inventory into normalized entries, dropping sentinels.
 * Exported because the evidence contract matches required items against these
 * same entries.
 *
 * @param {string} [value]
 * @returns {string[]}
 */
export function parseInventory(value) {
  return String(value || "")
    .split(/[,;\n]/)
    .map((entry) =>
      entry
        .toLowerCase()
        .replace(/[.!?]+$/, "")
        .replace(/\s+/g, " ")
        .trim()
    )
    .filter((entry) => entry.length > 0 && !INVENTORY_SENTINELS.has(entry));
}

/**
 * Safety assessment for a task arriving at readiness / checklist generation.
 *
 * Tasks produced by extractRepairTasks already carry a decision; reuse it so the
 * three stages cannot disagree. Model-supplied tasks (the agent may pass its own
 * task objects) have not been classified yet, so classify them here from the
 * same rules. Either way exactly one rule set decides.
 */
function resolveTaskSafety(task) {
  const classification = classifyTask(task?.title || "", task?.system || "");
  const flags =
    Array.isArray(task?.safetyFlags) && task.safetyFlags.length
      ? task.safetyFlags
      : classification.flags;

  // Never report "critical" without a warning to show for it. If a task was
  // hand-built with flags but no recognizable hazard text, the flags themselves
  // are the evidence of criticality.
  const safetyCritical = classification.safetyCritical || flags.length > 0;

  const hazards = classification.hazards.length
    ? classification.hazards
    : safetyCritical
    ? ["declared safety risk"]
    : [];

  return {
    ...classification,
    flags,
    safetyCritical,
    hazards,
    // Recomputed from the RESOLVED hazards so a task can never be critical with
    // an empty reason (which happens when flags were supplied but the title
    // carries no recognizable hazard text).
    blockingReason: hazards.length
      ? `Safety-critical work detected (${hazards.join(
          ", "
        )}). Treat the steps as preparation only and have a professional confirm the repair.`
      : "",
  };
}

export function checkRepairReadiness({
  tasks = [],
  availableTools = "",
  availableParts = "",
  skillLevel = "beginner",
  ackSafety = false,
} = {}) {
  const normalizedSkill = SKILL_RANK[skillLevel] ? skillLevel : "beginner";
  const skillRank = SKILL_RANK[normalizedSkill];
  // Any non-empty string used to earn the full 25 points, so "none" and "n/a"
  // scored the same as a full tool chest. Parsed entries with the sentinels
  // removed is what a real inventory means.
  const hasTools = parseInventory(availableTools).length > 0;
  const hasParts = parseInventory(availableParts).length > 0;

  // One classification per task, reused for both the critical verdict and the
  // warnings. Previously these came from different places: safetyFlags were
  // computed in extractRepairTasks from the full fragment, while criticality was
  // re-derived here from the (truncated) title plus the system name -- so a task
  // could be blocked with no warning, or warned about without blocking.
  const assessed = tasks.map((task) => ({
    task,
    assessment: resolveTaskSafety(task),
  }));

  const safetyFlaggedTasks = assessed.filter(({ assessment }) => assessment.flags.length > 0);
  const safetyCriticalTasks = assessed.filter(({ assessment }) => assessment.safetyCritical);
  const hasSafetyCritical = safetyCriticalTasks.length > 0;
  const safetyAcknowledged = ackSafety === true;
  const overSkillTasks = tasks.filter(
    (task) => (DIFFICULTY_RANK[task.difficulty] || 1) > skillRank
  );

  const rubric = [
    { id: "tools_listed", label: "Required tools listed", points: 25, met: hasTools },
    { id: "parts_listed", label: "Required parts listed", points: 25, met: hasParts },
    {
      id: "skill_match",
      label: "Skill level matches task difficulty",
      points: 30,
      met: overSkillTasks.length === 0,
    },
    {
      id: "safety_reviewed",
      label: "Safety-critical work acknowledged",
      points: 20,
      // Only earned when there is no safety-critical work, or the owner has
      // explicitly acknowledged the risk. Listing tools/parts does not count.
      met: !hasSafetyCritical || safetyAcknowledged,
    },
  ];

  const score = rubric.reduce((total, item) => total + (item.met ? item.points : 0), 0);

  const gaps = [];
  if (!hasTools) {
    gaps.push("No tools listed. Add the tools you have so missing tools can be flagged.");
  }
  if (!hasParts) {
    gaps.push("No parts listed. Add the parts on hand to confirm what still needs ordering.");
  }
  for (const task of overSkillTasks) {
    gaps.push(
      `"${task.title}" is rated ${task.difficulty} but skill level is ${normalizedSkill}. Consider a shop or extra prep.`
    );
  }
  if (hasSafetyCritical && !safetyAcknowledged) {
    // Name the hazards actually detected rather than a fixed example list, so
    // the blocking reason always matches the warnings shown on the tasks.
    const hazards = [
      ...new Set(safetyCriticalTasks.flatMap(({ assessment }) => assessment.hazards)),
    ];

    gaps.push(
      `Safety-critical work detected (${hazards.join(
        ", "
      )}). Treat the steps as preparation only and have a professional confirm the repair.`
    );
  }

  let level = "not_ready";
  if (score >= 80) {
    level = "ready";
  } else if (score >= 50) {
    level = "almost_ready";
  }

  // Never report "ready" for unacknowledged safety-critical work, regardless of
  // the numeric score, so a beginner is not nudged into an unsafe DIY repair.
  if (hasSafetyCritical && !safetyAcknowledged && level === "ready") {
    level = "almost_ready";
  }

  return {
    score,
    level,
    skillLevel: normalizedSkill,
    rubric,
    gaps,
    safetyCritical: hasSafetyCritical,
    safetyAcknowledged: hasSafetyCritical ? safetyAcknowledged : true,
    safetyFlags: [
      ...new Set(safetyFlaggedTasks.flatMap(({ assessment }) => assessment.flags)),
    ],
  };
}

// --- Tool: build_owner_checklist ------------------------------------------

export function buildOwnerChecklist({
  tasks = [],
  skillLevel = "beginner",
  ackSafety = false,
} = {}) {
  const skillRank = SKILL_RANK[skillLevel] || 1;
  const safetyAcknowledged = ackSafety === true;

  const checklist = tasks.map((task) => {
    const difficultyRank = DIFFICULTY_RANK[task.difficulty] || 1;
    // Same assessment the readiness check used -- not a second opinion.
    const assessment = resolveTaskSafety(task);
    const { safetyCritical } = assessment;

    // Safety-critical work is recommended to a shop unless the owner explicitly
    // accepts the risk; otherwise fall back to the skill-vs-difficulty split.
    let owner;
    if (safetyCritical && !safetyAcknowledged) {
      owner = "Shop Recommended";
    } else {
      owner = difficultyRank > skillRank ? "Professional shop" : "DIY";
    }

    return {
      taskId: task.id,
      task: task.title,
      system: task.system || assessment.system,
      owner,
      safetyCritical,
      // A checklist row can say "Shop Recommended" only alongside the warnings
      // that justify it. Carrying them here means the reason travels with the
      // recommendation instead of living only on the task list above it.
      safetyFlags: assessment.flags,
      safetyReason: safetyCritical ? assessment.blockingReason : "",
      priority: difficultyRank,
      // Generic placeholders, not verified repair instructions — labeled so a
      // beginner does not mistake them for a real procedure.
      steps: [
        "Placeholder: review the source procedure and torque specs from the cited documents",
        "Placeholder: gather the required parts and tools",
        owner === "DIY"
          ? "Placeholder: perform the repair following all safety notes"
          : "Placeholder: schedule and hand off to a professional shop",
        "Placeholder: verify the fix and log the result",
      ],
      done: false,
    };
  });

  // Highest-difficulty tasks first so the owner tackles blockers early.
  checklist.sort((left, right) => right.priority - left.priority || left.taskId - right.taskId);

  return { checklist };
}

// --- Tool: draft_handoff_notes --------------------------------------------

export function draftHandoffNotes({ tasks = [], vehicle = "the vehicle", partsNeeded = "" } = {}) {
  const taskTitles = tasks.map((task) => task.title);
  const systems = [...new Set(tasks.map((task) => task.system))];

  const partsShoppingList = [
    `Parts run for ${vehicle}:`,
    ...(normalizeText(partsNeeded)
      ? normalizeText(partsNeeded)
          .split(/,|\n/)
          .map((part) => `- ${part.trim()}`)
          .filter((line) => line.length > 2)
      : ["- Confirm exact parts after reviewing the cited procedures"]),
  ].join("\n");

  const mechanicHandoff = [
    `Vehicle: ${vehicle}`,
    `Systems involved: ${systems.join(", ") || "General"}`,
    "Requested work:",
    ...taskTitles.map((title) => `- ${title}`),
    "Please confirm diagnosis before replacing parts and share torque specs used.",
  ].join("\n");

  const maintenanceLogEntry = [
    `Maintenance log - ${vehicle}`,
    `Planned: ${taskTitles.join("; ") || "see brief"}`,
    "Status: planned (not yet started)",
  ].join("\n");

  return {
    partsShoppingList,
    mechanicHandoff,
    maintenanceLogEntry,
  };
}

// --- Tool registry --------------------------------------------------------

// Model-facing schemas.
//
// TRUST BOUNDARY: nothing the owner's readiness depends on appears here. The
// model previously supplied `tasks`, `availableTools`, `availableParts`,
// `skillLevel`, and `ackSafety` as tool arguments, and the registry ran them
// verbatim -- so the model could declare the safety risk acknowledged and hand
// itself a full tool chest. Those values now come only from the frozen trusted
// context the server builds from the request, and the registry below ignores
// any the model sends anyway. `brief` is trusted for the same reason: canonical
// tasks are extracted from the owner's brief before the loop starts.
export const repairToolSchemas = [
  {
    type: "function",
    name: "extract_repair_tasks",
    description:
      "Return the canonical, server-derived repair tasks for this run (id, title, system, difficulty, safety flags, keywords). Takes no arguments: the task list comes from the owner's brief and cannot be replaced.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "search_repair_docs",
    description:
      "Retrieve the most relevant chunks from the owner's uploaded PDF manuals to ground repair steps and torque specs. Returns citations. Every search must name the canonical task it is for.",
    parameters: {
      type: "object",
      properties: {
        taskId: {
          type: "integer",
          description: "The id of the canonical task from extract_repair_tasks that this search supports.",
        },
        query: { type: "string", description: "Keywords describing what to look up." },
        limit: { type: "integer", description: "Maximum chunks to return (default 4)." },
      },
      required: ["taskId", "query"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "check_repair_readiness",
    description:
      "Score the canonical tasks against the readiness rubric (tools, parts, skill match, safety) using the owner's stated inventory and skill. Takes no arguments: every input is owner-supplied and server-held.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "build_owner_checklist",
    description:
      "Turn the canonical tasks into a prioritized owner checklist with DIY vs professional-shop assignment. Takes no arguments. Safety-critical work is labeled Shop Recommended.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "draft_handoff_notes",
    description:
      "Draft channel-specific copy: a parts-store shopping list, a mechanic handoff summary, and a maintenance-log entry.",
    parameters: {
      type: "object",
      properties: {
        partsNeeded: {
          type: "string",
          description: "Parts the cited procedures call for, to list on the shopping copy.",
        },
      },
      additionalProperties: false,
    },
  },
];

/**
 * Builds the executors the agent loop calls.
 *
 * `trusted` is the server-owned planning context. Executors read every
 * readiness-relevant value from it and never from `args`, so a model that sends
 * `ackSafety: true` or a replacement task list changes nothing. Only genuinely
 * model-chosen values (a search query, parts copy) come from `args`.
 *
 * @param {{ retrieve?: typeof retrieveRelevantChunks, trusted?: any }} [deps]
 */
export function createToolRegistry({ retrieve = retrieveRelevantChunks, trusted = {} } = {}) {
  const tasks = Array.isArray(trusted.tasks) ? trusted.tasks : [];
  const validTaskIds = new Set(tasks.map((task) => task.id));

  return {
    extract_repair_tasks: () => ({ tasks }),
    search_repair_docs: (args) => {
      // `taskId` is required so PR 2 can tie each retrieved source to the task
      // it was fetched for. Rejecting an unknown id here keeps that association
      // trustworthy rather than letting the model invent one.
      const taskId = Number(args?.taskId);

      if (!validTaskIds.has(taskId)) {
        return Promise.resolve({
          error: `Unknown taskId ${args?.taskId}. Call extract_repair_tasks and use one of: ${
            [...validTaskIds].join(", ") || "(no tasks)"
          }.`,
        });
      }

      return searchRepairDocs({ query: args?.query, limit: args?.limit, taskId }, { retrieve });
    },
    check_repair_readiness: () =>
      checkRepairReadiness({
        tasks,
        availableTools: trusted.availableTools,
        availableParts: trusted.availableParts,
        skillLevel: trusted.skillLevel,
        ackSafety: trusted.safetyAcknowledged,
      }),
    build_owner_checklist: () =>
      buildOwnerChecklist({
        tasks,
        skillLevel: trusted.skillLevel,
        ackSafety: trusted.safetyAcknowledged,
      }),
    draft_handoff_notes: (args) =>
      draftHandoffNotes({
        tasks,
        vehicle: trusted.vehicle,
        partsNeeded: args?.partsNeeded,
      }),
  };
}
