// Generates the static mockup screens (screens/*.html) from shared chrome
// partials so the tab bar / status bar / app bar stay identical across
// every screen. MOCKUP TOOLING ONLY — never imported by the app.
//   node design/driver-app-redesign/mockups/build.mjs
import { writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "screens");
mkdirSync(OUT, { recursive: true });

/* ── SVG helpers ─────────────────────────────────────────────────── */
const svg = (paths, size = 20, sw = 1.8) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

const I = {
  today: (s) => svg('<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/><circle cx="12" cy="15.5" r="2.4" fill="currentColor" stroke="none"/>', s),
  sched: (s) => svg('<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>', s),
  tasks: (s) => svg('<path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/><path d="m9 14 2 2 4-4"/>', s),
  msg: (s) => svg('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>', s),
  more: (s) => svg('<circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="9.2"/>', s),
  check: (s) => svg('<polyline points="20 6 9 17 4 12"/>', s, 2.4),
  clock: (s) => svg('<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>', s),
  chev: (s) => svg('<polyline points="9 18 15 12 9 6"/>', s, 2),
  back: (s) => svg('<polyline points="15 18 9 12 15 6"/>', s, 2.2),
  alert: (s) => svg('<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>', s),
  info: (s) => svg('<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>', s),
  pin: (s) => svg('<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>', s),
  truck: (s) => svg('<path d="M10 17h4V5H2v12h3"/><path d="M20 17h2v-3.34a4 4 0 0 0-1.17-2.83L19 9h-5v8h1"/><circle cx="7.5" cy="17.5" r="2"/><circle cx="17.5" cy="17.5" r="2"/>', s),
  cam: (s) => svg('<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>', s),
  file: (s) => svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>', s),
  form: (s) => svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="13" y2="17"/>', s),
  phone: (s) => svg('<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>', s),
  user: (s) => svg('<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>', s),
  users: (s) => svg('<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>', s),
  gear: (s) => svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>', s),
  wifioff: (s) => svg('<line x1="1" y1="1" x2="23" y2="23"/><path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55"/><path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39"/><path d="M10.71 5.05A16 16 0 0 1 22.58 9"/><path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12" y2="20"/>', s, 2),
  refresh: (s) => svg('<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>', s),
  shield: (s) => svg('<path d="M12 2 4 5v6c0 5 3.5 9 8 11 4.5-2 8-6 8-11V5l-8-3z"/>', s),
  coffee: (s) => svg('<path d="M18 8h1a4 4 0 0 1 0 8h-1"/><path d="M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V8z"/><line x1="6" y1="1" x2="6" y2="4"/><line x1="10" y1="1" x2="10" y2="4"/><line x1="14" y1="1" x2="14" y2="4"/>', s),
  flag: (s) => svg('<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/>', s),
  swap: (s) => svg('<polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>', s),
  doc: (s) => svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="15" y2="17"/>', s),
  cal: (s) => svg('<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>', s),
  sun: (s) => svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>', s),
  scan: (s) => svg('<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><rect x="7" y="8" width="10" height="8" rx="1"/>', s),
  bell: (s) => svg('<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>', s),
  key: (s) => svg('<path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4"/>', s),
  out: (s) => svg('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>', s),
  megaphone: (s) => svg('<path d="m3 11 18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/>', s),
  x: (s) => svg('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>', s, 2.2),
};

/* ── Chrome partials ─────────────────────────────────────────────── */
const statusbar = `
<div class="statusbar">
  <span>8:42</span>
  <span class="sb-icons">
    ${svg('<path d="M2 20h2v-4H2zM7 20h2v-8H7zM12 20h2V8h-2zM17 20h2V4h-2z" fill="currentColor" stroke="none"/>', 15, 0)}
    ${svg('<path d="M5 12.55a11 11 0 0 1 14.08 0M8.5 15.5a6 6 0 0 1 7 0M12 19h.01"/>', 15, 2)}
    ${svg('<rect x="1" y="7" width="18" height="10" rx="2.5"/><rect x="3" y="9" width="12" height="6" rx="1" fill="currentColor" stroke="none"/><path d="M21 10.5v3" stroke-width="2"/>', 20, 1.5)}
  </span>
</div>`;

const tabIcons = {
  today: I.today(22), sched: I.sched(22), tasks: I.tasks(22), msg: I.msg(22), more: I.more(22),
};
function tabbar(active, { tasksBadge = 2, msgBadge = 1, msgUrgent = true, offline = false } = {}) {
  const tab = (id, label) => `
    <a class="tab${active === id ? " on" : ""}" href="#" aria-label="${label}${active === id ? " (current)" : ""}">
      ${id === "tasks" && tasksBadge ? `<span class="tab-badge">${tasksBadge}</span>` : ""}
      ${id === "msg" && msgBadge ? `<span class="tab-badge${msgUrgent ? " urgent" : ""}">${msgBadge}</span>` : ""}
      ${tabIcons[id]}${label}
    </a>`;
  return `
<nav class="tabbar${offline ? " offline-dim" : ""}" role="tablist">
  ${tab("today", "Today")}
  ${tab("sched", "Schedule")}
  ${tab("tasks", "Tasks")}
  ${tab("msg", "Messages")}
  ${tab("more", "More")}
</nav>
<div class="homebar"></div>`;
}

function appbar({ eyebrow = "Summit Logistics · DAU5", title = "Today", date = "Mon, Jul 13", conn = "ok", back = null, pill = "", avatar = "MR" } = {}) {
  const connHtml = conn === "none" ? ""
    : conn === "off"
      ? `<span class="conn off"><span class="dot"></span>Offline</span>`
      : conn === "sync"
        ? `<span class="conn"><span class="dot" style="background:var(--amber)"></span>Syncing</span>`
        : `<span class="conn"><span class="dot"></span>Synced</span>`;
  return `
<header class="appbar">
  ${back === null && eyebrow ? `<div class="appbar-eyebrow">${eyebrow}</div>` : ""}
  <div class="appbar-row">
    ${back !== null ? `<button class="appbar-back" aria-label="Back">${I.back(22)}</button>` : ""}
    <div class="appbar-title"><span class="title-text">${title}</span>${pill}</div>
    <div class="appbar-spacer"></div>
    ${date ? `<span class="appbar-date">${date}</span>` : ""}
    ${connHtml}
    ${avatar ? `<span class="appbar-avatar">${avatar}</span>` : ""}
  </div>
</header>`;
}

