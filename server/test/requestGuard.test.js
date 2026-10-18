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
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import request from "supertest";

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
