// The HTTP request gate of a no-login, local-first app.
//
// The app has no login on purpose, so the only things that keep a web page
// the owner happens to have open from driving it are checks on the request
// itself. Every case below drives the real createApp() over loopback with a
// scratch database, no OpenAI key, and NETWORK_MODE=0. Network-mode cases
// inject the Host allow-list instead of reading this machine's interfaces or
// running the tailscale CLI.
//
// Sections follow the threat each one closes:
//   1. Host allow-list: DNS rebinding (2A-03)
//   2. Cross-site writes and side-effect GETs (2A-02, 2A-07)
//   3. Backup export through a proxy such as `tailscale serve` (2A-08)
//   4. No CORS grant for any origin (2A-04)
//   5. Body contract and JSON errors (1B-06, 4A-04, 2A-12)
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import express from "express";
import request from "supertest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const samplePdf = path.join(__dirname, "fixtures", "sample-maintenance-schedule.pdf");

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-request-guard-"));
const clientDistDir = path.join(tempRoot, "client-dist");
fs.mkdirSync(clientDistDir, { recursive: true });
fs.writeFileSync(
  path.join(clientDistDir, "index.html"),
  "<!doctype html><html><body>Built Corolla app</body></html>"
);

process.env.DATABASE_FILE = path.join(tempRoot, "test.db");
process.env.UPLOADS_DIR = path.join(tempRoot, "uploads");
process.env.OPENAI_API_KEY = "";
// Pinned so a developer's server/.env (which may say NETWORK_MODE=1) cannot
// change what the default app accepts. dotenv never overrides a set variable.
process.env.NETWORK_MODE = "0";
process.env.ALLOWED_HOSTS = "";
process.env.OCR_ENABLED = "false";

const { createApp } = await import("../src/app.js");
const { createRateLimiter } = await import("../src/middleware/rateLimit.js");
const { db } = await import("../src/database.js");

const app = createApp({ clientDistDir });

