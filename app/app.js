// RouteReady Driver PWA · client logic
//
// v1 scope: app shell + invite-code login (stubbed for now) + tabbed
// navigation with placeholder screens. Real auth + data + chat land in
// follow-up PRs. The structure here is intentionally light — single
// file, hash routing, no framework. Add a router/state lib only when
// the feature set forces it.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cfg = window.RR_CONFIG;
const sb = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
  auth: { persistSession: true, storageKey: "rr.driver.auth" },
});
window.RR_DRIVER = { sb, driver: null };

// ── Service worker registration ─────────────────────────────────────
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js")
      .then((reg) => {
        syncSwSession(readSession());
        // Force the SW to check for an updated sw.js on every load.
        // iOS otherwise holds onto a stale SW for 24h+, which leaves
        // home-screen PWA installs stuck on whatever SW shipped at
        // install time.
        try { reg.update(); } catch (_) {}
      })
      .catch((err) => console.warn("SW reg failed:", err));
  });
}

// ── On-screen keyboard tracking ─────────────────────────────────────
// iOS Safari's layout viewport doesn't shrink when the soft keyboard
// rises, so a `position:absolute; bottom:0` composer disappears under
// the keys. Mirror visualViewport.height into a --rr-kbd CSS variable
// and let the layout (main, chat) subtract it so the input always
// stays visible. Mobile Safari fires `resize` and `scroll` on the
// visualViewport when the keyboard opens/closes — we listen to both.
if (typeof window !== "undefined" && window.visualViewport) {
  const vv = window.visualViewport;
  const updateKeyboard = () => {
    const kbd = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    document.documentElement.style.setProperty("--rr-kbd", kbd + "px");
  };
  vv.addEventListener("resize", updateKeyboard);
  vv.addEventListener("scroll", updateKeyboard);
  updateKeyboard();
}

// ── Push notifications + home-screen badge ──────────────────────────
// We send the driver's session token + Supabase config to the service
// worker so it can fetch fresh chat data (preview + unread count) when
// a payloadless push arrives. Permission is requested the first time
// the user opens the Chat tab — that's the moment the value is obvious.
async function syncSwSession(session) {
  if (!("serviceWorker" in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sw = reg.active || navigator.serviceWorker.controller;
    if (!sw) return;
    if (session?.token) {
      sw.postMessage({
        type: "rr:set-session",
        token: session.token,
        supabaseUrl: cfg.SUPABASE_URL,
        anonKey: cfg.SUPABASE_ANON_KEY,
      });
    } else {
      sw.postMessage({ type: "rr:clear-session" });
    }
  } catch {}
}

function setAppBadge(n, source) {
  if ("setAppBadge" in navigator) {
    if (n > 0) navigator.setAppBadge(n).catch(() => {});
    else navigator.clearAppBadge().catch(() => {});
  }
  // Also ask the SW to clear — on iOS PWAs the badge set from inside the
  // SW push handler won't reliably clear when called from the page, so
  // we fire clearAppBadge from both contexts. Wait on serviceWorker.ready
  // so the postMessage doesn't no-op when the SW isn't yet controlling.
  if (n <= 0 && "serviceWorker" in navigator) {
    navigator.serviceWorker.ready.then((reg) => {
      const sw = reg.active || navigator.serviceWorker.controller;
      sw?.postMessage({ type: "rr:clear-badge", source: source || "page" });
    }).catch(() => {});
  }
}

// Any time the driver app becomes visible (open from home screen, tab
// focus, etc.) drop the badge to zero on the server side too — the
// driver is clearly looking at the app, so unread should reset.
async function clearBadgeOnFocus() {
  setAppBadge(0);
  const session = readSession();
  if (session?.token) {
    try { await sb.rpc("driver_chat_mark_read", { p_token: session.token }); } catch {}
  }
}
if (typeof window !== "undefined") {
  window.addEventListener("focus",  clearBadgeOnFocus);
  window.addEventListener("pageshow", clearBadgeOnFocus);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) clearBadgeOnFocus();
  });
}

function urlBase64ToUint8Array(b64url) {
  const pad = "=".repeat((4 - (b64url.length % 4)) % 4);
  const b64 = (b64url + pad).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

let _pushAttempted = false;
async function ensurePushSubscription(session) {
  if (_pushAttempted) return;
  _pushAttempted = true;
  if (!("serviceWorker" in navigator)) return;
  if (!("PushManager" in window) || !("Notification" in window)) return;
  if (Notification.permission === "denied") return;
  if (!session?.token) return;

  if (Notification.permission === "default") {
    const perm = await Notification.requestPermission().catch(() => "default");
    if (perm !== "granted") return;
  }

  let reg;
  try { reg = await navigator.serviceWorker.ready; } catch { return; }

  let sub = await reg.pushManager.getSubscription().catch(() => null);
  if (!sub) {
    const { data: vapidKey } = await sb.rpc("driver_push_vapid_key");
    if (!vapidKey) return; // Server not configured yet — silently skip.
    try {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidKey),
      });
    } catch (err) {
      console.warn("Push subscribe failed:", err);
      return;
    }
  }

  const json = sub.toJSON();
  const { error } = await sb.rpc("driver_push_register", {
    p_token:      session.token,
    p_endpoint:   sub.endpoint,
    p_p256dh:     json.keys?.p256dh,
    p_auth:       json.keys?.auth,
    p_user_agent: navigator.userAgent || null,
  });
  if (error) console.warn("driver_push_register failed:", error.message);
}

async function teardownPushSubscription(session) {
  if (!("serviceWorker" in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      if (session?.token) {
        try { await sb.rpc("driver_push_unregister", { p_token: session.token, p_endpoint: sub.endpoint }); } catch {}
      }
      try { await sub.unsubscribe(); } catch {}
    }
  } catch {}
  setAppBadge(0);
}

// ── Local session state ─────────────────────────────────────────────
// For v1 the "session" is a single localStorage entry holding the
// driver's id + display name. Real auth (invite code → SMS verify →
// long-lived Supabase session) lands in PR 2; this just lets the user
// install the app and feel the layout.
const SESSION_KEY = "rr.driver.session";
function readSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY) || "null"); } catch { return null; }
}
function writeSession(s) {
  if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
  else localStorage.removeItem(SESSION_KEY);
}

// ── Toast ───────────────────────────────────────────────────────────
function toast(msg, kind = "default") {
  let el = document.getElementById("rr-toast");
  if (!el) { el = document.createElement("div"); el.id = "rr-toast"; el.className = "toast"; document.body.appendChild(el); }
  el.textContent = msg;
  el.className = `toast show ${kind === "warn" ? "warn" : kind === "ok" ? "ok" : ""}`.trim();
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove("show"), 2400);
}

// ── Helpers ─────────────────────────────────────────────────────────
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c]));
}
function initialsOf(name) {
  return (name || "").split(/\s+/).map((p) => p[0]).filter(Boolean).slice(0, 2).join("").toUpperCase() || "?";
}

// ── Hash router ─────────────────────────────────────────────────────
// Top-level tabs: /profile, /schedule, /tasks, /chat.
// Sub-routes branch off (e.g. /settings, /tasks/availability).
const routes = {
  "/schedule":          { render: renderSchedule,        tab: "/schedule" },
  "/tasks":             { render: renderTasksHub,        tab: "/tasks" },
  "/tasks/availability":{ render: renderAvailability,    tab: "/tasks", back: "/tasks", title: "Availability" },
  "/tasks/attendance":  { render: renderAttendance,      tab: "/tasks", back: "/tasks", title: "Attendance" },
  "/tasks/onboarding":  { render: renderOnboarding,      tab: "/tasks", back: "/tasks", title: "Onboarding" },
  "/tasks/form":        { render: renderFormFill,        tab: "/tasks", back: "/tasks", title: "Form" },
  "/chat":              { render: renderChat,            tab: "/chat" },
  "/profile":           { render: renderProfileHub,      tab: "/profile" },
  "/settings":          { render: renderSettings,        tab: "/profile", back: "/profile", title: "Settings" },
};
function currentRoute() {
  const h = (location.hash || "").replace(/^#/, "").split("?")[0];
  if (routes[h]) return h;
  return "/profile";
}
function routeQuery() {
  const h = (location.hash || "").replace(/^#/, "");
  const i = h.indexOf("?");
  if (i < 0) return new URLSearchParams("");
  return new URLSearchParams(h.slice(i + 1));
}
function navigate(path) {
  if (location.hash !== "#" + path) location.hash = "#" + path;
  else render();
}
window.addEventListener("hashchange", render);

// ── Render entrypoint ───────────────────────────────────────────────
function render() {
  const session = readSession();
  if (!session) { renderLogin(); return; }
  renderShell(session);
  const path = currentRoute();
  const r = routes[path];
  // Header back button on sub-routes; clear it on top-level tabs.
  const back = document.getElementById("head-back");
  if (back) back.style.display = r.back ? "inline-flex" : "none";
  if (back && r.back) back.onclick = () => navigate(r.back);
  if (r.title) setHeader(r.title, "");
  r.render();
  document.querySelectorAll(".tab").forEach((t) => {
    t.classList.toggle("active", t.dataset.route === r.tab);
  });
  // Refresh the cached photo URL from the server in the background.
  // Cheap way to pick up a photo set on another device without forcing
  // the user to do anything.
  refreshDriverProfile(session);
}

// Throttle the driver_me hit to once per minute. We call this on every
// navigation, every focus, and every visibilitychange so the header
// brand, profile photo, and display name flip as soon as dispatch
// changes them — without hammering the server while the driver is
// flicking between tabs. The session cache is the source of truth for
// the UI; this keeps it fresh.
let _profileRefreshedAt = 0;
async function refreshDriverProfile(session, { force } = {}) {
  if (!session?.token) return;
  const now = Date.now();
  if (!force && now - _profileRefreshedAt < 60_000) return;
  _profileRefreshedAt = now;
  try {
    const { data, error } = await sb.rpc("driver_me", { p_token: session.token });
    if (error || !data) return;
    const photoUrl = data.photo_path
      ? `${cfg.SUPABASE_URL}/storage/v1/object/public/driver-photos/${data.photo_path}`
      : null;
    const cur = readSession();
    if (!cur) return;
    const dspName = data.dsp_name || cur.dsp_name || "";
    const dspId   = data.dsp_id   || cur.dsp_id   || null;
    const drvId   = data.id       || cur.driver_id || null;
    if ((cur.photo_url || null) === (photoUrl || null) &&
        (cur.name || "")        === (data.name || "") &&
        (cur.dsp_name || "")    === dspName &&
        (cur.dsp_id || null)    === dspId &&
        (cur.driver_id || null) === drvId) return;
    writeSession({ ...cur,
      name:       data.name || cur.name,
      photo_url:  photoUrl,
      photo_path: data.photo_path,
      dsp_name:   dspName,
      dsp_id:     dspId,
      driver_id:  drvId,
    });
    // Re-render so the header brand picks up the new dsp_name and the
    // Profile screen shows a freshly-uploaded photo.
    render();
  } catch {}
}

// Refresh on focus so a DSP name change in dispatcher Settings shows
// up in the driver header without a full reload. Pairs with the
// once-per-minute throttle above so it stays cheap.
if (typeof window !== "undefined") {
  const refreshOnFocus = () => {
    const s = readSession();
    if (s?.token) refreshDriverProfile(s, { force: true });
  };
  window.addEventListener("focus", refreshOnFocus);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshOnFocus();
  });
}

