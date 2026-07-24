import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import test, { after } from "node:test";

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
