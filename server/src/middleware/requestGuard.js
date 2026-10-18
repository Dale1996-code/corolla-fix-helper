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
//
// Cross-site requests (2A-02). CORS cannot stop a write. A multipart upload, a
// body-less POST, or an <img src> GET is a "simple" request that the browser
// sends without asking first; CORS only decides whether the page may read the
// reply, and by then the PDF is planted. So every write under /api, and the
// GETs that do work rather than just read, must come from the app's own pages
// (see isSameOriginRequest).

import os from "node:os";
import { config } from "../config.js";
import {
  classifyNetworkAddresses,
  getTailscaleDnsName,
} from "../services/networkAddresses.js";
import { isLoopbackHostname, parseHostname } from "../utils/http.js";

// The most request body a refusal reads and throws away before answering. Node
// closes the connection after replying to a request whose body is still
// arriving, and the client then sees ECONNRESET instead of the reason, so a
// refused upload is drained first. The cap is the largest upload the app
// accepts anyway; past it the reply goes out at once and the connection closes.
const uploadLimitMb = Number.isFinite(config.maxUploadSizeMb) && config.maxUploadSizeMb > 0
  ? config.maxUploadSizeMb
  : 20;
const REFUSED_BODY_DISCARD_LIMIT_BYTES = uploadLimitMb * 1024 * 1024;

/** True when the request carries a body (Content-Length above 0, or chunked). */
function hasRequestBody(request) {
  if (request.headers["transfer-encoding"] !== undefined) {
    return true;
  }

  const length = Number(request.headers["content-length"]);
  return Number.isFinite(length) && length > 0;
}

/**
 * Answer a refused request with `{ error }` JSON in a way the client can read,
 * even mid-upload: any body still arriving is read and discarded first.
 */
function refuse(request, response, status, error) {
  let answered = false;
  const answer = () => {
    if (!answered && !response.headersSent) {
      answered = true;
      response.status(status).json({ error });
    }
  };

  if (!hasRequestBody(request) || request.complete) {
    answer();
    return;
  }

  const closeAndAnswer = () => {
    response.setHeader("Connection", "close");
    answer();
  };

  if (Number(request.headers["content-length"]) > REFUSED_BODY_DISCARD_LIMIT_BYTES) {
    closeAndAnswer();
    return;
  }

  let discarded = 0;
  request.on("data", (chunk) => {
    discarded += chunk.length;

    if (discarded > REFUSED_BODY_DISCARD_LIMIT_BYTES) {
      closeAndAnswer();
    }
  });
  request.once("end", answer);
  request.once("close", answer);
  request.resume();
}

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

    refuse(request, response, 421, misdirectedRequestMessage(hostname));
  };
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
// `none` is a request the person started themselves: a typed URL or bookmark.
const OWN_PAGE_FETCH_SITES = new Set(["same-origin", "none"]);

/**
 * True when `originHeader` is exactly the origin the request was sent to.
 * The Host header is read with the Origin's own scheme so default ports
 * compare equal (`https://my-pc.ts.net` and `Host: my-pc.ts.net`), while any
 * other port difference does not (`http://localhost:3000` vs `localhost:4000`).
 * `Origin: null` is never a match.
 */
function originMatchesHost(originHeader, hostHeader) {
  if (typeof hostHeader !== "string") {
    return false;
  }

  try {
    const origin = new URL(originHeader);

    if (origin.protocol !== "http:" && origin.protocol !== "https:") {
      return false;
    }

    return new URL(`${origin.protocol}//${hostHeader}`).host === origin.host;
  } catch {
    return false;
  }
}

/**
 * Whether a request came from one of this app's own pages, in this order:
 *
 *   1. `Sec-Fetch-Site`, when present, decides: only `same-origin` or `none`.
 *      Every current browser sends it and a page can neither set nor remove
 *      it, so a `same-site` page on another localhost port is refused too.
 *   2. Otherwise `Origin` must be exactly this request's own origin, port
 *      included. That covers browsers older than Fetch Metadata (Safari before
 *      16.4), which still attach Origin to every write.
 *   3. Neither header: not a browser. Browsers attach Origin to every POST,
 *      PUT, PATCH and DELETE, so a write without one is curl, a script, or the
 *      smoke test, and no web page can make one. The one remaining gap is a
 *      cross-site GET from a browser too old for Fetch Metadata, which sends
 *      neither header; only the two side-effect GETs care, and only on such a
 *      browser.
 *
 * The Host guard has already run, so the Host compared here is allow-listed.
 *
 * @param {import("express").Request} request
 */
export function isSameOriginRequest(request) {
  const fetchSite = request.headers["sec-fetch-site"];

  if (typeof fetchSite === "string") {
    return OWN_PAGE_FETCH_SITES.has(fetchSite.trim().toLowerCase());
  }

  const origin = request.headers.origin;

  if (typeof origin === "string") {
    return originMatchesHost(origin, request.headers.host);
  }

  return true;
}

function refuseCrossSite(request, response) {
  refuse(
    request,
    response,
    403,
    "Refused: this request came from a page on another site. Open Corolla Fix " +
      "Helper at its own address and try again."
  );
}

/**
 * Mounted on `/api`: refuse any write (anything but GET, HEAD, OPTIONS) that
 * did not come from the app's own pages.
 *
 * @param {import("express").Request} request
 * @param {import("express").Response} response
 * @param {import("express").NextFunction} next
 */
export function requireSameOriginWrite(request, response, next) {
  if (SAFE_METHODS.has(request.method) || isSameOriginRequest(request)) {
    next();
    return;
  }

  refuseCrossSite(request, response);
}

/**
 * The same rule for a GET route that does work rather than only reading
 * (backup export staging, paid procedure suggestions), which a cross-site
 * <img src> could otherwise trigger.
 *
 * @param {import("express").Request} request
 * @param {import("express").Response} response
 * @param {import("express").NextFunction} next
 */
export function requireSameOriginRequest(request, response, next) {
  if (isSameOriginRequest(request)) {
    next();
    return;
  }

  refuseCrossSite(request, response);
}
