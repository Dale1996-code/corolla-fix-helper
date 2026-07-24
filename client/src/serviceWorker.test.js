import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

const serviceWorkerSource = fs.readFileSync(
  path.join(process.cwd(), "public", "sw.js"),
  "utf8"
);

function loadServiceWorker({ cachedResponse = { source: "cache" } } = {}) {
  const listeners = {};
  const fetchImpl = vi.fn(() => Promise.reject(new Error("offline")));
  const cacheMatch = vi.fn(() => Promise.resolve(cachedResponse));
  const cacheAddAll = vi.fn(() => Promise.resolve());
  const cacheOpen = vi.fn(() => Promise.resolve({ addAll: cacheAddAll }));

  const worker = {
    addEventListener(type, listener) {
      listeners[type] = listener;
    },
    clients: { claim: vi.fn() },
    location: { origin: "https://corolla.test" },
    skipWaiting: vi.fn(),
  };

  vm.runInNewContext(serviceWorkerSource, {
    URL,
    caches: {
      delete: vi.fn(),
      keys: vi.fn(() => Promise.resolve([])),
      match: cacheMatch,
      open: cacheOpen,
    },
    fetch: fetchImpl,
    Promise,
    self: worker,
  });

  return { cacheAddAll, cacheMatch, cacheOpen, fetchImpl, listeners };
}

function dispatchFetch(listener, path, overrides = {}) {
  let responsePromise;
  const request = {
    method: "GET",
    mode: "no-cors",
    url: `https://corolla.test${path}`,
    ...overrides,
  };

  listener({
    request,
    respondWith(promise) {
      responsePromise = promise;
    },
  });

  return { request, responsePromise };
}

describe("service worker cache and fetch behavior", () => {
  it("precaches only the offline page and its icon", async () => {
    const { cacheAddAll, cacheOpen, listeners } = loadServiceWorker();
    let installPromise;

    listeners.install({
      waitUntil(promise) {
        installPromise = promise;
      },
    });
    await installPromise;

    expect(cacheOpen).toHaveBeenCalledWith("corolla-offline-v1");
    expect(cacheAddAll).toHaveBeenCalledWith(["/offline.html", "/icon.svg"]);
  });

  it.each(["/offline.html", "/icon.svg"])(
    "serves the precached %s asset from the cache",
    async (path) => {
      const { cacheMatch, fetchImpl, listeners } = loadServiceWorker();
      const { request, responsePromise } = dispatchFetch(listeners.fetch, path);

      await expect(responsePromise).resolves.toEqual({ source: "cache" });
      expect(cacheMatch).toHaveBeenCalledWith(request);
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  );

  it("leaves API and repair-data requests completely network-only", () => {
    const { cacheMatch, fetchImpl, listeners } = loadServiceWorker();
    const apiRoot = dispatchFetch(listeners.fetch, "/api", { mode: "navigate" });
    const apiRoute = dispatchFetch(listeners.fetch, "/api/repair-checklists");
    const pageData = dispatchFetch(listeners.fetch, "/repair-checklists/data.json");

    expect(apiRoot.responsePromise).toBeUndefined();
    expect(apiRoute.responsePromise).toBeUndefined();
    expect(pageData.responsePromise).toBeUndefined();
    expect(cacheMatch).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
