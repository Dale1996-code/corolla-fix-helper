// Ask-LEVEL relevance-floor calibration.
//
// This exists because `npm run eval:retrieval` structurally cannot observe the
// floor: it imports only the retrieval layer, while the floor sits above it in
// askQuestionUsingDocuments. Any threshold chosen without this harness is a
// guess.
//
//   npm run eval:relevance-floor
//
// It runs the REAL Ask pipeline against the REAL corpus but injects a stub
// answer generator, so no answer-model tokens are spent. Query embedding still
// needs OPENAI_API_KEY (that is what produces the semantic scores being
// calibrated). Nothing is written; the corpus is only read.

import { config } from "../config.js";

if (!config.openAiApiKey) {
  console.log("Relevance-floor calibration skipped: OPENAI_API_KEY is not set.");
  console.log("Semantic scores come from the query embedding, so a key is required.");
  process.exit(0);
}

// Importing database.js initializes the (real) database from config.
await import("../database.js");
const { askQuestionUsingDocuments } = await import("../services/aiAnswerService.js");
const { answerQualityCases } = await import("../evals/answerQualityCases.js");
const { sweepThresholds } = await import("../services/relevanceFloor.js");

const THRESHOLDS = [0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.5];

// Text cases only: a vision case would need an image and adds nothing here.
const cases = answerQualityCases.filter((testCase) => !testCase.image);

/**
 * A retrieved chunk counts as POSITIVE when the case tells us what a good
 * source looks like:
 *   - citationDocLike matches its document, or
 *   - one of the expected values appears in its text.
 * Refusal cases have no positives by construction -- every chunk they retrieve
 * is noise, which is exactly the signal a floor should be able to remove.
 */
function buildPositiveTest(testCase) {
  const valuePatterns = [
    ...(Array.isArray(testCase.mustIncludeAny) ? testCase.mustIncludeAny : []),
    ...(Array.isArray(testCase.citationSupportsAny) ? testCase.citationSupportsAny : []),
  ].filter((pattern) => pattern instanceof RegExp);

  return (chunk) => {
    const text = String(chunk?.chunkText || "");

    if (valuePatterns.some((pattern) => pattern.test(text))) {
      return true;
    }

    if (testCase.citationDocLike instanceof RegExp) {
      return (
        testCase.citationDocLike.test(String(chunk?.documentTitle || "")) ||
        testCase.citationDocLike.test(String(chunk?.originalFilename || ""))
      );
    }

    return false;
  };
}

const samples = [];
let failures = 0;

for (const testCase of cases) {
  try {
    const captured = [];

    await askQuestionUsingDocuments(testCase.question, {
      isAiConfigured: true,
      // Never enforce during calibration: we need to see everything retrieval
      // produced, including what the floor would have removed.
      relevanceFloor: false,
      // Stub the answer model. Retrieval and scoring are real; no answer tokens
      // are spent, so this whole sweep costs only the query embeddings.
      generateAnswerText: async ({ chunks }) => {
        captured.push(...chunks);
        return "not in documents";
      },
      generateEvidenceAnswer: async ({ chunks }) => {
        captured.push(...chunks);
        return { documentSupported: [], generalGuidance: [], gaps: [] };
      },
    });

    samples.push({
      id: testCase.id,
      expect: testCase.expect,
      chunks: captured,
      isPositive: buildPositiveTest(testCase),
    });

    const positives = captured.filter(samples[samples.length - 1].isPositive).length;
    console.log(
      `${testCase.id.padEnd(42)} chunks=${String(captured.length).padStart(2)} positives=${positives}`
    );
  } catch (error) {
    failures += 1;
    console.log(`${testCase.id.padEnd(42)} ERROR: ${error.message}`);
  }
}

// Composition of what actually reaches the answer stage. Without this, a sweep
// full of zeros is ambiguous: it could mean "the threshold is well chosen" or
// "the filter has nothing to act on". These counts say which.
const allChunks = samples.flatMap((sample) => sample.chunks);
const withBodyMatch = allChunks.filter((c) => Number(c?.chunkMatchedTerms) > 0).length;
const semanticOnly = allChunks.filter(
  (c) => !(Number(c?.chunkMatchedTerms) > 0) && Number(c?.semanticScore) > 0
).length;
const noSemantic = allChunks.filter((c) => !(Number(c?.semanticScore) > 0)).length;
const scores = allChunks
  .map((c) => Number(c?.semanticScore))
  .filter((value) => Number.isFinite(value) && value > 0)
  .sort((a, b) => a - b);

console.log("\n--- What reaches the answer stage ---");
console.log(`total chunks:               ${allChunks.length}`);
console.log(`with body-text keyword hit: ${withBodyMatch}  (exempt from the floor)`);
console.log(`semantic-only (floor can act on these): ${semanticOnly}`);
console.log(`no semantic score:          ${noSemantic}`);

if (scores.length) {
  const at = (fraction) => scores[Math.min(scores.length - 1, Math.floor(scores.length * fraction))];
  console.log(
    `semantic score min/p25/median/p75/max: ${scores[0].toFixed(3)} / ${at(0.25).toFixed(
      3
    )} / ${at(0.5).toFixed(3)} / ${at(0.75).toFixed(3)} / ${scores[scores.length - 1].toFixed(3)}`
  );
}

console.log("\n--- Threshold sweep (Ask-level) ---");
console.log(
  "threshold | kept+ | DROPPED+ | kept- | dropped- | noise removed | safe"
);

const sweep = sweepThresholds(samples, THRESHOLDS);

for (const row of sweep) {
  console.log(
    `${String(row.threshold).padEnd(9)} | ${String(row.keptPositive).padStart(5)} | ${String(
      row.droppedPositive
    ).padStart(8)} | ${String(row.keptNegative).padStart(5)} | ${String(
      row.droppedNegative
    ).padStart(8)} | ${(row.noiseReduction * 100).toFixed(1).padStart(12)}% | ${
      row.safe ? "yes" : "NO"
    }`
  );
}

const safeRows = sweep.filter((row) => row.safe && row.threshold > 0);
const recommended = safeRows.length ? safeRows[safeRows.length - 1] : null;

console.log("");

if (recommended && recommended.droppedNegative > 0) {
  console.log(
    `Recommended threshold: ${recommended.threshold} — removes ${recommended.droppedNegative} noise chunks and 0 positives.`
  );
  console.log("Set ASK_RELEVANCE_FLOOR=true only after reviewing this table.");
} else {
  console.log(
    "No threshold above 0 both removes noise and preserves every positive chunk."
  );
  console.log(
    "Keep ASK_RELEVANCE_FLOOR off: on this corpus the floor has nothing safe to remove."
  );
}

if (failures) {
  console.log(`\n${failures} case(s) errored; the sweep above excludes them.`);
  process.exitCode = 1;
}