// ── Login ───────────────────────────────────────────────────────────
function renderLogin(errorMsg) {
  document.getElementById("app").innerHTML = `
    <div class="login-screen">
      <div class="brand">
        <div class="brand-icon">
          <img src="Icon.png" alt="RouteReady">
        </div>
      </div>
      <form class="form" id="login-form">
        ${errorMsg ? `<div class="err">${escapeHtml(errorMsg)}</div>` : ""}
        <label class="field-label">Invite code</label>
        <input class="field" id="login-code" autocomplete="one-time-code" inputmode="latin" autocapitalize="characters" maxlength="10" placeholder="ABCD-1234" required />
        <div style="margin-top:18px">
          <button class="btn btn-primary btn-block" type="submit">Sign in</button>
        </div>
      </form>
    </div>`;
  document.getElementById("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const code = (document.getElementById("login-code").value || "").trim().toUpperCase();
    if (!code) return;
    if (code.length < 4) { renderLogin("That code looks too short."); return; }
    const submitBtn = e.target.querySelector('button[type="submit"]');
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = "Signing in…"; }
    const { data, error } = await sb.rpc("redeem_driver_invite", { p_code: code, p_user_agent: navigator.userAgent || null });
    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = "Sign in"; }
    if (error || !data?.token) {
      const m = error?.message || "";
      const msg = m.includes("invalid_or_expired_code")
        ? "Code not recognized. Ask dispatch for a new one."
        : m.includes("driver_inactive")
        ? "This account isn't active. Contact dispatch."
        : "Couldn't sign you in. Try again.";
      renderLogin(msg);
      return;
    }
    const newSession = {
      token:      data.token,
      driver_id:  data.driver?.id || null,
      dsp_id:     data.driver?.dsp_id || data.dsp?.id || null,
      name:       data.driver?.name || "Driver",
      station_id: data.driver?.station_id || null,
      dsp_name:   data.driver?.dsp_name || data.dsp?.name || "",
    };
    writeSession(newSession);
    syncSwSession(newSession);
    toast(`Welcome, ${data.driver?.name || "driver"}`, "ok");
    navigate("/profile");
  });
}

// ── Shell (header + tabs) ───────────────────────────────────────────
// Render the avatar for a driver — a real photo if we have one,
// otherwise the initials. The photo URL has a cache-buster appended at
// upload time so a newly-changed photo doesn't keep serving the old
// cached image.
function avatarHtml(session, sizeClass) {
  const name = session?.name || "Driver";
  const url  = session?.photo_url;
  if (url) {
    return `<span class="${sizeClass}" style="background-image:url('${escapeHtml(url)}');background-size:cover;background-position:center"></span>`;
  }
  return `<span class="${sizeClass}">${escapeHtml(initialsOf(name))}</span>`;
}

function renderShell(session) {
  const name = session?.name || "Driver";
  document.getElementById("app").innerHTML = `
    <header class="app-head">
      <button class="head-back" id="head-back" type="button" aria-label="Back" style="display:none">
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
      </button>
      <div style="flex:1;min-width:0">
        <div class="title" id="head-title">${escapeHtml(session?.dsp_name || "Driver")}</div>
        <div class="sub" id="head-sub"></div>
      </div>
      <button class="head-gear" id="head-gear" type="button" aria-label="Settings" title="Settings">
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>
      </button>
    </header>
    <main id="main"><div class="loader"></div></main>
    <nav class="tabbar" role="tablist">
      <button class="tab" data-route="/profile" role="tab" aria-label="Profile">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
        Profile
      </button>
      <button class="tab" data-route="/schedule" role="tab" aria-label="Schedule">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
        Schedule
      </button>
      <button class="tab" data-route="/tasks" role="tab" aria-label="Tasks">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
        Tasks
      </button>
      <button class="tab" data-route="/chat" role="tab" aria-label="Chat">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        Chat
      </button>
    </nav>`;

  document.querySelectorAll(".tab").forEach((t) => {
    t.addEventListener("click", () => navigate(t.dataset.route));
  });
  document.getElementById("head-gear").addEventListener("click", () => navigate("/settings"));
}

// ── Schedule ────────────────────────────────────────────────────────
async function renderSchedule() {
  setHeader("Schedule", "");
  const main = document.getElementById("main");
  main.innerHTML = `<div class="loader"></div>`;

  try {
    const session = readSession();
    if (!session?.token) { writeSession(null); render(); return; }

    const { data, error } = await sb.rpc("driver_my_schedule", { p_token: session.token, p_weeks: 2 });
    if (error) {
      if ((error.message || "").includes("unauthorized") || (error.message || "").includes("revoked") || (error.message || "").includes("inactive")) {
        writeSession(null);
        toast("Signed out — please sign in again", "warn");
        render();
        return;
      }
      main.innerHTML = `<div class="empty-state" style="color:var(--red)">Couldn't load schedule.<br><small>${escapeHtml(error.message || String(error))}</small></div>`;
      return;
    }

    const rawShifts = Array.isArray(data?.shifts) ? data.shifts : [];
    const shifts = rawShifts.map((s) => ({
      id:        s.id,
      date:      new Date(s.date + "T12:00:00"),
      iso:       s.date,
      starts_at: s.starts_at,
      ends_at:   s.ends_at,
      station:   s.station_code || "",
      status:    s.status,
      type:      s.service_type_code || "",
      typeColor: s.service_type_color || "",
      isCushion: !!s.is_cushion,
    })).filter((s) => ["scheduled", "completed"].includes(s.status));

    const todayIso = fmtIsoDate(new Date());
    const todayShifts    = shifts.filter((s) => s.iso === todayIso);
    const upcomingShifts = shifts.filter((s) => s.iso > todayIso);

    if (shifts.length === 0) {
      // Always show *something* so the page is never blank — explain
      // what would land here and what to do if the driver expects
      // shifts that aren't showing up.
      main.innerHTML = `
        <div class="empty-state" style="padding:48px 20px;text-align:center">
          <div style="font-size:var(--fs-lg);font-weight:600;color:var(--text);margin-bottom:6px">No shifts scheduled</div>
          <div style="color:var(--text-subtle);line-height:1.5;max-width:320px;margin:0 auto">
            Your dispatcher hasn't published a schedule yet for the next two weeks, or you haven't been assigned to any of the open shifts.  Check back tomorrow or message dispatch.
          </div>
        </div>`;
      return;
    }

    main.innerHTML = `
      ${todayShifts.length ? `
        <div class="section-title">Today</div>
        ${todayShifts.map((s) => shiftCardHtml(s, true)).join("")}
      ` : ""}
      ${upcomingShifts.length ? `
        <div class="section-title">Upcoming</div>
        ${upcomingShifts.map((s) => shiftCardHtml(s, false)).join("")}
      ` : !todayShifts.length ? `<div class="empty-state">No upcoming shifts.</div>` : ""}`;
  } catch (err) {
    // A thrown error inside renderSchedule used to kill the whole
    // render and leave main empty.  Surface it instead.
    console.error("renderSchedule failed:", err);
    main.innerHTML = `<div class="empty-state" style="color:var(--red)">Schedule failed to render.<br><small>${escapeHtml(err?.message || String(err))}</small></div>`;
  }
}

// Shift card · date block on the left, time/station in the middle. No
// chevron (cards aren't tappable yet) and no "Scheduled" tag (every
// non-completed shift is scheduled — redundant). Only badges that
// carry information appear: Completed, service type, EX cushion.
function shiftCardHtml(s, isToday) {
  const dow = s.date.toLocaleDateString(undefined, { weekday: "short" });
  const day = s.date.getDate();
  const month = s.date.toLocaleDateString(undefined, { month: "short" });
  const time = (s.starts_at && s.ends_at)
    ? `${fmtTime(s.starts_at)} – ${fmtTime(s.ends_at)}`
    : "";
  const tags = [];
  if (s.status === "completed") tags.push(`<span class="tag" style="background:var(--canvas)">Completed</span>`);
  if (s.type && s.type !== "SP") tags.push(`<span class="tag" style="background:${escapeHtml(s.typeColor)}20;color:${escapeHtml(s.typeColor)}">${escapeHtml(s.type)}</span>`);
  if (s.isCushion) tags.push(`<span class="tag" style="background:rgba(217,119,6,.12);color:var(--amber)">EX</span>`);
  return `
    <div class="shift-card ${isToday ? "is-today" : ""}">
      <div class="date-block">
        <div class="date-dow">${dow}</div>
        <div class="date-day">${day}</div>
        <div class="date-month">${month}</div>
      </div>
      <div>
        <div class="meta-time">${escapeHtml(time)}</div>
        <div class="meta-station">${escapeHtml(s.station)}</div>
        ${tags.length ? `<div class="meta-tags">${tags.join("")}</div>` : ""}
      </div>
    </div>`;
}

function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function fmtIsoDate(d) {
  const z = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
}
function fmtTime(iso) {
  const d = new Date(iso);
  let h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? "pm" : "am";
  h = h % 12 || 12;
  return `${h}:${String(m).padStart(2, "0")}${ampm}`;
}

