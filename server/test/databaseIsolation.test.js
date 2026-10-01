import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(testDir, "..");

// src/database.js opens config.databaseFile and creates config.uploadsDir the
// moment it is evaluated, so a suite that reaches it before pointing both env
// vars at a scratch dir opens -- and can lock -- the real 100 MB repair
// database. This guard reads source text only: it never executes a suite or a
// module, so it cannot itself open anything.

const ISOLATING_ENV_VARS = ["DATABASE_FILE", "UPLOADS_DIR"];

// After these keywords a "/" starts a regex rather than a division.
const REGEX_PRECEDING_KEYWORDS = new Set([
  "await",
  "case",
  "delete",
  "do",
  "else",
  "in",
  "instanceof",
  "new",
  "of",
  "return",
  "throw",
  "typeof",
  "void",
  "yield",
]);

/**
 * Split JavaScript source into identifier, punctuator, and string tokens, each
 * tagged with its brace depth. Comments, template text, and regex literals are
 * dropped so import-shaped text inside them is never mistaken for code; the
 * code inside a template's ${...} is still tokenized.
 */
function tokenize(source) {
  const tokens = [];
  // One entry per open "{" or "${": "brace" for code blocks, "template" for a
  // template expression, whose closing "}" resumes the template text.
  const stack = [];
  let depth = 0;
  let index = 0;

  const previousAllowsRegex = () => {
    const previous = tokens.at(-1);
    if (!previous) return true;
    if (previous.type === "identifier") return REGEX_PRECEDING_KEYWORDS.has(previous.value);
    if (previous.type === "string") return false;
    return ![")", "]", "}"].includes(previous.value);
  };

  // Scan template text from `index` (just past a backtick or a closing "}"),
  // stopping after the closing backtick or after an opening "${".
  const scanTemplateText = () => {
    while (index < source.length) {
      const char = source[index];
      if (char === "\\") {
        index += 2;
      } else if (char === "`") {
        index += 1;
        return;
      } else if (char === "$" && source[index + 1] === "{") {
        index += 2;
        stack.push("template");
        return;
      } else {
        index += 1;
      }
    }
  };

  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];

    if (/\s/.test(char)) {
      index += 1;
    } else if (char === "/" && next === "/") {
      const end = source.indexOf("\n", index);
      index = end === -1 ? source.length : end;
    } else if (char === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      index = end === -1 ? source.length : end + 2;
    } else if (char === "'" || char === '"') {
      let value = "";
      index += 1;
      while (index < source.length && source[index] !== char && source[index] !== "\n") {
        if (source[index] === "\\") {
          value += source[index + 1] ?? "";
          index += 2;
        } else {
          value += source[index];
          index += 1;
        }
      }
      index += 1;
      tokens.push({ type: "string", value, depth });
    } else if (char === "`") {
      index += 1;
      scanTemplateText();
      tokens.push({ type: "template", value: "`", depth });
    } else if (char === "/" && previousAllowsRegex()) {
      let inClass = false;
      index += 1;
      while (index < source.length && source[index] !== "\n") {
        const regexChar = source[index];
        if (regexChar === "\\") {
          index += 2;
          continue;
        }
        index += 1;
        if (regexChar === "[") inClass = true;
        else if (regexChar === "]") inClass = false;
        else if (regexChar === "/" && !inClass) break;
      }
      while (index < source.length && /[a-z]/i.test(source[index])) index += 1;
      tokens.push({ type: "regex", value: "/", depth });
    } else if (/[A-Za-z_$]/.test(char)) {
      const match = /^[\w$]+/.exec(source.slice(index));
      tokens.push({ type: "identifier", value: match[0], depth });
      index += match[0].length;
    } else if (/\d/.test(char)) {
      const match = /^[\w.]+/.exec(source.slice(index));
      tokens.push({ type: "number", value: match[0], depth });
      index += match[0].length;
    } else if (char === "{") {
      stack.push("brace");
      depth += 1;
      tokens.push({ type: "punctuator", value: "{", depth });
      index += 1;
    } else if (char === "}") {
      const opened = stack.pop();
      index += 1;
      if (opened === "template") {
        scanTemplateText();
      } else {
        depth = Math.max(0, depth - 1);
        tokens.push({ type: "punctuator", value: "}", depth });
      }
    } else if (char === "=") {
      // Keep "=", "==", "===", and "=>" apart: only a bare "=" assigns.
      const match = /^(===|==|=>|=)/.exec(source.slice(index));
      tokens.push({ type: "punctuator", value: match[0], depth });
      index += match[0].length;
    } else {
      tokens.push({ type: "punctuator", value: char, depth });
      index += 1;
    }
  }

  return tokens;
}

/**
 * Every import in a module, in source order: static imports, `export ... from`
 * re-exports, and import() calls (specifier null when it is not a literal).
 */