after(() => {
  db.close();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

// What os.networkInterfaces() reports on a laptop with home Wi-Fi and Tailscale.
const LAPTOP_INTERFACES = {
  "Wi-Fi": [{ address: "192.168.1.20", family: "IPv4", internal: false }],
  Tailscale: [{ address: "100.101.102.103", family: "IPv4", internal: false }],
  "Loopback Pseudo-Interface 1": [{ address: "127.0.0.1", family: "IPv4", internal: true }],
};
const MAGIC_DNS_NAME = "my-pc.tail1234.ts.net";

// What `tailscale serve --bg 4000` sends to http://127.0.0.1:4000 when it
// proxies the phone's HTTPS request. It passes the browser's own Host through
// unchanged (ipn/ipnlocal/serve.go: `r.Out.Host = r.In.Host`) and adds the
// forwarding and identity headers.
const TAILSCALE_SERVE_HEADERS = {
  Host: MAGIC_DNS_NAME,
  "X-Forwarded-For": "100.90.80.70",
  "X-Forwarded-Host": MAGIC_DNS_NAME,
  "X-Forwarded-Proto": "https",
  "Tailscale-User-Login": "owner@example.com",
};

// What a current browser sends with a fetch() from a page the app served.
function sameOriginHeaders(host = "localhost:4000", scheme = "http") {
  return { Host: host, Origin: `${scheme}://${host}`, "Sec-Fetch-Site": "same-origin" };
}

// What a current browser sends when some other site's page fires the request.
const CROSS_SITE = {
  Host: "localhost:4000",
  Origin: "https://evil.example",
  "Sec-Fetch-Site": "cross-site",
};

async function createNetworkModeApp({
  networkMode = true,
  allowedHosts = [],
  interfaces = LAPTOP_INTERFACES,
  readInterfaces = () => interfaces,
  lookupDnsName = async () => MAGIC_DNS_NAME,
  ...appOptions
} = {}) {
  const { createHostAllowList } = await import("../src/middleware/requestGuard.js");

  return createApp({
    clientDistDir,
    hostAllowList: createHostAllowList({
      networkMode,
      allowedHosts,
      readInterfaces,
      lookupDnsName,
    }),
    ...appOptions,
  });
}

function uploadSamplePdf(target, headers = {}) {
  return request(target)
    .post("/api/documents/upload")
    .set(headers)
    .field("title", "Toyota FSM")
    .field("system", "Brakes")
    .field("documentType", "Manual")
    .attach("pdfFile", samplePdf);
}

async function createSymptom(target = app) {
  const response = await request(target)
    .post("/api/symptoms")
    .send({ title: "Brake squeal", description: "Front caliper noise" });
  assert.equal(response.status, 201);
  return response.body.symptom.id;
}

// ---------------------------------------------------------------------------
// 1. Host allow-list (2A-03)
// ---------------------------------------------------------------------------

test("2A-03: a request for a foreign Host is a JSON 421 that names ALLOWED_HOSTS", async () => {
  const response = await request(app)
    .get("/api/documents")
    .set("Host", "rebind.attacker.example:4000");

  assert.equal(response.status, 421);
  assert.match(response.headers["content-type"] || "", /application\/json/);
  assert.match(response.body.error, /ALLOWED_HOSTS/);
});

test("2A-03: DNS rebinding cannot download the backup", async () => {
  const response = await request(app)
    .get("/api/settings/backup-export")
    .set("Host", "rebind.attacker.example:4000");

  assert.equal(response.status, 421);
  assert.doesNotMatch(response.headers["content-type"] || "", /gzip/);
});

test("2A-03: a foreign Host gets neither the API nor the built frontend", async () => {
  for (const pathname of ["/", "/documents", "/api", "/api/health"]) {
    const response = await request(app).get(pathname).set("Host", "rebind.attacker.example");
    assert.equal(response.status, 421, pathname);
  }
});

test("2A-03: lookalikes of a loopback name are refused", async () => {
  for (const host of [
    "localhost.attacker.example",
    "127.0.0.1.nip.io",
    "localhost@attacker.example",
    "attacker.example/localhost",
    "127.0.0.2:4000",
  ]) {
    const response = await request(app).get("/api/health").set("Host", host);
    assert.equal(response.status, 421, host);
  }
});

test("2A-03: loopback names are accepted on any port and in any case", async () => {
  for (const host of [
    "localhost",
    "localhost:4000",
    "localhost:5173",
    "LocalHost:4000",
    "localhost.:4000",
    "127.0.0.1:4000",
    "[::1]:4000",
  ]) {
    const response = await request(app).get("/api/health").set("Host", host);
    assert.equal(response.status, 200, host);
  }
});

test("2A-03: NETWORK_MODE=0 accepts no LAN, Tailscale, or ALLOWED_HOSTS name", async () => {
  const loopbackOnly = await createNetworkModeApp({
    networkMode: false,
    allowedHosts: ["corolla.home.arpa"],
  });

  for (const host of [
    "192.168.1.20:4000",
    "100.101.102.103:4000",
    MAGIC_DNS_NAME,
    "corolla.home.arpa",
  ]) {
    const response = await request(loopbackOnly).get("/api/health").set("Host", host);
    assert.equal(response.status, 421, host);
  }
});

test("NETWORK_MODE=1 accepts this machine's Wi-Fi address", async () => {
  const networkApp = await createNetworkModeApp();
  const response = await request(networkApp).get("/api/health").set("Host", "192.168.1.20:4000");

  assert.equal(response.status, 200);
});

test("NETWORK_MODE=1 accepts this machine's Tailscale address and MagicDNS name", async () => {
  const networkApp = await createNetworkModeApp();

  for (const host of [
    "100.101.102.103:4000",
    `${MAGIC_DNS_NAME}:4000`,
    `${MAGIC_DNS_NAME.toUpperCase()}:4000`,
  ]) {
    const response = await request(networkApp).get("/api/health").set("Host", host);
    assert.equal(response.status, 200, host);
  }
});

test("NETWORK_MODE=1 accepts a request proxied by tailscale serve", async () => {
  const networkApp = await createNetworkModeApp();
  const response = await request(networkApp).get("/api/health").set(TAILSCALE_SERVE_HEADERS);

  assert.equal(response.status, 200);
});

test("NETWORK_MODE=1 matches ALLOWED_HOSTS entries by hostname only", async () => {
  const networkApp = await createNetworkModeApp({
    allowedHosts: ["Corolla.Home.Arpa:8080", "http://garage-pc.local:4000/"],
  });

  for (const host of ["corolla.home.arpa:4000", "corolla.home.arpa", "garage-pc.local:9999"]) {
    const response = await request(networkApp).get("/api/health").set("Host", host);
    assert.equal(response.status, 200, host);
  }
});

test("NETWORK_MODE=1 refuses other names without running the tailscale CLI for each", async () => {
  let lookups = 0;
  const networkApp = await createNetworkModeApp({
    lookupDnsName: async () => {
      lookups += 1;
      return MAGIC_DNS_NAME;
    },
  });

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await request(networkApp)
      .get("/api/health")
      .set("Host", `rebind-${attempt}.attacker.example`);
    assert.equal(response.status, 421);
  }

  const magicDns = await request(networkApp).get("/api/health").set("Host", MAGIC_DNS_NAME);
  assert.equal(magicDns.status, 200);
  assert.ok(lookups <= 1, `the tailscale CLI was consulted ${lookups} times`);
});

test("NETWORK_MODE=1 without a Tailscale interface never consults the tailscale CLI", async () => {
  let lookups = 0;
  const networkApp = await createNetworkModeApp({
    interfaces: { "Wi-Fi": LAPTOP_INTERFACES["Wi-Fi"] },
    lookupDnsName: async () => {
      lookups += 1;
      return MAGIC_DNS_NAME;
    },
  });

  const response = await request(networkApp).get("/api/health").set("Host", MAGIC_DNS_NAME);

  assert.equal(response.status, 421);
  assert.equal(lookups, 0);
});

test("NETWORK_MODE=1 picks up a Wi-Fi address that changed after startup", async () => {
  let interfaces = { "Wi-Fi": [{ address: "192.168.1.20", family: "IPv4", internal: false }] };
  const networkApp = await createNetworkModeApp({ readInterfaces: () => interfaces });

  assert.equal(
    (await request(networkApp).get("/api/health").set("Host", "192.168.1.20:4000")).status,
    200
  );

  interfaces = { "Wi-Fi": [{ address: "192.168.1.77", family: "IPv4", internal: false }] };

  assert.equal(
    (await request(networkApp).get("/api/health").set("Host", "192.168.1.77:4000")).status,
    200
  );
});

// ---------------------------------------------------------------------------
// 2. Cross-site writes and side-effect GETs (2A-02, 2A-07)
// ---------------------------------------------------------------------------

test("2A-02: a cross-site multipart upload is refused and plants nothing", async () => {
  const before = (await request(app).get("/api/documents")).body;
  const response = await uploadSamplePdf(app, CROSS_SITE);
  const afterUpload = (await request(app).get("/api/documents")).body;

  assert.equal(response.status, 403);
  assert.match(response.headers["content-type"] || "", /application\/json/);
  assert.deepEqual(afterUpload, before);
});

test("2A-02: a browser without Fetch Metadata is refused by its foreign Origin", async () => {
  const response = await uploadSamplePdf(app, {
    Host: "localhost:4000",
    Origin: "https://evil.example",
  });

  assert.equal(response.status, 403);
});

test("a refused upload is still answered with its reason, not a dropped connection", async () => {
  // The refusal comes before the body is read; the gate drains the upload
  // first so the phone sees the 421 naming ALLOWED_HOSTS, not ECONNRESET.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await uploadSamplePdf(app, { Host: "my-pc.local:4000" });
    assert.equal(response.status, 421);
    assert.match(response.body.error, /ALLOWED_HOSTS/);
  }
});

