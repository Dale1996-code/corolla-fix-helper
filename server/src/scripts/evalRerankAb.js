import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Reranker A/B eval. Compares fusion-only retrieval against reranked retrieval
// on the same deterministic corpus and prints which cases each one gets right.
//
//   npm run eval:rerank
//
// It runs on its own temporary data. Without OPENAI_API_KEY the real reranker is
// a no-op (it returns the fusion order unchanged), so every case stays
// "both_right" -- which is itself the honest result: reranking does nothing
// without a key. Set OPENAI_API_KEY (and RERANK is exercised regardless of the
// RERANK_ENABLED flag, since this eval enables it per call) to see real
// reordering locally.

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-fix-helper-rerank-ab-"));

process.env.DATABASE_FILE = path.join(tempRoot, "eval.db");
process.env.UPLOADS_DIR = path.join(tempRoot, "uploads");

const { config } = await import("../config.js");
const { db } = await import("../database.js");
const { runRerankAbEval } = await import("../evals/hybridRetrievalEval.js");

function formatTopResult(result) {
  if (!result) {
    return "none";
  }

  return `${result.documentTitle} page ${result.pageNumber}`;
}

try {
  const report = await runRerankAbEval({ distractorDocumentCount: 50 });

  console.log("Reranker A/B eval");
  console.log(`OpenAI key present: ${config.openAiApiKey ? "yes" : "no (reranker is a no-op)"}`);
  console.log(`Eval cases: ${report.summary.evalCaseCount}`);
  console.log(`Distractor documents: ${report.summary.distractorDocumentCount}`);
  console.log(`Both right: ${report.summary.bothRight}`);
  console.log(`Rerank fixed (fusion wrong, rerank right): ${report.summary.rerankFixed}`);
  console.log(`Rerank broke (fusion right, rerank wrong): ${report.summary.rerankBroke}`);
  console.log(`Both wrong: ${report.summary.bothWrong}`);
  console.log("");
  console.log("id | expected | fusion top | rerank top | label");
  console.log("--- | --- | --- | --- | ---");

  for (const item of report.items) {
    console.log(
      [
        item.id,
        `${item.expectedSpec}, page ${item.expectedPage}`,
        formatTopResult(item.fusionTop),
        formatTopResult(item.rerankTop),
        item.label,
      ].join(" | ")
    );
  }

  // The reranker should never make retrieval worse on this corpus.
  if (report.summary.rerankBroke !== 0) {
    process.exitCode = 1;
  }
} finally {
  if (typeof db.close === "function") {
    db.close();
  }

  fs.rmSync(tempRoot, { recursive: true, force: true });
}