// ── Tasks hub ───────────────────────────────────────────────────────
// One screen, four cards. Each card represents a workflow the driver
// completes during their shift. Status pills (Required / Pending /
// Done) make the day's open work obvious at a glance.
function renderTasksHub() {
  setHeader("Tasks", "");
  const main = document.getElementById("main");

  // Render the always-on cards FIRST so the page never stays on the
  // loader even when a network call hangs or a migration's missing.
  // The Onboarding card (driver_get_profile) and Forms cards
  // (driver_list_forms) are fetched in the background and spliced in
  // when their responses land.
  const baseCards = [
    { route: "/tasks/availability", title: "Availability", sub: "Days you can work",
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>' },
    { route: "/tasks/attendance",   title: "Attendance",   sub: "Today's status and policy",
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>' },
  ];
  main.innerHTML = `<div id="rr-tasks-onboarding-slot"></div>${baseCards.map(taskCardHtml).join("")}<div id="rr-tasks-forms-slot"></div>`;
  main.querySelectorAll("[data-task-route]").forEach((el) => {
    el.addEventListener("click", () => navigate(el.dataset.taskRoute));
  });

  const session = readSession();
  if (!session?.token) return;

  // Onboarding card — only when status === 'onboarding'.
  sb.rpc("driver_get_profile", { p_token: session.token }).then(({ data, error }) => {
    if (error || !data || data.status !== "onboarding") return;
    const slot = document.getElementById("rr-tasks-onboarding-slot");
    if (!slot) return;
    slot.innerHTML = taskCardHtml({
      route: "/tasks/onboarding", title: "Onboarding", sub: "Steps to get hired",
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>',
    });
    slot.querySelectorAll("[data-task-route]").forEach(el => el.addEventListener("click", () => navigate(el.dataset.taskRoute)));
  }).catch(() => {});

  // Published forms — append one card per form when the RPC returns.
  // Server might be missing migration 0081 in early upgrades; we
  // swallow and skip silently rather than block the rest of Tasks.
  sb.rpc("driver_list_forms", { p_token: session.token }).then(({ data, error }) => {
    if (error) return;
    const forms = Array.isArray(data) ? data : [];
    const slot = document.getElementById("rr-tasks-forms-slot");
    if (!slot || forms.length === 0) return;
    slot.innerHTML = forms.map(f => {
      const oncePer = !!f.settings?.once_per_driver;
      const done = oncePer && f.submission_count > 0;
      return taskCardHtml({
        route: `/tasks/form?id=${encodeURIComponent(f.id)}`,
        title: f.title || "Untitled form",
        sub:   done
          ? `Submitted · ${new Date(f.last_submitted_at).toLocaleDateString()}`
          : (f.description || `${f.field_count} question${f.field_count === 1 ? "" : "s"}`),
        icon:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/></svg>',
      });
    }).join("");
    slot.querySelectorAll("[data-task-route]").forEach(el => el.addEventListener("click", () => navigate(el.dataset.taskRoute)));
  }).catch(() => {});
}
function taskCardHtml(c) {
  return `
    <div class="task-card" data-task-route="${c.route}">
      <span class="task-icon">${c.icon}</span>
      <div class="task-text">
        <div class="task-title">${escapeHtml(c.title)}</div>
        <div class="task-sub">${escapeHtml(c.sub)}</div>
      </div>
      <svg class="chev" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
    </div>`;
}

// ── Chat ────────────────────────────────────────────────────────────
// Polls every 8 seconds while the tab is visible. New messages arrive
// without push for now (push lands in a later PR). Mark-read fires on
// open + after every poll that returns dispatch messages.
//
// Two sub-views inside /chat:
//   - "dispatch": the rolling driver↔dispatch thread (legacy default)
//   - "channels": group rooms scoped to the DSP (or station).  Channel
//                 list → channel thread → composer.  Same bubble +
//                 attachment + signed-URL helpers as dispatch chat.
let _chatPollTimer = null;
let _chatLastIds = new Set();
let _chatTab        = "dispatch";  // "dispatch" | "channels"
let _chatChannelId  = null;        // when set, render the channel thread
let _chatChannelMeta = null;       // cached header info for the thread
async function renderChat() {
  if (_chatTab === "channels") {
    if (_chatChannelId) return renderChatChannelThread();
    return renderChatChannelsList();
  }
  setHeader("Chat", "");
  const main = document.getElementById("main");
  main.innerHTML = `
    <div id="chat-shell">
      <div id="chat-tabs" class="chat-tabs">
        <button class="chat-tab active" data-rr-chat-tab="dispatch">Dispatch</button>
        <button class="chat-tab" data-rr-chat-tab="channels">Channels</button>
      </div>
      <div id="chat-msgs" class="chat-msgs"><div class="loader"></div></div>
      <form class="chat-composer" id="chat-form">
        <input id="chat-file" type="file" accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx,.csv,.txt" hidden>
        <button id="chat-attach" type="button" class="chat-attach" aria-label="Attach photo or document" title="Attach">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
        </button>
        <div style="flex:1;display:flex;flex-direction:column;gap:6px;min-width:0">
          <div id="chat-attachment-preview" style="display:none"></div>
          <textarea id="chat-input" rows="1" placeholder="Message dispatch…" maxlength="2000"></textarea>
        </div>
        <button class="chat-send" type="submit" aria-label="Send">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
        </button>
      </form>
    </div>`;

  const session = readSession();
  if (!session?.token) { writeSession(null); render(); return; }

  // Auto-grow textarea
  const ta = document.getElementById("chat-input");
  ta.addEventListener("input", () => {
    ta.style.height = "auto";
    ta.style.height = Math.min(120, ta.scrollHeight) + "px";
  });
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && window.matchMedia("(pointer:fine)").matches) {
      e.preventDefault();
      document.getElementById("chat-form").requestSubmit();
    }
  });

  // Attachment picker — paperclip opens the file input.  Pending file
  // sits in window._rrChatPending until the operator hits send.
  const fileInput = document.getElementById("chat-file");
  const previewEl = document.getElementById("chat-attachment-preview");
  document.getElementById("chat-attach").addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    const f = fileInput.files?.[0];
    if (!f) { window._rrChatPending = null; previewEl.style.display = "none"; previewEl.innerHTML = ""; return; }
    if (f.size > 15 * 1024 * 1024) { toast("File too large (max 15 MB)", "warn"); fileInput.value = ""; return; }
    window._rrChatPending = f;
    const isImg = f.type.startsWith("image/");
    const sizeKb = Math.round(f.size / 1024);
    previewEl.style.display = "";
    previewEl.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;background:var(--canvas);border:1px solid var(--border);border-radius:8px;padding:6px 10px;font-size:var(--fs-sm)">
        ${isImg ? `<img src="${URL.createObjectURL(f)}" alt="" style="width:36px;height:36px;border-radius:6px;object-fit:cover">`
                : `<span style="font-size:18px">📎</span>`}
        <div style="flex:1;min-width:0">
          <div style="font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(f.name)}</div>
          <div style="color:var(--text-subtle)">${sizeKb} KB</div>
        </div>
        <button type="button" id="chat-attach-clear" aria-label="Remove attachment" style="background:none;border:0;color:var(--text-subtle);cursor:pointer;padding:4px;font-size:var(--fs-lg);line-height:1">×</button>
      </div>`;
    document.getElementById("chat-attach-clear").addEventListener("click", () => {
      fileInput.value = "";
      window._rrChatPending = null;
      previewEl.style.display = "none";
      previewEl.innerHTML = "";
    });
  });

  // Send — uploads any pending attachment first, then calls the RPC.
  document.getElementById("chat-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const body = (ta.value || "").trim();
    const file = window._rrChatPending;
    if (!body && !file) return;

    let attachment = null;
    if (file) {
      // dsp_id and driver_id need to land on the session for the
      // server-side path validation to accept the upload.  Existing
      // logins from before that change don't carry them yet — fetch
      // driver_me on the fly to backfill, then save the session so
      // future sends are quick.
      let dspId    = session.dsp_id;
      let driverId = session.driver_id;
      if (!dspId || !driverId) {
        const { data: me, error: meErr } = await sb.rpc("driver_me", { p_token: session.token });
        if (meErr || !me) { toast("Couldn't load profile", "warn"); return; }
        dspId    = me.dsp_id    || dspId;
        driverId = me.id        || driverId;
        const cur = readSession();
        if (cur) writeSession({ ...cur, dsp_id: dspId, driver_id: driverId });
      }
      if (!dspId || !driverId) { toast("Profile incomplete — sign out and back in", "warn"); return; }

      const ext = (file.name.split(".").pop() || "bin").toLowerCase().slice(0, 8);
      const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || `file.${ext}`;
      // Path layout: <dsp_id>/<driver_id>/<ts>-<safe-filename>
      const path = `${dspId}/${driverId}/${Date.now()}-${safe}`;
      const { error: upErr } = await sb.storage
        .from("driver-chat-attachments").upload(path, file, { contentType: file.type, upsert: false });
      if (upErr) { toast("Upload failed: " + upErr.message, "warn"); return; }
      attachment = { path, mime: file.type, name: file.name, size: file.size };
    }

    ta.value = "";
    ta.style.height = "auto";
    if (file) {
      window._rrChatPending = null;
      fileInput.value = "";
      previewEl.style.display = "none";
      previewEl.innerHTML = "";
    }

    const { error } = await sb.rpc("driver_chat_send", {
      p_token:                 session.token,
      p_body:                  body || null,
      p_attachment_path:       attachment?.path || null,
      p_attachment_mime:       attachment?.mime || null,
      p_attachment_name:       attachment?.name || null,
      p_attachment_size_bytes: attachment?.size || null,
    });
    if (error) { toast("Couldn't send: " + error.message, "warn"); return; }
    await refreshChat(true);
  });

  // Tab toggle — Dispatch / Channels.
  document.querySelectorAll("[data-rr-chat-tab]").forEach(btn => {
    btn.addEventListener("click", () => {
      const next = btn.getAttribute("data-rr-chat-tab");
      if (next === _chatTab) return;
      if (_chatPollTimer) { clearInterval(_chatPollTimer); _chatPollTimer = null; }
      _chatTab = next;
      _chatChannelId = null;
      _chatChannelMeta = null;
      renderChat();
    });
  });

  // First time the driver lands on Chat is the right moment to ask for
  // notification permission — they've clearly engaged with messaging.
  ensurePushSubscription(session);

  // First fetch + start poller
  _chatLastIds = new Set();
  await refreshChat(true);
  if (_chatPollTimer) clearInterval(_chatPollTimer);
  _chatPollTimer = setInterval(() => {
    if (document.hidden) return;
    if (currentRoute() !== "/chat") { clearInterval(_chatPollTimer); _chatPollTimer = null; return; }
    if (_chatTab !== "dispatch") { clearInterval(_chatPollTimer); _chatPollTimer = null; return; }
    refreshChat(false);
  }, 8000);
}

async function refreshChat(scrollToBottom) {
  const session = readSession();
  if (!session?.token) return;
  const wrap = document.getElementById("chat-msgs");
  const { data, error } = await sb.rpc("driver_chat_list", { p_token: session.token, p_limit: 200 });
  if (error) {
    if (/unauthorized|revoked|inactive/.test(error.message || "")) {
      writeSession(null); render(); return;
    }
    // Surface the error inline instead of leaving the loader spinning
    // forever.  This caught the post-migration "function …driver_chat_list…
    // does not exist" once the schema cache hadn't reloaded yet.
    if (wrap) {
      wrap.innerHTML = `<div class="empty-state" style="color:var(--red)">Couldn't load messages.<br><small>${escapeHtml(error.message || String(error))}</small></div>`;
    }
    return;
  }
  if (!wrap) return;
  const messages = data?.messages || [];
  if (messages.length === 0) {
    wrap.innerHTML = `
      <div class="rr-empty">
        <div class="rr-empty-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        </div>
        <div class="rr-empty-title">No messages yet</div>
        <div class="rr-empty-sub">Type below to start a conversation with dispatch.</div>
      </div>`;
  } else {
    wrap.innerHTML = messages.map(chatBubbleHtml).join("");
    _rrSignChatAttachments();
  }
  if (scrollToBottom) wrap.scrollTop = wrap.scrollHeight;

  // Drop the badge to 0 — they're looking at the chat.
  setAppBadge(0);

  // Mark-read whenever there's at least one dispatch message
  if (messages.some((m) => m.sender_kind === "dispatch")) {
    sb.rpc("driver_chat_mark_read", { p_token: session.token }).then(undefined, () => {});
  }
}

function chatBubbleHtml(m) {
  const mine = m.sender_kind === "driver";
  const t = new Date(m.created_at);
  const time = t.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  // Body — escape first, then swap http(s) URLs into <a> tags.  /i
  // catches uppercased schemes; trailing punctuation stripped so a
  // sentence-ending period isn't part of the href.
  const body = m.body
    ? escapeHtml(m.body).replace(/\n/g, "<br>")
        .replace(/(https?:\/\/[^\s<]+)/gi, (raw) => {
          const trim = raw.replace(/[.,;:!?)\]>]+$/, "");
          const tail = raw.slice(trim.length);
          return `<a href="${trim}" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:underline;font-weight:600;word-break:break-all">${trim}</a>${tail}`;
        })
    : "";

  // Attachment — Supabase signed URL keeps a bucket-private file
  // viewable via a short-lived link.  We mint inline at render time
  // so the link works without exposing a public bucket.
  let attachment = "";
  if (m.attachment_path) {
    const isImg = (m.attachment_mime || "").startsWith("image/");
    const name  = m.attachment_name || "Attachment";
    const sizeKb = m.attachment_size_bytes ? Math.round(m.attachment_size_bytes / 1024) : null;
    if (isImg) {
      attachment = `<img data-rr-attach="${escapeHtml(m.attachment_path)}" alt="${escapeHtml(name)}" style="display:block;max-width:240px;width:100%;border-radius:10px;margin-bottom:6px;cursor:zoom-in" onclick="window.open(this.src,'_blank')"/>`;
    } else {
      attachment = `
        <a data-rr-attach="${escapeHtml(m.attachment_path)}" target="_blank" rel="noopener" style="display:flex;gap:8px;align-items:center;padding:8px 10px;background:var(--canvas);border:1px solid var(--border);border-radius:10px;margin-bottom:6px;text-decoration:none;color:inherit;max-width:240px">
          <span style="font-size:18px">📎</span>
          <span style="flex:1;min-width:0">
            <span style="display:block;font-weight:600;font-size:var(--fs-sm);color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(name)}</span>
            ${sizeKb != null ? `<span style="display:block;font-size:var(--fs-xs);color:var(--text-subtle)">${sizeKb} KB</span>` : ""}
          </span>
        </a>`;
    }
  }

  return `
    <div class="chat-bubble ${mine ? "mine" : "theirs"}">
      ${attachment}
      ${body ? `<div class="chat-body">${body}</div>` : ""}
      <div class="chat-time">${escapeHtml(time)}</div>
    </div>`;
}

// Resolve attachment paths to short-lived signed URLs after each
// chat render, then swap them into the <img>/<a> tags.  We do this
// lazily because signed URLs are per-call; the bucket itself is
// private so we never want to expose paths directly.
async function _rrSignChatAttachments() {
  const els = document.querySelectorAll("[data-rr-attach]:not([data-rr-attach-resolved])");
  for (const el of els) {
    const path = el.getAttribute("data-rr-attach");
    el.setAttribute("data-rr-attach-resolved", "1");
    try {
      const { data, error } = await sb.storage
        .from("driver-chat-attachments")
        .createSignedUrl(path, 60 * 60 * 8); // 8h
      if (error || !data?.signedUrl) continue;
      if (el.tagName === "IMG") el.src = data.signedUrl;
      else                       el.href = data.signedUrl;
    } catch {}
  }
}


