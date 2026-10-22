import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// N5 P1 CLASSIFIES; it does not enforce. The applicability tagger may be used
// by its own read-only diagnostic scripts and nothing else until P3/P4, when
// filtering and claim verification are switched on deliberately, with their
// own tests and an owner decision. This guard reads source text only (it never
// imports a module), and fails the moment any other server module -- retrieval,
// the Ask verifier, the planner, a route -- references the tagger. When P3/P4
// land, extend ALLOWED in the same change that wires enforcement in.

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcRoot = path.join(serverRoot, "src");

const ALLOWED = new Set([
  "services/applicabilityScope.js",
  "scripts/diagnoseApplicability.js",
  "scripts/checkApplicabilityLabels.js",
]);

function listSourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return listSourceFiles(full);
    }
    return entry.name.endsWith(".js") ? [full] : [];
  });
}

test("only the tagger and its read-only scripts reference applicabilityScope", () => {
  const referencing = listSourceFiles(srcRoot)
    .filter((file) => fs.readFileSync(file, "utf8").includes("applicabilityScope"))
    .map((file) => path.relative(srcRoot, file).split(path.sep).join("/"));

  const unexpected = referencing.filter((file) => !ALLOWED.has(file));

  assert.deepEqual(
    unexpected,
    [],
    `applicability filtering is not enabled yet (N5 P1 is classification only), but these modules reference the tagger: ${unexpected.join(", ")}`
  );
});

test("the guard watches the modules that would enforce", () => {
  // If a rename moved one of these, the guard above would silently stop
  // covering it; pin that the enforcement points still exist where it looks.
  for (const file of [
    "services/chunkRetrievalService.js",
    "services/askEvidenceContract.js",
    "services/aiAnswerService.js",
    "services/agent/repairTools.js",
    "services/agent/repairPlanEvidenceContract.js",
    "routes/ask.js",
    "routes/repairPlan.js",
  ]) {
    assert.ok(fs.existsSync(path.join(srcRoot, file)), `${file} moved; re-point this guard`);
  }
});
