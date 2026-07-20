// Marketing screenshot harness — boots the RouteReady dashboard against a
// fully stubbed Supabase API with fictional demo data, navigates views,
// and captures 2x PNG screenshots.
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DSP_ID, UID, ST1, SVC_SP, SVC_XL, DSP, STATIONS, DRIVERS, VANS,
  TIME_OFF, WEEK_START, weekDates, todayIso, buildWeek, buildVanDays,
} from "./demo-data.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(DIR, "out");
fs.mkdirSync(OUT, { recursive: true });

const HOST = "https://doiwrhkirgblcvuskhno.supabase.co";
const BASE = "http://127.0.0.1:8123";

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const JWT = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: UID, role: "authenticated", exp: Math.floor(Date.now() / 1000) + 31536000 })}.x`;
const session = {
  access_token: JWT, token_type: "bearer",
  expires_at: Math.floor(Date.now() / 1000) + 31536000,
  refresh_token: "x",
  user: { id: UID, aud: "authenticated", role: "authenticated", email: "alex@blueridgelogistics.com" },
};

const grid = buildWeek(WEEK_START, 1);
const vanDays = buildVanDays(grid);
// 4 weeks of history + current week for per-driver selects (attendance rails).
const histStart = (() => { const d = new Date(WEEK_START + "T12:00:00"); d.setDate(d.getDate() - 28); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();
const histGrid = buildWeek(histStart, 5);

// ── RPC stubs ────────────────────────────────────────────────────────
const seatCount = (dateIso) => grid.shifts.filter((s) => s.date === dateIso).length;

const todayRosterRows = grid.shifts
  .filter((s) => s.date === todayIso)
  .map((s, i) => {
    const van = VANS.find((v) => v.id === s.van_id) || VANS[0];
    return {
      shift_id: s.id, shift_date: s.date, starts_at: s.starts_at, ends_at: s.ends_at,
      route_code: s.route_code, shift_status: s.status, shift_kind: "regular",
      station_id: ST1, station_code: "DNW2",
      driver_id: s.driver_id, driver_name: s.driver_name, driver_photo_path: null,
      tier: null, van_id: van.id, van_name: van.name, van_plate: van.plate,
      van_via: "primary", van_via_source: null, covering_for: null, gap_kind: null,
      wave_index: s.wave_index, service_type_code: s.service_type_code,
      service_type_color: s.service_type_color, is_cushion: s.is_cushion,
    };
  });

// All visible clocks freeze at 10:35 AM ET "today" (mid-morning: wave 1
// is out, wave 2 is about to check in) so captures are reproducible.
const FROZEN_DASH = new Date(`${todayIso}T10:35:00-04:00`).getTime();
const FROZEN_APP  = new Date(`${todayIso}T15:45:00-04:00`).getTime();
const nowMs = FROZEN_DASH;
const todayAttendance = {
  as_of: new Date(FROZEN_DASH).toISOString(),
  tardy_grace_minutes: 10, ncns_after_minutes: 60,
  rows: todayRosterRows.map((r, i) => {
    const checkedIn = new Date(r.starts_at).getTime() <= FROZEN_DASH; // wave 1 is out
    const inAt = new Date(new Date(r.starts_at).getTime() - (4 + (i % 9)) * 60000).toISOString();
    return {
      shift_id: r.shift_id, driver_id: r.driver_id, driver_name: r.driver_name,
      station_code: r.station_code, starts_at: r.starts_at,
      wave_index: r.wave_index, service_type_code: r.service_type_code,
      service_type_color: r.service_type_color, is_cushion: r.is_cushion,
      checked_in_at: checkedIn ? inAt : null, checked_out_at: null,
      missed_reported_at: null, missed_reason: null, distance_meters: checkedIn ? 42 : null,
      finalized: false, final_outcome: null, decision: null, decision_notes: null,
      computed_outcome: checkedIn ? "checked_in" : "waiting",
    };
  }),
};

const chatThreads = [
  { driver_id: "d-03", name: "Jordan Reyes", full_name: "Jordan Reyes", station_code: "DNW2", status: "active", last_at: new Date(nowMs - 4 * 60000).toISOString(), is_favorite: true, unread: 1, last_message: { body: "Rolling out now — see you back around 7.", sender_kind: "driver", created_at: new Date(nowMs - 4 * 60000).toISOString() } },
  { driver_id: "d-02", name: "Tanya Rivera", full_name: "Tanya Rivera", station_code: "DNW2", status: "active", last_at: new Date(nowMs - 22 * 60000).toISOString(), is_favorite: false, unread: 0, last_message: { body: "Got it, thank you!", sender_kind: "driver", created_at: new Date(nowMs - 22 * 60000).toISOString() } },
  { driver_id: "d-08", name: "Maria Santos", full_name: "Maria Santos", station_code: "DNW2", status: "active", last_at: new Date(nowMs - 65 * 60000).toISOString(), is_favorite: false, unread: 0, last_message: { body: "I can take the Saturday wave 2 if you still need coverage.", sender_kind: "driver", created_at: new Date(nowMs - 65 * 60000).toISOString() } },
  { driver_id: "d-05", name: "Sam Okafor", full_name: "Sam Okafor", station_code: "DNW2", status: "active", last_at: new Date(nowMs - 16 * 3600000).toISOString(), is_favorite: false, unread: 0, last_message: { body: "Van 105 wiper blades replaced 👍", sender_kind: "dispatcher", created_at: new Date(nowMs - 16 * 3600000).toISOString() } },
  { driver_id: "d-10", name: "Priya Nair", full_name: "Priya Nair", station_code: "DNW2", status: "active", last_at: new Date(nowMs - 26 * 3600000).toISOString(), is_favorite: false, unread: 0, last_message: { body: "Thanks for approving the time off!", sender_kind: "driver", created_at: new Date(nowMs - 26 * 3600000).toISOString() } },
  { driver_id: "d-07", name: "Chris Yang", full_name: "Chris Yang", station_code: "DNW2", status: "active", last_at: new Date(nowMs - 30 * 3600000).toISOString(), is_favorite: false, unread: 0, last_message: { body: "See you at the 10:20 wave tomorrow.", sender_kind: "dispatch", created_at: new Date(nowMs - 30 * 3600000).toISOString() } },
];

// Targets horizon: a growing-demand story — 7 routes/weekday now, ramping
// to 10 by the end of the 13-week horizon (holiday build-up).
function okamiCells(startIsoStr, weeks) {
  const base = buildWeek(startIsoStr, weeks).coverage;
  return base.map((c) => {
    const idx = Math.max(0, Math.floor((new Date(c.date) - new Date(startIsoStr)) / 86400000));
    const w = Math.floor(idx / 7);
    const ramp = w < 4 ? 0 : w < 8 ? 1 : w < 11 ? 2 : 3;
    const dow = new Date(c.date + "T12:00:00").getDay();
    const target = (dow === 0 ? 4 : dow === 6 ? 5 : 6) + ramp;
    const xl = (dow >= 1 && dow <= 5) ? 1 : 0;
    const future = w >= 2;
    return {
      ...c,
      target_routes: target, needed: target,
      targets_by_wave: [
        { wave_index: 1, service_type_id: SVC_SP, service_type_code: "SP", target_routes: Math.ceil((target - xl) * 0.65) },
        ...(xl ? [{ wave_index: 1, service_type_id: SVC_XL, service_type_code: "XL", target_routes: xl }] : []),
        { wave_index: 2, service_type_id: SVC_SP, service_type_code: "SP", target_routes: (target - xl) - Math.ceil((target - xl) * 0.65) },
      ].filter((t) => t.target_routes > 0),
      filled_by_wave: future ? [] : c.filled_by_wave,
      filled: future ? 0 : Math.min(c.filled, target),
      open_count: future ? target : Math.max(0, target - c.filled),
    };
  });
}

const RPC = {
  schedule_grid: (p) => buildWeek(p?.p_start || WEEK_START, p?.p_weeks || 1),
  okami_grid: (p) => okamiCells(p?.p_start || WEEK_START, p?.p_weeks || 3),
  active_drivers_for_horizon: (p) => {
    const start = p?.p_first_week_start || WEEK_START;
    const weeks = p?.p_weeks || 13;
    return Array.from({ length: weeks }, (_, w) => {
      const d = new Date(start + "T12:00:00"); d.setDate(d.getDate() + w * 7);
      const weekIso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const pto = w === 0 ? 1 : w === 3 ? 2 : 0;
      return { week_start: weekIso, total_active: 18, on_time_off: pto, on_pto: pto, available: 18 - pto };
    });
  },
  scheduling_settings_for_week: () => ({ cushion_pct: 10 }),
  get_woc_settings: () => null,
  rr_schema_version: () => 600,
  calendar_schema_version: () => 600,
  today_attendance: () => todayAttendance,
  today_roster: () => todayRosterRows,
  today_roster_auto_assign: () => null,
  overtime_intelligence: () => null,
  today_plan: () => ({
    open_shifts: [],
    dl_expiring: [{ driver_id: "d-12", driver_name: "Grace Kim", expires_on: "2026-07-26", days_left: 6 }],
    not_dot_certified: [],
  }),
  fleet_execution_summary: () => null,
  pipeline_counts: () => [
    { stage: "applied", count: 6 }, { stage: "screened", count: 3 },
    { stage: "interview", count: 2 }, { stage: "hired", count: 1 },
    { stage: "all", count: 12 }, { stage: "action_needed", count: 3 },
  ],
  dispatch_chat_threads: () => chatThreads,
  dispatch_chat_thread: (p) => {
    const d = DRIVERS.find((x) => x.id === (p?.p_driver_id || "d-03")) || DRIVERS[2];
    const msg = (id, kind, body, minsAgo, extra = {}) => ({
      id, sender_kind: kind, is_auto: false, body, edited_at: null, deleted_at: null,
      attachment_path: null, attachment_mime: null, attachment_name: null, attachment_size_bytes: null,
      priority: "normal", requires_ack: false, acked_at: null, reply_to: null,
      created_at: new Date(nowMs - minsAgo * 60000).toISOString(), is_unread: false, ...extra,
    });
    return {
      driver: { id: d.id, name: d.full_name, full_name: d.full_name },
      messages: [
        msg("m-1", "driver",   "Morning — van 103 has a low tire pressure light. Topping it up before wave.", 62),
        msg("m-2", "dispatch", "Thanks for flagging it — logged an issue on the van so the shop can check the valve. Safe drive!", 58),
        msg("m-3", "driver",   "Sounds good 👍", 55),
        msg("m-4", "dispatch", "Heads up — Thursday's wave moves to 10:50 next week. Your schedule is already updated.", 26),
        msg("m-5", "driver",   "Got it, thanks. Can I grab the Saturday open shift too?", 12),
        msg("m-6", "dispatch", "It's yours — just accepted your pickup. You're on wave 1 Saturday.", 9),
        msg("m-7", "driver",   "Rolling out now — see you back around 7.", 4, { is_unread: true }),
      ],
      last_read_at: new Date(nowMs - 30 * 60000).toISOString(),
      peer_last_read_at: new Date(nowMs - 33 * 60000).toISOString(),
    };
  },
  dispatch_chat_mark_read: () => null,
  vehicles_roster: () => VANS,
  roster_attendance_counts: () => DRIVERS.map((d, i) => ({ driver_id: d.id, worked: 22 - (i % 3 === 0 ? 1 : 0), eligible: 22 })),
  driver_app_status: () => DRIVERS.map((d, i) => ({ driver_id: d.id, invited: true, signed_in_at: "2026-06-01T12:00:00Z", last_seen_at: new Date(nowMs - (i + 1) * 3600000).toISOString(), has_push: true })),
  i9_list: () => [],
  orphaned_ride_alongs: () => [],
};

// ── Stub router ──────────────────────────────────────────────────────
function tableRows(table, url) {
  switch (table) {
    case "app_users": return [{ id: UID, dsp_id: DSP_ID, email: "alex@blueridgelogistics.com", full_name: "Alex Morgan", role: "owner", allowed_pages: null }];
    case "dsps": return [DSP];
    case "stations": return STATIONS;
    case "drivers": return DRIVERS;
    case "time_off_requests": return TIME_OFF;
    case "vehicles": return VANS;
    case "vehicle_day_assignments": return vanDays;
    case "driver_recognitions": return [{ driver_id: "d-08", sent_at: new Date(nowMs - 2 * 86400000).toISOString(), kind: "kudos", title: "5-star customer mention", status: "sent" }];
    case "coachings": return [];
    case "shifts": return histGrid.shifts.map((s) => ({ ...s, station: { code: "DNW2" } }));
    default: return [];
  }
}

async function stubRoute(route) {
  const req = route.request();
  const url = new URL(req.url());
  const p = url.pathname;
  const one = (req.headers()["accept"] || "").includes("pgrst.object");
  const json = (b, code = 200) => route.fulfill({ status: code, contentType: "application/json", body: JSON.stringify(b === undefined ? null : b) });

  if (p.startsWith("/auth/v1/token")) return json(session);
  if (p.startsWith("/auth/v1/user")) return json(session.user);
  if (p.startsWith("/auth/v1/")) return json({});
  if (p.startsWith("/storage/")) return json({});
  if (p.startsWith("/rest/v1/rpc/")) {
    const name = p.slice("/rest/v1/rpc/".length);
    let params = {};
    try { params = JSON.parse(req.postData() || "{}"); } catch {}
    if (RPC[name]) return json(RPC[name](params));
    return json(one ? {} : []);
  }
  if (p.startsWith("/rest/v1/")) {
    const table = p.slice("/rest/v1/".length).split("?")[0];
    if (req.method() !== "GET" && req.method() !== "HEAD") return json([], 201);
    let rows = tableRows(table, url);
    // Honor simple eq./in. column filters so scoped selects (per-driver
    // shifts, status splits, count-only HEAD queries) stay coherent.
    const SKIP = new Set(["select", "order", "limit", "offset", "or", "and"]);
    for (const [k, v] of url.searchParams.entries()) {
      if (SKIP.has(k) || !Array.isArray(rows) || !rows.length || !(k in (rows[0] || {}))) continue;
      const m = /^eq\.(.+)$/.exec(v);
      const inm = /^in\.\((.+)\)$/.exec(v);
      if (m) rows = rows.filter((r) => String(r[k]) === m[1]);
      else if (inm) { const set = new Set(inm[1].split(",").map((s) => s.replace(/^"|"$/g, ""))); rows = rows.filter((r) => set.has(String(r[k]))); }
    }
    if (req.method() === "HEAD") {
      const n = rows.length;
      return route.fulfill({ status: 200, contentType: "application/json", headers: { "content-range": n ? `0-${n - 1}/${n}` : `*/0` }, body: "" });
    }
    return json(one ? (rows[0] ?? {}) : rows);
  }
  return json(one ? {} : []);
}

// ── Boot ─────────────────────────────────────────────────────────────
export async function bootDashboard({ viewport = { width: 1560, height: 940 }, dpr = 2 } = {}) {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox", "--headless=new", "--force-prefers-reduced-motion"] });
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: dpr, timezoneId: "America/New_York", locale: "en-US" });
  await ctx.addInitScript(([s]) => {
    localStorage.setItem("sb-doiwrhkirgblcvuskhno-auth-token", JSON.stringify(s));
    window.__rrSchedOrientFlash = true;
  }, [session]);
  await ctx.route("**/*", (r) => r.request().url().startsWith(BASE) ? r.continue() : r.abort());
  await ctx.route(`${HOST}/**`, stubRoute);
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push("PAGEERROR: " + String(e).slice(0, 300)));
  page.on("console", (m) => { if (m.type() === "error") errs.push("CONSOLE: " + m.text().slice(0, 300)); });
  try { await page.clock.setFixedTime(new Date(FROZEN_DASH)); } catch {}
  await page.goto(`${BASE}/dashboard/index.html`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(5000);
  await page.evaluate(() => document.getElementById("rr-boot-overlay")?.remove());
  await page.waitForTimeout(500);
  return { browser, page, errs };
}

// ── Driver app (mobile PWA) ──────────────────────────────────────────
const JORDAN = DRIVERS[2]; // d-03 Jordan Reyes
// Jordan's two-week schedule, with a guaranteed shift today (the rotation
// may not land him on today's crew, and the spotlight needs one).
function jordanShifts() {
  const two = buildWeek(WEEK_START, 2);
  const mine = two.shifts.filter((s) => s.driver_id === JORDAN.id);
  if (!mine.some((s) => s.date === todayIso)) {
    mine.push({
      id: "sh-jr-today", date: todayIso, station_id: ST1,
      driver_id: JORDAN.id, driver_name: JORDAN.full_name, route_code: null,
      status: "scheduled", starts_at: `${todayIso}T10:20:00-04:00`,
      ends_at: `${todayIso}T19:20:00-04:00`, block_hours: 9, is_cushion: false,
      wave_index: 1, service_type_id: SVC_SP, service_type_code: "SP",
      service_type_label: "Standard Parcel", service_type_color: "#3b82f6",
      shift_kind: "regular", trainer_driver_id: null, trainer_name: null,
      route_classification: null, notes: null, van_id: "v-03",
    });
    mine.sort((a, b) => (a.date < b.date ? -1 : 1));
  }
  return mine;
}
const driverRPC = {
  driver_me: () => ({
    id: JORDAN.id, name: "Jordan", full_name: JORDAN.full_name, photo_path: null,
    dsp_id: DSP_ID, dsp_name: DSP.name, dsp_phone: "(571) 555-0199", request_features: {},
  }),
  driver_get_profile: () => ({
    id: JORDAN.id, full_name: JORDAN.full_name, preferred_name: "Jordan", pronouns: null,
    phone: JORDAN.phone, email: JORDAN.email, address: null,
    emergency_contact_name: null, emergency_contact_phone: null,
    dl_number: null, dl_image_path: null, dl_back_image_path: null,
    dl_expires_on: JORDAN.dl_expires_on, dot_certified: true, xl_certified: true,
    status: "active", hire_date: JORDAN.hire_date,
    background_check_completed_at: "2024-09-20T12:00:00Z",
    drug_test_completed_at: "2024-09-20T12:00:00Z", dsp_id: DSP_ID,
  }),
  driver_my_schedule: (p) => {
    const mine = jordanShifts().map((s) => ({
      id: s.id, date: s.date, starts_at: s.starts_at, ends_at: s.ends_at,
      wave_starts_at: s.starts_at, report_lead_minutes: 0,
      station_id: ST1, station_code: "DNW2", station_latitude: null, station_longitude: null,
      status: s.status, block_hours: s.block_hours, wave_index: s.wave_index,
      service_type_code: s.service_type_code, service_type_color: s.service_type_color,
      is_cushion: false, route_code: s.route_code, shift_kind: "regular",
      trainer_driver_id: null, trainer_name: null, notes: null,
    }));
    return { driver: { id: JORDAN.id, full_name: JORDAN.full_name, name: "Jordan" }, shifts: mine, start: WEEK_START, end: null };
  },
  driver_vehicle_days: () => jordanShifts().map((s) => ({
    date: s.date, vehicle: (VANS.find((v) => v.id === s.van_id) || VANS[2]).name,
    via: "primary", is_chain_match: true,
  })),
  driver_checkin_status: () => {
    const s = jordanShifts().find((x) => x.date === todayIso);
    if (!s) return { shift: null };
    const start = new Date(s.starts_at);
    return {
      shift: {
        id: s.id, starts_at: s.starts_at, ends_at: s.ends_at,
        wave_starts_at: s.starts_at, station_code: "DNW2", has_geofence: false,
        station_latitude: null, station_longitude: null, geofence_radius_meters: 150,
        window_open_at: new Date(start.getTime() - 15 * 60000).toISOString(),
        window_close_at: new Date(start.getTime() + 60 * 60000).toISOString(),
        checkin_lead_minutes: 15, ncns_after_minutes: 60,
      },
      checkin: {
        checked_in_at: new Date(start.getTime() - 8 * 60000).toISOString(),
        checked_out_at: null, missed_reported_at: null, missed_reason: null,
        distance_meters: 38, outcome: null,
      },
      can_checkin_now: false, window_is_open: false,
    };
  },
  driver_chat_list: () => ({ messages: [], unread: 0 }),
  driver_pending_shift_confirmations: () => [],
  driver_offer_list: () => [],
  driver_open_shifts_list: () => [],
  driver_swap_list: () => [],
  driver_list_coachings: () => [],
  driver_assignments_list: () => [],
  driver_list_forms: () => [],
  driver_list_checklists: () => [],
  driver_envelopes_list: () => [],
  driver_i9_get: () => null,
  driver_push_vapid_key: () => null,
};

async function stubDriverRoute(route) {
  const req = route.request();
  const url = new URL(req.url());
  const p = url.pathname;
  const one = (req.headers()["accept"] || "").includes("pgrst.object");
  const json = (b, code = 200) => route.fulfill({ status: code, contentType: "application/json", body: JSON.stringify(b === undefined ? null : b) });
  if (p.startsWith("/rest/v1/rpc/")) {
    const name = p.slice("/rest/v1/rpc/".length);
    let params = {};
    try { params = JSON.parse(req.postData() || "{}"); } catch {}
    if (driverRPC[name]) return json(driverRPC[name](params));
    return json(one ? {} : []);
  }
  if (p.startsWith("/auth/v1/")) return json({});
  if (p.startsWith("/storage/")) return json({});
  return json(one ? {} : []);
}

export async function bootDriverApp({ viewport = { width: 390, height: 844 }, dpr = 3 } = {}) {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox", "--headless=new", "--force-prefers-reduced-motion"] });
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: dpr, timezoneId: "America/New_York", locale: "en-US", isMobile: true, hasTouch: true });
  await ctx.route("**/*", (r) => r.request().url().startsWith(BASE) ? r.continue() : r.abort());
  await ctx.route(`${HOST}/**`, stubDriverRoute);
  const page = await ctx.newPage();
  // Freeze the visible clock mid-afternoon so the on-duty state reads
  // naturally regardless of when the capture runs.
  try { await page.clock.setFixedTime(new Date(FROZEN_APP)); } catch {}
  const errs = [];
  page.on("pageerror", (e) => errs.push("PAGEERROR: " + String(e).slice(0, 300)));
  page.on("console", (m) => { if (m.type() === "error") errs.push("CONSOLE: " + m.text().slice(0, 300)); });
  await page.goto(`${BASE}/app/index.html?preview=tok-demo-1234&n=Jordan&d=${encodeURIComponent(DSP.name)}&st=active`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4500);
  return { browser, page, errs };
}

