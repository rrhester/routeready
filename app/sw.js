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

const SHELL_CACHE = "rr-app-shell-v119";
const SHELL_FILES = [
  "./",
  "index.html",
  "styles.css",
  "app.js",
  "manifest.webmanifest",
  "icon.svg",
  "Icon.png",
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
  // Same-origin static assets: NETWORK-FIRST.  Cache-first held
  // users on a stale app.js even after we bumped ?v= because iOS
  // PWA SW updates are unreliable.  Network-first means every
  // reload tries fresh; the cache fallback keeps offline launches
  // working.
  if (url.origin === location.origin && SHELL_FILES.some((f) => url.pathname.endsWith(f.replace(/^\.\//, "")))) {
    event.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(SHELL_CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      }).catch(() => caches.match(req))
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
  } else if (data.type === "rr:clear-badge") {
    event.waitUntil(clearBadgeAndNotifications(data.source));
  }
});

// On iOS the home-screen badge often won't drop while there are still
// pending notifications in Notification Center for the PWA. Close them
// all out, clear the Badging API count, and ack to the server so we can
// confirm the SW handler actually fired.
async function clearBadgeAndNotifications(source) {
  let closed = 0;
  try {
    const ns = await self.registration.getNotifications();
    for (const n of ns) { try { n.close(); closed++; } catch {} }
  } catch {}
  if ("clearAppBadge" in self.navigator) {
    try { await self.navigator.clearAppBadge(); } catch {}
  }
  ackPush({ stage: "clear-badge", source: source || null, closed });
}


// ── Push handler ──
// Edge function (send-driver-push) encrypts the payload per RFC 8291, so
// we read title/body/unread/url straight from event.data — no SW-side
// fetch, no IDB lookup. iOS only reliably renders notifications when the
// payload is encrypted, so this is the path that actually works on a PWA.
//
// We also POST a one-line ack back to the edge function. iOS silently
// drops a notification if `showNotification` rejects an option (icon
// format, tag/renotify combo, etc.) — server logs prove whether the SW
// actually fired so we can tell "push didn't arrive at device" from
// "push arrived but iOS refused to render."
self.addEventListener("push", (event) => {
  let payload = {
    title:  "Dispatch",
    body:   "New message from dispatch",
    unread: 1,
    url:    "/app/#/chat",
  };
  let parseError = null;
  if (event.data) {
    try {
      const incoming = event.data.json();
      if (incoming && typeof incoming === "object") payload = { ...payload, ...incoming };
    } catch (err) {
      parseError = String(err);
      try { payload.body = event.data.text() || payload.body; } catch {}
    }
  }

  // Bare-minimum showNotification — no icon, no badge, no tag, no
  // renotify. Apple WebKit silently rejects the entire notification if
  // any option fails validation (SVG icon, etc.), so we keep it to the
  // two fields every browser supports.
  const notify = self.registration.showNotification(
    payload.title || "Dispatch",
    {
      body: payload.body || "",
      data: { url: payload.url || "/app/#/chat" },
    },
  ).catch((err) => ackPush({ stage: "showNotification", error: String(err) }));

  const tasks = [notify, ackPush({ stage: "received", parseError, hasData: !!event.data })];
  if ("setAppBadge" in self.navigator) {
    const n = Number(payload.unread) > 0 ? Number(payload.unread) : 1;
    tasks.push(self.navigator.setAppBadge(n).catch(() => {}));
  }
  event.waitUntil(Promise.all(tasks));
});

// Diagnostic beacon — POSTs to send-driver-push with `ack:true` so the
// edge function logs "push arrived at device". Uses the anon key stored
// at login to satisfy Supabase's JWT gateway; the function then
// short-circuits on `ack` before doing any work.
async function ackPush(info) {
  try {
    const [url, anon] = await Promise.all([rrGet("supabaseUrl"), rrGet("anonKey")]);
    if (!url || !anon) return;
    await fetch(url + "/functions/v1/send-driver-push", {
      method:  "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": "Bearer " + anon,
        "apikey":        anon,
      },
      body:    JSON.stringify({ ack: true, info, ts: new Date().toISOString() }),
      keepalive: true,
    });
  } catch {}
}


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
