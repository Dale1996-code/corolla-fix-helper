import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyNetworkAddresses,
  describePhoneAccessUrls,
  formatPhoneUrlLines,
  getTailscaleDnsName,
  getTailscaleServeUrl,
  isLinkLocalAddress,
  isTailscaleAddress,
} from "../src/services/networkAddresses.js";

function ipv4(address, overrides = {}) {
  return {
    address,
    family: "IPv4",
    internal: false,
    netmask: "255.255.255.0",
    mac: "00:00:00:00:00:00",
    cidr: `${address}/24`,
    ...overrides,
  };
}

test("isTailscaleAddress matches only the 100.64.0.0/10 CGNAT range", () => {
  assert.equal(isTailscaleAddress("100.64.0.1"), true);
  assert.equal(isTailscaleAddress("100.101.102.103"), true);
  assert.equal(isTailscaleAddress("100.127.255.254"), true);

  assert.equal(isTailscaleAddress("100.63.255.255"), false);
  assert.equal(isTailscaleAddress("100.128.0.1"), false);
  assert.equal(isTailscaleAddress("192.168.1.42"), false);
  assert.equal(isTailscaleAddress("10.0.0.5"), false);
  assert.equal(isTailscaleAddress("not-an-address"), false);
  assert.equal(isTailscaleAddress(""), false);
});

test("isLinkLocalAddress matches the self-assigned 169.254.x.x range", () => {
  assert.equal(isLinkLocalAddress("169.254.10.20"), true);
  assert.equal(isLinkLocalAddress("169.253.0.1"), false);
  assert.equal(isLinkLocalAddress("192.168.1.42"), false);
});

test("classifyNetworkAddresses splits LAN and Tailscale, skipping loopback, IPv6, and link-local", () => {
  const interfaces = {
    lo: [ipv4("127.0.0.1", { internal: true })],
    "Wi-Fi": [
      ipv4("192.168.1.42"),
      { address: "fe80::1", family: "IPv6", internal: false },
    ],
    "Dead adapter": [ipv4("169.254.10.20")],
    Tailscale: [ipv4("100.101.102.103")],
    empty: undefined,
  };

  assert.deepEqual(classifyNetworkAddresses(interfaces), {
    lan: ["192.168.1.42"],
    tailscale: ["100.101.102.103"],
  });
});

test("classifyNetworkAddresses lists home-router ranges before virtual-adapter ranges", () => {
  const interfaces = {
    "vEthernet (WSL)": [ipv4("172.17.0.1")],
    Ethernet: [ipv4("192.168.1.42")],
    "Corp VPN": [ipv4("10.8.0.3")],
  };

  assert.deepEqual(classifyNetworkAddresses(interfaces).lan, [
    "192.168.1.42",
    "10.8.0.3",
    "172.17.0.1",
  ]);
});

test("formatPhoneUrlLines prints a Wi-Fi line per LAN address and prefers the MagicDNS name", () => {
  const lines = formatPhoneUrlLines(4000, {
    lan: ["192.168.1.42"],
    tailscale: ["100.101.102.103"],
    dnsName: "my-pc.tail1234.ts.net",
  });

  assert.deepEqual(lines, [
    "On your phone (same Wi-Fi):  http://192.168.1.42:4000",
    "Via Tailscale (anywhere):    http://my-pc.tail1234.ts.net:4000",
  ]);
});

test("formatPhoneUrlLines falls back to the Tailscale IP and omits absent groups", () => {
  assert.deepEqual(
    formatPhoneUrlLines(4000, { lan: [], tailscale: ["100.101.102.103"] }),
    ["Via Tailscale (anywhere):    http://100.101.102.103:4000"]
  );

  assert.deepEqual(formatPhoneUrlLines(4000, { lan: [], tailscale: [] }), []);
});

test("formatPhoneUrlLines singles out the HTTPS serve URL as the install address", () => {
  const lines = formatPhoneUrlLines(4000, {
    lan: [],
    tailscale: ["100.101.102.103"],
    dnsName: "my-pc.tail1234.ts.net",
    serveUrl: "https://my-pc.tail1234.ts.net",
  });

  assert.deepEqual(lines, [
    "Via Tailscale (anywhere):    http://my-pc.tail1234.ts.net:4000",
    "Install on iPhone from:      https://my-pc.tail1234.ts.net  (HTTPS via tailscale serve)",
  ]);
});

test("getTailscaleDnsName parses the CLI status and strips the trailing dot", async () => {
  const execFileImpl = (_command, _args, _options, callback) => {
    callback(null, JSON.stringify({ Self: { DNSName: "my-pc.tail1234.ts.net." } }), "");
  };

  assert.equal(
    await getTailscaleDnsName({ execFileImpl }),
    "my-pc.tail1234.ts.net"
  );
});

