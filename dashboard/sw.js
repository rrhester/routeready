// RouteReady Dispatch · dashboard service worker
//
// ── RECOVERY MODE ────────────────────────────────────────────────
// A prior caching strategy poisoned some operators' browsers with a
// stale MIX of assets across rapid deploys — e.g. fresh index.html
// paired with a stale schedule-rrx.css — which rendered the schedule
// command strip in a scrambled order even though `main` was correct.
// Reloading didn't dislodge it because the controlling worker kept
// serving cached copies.
//
// This worker fixes that by caching NOTHING and PURGING every
// existing cache the moment it activates. All requests then go
// straight to the network, governed only by the normal HTTP cache
// headers in netlify.toml (HTML = no-cache; JS/CSS = ?v= versioned
// per deploy). That guarantees a clean, internally-consistent asset
// set on every load and lets a stuck browser self-heal — no DevTools
// "Unregister", no incognito required.
//
// Offline shell support is intentionally dropped while we recover;
// it can be reintroduced later behind a fresh, well-tested cache.

self.addEventListener("install", () => {
  // Take over as soon as possible so the purge runs without waiting
  // for every dashboard tab to close.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// No fetch handler that responds from cache. Without respondWith the
// browser performs its default network fetch, so nothing is served
// from a Service-Worker cache. (We don't register a fetch listener at
// all — pure pass-through.)

self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type === "rr:skip-waiting") self.skipWaiting();
});
