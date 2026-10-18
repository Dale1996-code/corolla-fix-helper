import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after } from "node:test";
import { DatabaseSync } from "node:sqlite";
import express from "express";

import { startServer } from "../src/serverLifecycle.js";

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

function listeningPort(output) {
  return new Promise((resolve) => {
    const check = () => {
      const match = output.stdout.match(/Server running on http:\/\/localhost:(\d+)/);

      if (match) {
        resolve(Number(match[1]));
      } else {
        setTimeout(check, 50);
      }
    };
    check();
  });
}

test("a shutdown signal folds the WAL into the .db file and closes it before exiting", async () => {
  const env = scratchEnv("graceful", { PORT: "0" });
  const walFile = `${env.DATABASE_FILE}-wal`;

  // child.kill() cannot deliver a real signal on Windows (it terminates the
  // process outright), so a preload turns an IPC message into the same
  // process "SIGINT" event Node raises for Ctrl+C. With no listener it exits
  // the way an unhandled SIGINT does. It is written to the temp dir because
  // the test runner executes every .js file under test/ as a suite.
  const preload = path.join(tempRoot, "signal-on-message.mjs");
  fs.writeFileSync(
    preload,
    [
      'process.on("message", (signal) => {',
      "  if (process.listenerCount(signal) === 0) process.exit(130);",
      "  process.emit(signal, signal);",
      "});",
      "",
    ].join("\n")
  );

  const { child, output, exited } = startChild({
    env,
    args: ["--import", pathToFileURL(preload).href],
    ipc: true,
  });

  try {
    const port = await waitFor(listeningPort(output), 20000, "server start");

    for (let index = 0; index < 30; index += 1) {
      const response = await fetch(`http://127.0.0.1:${port}/api/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: `shutdown note ${index}`, content: "x".repeat(2000) }),
      });
      assert.equal(response.status, 201);
    }

    // The audit's failure mode: the newest rows live only in the -wal file.
    assert.ok(fs.statSync(walFile).size > 0, "test setup: new rows should be in the -wal file");

    child.send("SIGINT");
    const { code } = await waitFor(exited, 20000, "server exit");

    assert.equal(code, 0, `expected a clean exit\n${output.stdout}\n${output.stderr}`);
    assert.ok(
      !fs.existsSync(walFile) || fs.statSync(walFile).size === 0,
      "the -wal file must be gone or empty after shutdown"
    );

    // Copy only the .db file — what the old manual rollback did — and the
    // rows must all be in it.
    const copiedDatabase = path.join(tempRoot, "graceful", "copy-of-db-only.db");
    fs.copyFileSync(env.DATABASE_FILE, copiedDatabase);
    const db = new DatabaseSync(copiedDatabase, { readOnly: true });

    try {
      const { count } = /** @type {{ count: number }} */ (
        db.prepare("SELECT COUNT(*) AS count FROM notes WHERE title LIKE 'shutdown note %'").get()
      );
      assert.equal(count, 30);
    } finally {
      db.close();
    }
  } finally {
    child.kill();
  }
});

test("a request that never finishes cannot stop the database from closing on shutdown", async () => {
  const app = express();
  let requestStarted;
  const started = new Promise((resolve) => {
    requestStarted = resolve;
  });
  app.get("/hang", () => {
    requestStarted();
    // Never responds, like a streaming planner run left open in a browser tab.
  });

  const fakeProcess = new EventEmitter();
  const calls = [];
  let exited;
  const exitCalled = new Promise((resolve) => {
    exited = resolve;
  });

  const { server } = startServer({
    app,
    port: 0,
    host: "127.0.0.1",
    processRef: fakeProcess,
    closeDatabase: () => calls.push("closeDatabase"),
    logger: { log() {}, error() {} },
    exit: (code) => {
      calls.push(`exit ${code}`);
      exited();
    },
    forceCloseAfterMs: 100,
  });
  await once(server, "listening");
  const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());

  const hanging = fetch(`http://127.0.0.1:${port}/hang`).catch(() => "connection cut");
  await started;

  fakeProcess.emit("SIGINT");
  await waitFor(exitCalled, 5000, "shutdown");

  assert.deepEqual(calls, ["closeDatabase", "exit 0"]);
  assert.equal(server.listening, false);
  assert.equal(await hanging, "connection cut");
});

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