test("getTailscaleDnsName returns null when the CLI fails or answers strangely", async () => {
  const failing = (_command, _args, _options, callback) =>
    callback(new Error("not installed"), "", "");
  assert.equal(await getTailscaleDnsName({ execFileImpl: failing }), null);

  const garbled = (_command, _args, _options, callback) =>
    callback(null, "not json", "");
  assert.equal(await getTailscaleDnsName({ execFileImpl: garbled }), null);
});

test("getTailscaleDnsName tries the Windows install path after PATH lookup fails", async () => {
  const commandsTried = [];
  const execFileImpl = (command, _args, _options, callback) => {
    commandsTried.push(command);

    if (command === "tailscale") {
      return callback(new Error("not on PATH"), "", "");
    }

    return callback(null, JSON.stringify({ Self: { DNSName: "pc.ts.net." } }), "");
  };

  assert.equal(
    await getTailscaleDnsName({ execFileImpl, platform: "win32" }),
    "pc.ts.net"
  );
  assert.deepEqual(commandsTried, [
    "tailscale",
    "C:\\Program Files\\Tailscale\\tailscale.exe",
  ]);
});

test("getTailscaleServeUrl finds the HTTPS proxy for our port and strips :443", async () => {
  const serveStatus = {
    Web: {
      "my-pc.tail1234.ts.net:443": {
        Handlers: { "/": { Proxy: "http://127.0.0.1:4000" } },
      },
    },
  };
  const execFileImpl = (_command, _args, _options, callback) =>
    callback(null, JSON.stringify(serveStatus), "");

  assert.equal(
    await getTailscaleServeUrl(4000, { execFileImpl }),
    "https://my-pc.tail1234.ts.net"
  );
});

test("getTailscaleServeUrl keeps non-443 ports visible in the URL", async () => {
  const serveStatus = {
    Web: {
      "my-pc.tail1234.ts.net:8443": {
        Handlers: { "/": { Proxy: "http://localhost:4000" } },
      },
    },
  };
  const execFileImpl = (_command, _args, _options, callback) =>
    callback(null, JSON.stringify(serveStatus), "");

  assert.equal(
    await getTailscaleServeUrl(4000, { execFileImpl }),
    "https://my-pc.tail1234.ts.net:8443"
  );
});

test("getTailscaleServeUrl returns null when serve targets another port or is unset", async () => {
  const otherPort = (_command, _args, _options, callback) =>
    callback(
      null,
      JSON.stringify({
        Web: {
          "my-pc.tail1234.ts.net:443": {
            Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } },
          },
        },
      }),
      ""
    );
  assert.equal(await getTailscaleServeUrl(4000, { execFileImpl: otherPort }), null);

  const notConfigured = (_command, _args, _options, callback) =>
    callback(null, "{}", "");
  assert.equal(await getTailscaleServeUrl(4000, { execFileImpl: notConfigured }), null);

  const failing = (_command, _args, _options, callback) =>
    callback(new Error("no serve"), "", "");
  assert.equal(await getTailscaleServeUrl(4000, { execFileImpl: failing }), null);
});

test("describePhoneAccessUrls only consults the CLI when a Tailscale interface exists", async () => {
  let lookups = 0;
  const lookupDnsName = async () => {
    lookups += 1;
    return "my-pc.tail1234.ts.net";
  };
  const lookupServeUrl = async () => {
    lookups += 1;
    return "https://my-pc.tail1234.ts.net";
  };

  const withTailscale = await describePhoneAccessUrls(4000, {
    interfaces: {
      "Wi-Fi": [ipv4("192.168.1.42")],
      Tailscale: [ipv4("100.101.102.103")],
    },
    lookupDnsName,
    lookupServeUrl,
  });

  assert.deepEqual(withTailscale, [
    "On your phone (same Wi-Fi):  http://192.168.1.42:4000",
    "Via Tailscale (anywhere):    http://my-pc.tail1234.ts.net:4000",
    "Install on iPhone from:      https://my-pc.tail1234.ts.net  (HTTPS via tailscale serve)",
  ]);
  assert.equal(lookups, 2);

  const withoutTailscale = await describePhoneAccessUrls(4000, {
    interfaces: { "Wi-Fi": [ipv4("192.168.1.42")] },
    lookupDnsName,
    lookupServeUrl,
  });

  assert.deepEqual(withoutTailscale, [
    "On your phone (same Wi-Fi):  http://192.168.1.42:4000",
  ]);
  assert.equal(lookups, 2, "no Tailscale interface means no CLI lookups");
});
