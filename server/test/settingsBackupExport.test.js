import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { setImmediate } from "node:timers";
import { setImmediate as nextTurn } from "node:timers/promises";
import test, { after } from "node:test";
import express from "express";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "settings-export-test-"));
process.env.DATABASE_FILE = path.join(tempRoot, "test.db");
process.env.UPLOADS_DIR = path.join(tempRoot, "uploads");

const { createBackupExportHandler, requireLoopback } = await import(
  "../src/routes/settings.js"
);
const { db } = await import("../src/database.js");

after(() => {
  db.close();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

class FakeResponse extends Writable {
  constructor() {
    super({ autoDestroy: false });
    this.headers = {};
    this.headersSent = false;
    this.statusCode = 200;
    this.jsonBody = null;
    this.chunks = [];
    this.destroyError = null;
  }

  _write(chunk, _encoding, callback) {
    this.headersSent = true;
    this.chunks.push(Buffer.from(chunk));
    callback();
  }

  _destroy(error, callback) {
    this.destroyError = error;
    callback();
  }

  setHeader(name, value) {
    this.headers[name] = value;
  }

  status(statusCode) {
    this.statusCode = statusCode;
    return this;
  }

  json(body) {
    this.jsonBody = body;
    this.headersSent = true;
    this.end();
    return this;
  }
}

function fakeTarProcess() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    // A killed process reports close asynchronously, with no exit code.
    setImmediate(() => child.emit("close", null, "SIGTERM"));
    return true;
  };
  return child;
}

function buildHandler(tarProcess, overrides = {}) {
  return createBackupExportHandler({
    spawnProcess: () => tarProcess,
    resolveTar: () => "test-tar",
    createStagingDir: async () => "test-staging",
    removeStagingDir: () => {},
    logger: { error() {} },
    ...overrides,
  });
}

test("requireLoopback lets a request from the host machine through", () => {
  let nextCalled = false;
  const response = new FakeResponse();

  requireLoopback(
    { socket: { remoteAddress: "127.0.0.1" } },
    response,
    () => {
      nextCalled = true;
    }
  );

  assert.equal(nextCalled, true);
  assert.equal(response.jsonBody, null);
});

test("requireLoopback blocks a request from another device with 403", () => {
  let nextCalled = false;
  const response = new FakeResponse();

  requireLoopback(
    { socket: { remoteAddress: "192.168.1.42" } },
    response,
    () => {
      nextCalled = true;
    }
  );

  assert.equal(nextCalled, false);
  assert.equal(response.statusCode, 403);
  assert.match(response.jsonBody.error, /host machine/i);
});

test("Settings backup export returns 500 when tar fails before streaming", async () => {
  const tarProcess = fakeTarProcess();
  const response = new FakeResponse();
  const handler = buildHandler(tarProcess);

  await handler({}, response);
  tarProcess.stderr.write("tar startup failed");
  tarProcess.emit("close", 2);
  await once(response, "finish");

  assert.equal(response.statusCode, 500);
  assert.match(response.jsonBody.error, /Could not create backup export archive/);
  assert.equal(response.chunks.length, 0);
});

test("Settings backup export returns 500 when tar cannot start", async () => {
  const tarProcess = fakeTarProcess();
  const response = new FakeResponse();
  const handler = buildHandler(tarProcess);

  await handler({}, response);
  tarProcess.emit("error", new Error("spawn failed"));
  await once(response, "finish");

  assert.equal(response.statusCode, 500);
  assert.match(response.jsonBody.error, /Could not create backup export archive/);
  assert.equal(response.chunks.length, 0);
});

test("Settings backup export destroys and logs a failed response after streaming starts", async () => {
  const tarProcess = fakeTarProcess();
  const response = new FakeResponse();
  const logMessages = [];
  const handler = buildHandler(tarProcess, {
    logger: { error: (message) => logMessages.push(message) },
  });

  await handler({}, response);
  tarProcess.stdout.write("partial archive");
  tarProcess.stderr.write("archive write failed");
  tarProcess.emit("close", 2);
  await once(response, "close");

  assert.equal(response.headersSent, true);
  assert.equal(Buffer.concat(response.chunks).toString(), "partial archive");
  assert.equal(response.destroyed, true);
  assert.match(response.destroyError.message, /tar exited with code 2/);
  assert.match(logMessages.join("\n"), /archive write failed/);
  assert.match(logMessages.join("\n"), /code 2/);
});

