import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";

// These tests run the real entry point, src/index.js, in a child process with
// scratch DATABASE_FILE / UPLOADS_DIR paths, so they exercise exactly what
// `npm start` and `npm run dev:server` run.

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entryPoint = path.join(serverRoot, "src", "index.js");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "server-lifecycle-test-"));

after(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function scratchEnv(name, extra = {}) {
  const dir = path.join(tempRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  const env = {
    ...process.env,
    DATABASE_FILE: path.join(dir, "app.db"),
    UPLOADS_DIR: path.join(dir, "uploads"),
    NETWORK_MODE: "0",
    SEED_DEMO: "0",
    ...extra,
  };
  delete env.OPENAI_API_KEY;
  return env;
}

function startChild({ env, args = [], ipc = false }) {
  const child = spawn(process.execPath, [...args, entryPoint], {
    cwd: serverRoot,
    env,
    stdio: ["ignore", "pipe", "pipe", ...(ipc ? ["ipc"] : [])],
  });
  const output = { stdout: "", stderr: "" };
  child.stdout.on("data", (chunk) => {
    output.stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output.stderr += chunk;
  });
  const exited = new Promise((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });
  return { child, output, exited };
}

async function waitFor(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms: ${label}`)), ms);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

test("the server exits 1 with a clear message when its port is already taken", async () => {
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  const { port } = /** @type {import("node:net").AddressInfo} */ (blocker.address());

  const { child, output, exited } = startChild({
    env: scratchEnv("port-taken", { PORT: String(port) }),
  });

  try {
    const { code } = await waitFor(exited, 20000, "server exit");

    assert.equal(code, 1, `expected exit code 1\n${output.stdout}\n${output.stderr}`);
    assert.match(output.stderr, new RegExp(`port ${port}.*already in use`, "i"));
    assert.doesNotMatch(output.stdout, /Server running/);
  } finally {
    child.kill();
    blocker.close();
  }
});
