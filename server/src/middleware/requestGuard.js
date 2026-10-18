// The request gate of a no-login, local-first app.
//
// Corolla Fix Helper has no login on purpose. What stops a web page the owner
// happens to have open in the same browser from driving the API is a set of
// checks on the request itself, kept together in this module.
//
// Host allow-list (2A-03). A request must be addressed to a name this machine
// answers to. Without the check, DNS rebinding works: an attacker's page at
// `rebind.example` re-points its own DNS name at 127.0.0.1, and the browser
// then treats this app as same-origin with the attacker's page, so no
// cross-origin rule applies. The Host header is the one thing that still names
// the attacker's domain, so anything not on the list gets 421 before any route
// runs. Names are matched by hostname only, never by port: the Vite dev proxy
// (`localhost:5173`), `npm start` (`:4000`), and `tailscale serve` (`:443`)
// all reach the same app.
//
// Accepted names:
//   - always: localhost, 127.0.0.1, [::1];
//   - with NETWORK_MODE=1 only: this machine's LAN and Tailscale addresses
//     (from services/networkAddresses.js, re-read when a name misses so a new
//     DHCP lease works), its Tailscale MagicDNS name (the name `tailscale serve`
//     passes through as the Host), and the names in ALLOWED_HOSTS.
//
// NETWORK_MODE=0 accepts the loopback names only, ALLOWED_HOSTS included:
// "localhost only" stays true even with a local proxy such as `tailscale
// serve` forwarding traffic from other devices to 127.0.0.1.

import os from "node:os";
import {
  classifyNetworkAddresses,
  getTailscaleDnsName,
} from "../services/networkAddresses.js";
import { isLoopbackHostname, parseHostname } from "../utils/http.js";

// How often a Host miss may re-run the tailscale CLI to refresh the MagicDNS
// name. A miss is usually a stranger's name, so this bounds subprocess spawns
// to one a minute however many bad requests arrive.
const MAGIC_DNS_LOOKUP_INTERVAL_MS = 60_000;

/**
 * Normalize one ALLOWED_HOSTS entry to a bare hostname. Entries are forgiving
 * about format (`garage-pc.local`, `Garage-PC.local:4000`, or a pasted URL such
 * as `http://garage-pc.local:4000/`), because only the hostname is compared.
 *
 * @param {string} entry
 * @returns {string | null}
 */
export function normalizeAllowedHost(entry) {
  const trimmed = String(entry).trim();

  if (trimmed.includes("://")) {
    try {
      return parseHostname(new URL(trimmed).host);
    } catch {
      return null;
    }
  }

  return parseHostname(trimmed);
}

/**
 * @typedef {object} HostAllowList
 * @property {(hostname: string | null) => Promise<boolean>} allows
 */

/**
 * Build the set of Host names this app answers to.
 *
 * Every dependency is injectable so tests can stand in for a laptop's
 * interfaces and the tailscale CLI without touching either.
 *
 * @param {object} [options]
 * @param {boolean} [options.networkMode] NETWORK_MODE=1
 * @param {string[]} [options.allowedHosts] raw ALLOWED_HOSTS entries
 * @param {() => Record<string, import("../services/networkAddresses.js").InterfaceAddress[] | undefined>} [options.readInterfaces]
 * @param {() => Promise<string | null>} [options.lookupDnsName]
 * @param {number} [options.lookupIntervalMs]
 * @param {() => number} [options.now]
 * @returns {HostAllowList}
 */
export function createHostAllowList({
  networkMode = false,
  allowedHosts = [],
  readInterfaces = () => os.networkInterfaces(),
  lookupDnsName = getTailscaleDnsName,
  lookupIntervalMs = MAGIC_DNS_LOOKUP_INTERVAL_MS,
  now = () => Date.now(),
} = {}) {
  const configuredHosts = new Set(
    networkMode ? allowedHosts.map(normalizeAllowedHost).filter(Boolean) : []
  );
  /** @type {string | null} */
  let magicDnsName = null;
  let lastLookupAt = -Infinity;
  /** @type {Promise<void> | null} */
  let pendingLookup = null;

  function readThisMachine() {
    try {
      const { lan, tailscale } = classifyNetworkAddresses(readInterfaces());
      return { addresses: new Set([...lan, ...tailscale]), hasTailscale: tailscale.length > 0 };
    } catch {
      return { addresses: new Set(), hasTailscale: false };
    }
  }

  function startMagicDnsLookup() {
    lastLookupAt = now();
    pendingLookup = Promise.resolve()
      .then(() => lookupDnsName())
      .then(
        (name) => {
          magicDnsName = parseHostname(name);
        },
        () => {}
      )
      .finally(() => {
        pendingLookup = null;
      });
  }

  // Like the startup banner, only consult the CLI when a Tailscale interface
  // exists. Warming the name now means the phone's first page load through
  // `tailscale serve` does not wait on the CLI.
  if (networkMode && readThisMachine().hasTailscale) {
    startMagicDnsLookup();
  }

  return {
    async allows(hostname) {
      if (!hostname) {
        return false;
      }

      if (isLoopbackHostname(hostname)) {
        return true;
      }

      if (!networkMode) {
        return false;
      }

      if (configuredHosts.has(hostname) || hostname === magicDnsName) {
        return true;
      }

      const { addresses, hasTailscale } = readThisMachine();

      if (addresses.has(hostname)) {
        return true;
      }

      if (!hasTailscale) {
        return false;
      }

      if (!pendingLookup && now() - lastLookupAt >= lookupIntervalMs) {
        startMagicDnsLookup();
      }

      // Parallel requests on a first page load share the one lookup instead of
      // being refused while it runs.
      if (pendingLookup) {
        await pendingLookup;
      }

      return hostname === magicDnsName;
    },
  };
}

function misdirectedRequestMessage(hostname) {
  const named = hostname
    ? `This server does not answer to "${hostname}".`
    : "This request did not name a host this server answers to.";

  return (
    `${named} It accepts localhost and 127.0.0.1, and with NETWORK_MODE=1 also this ` +
    "computer's Wi-Fi and Tailscale addresses. To use another name for this computer, " +
    "add it to ALLOWED_HOSTS (NETWORK_MODE=1 only) and restart the server."
  );
}

/**
 * Refuse, with 421 Misdirected Request, any request whose Host is not on the
 * allow-list. Mounted ahead of every route, the built frontend included.
 *
 * @param {HostAllowList} allowList
 * @returns {import("express").RequestHandler}
 */
export function createHostGuard(allowList) {
  return async function hostGuard(request, response, next) {
    const hostname = parseHostname(request.headers.host);

    if (await allowList.allows(hostname)) {
      next();
      return;
    }

    response.status(421).json({ error: misdirectedRequestMessage(hostname) });
  };
}