test("Settings backup export stops tar and removes the staging copy when the download is cancelled", async () => {
  const tarProcess = fakeTarProcess();
  const response = new FakeResponse();
  const removed = [];
  const handler = buildHandler(tarProcess, {
    removeStagingDir: (stagingRoot) => removed.push(stagingRoot),
  });

  await handler({}, response);
  tarProcess.stdout.write("partial archive");
  await nextTurn();

  // The browser goes away mid-download: Express destroys the response.
  response.destroy();
  await nextTurn();

  assert.equal(tarProcess.killed, true, "tar must be stopped");
  await nextTurn();
  assert.deepEqual(removed, ["test-staging"]);
});

test("Settings backup export never starts tar when the download is cancelled while staging", async () => {
  const tarProcess = fakeTarProcess();
  const response = new FakeResponse();
  const removed = [];
  let spawned = false;
  let finishStaging;
  const handler = buildHandler(tarProcess, {
    createStagingDir: () =>
      new Promise((resolve) => {
        finishStaging = () => resolve("test-staging");
      }),
    spawnProcess: () => {
      spawned = true;
      return tarProcess;
    },
    removeStagingDir: (stagingRoot) => removed.push(stagingRoot),
  });

  const handling = handler({}, response);
  response.destroy();
  finishStaging();
  await handling;

  assert.equal(spawned, false);
  assert.deepEqual(removed, ["test-staging"]);
});

test("a real cancelled download kills the archiver process and deletes the staging folder", async () => {
  // A real child process stands in for tar: it writes archive-sized chunks
  // forever, so once the browser stops reading it blocks on a full pipe —
  // the audit's leaked tar.exe. The staging folder is real too.
  const stagingRoot = fs.mkdtempSync(path.join(tempRoot, "staging-"));
  fs.writeFileSync(path.join(stagingRoot, "copy-of-database.db"), "a full copy of the data");
  let archiver;

  const app = express();
  app.get(
    "/backup-export",
    createBackupExportHandler({
      resolveTar: () => process.execPath,
      spawnProcess: (_tar, _args, options) => {
        archiver = spawn(
          process.execPath,
          ["-e", "const c = Buffer.alloc(65536, 120); (function w() { process.stdout.write(c, w); })();"],
          options
        );
        return archiver;
      },
      createStagingDir: async () => stagingRoot,
      logger: { error() {}, warn() {} },
    })
  );
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());

  try {
    await new Promise((resolve) => {
      const request = http.get(`http://127.0.0.1:${port}/backup-export`, (response) => {
        response.once("data", () => {
          request.destroy();
          resolve();
        });
      });
      request.on("error", () => {});
    });

    const deadline = Date.now() + 5000;

    while (
      (archiver.exitCode === null && archiver.signalCode === null) ||
      fs.existsSync(stagingRoot)
    ) {
      if (Date.now() > deadline) {
        assert.fail(
          `after 5 s: archiver running=${archiver.exitCode === null && archiver.signalCode === null}, ` +
            `staging folder present=${fs.existsSync(stagingRoot)}`
        );
      }

      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  } finally {
    archiver?.kill();
    server.closeAllConnections();
    server.close();
  }
});

test("Settings backup export streams data and ends only after tar succeeds", async () => {
  const tarProcess = fakeTarProcess();
  const response = new FakeResponse();
  const handler = buildHandler(tarProcess);

  await handler({}, response);
  tarProcess.stdout.write("archive ");
  tarProcess.stdout.end("bytes");

  assert.equal(response.writableEnded, false);

  tarProcess.emit("close", 0);
  await once(response, "finish");

  assert.equal(Buffer.concat(response.chunks).toString(), "archive bytes");
  assert.equal(response.headers["Content-Type"], "application/gzip");
  assert.equal(response.destroyed, false);
});
