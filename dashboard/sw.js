// RouteReady Dispatch · dashboard service worker
//
// Scope: /dashboard/ (lives next to index.html so the default scope
// is the dashboard tree only — the driver PWA at /app/ owns its
// own SW under its own scope).
//
// Strategy:
//   • Navigation requests           → network-first, fall back to
//     cached index.html so the dashboard still launches offline.
//   • Code assets (.js / .mjs / .css) → NETWORK-FIRST. A stale JS
//     bundle is the difference between "operator sees the bug fix
//     I shipped 10 minutes ago" and "operator screenshots the same
//     broken state and asks why nothing changed." Worth the small
//     extra round-trip to never serve stale code.
//   • Other dashboard assets (images, fonts) → stale-while-revalidate.
//     Fast launch, updates in background. Safe because asset content
//     doesn't drive behavior — only its display.
//   • Everything else (Supabase RPC, edge functions, external CDNs)
//     → pass-through. No offline data; live state needs the network.
//
// Bump SHELL_CACHE when the cached file set changes so the activate
// step purges the old cache.

const SHELL_CACHE = "rr-dash-shell-v4";

// Files that make the dashboard boot. index.html is the heaviest —
// once it's in the cache, an offline relaunch can still render the
// chrome and tell the operator they're disconnected.
const SHELL_FILES = [
  "./",
  "index.html",
  "tcp.css",
  "schedule-rrx.css",
  "onboarding-rrx.css",
  "manifest.webmanifest",
  "/app/Icon.png",
  "/app/icon.svg",
  "/app/rr-system.css",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_FILES).catch(() => {}))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // Navigation requests (the dashboard HTML shell): network-first,
  // fall back to the cached index.html on failure so an offline
  // launch still loads chrome.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then((c) => c.put("index.html", copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match("index.html").then((r) => r || caches.match("./"))),
    );
    return;
  }

  // Skip cross-origin requests entirely — the SW must not interfere
  // with Supabase RPC, edge function calls, or any third-party API.
  if (url.origin !== location.origin) return;

  const isDashboardAsset =
    url.pathname.startsWith("/dashboard/") || url.pathname.startsWith("/app/");
  if (!isDashboardAsset) return;

  // Code assets: network-first. A stale JS/CSS bundle defeats the
  // entire purpose of deploys — operators saw "ran Smart Fill, no
  // changes" for hours because the SW kept serving the previous
  // bundle. Network-first guarantees a fresh deploy reaches every
  // refresh, period. Falls back to cache when offline.
  const isCode = /\.(?:js|mjs|css)(?:\?|$)/.test(url.pathname + url.search);
  if (isCode) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.status === 200 && res.type !== "opaque") {
            const copy = res.clone();
            caches.open(SHELL_CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match(req)),
    );
    return;
  }

  // Non-code dashboard assets (images, fonts, manifest): stale-
  // while-revalidate. Fast launch, updates in background. Safe
  // because asset content doesn't drive behavior.
  event.respondWith(
    caches.open(SHELL_CACHE).then((cache) =>
      cache.match(req).then((cached) => {
        const networked = fetch(req)
          .then((res) => {
            if (res && res.status === 200 && res.type !== "opaque") {
              cache.put(req, res.clone()).catch(() => {});
            }
            return res;
          })
          .catch(() => cached);
        return cached || networked;
      }),
    ),
  );
});

// Allow the page to ask the SW to update itself (used when the
// dispatcher clicks the topbar refresh button).
self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type === "rr:skip-waiting") self.skipWaiting();
});
