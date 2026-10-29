import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";

// The built frontend served from an install path with a dot-folder in it --
// `C:\Users\me\.apps\corolla`, `~/.local/share/corolla`, or a checkout under
// `.claude/worktrees/`. The SPA fallback once handed `sendFile` the absolute
// path of index.html, and `send` refuses any path with a dot segment by
// default, so every deep link (`/documents`, a pasted `?documentId=` link, a
// phone's Home Screen start URL) was a 404 while `/` still worked.
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-fix-helper-spa-"));
const clientDistDir = path.join(tempRoot, ".apps", "corolla", "client", "dist");
const INDEX_HTML = '<!doctype html><html><body><div id="root"></div></body></html>';

fs.mkdirSync(path.join(clientDistDir, "assets"), { recursive: true });
fs.writeFileSync(path.join(clientDistDir, "index.html"), INDEX_HTML);
fs.writeFileSync(path.join(clientDistDir, "assets", "app.js"), "console.log('app');");
// A dotfile inside the build must still never be served.
fs.writeFileSync(path.join(clientDistDir, ".secret"), "do-not-serve");

process.env.DATABASE_FILE = path.join(tempRoot, "test.db");
process.env.UPLOADS_DIR = path.join(tempRoot, "uploads");

const { db } = await import("../src/database.js");
const { initializeDatabase } = await import("../src/initDatabase.js");
const { createApp } = await import("../src/app.js");

initializeDatabase();
const app = createApp({ clientDistDir });

after(() => {
  // Windows will not remove the folder while the database is open.
  if (typeof db.close === "function") {
    db.close();
  }

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("deep links fall back to the SPA index from a dot-folder install path", async () => {
  for (const url of ["/documents", "/documents?documentId=12", "/procedures", "/notes", "/no-such-page"]) {
    const response = await request(app).get(url);

    assert.equal(response.status, 200, url);
    assert.match(response.headers["content-type"], /text\/html/, url);
    assert.equal(response.text, INDEX_HTML, url);
  }
});

test("the root and built assets are still served from that path", async () => {
  assert.equal((await request(app).get("/")).text, INDEX_HTML);

  const asset = await request(app).get("/assets/app.js");
  assert.equal(asset.status, 200);
  assert.match(asset.text, /console\.log/);
});

test("a dotfile inside the build is never served, and an unknown API route stays a JSON 404", async () => {
  const dotfile = await request(app).get("/.secret");
  assert.doesNotMatch(dotfile.text, /do-not-serve/);

  const api = await request(app).get("/api/no-such-route");
  assert.equal(api.status, 404);
  assert.match(api.headers["content-type"], /application\/json/);
});
