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
    navigator.serviceWorker.register("./sw.js").catch((err) => console.warn("SW reg failed:", err));
  });
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
const routes = {
  "/schedule":     renderSchedule,
  "/availability": renderAvailability,
  "/timeoff":      renderTimeOff,
  "/chat":         renderChat,
};
function currentRoute() {
  const h = (location.hash || "").replace(/^#/, "");
  if (routes[h]) return h;
  return "/schedule";
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
  const route = currentRoute();
  routes[route]();
  document.querySelectorAll(".tab").forEach((t) => {
    t.classList.toggle("active", t.dataset.route === route);
  });
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
    // STUB for v1: accept any code, create a fake session. Real
    // redemption RPC + SMS verification lands in PR 2.
    if (code.length < 4) { renderLogin("Code looks too short. Double-check with dispatch."); return; }
    writeSession({
      driver_id: null,
      name: "Driver",
      code, // remember which code they used so we can swap it for a real session in PR 2
      stub: true,
    });
    toast("Welcome — this is a preview build", "ok");
    navigate("/schedule");
  });
}

// ── Shell (header + tabs) ───────────────────────────────────────────
function renderShell(session) {
  const name = session?.name || "Driver";
  document.getElementById("app").innerHTML = `
    <header class="app-head">
      <div>
        <div class="title" id="head-title">RouteReady</div>
        <div class="sub" id="head-sub"></div>
      </div>
      <button class="driver-chip" id="driver-chip" type="button" title="Sign out">
        <span class="avatar">${escapeHtml(initialsOf(name))}</span>
        <span>${escapeHtml(name)}</span>
      </button>
    </header>
    <main id="main"><div class="loader"></div></main>
    <nav class="tabbar" role="tablist">
      <button class="tab" data-route="/schedule" role="tab" aria-label="Schedule">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
        Schedule
      </button>
      <button class="tab" data-route="/availability" role="tab" aria-label="Availability">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
        Available
      </button>
      <button class="tab" data-route="/timeoff" role="tab" aria-label="Time off">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M5 22V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v18l-7-3z"/></svg>
        Time off
      </button>
      <button class="tab" data-route="/chat" role="tab" aria-label="Chat">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        Chat
      </button>
    </nav>`;

  document.querySelectorAll(".tab").forEach((t) => {
    t.addEventListener("click", () => navigate(t.dataset.route));
  });
  document.getElementById("driver-chip").addEventListener("click", () => {
    if (!confirm("Sign out of RouteReady?")) return;
    writeSession(null);
    location.hash = "";
    render();
  });
}

// ── Schedule ────────────────────────────────────────────────────────
function renderSchedule() {
  setHeader("Schedule", "Your shifts");
  const main = document.getElementById("main");
  // PR 2 fetches real shifts via a driver_my_schedule RPC. v1 ships
  // sample placeholders so the operator can feel the layout on a phone.
  const today = new Date();
  const sample = [
    { date: today, time: "11:20 AM – 9:20 PM", station: "DCA1 · Capitol Heights", status: "Confirmed", today: true },
    { date: addDays(today, 1), time: "11:45 AM – 9:45 PM", station: "DCA1 · Capitol Heights", status: "Confirmed" },
    { date: addDays(today, 2), time: "11:20 AM – 9:20 PM", station: "DCA1 · Capitol Heights", status: "Confirmed" },
    { date: addDays(today, 4), time: "11:45 AM – 9:45 PM", station: "DCA1 · Capitol Heights", status: "Confirmed" },
  ];
  if (sample.length === 0) {
    main.innerHTML = `<div class="empty-state">No shifts on the schedule yet.<br>Check back after dispatch publishes.</div>`;
    return;
  }
  const todayCard = sample.find((s) => s.today);
  const upcoming  = sample.filter((s) => !s.today);
  main.innerHTML = `
    ${todayCard ? `
      <div class="section-title">Today</div>
      ${shiftCardHtml(todayCard, true)}
    ` : ""}
    <div class="section-title">Upcoming</div>
    ${upcoming.map((s) => shiftCardHtml(s, false)).join("") || `<div class="empty-state">Nothing scheduled.</div>`}
    <div class="empty-state" style="font-size:11px;padding:24px 8px">Preview build — real shifts wire up in PR 2.</div>`;
}

function shiftCardHtml(s, isToday) {
  const dow = s.date.toLocaleDateString(undefined, { weekday: "short" });
  const day = s.date.getDate();
  const month = s.date.toLocaleDateString(undefined, { month: "short" });
  return `
    <div class="shift-card ${isToday ? "is-today" : ""}">
      <div class="date-block">
        <div class="date-dow">${dow}</div>
        <div class="date-day">${day}</div>
        <div class="date-month">${month}</div>
      </div>
      <div>
        <div class="meta-time">${escapeHtml(s.time)}</div>
        <div class="meta-station">${escapeHtml(s.station)}</div>
        <div class="meta-tags"><span class="tag tag-status-confirmed">${escapeHtml(s.status)}</span></div>
      </div>
      <svg class="chev" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
    </div>`;
}

function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }

// ── Availability ────────────────────────────────────────────────────
function renderAvailability() {
  setHeader("Availability", "Days you can work");
  document.getElementById("main").innerHTML = comingSoon(
    "Mark which days you can work and which you prefer.",
    "Available · Preferred · Notes",
  );
}

// ── Time off ────────────────────────────────────────────────────────
function renderTimeOff() {
  setHeader("Time off", "Request days off");
  document.getElementById("main").innerHTML = comingSoon(
    "Submit time-off requests and see their status.",
    "Pick dates · Add reason · Track approvals",
  );
}

// ── Chat ────────────────────────────────────────────────────────────
function renderChat() {
  setHeader("Chat", "Message dispatch");
  document.getElementById("main").innerHTML = comingSoon(
    "A single rolling conversation between you and dispatch.",
    "Two-way messages · Push notifications when a reply comes in",
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
