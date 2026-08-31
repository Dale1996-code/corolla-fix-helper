import { STATEMENT_CLAIM_KINDS } from "./repairPlanEvidenceContract.js";

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
//     safety warnings the classifier raised for those tasks,
//   - `sources`: the same citations again, but STRUCTURED -- `documentId` +
//     `pageNumber` + a title snapshot (roadmap N3.2). The prose above is for a
//     human to read; these rows are what survives a rename, a deletion, and the
//     walk into a repair-history record. See `buildDraftSources`.
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

/**
 * Cap on the structured citations one draft carries into SQLite. Mirrors
 * `MAX_SOURCES_PER_RECORD` in repairHistoryService so a checklist cannot carry
 * provenance that its own repair-history record could not later accept.
 */
export const MAX_DRAFT_SOURCES = 100;

/** Checklist titles stay short enough to read in the list column. */
export const MAX_DRAFT_TITLE_LENGTH = 120;

// Requirement claims get their own section, so they are not also listed as
// free-text statements. The partition comes from the evidence contract rather
// than a local copy: this module and the contract disagreeing about what counts
// as "a verified statement" is precisely the bug fixed below.

const NOT_FOUND_NOTICE =
  "No statement in this plan could be verified against your uploaded documents. Only the repair tasks and the safety warnings below were saved -- no technical statement was verified, so nothing here is a specification you can work to.";

// A plan CAN verify tool and part requirements while verifying nothing about the
// repair itself: the evidence contract counts required_tool / required_part as
// technical claims, so such a run is `partial` or even `verified`, not
// `not_found`.
//
// The notice above must not fire for it. Doing so wrote two contradictory
// sentences into a permanent record -- "nothing could be verified" sitting
// directly above "Verified requirements: Tools: torque wrench" -- which is worse
// than either statement alone, because the owner cannot tell which to believe.
const REQUIREMENTS_ONLY_NOTICE =
  "The only statements verified for this plan were the tool and part requirements listed below. No procedure, specification, or safety instruction could be verified for the tasks themselves, so read the cited documents in full before starting.";

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

/**
 * The draft's STRUCTURED provenance: the durable half of a citation.
 *
 * `describeSource` above renders a citation into a sentence a human reads
 * ("Brake Service Guide, page 4"). That sentence is not queryable, does not
 * survive a rename, and cannot be copied into a repair-history record. Before
 * N3.2 it was the only thing a saved checklist kept, so the `documentId` and
 * `pageNumber` the evidence contract had already resolved were discarded at
 * exactly the moment the plan became durable. This function keeps them.
 *
 * The prose is deliberately NOT replaced -- both are emitted. They answer
 * different questions ("what should I read?" versus "which row is this?"), and
 * dropping the sentence would make a saved checklist less readable to buy
 * nothing.
 *
 * The input is `citations`, which the evidence contract has already filtered to
 * the sources that actually backed an ACCEPTED claim. A chunk that was retrieved
 * and never cited is not evidence and does not appear here.
 *
 * `documentTitle` is carried alongside the id as a fallback snapshot, for the
 * narrow case where the document is deleted between building the plan and saving
 * the checklist. The save path prefers the live title when the document still
 * exists; see repairChecklistProvenanceService.
 *
 * Deduplication is first-seen order on `documentId:pageNumber`, matching
 * `normalizeSourceInputs` in repairHistoryService. Two accepted claims citing the
 * same page is the normal case, not an error, and it must produce one row.
 */
export function buildDraftSources(citations) {
  const seen = new Set();
  const sources = [];

  for (const citation of Array.isArray(citations) ? citations : []) {
    if (sources.length >= MAX_DRAFT_SOURCES) {
      break;
    }

    const documentId = Number(citation?.documentId);

    // A citation with no resolvable document id has no durable identity at all,
    // so there is nothing to store. It keeps its prose in the notes above.
    if (!Number.isInteger(documentId) || documentId <= 0) {
      continue;
    }

    const rawPage = Number(citation?.pageNumber);
    const pageNumber = Number.isInteger(rawPage) && rawPage > 0 ? rawPage : null;
    const key = `${documentId}:${pageNumber === null ? "" : pageNumber}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    sources.push({
      documentId,
      documentTitle: String(citation?.documentTitle || citation?.originalFilename || "").trim(),
      pageNumber,
    });
  }

  return sources;
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

  // Gated on the STATUS, never on "are there statements to print". Those are
  // different questions, and conflating them is what let a requirement-only plan
  // claim nothing was verified.
  if (evidenceStatus === "not_found") {
    notes.push(NOT_FOUND_NOTICE, "");
  } else if (!statements.length) {
    notes.push(REQUIREMENTS_ONLY_NOTICE, "");
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
    // The structured twin of the citations rendered into `notes` above. Saved as
    // its own rows so the evidence outlives the prose, the plan run, and the
    // document itself.
    sources: buildDraftSources(citations),
    evidenceStatus,
  };
}
