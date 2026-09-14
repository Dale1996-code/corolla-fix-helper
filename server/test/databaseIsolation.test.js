import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(testDir, "..");

// STUB: detects nothing yet.
function findDatabaseImports(_suiteFile, _options) {
  return [];
}

function describeViolation({ specifier, dynamic, chain }) {
  const importText = dynamic
    ? `import(${specifier === null ? "<non-literal>" : `"${specifier}"`}) runs before DATABASE_FILE and UPLOADS_DIR are both set`
    : `static import "${specifier}" is evaluated before any statement in the file`;

  return `${chain[0]}: ${importText}: ${chain.join(" -> ")}`;
}

// ---- The guard, over the real suites ----

test("no server suite reaches src/database.js before isolating the database", () => {
  const databaseModule = path.join(serverRoot, "src", "database.js");
  // Every .js file under test/: the runner executes each one as a suite.
  const suites = fs
    .readdirSync(testDir, { recursive: true })
    .filter((name) => name.endsWith(".js"))
    .map((name) => path.join(testDir, name));
  const reaching = suites.flatMap((suite) =>
    findDatabaseImports(suite, { root: serverRoot, databaseModule })
  );

  // Most suites legitimately reach the database through isolated imports, so
  // a walk that found none is broken, not clean.
  assert.ok(
    reaching.some((entry) => entry.isolated),
    "the import walk found no isolated route to src/database.js in any suite"
  );

  const violations = reaching.filter((entry) => !entry.isolated).map(describeViolation);
  assert.deepEqual(
    violations,
    [],
    [
      "These suites reach src/database.js before isolating it, so they open the real database.",
      "Point DATABASE_FILE and UPLOADS_DIR at a mkdtempSync scratch dir first, then load the modules with await import():",
      ...violations,
    ].join("\n")
  );
});

// ---- The guard's own rules, on throwaway trees shaped like server/ ----

const fixtureRoots = [];

after(() => {
  for (const root of fixtureRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// The stand-in database.js is never executed; the guard only reads source.
const FIXTURE_MODULES = {
  "src/database.js": "export const db = {};\n",
  "src/services/reader.js": 'import { db } from "../database.js";\nexport const read = () => db;\n',
  "src/services/barrel.js": 'export { read } from "./reader.js";\n',
  "src/services/pure.js": "export const pure = () => 1;\n",
};

function analyzeFixtureSuite(sourceLines) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-db-isolation-guard-"));
  fixtureRoots.push(root);

  const files = { ...FIXTURE_MODULES, "test/suite.test.js": sourceLines.join("\n") };
  for (const [relativePath, source] of Object.entries(files)) {
    const file = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, source);
  }

  return findDatabaseImports(path.join(root, "test", "suite.test.js"), {
    root,
    databaseModule: path.join(root, "src", "database.js"),
  });
}

const ISOLATE = [
  'process.env.DATABASE_FILE = "scratch/test.db";',
  'process.env.UPLOADS_DIR = "scratch/uploads";',
];
const READER = "../src/services/reader.js";
const READER_CHAIN = ["test/suite.test.js", "src/services/reader.js", "src/database.js"];

const CASES = [
  {
    name: "a static import that reaches database.js is flagged even below the assignments",
    // Static imports are hoisted: they are evaluated before line 1 runs.
    source: [...ISOLATE, `import { read } from "${READER}";`],
    want: [{ specifier: READER, dynamic: false, isolated: false, chain: READER_CHAIN }],
  },
  {
    name: "import() after both assignments is isolated",
    source: [...ISOLATE, `const { read } = await import("${READER}");`],
    want: [{ specifier: READER, dynamic: true, isolated: true, chain: READER_CHAIN }],
  },
  {
    name: "import() before the assignments is not isolated",
    source: [`const { read } = await import("${READER}");`, ...ISOLATE],
    want: [{ specifier: READER, dynamic: true, isolated: false, chain: READER_CHAIN }],
  },
  {
    name: "DATABASE_FILE alone does not isolate, because database.js also creates UPLOADS_DIR",
    source: [ISOLATE[0], `await import("${READER}");`],
    want: [{ specifier: READER, dynamic: true, isolated: false, chain: READER_CHAIN }],
  },
  {
    name: "assignments inside a hook run too late to isolate a top-level import()",
    source: ["before(() => {", ...ISOLATE, "});", `await import("${READER}");`],
    want: [{ specifier: READER, dynamic: true, isolated: false, chain: READER_CHAIN }],
  },
  {
    name: "a re-export is followed like an import",
    source: ['import { read } from "../src/services/barrel.js";'],
    want: [
      {
        specifier: "../src/services/barrel.js",
        dynamic: false,
        isolated: false,
        chain: [
          "test/suite.test.js",
          "src/services/barrel.js",
          "src/services/reader.js",
          "src/database.js",
        ],
      },
    ],
  },
  {
    name: "an import() of a computed specifier is assumed to reach the database",
    source: ['const target = "../src/services/pure.js";', "await import(target);"],
    want: [
      {
        specifier: null,
        dynamic: true,
        isolated: false,
        chain: ["test/suite.test.js", "import(<non-literal>)"],
      },
    ],
  },
  {
    name: "import text inside comments, strings, templates, and regexes is not followed",
    source: [
      '// const { db } = await import("../src/database.js");',
      '/* import { db } from "../src/database.js"; */',
      "const probe = 'import { db } from \"./src/config.js\";';",
      // The shape the config tests use to probe config.js in a child process.
      "const childSource = `",
      '  import { config } from "./src/config.js";',
      "`;",
      'import { pure } from "../src/services/pure.js";',
      // Read as a string, the quotes in this regex would swallow the import.
      `const quoted = /["']/; await import("${READER}");`,
    ],
    want: [{ specifier: READER, dynamic: true, isolated: false, chain: READER_CHAIN }],
  },
];

for (const { name, source, want } of CASES) {
  test(`guard: ${name}`, () => {
    assert.deepEqual(analyzeFixtureSuite(source), want);
  });
}