test("2A-02: a cross-site, body-less POST cannot re-run extraction", async () => {
  const uploaded = await uploadSamplePdf(app);
  assert.equal(uploaded.status, 201);

  const response = await request(app)
    .post(`/api/documents/${uploaded.body.document.id}/extract`)
    .set(CROSS_SITE);

  assert.equal(response.status, 403);
});

test("2A-02: a page served from another localhost port cannot write", async () => {
  const response = await request(app)
    .post("/api/notes")
    .set({ Host: "localhost:4000", Origin: "http://localhost:3000", "Sec-Fetch-Site": "same-site" })
    .send({ title: "Planted by another dev server" });

  assert.equal(response.status, 403);
});

test("2A-02: Sec-Fetch-Site decides when present, whatever the Origin says", async () => {
  const response = await request(app)
    .post("/api/notes")
    .set({ ...sameOriginHeaders(), "Sec-Fetch-Site": "cross-site" })
    .send({ title: "Planted" });

  assert.equal(response.status, 403);
});

test("2A-02: Origin: null (a sandboxed frame or privacy redirect) cannot write", async () => {
  const response = await request(app)
    .post("/api/notes")
    .set({ Host: "localhost:4000", Origin: "null" })
    .send({ title: "Planted" });

  assert.equal(response.status, 403);
});

