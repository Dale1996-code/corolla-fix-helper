import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-fix-helper-hybrid-eval-"));

process.env.DATABASE_FILE = path.join(tempRoot, "eval.db");
process.env.UPLOADS_DIR = path.join(tempRoot, "uploads");

const { db } = await import("../database.js");
const { runHybridRetrievalEval } = await import("../evals/hybridRetrievalEval.js");

function formatTopResult(result) {
  if (!result) {
    return "none";
  }

  return `${result.documentTitle} page ${result.pageNumber}`;
}

try {
  const report = await runHybridRetrievalEval({
    distractorDocumentCount: 2500,
  });

  console.log("Hybrid retrieval eval");
  console.log(`Eval cases: ${report.summary.evalCaseCount}`);
  console.log(`Distractor documents: ${report.summary.distractorDocumentCount}`);
  console.log(`Keyword wrong, hybrid right: ${report.summary.keywordWrongHybridRight}`);
  console.log(`Hybrid wrong: ${report.summary.hybridWrong}`);
  console.log("");
  console.log("id | expected | keyword top | hybrid top | fixed");
  console.log("--- | --- | --- | --- | ---");

  for (const item of report.items) {
    console.log(
      [
        item.id,
        `${item.expectedSpec}, page ${item.expectedPage}`,
        formatTopResult(item.keywordTop),
        formatTopResult(item.hybridTop),
        item.fixedWrongPage ? "yes" : "no",
      ].join(" | ")
    );
  }

  if (
    report.summary.keywordWrongHybridRight !== report.summary.evalCaseCount ||
    report.summary.hybridWrong !== 0
  ) {
    process.exitCode = 1;
  }
} finally {
  if (typeof db.close === "function") {
    db.close();
  }

  fs.rmSync(tempRoot, { recursive: true, force: true });
}