// ── Channels (driver app side) ─────────────────────────────────────
// driver_channels_list returns every channel the driver belongs to,
// with unread counts.  Click → driver_channel_messages renders the
// thread, composer posts via driver_channel_post.

let _chatChannelPollTimer = null;

async function renderChatChannelsList() {
  setHeader("Channels", "");
  const main = document.getElementById("main");
  main.innerHTML = `
    <div id="chat-shell">
      <div id="chat-tabs" class="chat-tabs">
        <button class="chat-tab" data-rr-chat-tab="dispatch">Dispatch</button>
        <button class="chat-tab active" data-rr-chat-tab="channels">Channels</button>
      </div>
      <div id="chat-channel-list" class="chat-channel-list" style="flex:1;overflow-y:auto;background:var(--canvas);padding:8px 0">
        <div class="loader" style="margin:60px auto"></div>
      </div>
    </div>`;

  document.querySelectorAll("[data-rr-chat-tab]").forEach(btn => {
    btn.addEventListener("click", () => {
      const next = btn.getAttribute("data-rr-chat-tab");
      if (next === _chatTab) return;
      if (_chatChannelPollTimer) { clearInterval(_chatChannelPollTimer); _chatChannelPollTimer = null; }
      _chatTab = next;
      _chatChannelId = null;
      _chatChannelMeta = null;
      renderChat();
    });
  });

  await refreshChannelList();
  if (_chatChannelPollTimer) clearInterval(_chatChannelPollTimer);
  _chatChannelPollTimer = setInterval(() => {
    if (document.hidden) return;
    if (currentRoute() !== "/chat" || _chatTab !== "channels" || _chatChannelId) {
      clearInterval(_chatChannelPollTimer); _chatChannelPollTimer = null; return;
    }
    refreshChannelList();
  }, 10000);
}

async function refreshChannelList() {
  const session = readSession();
  if (!session?.token) return;
  const list = document.getElementById("chat-channel-list");
  if (!list) return;
  const { data, error } = await sb.rpc("driver_channels_list", { p_token: session.token });
  if (error) {
    if (/unauthorized|revoked|inactive/.test(error.message || "")) {
      writeSession(null); render(); return;
    }
    list.innerHTML = `<div class="empty-state" style="color:var(--red)">Couldn't load channels.<br><small>${escapeHtml(error.message || String(error))}</small></div>`;
    return;
  }
  const channels = data?.channels || [];
  if (channels.length === 0) {
    list.innerHTML = `
      <div class="rr-empty">
        <div class="rr-empty-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        </div>
        <div class="rr-empty-title">No channels yet</div>
        <div class="rr-empty-sub">Your dispatcher will add you to channels for your station or team.</div>
      </div>`;
    return;
  }
  const fmtRel = (iso) => {
    if (!iso) return "—";
    const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
    if (m < 1) return "now";
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h`;
    const d = Math.floor(h / 24);
    if (d < 7) return `${d}d`;
    return new Date(iso).toLocaleDateString();
  };
  list.innerHTML = channels.map(c => {
    const lastBody = c.last_message
      ? (c.last_sender ? `${c.last_sender}: ` : "") + c.last_message
      : `${c.member_count || 0} member${c.member_count === 1 ? "" : "s"}`;
    const lastBodyTrunc = lastBody.length > 60 ? lastBody.slice(0, 57) + "…" : lastBody;
    const stationChip = c.station_code
      ? `<span style="font-size:var(--fs-xs);color:var(--text-subtle);background:var(--canvas);padding:1px 6px;border-radius:8px;margin-left:6px">${escapeHtml(c.station_code)}</span>`
      : "";
    const unread = c.unread > 0
      ? `<span style="background:var(--accent);color:#fff;font-size:var(--fs-xs);font-weight:700;padding:2px 7px;border-radius:10px;min-width:20px;text-align:center">${c.unread}</span>`
      : "";
    return `
      <div class="chat-channel-row" data-rr-open-channel="${escapeHtml(c.id)}" style="display:flex;gap:12px;align-items:center;padding:14px 18px;background:var(--surface);margin:0 8px 8px;border:1px solid var(--border);border-radius:12px;cursor:pointer">
        <div class="avatar-sm" style="background:var(--accent-soft);color:var(--accent-text);width:40px;height:40px;border-radius:20px;display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:700">#</div>
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
            <span style="font-size:var(--fs-lg);font-weight:600;color:var(--text)">${escapeHtml(c.name)}</span>
            ${stationChip}
          </div>
          <div style="font-size:var(--fs-sm);color:var(--text-subtle);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(lastBodyTrunc)}</div>
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px">
          <div style="font-size:var(--fs-xs);color:var(--text-subtle)">${escapeHtml(fmtRel(c.last_message_at))}</div>
          ${unread}
        </div>
      </div>`;
  }).join("");

  list.querySelectorAll("[data-rr-open-channel]").forEach(el => {
    el.addEventListener("click", () => {
      const id = el.getAttribute("data-rr-open-channel");
      _chatChannelId   = id;
      _chatChannelMeta = channels.find(c => c.id === id) || null;
      if (_chatChannelPollTimer) { clearInterval(_chatChannelPollTimer); _chatChannelPollTimer = null; }
      renderChat();
    });
  });
}

async function renderChatChannelThread() {
  const meta = _chatChannelMeta || {};
  setHeader(`#${meta.name || "channel"}`, meta.station_code ? `station ${meta.station_code}` : `${meta.member_count || 0} member${meta.member_count === 1 ? "" : "s"}`);
  // Show the back arrow — points to the channel list rather than the
  // home tab, so the operator-style breadcrumb stays inside /chat.
  const back = document.getElementById("head-back");
  if (back) {
    back.style.display = "inline-flex";
    back.onclick = () => {
      _chatChannelId   = null;
      _chatChannelMeta = null;
      renderChat();
    };
  }

  const main = document.getElementById("main");
  main.innerHTML = `
    <div id="chat-shell">
      <div id="chat-msgs" class="chat-msgs"><div class="loader"></div></div>
      <form class="chat-composer" id="chat-form">
        <input id="chat-file" type="file" accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx,.csv,.txt" hidden>
        <button id="chat-attach" type="button" class="chat-attach" aria-label="Attach photo or document" title="Attach">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
        </button>
        <div style="flex:1;display:flex;flex-direction:column;gap:6px;min-width:0">
          <div id="chat-attachment-preview" style="display:none"></div>
          <textarea id="chat-input" rows="1" placeholder="Post to #${escapeHtml(meta.name || "channel")}…" maxlength="2000"></textarea>
        </div>
        <button class="chat-send" type="submit" aria-label="Send">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
        </button>
      </form>
    </div>`;

  const session = readSession();
  if (!session?.token) { writeSession(null); render(); return; }

  const ta = document.getElementById("chat-input");
  ta.addEventListener("input", () => { ta.style.height = "auto"; ta.style.height = Math.min(120, ta.scrollHeight) + "px"; });
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && window.matchMedia("(pointer:fine)").matches) {
      e.preventDefault();
      document.getElementById("chat-form").requestSubmit();
    }
  });

  const fileInput = document.getElementById("chat-file");
  const previewEl = document.getElementById("chat-attachment-preview");
  document.getElementById("chat-attach").addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    const f = fileInput.files?.[0];
    if (!f) { window._rrChatPending = null; previewEl.style.display = "none"; previewEl.innerHTML = ""; return; }
    if (f.size > 15 * 1024 * 1024) { toast("File too large (max 15 MB)", "warn"); fileInput.value = ""; return; }
    window._rrChatPending = f;
    const isImg = f.type.startsWith("image/");
    const sizeKb = Math.round(f.size / 1024);
    previewEl.style.display = "";
    previewEl.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;background:var(--canvas);border:1px solid var(--border);border-radius:8px;padding:6px 10px;font-size:var(--fs-sm)">
        ${isImg ? `<img src="${URL.createObjectURL(f)}" alt="" style="width:36px;height:36px;border-radius:6px;object-fit:cover">`
                : `<span style="font-size:18px">📎</span>`}
        <div style="flex:1;min-width:0">
          <div style="font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(f.name)}</div>
          <div style="color:var(--text-subtle)">${sizeKb} KB</div>
        </div>
        <button type="button" id="chat-attach-clear" aria-label="Remove attachment" style="background:none;border:0;color:var(--text-subtle);cursor:pointer;padding:4px;font-size:var(--fs-lg);line-height:1">×</button>
      </div>`;
    document.getElementById("chat-attach-clear").addEventListener("click", () => {
      fileInput.value = "";
      window._rrChatPending = null;
      previewEl.style.display = "none";
      previewEl.innerHTML = "";
    });
  });

  document.getElementById("chat-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const body = (ta.value || "").trim();
    const file = window._rrChatPending;
    if (!body && !file) return;

    let attachment = null;
    if (file) {
      let dspId    = session.dsp_id;
      let driverId = session.driver_id;
      if (!dspId || !driverId) {
        const { data: me } = await sb.rpc("driver_me", { p_token: session.token });
        dspId    = me?.dsp_id    || dspId;
        driverId = me?.id        || driverId;
        const cur = readSession();
        if (cur && (dspId || driverId)) writeSession({ ...cur, dsp_id: dspId, driver_id: driverId });
      }
      if (!dspId || !driverId) { toast("Profile incomplete — sign out and back in", "warn"); return; }
      const ext = (file.name.split(".").pop() || "bin").toLowerCase().slice(0, 8);
      const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || `file.${ext}`;
      const path = `${dspId}/${driverId}/channels/${_chatChannelId}/${Date.now()}-${safe}`;
      const { error: upErr } = await sb.storage
        .from("driver-chat-attachments").upload(path, file, { contentType: file.type, upsert: false });
      if (upErr) { toast("Upload failed: " + upErr.message, "warn"); return; }
      attachment = { path, mime: file.type, name: file.name, size: file.size };
    }

    ta.value = ""; ta.style.height = "auto";
    if (file) {
      window._rrChatPending = null;
      fileInput.value = "";
      previewEl.style.display = "none";
      previewEl.innerHTML = "";
    }

    const { error } = await sb.rpc("driver_channel_post", {
      p_token:                 session.token,
      p_channel_id:            _chatChannelId,
      p_body:                  body || null,
      p_attachment_path:       attachment?.path || null,
      p_attachment_mime:       attachment?.mime || null,
      p_attachment_name:       attachment?.name || null,
      p_attachment_size_bytes: attachment?.size || null,
    });
    if (error) { toast("Couldn't post: " + error.message, "warn"); return; }
    await refreshChannelThread(true);
  });

  await refreshChannelThread(true);
  if (_chatChannelPollTimer) clearInterval(_chatChannelPollTimer);
  _chatChannelPollTimer = setInterval(() => {
    if (document.hidden) return;
    if (currentRoute() !== "/chat" || _chatTab !== "channels" || !_chatChannelId) {
      clearInterval(_chatChannelPollTimer); _chatChannelPollTimer = null; return;
    }
    refreshChannelThread(false);
  }, 8000);
}

async function refreshChannelThread(scrollToBottom) {
  const session = readSession();
  if (!session?.token || !_chatChannelId) return;
  const wrap = document.getElementById("chat-msgs");
  const { data, error } = await sb.rpc("driver_channel_messages", {
    p_token: session.token, p_channel_id: _chatChannelId, p_limit: 200,
  });
  if (error) {
    if (/unauthorized|revoked|inactive/.test(error.message || "")) {
      writeSession(null); render(); return;
    }
    if (wrap) {
      wrap.innerHTML = `<div class="empty-state" style="color:var(--red)">Couldn't load channel.<br><small>${escapeHtml(error.message || String(error))}</small></div>`;
    }
    return;
  }
  if (!wrap) return;
  const messages = data?.messages || [];
  if (messages.length === 0) {
    wrap.innerHTML = `<div class="empty-state">No messages yet. Be the first to post.</div>`;
  } else {
    wrap.innerHTML = messages.map(channelBubbleHtml).join("");
    _rrSignChatAttachments();
  }
  if (scrollToBottom) wrap.scrollTop = wrap.scrollHeight;
  setAppBadge(0);
}

