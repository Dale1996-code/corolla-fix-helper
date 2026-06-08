import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-fix-helper-eval-"));

process.env.DATABASE_FILE = path.join(tempRoot, "eval.db");
process.env.UPLOADS_DIR = path.join(tempRoot, "uploads");
process.env.OPENAI_API_KEY = "test-key";

const { db } = await import("../src/database.js");
const { HYBRID_RETRIEVAL_EVAL_CASES, runHybridRetrievalEval } = await import(
  "../src/evals/hybridRetrievalEval.js"
);

after(() => {
  if (typeof db.close === "function") {
    db.close();
  }

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("hybrid retrieval eval proves wrong keyword pages are fixed at 2500-document scale", async () => {
  assert.ok(HYBRID_RETRIEVAL_EVAL_CASES.length >= 10);
  assert.ok(HYBRID_RETRIEVAL_EVAL_CASES.length <= 15);

  const report = await runHybridRetrievalEval({
    distractorDocumentCount: 2500,
  });

  assert.equal(report.summary.evalCaseCount, HYBRID_RETRIEVAL_EVAL_CASES.length);
  assert.equal(report.summary.distractorDocumentCount, 2500);
  assert.equal(report.summary.keywordWrongHybridRight, HYBRID_RETRIEVAL_EVAL_CASES.length);
  assert.equal(report.summary.hybridWrong, 0);

  for (const item of report.items) {
    assert.equal(item.keywordCorrect, false, item.id);
    assert.equal(item.hybridCorrect, true, item.id);
    assert.equal(item.fixedWrongPage, true, item.id);
    assert.equal(item.hybridTop.pageNumber, item.expectedPage, item.id);
    assert.match(item.hybridTop.chunkText, new RegExp(item.expectedSpecPattern, "i"));
  }
});
