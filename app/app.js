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
  "/chat":              { render: renderChat,            tab: "/chat" },
  "/profile":           { render: renderProfileHub,      tab: "/profile" },
  "/profile/availability": { render: renderAvailability, tab: "/profile", back: "/profile", title: "Availability" },
  "/profile/documents": { render: renderDocuments,       tab: "/profile", back: "/profile", title: "Documents" },
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
    // Repaint header chip + profile if the user is on Profile.
    const chip = document.getElementById("driver-chip");
    if (chip) chip.innerHTML = avatarHtml(readSession(), "avatar");
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
      <button class="driver-chip" id="driver-chip" type="button" title="Profile">
        ${avatarHtml(session, "avatar")}
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
  document.getElementById("driver-chip").addEventListener("click", () => navigate("/profile"));
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
  const cards = [
    { route: "/profile/availability", title: "Availability",   sub: "Days you can work",
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>' },
    { route: "/profile/documents",    title: "Documents",      sub: "DL · DOT · insurance · uploads",
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>' },
  ];
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
    ${cards.map(taskCardHtml).join("")}
    <button class="btn btn-block btn-danger" id="rr-signout" style="margin-top:18px">Sign out</button>`;

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

  main.querySelectorAll("[data-task-route]").forEach((el) => {
    el.addEventListener("click", () => navigate(el.dataset.taskRoute));
  });
  main.querySelector("#rr-signout").addEventListener("click", async () => {
    if (!confirm("Sign out of RouteReady?")) return;
    const session = readSession();
    await teardownPushSubscription(session);
    if (session?.token) {
      try { await sb.rpc("driver_signout", { p_token: session.token }); } catch {}
    }
    writeSession(null);
    syncSwSession(null);
    location.hash = "";
    render();
  });
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

  // The toggle state shows the driver's "intended" availability — which
  // is the pending request if there is one, otherwise the live approved
  // set. Either way, every flip submits a new pending request.
  const liveDays    = new Set(Array.isArray(data?.days) ? data.days : []);
  const pendingDays = data?.pending?.days ? new Set(data.pending.days) : null;
  const picked      = new Set(pendingDays || liveDays);

  const lastDecision = data?.last_decision || null;
  const hasPending   = !!data?.pending;
  const blackout     = data?.blackout || null;
  const leadDays     = Number(data?.lead_days ?? 7);

  function statusBannerHtml() {
    if (blackout) {
      return `<div class="avail-banner denied">
        <div class="avail-banner-title">Submissions paused${blackout.reason ? " · " + escapeHtml(blackout.reason) : ""}</div>
        <div class="avail-banner-sub">Availability changes are blocked through ${escapeHtml(_fmtAvailDate(blackout.end_date))}. Toggles below are read-only until then.</div>
      </div>`;
    }
    if (hasPending) {
      return `<div class="avail-banner pending">
        <div class="avail-banner-title">Request pending review</div>
        <div class="avail-banner-sub">Your dispatcher will approve or deny this. The current schedule keeps your last approved availability until then.</div>
      </div>`;
    }
    if (lastDecision?.status === "approved" && lastDecision.effective_until) {
      const fromTxt = lastDecision.effective_from ? ` from ${_fmtAvailDate(lastDecision.effective_from)}` : "";
      return `<div class="avail-banner approved">
        <div class="avail-banner-title">Approved${escapeHtml(fromTxt)} through ${escapeHtml(_fmtAvailDate(lastDecision.effective_until))}</div>
        <div class="avail-banner-sub">Flip a toggle to request a change.</div>
      </div>`;
    }
    if (lastDecision?.status === "denied") {
      const note = lastDecision.decision_note ? ` · "${lastDecision.decision_note}"` : "";
      return `<div class="avail-banner denied">
        <div class="avail-banner-title">Last request was denied${escapeHtml(note)}</div>
        <div class="avail-banner-sub">Flip a toggle to submit a new request.</div>
      </div>`;
    }
    return `<div class="avail-banner neutral">
      <div class="avail-banner-title">Set your weekly availability</div>
      <div class="avail-banner-sub">Flip the days you can work. Your dispatcher will review and approve.</div>
    </div>`;
  }

  const rowsHtml = _AVAIL_DAYS.map((d) => {
    const on = picked.has(d.k);
    return `
      <label class="avail-day" for="avail-tog-${d.k}" ${blackout ? `style="opacity:.5;pointer-events:none"` : ""}>
        <span class="avail-day-name">${escapeHtml(d.fullLabel)}</span>
        <span class="avail-toggle ${on ? "on" : ""}">
          <input type="checkbox" id="avail-tog-${d.k}" data-rr-day="${d.k}" ${on ? "checked" : ""} ${blackout ? "disabled" : ""}/>
          <span class="avail-toggle-track"><span class="avail-toggle-thumb"></span></span>
        </span>
      </label>`;
  }).join("");

  const policyText = leadDays > 0
    ? `Approved availability changes go into effect <b>${leadDays} day${leadDays === 1 ? "" : "s"}</b> after approval and are effective for <b>3 weeks</b>.`
    : `Approved availability changes are effective immediately for <b>3 weeks</b>.`;

  main.innerHTML = `
    <div class="avail-page">
      <div id="avail-banner-slot">${statusBannerHtml()}</div>

      <section class="avail-list" id="avail-list">${rowsHtml}</section>

      <div class="avail-policy">${policyText}</div>
    </div>`;

  const listEl   = document.getElementById("avail-list");
  const bannerEl = document.getElementById("avail-banner-slot");

  // Submit on every flip, debounced so rapid taps coalesce into one
  // server round-trip. Optimistic UI: the toggle moves immediately;
  // we only revert if the server rejects.
  let _saveTimer = null;
  let _saveSeq   = 0;
  let _inFlight  = 0;

  function submitNow() {
    const seq = ++_saveSeq;
    _inFlight++;
    const days = _AVAIL_DAYS.filter((d) => picked.has(d.k)).map((d) => d.k);
    sb.rpc("driver_submit_availability", { p_token: session.token, p_days: days })
      .then(({ error }) => {
        _inFlight--;
        if (seq !== _saveSeq) return;
        if (error) {
          // Server-enforced blackout — re-render so the toggles lock and
          // the banner switches; surface the reason in a toast.
          if ((error.message || "").includes("availability_blackout")) {
            const reason = error.message.replace(/^.*availability_blackout:\s*/, "");
            toast("Submissions paused: " + reason, "warn");
            renderAvailability();
            return;
          }
          toast("Save failed: " + error.message, "warn");
          return;
        }
        bannerEl.innerHTML = `<div class="avail-banner pending">
          <div class="avail-banner-title">Request submitted · awaiting approval</div>
          <div class="avail-banner-sub">Your dispatcher will approve or deny this. Current schedule stays on your last approved availability until then.</div>
        </div>`;
      })
      .catch(() => { _inFlight--; });
  }

  // Expose the in-flight/save state on the window so the page-level
  // focus listener (registered once at boot) can decide whether it's
  // safe to re-render and pick up a fresh decision from the server.
  window._rrAvailInFlight = () => _inFlight > 0 || _saveTimer != null;

  listEl.addEventListener("change", (e) => {
    const cb = e.target.closest("input[data-rr-day]");
    if (!cb) return;
    const dk = cb.dataset.rrDay;
    if (cb.checked) picked.add(dk); else picked.delete(dk);
    cb.closest(".avail-toggle").classList.toggle("on", cb.checked);
    if (_saveTimer) clearTimeout(_saveTimer);
    _saveTimer = setTimeout(submitNow, 350);
  });
}

// Refresh the Availability page on focus / visibility change so a
// dispatcher decision (which arrives via chat push) clears the
// "pending" banner without a manual reload. Registered once at module
// load; the inner guard keeps it cheap when on other routes.
function _refreshAvailabilityIfActive() {
  if (currentRoute() !== "/profile/availability") return;
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