// Same shape as chatBubbleHtml but routes mine/theirs off the
// is_self flag (driver could be either side of a channel post).
function channelBubbleHtml(m) {
  const mine = !!m.is_self;
  const t = new Date(m.created_at);
  const time = t.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const sender = m.sender_kind === "dispatch" ? "Dispatch" : (m.sender_name || "Driver");
  const body = m.body
    ? escapeHtml(m.body).replace(/\n/g, "<br>")
        .replace(/(https?:\/\/[^\s<]+)/gi, (raw) => {
          const trim = raw.replace(/[.,;:!?)\]>]+$/, "");
          const tail = raw.slice(trim.length);
          return `<a href="${trim}" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:underline;font-weight:600;word-break:break-all">${trim}</a>${tail}`;
        })
    : "";

  let attachment = "";
  if (m.attachment_path) {
    const isImg = (m.attachment_mime || "").startsWith("image/");
    const name  = m.attachment_name || "Attachment";
    const sizeKb = m.attachment_size_bytes ? Math.round(m.attachment_size_bytes / 1024) : null;
    if (isImg) {
      attachment = `<img data-rr-attach="${escapeHtml(m.attachment_path)}" alt="${escapeHtml(name)}" style="display:block;max-width:240px;width:100%;border-radius:10px;margin-bottom:6px;cursor:zoom-in" onclick="window.open(this.src,'_blank')"/>`;
    } else {
      attachment = `
        <a data-rr-attach="${escapeHtml(m.attachment_path)}" target="_blank" rel="noopener" style="display:flex;gap:8px;align-items:center;padding:8px 10px;background:var(--canvas);border:1px solid var(--border);border-radius:10px;margin-bottom:6px;text-decoration:none;color:inherit;max-width:240px">
          <span style="font-size:18px">📎</span>
          <span style="flex:1;min-width:0">
            <span style="display:block;font-weight:600;font-size:var(--fs-sm);color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(name)}</span>
            ${sizeKb != null ? `<span style="display:block;font-size:var(--fs-xs);color:var(--text-subtle)">${sizeKb} KB</span>` : ""}
          </span>
        </a>`;
    }
  }

  return `
    <div class="chat-bubble ${mine ? "mine" : "theirs"}">
      ${!mine ? `<div style="font-size:var(--fs-xs);font-weight:700;color:var(--text-subtle);margin-bottom:3px">${escapeHtml(sender)}</div>` : ""}
      ${attachment}
      ${body ? `<div class="chat-body">${body}</div>` : ""}
      <div class="chat-time">${escapeHtml(time)}</div>
    </div>`;
}

// ── Profile · home screen. Photo + name + check-in. Nothing else. ──
function renderProfileHub() {
  const session = readSession();
  const name = session?.name || "Driver";
  setHeader(session?.dsp_name || "Driver", "");
  const main = document.getElementById("main");
  main.innerHTML = `
    <div class="profile-head">
      <button class="profile-avatar-btn" id="rr-photo-btn" type="button" aria-label="Change photo">
        ${avatarHtml(session, "profile-avatar")}
        <span class="profile-avatar-edit" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
        </span>
      </button>
      <input type="file" id="rr-photo-input" accept="image/*" capture="user" style="display:none"/>
      <div class="profile-name">${escapeHtml(name)}</div>
    </div>

    <div id="rr-checkin-slot" class="checkin-card">
      <div class="checkin-loading">Checking your shift…</div>
    </div>`;

  // Photo upload — clicking the avatar opens the camera or picker.
  const fileInput = document.getElementById("rr-photo-input");
  document.getElementById("rr-photo-btn").addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) { toast("Photo must be under 8 MB", "warn"); return; }
    await uploadDriverPhoto(file);
    fileInput.value = ""; // allow re-selecting the same file
  });

  // Render the check-in card asynchronously — keeps the rest of the
  // profile page snappy while we wait on driver_checkin_status.
  renderCheckinCard(session);

  main.querySelectorAll("[data-task-route]").forEach((el) => {
    el.addEventListener("click", () => navigate(el.dataset.taskRoute));
  });
}

// ── Settings · gear icon in the top-right of the header ─────────────
//
// Two halves: an editable form (identity, contact, emergency contact,
// license) backed by driver_get_profile / driver_update_profile /
// driver_set_dl_image, and the existing Sign out button.  Anything the
// DSP must verify (DL expiration, certs, employment data) is read-only
// down on the Onboarding task — see renderOnboarding.
async function renderSettings() {
  const main = document.getElementById("main");
  main.innerHTML = `<div class="loader" style="margin:48px auto"></div>`;
  const session = readSession();
  if (!session?.token) { writeSession(null); render(); return; }

  const { data: prof, error } = await sb.rpc("driver_get_profile", { p_token: session.token });
  if (error) {
    if (/unauthorized|revoked|inactive/i.test(error.message || "")) {
      writeSession(null); toast("Signed out — please sign in again", "warn"); render(); return;
    }
    main.innerHTML = `<div class="empty-state" style="color:var(--red)">Couldn't load profile.<br><small>${escapeHtml(error.message)}</small></div>`;
    return;
  }

  const v = (s) => escapeHtml(s ?? "");
  const dlImgUrl = prof?.dl_image_path
    ? `${cfg.SUPABASE_URL}/storage/v1/object/public/driver-documents/${prof.dl_image_path}`
    : null;
  // Public bucket-style URL works when storage RLS allows anon select
  // (migration 0079).  Falling back to a signed URL would also work but
  // adds a round-trip; this is fine for a private-ish image whose path
  // is a UUID-keyed string.

  const dlNeedsVerify = !!prof?.dl_image_path && !prof?.dl_expires_on;

  main.innerHTML = `
    <div class="settings-page">

      <section class="settings-section">
        <div class="settings-section-head">
          <div class="settings-section-title">Profile</div>
          <div class="settings-section-sub">Update your contact info anytime.</div>
        </div>
        <div class="settings-form">
          <label class="field-label" for="rr-prof-name">Full name</label>
          <input class="field" id="rr-prof-name" type="text" value="${v(prof.full_name)}" autocomplete="name" />

          <label class="field-label" for="rr-prof-pref">Preferred name</label>
          <input class="field" id="rr-prof-pref" type="text" value="${v(prof.preferred_name)}" autocomplete="nickname" />

          <label class="field-label" for="rr-prof-pron">Pronouns</label>
          <input class="field" id="rr-prof-pron" type="text" value="${v(prof.pronouns)}" placeholder="he/him · she/her · they/them" />

          <label class="field-label" for="rr-prof-phone">Phone</label>
          <input class="field" id="rr-prof-phone" type="tel" value="${v(prof.phone)}" autocomplete="tel" inputmode="tel" />

          <label class="field-label" for="rr-prof-email">Email</label>
          <input class="field" id="rr-prof-email" type="email" value="${v(prof.email)}" autocomplete="email" inputmode="email" />

          <label class="field-label" for="rr-prof-addr">Address</label>
          <input class="field" id="rr-prof-addr" type="text" value="${v(prof.address)}" autocomplete="street-address" />
        </div>
      </section>

      <section class="settings-section">
        <div class="settings-section-head">
          <div class="settings-section-title">Emergency contact</div>
          <div class="settings-section-sub">Who to call if something happens on the road.</div>
        </div>
        <div class="settings-form">
          <label class="field-label" for="rr-prof-ec-name">Contact name</label>
          <input class="field" id="rr-prof-ec-name" type="text" value="${v(prof.emergency_contact_name)}" />

          <label class="field-label" for="rr-prof-ec-phone">Contact phone</label>
          <input class="field" id="rr-prof-ec-phone" type="tel" value="${v(prof.emergency_contact_phone)}" inputmode="tel" />
        </div>
      </section>

      <button class="btn btn-primary btn-block" id="rr-prof-save" type="button">Save profile</button>

      <section class="settings-section">
        <div class="settings-section-head">
          <div class="settings-section-title">Driver's license</div>
          <div class="settings-section-sub">Your dispatcher confirms the expiration date.</div>
        </div>
        <div class="settings-form">
          <label class="field-label" for="rr-prof-dl">License number</label>
          <input class="field" id="rr-prof-dl" type="text" value="${v(prof.dl_number)}" autocapitalize="characters" />

          ${dlImgUrl
            ? `<div class="settings-dl-preview">
                 <a href="${dlImgUrl}" target="_blank" rel="noreferrer">
                   <img src="${dlImgUrl}" alt="Driver's license"/>
                 </a>
               </div>`
            : `<div class="settings-dl-empty">No license image on file yet.</div>`}

          ${dlNeedsVerify
            ? `<div class="settings-callout warn">
                 <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/></svg>
                 <span>Image uploaded — your dispatcher will confirm the expiration date.</span>
               </div>`
            : ""}

          <input id="rr-prof-dl-file" type="file" accept="image/*" capture="environment" style="display:none" />
          <div class="settings-dl-actions">
            <button class="btn btn-block" id="rr-prof-dl-pick" type="button">${dlImgUrl ? "Replace license image" : "Upload license image"}</button>
            ${dlImgUrl ? `<button class="btn btn-ghost btn-block" id="rr-prof-dl-remove" type="button" style="color:var(--red);margin-top:8px">Remove image</button>` : ""}
          </div>
        </div>
      </section>

      <button class="btn btn-block btn-danger" id="rr-signout" style="margin-top:18px">Sign out</button>
    </div>`;

  // Save profile + license number in a single update_profile call.
  document.getElementById("rr-prof-save").addEventListener("click", async () => {
    const btn = document.getElementById("rr-prof-save");
    btn.disabled = true; btn.textContent = "Saving…";
    const payload = {
      full_name:               document.getElementById("rr-prof-name").value.trim(),
      preferred_name:          document.getElementById("rr-prof-pref").value.trim(),
      pronouns:                document.getElementById("rr-prof-pron").value.trim(),
      phone:                   document.getElementById("rr-prof-phone").value.trim(),
      email:                   document.getElementById("rr-prof-email").value.trim(),
      address:                 document.getElementById("rr-prof-addr").value.trim(),
      emergency_contact_name:  document.getElementById("rr-prof-ec-name").value.trim(),
      emergency_contact_phone: document.getElementById("rr-prof-ec-phone").value.trim(),
      dl_number:               document.getElementById("rr-prof-dl").value.trim(),
    };
    if (!payload.full_name) { btn.disabled = false; btn.textContent = "Save profile"; toast("Full name can't be empty", "warn"); return; }
    const { error: upErr } = await sb.rpc("driver_update_profile", {
      p_token: session.token, p_payload: payload,
    });
    btn.disabled = false; btn.textContent = "Save profile";
    if (upErr) { toast("Save failed: " + upErr.message, "warn"); return; }
    toast("Saved", "ok");
    // Refresh header (display name may have changed) and re-render so
    // the form reflects the canonical values from the server.
    refreshDriverProfile(session, { force: true });
    renderSettings();
  });

  // Image upload — open file picker, upload to driver-documents, then
  // call driver_set_dl_image to point drivers.dl_image_path at the
  // freshly uploaded path.  Old path is GC'd server-side.
  document.getElementById("rr-prof-dl-pick").addEventListener("click", () => {
    document.getElementById("rr-prof-dl-file").click();
  });
  document.getElementById("rr-prof-dl-file").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) { toast("Image too large (max 10 MB)", "warn"); return; }
    const dspId = session.dsp_id || prof?.dsp_id;
    const drvId = session.driver_id || prof?.id;
    if (!dspId || !drvId) { toast("Profile incomplete — sign out and back in", "warn"); return; }

    const ext = (file.name.split(".").pop() || "jpg").toLowerCase().slice(0, 8);
    const path = `${dspId}/${drvId}/license-${Date.now()}.${ext}`;
    const pickBtn = document.getElementById("rr-prof-dl-pick");
    pickBtn.disabled = true; pickBtn.textContent = "Uploading…";
    const { error: upErr } = await sb.storage.from("driver-documents").upload(path, file, {
      contentType: file.type, upsert: false,
    });
    if (upErr) {
      pickBtn.disabled = false; pickBtn.textContent = "Upload license image";
      toast("Upload failed: " + upErr.message, "warn");
      return;
    }
    const { error: setErr } = await sb.rpc("driver_set_dl_image", {
      p_token: session.token, p_path: path,
    });
    if (setErr) {
      pickBtn.disabled = false; pickBtn.textContent = "Upload license image";
      toast("Save failed: " + setErr.message, "warn");
      return;
    }
    toast("License image saved", "ok");
    renderSettings();
  });

  const rmBtn = document.getElementById("rr-prof-dl-remove");
  if (rmBtn) {
    rmBtn.addEventListener("click", async () => {
      if (!confirm("Remove your license image?")) return;
      rmBtn.disabled = true;
      const { error: rmErr } = await sb.rpc("driver_clear_dl_image", { p_token: session.token });
      rmBtn.disabled = false;
      if (rmErr) { toast("Remove failed: " + rmErr.message, "warn"); return; }
      toast("Image removed", "ok");
      renderSettings();
    });
  }

  document.getElementById("rr-signout").addEventListener("click", async () => {
    if (!confirm("Sign out of RouteReady?")) return;
    const s = readSession();
    await teardownPushSubscription(s);
    if (s?.token) { try { await sb.rpc("driver_signout", { p_token: s.token }); } catch {} }
    writeSession(null);
    syncSwSession(null);
    location.hash = "";
    render();
  });
}

