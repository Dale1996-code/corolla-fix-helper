import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

// Cost bounds on the Repair Planner's tool loop (audit Stage 5-E1). The model
// chooses how many chunks a search returns and how many tools it calls at
// once; each of those is a retrieval, an embedding request, and tool output
// that rides back into the next turn's input. These tests pin the ceilings.
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-fix-helper-planner-bounds-"));

process.env.DATABASE_FILE = path.join(tempRoot, "planner-bounds.db");
process.env.UPLOADS_DIR = path.join(tempRoot, "uploads");
process.env.OPENAI_API_KEY = "";
process.env.NETWORK_MODE = "0";

fs.mkdirSync(process.env.UPLOADS_DIR, { recursive: true });

const { db } = await import("../src/database.js");
const { DEFAULT_SEARCH_RESULTS, MAX_SEARCH_RESULTS, repairToolSchemas } = await import(
  "../src/services/agent/repairTools.js"
);

after(() => {
  if (typeof db.close === "function") {
    db.close();
  }

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("the search schema tells the model the result bound (1A-20)", () => {
  const search = repairToolSchemas.find((schema) => schema.name === "search_repair_docs");
  const { limit } = search.parameters.properties;

  assert.equal(MAX_SEARCH_RESULTS, 8);
  assert.equal(limit.type, "integer");
  assert.equal(limit.minimum, 1);
  assert.equal(limit.maximum, MAX_SEARCH_RESULTS);
  assert.match(limit.description, new RegExp(`default ${DEFAULT_SEARCH_RESULTS}, at most ${MAX_SEARCH_RESULTS}`));
});
