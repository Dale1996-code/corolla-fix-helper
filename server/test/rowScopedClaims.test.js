import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ACCEPTED, judgeReply, parseCaptureText } from "../src/evals/answerCapture.js";
import { formatReplayReport, replayRecords } from "../src/evals/answerReplay.js";
import {
  buildEvidencePromptLines,
  checkClaimNumbers,
  checkClaimSubject,
  verifyEvidence,
} from "../src/services/askEvidenceContract.js";

// F1 (row-scoped claims). The verifier already accepts a claim that quotes ONE
// table row, names its part with that row's own words, and carries any condition
// printed elsewhere as a separate claim -- and rejects the same figures when a
// long quote spans several rows (S1, row_mismatch). F1 asks the MODEL for the
// accepted shape by adding rules to the evidence prompt. These tests pin the
// prompt text only; whether a model follows it is measured by a live capture,
// never by anything here.

/** The prompt rules as one line of text, so a re-wrapped line cannot break a test. */
function promptText(options = {}) {
  return buildEvidencePromptLines({
    question: "What is the gizmo reservoir capacity?",
    originalQuestion: "",
    hasImage: false,
    ...options,
  })
    .join("\n")
    .replace(/\s+/g, " ");
}

const ROW_SCOPE_RULES = [
  [
    "quote only the row or sentence that prints the figure",
    /quote ONLY the one table row or sentence that prints the figure you claim/i,
  ],
  [
    "not the surrounding table or neighbouring rows",
    /not the table around it, and not the rows before or after it/i,
  ],
  [
    "name the part with the same row's wording",
    /name the part in the claim with the words that SAME row or sentence uses/i,
  ],
  [
    "never use words from a heading or another row",
    /never with words taken from a heading or from another row/i,
  ],
  [
    "a condition printed elsewhere gets its own claim and quote",
    /give that condition its own claim with its own quote/i,
  ],
  [
    "a conditional figure is never stated as unconditional",
    /never state a figure as if it always held when the source prints it only under a condition/i,
  ],
  [
    "every claimed number is printed in the claim's own quote",
    /every number in a claim must be printed in that claim's own quote/i,
  ],
  ["a number the quote does not print is left out", /leave it out of the claim/i],
];

for (const [name, pattern] of ROW_SCOPE_RULES) {
  test(`F1 prompt: ${name}`, () => {
    assert.match(promptText(), pattern);
  });
}

test("F1 prompt: the row-scope rules belong to the documentSupported instructions", () => {
  const text = promptText();
  const claimsStart = text.indexOf("documentSupported:");
  const guidanceStart = text.indexOf("generalGuidance:");

  assert.ok(claimsStart >= 0 && guidanceStart > claimsStart, "channel instructions should be present");

  for (const [name, pattern] of ROW_SCOPE_RULES) {
    const at = text.search(pattern);

    assert.ok(at > claimsStart && at < guidanceStart, `"${name}" should sit between documentSupported and generalGuidance`);
  }
});

test("F1 prompt: the rules that were already there are still there", () => {
  const text = promptText();

  for (const kept of [
    "one entry per ATOMIC claim you take from the sources",
    "text copied EXACTLY, character for character, from that source",
    "It must contain the specific value or instruction the claim makes",
    "include the named part and its value in the quote",
    "a value by itself is not enough to prove which part it belongs to",
    "Never paraphrase a quote",
    "Never combine text from two sources into one quote",
    "Never put a torque figure, capacity, pressure, clearance, or other specification here",
    "Never invent a specification, step, tool, or warning",
  ]) {
    assert.ok(text.includes(kept), `lost an existing rule: ${kept}`);
  }
});

test("F1 prompt: the question lines still close the prompt, and the image note is unchanged", () => {
  const lines = buildEvidencePromptLines({
    question: "standalone question",
    originalQuestion: "original question",
    hasImage: false,
  });

  assert.deepEqual(lines.slice(-2), [
    "Original user question: original question",
    "Question: standalone question",
  ]);
  assert.ok(!promptText().includes("An image is attached"));

  const withImage = promptText({ hasImage: true });

  assert.match(withImage, /An image is attached/);
  assert.match(withImage, /NEVER a source for a specification/);
  // The F1 rules are not an image-only addition.
  assert.match(withImage, /quote ONLY the one table row or sentence/i);
});

// ---------------------------------------------------------------------------
// The shapes F1 asks for, replayed through the verifier.
//
// The fixture is INVENTED text (a "gizmo" with its own parts and figures): the
// repository is public and a real capture quotes the manuals. Its recorded
// verdicts were judged by the real verifier through buildCaptureRecord. F1
// changes no verifier code, so these pass with or without the prompt change:
// they pin what the verifier does with the replies F1 hopes to get, and with
// the reply it must keep refusing. They say nothing about what a model writes.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, "fixtures", "synthetic-row-scoped-capture.jsonl");
const fixtureText = fs.readFileSync(FIXTURE, "utf8");
const parsed = parseCaptureText(fixtureText);
const byCase = new Map(parsed.records.map((record) => [record.caseId, record]));

