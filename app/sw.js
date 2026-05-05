// RouteReady Driver PWA · service worker
//
// Strategy for v1: app-shell caching only. Network-first for HTML so
// updates land on next load; cache-first for static assets so launches
// are instant. No offline data — RPC calls fall through to the network.
// We'll add background sync + offline reads in a later phase if drivers
// actually need them; for now they're online almost always on the road.
//
// Push: payloadless. The send-driver-push edge function POSTs an empty
// VAPID-signed push when a dispatch→driver message lands. This SW
// receives the push, reads the driver's session token from IndexedDB
// (saved at login via postMessage), calls driver_chat_list to build a
// preview + unread count, then shows a notification + sets the home-
// screen badge (Badging API).

const SHELL_CACHE = "rr-app-shell-v6";
const SHELL_FILES = [
  "./",
  "index.html",
  "styles.css",
  "app.js",
  "manifest.webmanifest",
  "icon.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_FILES)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  // Same-origin static assets: cache-first, network-fallback.
  if (url.origin === location.origin && SHELL_FILES.some((f) => url.pathname.endsWith(f.replace(/^\.\//, "")))) {
    event.respondWith(
      caches.match(req).then((cached) => cached || fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(SHELL_CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      }))
    );
    return;
  }
  // Navigation requests: network-first so updated index.html lands on relaunch.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).catch(() => caches.match("./index.html"))
    );
    return;
  }
  // Everything else: pass-through.
});


// ── IndexedDB helper for the driver session ──
// The main page postMessages the token + Supabase URL/anon key here at
// login so the SW can call driver_chat_list when a push arrives.
const RR_DB = "rr-driver";
const RR_STORE = "kv";

function openRrDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(RR_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(RR_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}
async function rrGet(key) {
  const db = await openRrDb();
  return new Promise((resolve) => {
    const tx = db.transaction(RR_STORE, "readonly");
    const r  = tx.objectStore(RR_STORE).get(key);
    r.onsuccess = () => resolve(r.result ?? null);
    r.onerror   = () => resolve(null);
  });
}
async function rrSet(key, value) {
  const db = await openRrDb();
  return new Promise((resolve) => {
    const tx = db.transaction(RR_STORE, "readwrite");
    tx.objectStore(RR_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror    = () => resolve();
  });
}

self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type === "rr:set-session") {
    event.waitUntil(Promise.all([
      rrSet("token",        data.token        ?? null),
      rrSet("supabaseUrl",  data.supabaseUrl  ?? null),
      rrSet("anonKey",      data.anonKey      ?? null),
    ]));
  } else if (data.type === "rr:clear-session") {
    event.waitUntil(Promise.all([
      rrSet("token", null),
      // Keep supabaseUrl/anonKey — they're public and useful next login.
    ]));
    if ("clearAppBadge" in self.navigator) {
      self.navigator.clearAppBadge().catch(() => {});
    }
  }
});


// ── Push handler ──
// Edge function (send-driver-push) encrypts the payload per RFC 8291, so
// we read title/body/unread/url straight from event.data — no SW-side
// fetch, no IDB lookup. iOS only reliably renders notifications when the
// payload is encrypted, so this is the path that actually works on a PWA.
self.addEventListener("push", (event) => {
  let payload = {
    title:  "Dispatch",
    body:   "New message from dispatch",
    unread: 1,
    url:    "/app/#/chat",
  };
  if (event.data) {
    try {
      const incoming = event.data.json();
      if (incoming && typeof incoming === "object") payload = { ...payload, ...incoming };
    } catch {
      try { payload.body = event.data.text() || payload.body; } catch {}
    }
  }

  const tasks = [
    self.registration.showNotification(payload.title || "Dispatch", {
      body:     payload.body || "",
      icon:     "icon.svg",
      badge:    "icon.svg",
      tag:      "dispatch-message",
      renotify: true,
      data:     { url: payload.url || "/app/#/chat" },
    }),
  ];
  if ("setAppBadge" in self.navigator && Number(payload.unread) > 0) {
    tasks.push(self.navigator.setAppBadge(Number(payload.unread)).catch(() => {}));
  }
  event.waitUntil(Promise.all(tasks));
});


self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "./";
  event.waitUntil(
    self.clients.matchAll({ type: "window" }).then((wins) => {
      const w = wins.find((c) => c.url.includes("/app/"));
      if (w) { w.focus(); if (url) w.navigate(url).catch(() => {}); return; }
      self.clients.openWindow(url);
    })
  );
});
