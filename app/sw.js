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

// v131 · Document scanner gains optional on-device OCR ("Make
// searchable"): Tesseract.js is lazy-loaded on first use and the PDF is
// built with an invisible text layer over each page, so scans become
// searchable / selectable. Runs entirely on the phone; degrades to a
// normal PDF if the engine can't load. Bumped so installed driver PWAs
// purge the old shell and pick up the new app.js.
//
// v133 · Receipt Intake: after scanning, "What are you uploading?" is now a
// mandatory step (the direct "Send to dispatch" / "Save or share PDF" bypass
// buttons are gone), and the full Receipt submission flow ships. Bumped so
// installed driver PWAs purge the old shell and pick up the new app.js + CSS.
//
// v134 · Receipt OCR confidence: the on-device OCR's confidence score now
// rides along with receipt submissions (receipt_uploads.ocr_confidence was
// always null). Bumped so installed driver PWAs pick up the new app.js.
//
// v135 · Form photos: on submit, the app now also uploads a small ~480px
// thumbnail alongside the full image and records its path (answers[fid].thumb),
// so photo-heavy dispatcher reports load light thumbnails instead of full
// shots. Best-effort — a failed thumb just falls back to the full image.
// Covers both the online and offline (queued) submission paths. Bumped so
// installed driver PWAs pick up the new app.js.
//
// v136 · Professional-polish pass #1: real icon set (192/512 + maskable +
// apple-touch + favicon) and iOS splash screens; font preload; warn/offline
// surfaces moved to --amber-dark for AA contrast; toast() understands
// "success"/"info"; raw RPC error text routed through _friendlyError on a
// dozen surfaces; Tasks hub shows an error state instead of a false
// "Nothing to do" when its fetches fail; boot guard renders a readable
// retry screen if config.js fails to load. Bumped so installed driver PWAs
// purge the old shell and pick up the new app.js + CSS + index.html.
//
// v137 · Offline shell actually works cold: supabase-js is vendored
// same-origin (the esm.sh import was an uncacheable cross-origin module
// that killed offline boot), the precache now covers everything the shell
// really loads (rr-system.css, form-validation.js, the Inter font,
// dashboard/config.js, the vendored client), cache fallbacks match with
// ignoreSearch so ?v=-stamped requests hit the unversioned precache, and
// the fetch matcher is an exact-path allowlist (the old endsWith("") check
// matched every same-origin GET). Bumped so installed driver PWAs purge
// the old shell and pick up the new app.js + sw.js.
// v138 · Ink chrome: the header and home hero move from wall-to-wall
// brand blue to the deep navy of the app icon tile (--rr-ink-800/900);
// blue is demoted to the accent (CTAs, active states, avatar, check-in
// card) so actions pop against the chrome. theme-color follows. Bumped
// so installed driver PWAs pick up the new CSS + index.html.
// v139 · Component discipline: the seven status-chip families share one
// anatomy (999px pill, weight 700, 11px token size), micro-labels get a
// 10px floor (shift-card meta, date blocks, tab badge), and tab labels
// step up to 11px/600. Bumped so installed driver PWAs pick up the CSS.
// v140 · Chat navigation joins the hash router: /chat, /chat/channels,
// /chat/channel?id=… — hardware Back pops thread → list → out instead of
// exiting Chat, channels are deep-linkable, and the header back arrow is
// route-driven. Bumped so installed driver PWAs pick up the new app.js.
// v141 · Tab bar reaches the physical bottom edge: #app/html/body were
// inset-pinned AND explicitly heighted, which over-constrains the box
// (CSS drops the bottom pin) — any dvh shortfall vs the real viewport
// left a dead strip under the tab bar. Now edge-pinned with no height.
// v142 · Denser tab bar: 58px band (was 68) and the bar now reserves
// max(inset - 14px, 0) of the iPhone home-indicator zone instead of the
// full ~34px — the labels sit visibly lower, killing the dead-space read.
// Bar, main scroller, chat shell, and toast all share the new token.
// v143 · The zone iOS paints below the page (Safari bottom-toolbar strip,
// any viewport shortfall) now blends into the white tab bar instead of
// showing the gray canvas — the bar reads as running to the screen edge.
// v144 · Settings gains a quiet support footer: deploy build id (the ?v=
// token app.js loaded with), installed-app vs browser-tab, and live
// viewport/safe-area numbers — so a screenshot answers which build a
// phone is on and who owns any dead space at the screen edges.
// v145 · Viewport-shortfall diagnosis: the installed app on Dynamic
// Island iPhones gets a viewport one status-bar (59pt) shorter than the
// screen (WebKit standalone bug) — iOS paints the manifest
// background_color into the uncovered strip. Manifest background goes
// white so the strip blends with the tab bar, Settings gains frame/
// inset-top numbers plus two corner probes that tell the two bug
// variants apart from a single screenshot.
// v146 · The real dead-strip fix: iOS status-bar mode goes translucent ->
// default. Translucent triggers the WebKit standalone bug (web view at
// y=0 sized one status-bar short — probe-verified: the strip under the
// tab bar is unpaintable OS territory). Default mode aligns position
// with size, so the app runs flush to the physical bottom and iOS
// paints the status bar ink from theme-color. Applies on reinstall
// (Add to Home Screen). Diagnostic probes removed; footer stays.
// v147 · Real-time message delivery: the driver app now subscribes to the
// per-driver realtime bus (rr-driver-live-<id>) app-wide, and the server
// broadcasts a ping on every dispatch chat / channel message (migration
// 0467) — so messages and the unread badge update instantly in-app instead
// of on the 10–30s poll. Bumped so installed driver PWAs pick up the new
// app.js.
// v149 · Voice messages made obvious: the round composer button now doubles
// as a mic when the message box is empty (WhatsApp-style) — one tap records,
// a big Recording bar with a live timer + one-tap Send/Cancel; typing turns
// it back into the send arrow. Bumped so installed driver PWAs pick up the
// new app.js + CSS.
// v152 · State-treatment consistency: the Team screen and the three chat
// surfaces (messages, channels, channel thread) drop their bespoke empty/
// error markup for the shared errorStateHtml + .rr-empty pattern, so every
// "couldn't load" state carries the same alert icon + friendly-error text as
// the rest of the app. Bumped so installed driver PWAs pick up the new
// app.js + CSS.
// v153 · Component discipline: the attendance record's four ad-hoc inline
// stat tiles (Points / Callouts / No-shows / Tardies) become a shared
// .stat-tiles / .stat-tile primitive on the token scale (radius --r-lg,
// value --fs-lg, label --fs-xs, tabular figures) — off-scale 10px/18px/10px
// one-offs retired. Bumped so installed driver PWAs pick up the new CSS.
// v154 · Live "recording audio…" indicator: when either side records a voice
// note, the other sees "recording audio…" in place of "typing…" (reuses the
// presence broadcast). Bumped so installed driver PWAs pick up the new app.js.
// v155 · Home resilience: the home screen's "Up next" section no longer
// vanishes silently when its fetch fails on a flaky signal — a genuine load
// error now renders a calm, labeled, retryable card (shared compact
// home-section state card) so a driver can tell "no upcoming shift" from
// "couldn't load it". Intentional hide-when-empty is preserved. Bumped so
// installed driver PWAs pick up the new app.js.
// v156 · Home command center: an "Action needed" promo card surfaces the
// count of pending required tasks (open checklists + unacknowledged coaching —
// the same items the Tasks tab badge tracks, so the numbers agree) with a
// specific breakdown and a tap through to /tasks. Answers "what must I
// complete?" without a menu dive. Hidden when nothing is pending (clean home)
// and on load error (Tasks stays the source of truth). Bumped so installed
// driver PWAs pick up the new app.js + CSS.
// v157 · Chat send fix: a driver's just-sent message no longer disappears
// until a manual refresh. refreshChat's stub reconciliation built its "already
// confirmed" set from the pending stubs themselves (so every stub matched
// itself and was dropped on the next refresh, before the server had the
// message under read-after-write lag). It now builds that set from the
// canonical driver messages and carries a pending text stub forward until its
// body actually appears server-side. Bumped so installed driver PWAs pick up
// the new app.js.
// v158 · Loading + a11y polish: the Attendance screen replaces its bare
// spinner with a structured skeleton that mirrors its real layout (status
// banner + record card with four stat tiles + ladder card), and the swap-
// request dialog's icon-only close button gains an aria-label/title. Bumped
// so installed driver PWAs pick up the new app.js.
const SHELL_CACHE = "rr-app-shell-v158";
const SHELL_FILES = [
  "./",
  "index.html",
  "styles.css",
  "rr-system.css",
  "app.js",
  "comms-native.js",
  "form-validation.js",
  "vendor/supabase-js.mjs",
  "manifest.webmanifest",
  "icon.svg",
  "Icon.png",
  "icons/favicon-32.png",
  "fonts/inter-var-latin.woff2",
  "../dashboard/config.js",
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

// Exact same-origin paths the shell branch may serve — resolved against the
// SW scope so "../dashboard/config.js" maps to /dashboard/config.js. The old
// matcher used endsWith() over SHELL_FILES, and the "./" entry made it
// endsWith("") — true for EVERY same-origin GET, silently caching unbounded
// content into the shell cache.
const SHELL_PATHS = new Set(
  SHELL_FILES.filter((f) => f !== "./").map((f) => new URL(f, self.registration.scope).pathname)
);

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  // Same-origin shell assets: NETWORK-FIRST.  Cache-first held users on a
  // stale app.js even after we bumped ?v= because iOS PWA SW updates are
  // unreliable.  Network-first means every reload tries fresh; the cache
  // fallback keeps offline launches working.  ignoreSearch lets the
  // ?v=-stamped requests fall back to the unversioned install-time
  // precache on a cold offline launch.
  if (url.origin === location.origin && SHELL_PATHS.has(url.pathname)) {
    event.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(SHELL_CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      }).catch(() => caches.match(req, { ignoreSearch: true }))
    );
    return;
  }
  // Navigation requests: network-first so updated index.html lands on relaunch.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).catch(() => caches.match("./index.html", { ignoreSearch: true }))
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
  // any option fails validation (SVG icon, etc.), so the BASE options stay
  // to the two fields every browser supports.
  const baseData = { url: payload.url || "/app/#/chat", type: payload.type || "message" };
  const baseOpts = { body: payload.body || "", data: baseData };
  // Rich options add quick-action buttons (Reply / Mark read) on browsers
  // that support them (Android, desktop). We TRY rich first and fall back to
  // baseOpts if the platform rejects it — so iOS, which ignores or rejects
  // actions, never loses the notification. Never add actions to a call.
  const richOpts = payload.type === "call"
    ? baseOpts
    : { ...baseOpts, actions: [
        { action: "reply",    title: "Reply" },
        { action: "markread", title: "Mark read" },
      ] };
  const showIt = () => self.registration.showNotification(payload.title || "Dispatch", richOpts)
    .catch(() => self.registration.showNotification(payload.title || "Dispatch", baseOpts)
      .catch((err) => ackPush({ stage: "showNotification", error: String(err) })));

  // Call pushes double as the closed-app ring. If ANY app window is still
  // alive it's connected to realtime and already rings in-app (card + its
  // own notification), so suppress this one to avoid a double-ring — only a
  // fully-closed app (no window client) needs the push. Messages always show.
  const notify = payload.type === "call"
    ? self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
        const appAlive = wins.some((c) => (c.url || "").includes("/app/"));
        return appAlive ? undefined : showIt();
      }).catch(() => showIt())
    : showIt();

  const tasks = [notify, ackPush({ stage: "received", parseError, hasData: !!event.data, type: payload.type || "message" })];
  // A received message push == "delivered to device" — stamp the delivery
  // marker so the dispatcher sees Delivered ✓✓ before the driver opens it.
  if (payload.type !== "call") tasks.push(rrMarkDelivered());
  if ("setAppBadge" in self.navigator && payload.type !== "call") {
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

// Delivery receipt: tell the backend this device received the message, so the
// dispatcher sees "Delivered" even while the app is closed. Best-effort;
// failures are silent (Web Push + polling still cover the message itself).
async function rrMarkDelivered() {
  try {
    const [url, anon, token] = await Promise.all([rrGet("supabaseUrl"), rrGet("anonKey"), rrGet("token")]);
    if (!url || !anon || !token) return;
    await fetch(url + "/rest/v1/rpc/driver_chat_mark_delivered", {
      method:  "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": "Bearer " + anon,
        "apikey":        anon,
      },
      body:    JSON.stringify({ p_token: token }),
      keepalive: true,
    });
  } catch {}
}


// Quick-action: mark the dispatch thread read straight from the notification
// (Android/desktop action button). Mirrors rrMarkDelivered; also clears the
// app badge so the count drops without opening the app.
async function rrMarkRead() {
  try {
    const [url, anon, token] = await Promise.all([rrGet("supabaseUrl"), rrGet("anonKey"), rrGet("token")]);
    if (url && anon && token) {
      await fetch(url + "/rest/v1/rpc/driver_chat_mark_read", {
        method:  "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + anon, "apikey": anon },
        body:    JSON.stringify({ p_token: token }),
        keepalive: true,
      });
    }
  } catch {}
  try { if ("clearAppBadge" in self.navigator) await self.navigator.clearAppBadge(); } catch {}
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "./";
  // "Mark read" button → mark read + clear badge, do NOT open the app.
  if (event.action === "markread") {
    event.waitUntil(rrMarkRead());
    return;
  }
  // "Reply" button or a plain tap → open/focus the app at the thread.
  event.waitUntil(
    self.clients.matchAll({ type: "window" }).then((wins) => {
      const w = wins.find((c) => c.url.includes("/app/"));
      if (w) { w.focus(); if (url) w.navigate(url).catch(() => {}); return; }
      self.clients.openWindow(url);
    })
  );
});
