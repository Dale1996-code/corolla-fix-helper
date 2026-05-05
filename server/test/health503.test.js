import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import request from "supertest";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-health503-"));

process.env.DATABASE_FILE = path.join(tempRoot, "test.db");
process.env.UPLOADS_DIR = path.join(tempRoot, "uploads");
process.env.PORT = "4200";
process.env.CLIENT_PORT = "5175";

const { createApp } = await import("../src/app.js");
const { db } = await import("../src/database.js");

const app = createApp();

after(() => {
  try {
    db.close();
  } catch {
    // already closed by the 503 test
  }
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("GET /api/health returns 200 when database is reachable", async () => {
  const response = await request(app).get("/api/health");

  assert.equal(response.status, 200);
  assert.equal(response.body.status, "ok");
});

test("GET /api/health returns 503 after db.close()", async () => {
  db.close();

  const response = await request(app).get("/api/health");

  assert.equal(response.status, 503);
  assert.equal(response.body.status, "error");
});
