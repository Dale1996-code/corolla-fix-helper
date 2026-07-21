// Phone-access address discovery for the startup banner.
//
// The server listens on all interfaces, so a phone on the same network can use
// the app at http://<this machine's address>:<port>. This service finds those
// addresses so `index.js` can print ready-to-type URLs instead of only
// `localhost`:
//
//   - LAN IPv4 addresses (home Wi-Fi), filtered of link-local noise and sorted
//     so real home-router ranges beat virtual adapters (Docker, WSL, Hyper-V).
//   - Tailscale addresses, recognized by Tailscale's dedicated CGNAT range
//     100.64.0.0/10. When the `tailscale` CLI answers, the stable MagicDNS
//     machine name is preferred over the raw 100.x address, and a configured
//     `tailscale serve` HTTPS proxy for our port is surfaced as the
//     recommended install URL (service workers need a secure origin, so the
//     Serve URL is the only one with working offline support).
//
// The CLI is only consulted when a Tailscale interface exists, so machines
// without Tailscale never pay for a subprocess at startup. Everything here is
// best-effort display logic: any failure (no interfaces, no Tailscale, CLI
// missing or slow) must degrade to fewer banner lines, never a startup error.

import os from "node:os";
import { execFile } from "node:child_process";

/** True when the IPv4 address is in Tailscale's CGNAT range (100.64.0.0/10). */
export function isTailscaleAddress(address) {
  const octets = String(address)
    .split(".")
    .map((part) => Number(part));

  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part))) {
    return false;
  }

  return octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
}

/** True for 169.254.x.x — a self-assigned address no phone can reach. */
export function isLinkLocalAddress(address) {
  return /^169\.254\./.test(String(address));
}

// Lower is more likely to be the address a phone on home Wi-Fi can reach.
// Virtual adapters (Docker's 172.17.x, WSL, Hyper-V) usually land in the
// later buckets, so real router ranges print first.
function lanPriority(address) {
  if (/^192\.168\./.test(address)) {
    return 0;
  }

  if (/^10\./.test(address)) {
    return 1;
  }

  if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) {
    return 2;
  }

  return 3;
}

/**
 * One entry of `os.networkInterfaces()`, reduced to the fields read here so
 * tests can pass simple literals.
 * @typedef {{ address: string, family: string, internal: boolean }} InterfaceAddress
 */

/**
 * The callback shape of `child_process.execFile` actually used here, so tests
 * can inject a plain function.
 * @typedef {(command: string, args: string[],
 *            options: { timeout: number, windowsHide: boolean },
 *            callback: (error: Error | null, stdout: string, stderr: string) => void) => unknown} ExecFileLike
 */

/**
 * Split the machine's external IPv4 addresses into LAN and Tailscale groups.
 * LAN addresses are sorted most-likely-reachable first.
 *
 * @param {Record<string, InterfaceAddress[] | undefined>} [interfaces]
 *   Injectable for tests; defaults to the live `os.networkInterfaces()`.
 * @returns {{ lan: string[], tailscale: string[] }}
 */
export function classifyNetworkAddresses(interfaces = os.networkInterfaces()) {
  const lan = [];
  const tailscale = [];

  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (entry.internal || entry.family !== "IPv4" || isLinkLocalAddress(entry.address)) {
        continue;
      }

      if (isTailscaleAddress(entry.address)) {
        tailscale.push(entry.address);
      } else {
        lan.push(entry.address);
      }
    }
  }

  lan.sort((a, b) => lanPriority(a) - lanPriority(b));

  return { lan, tailscale };
}

/**
 * Run the local `tailscale` CLI and return stdout, or null on any failure.
 * On Windows the installer does not always put the CLI on PATH, so the
 * default install location is tried second.
 *
 * @param {string[]} args
 * @param {{ execFileImpl?: ExecFileLike, platform?: string, timeoutMs?: number }} [options]
 * @returns {Promise<string | null>}
 */
function runTailscaleCli(args, options = {}) {
  const {
    execFileImpl = execFile,
    platform = process.platform,
    timeoutMs = 1500,
  } = options;

  const commands = ["tailscale"];

  if (platform === "win32") {
    commands.push("C:\\Program Files\\Tailscale\\tailscale.exe");
  }

  const tryCommand = (command) =>
    new Promise((resolve) => {
      execFileImpl(
        command,
        args,
        { timeout: timeoutMs, windowsHide: true },
        (error, stdout) => resolve(error ? null : String(stdout))
      );
    });

  return commands.reduce(
    (previous, command) => previous.then((found) => (found === null ? tryCommand(command) : found)),
    Promise.resolve(/** @type {string | null} */ (null))
  );
}

