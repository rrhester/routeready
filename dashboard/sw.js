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

//   Per-deploy nonce history (200+ dated entries) was trimmed 2026-07-18
//   (project-review PR#28): this file is served no-cache on every dashboard
//   navigation, and the changelog added ~100 KB to each fetch while serving
//   no runtime purpose. The change history now lives in git log / PRs. When
//   you bump the nonce below, describe the deploy in the commit message, not
//   here.

const SW_DEPLOY_NONCE = "2026-07-19.21";

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

// ── Web Push (staff) ─────────────────────────────────────────────────────
// Rings a dispatcher whose dashboard is CLOSED for a driver's direct call
// (send-staff-push encrypts the payload per RFC 8291). Tapping deep-links to
// /dashboard/?rrcall=1&… where live.js auto-answers (mints a room, accepts,
// opens it). Mirrors the driver SW push handler.
self.addEventListener("push", (event) => {
  let payload = { title: "RouteReady", body: "", url: "/dashboard/", type: "message" };
  if (event.data) {
    try {
      const incoming = event.data.json();
      if (incoming && typeof incoming === "object") payload = { ...payload, ...incoming };
    } catch {
      try { payload.body = event.data.text() || payload.body; } catch {}
    }
  }
  const show = () => self.registration.showNotification(
    payload.title || "RouteReady",
    { body: payload.body || "", data: { url: payload.url || "/dashboard/" } },
  ).catch(() => {});
  // A call push doubles as the closed-dashboard ring — if any dashboard
  // window is still alive it already rings in-app, so suppress the dup.
  const notify = payload.type === "call"
    ? self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
        const alive = wins.some((c) => (c.url || "").includes("/dashboard/"));
        return alive ? undefined : show();
      }).catch(() => show())
    : show();
  event.waitUntil(notify);
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/dashboard/";
  event.waitUntil(
    self.clients.matchAll({ type: "window" }).then((wins) => {
      const w = wins.find((c) => (c.url || "").includes("/dashboard/"));
      if (w) { w.focus(); if (url) w.navigate(url).catch(() => {}); return; }
      return self.clients.openWindow(url);
    }),
  );
});