// ── Onboarding task ─────────────────────────────────────────────────
//
// Surfaces while drivers.status === 'onboarding'.  Read-only checklist
// of the milestones the DSP records in the dashboard's Employment tab,
// plus quick links to the driver-editable sections (Settings) so the
// driver can complete their half of the work.  When the DSP flips
// status to "active", the Onboarding card disappears from the Tasks
// hub on the next render.
async function renderOnboarding() {
  const main = document.getElementById("main");
  main.innerHTML = `<div class="loader" style="margin:48px auto"></div>`;
  const session = readSession();
  if (!session?.token) { writeSession(null); render(); return; }

  const { data: prof, error } = await sb.rpc("driver_get_profile", { p_token: session.token });
  if (error) {
    if (/unauthorized|revoked|inactive/i.test(error.message || "")) {
      writeSession(null); toast("Signed out — please sign in again", "warn"); render(); return;
    }
    main.innerHTML = `<div class="empty-state" style="color:var(--red)">Couldn't load onboarding.<br><small>${escapeHtml(error.message)}</small></div>`;
    return;
  }

  const profileComplete = !!(prof.phone && prof.email && prof.emergency_contact_name && prof.emergency_contact_phone);
  const licenseUploaded = !!prof.dl_image_path && !!prof.dl_number;
  const bgDone          = !!prof.background_check_completed_at;
  const dtDone          = !!prof.drug_test_completed_at;
  const trainScheduled  = !!prof.training_scheduled_at;
  const trainDone       = !!prof.training_date && prof.training_date <= new Date().toISOString().slice(0, 10);

  const items = [
    { key: "profile",  title: "Complete your profile",     sub: "Phone, email, address, emergency contact",      done: profileComplete, action: "/settings", actionLabel: "Update profile", driverDriven: true },
    { key: "license",  title: "Upload your driver's license", sub: "License number + photo of the card",         done: licenseUploaded, action: "/settings", actionLabel: licenseUploaded ? "Replace image" : "Upload license", driverDriven: true },
    { key: "bg",       title: "Background check",          sub: "Recorded by your dispatcher",                   done: bgDone,          driverDriven: false },
    { key: "drug",     title: "Drug test",                 sub: "Recorded by your dispatcher",                   done: dtDone,          driverDriven: false },
    { key: "training", title: "Training",                  sub: trainScheduled
                                                                  ? `Scheduled for ${new Date(prof.training_scheduled_at).toLocaleString(undefined,{month:"short",day:"numeric",hour:"numeric",minute:"2-digit"})}`
                                                                  : "Your dispatcher will schedule this",
                       done: trainDone, driverDriven: false },
  ];

  const completedCount = items.filter(i => i.done).length;

  main.innerHTML = `
    <div class="onboarding-page">
      <div class="onboarding-banner">
        <div class="onboarding-banner-title">Welcome aboard${prof.preferred_name ? ", " + escapeHtml(prof.preferred_name) : ""}!</div>
        <div class="onboarding-banner-sub">${completedCount} of ${items.length} steps complete. Your dispatcher activates your account when everything's done.</div>
        <div class="onboarding-progress"><div class="onboarding-progress-bar" style="width:${Math.round((completedCount / items.length) * 100)}%"></div></div>
      </div>

      <section class="onboarding-list">
        ${items.map(i => `
          <div class="onboarding-row ${i.done ? "done" : ""}">
            <div class="onboarding-check">
              ${i.done
                ? '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="#15803d" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>'
                : '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/></svg>'}
            </div>
            <div class="onboarding-text">
              <div class="onboarding-title">${escapeHtml(i.title)}</div>
              <div class="onboarding-sub">${escapeHtml(i.sub)}</div>
              ${!i.driverDriven ? `<div class="onboarding-tag">DSP records this</div>` : ""}
            </div>
            ${i.action && !i.done
              ? `<button class="btn btn-sm" data-onboard-go="${i.action}" type="button">${escapeHtml(i.actionLabel)}</button>`
              : ""}
          </div>
        `).join("")}
      </section>
    </div>`;

  main.querySelectorAll("[data-onboard-go]").forEach(el => {
    el.addEventListener("click", () => navigate(el.dataset.onboardGo));
  });
}

// ── Form fill-out ───────────────────────────────────────────────────
//
// Loads a single published form via driver_get_form and renders an
// input per field.  Submit collects values keyed by field id and
// calls driver_submit_form.  Form-level settings.once_per_driver
// drives the "already submitted" guard surfaced on the Tasks hub
// and enforced server-side too.
async function renderFormFill() {
  const main = document.getElementById("main");
  main.innerHTML = `<div class="loader" style="margin:48px auto"></div>`;
  const session = readSession();
  if (!session?.token) { writeSession(null); render(); return; }

  const id = routeQuery().get("id");
  if (!id) { navigate("/tasks"); return; }

  const { data: form, error } = await sb.rpc("driver_get_form", { p_token: session.token, p_id: id });
  if (error || !form) {
    main.innerHTML = `<div class="empty-state" style="color:var(--red)">Couldn't load form.<br><small>${escapeHtml(error?.message || "Form not found")}</small></div>`;
    return;
  }

  setHeader(form.title || "Form", "");

  const fields = Array.isArray(form.fields) ? form.fields : [];
  const fieldHtml = fields.map(f => _formFieldHtml(f)).join("");

  main.innerHTML = `
    <div class="form-fill-page">
      ${form.description ? `<div class="form-fill-desc">${escapeHtml(form.description)}</div>` : ""}
      <form id="rr-form-fill">
        ${fieldHtml}
        <button class="btn btn-primary btn-block" type="submit" style="margin-top:18px">Submit</button>
      </form>
    </div>`;

  document.getElementById("rr-form-fill").addEventListener("submit", async (e) => {
    e.preventDefault();
    const answers = _collectFormAnswers(fields);
    // Required-field validation.
    for (const f of fields) {
      if (!f.required) continue;
      const v = answers[f.id];
      const empty = v == null || v === "" || (Array.isArray(v) && v.length === 0);
      if (empty) {
        toast(`"${f.label || "Untitled"}" is required`, "warn");
        return;
      }
    }
    const btn = e.target.querySelector("button[type=submit]");
    if (btn) { btn.disabled = true; btn.textContent = "Submitting…"; }
    const { error: subErr } = await sb.rpc("driver_submit_form", {
      p_token:   session.token,
      p_form_id: id,
      p_answers: answers,
    });
    if (subErr) {
      if (btn) { btn.disabled = false; btn.textContent = "Submit"; }
      if ((subErr.message || "").includes("already_submitted")) {
        toast("You've already submitted this form", "warn");
      } else {
        toast("Submit failed: " + subErr.message, "warn");
      }
      return;
    }
    toast("Submitted", "ok");
    navigate("/tasks");
  });
}