function collectImports(source) {
  const tokens = tokenize(source);
  const imports = [];
  const assignments = [];

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.type !== "identifier") continue;
    const previous = tokens[i - 1];
    const next = tokens[i + 1];
    // obj.import(...) or obj.export is a property, not syntax.
    if (previous?.value === ".") continue;

    if (token.value === "import" && next?.value === "(") {
      const argument = tokens[i + 2];
      const afterArgument = tokens[i + 3];
      const literal =
        argument?.type === "string" && [")", ","].includes(afterArgument?.value);
      imports.push({
        specifier: literal ? argument.value : null,
        dynamic: true,
        position: i,
      });
    } else if (token.value === "import" && next?.value !== ".") {
      // import "x"; import x from "x"; import { a, b as c } from "x";
      const specifier = tokens.slice(i + 1).find((candidate) => candidate.type === "string");
      if (specifier) imports.push({ specifier: specifier.value, dynamic: false, position: i });
    } else if (token.value === "export" && (next?.value === "*" || next?.value === "{")) {
      let j = i + 1;
      if (next.value === "{") {
        while (j < tokens.length && tokens[j].value !== "}") j += 1;
        j += 1;
      } else {
        j += 1;
        if (tokens[j]?.value === "as") j += 2;
      }
      if (tokens[j]?.value === "from" && tokens[j + 1]?.type === "string") {
        imports.push({ specifier: tokens[j + 1].value, dynamic: false, position: i });
      }
    } else if (
      token.value === "process" &&
      next?.value === "." &&
      tokens[i + 2]?.value === "env" &&
      token.depth === 0
    ) {
      // process.env.NAME = ...  or  process.env["NAME"] = ...
      const dotted = tokens[i + 3]?.value === "." && tokens[i + 5]?.value === "=";
      const bracketed =
        tokens[i + 3]?.value === "[" &&
        tokens[i + 4]?.type === "string" &&
        tokens[i + 5]?.value === "]" &&
        tokens[i + 6]?.value === "=";
      if (dotted || bracketed) {
        assignments.push({ name: tokens[i + 4].value, position: i });
      }
    }
  }

  return { imports, assignments };
}

function resolveRelative(fromFile, specifier) {
  if (!specifier?.startsWith("./") && !specifier?.startsWith("../")) return null;
  const resolved = path.resolve(path.dirname(fromFile), specifier);
  return fs.existsSync(resolved) && fs.statSync(resolved).isFile() ? resolved : null;
}

/**
 * Shortest import chain from `startFile` to `databaseModule`, as absolute
 * paths, or null when the module never reaches it. Follows relative static
 * imports, re-exports, and literal import() calls; bare and node: specifiers
 * are third-party and cannot reach the app's database module.
 */
function findChainToDatabase(startFile, databaseModule, importsCache) {
  const readImports = (file) => {
    if (!importsCache.has(file)) {
      importsCache.set(file, collectImports(fs.readFileSync(file, "utf8")).imports);
    }
    return importsCache.get(file);
  };

  const parents = new Map([[startFile, null]]);
  const queue = [startFile];
  while (queue.length > 0) {
    const file = queue.shift();
    if (file === databaseModule) {
      const chain = [];
      for (let step = file; step !== null; step = parents.get(step)) chain.unshift(step);
      return chain;
    }
    for (const { specifier } of readImports(file)) {
      const target = resolveRelative(file, specifier);
      if (target && !parents.has(target)) {
        parents.set(target, file);
        queue.push(target);
      }
    }
  }
  return null;
}

/**
 * Each import in `suiteFile` that reaches `databaseModule`, with whether it
 * runs only after DATABASE_FILE and UPLOADS_DIR are both assigned. A static
 * import is never isolated: imports are hoisted and evaluated before the
 * file's first statement. An import() is isolated only when both assignments
 * appear earlier at the top level -- an assignment inside a hook or a test
 * runs too late. A computed import() cannot be followed, so it is assumed to
 * reach the database.
 */
function findDatabaseImports(suiteFile, { root, databaseModule }) {
  const relative = (file) => path.relative(root, file).split(path.sep).join("/");
  const suite = relative(suiteFile);
  const { imports, assignments } = collectImports(fs.readFileSync(suiteFile, "utf8"));
  const importsCache = new Map();
  const results = [];

  for (const { specifier, dynamic, position } of imports) {
    let chain;
    if (specifier === null) {
      chain = [suite, "import(<non-literal>)"];
    } else {
      const target = resolveRelative(suiteFile, specifier);
      const reached = target && findChainToDatabase(target, databaseModule, importsCache);
      if (!reached) continue;
      chain = [suite, ...reached.map(relative)];
    }

    const isolated =
      dynamic &&
      ISOLATING_ENV_VARS.every((name) =>
        assignments.some((assignment) => assignment.name === name && assignment.position < position)
      );
    results.push({ specifier, dynamic, isolated, chain });
  }

  return results;
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
    .readdirSync(testDir, { recursive: true, encoding: "utf8" })
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
