// RouteReady Dispatch · dashboard service worker
//
// ── RECOVERY MODE + FORCED REFRESH ───────────────────────────────
// A prior caching strategy poisoned some operators' browsers with a
// stale MIX of assets across rapid deploys. This worker caches NOTHING
// and PURGES every existing cache the moment it activates, so all
// requests go straight to the network (governed only by the HTTP cache
// headers in _headers — HTML = no-cache; JS/CSS = ?v= versioned).
//
// NEW (forced refresh): on activate we ALSO navigate every open window
// to a fresh copy. An INSTALLED app that's resumed (not cold-launched)
// can sit on a stale shell indefinitely — the no-cache headers never
// get a chance to run because the shell is never re-requested. By
// reloading controlled clients the moment a new worker takes over, a
// deploy reaches even a pinned installed app: the browser fetches the
// new sw.js on launch, this worker activates, wipes caches, and
// navigates the window to the current shell. No DevTools, no incognito,
// no "clear site data" required.
//
// Re-navigation only fires when a NEW worker activates (i.e. when this
// file's bytes change on a deploy), so it cannot loop: the reloaded
// page registers the same worker, finds no update, and nothing else
// fires.

// ── Deploy nonce ─────────────────────────────────────────────────
// Bump this on any CSS/HTML-only deploy that must reach pinned/installed
// apps. sw.js byte-changes are the ONLY trigger for the forced refresh
// below (new worker → activate → purge caches → navigate windows to the
// fresh shell), so a recolor that never touches sw.js can sit invisible
// on a resumed installed app. Bumping forces every open window to the
// current shell on next launch.
//   2026-06-27.08 · App-launcher dots → solid #FFC000 (was multi-tone).
const SW_DEPLOY_NONCE = "2026-06-27.08";

self.addEventListener("install", () => {
  // Take over as soon as possible so the purge + refresh run without
  // waiting for every dashboard tab to close.
  try { console.log("[rr-sw] installing build", SW_DEPLOY_NONCE); } catch (e) {}
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
      .then(() => self.clients.matchAll({ type: "window", includeUncontrolled: true }))
      .then((clients) => {
        clients.forEach((client) => {
          // Reload each open window to the fresh shell. Best-effort —
          // one client that refuses to navigate can't abort the rest.
          try { client.navigate(client.url); } catch (e) { /* ignore */ }
        });
      }),
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
