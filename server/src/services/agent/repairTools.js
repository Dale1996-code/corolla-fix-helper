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

// --- Tool: extract_repair_tasks -------------------------------------------

/**
 * @param {{ brief?: string }} [args]
 */
export function extractRepairTasks({ brief } = {}) {
  const normalizedBrief = normalizeText(brief);

  if (!normalizedBrief) {
    return { tasks: [] };
  }

  const fragments = splitBriefIntoFragments(normalizedBrief);
  const source = fragments.length ? fragments : [normalizedBrief];

  const tasks = source.map((fragment, index) => {
    const classification = classifyTask(fragment);
    const { system } = classification;
    const difficulty = detectDifficulty(fragment);

    return {
      id: index + 1,
      title: fragment.length > 120 ? `${fragment.slice(0, 117)}...` : fragment,
      system,
      difficulty,
      safetyFlags: classification.flags,
      // Carried on the task so readiness and the checklist reuse THIS decision
      // instead of re-classifying the (possibly truncated) title and reaching a
      // different answer.
      safetyCritical: classification.safetyCritical,
      keywords: buildKeywords(fragment, system),
    };
  });

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
 * @param {{ query?: string, limit?: number }} [args]
 * @param {{ retrieve?: typeof retrieveRelevantChunks }} [deps]
 */
export async function searchRepairDocs({ query, limit = 4 } = {}, { retrieve = retrieveRelevantChunks } = {}) {
  const normalizedQuery = normalizeText(query);

  if (!normalizedQuery) {
    return { query: "", citations: [], context: "" };
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

  return { query: normalizedQuery, citations, context };
}

// --- Tool: check_repair_readiness -----------------------------------------

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
  const hasTools = normalizeText(availableTools).length > 0;
  const hasParts = normalizeText(availableParts).length > 0;

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

export const repairToolSchemas = [
  {
    type: "function",
    name: "extract_repair_tasks",
    description:
      "Split a free-text repair brief into discrete, system-tagged repair tasks with difficulty, safety flags, and document-search keywords.",
    parameters: {
      type: "object",
      properties: {
        brief: { type: "string", description: "The full repair brief from the owner." },
      },
      required: ["brief"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "search_repair_docs",
    description:
      "Retrieve the most relevant chunks from the owner's uploaded PDF manuals to ground repair steps and torque specs. Returns citations.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keywords describing what to look up." },
        limit: { type: "integer", description: "Maximum chunks to return (default 4)." },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "check_repair_readiness",
    description:
      "Score a set of tasks against a readiness rubric (tools, parts, skill match, safety) and report gaps and blockers.",
    parameters: {
      type: "object",
      properties: {
        tasks: { type: "array", items: { type: "object" }, description: "Tasks from extract_repair_tasks." },
        availableTools: { type: "string" },
        availableParts: { type: "string" },
        skillLevel: { type: "string", enum: ["beginner", "intermediate", "advanced"] },
        ackSafety: {
          type: "boolean",
          description:
            "Set true only when the owner has explicitly acknowledged the risk of safety-critical work (brakes, fuel, electrical, lifting, suspension). Required before such work can be marked Ready.",
        },
      },
      required: ["tasks"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "build_owner_checklist",
    description:
      "Turn tasks into a prioritized owner checklist with DIY vs professional-shop assignment and step placeholders. Safety-critical work is recommended to a shop unless ackSafety is true.",
    parameters: {
      type: "object",
      properties: {
        tasks: { type: "array", items: { type: "object" } },
        skillLevel: { type: "string", enum: ["beginner", "intermediate", "advanced"] },
        ackSafety: {
          type: "boolean",
          description:
            "Set true only when the owner has explicitly acknowledged the risk of safety-critical work. Otherwise safety-critical tasks are labeled Shop Recommended.",
        },
      },
      required: ["tasks"],
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
        tasks: { type: "array", items: { type: "object" } },
        vehicle: { type: "string" },
        partsNeeded: { type: "string" },
      },
      required: ["tasks"],
      additionalProperties: false,
    },
  },
];

export function createToolRegistry({ retrieve = retrieveRelevantChunks } = {}) {
  return {
    extract_repair_tasks: (args) => extractRepairTasks(args),
    search_repair_docs: (args) => searchRepairDocs(args, { retrieve }),
    check_repair_readiness: (args) => checkRepairReadiness(args),
    build_owner_checklist: (args) => buildOwnerChecklist(args),
    draft_handoff_notes: (args) => draftHandoffNotes(args),
  };
}
