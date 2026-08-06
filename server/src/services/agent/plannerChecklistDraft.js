import { TECHNICAL_CLAIM_KINDS } from "./repairPlanEvidenceContract.js";

// The checklist a completed Repair Planner run may be saved as.
//
// The draft is built HERE, on the server, from validated planner output only,
// and is then held in the plan run store under its own id. The browser never
// sends checklist content back: `POST /api/repair-checklists/from-planner`
// accepts a draft id and nothing else. That is the whole point of the split --
// a checklist saved from a plan is a durable SQLite record, and if its text
// arrived from the page then a tampered request (or a bug in the renderer)
// could write an invented torque figure into permanent storage wearing the
// planner's authority.
//
// What goes in:
//   - one normal checklist item per canonical, server-derived task,
//   - notes carrying the statements the evidence contract ACCEPTED, each with
//     its document and page, the verified tool/part requirements, and the
//     safety warnings the classifier raised for those tasks.
//
// What deliberately stays out:
//   - the model's own prose (the planner discards it before this point anyway),
//   - the run's gaps (they describe what could NOT be verified; a saved
//     checklist that lists them reads as a to-do list of unverified claims),
//   - the placeholder owner-checklist steps ("Placeholder: perform the
//     repair..."), which are labeled placeholders precisely because they are not
//     instructions,
//   - the handoff drafts (parts list / mechanic copy / log entry) -- separate
//     artifacts with their own purpose, not checklist content,
//   - the readiness score and level, which describe a moment in time and go
//     stale the instant the owner buys a tool,
//   - every rejected claim.

/** Notes never grow past this many verified statements. */
export const MAX_DRAFT_STATEMENTS = 60;

/** Checklist titles stay short enough to read in the list column. */
export const MAX_DRAFT_TITLE_LENGTH = 120;

// Requirement claims get their own section, so they are not also listed as
// free-text statements. Derived from the contract's own list so a newly added
// technical kind shows up here instead of being silently dropped.
const REQUIREMENT_CLAIM_KINDS = new Set(["required_tool", "required_part"]);
const STATEMENT_CLAIM_KINDS = TECHNICAL_CLAIM_KINDS.filter(
  (kind) => !REQUIREMENT_CLAIM_KINDS.has(kind)
);

const NOT_FOUND_NOTICE =
  "No statement in this plan could be verified against your uploaded documents. Only the repair tasks and the safety warnings below were saved -- no technical statement was verified, so nothing here is a specification you can work to.";

const PROVENANCE_NOTE =
  "Saved from a Repair Planner run. The statements below were matched word-for-word to a page of your uploaded documents at the time the plan was built. They are reference material, not step-by-step repair instructions: open each cited page and read the full procedure before working on the vehicle.";

function truncate(value, limit) {
  const text = String(value || "").replace(/\s+/g, " ").trim();

  if (text.length <= limit) {
    return text;
  }

  return `${text.slice(0, Math.max(0, limit - 3))}...`;
}

/**
 * The checklist's title.
 *
 * Built from the canonical task titles -- the same server-derived list the plan
 * itself is scored against -- so the saved record names the work, not the raw
 * brief the owner typed.
 */
export function buildDraftTitle(tasks) {
  const titles = tasks.map((task) => truncate(task?.title, MAX_DRAFT_TITLE_LENGTH)).filter(Boolean);

  if (!titles.length) {
    return "Repair plan";
  }

  const [first, ...rest] = titles;
  const suffix = rest.length ? ` (+${rest.length} more)` : "";

  return truncate(`${first}${suffix}`, MAX_DRAFT_TITLE_LENGTH);
}

/** Source label for a cited statement: the document and the page it came from. */
function describeSource(citation) {
  if (!citation) {
    return "";
  }

  const name = citation.documentTitle || citation.originalFilename || "Untitled document";

  return Number.isInteger(citation.pageNumber) && citation.pageNumber > 0
    ? `${name}, page ${citation.pageNumber}`
    : name;
}

