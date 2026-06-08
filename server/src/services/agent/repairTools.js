import { retrieveRelevantChunks } from "../chunkRetrievalService.js";

// Deterministic tools the repair-planning agent can call.
//
// Each tool has a JSON schema (so the model knows how to call it) and a plain
// `execute` function that does real, testable work. Keeping the executors
// deterministic means the structured artifacts the UI renders do not depend on
// model randomness, and the whole pipeline can be tested without a live model.

const SYSTEM_KEYWORDS = [
  { system: "Engine", terms: ["engine", "idle", "misfire", "spark", "coil", "timing", "oil", "valve", "intake", "throttle"] },
  { system: "Cooling", terms: ["coolant", "radiator", "thermostat", "overheat", "water pump", "temperature"] },
  { system: "Brakes", terms: ["brake", "rotor", "caliper", "pad", "abs", "master cylinder"] },
  { system: "Electrical", terms: ["battery", "alternator", "fuse", "wiring", "starter", "sensor", "light", "charging"] },
  { system: "Suspension", terms: ["strut", "shock", "control arm", "bushing", "ball joint", "alignment", "steering"] },
  { system: "Transmission", terms: ["transmission", "clutch", "gear", "shift", "solenoid", "atf"] },
  { system: "HVAC", terms: ["heater", "ac", "air conditioning", "blower", "cabin filter", "vent"] },
  { system: "Fuel", terms: ["fuel", "injector", "pump", "filter", "tank"] },
];

const ADVANCED_TERMS = ["timing", "transmission", "clutch", "head gasket", "valve", "rebuild", "camshaft"];
const INTERMEDIATE_TERMS = ["alternator", "starter", "strut", "radiator", "water pump", "caliper", "injector"];

const SKILL_RANK = { beginner: 1, intermediate: 2, advanced: 3 };
const DIFFICULTY_RANK = { beginner: 1, intermediate: 2, advanced: 3 };

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function detectSystem(text) {
  const lowered = text.toLowerCase();

  for (const entry of SYSTEM_KEYWORDS) {
    if (entry.terms.some((term) => lowered.includes(term))) {
      return entry.system;
    }
  }

  return "General";
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

function detectSafetyFlags(text) {
  const lowered = text.toLowerCase();
  const flags = [];

  if (/(brake|abs|caliper|rotor|master cylinder)/.test(lowered)) {
    flags.push("Brake work affects stopping safety. Bleed and test before driving.");
  }
  if (/(fuel|injector|gas tank)/.test(lowered)) {
    flags.push("Fuel system work is a fire hazard. Relieve pressure and avoid sparks.");
  }
  if (/(battery|alternator|wiring|electrical|starter)/.test(lowered)) {
    flags.push("Disconnect the battery before electrical work.");
  }
  if (/(jack|lift|wheel|suspension|strut|control arm)/.test(lowered)) {
    flags.push("Use jack stands. Never work under a vehicle held only by a jack.");
  }
  if (/(coolant|radiator|thermostat|overheat)/.test(lowered)) {
    flags.push("Never open a hot cooling system. Let it cool to avoid burns.");
  }

  return flags;
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

export function extractRepairTasks({ brief } = {}) {
  const normalizedBrief = normalizeText(brief);

  if (!normalizedBrief) {
    return { tasks: [] };
  }

  const fragments = splitBriefIntoFragments(normalizedBrief);
  const source = fragments.length ? fragments : [normalizedBrief];

  const tasks = source.map((fragment, index) => {
    const system = detectSystem(fragment);
    const difficulty = detectDifficulty(fragment);

    return {
      id: index + 1,
      title: fragment.length > 120 ? `${fragment.slice(0, 117)}...` : fragment,
      system,
      difficulty,
      safetyFlags: detectSafetyFlags(fragment),
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

export function searchRepairDocs({ query, limit = 4 } = {}, { retrieve = retrieveRelevantChunks } = {}) {
  const normalizedQuery = normalizeText(query);

  if (!normalizedQuery) {
    return { query: "", citations: [], context: "" };
  }

  const chunks = retrieve(normalizedQuery, { limit });

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

export function checkRepairReadiness({
  tasks = [],
  availableTools = "",
  availableParts = "",
  skillLevel = "beginner",
} = {}) {
  const normalizedSkill = SKILL_RANK[skillLevel] ? skillLevel : "beginner";
  const skillRank = SKILL_RANK[normalizedSkill];
  const hasTools = normalizeText(availableTools).length > 0;
  const hasParts = normalizeText(availableParts).length > 0;

  const safetyFlaggedTasks = tasks.filter(
    (task) => Array.isArray(task.safetyFlags) && task.safetyFlags.length > 0
  );
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
      label: "Safety-critical steps identified",
      points: 20,
      met: safetyFlaggedTasks.length === 0 || tasks.length > 0,
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

  let level = "not_ready";
  if (score >= 80) {
    level = "ready";
  } else if (score >= 50) {
    level = "almost_ready";
  }

  return {
    score,
    level,
    skillLevel: normalizedSkill,
    rubric,
    gaps,
    safetyFlags: [...new Set(safetyFlaggedTasks.flatMap((task) => task.safetyFlags))],
  };
}

// --- Tool: build_owner_checklist ------------------------------------------

export function buildOwnerChecklist({ tasks = [], skillLevel = "beginner" } = {}) {
  const skillRank = SKILL_RANK[skillLevel] || 1;

  const checklist = tasks.map((task) => {
    const difficultyRank = DIFFICULTY_RANK[task.difficulty] || 1;
    const owner = difficultyRank > skillRank ? "Professional shop" : "DIY";

    return {
      taskId: task.id,
      task: task.title,
      system: task.system,
      owner,
      priority: difficultyRank,
      steps: [
        "Review source procedure and torque specs from cited documents",
        "Gather required parts and tools",
        owner === "DIY" ? "Perform the repair following safety notes" : "Schedule and hand off to the shop",
        "Verify the fix and log the result",
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
      },
      required: ["tasks"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "build_owner_checklist",
    description:
      "Turn tasks into a prioritized owner checklist with DIY vs professional-shop assignment and step placeholders.",
    parameters: {
      type: "object",
      properties: {
        tasks: { type: "array", items: { type: "object" } },
        skillLevel: { type: "string", enum: ["beginner", "intermediate", "advanced"] },
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