test("the row-scoped fixture is invented text, never a real capture", () => {
  assert.deepEqual(parsed.errors, []);

  // Records only: the header's format name is the app's own name.
  for (const record of parsed.records) {
    const marker = JSON.stringify(record).match(/ALLDATA|Toyota|Corolla|2ZR|2AZ/i);

    assert.equal(marker, null, `${record.caseId} carries a real-manual marker: ${marker?.[0]}`);

    for (const chunk of record.chunks) {
      assert.match(chunk.documentTitle, /^Synthetic /);
    }
  }
});

test("an unchanged verifier reports 0 changed verdicts over the row-scoped fixture", () => {
  const result = replayRecords(parsed.records);

  assert.equal(result.recordCount, 6);
  assert.equal(result.verdictTotal, 8);
  assert.deepEqual(result.verdictChanges, []);
  assert.deepEqual(result.statusChanges, []);
  assert.deepEqual(result.errors, []);
  assert.equal(formatReplayReport({ header: parsed.header, result }).split("\n").at(-1), "0 verdicts changed of 8");
});

// [case, status, verdict of each documentSupported claim, what the case stands for]
const EXPECTED = [
  [
    "synthetic-capacity-natural-row-only-quote",
    "not_found",
    ["subject_mismatch"],
    "natural wording over a row-only quote: the part's name is printed away from the row",
  ],
  [
    "synthetic-capacity-natural-long-quote",
    "not_found",
    ["row_mismatch"],
    "natural wording over a long quote naming the part: the quote spans both capacity rows",
  ],
  [
    "synthetic-capacity-row-scoped",
    "answered",
    [ACCEPTED],
    "R1: one row, named with that row's own words",
  ],
  [
    "synthetic-voltage-joined-condition",
    "not_found",
    ["row_mismatch"],
    "a condition and a figure printed in two sentences, joined in one claim",
  ],
  [
    "synthetic-voltage-two-claims",
    "partial",
    [ACCEPTED, ACCEPTED],
    "R2: the condition as its own claim, then the figure pointing at it",
  ],
  [
    "synthetic-capacity-cross-row-long-quote",
    "not_found",
    ["row_mismatch"],
    "adversarial: the part named in a long quote, the other row's figure",
  ],
];

for (const [caseId, status, claimVerdicts, meaning] of EXPECTED) {
  test(`row-scoped fixture: ${caseId} (${meaning})`, () => {
    const record = byCase.get(caseId);

    assert.ok(record, `the fixture should hold ${caseId}`);

    // Judged now, not read back: the recorded verdicts could be stale.
    const judged = judgeReply(record.reply, record.chunks);

    assert.equal(judged.status, status);
    assert.deepEqual(
      judged.verdicts.filter((entry) => entry.channel === "documentSupported").map((entry) => entry.verdict),
      claimVerdicts
    );
  });
}

test("a long quote naming the part and printing the figure is still refused when the rows differ", () => {
  const record = byCase.get("synthetic-capacity-cross-row-long-quote");
  const [claim] = record.reply.documentSupported;

  // The subject check and the numeric check each pass on their own: the part is
  // named in the quote and so is the figure. Only the row check (S1) separates
  // the "without strainer" row's figure from the "with strainer" claim.
  assert.equal(checkClaimSubject(claim.claim, claim.evidenceQuote).grounded, true);
  assert.equal(checkClaimNumbers(claim.claim, claim.evidenceQuote).grounded, true);

  const result = verifyEvidence(
    { documentSupported: [claim], generalGuidance: [], gaps: [] },
    record.chunks
  );

  assert.equal(result.documentSupported.length, 0);
  assert.equal(result.rejected[0].reason, "row_mismatch");
  assert.equal(result.rejected[0].detail, "condition_mismatch");
  // The rejected figure is not reprinted in the gap that replaces the claim.
  assert.doesNotMatch(result.gaps.join(" "), /2\.9/);
});

test("the row-scoped wording does not launder another row's figure", () => {
  const record = byCase.get("synthetic-capacity-row-scoped");
  const wrongFigure = "The replace and refill with strainer change capacity is 2.9 liters.";

  for (const [quote, reason] of [
    // A row-only quote does not print the claimed figure at all.
    ["Replace and refill with strainer change 3.2 liters (3.4 US qts, 2.8 lmp. qts)", "numeric_anomaly"],
    // A quote printing both rows is checked row by row.
    [
      "Replace and refill with strainer change 3.2 liters (3.4 US qts, 2.8 lmp. qts) " +
        "Replace and refill without strainer change 2.9 liters (3.1 US qts, 2.6 lmp. qts)",
      "row_mismatch",
    ],
  ]) {
    const result = verifyEvidence(
      {
        documentSupported: [{ claim: wrongFigure, sourceId: "S1", evidenceQuote: quote }],
        generalGuidance: [],
        gaps: [],
      },
      record.chunks
    );

    assert.equal(result.documentSupported.length, 0, quote);
    assert.equal(result.rejected[0].reason, reason, quote);
  }
});
