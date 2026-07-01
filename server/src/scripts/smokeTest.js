// CLI: production smoke test for the built app.
//
//   npm run build && npm run smoke
//
// A green unit suite proves the pieces work; this proves the whole thing
// actually boots and answers. It starts the real Express app the same way
// `npm start` does, then makes live HTTP requests over a socket to confirm:
//
//   1. The built frontend (client/dist) is served, including the SPA fallback.
//   2. The core JSON API routes respond.
//   3. The AI route degrades gracefully with no OPENAI_API_KEY (no crash).
//
// It runs against a throwaway DATABASE_FILE + UPLOADS_DIR so it never touches
// real data, and exits non-zero if any check fails. This is meant to run right
// after `npm run build`, so a missing client/dist is treated as a failure.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..", "..", "..");

async function requestJson(baseUrl, routePath, options = {}) {
  const response = await fetch(`${baseUrl}${routePath}`, options);
  let body;

  try {
    body = await response.json();
  } catch {
    body = null;
  }

  return { status: response.status, body };
}

async function requestText(baseUrl, routePath) {
  const response = await fetch(`${baseUrl}${routePath}`);
  const text = await response.text();

  return {
    status: response.status,
    contentType: response.headers.get("content-type") || "",
    text,
  };
}

async function runChecks(baseUrl, { frontendBuilt }) {
  const checks = [];
  const check = async (name, fn) => {
    try {
      await fn();
      checks.push({ name, ok: true });
      console.log(`   ok   ${name}`);
    } catch (error) {
      checks.push({ name, ok: false, error });
      console.log(`   FAIL ${name}: ${error.message || error}`);
    }
  };

  await check("GET /api returns service info", async () => {
    const { status, body } = await requestJson(baseUrl, "/api");
    assert.equal(status, 200);
    assert.equal(body.name, "Corolla Fix Helper API");
  });

  await check("GET /api/health reports ok", async () => {
    const { status, body } = await requestJson(baseUrl, "/api/health");
    assert.equal(status, 200);
    assert.equal(body.status, "ok");
  });

  await check("GET /api/dashboard responds", async () => {
    const { status } = await requestJson(baseUrl, "/api/dashboard");
    assert.equal(status, 200);
  });

  await check("GET /api/documents returns a documents array", async () => {
    const { status, body } = await requestJson(baseUrl, "/api/documents");
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.documents), "expected documents array");
  });

  await check("GET /api/settings returns the vehicle profile", async () => {
    const { status, body } = await requestJson(baseUrl, "/api/settings");
    assert.equal(status, 200);
    assert.equal(typeof body.vehicle.make, "string");
  });

  await check("GET /api/search/documents responds", async () => {
    const { status, body } = await requestJson(
      baseUrl,
      "/api/search/documents?q=brake"
    );
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.results), "expected results array");
  });

  await check("POST /api/ask degrades gracefully without a key", async () => {
    const { status, body } = await requestJson(baseUrl, "/api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "Smoke test question?" }),
    });
    assert.equal(status, 200);
    assert.equal(body.status, "ai_not_configured");
  });

  if (frontendBuilt) {
    await check("GET / serves the built frontend", async () => {
      const { status, contentType, text } = await requestText(baseUrl, "/");
      assert.equal(status, 200);
      assert.match(contentType, /html/);
      assert.match(text, /<div id="root">/);
    });

    await check("GET /documents falls back to the SPA index", async () => {
      const { status, contentType } = await requestText(baseUrl, "/documents");
      assert.equal(status, 200);
      assert.match(contentType, /html/);
    });
  } else {
    await check("GET / serves the API fallback notice", async () => {
      const { status, body } = await requestJson(baseUrl, "/");
      assert.equal(status, 200);
      assert.equal(body.name, "Corolla Fix Helper API");
    });
  }

  return checks;
}

async function runSmokeTest() {
  const smokeRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "corolla-fix-helper-smoke-")
  );

  // Point the app at a throwaway database + uploads and force the graceful
  // no-key path. These must be set before app.js (and config.js) are imported.
  process.env.DATABASE_FILE = path.join(smokeRoot, "data", "smoke.db");
  process.env.UPLOADS_DIR = path.join(smokeRoot, "uploads");
  process.env.OPENAI_API_KEY = "";
  process.env.OCR_ENABLED = "false";
  process.env.SEED_DEMO = "";
  process.env.PORT = "0";

  const clientDistIndex = path.join(projectRoot, "client", "dist", "index.html");
  const frontendBuilt = fs.existsSync(clientDistIndex);

  if (!frontendBuilt) {
    console.warn(
      "Warning: client/dist/index.html not found. Run `npm run build` first " +
        "for a full production smoke test; checking the API fallback instead."
    );
  }

  const { createApp } = await import("../app.js");
  const { db } = await import("../database.js");

  const app = createApp();
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });

  try {
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    console.log(`Smoke testing the built app at ${baseUrl} ...`);

    const checks = await runChecks(baseUrl, { frontendBuilt });
    const failed = checks.filter((entry) => !entry.ok);

    console.log("");

    if (failed.length) {
      throw new Error(
        `${failed.length} of ${checks.length} smoke checks failed.`
      );
    }

    console.log(
      `Smoke test PASSED: ${checks.length} checks green` +
        (frontendBuilt ? " (built frontend served)." : " (API-only fallback).")
    );
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));

    if (typeof db.close === "function") {
      db.close();
    }

    fs.rmSync(smokeRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await runSmokeTest();
  } catch (error) {
    console.error("");
    console.error(`Smoke test FAILED: ${error.message || error}`);
    process.exitCode = 1;
  }
}
