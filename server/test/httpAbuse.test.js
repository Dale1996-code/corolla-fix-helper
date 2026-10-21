import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import request from "supertest";

// Known HTTP-boundary defects from the 2026-10-18 audit, as todo tests: each
// assertion states the behavior the app should have, and node:test reports the
// failure under its finding ID without failing the run. A fix removes the
// `todo` from the test it turns green. Loopback supertest only, no API key.
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-fix-helper-http-abuse-"));

process.env.DATABASE_FILE = path.join(tempRoot, "http-abuse.db");
process.env.UPLOADS_DIR = path.join(tempRoot, "uploads");
// config.js runs dotenv.config() at import, so pin what a local server/.env
// could otherwise change underneath these tests.
process.env.OPENAI_API_KEY = "";
process.env.NETWORK_MODE = "0";
process.env.OCR_ENABLED = "false";

fs.mkdirSync(process.env.UPLOADS_DIR, { recursive: true });

const { createApp } = await import("../src/app.js");
const { db } = await import("../src/database.js");

// A dist folder that does not exist, so the result never depends on whether
// the client has been built.
const app = createApp({ clientDistDir: path.join(tempRoot, "no-dist") });

after(() => {
  if (typeof db.close === "function") {
    db.close();
  }

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

const MINIMAL_PDF = Buffer.from("%PDF-1.1\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");

test(
  "a cross-origin multipart upload is refused and creates nothing",
  async () => {
    const before = (await request(app).get("/api/documents")).body;
    const response = await request(app)
      .post("/api/documents/upload")
      .set("Origin", "https://evil.example")
      .field("title", "Planted Manual")
      .field("system", "Brakes")
      .field("documentType", "manual")
      .attach("pdfFile", MINIMAL_PDF, { filename: "planted.pdf", contentType: "application/pdf" });
    const afterUpload = (await request(app).get("/api/documents")).body;

    // A multipart form is a "simple" request: the browser sends it without a
    // preflight, so CORS response headers cannot stop the write.
    assert.equal(response.status, 403, `upload from a foreign origin returned ${response.status}`);
    assert.deepEqual(afterUpload, before);
  }
);

test(
  "a text/plain body to POST /api/notes is a JSON 4xx, never an HTML 500",
  async () => {
    const response = await request(app)
      .post("/api/notes")
      .set("Content-Type", "text/plain")
      .send(JSON.stringify({ title: "x", content: "y" }));

    assert.ok(response.status >= 400 && response.status < 500, `status ${response.status}`);
    assert.match(response.headers["content-type"] || "", /application\/json/);
  }
);

test("malformed JSON is a JSON 400", async () => {
  const response = await request(app)
    .post("/api/notes")
    .set("Content-Type", "application/json")
    .send("{bad json");

  assert.equal(response.status, 400);
  assert.match(response.headers["content-type"] || "", /application\/json/);
});

test("an unknown /api route is a JSON 404", async () => {
  const response = await request(app).get("/api/does-not-exist");

  assert.equal(response.status, 404);
  assert.match(response.headers["content-type"] || "", /application\/json/);
});

test("a request with a foreign Host header is refused", async () => {
  // DNS rebinding: a page on an attacker's domain re-resolves to 127.0.0.1 and
  // then talks to the app as same-origin, carrying its own Host name. 421
  // Misdirected Request: this server does not answer to that name.
  const response = await request(app)
    .get("/api/documents")
    .set("Host", "rebind.attacker.example:4000");

  assert.equal(response.status, 421, `foreign Host served with ${response.status}`);
});

test("an upload whose bytes are not a PDF is rejected", { todo: "2A-09" }, async () => {
  const response = await request(app)
    .post("/api/documents/upload")
    .field("title", "Not a PDF")
    .field("system", "Brakes")
    .field("documentType", "manual")
    .attach("pdfFile", Buffer.from("<html>login page</html>"), {
      filename: "saved-login-page.pdf",
      contentType: "application/pdf",
    });

  assert.ok(
    response.status >= 400 && response.status < 500,
    `non-PDF bytes accepted with ${response.status}`
  );
});