test("2A-02: an old browser's Origin must match the Host it was sent to, port included", async () => {
  const response = await request(app)
    .post("/api/notes")
    .set({ Host: "localhost:4000", Origin: "http://localhost:3000" })
    .send({ title: "Planted" });

  assert.equal(response.status, 403);
});

test("2A-02: a cross-site DELETE is refused and the record survives", async () => {
  const created = await request(app).post("/api/notes").send({ title: "Keep me" });
  assert.equal(created.status, 201);
  const noteId = created.body.note.id;

  const response = await request(app).delete(`/api/notes/${noteId}`).set(CROSS_SITE);

  const notes = (await request(app).get("/api/notes")).body.notes;

  assert.equal(response.status, 403);
  assert.ok(notes.some((note) => note.id === noteId), "the note was deleted cross-site");
});

test("2A-02/2A-07: a cross-site GET (an <img src>) cannot start procedure suggestions", async () => {
  const symptomId = await createSymptom();
  const response = await request(app)
    .get(`/api/symptoms/${symptomId}/suggested-procedures`)
    .set({ Host: "localhost:4000", "Sec-Fetch-Site": "cross-site" });

  assert.equal(response.status, 403);
});

test("2A-02: a cross-site GET cannot stage a backup", async () => {
  const response = await request(app)
    .get("/api/settings/backup-export")
    .set({ Host: "localhost:4000", "Sec-Fetch-Site": "cross-site" });

  assert.equal(response.status, 403);
  assert.doesNotMatch(response.headers["content-type"] || "", /gzip/);
});

test("2A-07: procedure suggestions share the AI rate-limit window", async () => {
  const limitedApp = createApp({
    clientDistDir,
    aiRateLimiter: createRateLimiter({ windowMs: 60_000, max: 2 }),
  });
  const symptomId = await createSymptom(limitedApp);
  const statuses = [];

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await request(limitedApp)
      .get(`/api/symptoms/${symptomId}/suggested-procedures`)
      .set(sameOriginHeaders());
    statuses.push(response.status);
  }

  assert.deepEqual(statuses, [200, 200, 429]);
});

test("2A-07: refused cross-site suggestion requests do not use up the AI window", async () => {
  const limitedApp = createApp({
    clientDistDir,
    aiRateLimiter: createRateLimiter({ windowMs: 60_000, max: 1 }),
  });
  const symptomId = await createSymptom(limitedApp);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const refused = await request(limitedApp)
      .get(`/api/symptoms/${symptomId}/suggested-procedures`)
      .set({ Host: "localhost:4000", "Sec-Fetch-Site": "cross-site" });
    assert.equal(refused.status, 403);
  }

  const owner = await request(limitedApp)
    .get(`/api/symptoms/${symptomId}/suggested-procedures`)
    .set(sameOriginHeaders());
  assert.equal(owner.status, 200);
});

test("a same-origin page can write", async () => {
  const response = await request(app)
    .post("/api/notes")
    .set(sameOriginHeaders())
    .send({ title: "Same-origin note" });

  assert.equal(response.status, 201);
});

test("a typed URL or bookmark (Sec-Fetch-Site: none) can open suggestions", async () => {
  const symptomId = await createSymptom();
  const response = await request(app)
    .get(`/api/symptoms/${symptomId}/suggested-procedures`)
    .set({ Host: "localhost:4000", "Sec-Fetch-Site": "none" });

  assert.equal(response.status, 200);
});

test("an old browser without Fetch Metadata can write when its Origin is this origin", async () => {
  const response = await request(app)
    .post("/api/notes")
    .set({ Host: "localhost:4000", Origin: "http://localhost:4000" })
    .send({ title: "Old Safari note" });

  assert.equal(response.status, 201);
});

test("a non-browser client (curl, scripts, the smoke test) can write", async () => {
  const response = await request(app).post("/api/notes").send({ title: "curl note" });

  assert.equal(response.status, 201);
});

test("the Vite dev proxy keeps working: Host and Origin are both localhost:5173", async () => {
  const modern = await request(app)
    .post("/api/notes")
    .set(sameOriginHeaders("localhost:5173"))
    .send({ title: "Dev-mode note" });
  const old = await request(app)
    .post("/api/notes")
    .set({ Host: "localhost:5173", Origin: "http://localhost:5173" })
    .send({ title: "Dev-mode note, old browser" });

  assert.equal(modern.status, 201);
  assert.equal(old.status, 201);
});

