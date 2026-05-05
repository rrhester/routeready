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
      .then(() => syncSwSession(readSession()))
      .catch((err) => console.warn("SW reg failed:", err));
  });
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
// Top-level tabs: /schedule, /tasks, /chat, /profile.
// Sub-routes branch off /tasks and /profile (e.g. /tasks/dvir).
const routes = {
  "/schedule":          { render: renderSchedule,        tab: "/schedule" },
  "/tasks":             { render: renderTasksHub,        tab: "/tasks" },
  "/tasks/dvir-pre":    { render: renderDvirPre,         tab: "/tasks", back: "/tasks", title: "Pre-trip inspection" },
  "/tasks/dvir-post":   { render: renderDvirPost,        tab: "/tasks", back: "/tasks", title: "Post-trip inspection" },
  "/tasks/checklist":   { render: renderChecklists,      tab: "/tasks", back: "/tasks", title: "Today's checklists" },
  "/tasks/forms":       { render: renderForms,           tab: "/tasks", back: "/tasks", title: "Forms" },
  "/tasks/timeoff":     { render: renderTimeOff,         tab: "/tasks", back: "/tasks", title: "Request time off" },
  "/tasks/availability":{ render: renderAvailability,    tab: "/tasks", back: "/tasks", title: "Availability" },
  "/tasks/attendance":  { render: renderAttendance,      tab: "/tasks", back: "/tasks", title: "Attendance" },
  "/chat":              { render: renderChat,            tab: "/chat" },
  "/profile":           { render: renderProfileHub,      tab: "/profile" },
  "/settings":          { render: renderSettings,        tab: "/profile", back: "/profile", title: "Settings" },
  "/tasks/documents":   { render: renderDocuments,       tab: "/tasks",   back: "/tasks",   title: "Documents" },
};
function currentRoute() {
  const h = (location.hash || "").replace(/^#/, "");
  if (routes[h]) return h;
  return "/profile";
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

let _profileRefreshed = false;
async function refreshDriverProfile(session) {
  if (_profileRefreshed || !session?.token) return;
  _profileRefreshed = true;
  try {
    const { data, error } = await sb.rpc("driver_me", { p_token: session.token });
    if (error || !data) return;
    const photoUrl = data.photo_path
      ? `${cfg.SUPABASE_URL}/storage/v1/object/public/driver-photos/${data.photo_path}`
      : null;
    const cur = readSession();
    if (!cur) return;
    if ((cur.photo_url || null) === (photoUrl || null) &&
        (cur.name || "")     === (data.name || "")) return;
    writeSession({ ...cur, name: data.name || cur.name, photo_url: photoUrl, photo_path: data.photo_path });
    // Repaint Profile if the user is on it (the header is now a fixed
    // gear icon, no avatar to refresh there).
    if (currentRoute() === "/profile") render();
  } catch {}
}

// ── Login ───────────────────────────────────────────────────────────
function renderLogin(errorMsg) {
  document.getElementById("app").innerHTML = `
    <div class="login-screen">
      <div class="brand">
        <div class="brand-icon">RR</div>
        <div class="brand-name">RouteReady</div>
        <div class="brand-sub">Driver app</div>
      </div>
      <form class="form" id="login-form">
        ${errorMsg ? `<div class="err">${escapeHtml(errorMsg)}</div>` : ""}
        <label class="field-label">Invite code</label>
        <input class="field" id="login-code" autocomplete="one-time-code" inputmode="latin" autocapitalize="characters" maxlength="10" placeholder="Enter your code" required />
        <div class="help">You received this from dispatch during orientation.</div>
        <div style="margin-top:18px">
          <button class="btn btn-primary btn-block" type="submit">Continue</button>
        </div>
      </form>
    </div>`;
  document.getElementById("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const code = (document.getElementById("login-code").value || "").trim().toUpperCase();
    if (!code) return;
    if (code.length < 4) { renderLogin("Code looks too short. Double-check with dispatch."); return; }
    const submitBtn = e.target.querySelector('button[type="submit"]');
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = "Checking…"; }
    const { data, error } = await sb.rpc("redeem_driver_invite", { p_code: code, p_user_agent: navigator.userAgent || null });
    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = "Continue"; }
    if (error || !data?.token) {
      const m = error?.message || "";
      const msg = m.includes("invalid_or_expired_code")
        ? "Code not recognized or already used. Ask dispatch for a new one."
        : m.includes("driver_inactive")
        ? "This account isn't active. Contact dispatch."
        : "Couldn't sign you in. Try again or contact dispatch.";
      renderLogin(msg);
      return;
    }
    const newSession = {
      token:      data.token,
      driver_id:  data.driver?.id || null,
      name:       data.driver?.name || "Driver",
      station_id: data.driver?.station_id || null,
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
        <div class="title" id="head-title">RouteReady</div>
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
  setHeader("Schedule", "Your shifts");
  const main = document.getElementById("main");
  main.innerHTML = `<div class="loader"></div>`;

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
    main.innerHTML = `<div class="empty-state" style="color:var(--red)">Couldn't load schedule.<br><small>${escapeHtml(error.message)}</small></div>`;
    return;
  }

  const shifts = (data?.shifts || []).map((s) => ({
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
    main.innerHTML = `<div class="empty-state">No shifts on the schedule yet.<br>Check back after dispatch publishes.</div>`;
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
    ` : !todayShifts.length ? `<div class="empty-state">Nothing scheduled in the next 2 weeks.</div>` : ""}`;
}

function shiftCardHtml(s, isToday) {
  const dow = s.date.toLocaleDateString(undefined, { weekday: "short" });
  const day = s.date.getDate();
  const month = s.date.toLocaleDateString(undefined, { month: "short" });
  const time = (s.starts_at && s.ends_at)
    ? `${fmtTime(s.starts_at)} – ${fmtTime(s.ends_at)}`
    : "";
  const statusTag = s.status === "completed"
    ? `<span class="tag" style="background:var(--canvas)">Completed</span>`
    : `<span class="tag tag-status-confirmed">Scheduled</span>`;
  const typeTag = (s.type && s.type !== "SP")
    ? `<span class="tag" style="background:${escapeHtml(s.typeColor)}20;color:${escapeHtml(s.typeColor)}">${escapeHtml(s.type)}</span>`
    : "";
  const cushionTag = s.isCushion ? `<span class="tag" style="background:rgba(217,119,6,.12);color:var(--amber)">EX</span>` : "";
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
        <div class="meta-tags">${statusTag}${typeTag}${cushionTag}</div>
      </div>
      <svg class="chev" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
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
  setHeader("Tasks", "Today's work");
  const main = document.getElementById("main");
  // v1: hard-coded status. PR 3+ replaces with real DVIR/checklist
  // completion records.
  const cards = [
    { route: "/tasks/availability", title: "Availability",     sub: "Days you can work · subject to approval", status: null,
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>' },
    { route: "/tasks/attendance",   title: "Attendance",       sub: "Today's status · attendance policy",     status: null,
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11h6"/><path d="M9 7h6"/><path d="M9 15h4"/><rect x="3" y="3" width="18" height="18" rx="2"/></svg>' },
    { route: "/tasks/dvir-pre",  title: "Pre-trip inspection",  sub: "DVIR · required before each shift",  status: "Required",
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>' },
    { route: "/tasks/dvir-post", title: "Post-trip inspection", sub: "DVIR · log defects after the route",  status: "After shift",
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>' },
    { route: "/tasks/checklist", title: "Today's checklists",   sub: "Items dispatch needs done today",      status: "Pending",
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>' },
    { route: "/tasks/forms",     title: "Forms",                sub: "Submit incidents · respond to assigned forms", status: null,
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>' },
    { route: "/tasks/timeoff",   title: "Request time off",     sub: "Pick days · add reason",               status: null,
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/></svg>' },
    { route: "/tasks/documents", title: "Documents",            sub: "DL · DOT · insurance · uploads",       status: null,
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>' },
  ];
  main.innerHTML = cards.map(taskCardHtml).join("") + `
    <div class="empty-state" style="font-size:11px;padding:24px 8px">Preview build — flows wire up in upcoming PRs.</div>`;
  main.querySelectorAll("[data-task-route]").forEach((el) => {
    el.addEventListener("click", () => navigate(el.dataset.taskRoute));
  });
}
function taskCardHtml(c) {
  const pillCls = c.status === "Required" ? "pill-required"
                : c.status === "Pending"  ? "pill-pending"
                : c.status === "Done"     ? "pill-done"
                : "";
  return `
    <div class="task-card" data-task-route="${c.route}">
      <span class="task-icon">${c.icon}</span>
      <div class="task-text">
        <div class="task-title">${escapeHtml(c.title)}</div>
        <div class="task-sub">${escapeHtml(c.sub)}</div>
      </div>
      ${c.status ? `<span class="task-pill ${pillCls}">${escapeHtml(c.status)}</span>` : ""}
      <svg class="chev" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
    </div>`;
}

// ── DVIR pre-trip ───────────────────────────────────────────────────
function renderDvirPre() {
  document.getElementById("main").innerHTML = comingSoon(
    "Walk-around the vehicle and confirm each section.",
    "Cab · body · lights · brakes · tires · mirrors · defects + photos · sign",
  );
}

// ── DVIR post-trip ──────────────────────────────────────────────────
function renderDvirPost() {
  document.getElementById("main").innerHTML = comingSoon(
    "End-of-shift inspection.",
    "Log defects discovered on the route · attach photos · sign",
  );
}

// ── Checklists ──────────────────────────────────────────────────────
function renderChecklists() {
  document.getElementById("main").innerHTML = comingSoon(
    "Daily tasks dispatch needs you to complete.",
    "Same list every driver runs · check off as you go",
  );
}

// ── Forms ───────────────────────────────────────────────────────────
function renderForms() {
  document.getElementById("main").innerHTML = comingSoon(
    "Submit incident reports or respond to dispatch-assigned forms.",
    "Photos · text · attach to a shift",
  );
}

// ── Time off ────────────────────────────────────────────────────────
function renderTimeOff() {
  document.getElementById("main").innerHTML = comingSoon(
    "Submit time-off requests and see their status.",
    "Pick dates · add reason · track approvals",
  );
}

// ── Chat ────────────────────────────────────────────────────────────
// Polls every 8 seconds while the tab is visible. New messages arrive
// without push for now (push lands in a later PR). Mark-read fires on
// open + after every poll that returns dispatch messages.
let _chatPollTimer = null;
let _chatLastIds = new Set();
async function renderChat() {
  setHeader("Chat", "Message dispatch");
  const main = document.getElementById("main");
  main.innerHTML = `
    <div id="chat-shell">
      <div id="chat-msgs" class="chat-msgs"><div class="loader"></div></div>
      <form class="chat-composer" id="chat-form">
        <textarea id="chat-input" rows="1" placeholder="Message dispatch…" maxlength="2000"></textarea>
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
    // Enter sends, Shift+Enter newline (desktop). On phone, the "send"
    // button is the primary path; Enter inserts a newline as on iMessage.
    if (e.key === "Enter" && !e.shiftKey && window.matchMedia("(pointer:fine)").matches) {
      e.preventDefault();
      document.getElementById("chat-form").requestSubmit();
    }
  });

  // Send
  document.getElementById("chat-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const body = (ta.value || "").trim();
    if (!body) return;
    ta.value = "";
    ta.style.height = "auto";
    const { error } = await sb.rpc("driver_chat_send", { p_token: session.token, p_body: body });
    if (error) { toast("Couldn't send: " + error.message, "warn"); return; }
    await refreshChat(true);
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
    refreshChat(false);
  }, 8000);
}

async function refreshChat(scrollToBottom) {
  const session = readSession();
  if (!session?.token) return;
  const { data, error } = await sb.rpc("driver_chat_list", { p_token: session.token, p_limit: 200 });
  if (error) {
    if (/unauthorized|revoked|inactive/.test(error.message || "")) {
      writeSession(null); render(); return;
    }
    return;
  }
  const wrap = document.getElementById("chat-msgs");
  if (!wrap) return;
  const messages = data?.messages || [];
  if (messages.length === 0) {
    wrap.innerHTML = `<div class="empty-state">No messages yet.<br>Start a thread with dispatch below.</div>`;
  } else {
    wrap.innerHTML = messages.map(chatBubbleHtml).join("");
  }
  if (scrollToBottom) wrap.scrollTop = wrap.scrollHeight;

  // Drop the badge to 0 — they're looking at the chat.
  setAppBadge(0);

  // Mark-read whenever there's at least one dispatch message
  if (messages.some((m) => m.sender_kind === "dispatch")) {
    sb.rpc("driver_chat_mark_read", { p_token: session.token }).catch(() => {});
  }
}

function chatBubbleHtml(m) {
  const mine = m.sender_kind === "driver";
  const t = new Date(m.created_at);
  const time = t.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `
    <div class="chat-bubble ${mine ? "mine" : "theirs"}">
      <div class="chat-body">${escapeHtml(m.body).replace(/\n/g, "<br>")}</div>
      <div class="chat-time">${escapeHtml(time)}</div>
    </div>`;
}

// ── Profile hub ─────────────────────────────────────────────────────
function renderProfileHub() {
  const session = readSession();
  const name = session?.name || "Driver";
  setHeader("Profile", "Your info");
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
      <div class="profile-meta">${session?.photo_url ? "Tap photo to change" : "Tap photo to add one"}</div>
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
function renderSettings() {
  const main = document.getElementById("main");
  const session = readSession();
  const name = session?.name || "Driver";
  main.innerHTML = `
    <div class="settings-page">
      <div class="settings-section">
        <div class="settings-row">
          <div>
            <div class="settings-label">Signed in as</div>
            <div class="settings-value">${escapeHtml(name)}</div>
          </div>
        </div>
      </div>

      <button class="btn btn-block btn-danger" id="rr-signout" style="margin-top:18px">Sign out</button>
    </div>`;

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
        </div>`;
      return;
    }
    slot.innerHTML = `
      <div class="checkin-row checked-in">
        <div>
          <div class="checkin-title">Checked in · ${escapeHtml(inT)}</div>
          <div class="checkin-sub">${escapeHtml(stationCode)} · shift started ${escapeHtml(startsAtTxt)}</div>
        </div>
      </div>
      <button class="checkin-btn checkin-btn-secondary" id="rr-checkout-btn" type="button">
        Check out
        <span class="checkin-meta">Tap when your shift ends</span>
      </button>`;
    document.getElementById("rr-checkout-btn").addEventListener("click", () => doCheckout(session));
    return;
  }

  // Not checked in. Show check-in (gated by window) + missed-day button.
  if (!shift.has_geofence) {
    slot.innerHTML = `
      <div class="checkin-row">
        <div>
          <div class="checkin-title">Check-in unavailable</div>
          <div class="checkin-sub">Your dispatcher hasn't set the geofence for ${escapeHtml(stationCode)} yet.</div>
        </div>
      </div>
      <button class="checkin-btn checkin-btn-tertiary" id="rr-missed-btn" type="button">
        Report missed day
        <span class="checkin-meta">Let dispatch know you can't make it</span>
      </button>`;
    document.getElementById("rr-missed-btn").addEventListener("click", () => doMissedDay(session));
    return;
  }

  const windowOpen = !!status.window_is_open;
  const lead       = Number(shift.checkin_lead_minutes ?? 15);
  const primary    = windowOpen
    ? `<button class="checkin-btn" id="rr-checkin-btn" type="button">
         Check in for shift
         <span class="checkin-meta">${escapeHtml(stationCode)} · ${escapeHtml(startsAtTxt)}</span>
       </button>`
    : `<button class="checkin-btn" id="rr-checkin-btn" type="button" disabled>
         Check in opens at ${escapeHtml(windowOpenTxt)}
         <span class="checkin-meta">Up to ${lead} minutes before shift · ${escapeHtml(startsAtTxt)}</span>
       </button>`;

  slot.innerHTML = `
    ${primary}
    <button class="checkin-btn checkin-btn-tertiary" id="rr-missed-btn" type="button">
      Report missed day
      <span class="checkin-meta">Let dispatch know you can't make it</span>
    </button>
    <div class="checkin-policy">Must be at the station to check in.</div>`;

  if (windowOpen) {
    document.getElementById("rr-checkin-btn").addEventListener("click", () => doCheckin(session));
  }
  document.getElementById("rr-missed-btn").addEventListener("click", () => doMissedDay(session));
}

async function doCheckin(session) {
  if (!confirm("Check in for your shift now?")) return;
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
  if (!confirm("Check out for your shift?")) return;
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

async function doMissedDay(session) {
  const reason = prompt(
    "Report today as a missed day?\n\nDispatch will be notified. Optional reason:",
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
    ? `Approved availability changes go into effect <b>${leadDays} day${leadDays === 1 ? "" : "s"}</b> after approval and are effective for <b>3 weeks</b>. You'll be notified by message.`
    : `Approved availability changes are effective immediately for <b>3 weeks</b>. You'll be notified by message.`;

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
        Submit availability
        <span class="checkin-meta">${locked ? "Pending or paused" : "Subject to dispatcher approval"}</span>
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
    if (!confirm("Submit your availability for approval?")) return;

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
    toast("Submitted · subject to approval. We'll notify you.", "ok");
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

  const [statusRes, settingsRes] = await Promise.all([
    sb.rpc("driver_checkin_status",       { p_token: session.token }),
    sb.rpc("driver_attendance_settings",  { p_token: session.token }),
  ]);

  if (statusRes.error || settingsRes.error) {
    main.innerHTML = `<div class="empty-state" style="color:var(--red)">Couldn't load attendance.<br><small>${escapeHtml((statusRes.error || settingsRes.error).message)}</small></div>`;
    return;
  }

  const status   = statusRes.data || {};
  const settings = settingsRes.data || {};
  const lead     = Number(settings.checkin_lead_minutes ?? 15);
  const grace    = Number(settings.tardy_grace_minutes  ?? 10);
  const ncns     = Number(settings.ncns_after_minutes   ?? 60);

  const shift = status.shift;
  const chk   = status.checkin;

  let statusLine, statusClass;
  if (!shift) {
    statusLine = "No shift scheduled today.";
    statusClass = "neutral";
  } else if (chk?.checked_out_at) {
    statusLine = `Shift complete · checked out ${new Date(chk.checked_out_at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
    statusClass = "approved";
  } else if (chk?.checked_in_at) {
    statusLine = `Checked in · ${new Date(chk.checked_in_at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
    statusClass = "approved";
  } else if (chk?.missed_reported_at) {
    statusLine = `Missed day reported · dispatch notified`;
    statusClass = "denied";
  } else {
    statusLine = `Scheduled · shift starts ${shift.starts_at ? new Date(shift.starts_at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : "—"}`;
    statusClass = "pending";
  }

  main.innerHTML = `
    <div class="avail-page">
      <div class="avail-banner ${statusClass}">
        <div class="avail-banner-title">Today's status</div>
        <div class="avail-banner-sub">${escapeHtml(statusLine)}</div>
      </div>

      <section class="avail-list" style="display:block;padding:14px 16px">
        <div class="checkin-title" style="margin-bottom:8px">Attendance policy</div>
        <ul style="margin:0;padding-left:18px;font-size:13px;color:var(--text-muted);line-height:1.55">
          <li>Check in opens <b>${lead} minute${lead === 1 ? "" : "s"}</b> before your shift starts. You must be at the station.</li>
          <li>If you can't make it, tap <b>Report missed day</b> on your home screen so dispatch knows in advance.</li>
          <li>If you haven't checked in by your shift start, you're marked <b>tardy</b> after a <b>${grace}-minute</b> grace.</li>
          <li>If you still haven't checked in or reported by <b>${ncns} minute${ncns === 1 ? "" : "s"}</b> after your shift starts, it counts as a <b>no-call no-show</b>.</li>
          <li>Check out from your home screen when your shift ends.</li>
        </ul>
      </section>
    </div>`;
}

function renderDocuments() {
  document.getElementById("main").innerHTML = comingSoon(
    "Upload renewals when documents are about to expire.",
    "Driver's license · DOT medical · insurance · misc",
  );
}

// ── Coming-soon block ───────────────────────────────────────────────
function comingSoon(line, second) {
  return `
    <div class="coming-soon">
      <div class="badge">Preview</div>
      <div style="font-size:14px;color:var(--text);font-weight:600;margin-bottom:6px">${escapeHtml(line)}</div>
      <div>${escapeHtml(second)}</div>
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