/**
 * This machine's MagicDNS name, e.g. "my-pc.tail1234.ts.net", or null when
 * the CLI is unavailable or answers strangely — the 100.x interface address
 * is a fine fallback.
 *
 * @param {{ execFileImpl?: ExecFileLike, platform?: string, timeoutMs?: number }} [options]
 * @returns {Promise<string | null>}
 */
export async function getTailscaleDnsName(options = {}) {
  const stdout = await runTailscaleCli(["status", "--json"], options);

  if (stdout === null) {
    return null;
  }

  try {
    const status = JSON.parse(stdout);
    const dnsName = status?.Self?.DNSName;

    if (typeof dnsName === "string" && dnsName.trim()) {
      // Tailscale reports a fully-qualified name with a trailing dot.
      return dnsName.trim().replace(/\.$/, "");
    }
  } catch {
    // Not JSON — treat as unavailable.
  }

  return null;
}

/**
 * The HTTPS URL `tailscale serve` exposes for this app, or null when Serve is
 * not configured (or not pointing at our port). Serve is what gives the phone
 * a valid-certificate HTTPS origin, which service workers require, so the
 * banner singles this URL out as the one to install from.
 *
 * @param {number} port
 * @param {{ execFileImpl?: ExecFileLike, platform?: string, timeoutMs?: number }} [options]
 * @returns {Promise<string | null>}
 */
export async function getTailscaleServeUrl(port, options = {}) {
  const stdout = await runTailscaleCli(["serve", "status", "--json"], options);

  if (stdout === null) {
    return null;
  }

  try {
    const status = JSON.parse(stdout);

    for (const [hostPort, site] of Object.entries(status?.Web || {})) {
      const handlers = Object.values(site?.Handlers || {});
      const proxiesToApp = handlers.some((handler) => {
        try {
          return new URL(handler?.Proxy).port === String(port);
        } catch {
          return false;
        }
      });

      if (proxiesToApp) {
        return hostPort.endsWith(":443")
          ? `https://${hostPort.slice(0, -4)}`
          : `https://${hostPort}`;
      }
    }
  } catch {
    // Not JSON — treat as not configured.
  }

  return null;
}

/**
 * Format the banner lines for the discovered addresses. Pure so tests can
 * cover every combination without touching the network.
 *
 * @param {number} port
 * @param {{ lan: string[], tailscale: string[], dnsName?: string | null, serveUrl?: string | null }} addresses
 * @returns {string[]}
 */
export function formatPhoneUrlLines(port, { lan, tailscale, dnsName = null, serveUrl = null }) {
  const lines = [];

  for (const address of lan) {
    lines.push(`On your phone (same Wi-Fi):  http://${address}:${port}`);
  }

  const tailscaleHost = dnsName || tailscale[0];

  if (tailscaleHost) {
    lines.push(`Via Tailscale (anywhere):    http://${tailscaleHost}:${port}`);
  }

  if (serveUrl) {
    lines.push(`Install on iPhone from:      ${serveUrl}  (HTTPS via tailscale serve)`);
  }

  return lines;
}

/**
 * Discover addresses and return the ready-to-print banner lines. Never
 * rejects; on any surprise it returns whatever lines it could build.
 *
 * @param {number} port
 * @param {{ interfaces?: Record<string, InterfaceAddress[] | undefined>,
 *           lookupDnsName?: () => Promise<string | null>,
 *           lookupServeUrl?: (port: number) => Promise<string | null> }} [options]
 * @returns {Promise<string[]>}
 */
export async function describePhoneAccessUrls(port, options = {}) {
  try {
    const {
      interfaces,
      lookupDnsName = getTailscaleDnsName,
      lookupServeUrl = getTailscaleServeUrl,
    } = options;
    const addresses = classifyNetworkAddresses(interfaces);

    if (addresses.tailscale.length === 0) {
      return formatPhoneUrlLines(port, addresses);
    }

    const [dnsName, serveUrl] = await Promise.all([
      lookupDnsName(),
      lookupServeUrl(port),
    ]);

    return formatPhoneUrlLines(port, { ...addresses, dnsName, serveUrl });
  } catch {
    return [];
  }
}