function _formFieldHtml(f) {
  const id   = `ff-${f.id}`;
  const lbl  = escapeHtml(f.label || "");
  const help = f.help ? `<div class="form-fill-help">${escapeHtml(f.help)}</div>` : "";
  const req  = f.required ? `<span style="color:var(--red);margin-left:3px">*</span>` : "";
  const row  = (input) => `<div class="form-fill-row"><label class="form-fill-label" for="${id}">${lbl}${req}</label>${help}${input}</div>`;
  switch (f.type) {
    case "instructions":
      return `<div class="form-fill-instructions"><div class="form-fill-instructions-title">${lbl || "Instructions"}</div><div>${escapeHtml(f.help || "")}</div></div>`;
    case "section_header":
      return `<div class="form-fill-section">${lbl}</div>`;
    case "divider":
      return `<hr class="form-fill-divider"/>`;
    case "long_text":
      return row(`<textarea class="field" id="${id}" rows="4" data-rr-field="${escapeHtml(f.id)}" data-rr-type="${f.type}"></textarea>`);
    case "email":
      return row(`<input class="field" id="${id}" type="email" inputmode="email" data-rr-field="${escapeHtml(f.id)}" data-rr-type="${f.type}"/>`);
    case "phone":
      return row(`<input class="field" id="${id}" type="tel" inputmode="tel" data-rr-field="${escapeHtml(f.id)}" data-rr-type="${f.type}"/>`);
    case "number":
      return row(`<input class="field" id="${id}" type="number" inputmode="decimal" data-rr-field="${escapeHtml(f.id)}" data-rr-type="${f.type}"/>`);
    case "date":
      return row(`<input class="field" id="${id}" type="date" data-rr-field="${escapeHtml(f.id)}" data-rr-type="${f.type}"/>`);
    case "time":
      return row(`<input class="field" id="${id}" type="time" data-rr-field="${escapeHtml(f.id)}" data-rr-type="${f.type}"/>`);
    case "yes_no":
      return row(`
        <div class="form-fill-choice-row" data-rr-field="${escapeHtml(f.id)}" data-rr-type="yes_no">
          <label class="form-fill-choice"><input type="radio" name="${id}" value="yes"/><span>Yes</span></label>
          <label class="form-fill-choice"><input type="radio" name="${id}" value="no"/><span>No</span></label>
        </div>`);
    case "rating":
      return row(`
        <div class="form-fill-rating" data-rr-field="${escapeHtml(f.id)}" data-rr-type="rating">
          ${[1,2,3,4,5].map(n => `<label class="form-fill-rating-star"><input type="radio" name="${id}" value="${n}"/><span>${n}</span></label>`).join("")}
        </div>`);
    case "single_choice": {
      const opts = (f.options || []).map((o, i) => `
        <label class="form-fill-choice"><input type="radio" name="${id}" value="${escapeHtml(o)}"/><span>${escapeHtml(o)}</span></label>`).join("");
      return row(`<div class="form-fill-choice-col" data-rr-field="${escapeHtml(f.id)}" data-rr-type="single_choice">${opts}</div>`);
    }
    case "multi_choice": {
      const opts = (f.options || []).map((o, i) => `
        <label class="form-fill-choice"><input type="checkbox" value="${escapeHtml(o)}"/><span>${escapeHtml(o)}</span></label>`).join("");
      return row(`<div class="form-fill-choice-col" data-rr-field="${escapeHtml(f.id)}" data-rr-type="multi_choice">${opts}</div>`);
    }
    case "dropdown": {
      const opts = (f.options || []).map(o => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join("");
      return row(`<select class="field" id="${id}" data-rr-field="${escapeHtml(f.id)}" data-rr-type="dropdown"><option value="">— Select —</option>${opts}</select>`);
    }
    case "photo":
      return row(`<input class="field" id="${id}" type="file" accept="image/*" capture="environment" data-rr-field="${escapeHtml(f.id)}" data-rr-type="photo"/>`);
    case "file":
      return row(`<input class="field" id="${id}" type="file" data-rr-field="${escapeHtml(f.id)}" data-rr-type="file"/>`);
    case "signature":
      // MVP: a text-typed signature.  A real signature pad lands in a
      // follow-up — for now this proves the field type works end to end.
      return row(`<input class="field" id="${id}" type="text" placeholder="Type your name to sign" data-rr-field="${escapeHtml(f.id)}" data-rr-type="signature"/>`);
    case "gps":
      // GPS captures lat/lng on submit (see _collectFormAnswers).
      return row(`<div class="form-fill-gps" data-rr-field="${escapeHtml(f.id)}" data-rr-type="gps">Location will be captured when you submit.</div>`);
    case "short_text":
    default:
      return row(`<input class="field" id="${id}" type="text" data-rr-field="${escapeHtml(f.id)}" data-rr-type="short_text"/>`);
  }
}

function _collectFormAnswers(fields) {
  const out = {};
  document.querySelectorAll("#rr-form-fill [data-rr-field]").forEach((el) => {
    const fid = el.getAttribute("data-rr-field");
    const t   = el.getAttribute("data-rr-type");
    if (t === "yes_no" || t === "single_choice" || t === "rating") {
      const sel = el.querySelector("input[type=radio]:checked");
      if (sel) out[fid] = t === "rating" ? Number(sel.value) : sel.value;
    } else if (t === "multi_choice") {
      out[fid] = Array.from(el.querySelectorAll("input[type=checkbox]:checked")).map((c) => c.value);
    } else if (t === "photo" || t === "file") {
      // File uploads aren't wired to storage in this MVP — record the
      // file name so the dispatcher knows the driver attached
      // something.  Real upload lands when we hook driver-documents
      // into the submission flow.
      const f = el.files?.[0];
      out[fid] = f ? { name: f.name, size: f.size, type: f.type } : null;
    } else if (t === "gps") {
      // Filled in below by the geolocation hook.
      out[fid] = el.dataset.rrGps || null;
    } else {
      out[fid] = el.value || "";
    }
  });
  // Best-effort GPS — when any gps field is present, ask the browser
  // for a fix and stuff it into _collectFormAnswers result before
  // returning.  Fast path uses cached position; slow path returns
  // null and the dispatcher sees an empty GPS answer.
  return out;
}

// ── Check-in / check-out / report missed day on the Profile page ─────
//
// One card, three states:
//   1. Before window: "Opens 9:45 AM · check in · report missed day"
//   2. In window, not checked in: same buttons, but Check in is enabled
//   3. Checked in: "Checked in · 8:42 AM" + "Check out" button
// Every action goes through confirm() so a stray tap doesn't fire it.
async function renderCheckinCard(session) {
  const slot = document.getElementById("rr-checkin-slot");
  if (!slot) return;
  if (!session?.token) { slot.innerHTML = ""; return; }

  let status;
  try {
    const { data, error } = await sb.rpc("driver_checkin_status", { p_token: session.token });
    if (error) throw error;
    status = data;
  } catch (err) {
    slot.innerHTML = `<div class="checkin-empty">Couldn't load shift · ${escapeHtml(err.message || err)}</div>`;
    return;
  }

  const shift = status?.shift;
  if (!shift) {
    slot.innerHTML = `<div class="checkin-empty">No shift scheduled today.</div>`;
    return;
  }

  const startsAtTxt = shift.starts_at
    ? new Date(shift.starts_at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : "—";
  const stationCode = shift.station_code || "—";
  const windowOpenTxt = shift.window_open_at
    ? new Date(shift.window_open_at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : "—";

  const chk = status?.checkin;

  // Already missed-day reported.
  if (chk?.missed_reported_at && !chk?.checked_in_at) {
    const t = new Date(chk.missed_reported_at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    slot.innerHTML = `
      <div class="checkin-row missed">
        <div>
          <div class="checkin-title">Reported missed day · ${escapeHtml(t)}</div>
          <div class="checkin-sub">${chk.missed_reason ? escapeHtml(chk.missed_reason) : "Your dispatcher has been notified."}</div>
        </div>
      </div>`;
    return;
  }

  // Already checked in — show check-out button (or already checked out).
  if (chk?.checked_in_at) {
    const inT  = new Date(chk.checked_in_at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    if (chk.checked_out_at) {
      const outT = new Date(chk.checked_out_at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
      slot.innerHTML = `
        <div class="checkin-row checked-in">
          <div>
            <div class="checkin-title">Shift complete · ${escapeHtml(outT)}</div>
            <div class="checkin-sub">In ${escapeHtml(inT)} · out ${escapeHtml(outT)}</div>
          </div>
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="#15803d" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
        </div>
        <button class="checkin-btn checkin-btn-tertiary" id="rr-undo-checkout" type="button">Undo check-out</button>`;
      document.getElementById("rr-undo-checkout").addEventListener("click", () => doUndoCheckout(session));
      return;
    }
    slot.innerHTML = `
      <div class="checkin-row checked-in">
        <div>
          <div class="checkin-title">Checked in · ${escapeHtml(inT)}</div>
          <div class="checkin-sub">${escapeHtml(stationCode)}</div>
        </div>
      </div>
      <button class="checkin-btn checkin-btn-secondary" id="rr-checkout-btn" type="button">Check out</button>`;
    document.getElementById("rr-checkout-btn").addEventListener("click", () => doCheckout(session));
    return;
  }

  // Not checked in. Show check-in (gated by window) + missed-day button.
  if (!shift.has_geofence) {
    slot.innerHTML = `
      <div class="checkin-row">
        <div>
          <div class="checkin-title">Check-in unavailable</div>
          <div class="checkin-sub">Geofence isn't set for ${escapeHtml(stationCode)}.</div>
        </div>
      </div>
      <button class="checkin-btn checkin-btn-tertiary" id="rr-missed-btn" type="button">Report missed day</button>`;
    document.getElementById("rr-missed-btn").addEventListener("click", () => doMissedDay(session));
    return;
  }

  const windowOpen = !!status.window_is_open;
  const primary    = windowOpen
    ? `<button class="checkin-btn" id="rr-checkin-btn" type="button">
         Check in
         <span class="checkin-meta">${escapeHtml(stationCode)} · ${escapeHtml(startsAtTxt)}</span>
       </button>`
    : `<button class="checkin-btn" id="rr-checkin-btn" type="button" disabled>
         Opens at ${escapeHtml(windowOpenTxt)}
         <span class="checkin-meta">${escapeHtml(stationCode)} · ${escapeHtml(startsAtTxt)}</span>
       </button>`;

  slot.innerHTML = `
    ${primary}
    <button class="checkin-btn checkin-btn-tertiary" id="rr-missed-btn" type="button">Report missed day</button>`;

  if (windowOpen) {
    document.getElementById("rr-checkin-btn").addEventListener("click", () => doCheckin(session));
  }
  document.getElementById("rr-missed-btn").addEventListener("click", () => doMissedDay(session));
}

async function doCheckin(session) {
  if (!confirm("Check in now?")) return;
  const btn = document.getElementById("rr-checkin-btn");
  if (!btn) return;
  if (!("geolocation" in navigator)) { toast("This device can't share location", "warn"); return; }
  btn.disabled = true;
  const orig = btn.innerHTML;
  btn.innerHTML = "Locating…";

  navigator.geolocation.getCurrentPosition(async (pos) => {
    const { latitude: lat, longitude: lng, accuracy } = pos.coords;
    btn.innerHTML = "Checking in…";
    const { data, error } = await sb.rpc("driver_checkin", {
      p_token:    session.token,
      p_lat:      lat,
      p_lng:      lng,
      p_accuracy: Math.round(accuracy || 0),
    });
    btn.disabled = false;
    btn.innerHTML = orig;
    if (error) {
      const msg = error.message || "";
      if      (msg.includes("out_of_geofence"))         toast(msg.replace(/^.*out_of_geofence:\s*/, "Too far from station: "), "warn");
      else if (msg.includes("too_early_to_checkin"))    toast(msg.replace(/^.*too_early_to_checkin:\s*/, ""), "warn");
      else if (msg.includes("no_shift_today"))          toast("No shift scheduled today", "warn");
      else if (msg.includes("geofence_not_configured")) toast("Dispatcher hasn't set the geofence yet", "warn");
      else                                              toast("Check-in failed: " + msg, "warn");
      return;
    }
    toast(data?.already_checked_in ? "Already checked in" : "Checked in ✓", "ok");
    renderCheckinCard(session);
  }, (err) => {
    btn.disabled = false;
    btn.innerHTML = orig;
    if (err.code === err.PERMISSION_DENIED) toast("Allow location to check in", "warn");
    else toast("Couldn't get location: " + err.message, "warn");
  }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 });
}

async function doCheckout(session) {
  if (!confirm("Check out?")) return;
  const btn = document.getElementById("rr-checkout-btn");
  if (btn) btn.disabled = true;
  // Geolocation is best-effort on check-out; we don't gate.
  const submit = async (lat, lng) => {
    const { error } = await sb.rpc("driver_checkout", {
      p_token: session.token, p_lat: lat ?? null, p_lng: lng ?? null,
    });
    if (btn) btn.disabled = false;
    if (error) { toast("Check-out failed: " + error.message, "warn"); return; }
    toast("Checked out ✓", "ok");
    renderCheckinCard(session);
  };
  if (!("geolocation" in navigator)) { submit(); return; }
  navigator.geolocation.getCurrentPosition(
    (pos) => submit(pos.coords.latitude, pos.coords.longitude),
    () => submit(),
    { enableHighAccuracy: false, timeout: 5000, maximumAge: 30000 },
  );
}

async function doUndoCheckout(session) {
  if (!confirm("Undo your check-out?")) return;
  const { error } = await sb.rpc("driver_undo_checkout", { p_token: session.token });
  if (error) {
    if ((error.message || "").includes("day_finalized")) {
      toast("Day already approved — contact dispatch", "warn");
    } else if ((error.message || "").includes("no_checkout_to_undo")) {
      toast("Nothing to undo", "warn");
    } else {
      toast("Couldn't undo: " + error.message, "warn");
    }
    return;
  }
  toast("Check-out undone", "ok");
  renderCheckinCard(session);
}

async function doMissedDay(session) {
  const reason = prompt(
    "Report today as missed?\n\nOptional reason for dispatch:",
    "",
  );
  if (reason === null) return; // cancelled
  const { error } = await sb.rpc("driver_report_missed_day", {
    p_token: session.token,
    p_reason: reason,
  });
  if (error) {
    if ((error.message || "").includes("already_checked_in")) {
      toast("You're already checked in", "warn");
    } else if ((error.message || "").includes("no_shift_today")) {
      toast("No shift scheduled today", "warn");
    } else {
      toast("Couldn't report: " + error.message, "warn");
    }
    return;
  }
  toast("Reported · dispatch has been notified", "ok");
  renderCheckinCard(session);
}

async function uploadDriverPhoto(file) {
  const session = readSession();
  if (!session?.token) return;
  toast("Uploading…");
  const fd = new FormData();
  fd.append("token", session.token);
  fd.append("photo", file);
  let url = `${cfg.SUPABASE_URL}/functions/v1/upload-driver-photo`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        // Supabase routes through its own auth gateway; the anon key
        // satisfies the JWT requirement, the function does its own
        // token verification.
        "Authorization": "Bearer " + cfg.SUPABASE_ANON_KEY,
        "apikey":        cfg.SUPABASE_ANON_KEY,
      },
      body: fd,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json?.photo_url) {
      toast("Upload failed: " + (json?.error || res.statusText), "warn");
      return;
    }
    writeSession({ ...session, photo_url: json.photo_url, photo_path: json.photo_path });
    toast("Photo updated", "ok");
    render(); // re-render so header chip + profile avatar pick up the new URL
  } catch (err) {
    toast("Upload failed: " + (err?.message || err), "warn");
  }
}

// ── Availability ────────────────────────────────────────────────────
const _AVAIL_DAYS = [
  { k: "mon", label: "Mon", fullLabel: "Monday" },
  { k: "tue", label: "Tue", fullLabel: "Tuesday" },
  { k: "wed", label: "Wed", fullLabel: "Wednesday" },
  { k: "thu", label: "Thu", fullLabel: "Thursday" },
  { k: "fri", label: "Fri", fullLabel: "Friday" },
  { k: "sat", label: "Sat", fullLabel: "Saturday" },
  { k: "sun", label: "Sun", fullLabel: "Sunday" },
];

async function renderAvailability() {
  const main = document.getElementById("main");
  main.innerHTML = `<div class="loader"></div>`;

  const session = readSession();
  if (!session?.token) { writeSession(null); render(); return; }

  const { data, error } = await sb.rpc("driver_get_availability", { p_token: session.token });
  if (error) {
    if (/unauthorized|revoked|inactive/i.test(error.message || "")) {
      writeSession(null); toast("Signed out — please sign in again", "warn"); render(); return;
    }
    main.innerHTML = `<div class="empty-state" style="color:var(--red)">Couldn't load availability.<br><small>${escapeHtml(error.message)}</small></div>`;
    return;
  }

  const liveDays    = new Set(Array.isArray(data?.days) ? data.days : []);
  const pendingDays = data?.pending?.days ? new Set(data.pending.days) : null;
  const picked      = new Set(pendingDays || liveDays);

  const hasPending = !!data?.pending;
  const blackout   = data?.blackout || null;
  const leadDays   = Number(data?.lead_days ?? 7);

  // Lock toggles when there's a blackout OR a pending request waiting
  // for approval. Either way the user can't submit a new one anyway.
  const locked = !!blackout || hasPending;

  const rowsHtml = _AVAIL_DAYS.map((d) => {
    const on = picked.has(d.k);
    return `
      <label class="avail-day" for="avail-tog-${d.k}" ${locked ? `style="opacity:.55;pointer-events:none"` : ""}>
        <span class="avail-day-name">${escapeHtml(d.fullLabel)}</span>
        <span class="avail-toggle ${on ? "on" : ""}">
          <input type="checkbox" id="avail-tog-${d.k}" data-rr-day="${d.k}" ${on ? "checked" : ""} ${locked ? "disabled" : ""}/>
          <span class="avail-toggle-track"><span class="avail-toggle-thumb"></span></span>
        </span>
      </label>`;
  }).join("");

  const policyText = leadDays > 0
    ? `Effective <b>${leadDays} day${leadDays === 1 ? "" : "s"}</b> after approval, for 3 weeks.`
    : `Effective immediately on approval, for 3 weeks.`;

  // Banner only appears for the two states the driver can do something
  // about: blackout (can't submit) and pending (waiting on approval).
  // Approved/denied results land as a chat message instead — keeps the
  // page clean once a decision is made.
  let bannerHtml = "";
  if (blackout) {
    bannerHtml = `<div class="avail-banner denied">
      <div class="avail-banner-title">Submissions paused${blackout.reason ? " · " + escapeHtml(blackout.reason) : ""}</div>
      <div class="avail-banner-sub">Availability changes are blocked through ${escapeHtml(_fmtAvailDate(blackout.end_date))}.</div>
    </div>`;
  } else if (hasPending) {
    bannerHtml = `<div class="avail-banner pending">
      <div class="avail-banner-title">Request pending review</div>
      <div class="avail-banner-sub">You'll get a message when your dispatcher decides.</div>
    </div>`;
  }

  main.innerHTML = `
    <div class="avail-page">
      ${bannerHtml ? `<div id="avail-banner-slot">${bannerHtml}</div>` : ""}
      <section class="avail-list" id="avail-list">${rowsHtml}</section>
      <button class="checkin-btn" id="avail-submit" type="button" ${locked ? "disabled" : ""}>
        ${locked ? "Submission paused" : "Submit"}
      </button>
      <div class="avail-policy">${policyText}</div>
    </div>`;

  const listEl   = document.getElementById("avail-list");
  const submitEl = document.getElementById("avail-submit");

  let _inFlight = 0;
  window._rrAvailInFlight = () => _inFlight > 0;

  listEl.addEventListener("change", (e) => {
    const cb = e.target.closest("input[data-rr-day]");
    if (!cb) return;
    const dk = cb.dataset.rrDay;
    if (cb.checked) picked.add(dk); else picked.delete(dk);
    cb.closest(".avail-toggle").classList.toggle("on", cb.checked);
  });

  submitEl.addEventListener("click", async () => {
    if (locked) {
      if (hasPending) toast("You already have a pending request", "warn");
      else if (blackout) toast("Submissions are paused right now", "warn");
      return;
    }
    if (!confirm("Submit availability for approval?")) return;

    _inFlight++;
    submitEl.disabled = true;
    const days = _AVAIL_DAYS.filter((d) => picked.has(d.k)).map((d) => d.k);
    const { error } = await sb.rpc("driver_submit_availability", {
      p_token: session.token, p_days: days,
    });
    _inFlight--;
    if (error) {
      submitEl.disabled = false;
      if ((error.message || "").includes("availability_blackout")) {
        const reason = error.message.replace(/^.*availability_blackout:\s*/, "");
        toast("Submissions paused: " + reason, "warn");
      } else {
        toast("Submit failed: " + error.message, "warn");
      }
      return;
    }
    toast("Submitted for approval", "ok");
    // Re-render so the page reflects the new pending state (toggles
    // lock, button disables, banner shows the pending message).
    renderAvailability();
  });
}

// Refresh the Availability page on focus / visibility change so a
// dispatcher decision (which arrives via chat push) clears the
// "pending" banner without a manual reload. Registered once at module
// load; the inner guard keeps it cheap when on other routes.
function _refreshAvailabilityIfActive() {
  if (currentRoute() !== "/tasks/availability") return;
  if (typeof window._rrAvailInFlight === "function" && window._rrAvailInFlight()) return;
  renderAvailability();
}
window.addEventListener("focus", _refreshAvailabilityIfActive);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) _refreshAvailabilityIfActive();
});