function page({ name, title, body, active = "today", cta = "", tabOpts = {}, offlineStrip = false, appbarOpts = {}, bodyClass = "" }) {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${title} · RouteReady Driver mockup</title>
<link rel="stylesheet" href="../mockups/rr-mobile.css">
</head>
<body${bodyClass ? ` class="${bodyClass}"` : ""}>
<div class="phone">
${statusbar}
${appbar(appbarOpts)}
${offlineStrip ? `<div class="offline-strip">${I.wifioff(15)}<span>You're offline — working from saved data</span><span class="spacer"></span><a class="strip-link" href="#">Details</a></div>` : ""}
${body}
${cta}
${tabbar(active, tabOpts)}
</div>
</body>
</html>`;
  writeFileSync(join(OUT, name + ".html"), html);
  console.log("built", name);
}

/* ── Reusable content blocks ─────────────────────────────────────── */
const rail = (stage, blocked = false) => {
  // stages: 1 check-in · 2 inspect · 3 drive · 4 check-out
  const segs = [1, 2, 3, 4].map((i) => {
    if (i < stage) return `<span class="rail-seg done"></span>`;
    if (i === stage) return `<span class="rail-seg ${blocked ? "blocked" : "cur"}"></span>`;
    return `<span class="rail-seg"></span>`;
  }).join("");
  const lbl = (i, txt) => `<span class="${i < stage ? "done" : i === stage ? "on" : ""}">${txt}</span>`;
  return `
  <div class="rail">
    <div class="rail-track">${segs}</div>
    <div class="rail-labels">${lbl(1, "Check in")}${lbl(2, "Inspect")}${lbl(3, "Drive")}${lbl(4, "Check out")}</div>
  </div>`;
};

const board = ({ station = "DAU5", route = "Standard", van = "V-214", wave = "9:35 AM", vanNote = "", missing = [] } = {}) => `
  <div class="board">
    <div class="cell"><div class="bl">Station</div><div class="bv${missing.includes("station") ? " missing" : ""}">${missing.includes("station") ? "—" : station}</div></div>
    <div class="cell"><div class="bl">Route</div><div class="bv${missing.includes("route") ? " missing" : ""}">${missing.includes("route") ? "—" : route}</div></div>
    <div class="cell"><div class="bl">Van</div><div class="bv${missing.includes("van") ? " missing" : ""}">${missing.includes("van") ? "—" : van}${vanNote ? ` <small>${vanNote}</small>` : ""}</div></div>
    <div class="cell"><div class="bl">Wave</div><div class="bv${missing.includes("wave") ? " missing" : ""}">${missing.includes("wave") ? "—" : wave}</div></div>
  </div>`;

const shiftcard = ({ pill, time = `9:20 <small>AM</small> – 6:00 <small>PM</small>`, sub, stage, blocked, boardOpts = {}, count = "", railHtml }) => `
<section class="panel shiftcard">
  <div class="sc-top">${pill}<span class="appbar-spacer"></span><span class="appbar-date">Mon, Jul 13</span></div>
  <div class="sc-time-row"><span class="sc-time">${time}</span></div>
  ${sub ? `<div class="sc-sub">${sub}</div>` : ""}
  ${railHtml !== undefined ? railHtml : rail(stage || 1, blocked)}
  ${board(boardOpts)}
  ${count}
</section>`;

const taskRow = ({ state, title, meta, pill = "", href = "#" }) => `
  <a class="row${state === "done" ? " done" : ""}" href="${href}">
    <span class="t-state ${state}">${state === "done" ? I.check(13) : state === "cur" ? svg('<circle cx="12" cy="12" r="5" fill="currentColor" stroke="none"/>', 12, 0) : state === "blocked" ? svg('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>', 12) : state === "alert" ? I.alert(12) : ""}</span>
    <span class="row-body">
      <span class="row-title">${title}</span>
      ${meta ? `<span class="row-meta">${meta}</span>` : ""}
    </span>
    <span class="row-end">${pill}<span class="chev">${I.chev(16)}</span></span>
  </a>`;

const P = {
  sched: `<span class="pill navy"><span class="pdot"></span>Scheduled</span>`,
  ready: `<span class="pill blue"><span class="pdot"></span>Ready to check in</span>`,
  onduty: `<span class="pill green"><span class="pdot"></span>On duty</span>`,
  checkout: `<span class="pill amber"><span class="pdot"></span>Check-out · 2 items left</span>`,
  complete: `<span class="pill green">${I.check(11)}Complete</span>`,
  none: `<span class="pill"><span class="pdot"></span>No shift today</span>`,
};

/* ═════════════════════ 01 · Today — scheduled ═══════════════════ */
page({
  name: "01-today-scheduled",
  title: "Today — scheduled",
  body: `
<main class="main has-cta">
  ${shiftcard({
    pill: P.sched, stage: 1,
    sub: `Check-in opens <b>8:20 AM</b> · Wave departs <b>9:35 AM</b>`,
    count: `<div class="count"><span class="c-label">Shift starts in</span><span class="c-val">2h 38m</span></div>`,
  })}

  <div class="notice danger">
    ${I.alert(17)}
    <div>
      <div class="n-title">Safety notice — acknowledge before your wave</div>
      <div class="n-body">Ice reported on the Ranch Rd 620 bridge. Reduce speed and report incidents immediately.</div>
      <div class="n-act"><button class="btn btn-sm btn-primary">Acknowledge</button><button class="btn btn-sm btn-quiet">Read more</button></div>
    </div>
  </div>

  <div class="sec">Before your shift <span class="sec-n">1 of 3</span></div>
  <div class="panel">
    ${taskRow({ state: "done", title: "Confirm your shift", meta: "Confirmed yesterday, 4:12 PM" })}
    ${taskRow({ state: "alert", title: "Acknowledge safety notice", meta: "Sent by dispatch · 7:07 AM", pill: `<span class="pill red">Required</span>` })}
    ${taskRow({ state: "blocked", title: "Pre-trip inspection", meta: "Available after you check in", pill: `<span class="pill">12 items</span>` })}
  </div>

  <div class="sec">Up next <span class="sec-link">Schedule</span></div>
  <div class="panel">
    <div class="shift-row">
      <span class="sr-date"><span class="sr-dw">Tue</span><span class="sr-dn">14</span></span>
      <span class="sr-body"><span class="sr-time">9:20 AM – 6:00 PM</span><span class="sr-meta">DAU5 · Van <b>V-214</b> · Standard</span></span>
      <span class="chev">${I.chev(16)}</span>
    </div>
  </div>
</main>`,
  cta: `
<div class="cta-bar">
  <button class="btn disabled" disabled>${I.clock(17)}Check-in opens at 8:20 AM</button>
  <div class="cta-note">You can check in up to 60 minutes before your shift</div>
</div>`,
});

/* ═════════════════════ 02 · Today — ready ═══════════════════════ */
page({
  name: "02-today-ready",
  title: "Today — ready to check in",
  body: `
<main class="main has-cta">
  ${shiftcard({
    pill: P.ready, stage: 1,
    sub: `Check-in closes <b>10:20 AM</b> · Wave departs <b>9:35 AM</b>`,
    count: `<div class="count"><span class="c-label">Shift starts in</span><span class="c-val">38m</span></div>`,
  })}

  <div class="panel">
    <div class="row">
      <span class="row-ic" style="color:var(--green-dark)">${I.pin(18)}</span>
      <span class="row-body">
        <span class="row-title" style="color:var(--green-dark)">You're at DAU5</span>
        <span class="row-meta">Inside the station geofence · about 40 m from the gate</span>
      </span>
      <span class="row-end"><span class="pill green">${I.check(11)}In range</span></span>
    </div>
  </div>

  <div class="sec">Before wave departure <span class="sec-n">2 of 3</span></div>
  <div class="panel">
    ${taskRow({ state: "done", title: "Acknowledge safety notice", meta: "Acknowledged 8:31 AM" })}
    ${taskRow({ state: "done", title: "Confirm your shift", meta: "Confirmed yesterday, 4:12 PM" })}
    ${taskRow({ state: "blocked", title: "Pre-trip inspection", meta: "Available after you check in · 12 items · ~4 min", pill: `<span class="pill amber">Due 9:20 AM</span>` })}
  </div>

  <div class="sec">Today's van</div>
  <div class="panel">
    <div class="row">
      <span class="row-ic">${I.truck(18)}</span>
      <span class="row-body"><span class="row-title">V-214 · staged in bay 3</span><span class="row-meta">2023 Ford Transit 250 · KHP-2314 (TX)</span></span>
      <span class="row-end"><span class="pill green">Docs OK</span><span class="chev">${I.chev(16)}</span></span>
    </div>
  </div>
</main>`,
  cta: `
<div class="cta-bar">
  <button class="btn btn-primary">${I.check(17)}Check in · 9:20 AM shift</button>
  <div class="cta-note ok">Location confirmed — you're inside the station geofence</div>
</div>`,
});

/* ════════════════ 03 · Today — on duty (pre-trip gate) ══════════ */
page({
  name: "03-today-onduty",
  title: "Today — checked in, pre-shift requirements",
  body: `
<main class="main has-cta">
  ${shiftcard({
    pill: P.onduty, stage: 2, blocked: true,
    sub: `Checked in <b>8:04 AM</b> · Wave departs <b>9:35 AM</b>`,
    count: `<div class="count"><span class="c-label">Wave departs in</span><span class="c-val">53m</span></div>`,
  })}

  <div class="notice warn">
    ${I.alert(17)}
    <div>
      <div class="n-title">Pre-trip inspection due before you leave</div>
      <div class="n-body">Fleet needs your walkaround before wave departure at 9:35 AM.</div>
    </div>
  </div>

  <div class="sec">Before wave departure <span class="sec-n">1 of 2</span></div>
  <div class="panel">
    ${taskRow({ state: "cur", title: "Pre-trip inspection", meta: "12 items · ~4 min · goes to Fleet", pill: `<span class="pill amber">Due 9:20 AM</span>` })}
    ${taskRow({ state: "done", title: "Confirm van & route", meta: "V-214 · Standard · confirmed 8:05 AM" })}
  </div>

  <div class="sec">Later today <span class="sec-n">2</span></div>
  <div class="panel">
    ${taskRow({ state: "blocked", title: "Mileage & fuel log", meta: "Available at check-out", pill: `<span class="pill">Required</span>` })}
    ${taskRow({ state: "blocked", title: "End-of-day debrief", meta: "Available after your route", pill: `<span class="pill">Optional</span>` })}
  </div>
</main>`,
  cta: `
<div class="cta-bar">
  <button class="btn btn-primary">${I.tasks(17)}Start pre-trip inspection</button>
  <div class="cta-note warn">Required before wave departure · 53 min left</div>
</div>`,
});

/* ═════════════════════ 04 · Today — active shift ════════════════ */
page({
  name: "04-today-active",
  title: "Today — active shift",
  body: `
<main class="main">
  ${shiftcard({
    pill: P.onduty, stage: 3,
    sub: `On duty <b>4h 12m</b> · return by <b>6:00 PM</b>`,
  })}

  <div class="sec">During your shift</div>
  <div class="panel">
    <div class="row">
      <span class="row-ic">${I.coffee(18)}</span>
      <span class="row-body"><span class="row-title">30-min break</span><span class="row-meta">Not started · take it before 2:00 PM</span></span>
      <span class="row-end"><button class="btn btn-sm">Start break</button></span>
    </div>
    <a class="row" href="#">
      <span class="row-ic">${I.msg(18)}</span>
      <span class="row-body"><span class="row-title">Messages</span><span class="row-meta"><b>Dispatch:</b> "Route 12 has a gate code update…"</span></span>
      <span class="row-end"><span class="pill blue">1 new</span><span class="chev">${I.chev(16)}</span></span>
    </a>
    <a class="row" href="#">
      <span class="row-ic">${I.flag(18)}</span>
      <span class="row-body"><span class="row-title">Report an issue</span><span class="row-meta">Van defect, delay, incident or blocked stop</span></span>
      <span class="row-end"><span class="chev">${I.chev(16)}</span></span>
    </a>
  </div>

  <div class="sec">Check-out readiness <span class="sec-n">1 of 3</span></div>
  <div class="panel">
    ${taskRow({ state: "done", title: "Pre-trip inspection", meta: "Submitted 9:12 AM · no defects" })}
    ${taskRow({ state: "cur", title: "Mileage & fuel log", meta: "Takes ~1 min — you can file it early", pill: `<span class="pill amber">Required</span>` })}
    ${taskRow({ state: "blocked", title: "End-of-day debrief", meta: "Available after your route", pill: `<span class="pill">Optional</span>` })}
  </div>

  <div class="divider-note">Check-out unlocks when you're back at DAU5</div>
</main>`,
});

/* ═════════════════════ 05 · Check-out — outstanding ═════════════ */
page({
  name: "05-today-checkout",
  title: "Check-out — outstanding items",
  body: `
<main class="main has-cta">
  ${shiftcard({
    pill: P.checkout, stage: 4, blocked: true,
    sub: `Back at DAU5 · on duty <b>9h 48m</b>`,
  })}

  <div class="sec">Before you check out <span class="sec-n">2 of 4</span></div>
  <div class="panel">
    ${taskRow({ state: "done", title: "Post-trip walkaround", meta: "Submitted 5:47 PM · no new damage" })}
    ${taskRow({ state: "done", title: "Return keys & fuel card", meta: "Confirmed by dispatch 5:49 PM" })}
    ${taskRow({ state: "cur", title: "Mileage & fuel log", meta: "Odometer photo + fuel level · ~1 min", pill: `<span class="pill red">Required</span>` })}
    ${taskRow({ state: "cur", title: "End-of-day debrief", meta: "3 questions about your route", pill: `<span class="pill red">Required</span>` })}
  </div>

  <div class="notice info">
    ${I.info(17)}
    <div>
      <div class="n-title">Anything to report from today?</div>
      <div class="n-body">Log delays, near-misses or customer issues before you leave — it goes straight to dispatch.</div>
      <div class="n-act"><button class="btn btn-sm">Report an issue</button></div>
    </div>
  </div>
</main>`,
  cta: `
<div class="cta-bar">
  <button class="btn disabled" disabled>Check out</button>
  <div class="cta-note warn">2 required items left — finish them to check out</div>
</div>`,
});

/* ═══════════════ 06 · Check-out — confirm (sheet) ═══════════════ */
page({
  name: "06-today-checkout-confirm",
  title: "Check-out — confirm",
  body: `
<main class="main has-cta" style="filter:blur(1px) saturate(.9);opacity:.55;pointer-events:none">
  ${shiftcard({
    pill: `<span class="pill green"><span class="pdot"></span>Ready to check out</span>`, stage: 4,
    sub: `Back at DAU5 · on duty <b>9h 48m</b>`,
  })}
  <div class="sec">Before you check out <span class="sec-n">4 of 4</span></div>
  <div class="panel">
    ${taskRow({ state: "done", title: "Post-trip walkaround", meta: "Submitted 5:47 PM" })}
    ${taskRow({ state: "done", title: "Return keys & fuel card", meta: "Confirmed 5:49 PM" })}
    ${taskRow({ state: "done", title: "Mileage & fuel log", meta: "Submitted 5:52 PM" })}
    ${taskRow({ state: "done", title: "End-of-day debrief", meta: "Submitted 5:54 PM" })}
  </div>
</main>
<div style="position:absolute;inset:0;background:rgba(15,23,42,.44);z-index:5"></div>
<div style="position:absolute;left:0;right:0;bottom:0;z-index:6;background:var(--surface);border-radius:14px 14px 0 0;box-shadow:var(--shadow-float);padding:8px 16px calc(var(--homebar-h) + 14px)">
  <div style="width:36px;height:4px;border-radius:2px;background:var(--border-strong);margin:4px auto 14px"></div>
  <div style="font-size:18px;font-weight:700;letter-spacing:-.01em">Check out at 5:56 PM?</div>
  <div style="font-size:13px;color:var(--subtle);margin:3px 0 12px">This ends your shift and notifies dispatch.</div>
  <div class="panel" style="margin-bottom:14px">
    <div class="kv"><span class="k">On duty</span><span class="v">9h 52m</span><span class="kv-end"><span class="pill green">${I.check(11)}Full shift</span></span></div>
    <div class="kv"><span class="k">Checked in</span><span class="v">8:04 AM</span></div>
    <div class="kv"><span class="k">Forms</span><span class="v">4 of 4 submitted</span></div>
    <div class="kv"><span class="k">Van V-214</span><span class="v">Returned · no new damage</span></div>
  </div>
  <button class="btn btn-primary btn-block" style="min-height:50px">Confirm check-out</button>
  <button class="btn btn-quiet btn-block" style="margin-top:6px">Not yet</button>
</div>`,
});

/* ═════════════════════ 07 · Today — complete ════════════════════ */
page({
  name: "07-today-complete",
  title: "Today — shift complete",
  body: `
<main class="main">
  <section class="panel shiftcard">
    <div class="hero-ok">
      <div class="ok-ring">${I.check(24)}</div>
      <div class="ok-title">Shift complete</div>
      <div class="ok-sub">Checked out at 6:02 PM · dispatch has been notified</div>
    </div>
    ${rail(5)}
  </section>

  <div class="sec">Today's summary</div>
  <div class="panel">
    <div class="kv"><span class="k">On duty</span><span class="v">9h 58m</span><span class="kv-end"><span class="pill green">${I.check(11)}Complete</span></span></div>
    <div class="kv"><span class="k">Checked in</span><span class="v">8:04 AM · DAU5</span></div>
    <div class="kv"><span class="k">Checked out</span><span class="v">6:02 PM · DAU5</span></div>
    <div class="kv"><span class="k">Van</span><span class="v">V-214 · returned, no defects</span></div>
    <div class="kv"><span class="k">Submitted</span><span class="v">Pre-trip · Mileage · Debrief</span></div>
  </div>

  <div class="sec">Up next</div>
  <div class="panel">
    <div class="shift-row">
      <span class="sr-date"><span class="sr-dw">Tue</span><span class="sr-dn">14</span></span>
      <span class="sr-body"><span class="sr-time">9:20 AM – 6:00 PM</span><span class="sr-meta">DAU5 · Van <b>V-214</b> · Standard</span></span>
      <span class="chev">${I.chev(16)}</span>
    </div>
  </div>

  <div style="text-align:center;margin-top:14px">
    <button class="btn btn-quiet">Undo check-out</button>
  </div>
</main>`,
});

/* ═════════════════════ 08 · Schedule ════════════════════════════ */
page({
  name: "08-schedule",
  title: "Schedule",
  active: "sched",
  appbarOpts: { title: "Schedule", date: "Jul 13 – 26" },
  body: `
<main class="main">
  <div class="panel">
    <div class="week-strip">
      <span class="d off"><span class="dw">S</span><span class="dn">12</span></span>
      <span class="d has today"><span class="dw">M</span><span class="dn">13</span></span>
      <span class="d has"><span class="dw">T</span><span class="dn">14</span></span>
      <span class="d has"><span class="dw">W</span><span class="dn">15</span></span>
      <span class="d off"><span class="dw">T</span><span class="dn">16</span></span>
      <span class="d has"><span class="dw">F</span><span class="dn">17</span></span>
      <span class="d off"><span class="dw">S</span><span class="dn">18</span></span>
    </div>
    <div class="week-strip" style="border-top:1px solid var(--border-subtle)">
      <span class="d off"><span class="dw">S</span><span class="dn">19</span></span>
      <span class="d has"><span class="dw">M</span><span class="dn">20</span></span>
      <span class="d has"><span class="dw">T</span><span class="dn">21</span></span>
      <span class="d has"><span class="dw">W</span><span class="dn">22</span></span>
      <span class="d off"><span class="dw">T</span><span class="dn">23</span></span>
      <span class="d has"><span class="dw">F</span><span class="dn">24</span></span>
      <span class="d off"><span class="dw">S</span><span class="dn">25</span></span>
    </div>
  </div>

  <div class="sec">Today <span class="sec-link">Open Today tab</span></div>
  <div class="panel" style="border-left:3px solid var(--blue)">
    <div class="shift-row">
      <span class="sr-date"><span class="sr-dw">Mon</span><span class="sr-dn">13</span></span>
      <span class="sr-body"><span class="sr-time">9:20 AM – 6:00 PM</span><span class="sr-meta">DAU5 · Van <b>V-214</b> · Wave <b>9:35</b> · Standard</span></span>
      <span class="pill blue"><span class="pdot"></span>Ready</span>
    </div>
  </div>

  <div class="sec">This week <span class="sec-n">3</span></div>
  <div class="panel">
    <div class="shift-row">
      <span class="sr-date"><span class="sr-dw">Tue</span><span class="sr-dn">14</span></span>
      <span class="sr-body"><span class="sr-time">9:20 AM – 6:00 PM</span><span class="sr-meta">DAU5 · Van <b>V-214</b> · Standard</span></span>
      <span class="row-end"><span class="chev">${I.chev(16)}</span></span>
    </div>
    <div class="shift-row">
      <span class="sr-date"><span class="sr-dw">Wed</span><span class="sr-dn">15</span></span>
      <span class="sr-body"><span class="sr-time">10:20 AM – 7:00 PM</span><span class="sr-meta">DAU5 · Van <b>V-108</b> <span class="pill amber" style="height:17px;font-size:10px;padding:0 6px">Rotation</span> · Rescue</span></span>
      <span class="row-end"><span class="chev">${I.chev(16)}</span></span>
    </div>
    <div class="shift-row">
      <span class="sr-date"><span class="sr-dw">Fri</span><span class="sr-dn">17</span></span>
      <span class="sr-body"><span class="sr-time">9:20 AM – 6:00 PM</span><span class="sr-meta">DAU5 · Van <b>V-214</b> · Standard</span></span>
      <span class="row-end"><span class="chev">${I.chev(16)}</span></span>
    </div>
  </div>

  <div class="sec">Next week <span class="sec-n">4</span></div>
  <div class="panel">
    <div class="shift-row">
      <span class="sr-date"><span class="sr-dw">Mon</span><span class="sr-dn">20</span></span>
      <span class="sr-body"><span class="sr-time">9:20 AM – 6:00 PM</span><span class="sr-meta">DAU5 · Standard</span></span>
      <span class="row-end"><span class="chev">${I.chev(16)}</span></span>
    </div>
    <div class="shift-row">
      <span class="sr-date"><span class="sr-dw">Tue</span><span class="sr-dn">21</span></span>
      <span class="sr-body"><span class="sr-time">9:20 AM – 6:00 PM</span><span class="sr-meta">DAU5 · Standard</span></span>
      <span class="row-end"><span class="chev">${I.chev(16)}</span></span>
    </div>
  </div>

  <div class="sec">Open shifts you can pick up <span class="sec-n">2</span></div>
  <div class="panel">
    <div class="shift-row">
      <span class="sr-date"><span class="sr-dw">Thu</span><span class="sr-dn">16</span></span>
      <span class="sr-body"><span class="sr-time">9:20 AM – 6:00 PM</span><span class="sr-meta">DAU5 · Standard · posted by dispatch</span></span>
      <span class="row-end"><button class="btn btn-sm btn-primary">Pick up</button></span>
    </div>
    <div class="shift-row">
      <span class="sr-date"><span class="sr-dw">Sat</span><span class="sr-dn">18</span></span>
      <span class="sr-body"><span class="sr-time">7:00 AM – 3:30 PM</span><span class="sr-meta">DAU5 · Early wave</span></span>
      <span class="row-end"><button class="btn btn-sm btn-primary">Pick up</button></span>
    </div>
  </div>

  <div class="divider-note">Need a day covered? Open a shift and tap “Offer swap”.</div>
</main>`,
});

/* ═════════════════════ 09 · Tasks ═══════════════════════════════ */
page({
  name: "09-tasks",
  title: "Tasks",
  active: "tasks",
  appbarOpts: { title: "Tasks", date: "" },
  body: `
<main class="main">
  <div class="panel">
    <div class="prog">
      <span class="prog-n" style="color:var(--ink);font-weight:700">Today</span>
      <span class="prog-track"><span class="prog-fill" style="width:40%"></span></span>
      <span class="prog-n">2 of 5 done</span>
    </div>
  </div>

  <div class="sec" style="color:var(--red-dark)">Blocking check-out <span class="sec-n">2</span></div>
  <div class="panel">
    ${taskRow({ state: "alert", title: "Mileage & fuel log", meta: "Required at check-out · ~1 min", pill: `<span class="pill red">Required</span>` })}
    ${taskRow({ state: "alert", title: "End-of-day debrief", meta: "Required at check-out · 3 questions", pill: `<span class="pill red">Required</span>` })}
  </div>

  <div class="sec">Required this week <span class="sec-n">1</span></div>
  <div class="panel">
    ${taskRow({ state: "cur", title: "Coaching: speeding event review", meta: "Sent Jul 11 · acknowledge by Fri", pill: `<span class="pill amber">Due Fri</span>` })}
  </div>

  <div class="sec">Optional <span class="sec-n">2</span></div>
  <div class="panel">
    ${taskRow({ state: "cur", title: "2026 Handbook acknowledgement", meta: "E-sign · 1 document" })}
    ${taskRow({ state: "cur", title: "Scan a document", meta: "Photos → PDF straight to dispatch" })}
  </div>

  <div class="sec">Waiting on dispatch <span class="sec-n">1</span></div>
  <div class="panel">
    ${taskRow({ state: "blocked", title: "Form I-9 — Section 2", meta: "Dispatch completes this step", pill: `<span class="pill">Waiting</span>` })}
  </div>

  <div class="sec">Completed today <span class="sec-n">2</span></div>
  <div class="panel">
    ${taskRow({ state: "done", title: "Pre-trip inspection", meta: "Submitted 9:12 AM · no defects" })}
    ${taskRow({ state: "done", title: "Acknowledge safety notice", meta: "Acknowledged 8:31 AM" })}
  </div>
</main>`,
});

/* ═════════════════════ 10 · Messages ════════════════════════════ */
page({
  name: "10-messages",
  title: "Messages",
  active: "msg",
  appbarOpts: { title: "Messages", date: "" },
  body: `
<div class="viewtabs">
  <button class="vt on">Inbox <span class="vt-n">2</span></button>
  <button class="vt">Dispatch</button>
  <button class="vt">Channels</button>
</div>
<main class="main">
  <div class="sec" style="color:var(--red-dark)">Needs acknowledgement <span class="sec-n">1</span></div>
  <div class="notice danger" style="margin-bottom:8px">
    ${I.alert(17)}
    <div style="flex:1">
      <div class="n-title">Safety notice · Urgent</div>
      <div class="n-body">Ice reported on the Ranch Rd 620 bridge. Reduce speed and report any incidents immediately.</div>
      <div class="n-act"><button class="btn btn-sm btn-primary">Acknowledge</button><span style="font-size:11px;color:var(--subtle);align-self:center">Dispatch · 7:07 AM</span></div>
    </div>
  </div>

  <div class="sec">Conversations</div>
  <div class="panel">
    <a class="row msg-row unread" href="#">
      <span class="m-ava hq">SL</span>
      <span class="row-body">
        <span class="m-top"><span class="m-who">Dispatch</span><span class="m-when">8:39 AM</span></span>
        <span class="m-preview">Marcus — your van V-214 is staged in bay 3 today.</span>
      </span>
      <span class="unread-dot"></span>
    </a>
    <a class="row msg-row" href="#">
      <span class="m-ava" style="background:linear-gradient(135deg,#2563eb,#1e40af)">D5</span>
      <span class="row-body">
        <span class="m-top"><span class="m-who">DAU5 Drivers</span><span class="m-when">7:58 AM</span></span>
        <span class="m-preview">Alicia: Anyone have the gate code for the Lakeline complex?</span>
      </span>
    </a>
  </div>

  <div class="sec">Announcements</div>
  <div class="panel">
    <a class="row msg-row" href="#">
      <span class="row-ic">${I.megaphone(18)}</span>
      <span class="row-body">
        <span class="m-top"><span class="m-who" style="font-weight:600">Load-out starts 8:50 today</span><span class="m-when">Yesterday</span></span>
        <span class="m-preview">Wave 1 leaves at 9:35 sharp — be staged by 9:25.</span>
      </span>
      <span class="row-end"><span class="pill green">${I.check(11)}Ack'd</span></span>
    </a>
    <a class="row msg-row" href="#">
      <span class="row-ic">${I.megaphone(18)}</span>
      <span class="row-body">
        <span class="m-top"><span class="m-who" style="font-weight:600">Parking change at DAU5</span><span class="m-when">Jul 10</span></span>
        <span class="m-preview">Personal vehicles move to the east lot starting Monday.</span>
      </span>
      <span class="row-end"><span class="pill">Read</span></span>
    </a>
  </div>

  <div class="divider-note">Call or video-call dispatch from any conversation</div>
</main>`,
});

/* ═════════════════════ 11 · Inspection ══════════════════════════ */
page({
  name: "11-inspection",
  title: "Pre-trip inspection",
  active: "tasks",
  appbarOpts: { back: true, title: "Pre-trip inspection", date: "", avatar: "", pill: `<span class="pill amber">Due 9:20 AM</span>` },
  tabOpts: { tasksBadge: 2 },
  body: `
<main class="main has-cta">
  <div class="panel">
    <div class="prog">
      <span class="prog-n" style="color:var(--ink);font-weight:700">Van V-214</span>
      <span class="prog-track"><span class="prog-fill" style="width:75%"></span></span>
      <span class="prog-n">9 of 12</span>
    </div>
  </div>

  <div class="sec">Walkaround</div>
  <div class="panel">
    <div class="row done">
      <span class="t-state done">${I.check(13)}</span>
      <span class="row-body"><span class="row-title">Body damage check</span></span>
      <span class="row-end"><span class="pill green">Pass</span></span>
    </div>
    <div class="row done">
      <span class="t-state done">${I.check(13)}</span>
      <span class="row-body"><span class="row-title">Lights, signals & flashers</span></span>
      <span class="row-end"><span class="pill green">Pass</span></span>
    </div>
    <div class="row" style="display:block;padding-bottom:13px">
      <div style="display:flex;align-items:center;gap:10px">
        <span class="t-state alert">${I.alert(12)}</span>
        <span class="row-body"><span class="row-title">Tires inflated & free of damage</span></span>
        <span class="row-end" style="width:150px"><span class="seg" style="flex:1"><button>Pass</button><button class="on-bad">Fail</button></span></span>
      </div>
      <div style="margin:10px 0 0 32px;padding:11px 12px;border:1px solid var(--red-border);background:var(--red-soft);border-radius:6px">
        <div style="font-size:12px;font-weight:700;color:var(--red-dark);margin-bottom:7px">Describe the defect — goes to Fleet</div>
        <div style="display:flex;gap:8px;margin-bottom:9px">
          <span class="photo-thumb"></span>
          <span class="photo-add" style="background:var(--surface)">${I.cam(15)}Add photo</span>
        </div>
        <div class="field" style="min-height:38px;color:var(--ink);font-size:14px">Front-left tire worn to the wear bar.</div>
      </div>
    </div>
  </div>

  <div class="sec">In-cab</div>
  <div class="panel">
    <div class="row done">
      <span class="t-state done">${I.check(13)}</span>
      <span class="row-body"><span class="row-title">Mirrors, wipers & horn</span></span>
      <span class="row-end"><span class="pill green">Pass</span></span>
    </div>
    <div class="row">
      <span class="t-state cur">${svg('<circle cx="12" cy="12" r="5" fill="currentColor" stroke="none"/>', 12, 0)}</span>
      <span class="row-body"><span class="row-title">Odometer reading</span><span class="row-meta">Miles, as shown on the dash</span></span>
      <span class="row-end" style="width:110px"><span class="field" style="min-height:38px;padding:8px 10px;color:var(--disabled)">48,213</span></span>
    </div>
    <div class="row">
      <span class="t-state cur">${svg('<circle cx="12" cy="12" r="5" fill="currentColor" stroke="none"/>', 12, 0)}</span>
      <span class="row-body"><span class="row-title">Photo of dash</span><span class="row-meta">Odometer + fuel level visible</span></span>
      <span class="row-end"><span class="photo-add">${I.cam(15)}Add photo</span></span>
    </div>
  </div>
</main>`,
  cta: `
<div class="cta-bar">
  <button class="btn btn-primary">Submit inspection</button>
  <div class="cta-note warn">1 defect will be reported to Fleet before departure</div>
</div>`,
});

/* ═════════════════════ 12 · No shift today ══════════════════════ */
page({
  name: "12-today-noshift",
  title: "Today — no shift",
  body: `
<main class="main">
  <section class="panel shiftcard">
    <div class="sc-top">${P.none}<span class="appbar-spacer"></span><span class="appbar-date">Mon, Jul 13</span></div>
    <div class="panel-pad" style="padding-top:2px">
      <div style="font-size:17px;font-weight:700;letter-spacing:-.01em">You're off today</div>
      <div style="font-size:13px;color:var(--subtle);margin-top:2px">Next shift tomorrow at 9:20 AM · DAU5</div>
    </div>
  </section>

  <div class="sec">Want extra hours? <span class="sec-n">2 open shifts</span></div>
  <div class="panel">
    <div class="shift-row">
      <span class="sr-date"><span class="sr-dw">Thu</span><span class="sr-dn">16</span></span>
      <span class="sr-body"><span class="sr-time">9:20 AM – 6:00 PM</span><span class="sr-meta">DAU5 · Standard</span></span>
      <span class="row-end"><button class="btn btn-sm btn-primary">Pick up</button></span>
    </div>
    <div class="shift-row">
      <span class="sr-date"><span class="sr-dw">Sat</span><span class="sr-dn">18</span></span>
      <span class="sr-body"><span class="sr-time">7:00 AM – 3:30 PM</span><span class="sr-meta">DAU5 · Early wave</span></span>
      <span class="row-end"><button class="btn btn-sm btn-primary">Pick up</button></span>
    </div>
  </div>

  <div class="sec">Worth doing today <span class="sec-n">2</span></div>
  <div class="panel">
    ${taskRow({ state: "cur", title: "Coaching: speeding event review", meta: "Acknowledge by Friday", pill: `<span class="pill amber">Due Fri</span>` })}
    ${taskRow({ state: "cur", title: "2026 Handbook acknowledgement", meta: "E-sign · 1 document" })}
  </div>

  <div class="sec">This week</div>
  <div class="panel">
    <div class="shift-row">
      <span class="sr-date"><span class="sr-dw">Tue</span><span class="sr-dn">14</span></span>
      <span class="sr-body"><span class="sr-time">9:20 AM – 6:00 PM</span><span class="sr-meta">DAU5 · Van <b>V-214</b> · Standard</span></span>
      <span class="chev">${I.chev(16)}</span>
    </div>
    <div class="shift-row">
      <span class="sr-date"><span class="sr-dw">Wed</span><span class="sr-dn">15</span></span>
      <span class="sr-body"><span class="sr-time">10:20 AM – 7:00 PM</span><span class="sr-meta">DAU5 · Rescue</span></span>
      <span class="chev">${I.chev(16)}</span>
    </div>
  </div>
</main>`,
  tabOpts: { tasksBadge: 2, msgBadge: 0 },
});

/* ═════════════════════ 13 · Missing assignment ══════════════════ */
page({
  name: "13-today-missing",
  title: "Today — missing assignment",
  body: `
<main class="main has-cta">
  ${shiftcard({
    pill: P.ready, stage: 1,
    sub: `Check-in closes <b>10:20 AM</b> · Wave departs <b>9:35 AM</b>`,
    boardOpts: { missing: ["van", "route"] },
    count: `<div class="count"><span class="c-label">Shift starts in</span><span class="c-val">38m</span></div>`,
  })}

  <div class="notice warn">
    ${I.alert(17)}
    <div style="flex:1">
      <div class="n-title">No van assigned yet</div>
      <div class="n-body">Dispatch usually assigns vans by 8:30 AM. You can still check in — we'll notify you the moment your van and route land.</div>
      <div class="n-act"><button class="btn btn-sm">Message dispatch</button></div>
    </div>
  </div>

  <div class="sec">Before wave departure <span class="sec-n">2 of 3</span></div>
  <div class="panel">
    ${taskRow({ state: "done", title: "Acknowledge safety notice", meta: "Acknowledged 8:31 AM" })}
    ${taskRow({ state: "done", title: "Confirm your shift", meta: "Confirmed yesterday, 4:12 PM" })}
    ${taskRow({ state: "blocked", title: "Pre-trip inspection", meta: "Available once your van is assigned", pill: `<span class="pill">Waiting on van</span>` })}
  </div>
</main>`,
  cta: `
<div class="cta-bar">
  <button class="btn btn-primary">${I.check(17)}Check in · 9:20 AM shift</button>
  <div class="cta-note">Checking in doesn't need a van — inspection unlocks when it's assigned</div>
</div>`,
});

/* ═════════════════════ 14 · Offline & syncing ═══════════════════ */
page({
  name: "14-offline",
  title: "Offline & syncing",
  offlineStrip: true,
  appbarOpts: { conn: "off" },
  tabOpts: { offline: true },
  body: `
<main class="main has-cta">
  ${shiftcard({
    pill: P.onduty, stage: 2, blocked: true,
    sub: `Checked in <b>8:04 AM</b> · showing saved data from <b>8:12 AM</b>`,
    count: `<div class="count"><span class="c-label">Wave departs in</span><span class="c-val">53m</span></div>`,
  })}

  <div class="sec" style="color:var(--amber-dark)">Waiting to sync <span class="sec-n">2</span></div>
  <div class="panel">
    <div class="row">
      <span class="row-ic">${I.tasks(18)}</span>
      <span class="row-body">
        <span class="row-title">Pre-trip inspection</span>
        <span class="row-meta">Saved on this phone 9:12 AM · sends automatically</span>
      </span>
      <span class="row-end"><span class="pill amber"><span class="pdot"></span>Pending</span></span>
    </div>
    <div class="row">
      <span class="row-ic">${I.form(18)}</span>
      <span class="row-body">
        <span class="row-title">Mileage & fuel log</span>
        <span class="row-meta">Upload failed at 9:14 AM — kept safely on this phone</span>
      </span>
      <span class="row-end"><span class="pill red">Failed</span><button class="btn btn-sm">Retry</button></span>
    </div>
  </div>

  <div class="notice info">
    ${I.info(17)}
    <div>
      <div class="n-title">Everything you do offline is saved</div>
      <div class="n-body">Inspections, forms and messages queue on this phone and send themselves when you're back in coverage.</div>
    </div>
  </div>

  <div class="sec">Before wave departure <span class="sec-n">1 of 2</span></div>
  <div class="panel">
    ${taskRow({ state: "cur", title: "Pre-trip inspection", meta: "Completed — will submit when back online", pill: `<span class="pill amber">Pending</span>` })}
    ${taskRow({ state: "done", title: "Confirm van & route", meta: "V-214 · Standard · confirmed 8:05 AM" })}
  </div>
</main>`,
  cta: `
<div class="cta-bar">
  <button class="btn">${I.refresh(16)}Try to sync now</button>
  <div class="cta-note warn">2 items waiting · last synced 8:12 AM</div>
</div>`,
});

/* ═════════════════════ 15 · More ════════════════════════════════ */
page({
  name: "15-more",
  title: "More",
  active: "more",
  appbarOpts: { title: "More", date: "" },
  body: `
<main class="main">
  <div class="panel">
    <a class="row" href="#" style="min-height:62px">
      <span class="appbar-avatar" style="width:42px;height:42px;font-size:14px">MR</span>
      <span class="row-body">
        <span class="row-title" style="font-size:16px">Marcus Rivera</span>
        <span class="row-meta">Driver · DAU5 · Summit Logistics</span>
      </span>
      <span class="row-end"><span class="chev">${I.chev(16)}</span></span>
    </a>
  </div>

  <div class="sec">Documents & compliance</div>
  <div class="panel">
    <a class="row" href="#"><span class="row-ic">${I.doc(18)}</span><span class="row-body"><span class="row-title">My documents</span></span><span class="row-end"><span class="chev">${I.chev(16)}</span></span></a>
    <a class="row" href="#"><span class="row-ic">${I.file(18)}</span><span class="row-body"><span class="row-title">Driver's license</span></span><span class="row-end"><span class="pill amber">Renew by Aug 2</span><span class="chev">${I.chev(16)}</span></span></a>
    <a class="row" href="#"><span class="row-ic">${I.truck(18)}</span><span class="row-body"><span class="row-title">Van documents</span><span class="row-meta">Insurance · registration for V-214</span></span><span class="row-end"><span class="chev">${I.chev(16)}</span></span></a>
    <a class="row" href="#"><span class="row-ic">${I.scan(18)}</span><span class="row-body"><span class="row-title">Scan a document</span></span><span class="row-end"><span class="chev">${I.chev(16)}</span></span></a>
  </div>

  <div class="sec">Work</div>
  <div class="panel">
    <a class="row" href="#"><span class="row-ic">${I.cal(18)}</span><span class="row-body"><span class="row-title">Availability</span></span><span class="row-end"><span class="chev">${I.chev(16)}</span></span></a>
    <a class="row" href="#"><span class="row-ic">${I.sun(18)}</span><span class="row-body"><span class="row-title">Time off</span></span><span class="row-end"><span class="pill blue">1 pending</span><span class="chev">${I.chev(16)}</span></span></a>
    <a class="row" href="#"><span class="row-ic">${I.shield(18)}</span><span class="row-body"><span class="row-title">Attendance</span></span><span class="row-end"><span class="pill green">Good standing</span><span class="chev">${I.chev(16)}</span></span></a>
  </div>

  <div class="sec">Team & support</div>
  <div class="panel">
    <a class="row" href="#"><span class="row-ic">${I.users(18)}</span><span class="row-body"><span class="row-title">Team roster</span><span class="row-meta">Call or text your teammates</span></span><span class="row-end"><span class="chev">${I.chev(16)}</span></span></a>
    <a class="row" href="#"><span class="row-ic">${I.phone(18)}</span><span class="row-body"><span class="row-title">Call dispatch</span></span><span class="row-end"><span class="chev">${I.chev(16)}</span></span></a>
  </div>

  <div class="sec">App</div>
  <div class="panel">
    <a class="row" href="#"><span class="row-ic">${I.bell(18)}</span><span class="row-body"><span class="row-title">Notifications</span></span><span class="row-end"><span class="pill green">On</span><span class="chev">${I.chev(16)}</span></span></a>
    <a class="row" href="#"><span class="row-ic">${I.key(18)}</span><span class="row-body"><span class="row-title">Sign-in PIN</span></span><span class="row-end"><span class="chev">${I.chev(16)}</span></span></a>
    <a class="row" href="#"><span class="row-ic">${I.gear(18)}</span><span class="row-body"><span class="row-title">Settings</span></span><span class="row-end"><span class="chev">${I.chev(16)}</span></span></a>
    <a class="row" href="#"><span class="row-ic" style="color:var(--red-dark)">${I.out(18)}</span><span class="row-body"><span class="row-title" style="color:var(--red-dark)">Sign out</span></span></a>
  </div>

  <div class="divider-note">RouteReady Driver · v2.0 design preview</div>
</main>`,
  tabOpts: { tasksBadge: 2, msgBadge: 1 },
});

/* ═══════════════ 16 · Concept A — shift timeline home ═══════════ */
page({
  name: "16-concept-a-timeline",
  title: "Concept A — timeline home",
  body: `
<main class="main has-cta">
  <div class="panel" style="margin-bottom:8px">
    <div class="sc-top" style="padding-bottom:10px">
      ${P.onduty}
      <span class="appbar-spacer"></span>
      <span class="chiplet">DAU5</span><span class="chiplet">${I.truck(12)} V-214</span><span class="chiplet">Wave 9:35</span>
    </div>
  </div>

  <div class="sec">Your shift, step by step</div>
  <div class="panel tl">
    <div class="tl-node done">
      <span class="tl-dot">${I.check(13)}</span>
      <span class="tl-body">
        <span class="tl-title">Check in <span class="tl-when">8:04 AM</span></span>
        <span class="tl-meta">At DAU5 · on time</span>
      </span>
    </div>
    <div class="tl-node done">
      <span class="tl-dot">${I.check(13)}</span>
      <span class="tl-body">
        <span class="tl-title">Acknowledge safety notice <span class="tl-when">8:31 AM</span></span>
        <span class="tl-meta">Ice on RR 620 bridge</span>
      </span>
    </div>
    <div class="tl-node cur">
      <span class="tl-dot">${svg('<circle cx="12" cy="12" r="5" fill="currentColor" stroke="none"/>', 12, 0)}</span>
      <span class="tl-body">
        <span class="tl-title">Pre-trip inspection <span class="tl-when" style="color:var(--amber-dark)">Due 9:20</span></span>
        <span class="tl-meta">12 items · ~4 min · goes to Fleet</span>
        <div class="tl-expand">
          <div style="display:flex;align-items:center;gap:10px">
            <span style="flex:1;font-size:12.5px;color:var(--muted)">Van V-214 staged in bay 3 — walk around before load-out.</span>
            <button class="btn btn-sm btn-primary">Start</button>
          </div>
        </div>
      </span>
    </div>
    <div class="tl-node">
      <span class="tl-dot"></span>
      <span class="tl-body">
        <span class="tl-title" style="font-weight:600">Wave departure <span class="tl-when">9:35 AM</span></span>
        <span class="tl-meta">Be staged by 9:25 · load-out from 8:50</span>
      </span>
    </div>
    <div class="tl-node locked">
      <span class="tl-dot">${svg('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>', 12)}</span>
      <span class="tl-body">
        <span class="tl-title">Drive route <span class="tl-when">~8h</span></span>
        <span class="tl-meta">30-min break required before 2:00 PM</span>
      </span>
    </div>
    <div class="tl-node locked">
      <span class="tl-dot">${svg('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>', 12)}</span>
      <span class="tl-body">
        <span class="tl-title">Check out <span class="tl-when">after 6:00 PM</span></span>
        <span class="tl-meta">Mileage log + debrief unlock when you return</span>
      </span>
    </div>
  </div>

  <div class="sec">Messages <span class="sec-link">Open</span></div>
  <div class="panel">
    <a class="row msg-row unread" href="#">
      <span class="m-ava hq">SL</span>
      <span class="row-body">
        <span class="m-top"><span class="m-who">Dispatch</span><span class="m-when">8:39 AM</span></span>
        <span class="m-preview">Marcus — your van V-214 is staged in bay 3 today.</span>
      </span>
      <span class="unread-dot"></span>
    </a>
  </div>
</main>`,
  cta: `
<div class="cta-bar">
  <button class="btn btn-primary">${I.tasks(17)}Start pre-trip inspection</button>
  <div class="cta-note warn">Required before wave departure · 53 min left</div>
</div>`,
});

/* ═══════════════ 17 · Stress — long names + urgent + offline ════ */
page({
  name: "17-stress",
  title: "Stress — long content, offline, urgent",
  offlineStrip: true,
  appbarOpts: {
    eyebrow: "Konstantinopoulos Bros. Last-Mile Logistics · DAU5 North Annex",
    conn: "off",
  },
  tabOpts: { offline: true, tasksBadge: 12, msgBadge: 9 },
  body: `
<main class="main has-cta">
  ${shiftcard({
    pill: P.ready, stage: 1,
    sub: `Check-in closes <b>10:20 AM</b> · Wave departs <b>9:35 AM</b>`,
    boardOpts: { station: "DAU5 North Annex", route: "Standard Parcel — Extra Large", van: "V-2148-TEMP", wave: "9:35 AM" },
    count: `<div class="count"><span class="c-label">Shift starts in</span><span class="c-val">38m</span></div>`,
  })}

  <div class="notice danger">
    ${I.alert(17)}
    <div style="flex:1">
      <div class="n-title">Severe weather — tornado watch until 3:00 PM for northern Williamson County</div>
      <div class="n-body">Return to the nearest safe stop and contact dispatch immediately if sirens sound. Route pauses will not count against on-time metrics today.</div>
      <div class="n-act"><button class="btn btn-sm btn-primary">Acknowledge</button></div>
    </div>
  </div>

  <div class="sec">Before wave departure <span class="sec-n">1 of 5</span></div>
  <div class="panel">
    ${taskRow({ state: "alert", title: "Acknowledge severe weather notice", meta: "Sent 8:12 AM · required", pill: `<span class="pill red">Required</span>` })}
    ${taskRow({ state: "cur", title: "Pre-trip inspection — extended winter checklist", meta: "18 items · ~7 min · goes to Fleet", pill: `<span class="pill amber">Due 9:20</span>` })}
    ${taskRow({ state: "cur", title: "Confirm temporary rotation van V-2148-TEMP", meta: "Your usual van V-214 is in the shop until Thursday" })}
    ${taskRow({ state: "done", title: "Confirm your shift", meta: "Confirmed yesterday" })}
    ${taskRow({ state: "blocked", title: "Load-out scan", meta: "Available at the dock from 8:50 AM" })}
  </div>
</main>`,
  cta: `
<div class="cta-bar">
  <button class="btn disabled" disabled>${I.wifioff(16)}Check in — waiting for connection</button>
  <div class="cta-note warn">Check-in needs a connection · retrying automatically</div>
</div>`,
});

/* ═══════════════ 18 · Keyboard visible (inspection note) ════════ */
page({
  name: "18-keyboard",
  title: "Inspection — keyboard open",
  active: "tasks",
  appbarOpts: { back: true, title: "Pre-trip inspection", date: "", avatar: "", pill: `<span class="pill amber">Due 9:20 AM</span>` },
  body: `
<main class="main" style="padding-bottom:308px">
  <div class="panel">
    <div class="row" style="display:block;padding-bottom:13px">
      <div style="display:flex;align-items:center;gap:10px">
        <span class="t-state alert">${I.alert(12)}</span>
        <span class="row-body"><span class="row-title">Tires inflated & free of damage</span></span>
        <span class="row-end" style="width:150px"><span class="seg" style="flex:1"><button>Pass</button><button class="on-bad">Fail</button></span></span>
      </div>
      <div style="margin:10px 0 0 32px;padding:11px 12px;border:1px solid var(--red-border);background:var(--red-soft);border-radius:6px">
        <div style="font-size:12px;font-weight:700;color:var(--red-dark);margin-bottom:7px">Describe the defect — goes to Fleet</div>
        <div class="field focused" style="min-height:58px;font-size:15px">Front-left tire worn to the wear bar, sidewall scuff on<span style="border-left:2px solid var(--blue);margin-left:1px"></span></div>
        <div class="field-help">Saved automatically as you type</div>
      </div>
    </div>
  </div>
  <div style="display:flex;justify-content:flex-end;margin-top:10px">
    <button class="btn btn-sm btn-primary">Done</button>
  </div>
</main>
<div class="kbd-sim">
  <div class="krow">${"QWERTYUIOP".split("").map((k) => `<span class="key">${k}</span>`).join("")}</div>
  <div class="krow">${"ASDFGHJKL".split("").map((k) => `<span class="key">${k}</span>`).join("")}</div>
  <div class="krow"><span class="key wide">⇧</span>${"ZXCVBNM".split("").map((k) => `<span class="key">${k}</span>`).join("")}<span class="key wide">⌫</span></div>
  <div class="krow"><span class="key wide">123</span><span class="key space"></span><span class="key wide" style="width:74px;font-size:13px">return</span></div>
</div>`,
});

/* ═══════════════ 19 · Large text (accessibility) ════════════════ */
page({
  name: "19-large-text",
  title: "Today — large text",
  bodyClass: "lg-text",
  body: `
<main class="main has-cta">
  ${shiftcard({
    pill: P.ready, stage: 1,
    sub: `Check-in closes <b>10:20 AM</b> · Wave departs <b>9:35 AM</b>`,
    count: `<div class="count"><span class="c-label">Shift starts in</span><span class="c-val">38m</span></div>`,
  })}
  <div class="sec">Before wave departure <span class="sec-n">2 of 3</span></div>
  <div class="panel">
    ${taskRow({ state: "done", title: "Acknowledge safety notice", meta: "Acknowledged 8:31 AM" })}
    ${taskRow({ state: "done", title: "Confirm your shift", meta: "Confirmed yesterday, 4:12 PM" })}
    ${taskRow({ state: "blocked", title: "Pre-trip inspection", meta: "Available after you check in", pill: `<span class="pill amber">Due 9:20</span>` })}
  </div>
</main>`,
  cta: `
<div class="cta-bar">
  <button class="btn btn-primary">${I.check(17)}Check in · 9:20 AM shift</button>
  <div class="cta-note ok">Location confirmed — you're inside the station geofence</div>
</div>`,
});

/* ═══════════ 20–22 · REVISION 1 — the calmer Today ═══════════════
   Same architecture, half the furniture: one meta line instead of the
   4-cell board, an unlabeled progress rail, no countdown row (it moves
   into the CTA note), one focus item instead of full requirement lists,
   location + urgency folded into the action bar. */

const railMini = (stage) => `
  <div class="rail" style="padding:2px 14px 14px">
    <div class="rail-track">${[1, 2, 3, 4].map((i) =>
      `<span class="rail-seg ${i < stage ? "done" : i === stage ? "cur" : ""}" style="height:3px"></span>`).join("")}
    </div>
  </div>`;

const cleanCard = ({ pill, time = `9:20 <small>AM</small> – 6:00 <small>PM</small>`, meta, stage }) => `
<section class="panel shiftcard">
  <div class="sc-top">${pill}</div>
  <div class="sc-time-row"><span class="sc-time">${time}</span></div>
  <div class="sc-sub" style="padding-bottom:14px">${meta}</div>
  ${railMini(stage)}
</section>`;

const CLEAN_APPBAR = { eyebrow: "", conn: "none" };

page({
  name: "20-clean-ready",
  title: "Revision — Today, ready (calm)",
  appbarOpts: CLEAN_APPBAR,
  body: `
<main class="main has-cta">
  ${cleanCard({
    pill: P.ready, stage: 1,
    meta: `DAU5 · Van <b>V-214</b> · Wave <b>9:35 AM</b>`,
  })}

  <div class="sec">Next</div>
  <div class="panel">
    ${taskRow({ state: "blocked", title: "Pre-trip inspection", meta: "Starts after you check in · 12 items · ~4 min" })}
  </div>
  <div class="divider-note">2 of 3 steps done today · <a href="#" style="color:var(--blue);text-decoration:none;font-weight:600">See all</a></div>
</main>`,
  cta: `
<div class="cta-bar">
  <button class="btn btn-primary">${I.check(17)}Check in</button>
  <div class="cta-note ok">You're at DAU5 · shift starts in 38 min</div>
</div>`,
});

page({
  name: "21-clean-onduty",
  title: "Revision — Today, on duty (calm)",
  appbarOpts: CLEAN_APPBAR,
  body: `
<main class="main has-cta">
  ${cleanCard({
    pill: P.onduty, stage: 2,
    meta: `Checked in <b>8:04 AM</b> · Wave <b>9:35 AM</b> · Van <b>V-214</b>`,
  })}

  <div class="sec">Next</div>
  <div class="panel">
    ${taskRow({ state: "cur", title: "Pre-trip inspection", meta: "12 items · ~4 min · goes to Fleet", pill: `<span class="pill amber">Due 9:20 AM</span>` })}
  </div>
  <div class="divider-note">2 more steps later today · <a href="#" style="color:var(--blue);text-decoration:none;font-weight:600">See all</a></div>
</main>`,
  cta: `
<div class="cta-bar">
  <button class="btn btn-primary">${I.tasks(17)}Start pre-trip inspection</button>
  <div class="cta-note">Wave departs 9:35 AM · 53 min</div>
</div>`,
});

page({
  name: "22-clean-active",
  title: "Revision — Today, active shift (calm)",
  appbarOpts: CLEAN_APPBAR,
  body: `
<main class="main">
  ${cleanCard({
    pill: P.onduty, stage: 3,
    meta: `On duty <b>4h 12m</b> · return by <b>6:00 PM</b>`,
  })}

  <div class="sec">During your shift</div>
  <div class="panel">
    <div class="row">
      <span class="row-ic">${I.coffee(18)}</span>
      <span class="row-body"><span class="row-title">30-min break</span><span class="row-meta">Take it before 2:00 PM</span></span>
      <span class="row-end"><button class="btn btn-sm">Start</button></span>
    </div>
    <a class="row" href="#">
      <span class="row-ic">${I.msg(18)}</span>
      <span class="row-body"><span class="row-title">Messages</span></span>
      <span class="row-end"><span class="pill blue">1 new</span><span class="chev">${I.chev(16)}</span></span>
    </a>
    <a class="row" href="#">
      <span class="row-ic">${I.flag(18)}</span>
      <span class="row-body"><span class="row-title">Report an issue</span></span>
      <span class="row-end"><span class="chev">${I.chev(16)}</span></span>
    </a>
  </div>

  <div class="sec">Check-out</div>
  <div class="panel">
    <a class="row" href="#">
      <span class="row-ic">${I.clock(18)}</span>
      <span class="row-body"><span class="row-title">2 items before you can check out</span><span class="row-meta">Mileage & fuel log · End-of-day debrief</span></span>
      <span class="row-end"><span class="chev">${I.chev(16)}</span></span>
    </a>
  </div>
  <div class="divider-note">Check-out unlocks when you're back at DAU5</div>
</main>`,
});

/* ═══════════ 23 · Form fill — calm treatment ═════════════════════
   A published form (driver_list_forms → renderFormFill) rendered with
   the same kit as checklists: field rows, autosave, sticky submit that
   states its consequence. Demonstrates stage binding: this form gates
   check-out, so Today's CTA leads here at the right moment. */
page({
  name: "23-clean-form",
  title: "Revision — form fill (Mileage & fuel log)",
  active: "tasks",
  appbarOpts: { back: true, title: "Mileage & fuel log", date: "", avatar: "", conn: "none", pill: `<span class="pill amber">Unlocks check-out</span>` },
  body: `
<main class="main has-cta">
  <div class="panel">
    <div class="row" style="display:block;padding:14px">
      <label class="field-label">Odometer at return <span class="req">*</span></label>
      <div class="field" style="font-variant-numeric:tabular-nums">48,391</div>
      <div class="field-help">Started at 48,213 this morning · about 178 mi driven</div>
    </div>
    <div class="row" style="display:block;padding:14px">
      <label class="field-label">Fuel level <span class="req">*</span></label>
      <div class="seg">
        <button>Full</button><button>¾</button><button class="on">½</button><button>¼ or less</button>
      </div>
    </div>
    <div class="row" style="display:block;padding:14px">
      <label class="field-label">Photo of dash <span class="req">*</span></label>
      <div style="display:flex;gap:8px;align-items:center">
        <span class="photo-thumb"></span>
        <span class="photo-add">${I.cam(15)}Retake</span>
      </div>
      <div class="field-help">Odometer and fuel gauge visible in one shot</div>
    </div>
    <div class="row" style="display:block;padding:14px">
      <label class="field-label">Anything to note? <span style="color:var(--faint, var(--disabled));text-transform:none;letter-spacing:0">(optional)</span></label>
      <div class="field" style="min-height:58px;color:var(--disabled)">e.g. warning lights, low washer fluid…</div>
    </div>
  </div>
  <div class="divider-note">Saved automatically — safe to leave and come back, even offline</div>
</main>`,
  cta: `
<div class="cta-bar">
  <button class="btn btn-primary">Submit mileage & fuel log</button>
  <div class="cta-note">1 required item left after this: End-of-day debrief</div>
</div>`,
});

/* ═══════════ 24 · Tasks — calm treatment ═════════════════════════
   The single inventory: forms, checklists, coaching acks, documents
   to sign — one list, grouped by consequence, completed collapsed. */
page({
  name: "24-clean-tasks",
  title: "Revision — Tasks (calm)",
  active: "tasks",
  appbarOpts: { eyebrow: "", conn: "none", title: "Tasks", date: "" },
  body: `
<main class="main">
  <div class="sec">Before check-out <span class="sec-n">2</span></div>
  <div class="panel">
    ${taskRow({ state: "cur", title: "Mileage & fuel log", meta: "Form · ~1 min", pill: `<span class="pill amber">Required</span>` })}
    ${taskRow({ state: "cur", title: "End-of-day debrief", meta: "Form · 3 questions", pill: `<span class="pill amber">Required</span>` })}
  </div>

  <div class="sec">This week <span class="sec-n">1</span></div>
  <div class="panel">
    ${taskRow({ state: "cur", title: "Coaching: speeding event review", meta: "Acknowledge · sent Jul 11", pill: `<span class="pill amber">Due Fri</span>` })}
  </div>

  <div class="sec">When you have a minute <span class="sec-n">3</span></div>
  <div class="panel">
    ${taskRow({ state: "cur", title: "2026 Handbook acknowledgement", meta: "Sign · 1 document" })}
    ${taskRow({ state: "cur", title: "Scan a document", meta: "Photos → PDF to dispatch" })}
    ${taskRow({ state: "blocked", title: "Form I-9 — Section 2", meta: "Dispatch completes this step", pill: `<span class="pill">Waiting</span>` })}
  </div>

  <div class="divider-note">Completed today (2) · <a href="#" style="color:var(--blue);text-decoration:none;font-weight:600">See all</a></div>
</main>`,
});

console.log("all screens built →", OUT);