test("a same-origin multipart upload still works", async () => {
  const response = await uploadSamplePdf(app, sameOriginHeaders());

  assert.equal(response.status, 201);
});

test("NETWORK_MODE=1: the phone on Wi-Fi or plain MagicDNS can write", async () => {
  const networkApp = await createNetworkModeApp();

  for (const host of ["192.168.1.20:4000", `${MAGIC_DNS_NAME}:4000`]) {
    const response = await request(networkApp)
      .post("/api/notes")
      .set(sameOriginHeaders(host))
      .send({ title: `Phone note via ${host}` });
    assert.equal(response.status, 201, host);
  }
});

test("NETWORK_MODE=1: the phone through tailscale serve can write and upload", async () => {
  const networkApp = await createNetworkModeApp();
  const serveOrigin = `https://${MAGIC_DNS_NAME}`;

  const modern = await request(networkApp)
    .post("/api/notes")
    .set({ ...TAILSCALE_SERVE_HEADERS, Origin: serveOrigin, "Sec-Fetch-Site": "same-origin" })
    .send({ title: "Phone note via tailscale serve" });
  const oldSafari = await request(networkApp)
    .post("/api/notes")
    .set({ ...TAILSCALE_SERVE_HEADERS, Origin: serveOrigin })
    .send({ title: "Old Safari note via tailscale serve" });
  const upload = await uploadSamplePdf(networkApp, {
    ...TAILSCALE_SERVE_HEADERS,
    Origin: serveOrigin,
    "Sec-Fetch-Site": "same-origin",
  });

  assert.equal(modern.status, 201);
  assert.equal(oldSafari.status, 201);
  assert.equal(upload.status, 201);
});

// ---------------------------------------------------------------------------
// 3. Backup export through a proxy (2A-08)
// ---------------------------------------------------------------------------

test("2A-08: backup export refuses a request that came through tailscale serve", async () => {
  const networkApp = await createNetworkModeApp();
  const response = await request(networkApp)
    .get("/api/settings/backup-export")
    .set({ ...TAILSCALE_SERVE_HEADERS, "Sec-Fetch-Site": "same-origin" });

  assert.equal(response.status, 403);
  assert.match(response.body.error, /host machine/i);
});

test("2A-08: backup export refuses any request carrying proxy forwarding headers", async () => {
  for (const forwarding of [
    { "X-Forwarded-For": "192.168.1.50" },
    { Forwarded: "for=192.168.1.50;proto=http" },
    { "X-Forwarded-Host": "corolla.example" },
  ]) {
    const response = await request(app)
      .get("/api/settings/backup-export")
      .set({ Host: "localhost:4000", ...forwarding });
    assert.equal(response.status, 403, JSON.stringify(forwarding));
  }
});

test("2A-08: backup export refuses a loopback connection addressed to a network name", async () => {
  // e.g. the Vite dev server started with --host, proxying a phone's request.
  const networkApp = await createNetworkModeApp();
  const response = await request(networkApp)
    .get("/api/settings/backup-export")
    .set("Host", "192.168.1.20:4000");

  assert.equal(response.status, 403);
});

test("backup export still works on the host machine, directly and through the Vite proxy", async () => {
  const direct = await request(app).get("/api/settings/backup-export").set("Host", "localhost:4000");
  const viaVite = await request(app)
    .get("/api/settings/backup-export")
    .set({ Host: "localhost:5173", "Sec-Fetch-Site": "same-origin" });

  assert.equal(direct.status, 200);
  assert.match(direct.headers["content-type"] || "", /gzip/);
  assert.equal(viaVite.status, 200);
  assert.match(viaVite.headers["content-type"] || "", /gzip/);
});

// ---------------------------------------------------------------------------
// 4. No CORS grant (2A-04)
// ---------------------------------------------------------------------------

test("2A-04: no origin is granted CORS access, not even the Vite port", async () => {
  const preflight = await request(app)
    .options("/api/notes/1")
    .set({ Origin: "http://localhost:5173", "Access-Control-Request-Method": "DELETE" });
  const read = await request(app).get("/api/settings").set("Origin", "http://localhost:5173");

  assert.equal(preflight.headers["access-control-allow-origin"], undefined);
  assert.equal(read.headers["access-control-allow-origin"], undefined);
});

// ---------------------------------------------------------------------------
// 5. Body contract and JSON errors (1B-06, 4A-04, 2A-12)
// ---------------------------------------------------------------------------