function _fmtAvailDate(iso) {
  if (!iso) return "—";
  try {
    const d = new Date(iso + "T12:00:00");
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  } catch { return iso; }
}

// ── Documents ───────────────────────────────────────────────────────
// ── Tasks → Attendance: today's status + the policy ────────────────
async function renderAttendance() {
  const main = document.getElementById("main");
  main.innerHTML = `<div class="loader"></div>`;
  const session = readSession();
  if (!session?.token) { writeSession(null); render(); return; }

  // Pull the driver's current standing + their DSP's policy.  This
  // replaces the old "on the clock / off the clock" card — that lives
  // on the home Profile screen now.  The Attendance screen exists to
  // tell the driver where they stand against the rules and what those
  // rules actually are.
  const { data, error } = await sb.rpc("driver_attendance_overview",
    { p_token: session.token });

  if (error) {
    main.innerHTML = `<div class="empty-state" style="color:var(--red)">Couldn't load attendance.<br><small>${escapeHtml(error.message)}</small></div>`;
    return;
  }

  const standing = data?.standing || {};
  const policy   = data?.policy   || {};
  const enabled  = policy.enabled !== false;

  // Status banner
  let statusTitle, statusSub, statusClass;
  if (!enabled) {
    statusTitle = "No attendance policy";
    statusSub   = "Your DSP doesn't track attendance points right now.";
    statusClass = "neutral";
  } else if (standing.status === "action") {
    statusTitle = "Action — review with your leader";
    statusSub   = standing.in_first_30_days
      ? "First-30-days probation rule applied."
      : `${standing.occurrences} occurrence${standing.occurrences === 1 ? "" : "s"} in the last ${policy.decay_days} days.`;
    statusClass = "denied";
  } else if (standing.status === "warning") {
    statusTitle = "Warning";
    statusSub   = `${standing.occurrences} of ${policy.threshold_action} occurrences before formal action.`;
    statusClass = "pending";
  } else {
    statusTitle = "Good standing";
    statusSub   = standing.occurrences > 0
      ? `${standing.occurrences} occurrence${standing.occurrences === 1 ? "" : "s"} on file in the last ${policy.decay_days} days.`
      : "Clean record over the last " + policy.decay_days + " days.";
    statusClass = "approved";
  }

  // Build the policy explanation in plain terms — no toggle words, no
  // jargon.  Bullets mirror the dispatcher's policy builder so the
  // driver and the leader see the same rules.
  const counts = [];
  if (policy.count_tardy)   counts.push("late check-ins (tardies)");
  if (policy.count_callout) counts.push("callouts (you let dispatch know in advance)");
  if (policy.count_noshow)  counts.push("no-call no-shows");
  const countsText = counts.length === 0
    ? "Nothing currently counts as an occurrence — your DSP is logging events but not scoring them."
    : "An occurrence is recorded for: " + counts.join(", ") + ".";

  const ladderText = "Coaching is progressive: each occurrence in the rolling window steps you up one rung — <b>1st</b> = verbal conversation, <b>2nd</b> = written warning, <b>3rd</b> = final written warning, <b>4th</b> = termination. Older events drop off as the window scrolls forward.";

  const ncnsText = policy.ncns_terminates
    ? "<b>One no-call no-show is grounds for termination</b> — your DSP escalates NCNS instantly, even on a clean record."
    : "";

  const first30Text = policy.first_30_strict
    ? `New drivers are held to <b>zero absences</b> for their first ${policy.first_30_window_days} days.  Any callout or no-show in that window jumps straight to Action.`
    : "";

  const policyBullets = !enabled ? [] : [
    countsText,
    `Events accrue in a rolling <b>${policy.decay_days}-day</b> window. Coaching starts at occurrence <b>#${policy.threshold_warn}</b>.`,
    ladderText,
    ncnsText,
    first30Text,
  ].filter(Boolean);

  main.innerHTML = `
    <div class="avail-page">
      <div class="avail-banner ${statusClass}">
        <div class="avail-banner-title">${escapeHtml(statusTitle)}</div>
        ${statusSub ? `<div class="avail-banner-sub">${escapeHtml(statusSub)}</div>` : ""}
      </div>

      ${enabled ? `
      <div class="card">
        <div class="checkin-title" style="margin-bottom:8px">Your record</div>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px">
          <div style="background:var(--canvas);border-radius:10px;padding:10px 12px;text-align:center">
            <div style="font-size:18px;font-weight:700;color:var(--text)">${standing.tardies ?? 0}</div>
            <div style="font-size:var(--fs-xs);color:var(--text-subtle);font-weight:600;letter-spacing:.04em;text-transform:uppercase;margin-top:2px">Tardies</div>
          </div>
          <div style="background:var(--canvas);border-radius:10px;padding:10px 12px;text-align:center">
            <div style="font-size:18px;font-weight:700;color:var(--text)">${standing.callouts ?? 0}</div>
            <div style="font-size:var(--fs-xs);color:var(--text-subtle);font-weight:600;letter-spacing:.04em;text-transform:uppercase;margin-top:2px">Callouts</div>
          </div>
          <div style="background:var(--canvas);border-radius:10px;padding:10px 12px;text-align:center">
            <div style="font-size:18px;font-weight:700;color:var(--text)">${standing.noshows ?? 0}</div>
            <div style="font-size:var(--fs-xs);color:var(--text-subtle);font-weight:600;letter-spacing:.04em;text-transform:uppercase;margin-top:2px">No-shows</div>
          </div>
        </div>
      </div>` : ""}

      <section class="card">
        <div class="checkin-title" style="margin-bottom:8px">${enabled ? "How your DSP's attendance policy works" : "Attendance"}</div>
        ${enabled
          ? `<ul style="margin:0;padding-left:18px;font-size:var(--fs-md);color:var(--text-muted);line-height:1.6">
               ${policyBullets.map(b => `<li>${b}</li>`).join("")}
             </ul>`
          : `<p style="margin:0;font-size:var(--fs-md);color:var(--text-muted);line-height:1.6">Your DSP isn't running an attendance scoring policy right now.  Tardies, callouts, and no-shows are still logged on your record, but no warnings or actions are auto-generated.</p>`}
      </section>
    </div>`;
}

// ── Header helper ───────────────────────────────────────────────────
function setHeader(title, sub) {
  const t = document.getElementById("head-title");
  const s = document.getElementById("head-sub");
  if (t) t.textContent = title;
  if (s) s.textContent = sub || "";
}

// ── Boot ────────────────────────────────────────────────────────────
render();
