import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// N5 P1 CLASSIFIES and P2 PERSISTS; neither enforces. The applicability tagger
// may be used by its own read-only diagnostic scripts and by the code that
// WRITES each chunk's scope, and nothing else until P3/P4, when filtering and
// claim verification are switched on deliberately, with their own tests and an
// owner decision. This guard reads source text only (it never imports a
// module), and fails the moment any other server module -- retrieval, the Ask
// verifier, the planner, a route -- references the tagger, the persisted-scope
// module, or the scope columns themselves. When P3/P4 land, extend the allow
// lists in the same change that wires enforcement in.
//
// applicabilityScopeNotRead.test.js is the runtime half: it fills the columns
// with another engine's scope and proves Ask, the planner, and retrieval return
// exactly what they return with the columns empty.

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcRoot = path.join(serverRoot, "src");

// Who may reference the tagger: itself, its read-only scripts, and the module
// that turns its output into column values.
const TAGGER_ALLOWED = new Set([
  "services/applicabilityScope.js",
  "scripts/diagnoseApplicability.js",
  "scripts/checkApplicabilityLabels.js",
  "services/chunkScopePersistence.js",
]);

// Who may compute a scope to STORE: the chunk rebuild and the backfill.
const PERSISTENCE_ALLOWED = new Set([
  "services/chunkScopePersistence.js",
  "services/documentChunkService.js",
  "services/applicabilityBackfill.js",
]);

// Who may name the columns: the migration that adds them and the code that
// writes them. The backfill reads `scope_version` only to find chunks still
// to tag (that is what makes it resumable) and never acts on a scope's value.
const COLUMN_ALLOWED = new Set([
  "initDatabase.js",
  "services/chunkScopePersistence.js",
  "services/documentChunkService.js",
  "services/applicabilityBackfill.js",
  "scripts/backfillApplicability.js",
]);
const SCOPE_COLUMN = /\b(?:scope_at_start|scope_version)\b/;

function listSourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return listSourceFiles(full);
    }
    return entry.name.endsWith(".js") ? [full] : [];
  });
}

const sources = listSourceFiles(srcRoot).map((file) => ({
  file: path.relative(srcRoot, file).split(path.sep).join("/"),
  text: fs.readFileSync(file, "utf8"),
}));

function referencing(matches) {
  return sources.filter(({ text }) => matches(text)).map(({ file }) => file);
}

test("only the tagger, its read-only scripts, and the scope writer reference applicabilityScope", () => {
  const unexpected = referencing((text) => text.includes("applicabilityScope")).filter(
    (file) => !TAGGER_ALLOWED.has(file)
  );

  assert.deepEqual(
    unexpected,
    [],
    `applicability filtering is not enabled yet (N5 P1/P2 classify and store only), but these modules reference the tagger: ${unexpected.join(", ")}`
  );
});

test("only the chunk rebuild and the backfill use the persisted-scope module", () => {
  const unexpected = referencing((text) => text.includes("chunkScopePersistence")).filter(
    (file) => !PERSISTENCE_ALLOWED.has(file)
  );

  assert.deepEqual(
    unexpected,
    [],
    `only the chunk rebuild and the backfill may compute a stored scope, but these modules use it: ${unexpected.join(", ")}`
  );
});

test("nothing outside the migration and the writers names the scope columns", () => {
  const unexpected = referencing((text) => SCOPE_COLUMN.test(text)).filter((file) => !COLUMN_ALLOWED.has(file));

  assert.deepEqual(
    unexpected,
    [],
    `scope_at_start / scope_version must not be read until enforcement lands (N5 P3/P4), but these modules name them: ${unexpected.join(", ")}`
  );
});

// `SELECT *` or `alias.*` would read the new columns without naming them. No
// module does it today; this keeps the column-name check above from being
// sidestepped.
test("no module selects every column of document_chunks", () => {
  const offenders = sources
    .filter(({ text }) => text.includes("document_chunks"))
    .filter(({ text }) => {
      if (/\bSELECT\s+(?:DISTINCT\s+)?\*/i.test(text)) {
        return true;
      }
      const aliases = new Set(["document_chunks"]);
      for (const match of text.matchAll(/\bdocument_chunks\s+(?:AS\s+)?([A-Za-z_]\w*)/gi)) {
        aliases.add(match[1]);
      }
      return [...aliases].some((alias) => new RegExp(`(?<![\\w.])${alias}\\.\\*`).test(text));
    })
    .map(({ file }) => file);

  assert.deepEqual(
    offenders,
    [],
    `select the document_chunks columns you need by name; these modules select all of them: ${offenders.join(", ")}`
  );
});

test("the guard watches the modules that would enforce", () => {
  // If a rename moved one of these, the guard above would silently stop
  // covering it; pin that the enforcement points still exist where it looks.
  for (const file of [
    "services/chunkRetrievalService.js",
    "services/chunkEmbeddingService.js",
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