function describeRequirementGroup(label, group) {
  if (!group || group.status === "unknown") {
    return `- ${label}: not established from your documents. Confirm before starting.`;
  }

  if (group.status === "none_required") {
    return `- ${label}: the cited procedures state none are required.`;
  }

  const required = Array.isArray(group.required) ? group.required.filter(Boolean) : [];

  if (!required.length) {
    return `- ${label}: not established from your documents. Confirm before starting.`;
  }

  return `- ${label}: ${required.join(", ")}.`;
}

/**
 * Builds the checklist draft for a completed run.
 *
 * Every completed evidence status produces a draft, including `not_found`: an
 * owner who read a plan that grounded nothing still has a real task list worth
 * keeping, and the notes say plainly that nothing was verified.
 *
 * @param {{
 *   tasks?: readonly any[],
 *   evidenceStatus?: string,
 *   verifiedClaims?: readonly any[],
 *   citations?: readonly any[],
 *   requirements?: { tools: any, parts: any } | null,
 * }} input
 */
export function buildPlannerChecklistDraft({
  tasks = [],
  evidenceStatus = "not_found",
  verifiedClaims = [],
  citations = [],
  requirements = null,
} = {}) {
  const citationsBySourceId = new Map(
    citations.map((citation) => [citation.sourceId, citation])
  );

  // Only ACCEPTED claims reach this function -- `verifiedClaims` is the evidence
  // contract's accepted list. Rejected ones were never in it.
  const statements = verifiedClaims.filter((claim) =>
    STATEMENT_CLAIM_KINDS.includes(claim.kind)
  );

  const notes = [PROVENANCE_NOTE, ""];

  if (evidenceStatus === "not_found" || !statements.length) {
    notes.push(NOT_FOUND_NOTICE, "");
  } else {
    notes.push("Verified statements from your documents");

    let written = 0;
    let omitted = 0;

    for (const task of tasks) {
      notes.push(`${task.id}. ${task.title}`);

      const forTask = statements.filter((claim) => claim.taskId === task.id);

      if (!forTask.length) {
        notes.push("   - No statement from your documents could be verified for this task.");
        continue;
      }

      for (const claim of forTask) {
        if (written >= MAX_DRAFT_STATEMENTS) {
          omitted += 1;
          continue;
        }

        const source = describeSource(citationsBySourceId.get(claim.sourceId));
        notes.push(`   - ${claim.claim}${source ? ` (${source})` : ""}`);
        written += 1;
      }
    }

    // Never truncate silently: a checklist that quietly drops half its evidence
    // reads exactly like one that had nothing more to say.
    if (omitted) {
      notes.push(
        `   (${omitted} further verified statement${
          omitted === 1 ? " was" : "s were"
        } not copied; this checklist keeps the first ${MAX_DRAFT_STATEMENTS}. Rebuild the plan to see them all.)`
      );
    }

    notes.push("");
  }

  notes.push("Verified requirements");
  notes.push(describeRequirementGroup("Tools", requirements?.tools));
  notes.push(describeRequirementGroup("Parts", requirements?.parts));

  // Warnings come from the task's own server-assigned flags, which the safety
  // classifier produced when the canonical tasks were derived. They are not
  // re-derived here and they are never taken from the model.
  const safetyFlags = [
    ...new Set(tasks.flatMap((task) => (Array.isArray(task.safetyFlags) ? task.safetyFlags : []))),
  ];

  if (safetyFlags.length) {
    notes.push("");
    notes.push("Safety warnings");
    for (const flag of safetyFlags) {
      notes.push(`- ${flag}`);
    }
  }

  return {
    title: buildDraftTitle(tasks),
    // A saved plan is always work not yet started. The owner can move it on from
    // the Checklists page like any other checklist.
    status: "planned",
    description: `Saved from a Repair Planner run (evidence: ${evidenceStatus}).`,
    notes: notes.join("\n").trim(),
    items: tasks.map((task) => ({ text: truncate(task.title, MAX_DRAFT_TITLE_LENGTH) })),
    evidenceStatus,
  };
}