test("1B-06: a text/plain body is a JSON 415, never an HTML 500, and writes nothing", async () => {
  const before = (await request(app).get("/api/notes")).body;
  const response = await request(app)
    .post("/api/notes")
    .set("Content-Type", "text/plain")
    .send(JSON.stringify({ title: "x", content: "y" }));
  const afterPost = (await request(app).get("/api/notes")).body;

  assert.equal(response.status, 415);
  assert.match(response.headers["content-type"] || "", /application\/json/);
  assert.match(response.body.error, /application\/json/);
  assert.deepEqual(afterPost, before);
});

test("4A-04: JSON write routes answer a form-encoded body with 415", async () => {
  for (const [method, pathname] of [
    ["post", "/api/notes"],
    ["put", "/api/notes/1"],
    ["post", "/api/symptoms"],
    ["post", "/api/procedures"],
    ["put", "/api/settings/vehicle"],
    ["post", "/api/ask"],
    ["post", "/api/repair-plan"],
  ]) {
    const response = await request(app)[method](pathname).type("form").send("title=Planted");
    assert.equal(response.status, 415, `${method.toUpperCase()} ${pathname}`);
  }
});

test("1B-06: malformed JSON is a JSON 400 without a stack trace", async () => {
  const response = await request(app)
    .post("/api/notes")
    .set("Content-Type", "application/json")
    .send("{bad json");

  assert.equal(response.status, 400);
  assert.match(response.headers["content-type"] || "", /application\/json/);
  assert.equal(typeof response.body.error, "string");
  assert.doesNotMatch(response.text, /node_modules|at JSON\.parse|SyntaxError/);
});

test("4A-04: a body-less POST is a JSON 400 validation error, not a 500", async () => {
  for (const pathname of ["/api/notes", "/api/symptoms", "/api/procedures"]) {
    const response = await request(app).post(pathname);
    assert.equal(response.status, 400, pathname);
    assert.match(response.body.error, /required/i, pathname);
  }
});

test("4A-04: a browser POST with Content-Length: 0 is body-less, not a 415", async () => {
  const response = await request(app)
    .post("/api/notes")
    .set({ ...sameOriginHeaders(), "Content-Length": "0" });

  assert.equal(response.status, 400);
  assert.match(response.body.error, /Title is required/);
});

test("1B-06: a long note well past the old 100 kB default is saved", async () => {
  const response = await request(app)
    .post("/api/notes")
    .send({ title: "Long note", content: "torque spec ".repeat(25_000) });

  assert.equal(response.status, 201);
});

test("1B-06: a body over the JSON limit is a JSON 413", async () => {
  const response = await request(app)
    .post("/api/notes")
    .send({ title: "Huge note", content: "x".repeat(2 * 1024 * 1024) });

  assert.equal(response.status, 413);
  assert.match(response.headers["content-type"] || "", /application\/json/);
});

test("1B-06: an unknown /api route is a JSON 404", async () => {
  for (const [method, pathname] of [
    ["get", "/api/does-not-exist"],
    ["post", "/api/does-not-exist"],
    ["get", "/api/notes/1/not-a-route"],
  ]) {
    const response = await request(app)[method](pathname);
    assert.equal(response.status, 404, `${method.toUpperCase()} ${pathname}`);
    assert.match(response.headers["content-type"] || "", /application\/json/);
  }
});

test("an unknown non-API path still serves the app shell", async () => {
  const response = await request(app).get("/documents/some/client/route");

  assert.equal(response.status, 200);
  assert.match(response.text, /Built Corolla app/);
});

test("2A-12: responses do not advertise Express", async () => {
  const response = await request(app).get("/api/health");

  assert.equal(response.headers["x-powered-by"], undefined);
});

test("4A-04: an unexpected error is a generic JSON 500 and the detail is only logged", async () => {
  const { createJsonErrorHandler } = await import("../src/middleware/requestGuard.js");
  const logged = [];
  const probe = express();
  probe.get("/boom", () => {
    throw new Error("SQLITE_CONSTRAINT at C:\\Users\\owner\\corolla.db");
  });
  probe.use(createJsonErrorHandler({ logger: { error: (...args) => logged.push(args) } }));

  const response = await request(probe).get("/boom");

  assert.equal(response.status, 500);
  assert.match(response.headers["content-type"] || "", /application\/json/);
  assert.equal(typeof response.body.error, "string");
  assert.doesNotMatch(response.text, /SQLITE|Users|owner/);
  assert.equal(logged.length, 1);
});
