import assert from "node:assert/strict";
import test from "node:test";

// Pure contract logic: no database, no network. Safe to import directly.
import { deriveEvidenceStatus, verifyEvidence } from "../src/services/askEvidenceContract.js";
import { verifyClaims } from "../src/services/agent/repairPlanEvidenceContract.js";
import { ASK_ORACLE, EVIDENCE_ORACLE, PLANNER_ORACLE } from "./fixtures/evidenceOracle.js";

// Drives every row of the evidence oracle through the real verifiers. A row the
// verifier gets wrong today is reported as todo under its audit finding, which
// node:test counts without failing the run. The last test below turns red the
// moment a todo row starts passing, so a fix must also remove its `todo`.

function askOutcome(row) {
  if (row.channel === "generalGuidance") {
    const result = verifyEvidence(
      { documentSupported: [], generalGuidance: [row.claim], gaps: [] },
      []
    );
    const kept = result.generalGuidance.includes(row.claim);
    return {
      verdict: kept ? "accept" : "reject",
      detail: kept ? "kept in generalGuidance" : `removed: ${result.rejected[0]?.reason}`,
    };
  }

  const result = verifyEvidence(
    {
      documentSupported: [{ claim: row.claim, sourceId: "S1", evidenceQuote: row.quote }],
      generalGuidance: [],
      gaps: [],
    },
    [
      {
        documentId: 1,
        documentTitle: "Oracle Manual",
        originalFilename: "oracle.pdf",
        pageNumber: 1,
        chunkIndex: 0,
        chunkText: row.chunkText,
      },
    ]
  );
  const status = deriveEvidenceStatus(result);
  const supported = result.documentSupported.length === 1;
  // An accepted claim must also leave the answer `answered`, and a rejected one
  // must never: a status that disagrees with the claim is its own defect.
  const verdict =
    supported && status === "answered"
      ? "accept"
      : !supported && status !== "answered"
        ? "reject"
        : "inconsistent";

  return {
    verdict,
    detail: supported ? `supported, status=${status}` : `${result.rejected[0]?.reason}, status=${status}`,
  };
}

function plannerOutcome(row) {
  const source = {
    id: "S1",
    documentId: 1,
    documentTitle: "Oracle Manual",
    originalFilename: "oracle.pdf",
    pageNumber: 4,
    chunkIndex: 0,
    chunkText: row.chunkText,
    evidenceText: row.chunkText,
    snippet: row.chunkText.slice(0, 220),
  };
  /** @type {Record<string, any>} */
  const claim = {
    taskId: 1,
    kind: row.channel,
    claim: row.claim,
    sourceId: "S1",
    evidenceQuote: row.quote,
  };
  if (row.itemName !== undefined) claim.itemName = row.itemName;

  // verifyClaims takes no task today -- that is finding 1A-06. The task is
  // passed in the shape buildRepairPlanEvidence uses, so the fix can read it
  // from here instead of the table changing.
  const context = {
    sourcesById: new Map([["S1", source]]),
    tasks: [{ id: 1, title: row.task, compound: false, clauses: [], safetyCritical: false }],
  };
  const { accepted, rejected } = verifyClaims([claim], context);

  return {
    verdict: accepted.length === 1 ? "accept" : "reject",
    detail: accepted.length === 1 ? "accepted" : `rejected: ${rejected[0]?.reason}`,
  };
}

const outcomeOf = (row) => (row.verifier === "ask" ? askOutcome(row) : plannerOutcome(row));

function describeRow(row, outcome) {
  return [
    `${row.id} [${row.finding}] expected ${row.expect}, got ${outcome.verdict} (${outcome.detail})`,
    `  claim: ${JSON.stringify(row.claim)}`,
    `  quote: ${JSON.stringify(row.quote)}`,
    `  note:  ${row.note}`,
  ].join("\n");
}

// ---- The table itself ----

test("every oracle row is well formed", () => {
  const ids = new Set();

  for (const row of EVIDENCE_ORACLE) {
    assert.ok(!ids.has(row.id), `duplicate oracle id ${row.id}`);
    ids.add(row.id);
    assert.ok(["accept", "reject"].includes(row.expect), `${row.id}: expect`);
    assert.ok(row.claim && row.note && row.finding, `${row.id}: claim, note, finding`);

    if (row.verifier === "ask" && row.channel === "generalGuidance") {
      assert.equal(row.quote, null, `${row.id}: guidance cites nothing`);
    } else {
      assert.ok(row.chunkText && row.quote, `${row.id}: chunkText and quote`);
    }

    if (row.verifier === "planner") {
      assert.ok(row.task, `${row.id}: a planner claim is filed under a task`);
    }

    // A control guards against over-correction, so it can never be a known
    // failure; and a known failure is filed under the finding it reproduces.
    if (row.finding === "control") {
      assert.equal(row.todo, undefined, `${row.id}: a control row never carries todo`);
    }
    if (row.todo !== undefined) {
      assert.equal(row.todo, row.finding, `${row.id}: todo names its own finding`);
    }
  }

  assert.ok(ASK_ORACLE.some((row) => row.finding === "control" && row.expect === "accept"));
  assert.ok(PLANNER_ORACLE.some((row) => row.finding === "control" && row.expect === "accept"));
});

// ---- One test per row ----

for (const row of EVIDENCE_ORACLE) {
  test(
    `${row.verifier} oracle ${row.id} [${row.finding}] must ${row.expect}`,
    { todo: row.todo },
    () => {
      const outcome = outcomeOf(row);
      assert.equal(outcome.verdict, row.expect, describeRow(row, outcome));
    }
  );
}

// ---- Stale-todo guard ----

test("every todo row still reproduces its finding (remove todo when a fix lands)", () => {
  const nowPassing = EVIDENCE_ORACLE.filter((row) => row.todo !== undefined)
    .map((row) => ({ row, outcome: outcomeOf(row) }))
    .filter(({ row, outcome }) => outcome.verdict === row.expect)
    .map(({ row }) => `${row.id} [${row.todo}]`);

  assert.deepEqual(
    nowPassing,
    [],
    "These rows now get the right verdict. Remove their `todo` so they gate from here on."
  );
});
