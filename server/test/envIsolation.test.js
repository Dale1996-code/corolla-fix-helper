import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after } from "node:test";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(testDir, "..");

// config.js loads .env from the working directory, which is server/ for
// `npm test` and for `cd server && node --test test/x.test.js`. The owner's
// server/.env holds the real OPENAI_API_KEY and NETWORK_MODE=1. Suites used to
// opt out one at a time by blanking the key before importing anything, so a
// new suite that forgot ran with the real key. config.js now skips .env
// whenever the test runner started the process, and this guard proves it from
// three sides: the runner still marks the process, no key reaches a suite, and
// a .env planted beside a probe is ignored under the runner but read outside
// it.

// Captured before this file can touch process.env: what every suite inherits
// from the shell that launched the runner.
const inherited = {
  NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
};

test("the test runner marks this process, which is what makes config.js skip .env", () => {
  assert.ok(
    inherited.NODE_TEST_CONTEXT,
    [
      "NODE_TEST_CONTEXT is not set, so config.js would load server/.env and its real OPENAI_API_KEY.",
      "Run the suites through `node --test` (npm test, or `cd server && node --test test/x.test.js`):",
      "plain `node test/x.test.js` and --test-isolation=none do not set it. If a Node upgrade",
      "renamed the variable, update the check at the top of src/config.js.",
    ].join("\n")
  );
});

test("no OpenAI key is visible to a suite under the test runner", async () => {
  const { config } = await import("../src/config.js");

  // config.js can skip .env but not the shell, so a key exported there would
  // reach every suite that does not blank it.
  assert.equal(
    inherited.OPENAI_API_KEY ?? "",
    "",
    "OPENAI_API_KEY is set in the environment that launched the tests. Unset it before running them."
  );
  assert.equal(config.openAiApiKey, "", "config.js read an OpenAI key under the test runner");
});

// ---- The mechanism itself, against a .env planted beside a child probe ----

const fixtureRoots = [];

after(() => {
  for (const root of fixtureRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const CANARY_KEY = "sk-env-isolation-canary-not-a-real-key";

// Loads the real config.js in a child process whose working directory holds a
// .env with a canary key and NETWORK_MODE=1, then reports what config read.
function probeConfigBesidePlantedEnv({ underRunner }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-env-isolation-"));
  fixtureRoots.push(root);
  fs.writeFileSync(path.join(root, ".env"), `OPENAI_API_KEY=${CANARY_KEY}\nNETWORK_MODE=1\n`);

  const configUrl = pathToFileURL(path.join(serverRoot, "src", "config.js")).href;
  const probe = `
    const { config } = await import(${JSON.stringify(configUrl)});
    console.log(JSON.stringify({ key: config.openAiApiKey, networkMode: config.networkMode }));
  `;
  // The planted .env must be the only source of both values.
  const env = { ...process.env };
  delete env.OPENAI_API_KEY;
  delete env.NETWORK_MODE;
  if (!underRunner) delete env.NODE_TEST_CONTEXT;

  const stdout = execFileSync(process.execPath, ["--input-type=module", "--eval", probe], {
    cwd: root,
    encoding: "utf8",
    env,
  });
  return JSON.parse(stdout.trim().split("\n").at(-1));
}

test("under the test runner, config.js ignores a .env in its working directory", () => {
  assert.deepEqual(probeConfigBesidePlantedEnv({ underRunner: true }), {
    key: "",
    networkMode: false,
  });
});

test("guard: outside the test runner, the same probe does read that .env", () => {
  // Without this, the check above would also pass if the probe never found
  // the planted .env at all.
  assert.deepEqual(probeConfigBesidePlantedEnv({ underRunner: false }), {
    key: CANARY_KEY,
    networkMode: true,
  });
});
