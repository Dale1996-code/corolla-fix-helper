// Service worker for the installed (Home Screen) app.
//
// Deliberately minimal: repair data must never be stale, so nothing dynamic is
// ever cached. The only cached responses are the offline fallback page and the
// icons it shows. Strategy per request:
//
//   - /api/*      : never intercepted — always the real network, real errors.
//   - navigations : network first; if the server is unreachable, show the
//                   precached offline page instead of the browser error.
//   - other GETs  : network only.
//
// Bump OFFLINE_CACHE when the precached files change so old caches are
// replaced on the next activate.

const OFFLINE_CACHE = "corolla-offline-v1";
const OFFLINE_URL = "/offline.html";
const PRECACHE_URLS = [OFFLINE_URL, "/icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(OFFLINE_CACHE)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((key) => key !== OFFLINE_CACHE).map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  if (url.pathname.startsWith("/api/")) {
    return;
  }

  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request).catch(() => caches.match(OFFLINE_URL))
    );
    return;
  }

  // Everything else falls through to the network untouched.
});