// ── Shots ────────────────────────────────────────────────────────────
const shots = {
  async "schedule-week"(page) {
    await page.waitForTimeout(2500);
  },
  async "today-plan"(page) {
    await page.evaluate(() => window.goto && window.goto("dashboard"));
    await page.waitForTimeout(3500);
  },
  async targets(page) {
    await page.evaluate(() => window.schedSub && window.schedSub("targets"));
    await page.waitForTimeout(4000);
  },
  async fleet(page) {
    await page.evaluate(() => window.goto && window.goto("fleet2"));
    await page.waitForTimeout(3500);
  },
  async drivers(page) {
    await page.evaluate(() => window.goto && window.goto("drivers"));
    await page.waitForTimeout(3500);
  },
  async messages(page) {
    // The realtime websocket can't connect in the sandbox — the banner it
    // triggers is an environment artifact, not a product state.
    await page.evaluate(() => { window._rrChatRealtimeHealthy = true; });
    await page.addStyleTag({ content: "#rr-mc-connbanner{display:none!important}" });
    await page.evaluate(() => window.goto && window.goto("messages"));
    await page.waitForTimeout(4000);
  },
};

const which = process.argv[2] || "schedule-week";
if (which.startsWith("driver-app")) {
  const { browser, page, errs } = await bootDriverApp();
  if (which === "driver-app-schedule") {
    await page.locator('button.tab[data-route="/schedule"]').click();
    await page.waitForTimeout(2500);
  }
  await page.screenshot({ path: path.join(OUT, which + ".png") });
  console.log("saved", which, JSON.stringify({ errs: errs.slice(0, 8) }, null, 1));
  await browser.close();
} else {
  const { browser, page, errs } = await bootDashboard();
  if (shots[which]) await shots[which](page);
  await page.screenshot({ path: path.join(OUT, which + ".png") });
  console.log("saved", which, JSON.stringify({ errs: errs.slice(0, 8) }, null, 1));
  await browser.close();
}
