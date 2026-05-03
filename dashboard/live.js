// Live data layer for the operator dashboard.
//
// The mockup HTML is the visual frame. live.js takes over once the page
// loads: requires auth, then hands the pipeline view real data via the
// pipeline_list / pipeline_counts RPCs, and rewires paAction(...) to
// call send_screening_link / send_booking_link / decline_applicant.
//
// Other tabs still show mockup data — they get wired up in follow-ups.

import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm";

const cfg = window.RR_CONFIG;
if (!cfg) throw new Error("RR_CONFIG missing — load config.js before live.js");

const sb = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});
window.RR = { sb, user: null, dsp: null };

// ─── Auth gate ─────────────────────────────────────────────────────────────
const { data: { session } } = await sb.auth.getSession();
if (!session) {
  const next = encodeURIComponent(location.pathname + location.search);
  location.replace(`./login.html?next=${next}`);
  throw new Error("redirecting to login");
}

const { data: profile, error: profileErr } = await sb.from("app_users")
  .select("id, dsp_id, email, full_name, role").eq("id", session.user.id).maybeSingle();

if (profileErr || !profile) {
  // Auth user exists but app_users row doesn't — auth hook failed (most
  // likely a non-allowed domain that slipped through). Send to login with
  // an error.
  await sb.auth.signOut();
  location.replace("./login.html?err=no_profile");
  throw new Error("no app_users row");
}
window.RR.user = profile;

const { data: dspRow } = await sb.from("dsps")
  .select("id, name, short_code, timezone, metadata").eq("id", profile.dsp_id).single();
window.RR.dsp = dspRow;

// ─── Tiny DOM helpers ──────────────────────────────────────────────────────
const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function toast(msg, kind) {
  if (typeof window.toast === "function") return window.toast(msg, kind);
  console.log("[toast]", kind ?? "", msg);
}

function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

// ─── Pipeline render ───────────────────────────────────────────────────────

const STAGE_LABELS = {
  applied: "Applied",
  screened: "Screened",
  booking_pending: "Booking pending",
  booking_scheduled: "Booking scheduled",
};

function renderApplicantCard(a) {
  const stage = a.pipeline_stage;
  const slug  = (a.full_name || "").toLowerCase().replace(/\s+/g, "-");
  const subtitle = [
    a.station_code ? `Station ${a.station_code}` : null,
    a.source ? `via ${a.source}` : null,
  ].filter(Boolean).join(" · ");

  let primaryBtn = "";
  if (stage === "applied") {
    primaryBtn = `<button class="pa-disp-btn primary" type="button" data-rr-action="resend_screening">Resend screening</button>`;
  } else if (stage === "screened") {
    primaryBtn = `<button class="pa-disp-btn primary" type="button" data-rr-action="send_link">Send booking link</button>`;
  } else if (stage === "booking_pending") {
    primaryBtn = `<button class="pa-disp-btn primary" type="button" data-rr-action="resend_link">Resend booking link</button>`;
  } else if (stage === "booking_scheduled") {
    const when = a.next_event_starts_at ? `Booked ${fmtDate(a.next_event_starts_at)}` : "Booked";
    primaryBtn = `<button class="pa-disp-btn ghost" type="button" disabled>${when}</button>
                  <button class="pa-disp-btn danger" type="button" data-rr-action="cancel_interview">Cancel interview</button>`;
  }

  const videoBtn = a.video_url
    ? `<button class="pa-disp-btn ghost" type="button" data-rr-action="play_video" data-video-url="${encodeURI(a.video_url)}">▶ Intro video</button>`
    : "";

  return `
    <div class="pa-card" data-stage="${stage}" data-applicant="${a.id}" data-applicant-slug="${slug}"
         data-rr-pinnable data-rr-pin-kind="applicant" data-rr-pin-ref="${a.id}"
         data-rr-pin-label="${escapeHtml(a.full_name ?? "Applicant")}">
      <div class="pa-row">
        <div class="pa-id">
          <div class="pa-name">${a.full_name ?? ""}</div>
          <div class="pa-sub">${subtitle}</div>
        </div>
        <span class="pa-stage-pill ${stage}">${STAGE_LABELS[stage] ?? stage}</span>
      </div>
      <div class="pa-disp">
        <button class="pa-disp-btn ghost" type="button" data-rr-action="call">Call</button>
        ${videoBtn}
        <button class="pa-disp-btn danger" type="button" data-rr-action="decline">Decline</button>
        ${primaryBtn}
      </div>
    </div>`;
}

// Open the applicant's video intro in a simple modal overlay.
function openVideoModal(url) {
  let overlay = document.getElementById("rr-video-overlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "rr-video-overlay";
    overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:9999;display:flex;align-items:center;justify-content:center;padding:24px;cursor:pointer";
    overlay.addEventListener("click", () => { overlay.remove(); });
    document.body.appendChild(overlay);
  }
  overlay.innerHTML = `
    <video controls autoplay playsinline
           style="max-width:100%;max-height:90vh;border-radius:12px;background:#000"
           src="${url}"></video>`;
}

async function loadPipeline(stage = "all") {
  const list = $("#pipe-applicants");
  if (!list) return;

  const [{ data: rows, error }, { data: counts }] = await Promise.all([
    sb.rpc("pipeline_list", { p_stage: stage, p_limit: 200 }),
    sb.rpc("pipeline_counts"),
  ]);
  if (error) {
    toast("Pipeline load failed: " + error.message, "warn");
    return;
  }

  // Update tab counts. Always set (including 0) so the mockup defaults
  // don't bleed through when a stage is empty.
  const countMap = Object.fromEntries((counts ?? []).map(r => [r.stage, r.count]));
  $$("#pipeline-stage-tabs .stage-tab").forEach(btn => {
    const s = btn.getAttribute("data-stage");
    const el = btn.querySelector(".stage-tab-count");
    if (el) el.textContent = countMap[s] ?? 0;
  });

  list.innerHTML = (rows ?? []).map(renderApplicantCard).join("")
    || `<div style="padding:48px;text-align:center;color:var(--text-subtle);font-size:13px">No applicants yet — share your apply link or add one manually.</div>`;
}

// ─── paAction override ─────────────────────────────────────────────────────
//
// The mockup wires onclick="paAction(this,'send_link','Marcus Hill')". We
// intercept at the document level via delegated listener; if the button
// has data-rr-action (live cards), we use that and dispatch to the RPC.
// If it has the legacy onclick (static seeded HTML), we still handle it
// the same way using the card's data-applicant.

async function handleAction(btn) {
  const card = btn.closest(".pa-card");
  if (!card) return;
  const id     = card.getAttribute("data-applicant");
  const action = btn.getAttribute("data-rr-action");
  if (!id || !action) return;

  btn.disabled = true;

  try {
    if (action === "resend_screening") {
      const { error } = await sb.rpc("send_screening_link", { p_id: id });
      if (error) throw error;
      toast("Screening link sent", "success");
    } else if (action === "send_link" || action === "resend_link") {
      const { error } = await sb.rpc("send_booking_link", { p_id: id, p_kind: "interview" });
      if (error) throw error;
      toast("Booking link sent", "success");
    } else if (action === "decline") {
      if (!confirm("Decline this applicant?")) { btn.disabled = false; return; }
      const { error } = await sb.rpc("decline_applicant", { p_id: id, p_reason: "Manual decline" });
      if (error) throw error;
      toast("Applicant declined", "warn");
    } else if (action === "cancel_interview") {
      const reason = prompt("Cancellation reason? (optional · stays internal)");
      if (reason === null) { btn.disabled = false; return; }
      const { error } = await sb.rpc("cancel_interview", { p_applicant_id: id, p_reason: reason || null });
      if (error) throw error;
      toast("Interview cancelled · applicant texted a new booking link", "success");
    } else if (action === "call") {
      // Dial via tel: link; no backend call.
      const { data } = await sb.from("applicants").select("phone").eq("id", id).single();
      if (data?.phone) location.href = `tel:${data.phone}`;
      else toast("No phone on file", "warn");
      btn.disabled = false;
      return;
    } else if (action === "play_video") {
      const url = btn.getAttribute("data-video-url");
      if (url) openVideoModal(url);
      btn.disabled = false;
      return;
    }
    await loadPipeline(getActiveStage());
  } catch (e) {
    toast("Action failed: " + (e.message ?? e), "warn");
    btn.disabled = false;
  }
}

document.addEventListener("click", (e) => {
  // Watch-video pill works on both .pa-card and .iv-card — handle as a
  // standalone action that doesn't need a parent card lookup.
  const playBtn = e.target.closest("[data-rr-play-video]");
  if (playBtn) {
    e.preventDefault();
    e.stopImmediatePropagation();
    const url = playBtn.getAttribute("data-video-url");
    if (url) openVideoModal(url);
    return;
  }
  const btn = e.target.closest("[data-rr-action]");
  if (btn) {
    e.preventDefault();
    e.stopImmediatePropagation();
    handleAction(btn);
  }
}, true);

// Replace the mockup's window.paAction with a thin shim that uses the
// data-rr-action path so legacy seeded inline-onclick markup keeps working
// after the first re-render (until then it triggers the mockup's toast).
const _legacyPaAction = window.paAction;
window.paAction = function (btn, action, _name) {
  btn.setAttribute("data-rr-action", action);
  return handleAction(btn);
};

// ─── Stage filter + view-switch hooks ──────────────────────────────────────

function getActiveStage() {
  const active = $("#pipeline-stage-tabs .stage-tab.active");
  return active?.getAttribute("data-stage") ?? "all";
}

const _legacyFilter = window.filterPipelineStage;
window.filterPipelineStage = function (btn) {
  if (typeof _legacyFilter === "function") _legacyFilter(btn);
  loadPipeline(btn.getAttribute("data-stage") ?? "all");
};

const _legacyGoto = window.goto;
window.goto = function (view) {
  if (typeof _legacyGoto === "function") _legacyGoto(view);
  if (view === "pipeline")  loadPipeline(getActiveStage());
  if (view === "drivers")   loadDriversRoster();
  if (view === "checkin")   loadCheckinView();
  if (view === "dashboard") { loadDashboardTasks(); loadDashboardWeather(); }
};


// ─── Drivers roster ────────────────────────────────────────────────────────
//
// Replaces the mockup roster rows with live rows from public.drivers.
// Records are minimal today (name, contact, station, hire_date, status)
// so the columns the mockup defined for Score / Attendance / Coach show
// "—" until a future migration fills them in.

// Driver stage state — what the operator has filtered to.
let _driverStage = "active";

async function loadDriversRoster() {
  const tbody = document.getElementById("drivers-tbody");
  if (!tbody) return;

  const { data: rows, error } = await sb.from("drivers")
    .select(`id, full_name, first_name, last_name, preferred_name, email, phone, status, hire_date, tier, score,
             background_check_completed_at, drug_test_completed_at,
             training_scheduled_at, training_date,
             station:station_id (code)`)
    .eq("dsp_id", window.RR.dsp.id)
    .order("hire_date", { ascending: false })
    .limit(500);

  refreshDriverStatRow(rows ?? []);
  renderDriverTable(rows ?? [], error);
}

function visibleDriversForStage(rows, stage) {
  switch (stage) {
    case "onboarding": return rows.filter(r => r.status === "onboarding");
    case "active":     return rows.filter(r => r.status === "active");
    case "atrisk":     return rows.filter(r => r.status === "active" && (r.score ?? 999) < 70);
    case "inactive":   return rows.filter(r => ["leave","inactive","terminated"].includes(r.status));
    default:           return rows;
  }
}

function renderDriverTable(rows, error) {
  const tbody = document.getElementById("drivers-tbody");
  const thead = tbody?.parentElement?.querySelector("thead tr");
  if (!tbody || !thead) return;

  // Swap headers per stage. Onboarding shows the new milestone columns.
  if (_driverStage === "onboarding") {
    thead.innerHTML = `
      <th>Driver</th>
      <th>Days since hire</th>
      <th>Background check</th>
      <th>Drug test</th>
      <th>Training scheduled</th>
      <th>Status</th>
      <th>Training date</th>
      <th></th>`;
  } else {
    thead.innerHTML = `
      <th>Driver</th>
      <th>Station</th>
      <th>Tenure</th>
      <th>Score</th>
      <th>Attendance · 30d</th>
      <th>Status</th>
      <th>Last coached</th>
      <th></th>`;
  }

  if (error) {
    tbody.innerHTML = `<tr><td colspan="8" style="padding:24px;text-align:center;color:var(--red);font-size:13px">${escapeHtml(error.message)}</td></tr>`;
    return;
  }

  const visible = visibleDriversForStage(rows, _driverStage);
  if (visible.length === 0) {
    const empty = _driverStage === "onboarding"
      ? "No drivers in onboarding right now."
      : _driverStage === "active"
      ? "No active drivers yet. Hire someone in Interview Day to fill this list."
      : "No drivers in this stage.";
    tbody.innerHTML = `<tr><td colspan="8" style="padding:48px;text-align:center;color:var(--text-subtle);font-size:13px">${empty}</td></tr>`;
    return;
  }

  const renderer = _driverStage === "onboarding" ? renderOnboardingRow : renderDriverRow;
  tbody.innerHTML = visible.map(renderer).join("");
}

function pillCheck(when) {
  if (when) return `<span class="tag" style="background:var(--green-soft);color:var(--green)">Done · ${new Date(when).toLocaleDateString()}</span>`;
  return `<span class="tag" style="background:var(--canvas);color:var(--text-subtle)">Pending</span>`;
}

function renderOnboardingRow(d) {
  const initials = displayDriverInitials(d);
  const display = displayDriverName(d);
  const tier = d.tier ? `tier-${String(d.tier).toLowerCase()}` : "tier-c";
  const contact = d.phone || d.email || "";
  const days = d.hire_date
    ? Math.max(0, Math.floor((Date.now() - new Date(d.hire_date).getTime()) / 86400000))
    : null;
  const daysCell = days != null
    ? `<span style="font-weight:600">${days}</span> <span style="font-size:11px;color:var(--text-subtle)">day${days === 1 ? "" : "s"}</span>`
    : '<span style="color:var(--text-subtle)">—</span>';
  return `
    <tr data-driver-id="${d.id}" data-rr-open-driver>
      <td><div class="cell-driver"><div class="avatar-sm ${tier}">${initials}</div>
        <div><div class="cell-name">${escapeHtml(display)}</div>
        <div class="cell-name-sub">${escapeHtml(contact)}</div></div></div></td>
      <td>${daysCell}</td>
      <td>${pillCheck(d.background_check_completed_at)}</td>
      <td>${pillCheck(d.drug_test_completed_at)}</td>
      <td>${d.training_scheduled_at ? new Date(d.training_scheduled_at).toLocaleString() : '<span style="color:var(--text-subtle)">—</span>'}</td>
      <td>${renderDriverStatusBadge(d.status)}</td>
      <td class="cell-time">${d.training_date ? new Date(d.training_date).toLocaleDateString() : "—"}</td>
      <td></td>
    </tr>`;
}

function renderDriverRow(d) {
  const initials = displayDriverInitials(d);
  const display = displayDriverName(d);
  const tier = d.tier ? `tier-${String(d.tier).toLowerCase()}` : "tier-c";
  const tenure = d.hire_date ? tenureLabel(d.hire_date) : "—";
  const station = d.station?.code || "—";
  const contact = d.phone || d.email || "";
  const statusBadge = renderDriverStatusBadge(d.status);
  return `
    <tr data-driver-id="${d.id}" data-rr-open-driver
        data-rr-pinnable data-rr-pin-kind="driver" data-rr-pin-ref="${d.id}"
        data-rr-pin-label="${escapeHtml(display || "Driver")}">
      <td><div class="cell-driver"><div class="avatar-sm ${tier}">${initials}</div>
        <div><div class="cell-name">${escapeHtml(display)}</div>
        <div class="cell-name-sub">${escapeHtml(contact)}</div></div></div></td>
      <td>${escapeHtml(station)}</td>
      <td>${tenure}</td>
      <td>—</td>
      <td>—</td>
      <td>${statusBadge}</td>
      <td class="cell-time">—</td>
      <td></td>
    </tr>`;
}

// Override the mockup's filterDriversStage so it actually filters the
// roster against live data. Auto-hides at-risk + inactive when empty
// since we don't yet have the data model for at-risk.
const _legacyFilterDrivers = window.filterDriversStage;
window.filterDriversStage = function (btn) {
  if (typeof _legacyFilterDrivers === "function") _legacyFilterDrivers(btn);
  _driverStage = btn.getAttribute("data-stage") || "active";
  loadDriversRoster();
};


// ─── Drivers → Licenses tab ──────────────────────────────────────────────
//
// The mockup's renderRenewalsPanel() (and licResendNow / licMarkRenewed)
// fill the same DOM container we use, with RR_DRIVERS mockup data. They
// fire on page load and on stage filter clicks, flashing fake rows
// before our live loader runs. Stub them all out at boot so only the
// live loader paints the panel.
window.renderRenewalsPanel = function () { /* superseded */ };
window.licResendNow        = function () { /* superseded */ };
window.licMarkRenewed      = function () { /* superseded */ };
window.licApplyAll         = function () { /* superseded */ };

// Wipe the panel body once at boot so any rendering the mockup already
// did before live.js loaded gets cleared before the operator can click.
{
  const body = document.getElementById("lic-renewals-body");
  if (body) body.innerHTML = `<div style="padding:24px;text-align:center;color:var(--text-subtle);font-size:13px">Loading…</div>`;
}

// ─── Drivers · Attendance (live) ───────────────────────────────────────────

let _attLiveWindow = 30; // days; mirrors the mockup's filter chip

// Window cycle chip: keep the mockup's 30/60/90 cycle but refresh live data.
document.addEventListener("click", (e) => {
  const chip = e.target.closest("#att-window-chip");
  if (!chip) return;
  const txt = chip.textContent || "";
  const match = txt.match(/(\d+)/);
  const cur = match ? parseInt(match[1], 10) : 30;
  const seq = [30, 60, 90];
  _attLiveWindow = seq[(seq.indexOf(cur) + 1) % seq.length];
  chip.textContent = `Window: ${_attLiveWindow} days`;
  loadAttendanceLive();
});


async function loadAttendanceLive() {
  const dspId = window.RR?.dsp?.id;
  if (!dspId) return;

  const sinceDate = new Date(); sinceDate.setDate(sinceDate.getDate() - _attLiveWindow);
  const sinceIso  = fmtIsoDate(sinceDate);
  const todayIso  = fmtIsoDate(new Date());

  const [driversRes, shiftsRes] = await Promise.all([
    sb.from("drivers")
      .select("id, full_name, first_name, last_name, preferred_name, status, station:station_id (code)")
      .eq("dsp_id", dspId)
      .order("full_name"),
    sb.from("shifts")
      .select("driver_id, status, date")
      .eq("dsp_id", dspId)
      .gte("date", sinceIso)
      .lte("date", todayIso),
  ]);

  if (driversRes.error || shiftsRes.error) {
    console.warn("attendance load:", driversRes.error || shiftsRes.error);
    return;
  }

  const drivers = driversRes.data || [];
  const shifts  = shiftsRes.data  || [];

  // Per-driver aggregate. status === 'completed' counts as Present;
  // 'called_off' = Callout; 'no_show' = No-show. 'scheduled' is in-progress
  // (counts toward scheduled total but not present until completed).
  const acc = new Map(); // driver_id -> { scheduled, present, callouts, noshows, last }
  for (const sh of shifts) {
    if (!sh.driver_id) continue;
    let a = acc.get(sh.driver_id);
    if (!a) { a = { scheduled: 0, present: 0, callouts: 0, noshows: 0, last: null }; acc.set(sh.driver_id, a); }
    a.scheduled += 1;
    if (sh.status === "completed")      a.present  += 1;
    else if (sh.status === "called_off") a.callouts += 1;
    else if (sh.status === "no_show")    a.noshows  += 1;
    if (sh.status === "called_off" || sh.status === "no_show") {
      if (!a.last || sh.date > a.last) a.last = sh.date;
    }
  }

  // Pull policy from saved DSP metadata (operator-editable in Policy tab).
  const POLICY = _getAttPolicy();

  let totalScheduled = 0, totalPresent = 0, totalIncidents = 0, inAction = 0;
  const rows = drivers.map(d => {
    const a = acc.get(d.id) || { scheduled: 0, present: 0, callouts: 0, noshows: 0, last: null };
    const points = a.callouts * POLICY.points_per_callout + a.noshows * POLICY.points_per_noshow;
    const occ = a.callouts + a.noshows;
    let statusLabel = "Good";
    let statusKind  = "ok";
    if (points >= POLICY.threshold_action) { statusLabel = "Action"; statusKind = "bad"; }
    else if (points >= POLICY.threshold_warn) { statusLabel = "Warn"; statusKind = "warn"; }
    totalScheduled += a.scheduled;
    totalPresent   += a.present;
    totalIncidents += occ;
    if (statusKind !== "ok") inAction += 1;
    return { d, a, points, occ, statusLabel, statusKind };
  }).sort((x, y) => (y.points - x.points) || (y.occ - x.occ));

  // KPIs
  const avgRate = totalScheduled > 0 ? Math.round(totalPresent / totalScheduled * 100) : 100;
  const setKpi = (id, text, cls) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    if (cls) el.className = `di-val ${cls}`;
  };
  setKpi("att-kpi-rate", `${avgRate}%`, avgRate >= 95 ? "ok" : avgRate >= 90 ? "warn" : "bad");
  setKpi("att-kpi-action", String(inAction), inAction === 0 ? "ok" : inAction <= 2 ? "warn" : "bad");
  setKpi("att-kpi-incidents", String(totalIncidents));
  const rateSubEl = document.getElementById("att-kpi-rate-sub");
  if (rateSubEl) rateSubEl.textContent = `${totalPresent} / ${totalScheduled} shifts · last ${_attLiveWindow}d`;
  const incSubEl = document.getElementById("att-kpi-incidents-sub");
  if (incSubEl) incSubEl.textContent = `Last ${_attLiveWindow} days`;

  // Table
  const tbody = document.getElementById("att-report-body");
  if (!tbody) return;
  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="13" style="padding:24px;text-align:center;color:var(--text-subtle)">No drivers yet</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map(r => {
    const display = displayDriverName(r.d);
    const initials = displayDriverInitials(r.d);
    const station = r.d.station?.code || "—";
    const last = r.a.last ? new Date(r.a.last + "T12:00:00").toLocaleDateString() : "—";
    const statusColor = r.statusKind === "bad" ? "var(--red)" : r.statusKind === "warn" ? "var(--amber)" : "var(--green)";
    return `<tr>
      <td><div class="cell-driver"><div class="avatar-sm tier-c">${initials}</div><div><div class="cell-name">${escapeHtml(display)}</div></div></div></td>
      <td>${escapeHtml(station)}</td>
      <td style="text-align:right">${r.a.scheduled}</td>
      <td style="text-align:right">${r.a.present}</td>
      <td style="text-align:right">—</td>
      <td style="text-align:right">${r.a.callouts}</td>
      <td style="text-align:right">${r.a.noshows}</td>
      <td style="text-align:right">—</td>
      <td style="text-align:right;font-weight:600">${r.points}</td>
      <td style="text-align:right">${r.occ}</td>
      <td><span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;background:${statusColor}1A;color:${statusColor}">${r.statusLabel}</span></td>
      <td>${last}</td>
      <td></td>
    </tr>`;
  }).join("");

  // Subnav badge — number of drivers in warn/action.
  const badge = document.getElementById("att-subnav-badge");
  if (badge) {
    if (inAction > 0) { badge.textContent = String(inAction); badge.style.display = "inline-block"; }
    else { badge.style.display = "none"; }
  }
}

// ─── Today's check-in (live) ───────────────────────────────────────────────

const _CI_TO_STATUS = { present: "completed", late: "late", callout: "called_off", noshow: "no_show" };
const _STATUS_TO_CI = Object.fromEntries(Object.entries(_CI_TO_STATUS).map(([k, v]) => [v, k]));

// ─── Dashboard · Weather (NWS forecast + alerts) ──────────────────────

let _weatherRefreshTimer = null;
function _scheduleWeatherRefresh() {
  if (_weatherRefreshTimer) return;
  _weatherRefreshTimer = setInterval(() => {
    if (document.visibilityState !== "visible") return;
    if (!document.getElementById("rr-weather-body")) return;
    loadDashboardWeather();
  }, 5 * 60 * 1000);
}

async function loadDashboardWeather() {
  const body = document.getElementById("rr-weather-body");
  if (!body) return;
  _scheduleWeatherRefresh();
  loadWeatherRadar();
  const meta = window.RR?.dsp?.metadata?.weather || {};
  const lat = Number(meta.lat);
  const lon = Number(meta.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    body.innerHTML = `<div class="task-eyebrow" style="margin-bottom:2px">Weather · station forecast</div>
      <div style="font-size:13px;color:var(--text);font-weight:600;margin-bottom:2px">Set your station location</div>
      <div style="font-size:11px;color:var(--text-subtle);line-height:1.4">Paste lat/lon from Google Maps in Settings → Workspace to enable the local weather forecast and severe-weather alerts.</div>`;
    return;
  }

  body.innerHTML = `<div class="task-eyebrow" style="margin-bottom:2px">Weather · station forecast</div>
    <div style="font-size:13px;color:var(--text-subtle)">Loading…</div>`;

  try {
    const headers = { "User-Agent": "RouteReady/1.0 (dashboard)", "Accept": "application/geo+json" };
    const pointsRes = await fetch(`https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`, { headers });
    if (!pointsRes.ok) throw new Error(`points HTTP ${pointsRes.status}`);
    const points = await pointsRes.json();
    const forecastUrl = points?.properties?.forecast;
    const hourlyUrl   = points?.properties?.forecastHourly;
    const stationsUrl = points?.properties?.observationStations;
    const locName = (() => {
      const rl = points?.properties?.relativeLocation?.properties;
      if (!rl) return "";
      return [rl.city, rl.state].filter(Boolean).join(", ");
    })();
    if (!forecastUrl) throw new Error("no forecast URL from NWS");

    const [fRes, alertsRes, hRes, stationsRes, sunRes] = await Promise.all([
      fetch(forecastUrl, { headers }),
      fetch(`https://api.weather.gov/alerts/active?point=${lat.toFixed(4)},${lon.toFixed(4)}`, { headers }),
      hourlyUrl ? fetch(hourlyUrl, { headers }) : Promise.resolve(null),
      stationsUrl ? fetch(stationsUrl, { headers }).catch(() => null) : Promise.resolve(null),
      fetch(`https://api.sunrise-sunset.org/json?lat=${lat.toFixed(4)}&lng=${lon.toFixed(4)}&formatted=0`).catch(() => null),
    ]);
    const forecast = await fRes.json();
    const alerts   = await alertsRes.json();
    const hourly   = hRes ? await hRes.json() : null;

    // Latest observation from nearest station (gust, pressure, visibility, real humidity)
    let obs = null;
    try {
      if (stationsRes && stationsRes.ok) {
        const stations = await stationsRes.json();
        const stationId = stations?.features?.[0]?.properties?.stationIdentifier;
        if (stationId) {
          const obsRes = await fetch(`https://api.weather.gov/stations/${stationId}/observations/latest`, { headers });
          if (obsRes.ok) {
            const o = await obsRes.json();
            obs = o?.properties || null;
          }
        }
      }
    } catch (e) { /* obs is optional */ }

    // Sunrise / sunset (UTC ISO → browser local)
    let sun = null;
    try {
      if (sunRes && sunRes.ok) {
        const sj = await sunRes.json();
        if (sj?.status === "OK") sun = sj.results;
      }
    } catch (e) { /* optional */ }

    const periods = forecast?.properties?.periods || [];
    if (periods.length === 0) throw new Error("no forecast periods");

    const now = periods[0];
    const dayPairs = [];
    for (let i = 0; i < periods.length && dayPairs.length < 8; i++) {
      const p = periods[i];
      if (p.isDaytime) {
        const next = periods[i + 1];
        dayPairs.push({
          label: p.name,
          hi: p.temperature,
          lo: next && !next.isDaytime ? next.temperature : null,
          unit: p.temperatureUnit,
          short: p.shortForecast,
          precip: p.probabilityOfPrecipitation?.value || 0,
          wind: p.windSpeed,
          windDir: p.windDirection,
          startTime: p.startTime,
        });
      }
    }

    const hourlyPeriods = (hourly?.properties?.periods || []).slice(0, 14);
    const peakRain = hourlyPeriods.reduce((m, h) => Math.max(m, h.probabilityOfPrecipitation?.value || 0), 0);
    const peakWindMph = hourlyPeriods.reduce((m, h) => {
      const v = parseInt(String(h.windSpeed || "").match(/(\d+)/)?.[1] || "0", 10);
      return Math.max(m, v);
    }, 0);
    const peakTemp = hourlyPeriods.reduce((m, h) => Math.max(m, h.temperature ?? -999), -999);
    const minTemp  = hourlyPeriods.reduce((m, h) => Math.min(m, h.temperature ??  999),  999);

    const fmtHour = (iso) => {
      try { const d = new Date(iso); const h = d.getHours(); return (h%12||12) + (h<12?"a":"p"); } catch { return ""; }
    };
    const tempColor = (t) => {
      if (t >= 95) return "var(--red)";
      if (t >= 85) return "var(--amber)";
      if (t <= 32) return "#5b8def";
      return "var(--text)";
    };
    const precipColor = (pct) => {
      if (pct >= 60) return "var(--red)";
      if (pct >= 30) return "var(--amber)";
      return "var(--text-subtle)";
    };
    const hourlyHtml = hourlyPeriods.map(h => {
      const pct = h.probabilityOfPrecipitation?.value || 0;
      const wind = parseInt(String(h.windSpeed || "").match(/(\d+)/)?.[1] || "0", 10);
      return `<div style="display:flex;flex-direction:column;align-items:center;gap:1px;padding:4px 5px;border-radius:4px;min-width:42px;background:var(--canvas)">
        <div style="font-size:10px;color:var(--text-muted);font-weight:600">${fmtHour(h.startTime)}</div>
        <div style="font-size:13px;font-weight:700;color:${tempColor(h.temperature)};font-variant-numeric:tabular-nums;line-height:1">${h.temperature}°</div>
        <div style="font-size:9px;font-weight:600;color:${precipColor(pct)};line-height:1">${pct}%</div>
        ${wind >= 15 ? `<div style="font-size:9px;color:var(--amber);font-weight:600;line-height:1">${wind}</div>` : ""}
      </div>`;
    }).join("");

    const advisories = [];
    if (peakWindMph >= 25) advisories.push(`High wind to <strong>${peakWindMph} mph</strong> next 14h — secure cargo doors, watch high-profile vehicles.`);
    else if (peakWindMph >= 18) advisories.push(`Gusty wind to <strong>${peakWindMph} mph</strong> next 14h.`);
    if (peakTemp >= 95) advisories.push(`Heat to <strong>${peakTemp}°F</strong> — push hydration breaks, watch for heat stress.`);
    else if (peakTemp >= 88) advisories.push(`Warm <strong>${peakTemp}°F</strong> peak — stock water in vans.`);
    if (minTemp <= 32 && minTemp !== 999) advisories.push(`Freezing temps (<strong>${minTemp}°F</strong>) — black-ice risk on early routes.`);
    if (peakRain >= 60) {
      const wettest = hourlyPeriods.reduce((b, h) => ((h.probabilityOfPrecipitation?.value||0) > (b?.probabilityOfPrecipitation?.value||0) ? h : b), null);
      const when = wettest ? fmtHour(wettest.startTime) : "";
      advisories.push(`<strong>${peakRain}%</strong> precip${when ? ` near <strong>${when}</strong>` : ""} — pad route times, plan covered handoffs.`);
    } else if (peakRain >= 40) {
      advisories.push(`<strong>${peakRain}%</strong> precip in delivery window.`);
    }

    const activeAlerts = (alerts?.features || [])
      .map(f => f?.properties)
      .filter(p => p && p.event)
      .sort((a, b) => {
        const rank = { Extreme: 0, Severe: 1, Moderate: 2, Minor: 3, Unknown: 4 };
        return (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9);
      })
      .slice(0, 5);

    const fmtExpires = (iso) => {
      try {
        const d = new Date(iso);
        const mins = Math.round((d - new Date()) / 60000);
        if (mins <= 0) return "expired";
        if (mins < 60) return `expires in ${mins}m`;
        const h = Math.floor(mins / 60), m = mins % 60;
        if (h < 24) return `expires in ${h}h${m ? ` ${m}m` : ""}`;
        const days = Math.floor(h / 24);
        return `expires in ${days}d`;
      } catch { return ""; }
    };

    const alertHtml = activeAlerts.length === 0
      ? ""
      : `<div style="display:flex;flex-direction:column;gap:5px;margin-top:8px;padding:6px 8px;background:rgba(229,62,62,.06);border-left:2px solid var(--red);border-radius:3px">
          <div class="task-eyebrow" style="margin-bottom:1px">${activeAlerts.length} active alert${activeAlerts.length > 1 ? "s" : ""}</div>
          ${activeAlerts.map(a => {
            const sev = a.severity === "Extreme" ? "var(--red)" : a.severity === "Severe" ? "var(--red)" : a.severity === "Moderate" ? "var(--amber)" : "var(--text-muted)";
            const exp = a.expires ? ` <span style="color:var(--text-subtle);font-weight:400">· ${escapeHtml(fmtExpires(a.expires))}</span>` : "";
            return `<div style="font-size:11px;color:${sev};line-height:1.35"><strong>${escapeHtml(a.event || "Alert")}</strong>${a.headline ? ` — ${escapeHtml(a.headline.slice(0, 130))}` : ""}${exp}</div>`;
          }).join("")}
        </div>`;

    const advisoryHtml = advisories.length === 0
      ? ""
      : `<div style="margin-top:8px"><div class="task-eyebrow" style="margin-bottom:3px">Driver advisory</div>
          ${advisories.map(a => `<div style="font-size:11px;color:var(--text);line-height:1.4;margin:1px 0">• ${a}</div>`).join("")}
        </div>`;

    const nowWind = parseInt(String(now.windSpeed || "").match(/(\d+)/)?.[1] || "0", 10);
    const nowDir = now.windDirection || "";

    // Live observation conversions
    const cToF = (c) => c == null ? null : Math.round(c * 9/5 + 32);
    const kphToMph = (k) => k == null ? null : Math.round(k * 0.621371);
    const paToInHg = (p) => p == null ? null : (p * 0.0002953).toFixed(2);
    const mToMi = (m) => m == null ? null : (m / 1609.344).toFixed(1);
    const obsTempF = obs ? cToF(obs.temperature?.value) : null;
    const obsHumidity = obs ? Math.round(obs.relativeHumidity?.value ?? -1) : -1;
    const obsGustMph = obs ? kphToMph(obs.windGust?.value) : null;
    const obsPressureInHg = obs ? paToInHg(obs.barometricPressure?.value) : null;
    const obsVisibilityMi = obs ? mToMi(obs.visibility?.value) : null;
    const obsTimestamp = obs?.timestamp || null;

    // Hourly humidity for index 0 (right now-ish) for "feels like" fallback
    const h0 = hourlyPeriods[0] || {};
    const rhNow = obsHumidity > 0 ? obsHumidity : (h0.relativeHumidity?.value ?? null);
    const tNow = obsTempF != null ? obsTempF : now.temperature;
    const windNow = obsGustMph != null ? obsGustMph : nowWind;

    // Heat index (Rothfusz) — valid when T >= 80°F and RH >= 40
    const heatIndex = (T, RH) => {
      if (T < 80 || RH < 40) return null;
      const HI = -42.379 + 2.04901523*T + 10.14333127*RH - 0.22475541*T*RH
                - 0.00683783*T*T - 0.05481717*RH*RH + 0.00122874*T*T*RH
                + 0.00085282*T*RH*RH - 0.00000199*T*T*RH*RH;
      return Math.round(HI);
    };
    // Wind chill — valid when T <= 50°F and V >= 3 mph
    const windChill = (T, V) => {
      if (T > 50 || V < 3) return null;
      const WC = 35.74 + 0.6215*T - 35.75*Math.pow(V, 0.16) + 0.4275*T*Math.pow(V, 0.16);
      return Math.round(WC);
    };
    let feelsLike = null;
    let feelsKind = "";
    if (rhNow != null) {
      const hi = heatIndex(tNow, rhNow);
      if (hi != null && hi !== tNow) { feelsLike = hi; feelsKind = "Feels like"; }
    }
    if (feelsLike == null) {
      const wc = windChill(tNow, windNow);
      if (wc != null && wc !== tNow) { feelsLike = wc; feelsKind = "Feels like"; }
    }

    // Heat-index advisory (highest takes priority of existing peakTemp checks)
    if (feelsLike != null && feelsLike >= 100 && peakTemp < 95) {
      advisories.unshift(`Heat index <strong>${feelsLike}°F</strong> right now — push hydration breaks, watch for heat stress.`);
    }

    // Sunrise/sunset (display in browser local time)
    const fmtTime = (iso) => {
      try {
        const d = new Date(iso);
        return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).toLowerCase().replace(" ", "");
      } catch { return ""; }
    };
    const sunLine = sun
      ? (() => {
          const sr = fmtTime(sun.sunrise);
          const ss = fmtTime(sun.sunset);
          // Headlight cutoff context — civil twilight end
          const ct = fmtTime(sun.civil_twilight_end);
          const now = new Date();
          const sunsetD = new Date(sun.sunset);
          const minsToSunset = Math.round((sunsetD - now) / 60000);
          let cutoffNote = "";
          if (minsToSunset > 0 && minsToSunset < 180) {
            cutoffNote = ` · <strong style="color:var(--amber)">${minsToSunset >= 60 ? Math.floor(minsToSunset/60)+"h " : ""}${minsToSunset%60}m to sunset</strong>`;
          }
          return `<div style="font-size:11px;color:var(--text-subtle);margin-top:2px">☀ Sunrise <strong style="color:var(--text)">${sr}</strong> · Sunset <strong style="color:var(--text)">${ss}</strong>${ct ? ` · Headlights ${ct}` : ""}${cutoffNote}</div>`;
        })()
      : "";

    // "Right now" detail line — humidity, gust, pressure, visibility
    const obsBits = [];
    if (rhNow != null && rhNow >= 0) obsBits.push(`Humidity <strong style="color:var(--text)">${rhNow}%</strong>`);
    if (obsGustMph && obsGustMph > nowWind) obsBits.push(`Gust <strong style="color:${obsGustMph >= 25 ? "var(--red)" : obsGustMph >= 18 ? "var(--amber)" : "var(--text)"}">${obsGustMph} mph</strong>`);
    if (obsPressureInHg) obsBits.push(`Pressure <strong style="color:var(--text)">${obsPressureInHg} inHg</strong>`);
    if (obsVisibilityMi && parseFloat(obsVisibilityMi) < 5) obsBits.push(`Vis <strong style="color:var(--amber)">${obsVisibilityMi} mi</strong>`);
    const obsLine = obsBits.length
      ? `<div style="font-size:11px;color:var(--text-subtle);margin-top:2px">${obsBits.join(" · ")}</div>`
      : "";

    const today    = dayPairs[0];
    const tomorrow = dayPairs[1];
    const dayLine = (d) => d
      ? `<div style="font-size:11px;color:var(--text-subtle);line-height:1.4">
           <strong style="color:var(--text)">${escapeHtml(d.label)}</strong>
           Hi <strong style="color:var(--text);font-variant-numeric:tabular-nums">${d.hi}°</strong>${d.lo!=null ? ` / Lo <strong style="color:var(--text);font-variant-numeric:tabular-nums">${d.lo}°</strong>` : ""}
           · ${escapeHtml(d.short || "")}${d.precip ? ` · <strong style="color:${precipColor(d.precip)}">${d.precip}%</strong>` : ""}
         </div>`
      : "";

    // 7-day at-a-glance
    const weeklyHtml = dayPairs.slice(0, 7).map((d, idx) => {
      const wd = idx === 0 ? "Today" : (() => {
        try { return new Date(d.startTime).toLocaleDateString([], { weekday: "short" }); }
        catch { return d.label.slice(0, 3); }
      })();
      const summary = (d.short || "").slice(0, 18);
      return `<div style="display:flex;flex-direction:column;align-items:center;gap:2px;padding:6px 6px;border-radius:5px;min-width:62px;background:var(--canvas)">
        <div style="font-size:10px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.04em">${escapeHtml(wd)}</div>
        <div style="display:flex;align-items:baseline;gap:3px">
          <span style="font-size:13px;font-weight:700;color:${tempColor(d.hi)};font-variant-numeric:tabular-nums;line-height:1">${d.hi}°</span>
          ${d.lo!=null ? `<span style="font-size:10px;color:var(--text-subtle);font-variant-numeric:tabular-nums">${d.lo}°</span>` : ""}
        </div>
        <div style="font-size:9px;color:var(--text-subtle);text-align:center;line-height:1.15;max-width:72px">${escapeHtml(summary)}</div>
        ${d.precip ? `<div style="font-size:9px;font-weight:600;color:${precipColor(d.precip)};line-height:1">${d.precip}%</div>` : `<div style="height:9px"></div>`}
      </div>`;
    }).join("");

    body.innerHTML = `
      <div class="task-eyebrow" style="margin-bottom:2px">Weather${locName ? ` · ${escapeHtml(locName)}` : ""}${obsTimestamp ? ` · obs ${fmtTime(obsTimestamp)}` : ""}</div>
      <div style="display:flex;align-items:baseline;gap:10px;margin-top:2px;flex-wrap:wrap">
        <div style="font-size:26px;font-weight:700;color:var(--text);letter-spacing:-.02em;line-height:1;font-variant-numeric:tabular-nums">${tNow}°F</div>
        <div style="font-size:12px;color:var(--text);line-height:1.3;font-weight:600">${escapeHtml(now.shortForecast || "")}</div>
        ${feelsLike != null ? `<div style="font-size:11px;color:${feelsLike >= 100 ? "var(--red)" : feelsLike >= 90 ? "var(--amber)" : feelsLike <= 20 ? "#5b8def" : "var(--text-subtle)"};font-weight:600">${feelsKind} <span style="font-variant-numeric:tabular-nums">${feelsLike}°F</span></div>` : ""}
      </div>
      <div style="font-size:11px;color:var(--text-subtle);margin-top:2px">
        ${nowWind ? `Wind ${nowWind} mph${nowDir ? ` ${escapeHtml(nowDir)}` : ""}` : ""}${peakRain ? `${nowWind ? " · " : ""}${peakRain}% peak precip next 14h` : ""}
      </div>
      ${obsLine}
      ${sunLine}
      <div class="task-eyebrow" style="margin-top:10px;margin-bottom:4px">Next 14 hours</div>
      <div style="display:flex;gap:3px;overflow-x:auto;padding-bottom:2px">${hourlyHtml}</div>
      <div class="task-eyebrow" style="margin-top:10px;margin-bottom:4px">7-day outlook</div>
      <div style="display:flex;gap:4px;overflow-x:auto;padding-bottom:2px">${weeklyHtml}</div>
      <div style="margin-top:8px;display:flex;flex-direction:column;gap:3px">
        ${dayLine(today)}
        ${dayLine(tomorrow)}
      </div>
      ${advisoryHtml}
      ${alertHtml}`;
  } catch (err) {
    console.warn("weather load failed:", err);
    const isOutsideUS = String(err.message || "").includes("404");
    const detail = isOutsideUS
      ? `Saved coords <strong>${lat}, ${lon}</strong> aren't covered by NWS (US only). Common cause: longitude sign flipped — west of the prime meridian should be negative (e.g. <strong>-76.910</strong>).`
      : `Could not load forecast (${escapeHtml(err.message || String(err))}). Saved: <strong>${lat}, ${lon}</strong>.`;
    body.innerHTML = `<div class="task-eyebrow" style="margin-bottom:2px">Weather · station forecast</div>
      <div style="font-size:13px;color:var(--text-subtle);line-height:1.5">${detail}</div>`;
  }
}

// ─── Dashboard · Live radar (RainViewer + Leaflet + 2hr drive overlay) ─

let _weatherRadarState = null;
let _weatherRadarRefreshTimer = null;

function _ensureLeaflet() {
  if (window.L) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (!document.querySelector('link[data-rr-leaflet]')) {
      const css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
      css.crossOrigin = '';
      css.dataset.rrLeaflet = '1';
      document.head.appendChild(css);
    }
    const existing = document.querySelector('script[data-rr-leaflet]');
    if (existing) {
      const wait = setInterval(() => {
        if (window.L) { clearInterval(wait); resolve(); }
      }, 50);
      setTimeout(() => { clearInterval(wait); if (!window.L) reject(new Error('leaflet timeout')); }, 10000);
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
    script.crossOrigin = '';
    script.dataset.rrLeaflet = '1';
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('leaflet load failed'));
    document.head.appendChild(script);
  });
}

async function loadWeatherRadar() {
  const card = document.getElementById('rr-weather-radar-card');
  if (!card) return;
  const meta = window.RR?.dsp?.metadata?.weather || {};
  const lat = Number(meta.lat);
  const lon = Number(meta.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) { card.style.display = 'none'; return; }
  card.style.display = 'flex';

  try { await _ensureLeaflet(); } catch (e) { console.warn('leaflet load:', e); return; }

  const mapEl = document.getElementById('rr-radar-map');
  if (!mapEl) return;

  // First-time map setup
  if (!_weatherRadarState || !_weatherRadarState.map) {
    const map = L.map(mapEl, {
      center: [lat, lon],
      zoom: 8,
      zoomControl: true,
      scrollWheelZoom: false,
      attributionControl: false,
    });

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18 }).addTo(map);

    L.circleMarker([lat, lon], {
      radius: 6, color: '#fff', weight: 2, fillColor: '#e53e3e', fillOpacity: 1,
    }).addTo(map).bindTooltip('Station', { permanent: false });

    // 2hr drive ring (~120 mi at typical highway speeds)
    L.circle([lat, lon], {
      radius: 193121, color: '#3b82f6', weight: 1.5, dashArray: '6 4',
      fillColor: '#3b82f6', fillOpacity: 0.04,
    }).addTo(map).bindTooltip('2hr drive zone (~120 mi)', { permanent: false });

    _weatherRadarState = {
      map, frames: [], currentIdx: 0, layers: new Map(),
      playing: true, timer: null, host: '', pastCount: 0, color: 2,
    };

    // Recompute size after layout settles
    setTimeout(() => map.invalidateSize(), 100);
  }

  // Refresh frame catalog
  try {
    const res = await fetch('https://api.rainviewer.com/public/weather-maps.json');
    if (!res.ok) throw new Error(`rainviewer HTTP ${res.status}`);
    const data = await res.json();
    const past    = data.radar?.past || [];
    const nowcast = data.radar?.nowcast || [];
    const frames  = [...past, ...nowcast];
    if (!frames.length) return;

    const s = _weatherRadarState;
    // Drop stale layers from previous fetch
    for (const layer of s.layers.values()) s.map.removeLayer(layer);
    s.layers.clear();
    s.frames = frames;
    s.host   = data.host;
    s.pastCount = past.length;

    // Set scrubber max
    const scrub = document.getElementById('rr-radar-scrub');
    if (scrub) {
      scrub.max = String(frames.length - 1);
      scrub.value = String(past.length - 1);
    }

    setRadarFrame(past.length - 1);

    // Restart auto-play
    if (s.timer) clearInterval(s.timer);
    s.playing = true;
    const playBtn = document.getElementById('rr-radar-playpause');
    if (playBtn) playBtn.textContent = '⏸';
    s.timer = setInterval(() => {
      if (!s.playing) return;
      const next = (s.currentIdx + 1) % s.frames.length;
      setRadarFrame(next);
    }, 700);
  } catch (e) {
    console.warn('radar fetch:', e);
  }

  // Auto-refresh frame catalog every 5 min
  if (!_weatherRadarRefreshTimer) {
    _weatherRadarRefreshTimer = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      if (!document.getElementById('rr-radar-map')) return;
      loadWeatherRadar();
    }, 5 * 60 * 1000);
  }
}

function setRadarFrame(idx) {
  const s = _weatherRadarState;
  if (!s || !s.frames[idx]) return;

  if (!s.layers.has(idx)) {
    const f = s.frames[idx];
    const url = `${s.host}${f.path}/256/{z}/{x}/{y}/${s.color}/1_1.png`;
    const layer = L.tileLayer(url, { opacity: 0, tileSize: 256, zIndex: 100 + idx });
    layer.addTo(s.map);
    s.layers.set(idx, layer);
  }

  for (const [i, layer] of s.layers.entries()) {
    layer.setOpacity(i === idx ? 0.7 : 0);
  }

  s.currentIdx = idx;

  const tl = document.getElementById('rr-radar-timeline');
  if (tl) {
    const f = s.frames[idx];
    const t = new Date(f.time * 1000);
    const isLast = idx === s.pastCount - 1;
    const isPast = idx < s.pastCount;
    const offsetMin = Math.round((t.getTime() - Date.now()) / 60000);
    const label = isLast ? 'Now' : (isPast ? `${offsetMin}m` : `+${offsetMin}m`);
    const time = t.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const color = isPast ? (isLast ? 'var(--text)' : 'var(--text-subtle)') : 'var(--accent-text)';
    tl.style.color = color;
    tl.textContent = `${label} · ${time}`;
  }

  const scrub = document.getElementById('rr-radar-scrub');
  if (scrub && parseInt(scrub.value, 10) !== idx) scrub.value = String(idx);
}

// Radar controls — play/pause, scrub, color scheme
document.addEventListener('click', (e) => {
  if (e.target.closest('#rr-radar-playpause')) {
    if (!_weatherRadarState) return;
    _weatherRadarState.playing = !_weatherRadarState.playing;
    const btn = document.getElementById('rr-radar-playpause');
    if (btn) btn.textContent = _weatherRadarState.playing ? '⏸' : '▶';
  }
});
document.addEventListener('input', (e) => {
  if (e.target.id === 'rr-radar-scrub') {
    if (!_weatherRadarState) return;
    _weatherRadarState.playing = false;
    const btn = document.getElementById('rr-radar-playpause');
    if (btn) btn.textContent = '▶';
    setRadarFrame(parseInt(e.target.value, 10));
  }
});
document.addEventListener('change', (e) => {
  if (e.target.id === 'rr-radar-style') {
    if (!_weatherRadarState) return;
    _weatherRadarState.color = parseInt(e.target.value, 10) || 2;
    // Drop cached layers so new color takes effect
    for (const layer of _weatherRadarState.layers.values()) _weatherRadarState.map.removeLayer(layer);
    _weatherRadarState.layers.clear();
    setRadarFrame(_weatherRadarState.currentIdx);
  }
});

// Settings: Save station location → write to dsps.metadata.weather, refresh card.
document.addEventListener("click", async (e) => {
  if (!e.target.closest("#rr-set-weather-save")) return;
  e.preventDefault();
  const dspId = window.RR?.dsp?.id;
  const status = document.getElementById("rr-set-weather-status");
  const setStatus = (text, kind) => {
    if (!status) return;
    status.style.color = kind === "warn" ? "var(--red)" : kind === "ok" ? "var(--green)" : "var(--text-subtle)";
    status.textContent = text;
  };
  if (!dspId) { setStatus("DSP not loaded — refresh the page", "warn"); return; }

  const latRaw = (document.getElementById("rr-set-weather-lat")?.value || "").trim();
  const lonRaw = (document.getElementById("rr-set-weather-lon")?.value || "").trim();
  const lat = Number(latRaw);
  const lon = Number(lonRaw);
  if (latRaw === "" || lonRaw === "" || !Number.isFinite(lat) || !Number.isFinite(lon)
      || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    setStatus("Enter valid lat/lon (e.g. 38.886, -76.910)", "warn");
    return;
  }

  setStatus("Saving…");
  try {
    const { data: row, error: readErr } = await sb.from("dsps").select("metadata").eq("id", dspId).single();
    if (readErr) throw readErr;
    const meta = row?.metadata || {};
    const newMeta = { ...meta, weather: { ...(meta.weather || {}), lat, lon } };
    const { error: upErr } = await sb.from("dsps").update({ metadata: newMeta }).eq("id", dspId);
    if (upErr) throw upErr;
    if (window.RR?.dsp) window.RR.dsp.metadata = newMeta;
    setStatus(`Saved ✓ (${lat}, ${lon})`, "ok");
    setTimeout(() => setStatus(""), 4000);
    toast("Station location saved", "success");
    if (typeof loadDashboardWeather === "function") loadDashboardWeather();
  } catch (err) {
    console.error("weather save failed:", err);
    setStatus("Failed: " + (err.message || String(err)), "warn");
  }
});

// Pre-fill the settings inputs and show what's currently stored so the
// operator never has to guess whether their save took.
function _prefillWeatherInputs() {
  const meta = window.RR?.dsp?.metadata?.weather || {};
  const latEl = document.getElementById("rr-set-weather-lat");
  const lonEl = document.getElementById("rr-set-weather-lon");
  if (latEl && Number.isFinite(Number(meta.lat))) latEl.value = meta.lat;
  if (lonEl && Number.isFinite(Number(meta.lon))) lonEl.value = meta.lon;
  const status = document.getElementById("rr-set-weather-status");
  if (status && (Number.isFinite(Number(meta.lat)) || Number.isFinite(Number(meta.lon)))) {
    status.style.color = "var(--text-subtle)";
    status.textContent = `Currently saved: ${meta.lat}, ${meta.lon}`;
  }
}
document.addEventListener("click", (e) => {
  // Settings nav button (sidebar) or the Workspace section pill.
  if (e.target.closest('[data-rr-nav-item="settings"]') ||
      e.target.closest('a[href="#settings"]') ||
      e.target.closest('.settings-nav-item[data-set="workspace"]')) {
    setTimeout(_prefillWeatherInputs, 0);
  }
});
// Wrap the existing goto so navigating to settings also prefills.
const _legacyGotoForWeather = window.goto;
if (typeof _legacyGotoForWeather === "function") {
  window.goto = function (view) {
    const r = _legacyGotoForWeather(view);
    if (view === "settings") setTimeout(_prefillWeatherInputs, 0);
    return r;
  };
}


// ─── Dashboard · Today's tasks (Attendance card + header counts) ───────

async function loadDashboardTasks() {
  const dspId = window.RR?.dsp?.id;
  if (!dspId) return;
  const todayIso = fmtIsoDate(new Date());
  const weekStart = fmtIsoDate(startOfWeekMonday(new Date()));
  const weekEnd   = fmtIsoDate(addDays(new Date(weekStart + "T12:00:00"), 6));

  // Date eyebrow
  const eyebrow = document.getElementById("db-eyebrow");
  if (eyebrow) eyebrow.textContent = new Date().toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });

  // Today's shifts: total, present (completed), pending (scheduled), and stations.
  const [shiftsRes, stationsRes, recentAbsentRes] = await Promise.all([
    sb.from("shifts")
      .select("id, status, driver_id, station_id, starts_at, ends_at")
      .eq("dsp_id", dspId)
      .eq("date", todayIso),
    sb.from("stations").select("code, active").eq("dsp_id", dspId).eq("active", true),
    // 30-day absences for the "callout patterns" pill.
    sb.from("shifts")
      .select("driver_id, status")
      .eq("dsp_id", dspId)
      .in("status", ["called_off", "no_show"])
      .gte("date", fmtIsoDate(addDays(new Date(), -30)))
      .lte("date", todayIso),
  ]);

  const shifts = shiftsRes.data || [];
  const stations = stationsRes.data || [];

  const total       = shifts.length;
  const checkedIn   = shifts.filter(sh => sh.status === "completed" || sh.status === "late").length;
  const callouts    = shifts.filter(sh => sh.status === "called_off" || sh.status === "no_show").length;
  const coverageNeeded = shifts.filter(sh => sh.status !== "called_off" && sh.status !== "no_show").length;
  const coveragePct = total === 0 ? 0 : Math.round(checkedIn / Math.max(1, coverageNeeded) * 100);

  const setText = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  setText("dash-pip-checkin", checkedIn);
  setText("dash-pip-total", total);
  setText("dash-coverage", total === 0 ? "—" : `${coveragePct}%`);

  // Loadout = earliest scheduled start time today; stations comma-list.
  const earliest = shifts
    .filter(sh => sh.starts_at)
    .map(sh => new Date(sh.starts_at))
    .sort((a, b) => a - b)[0];
  const loadoutLabel = earliest
    ? `Loadout ${earliest.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`
    : "No shifts today";
  const stationLabel = stations.length > 0 ? ` · ${stations.map(s => s.code).join(", ")}` : "";
  setText("dash-pip-meta", `${loadoutLabel}${stationLabel}`);

  // "Callout patterns" — drivers with 3+ callouts/no-shows in last 30 days.
  const absencesPerDriver = new Map();
  for (const sh of (recentAbsentRes.data || [])) {
    if (!sh.driver_id) continue;
    absencesPerDriver.set(sh.driver_id, (absencesPerDriver.get(sh.driver_id) || 0) + 1);
  }
  const flagged = Array.from(absencesPerDriver.values()).filter(n => n >= 3).length;
  const flagEl = document.getElementById("dash-pip-flag");
  const flagTextEl = document.getElementById("dash-pip-flag-text");
  if (flagEl && flagTextEl) {
    if (flagged > 0) {
      flagEl.style.display = "";
      flagTextEl.textContent = `${flagged} callout pattern${flagged === 1 ? "" : "s"} flagged`;
    } else {
      flagEl.style.display = "none";
    }
  }
}

async function loadCheckinView() {
  const list = document.querySelector("#view-checkin .checkin-list");
  if (!list) return;
  const dspId = window.RR?.dsp?.id;
  if (!dspId) return;
  const todayIso = fmtIsoDate(new Date());

  const [driversRes, shiftsRes] = await Promise.all([
    sb.from("drivers")
      .select("id, full_name, first_name, last_name, preferred_name, phone, station:station_id (code), tier")
      .eq("dsp_id", dspId)
      .eq("status", "active"),
    sb.from("shifts")
      .select("id, driver_id, status")
      .eq("dsp_id", dspId)
      .eq("date", todayIso),
  ]);

  if (driversRes.error || shiftsRes.error) {
    console.warn("checkin load:", driversRes.error || shiftsRes.error);
    return;
  }
  const drivers = driversRes.data || [];
  const shifts  = shiftsRes.data  || [];

  const driverShift = new Map(); // driver_id -> shift row
  for (const sh of shifts) {
    if (sh.driver_id) driverShift.set(sh.driver_id, sh);
  }

  // Update head sub line + progress meta with today's actuals.
  const sub = document.querySelector("#view-checkin .page-sub");
  if (sub) {
    const expected = drivers.filter(d => driverShift.has(d.id)).length;
    sub.textContent = `${new Date().toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })} · ${expected} drivers expected`;
  }

  const rows = drivers
    .filter(d => driverShift.has(d.id))
    .map(d => {
      const display = displayDriverName(d);
      const initials = displayDriverInitials(d);
      const station = d.station?.code || "—";
      const tier = d.tier ? `tier-${String(d.tier).toLowerCase()}` : "tier-c";
      const sh = driverShift.get(d.id);
      const ciKey = _STATUS_TO_CI[sh.status]; // present / late / callout / noshow / undefined
      const markedClass = ciKey ? ` marked marked-${ciKey === "callout" ? "callout" : ciKey === "noshow" ? "noshow" : ciKey}` : "";
      const btn = (key, title, svg) => {
        const active = ciKey === key ? " active" : "";
        return `<button type="button" class="status-btn s-${key}${active}" data-rr-ci-shift="${sh.id}" data-rr-ci-status="${key}" title="${title}">${svg}</button>`;
      };
      return `<div class="checkin-row${markedClass}" data-name="${escapeHtml(initials)}">
        <div class="checkin-driver">
          <div class="avatar-sm ${tier}">${initials}</div>
          <div>
            <div class="checkin-driver-name">${escapeHtml(display)}</div>
            <div class="checkin-driver-meta">${escapeHtml(d.phone || "")}</div>
          </div>
        </div>
        <div class="checkin-station">${escapeHtml(station)}</div>
        <div class="status-row">
          ${btn("present", "Present", '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>')}
          ${btn("late",    "Late",    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>')}
          ${btn("callout", "Callout", '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>')}
          ${btn("noshow",  "No-show", '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>')}
        </div>
      </div>`;
    });

  list.innerHTML = rows.length === 0
    ? `<div style="padding:32px;text-align:center;color:var(--text-subtle)">No shifts scheduled for today.</div>`
    : rows.join("");

  _updateCheckinProgress();
}

function _updateCheckinProgress() {
  const list = document.querySelector("#view-checkin .checkin-list");
  if (!list) return;
  const total = list.querySelectorAll(".checkin-row").length;
  const marked = list.querySelectorAll(".checkin-row.marked").length;
  const pct = total > 0 ? Math.round(marked / total * 100) : 0;
  const fill = document.getElementById("ci-progress");
  if (fill) fill.style.width = `${pct}%`;
  const m = document.getElementById("ci-marked");
  if (m) m.textContent = String(marked);
  const meta = document.querySelector("#view-checkin .checkin-progress-meta span:first-child");
  if (meta) meta.textContent = `${marked} of ${total} marked`;
}

// Click handler: write the status to public.shifts and toggle UI.
document.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-rr-ci-shift][data-rr-ci-status]");
  if (!btn) return;
  e.preventDefault();
  const shiftId = btn.dataset.rrCiShift;
  const ciKey   = btn.dataset.rrCiStatus;
  const newStatus = _CI_TO_STATUS[ciKey];
  if (!shiftId || !newStatus) return;

  const row = btn.closest(".checkin-row");
  const { error } = await sb.from("shifts").update({ status: newStatus }).eq("id", shiftId);
  if (error) { toast("Save failed: " + error.message, "warn"); return; }

  // Visual: clear sibling active states, mark row, add active to clicked.
  if (row) {
    row.classList.remove("marked-present", "marked-late", "marked-callout", "marked-noshow");
    row.classList.add("marked", `marked-${ciKey === "noshow" ? "noshow" : ciKey === "callout" ? "callout" : ciKey}`);
    row.querySelectorAll(".status-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
  }
  _updateCheckinProgress();
});


// ─── Drivers · Attendance · Policy + Event log ──────────────────────────

const _ATT_DEFAULT_POLICY = {
  mode: "points",            // points | occurrence | hybrid
  decay_days: 90,
  points_per_callout: 1,
  points_per_noshow: 3,
  threshold_warn: 3,
  threshold_action: 6,
};

function _getAttPolicy() {
  const p = window.RR?.dsp?.metadata?.attendance?.policy || {};
  return { ..._ATT_DEFAULT_POLICY, ...p };
}

async function loadAttendancePolicy() {
  const pane = document.getElementById("att-pane-policy");
  if (!pane) return;
  const dspId = window.RR?.dsp?.id;
  if (!dspId) return;

  const { data, error } = await sb.from("dsps").select("metadata").eq("id", dspId).single();
  if (error) { console.warn("policy load:", error.message); return; }
  const meta = data?.metadata || {};
  if (window.RR?.dsp) window.RR.dsp.metadata = meta;
  const p = { ..._ATT_DEFAULT_POLICY, ...(meta?.attendance?.policy || {}) };

  // Re-render the Policy pane with editable inputs (operator-friendly,
  // not the elaborate mockup variant — just the values that matter for
  // computation).
  pane.innerHTML = `
    <div class="pol-section">
      <h3 class="pol-section-title">Mode</h3>
      <p class="pol-section-sub">Most DSPs use <strong>Points-based</strong>: each event has a point value, thresholds trigger an action.</p>
      <div class="pol-mode-row">
        ${["points","occurrence","hybrid"].map(m => `
          <button class="pol-mode-btn${p.mode === m ? " active" : ""}" type="button" data-rr-att-mode="${m}">
            <div class="pol-mode-title">${m === "points" ? "Points-based" : m === "occurrence" ? "Occurrence-based" : "Hybrid"}</div>
          </button>`).join("")}
      </div>
    </div>
    <div class="pol-section">
      <h3 class="pol-section-title">Point values</h3>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;max-width:520px">
        <label style="display:flex;flex-direction:column;gap:4px"><span style="font-size:11px;font-weight:600;color:var(--text-muted);letter-spacing:.04em;text-transform:uppercase">Callout</span>
          <input type="number" min="0" max="20" step="0.5" class="form-input" data-rr-att-field="points_per_callout" value="${p.points_per_callout}"/></label>
        <label style="display:flex;flex-direction:column;gap:4px"><span style="font-size:11px;font-weight:600;color:var(--text-muted);letter-spacing:.04em;text-transform:uppercase">No-show</span>
          <input type="number" min="0" max="20" step="0.5" class="form-input" data-rr-att-field="points_per_noshow" value="${p.points_per_noshow}"/></label>
      </div>
    </div>
    <div class="pol-section">
      <h3 class="pol-section-title">Thresholds</h3>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px;max-width:760px">
        <label style="display:flex;flex-direction:column;gap:4px"><span style="font-size:11px;font-weight:600;color:var(--text-muted);letter-spacing:.04em;text-transform:uppercase">Warn at</span>
          <input type="number" min="1" max="40" step="1" class="form-input" data-rr-att-field="threshold_warn" value="${p.threshold_warn}"/></label>
        <label style="display:flex;flex-direction:column;gap:4px"><span style="font-size:11px;font-weight:600;color:var(--text-muted);letter-spacing:.04em;text-transform:uppercase">Action at</span>
          <input type="number" min="1" max="40" step="1" class="form-input" data-rr-att-field="threshold_action" value="${p.threshold_action}"/></label>
        <label style="display:flex;flex-direction:column;gap:4px"><span style="font-size:11px;font-weight:600;color:var(--text-muted);letter-spacing:.04em;text-transform:uppercase">Decay window (days)</span>
          <input type="number" min="14" max="365" step="1" class="form-input" data-rr-att-field="decay_days" value="${p.decay_days}"/></label>
      </div>
    </div>
    <div style="display:flex;align-items:center;gap:10px">
      <button class="btn btn-primary" type="button" id="rr-att-policy-save">Save policy</button>
      <span id="rr-att-policy-status" style="font-size:12px;color:var(--text-subtle)"></span>
    </div>`;
}

document.addEventListener("click", async (e) => {
  // Mode selector click
  const modeBtn = e.target.closest("[data-rr-att-mode]");
  if (modeBtn) {
    document.querySelectorAll("[data-rr-att-mode]").forEach(b => b.classList.toggle("active", b === modeBtn));
    return;
  }
  // Save policy
  if (e.target.id === "rr-att-policy-save") {
    e.preventDefault();
    const dspId = window.RR?.dsp?.id;
    if (!dspId) return;
    const status = document.getElementById("rr-att-policy-status");
    const fields = {};
    document.querySelectorAll("[data-rr-att-field]").forEach(el => {
      fields[el.dataset.rrAttField] = Number(el.value);
    });
    const mode = document.querySelector("[data-rr-att-mode].active")?.dataset.rrAttMode || "points";
    const newPolicy = { ..._ATT_DEFAULT_POLICY, ...fields, mode };

    if (status) { status.style.color = "var(--text-subtle)"; status.textContent = "Saving…"; }
    const { data: row } = await sb.from("dsps").select("metadata").eq("id", dspId).single();
    const meta = row?.metadata || {};
    const newMeta = { ...meta, attendance: { ...(meta.attendance || {}), policy: newPolicy } };
    const { error: upErr } = await sb.from("dsps").update({ metadata: newMeta }).eq("id", dspId);
    if (upErr) { if (status) { status.style.color = "var(--red)"; status.textContent = "Failed: " + upErr.message; } return; }
    if (window.RR?.dsp) window.RR.dsp.metadata = newMeta;
    if (status) { status.style.color = "var(--green)"; status.textContent = "Saved ✓"; setTimeout(() => status.textContent = "", 2500); }
    toast("Attendance policy saved", "success");
    // Refresh report tab to use new policy thresholds.
    if (typeof loadAttendanceLive === "function") loadAttendanceLive();
  }
});


async function loadAttendanceEventLog() {
  const pane = document.getElementById("att-pane-log");
  if (!pane) return;
  const dspId = window.RR?.dsp?.id;
  if (!dspId) return;

  const policy = _getAttPolicy();
  const since = new Date(); since.setDate(since.getDate() - policy.decay_days);
  const sinceIso = fmtIsoDate(since);

  const [shiftsRes, driversRes] = await Promise.all([
    sb.from("shifts")
      .select("id, date, status, driver_id")
      .eq("dsp_id", dspId)
      .in("status", ["called_off", "no_show", "late"])
      .gte("date", sinceIso)
      .order("date", { ascending: false }),
    sb.from("drivers")
      .select("id, full_name, first_name, last_name, preferred_name, station:station_id (code), tier")
      .eq("dsp_id", dspId),
  ]);

  if (shiftsRes.error || driversRes.error) {
    console.warn("event log load:", shiftsRes.error || driversRes.error);
    return;
  }

  const drvById = new Map((driversRes.data || []).map(d => [d.id, d]));
  const events = (shiftsRes.data || []).filter(sh => sh.driver_id);

  const countEl = document.getElementById("att-log-count");
  if (countEl) countEl.textContent = String(events.length);

  if (events.length === 0) {
    pane.innerHTML = `<div style="padding:32px;text-align:center;color:var(--text-subtle);font-size:13px">No callouts, no-shows, or late events in the last ${policy.decay_days} days.</div>`;
    return;
  }

  const eventLabel = { called_off: "Callout", no_show: "No-show", late: "Late" };
  const eventColor = { called_off: "var(--amber)", no_show: "var(--red)", late: "var(--text-muted)" };

  pane.innerHTML = `
    <div class="table-wrap"><table class="table">
      <thead><tr><th>Date</th><th>Driver</th><th>Station</th><th>Event</th><th style="text-align:right">Points</th></tr></thead>
      <tbody>
        ${events.map(ev => {
          const d = drvById.get(ev.driver_id);
          const display = d ? displayDriverName(d) : "—";
          const station = d?.station?.code || "—";
          const initials = d ? displayDriverInitials(d) : "?";
          const tier = d?.tier ? `tier-${String(d.tier).toLowerCase()}` : "tier-c";
          const points = ev.status === "no_show" ? policy.points_per_noshow : ev.status === "called_off" ? policy.points_per_callout : 0;
          return `<tr>
            <td>${new Date(ev.date + "T12:00:00").toLocaleDateString()}</td>
            <td><div class="cell-driver"><div class="avatar-sm ${tier}">${initials}</div><div><div class="cell-name">${escapeHtml(display)}</div></div></div></td>
            <td>${escapeHtml(station)}</td>
            <td><span style="color:${eventColor[ev.status]};font-weight:600">${eventLabel[ev.status]}</span></td>
            <td style="text-align:right;font-weight:600">${points}</td>
          </tr>`;
        }).join("")}
      </tbody>
    </table></div>`;
}

// Hook attTab — operator clicks Report / Policy / Log inside the
// Drivers → Attendance subview. The mockup defines window.attTab on
// load; wrap it so we can also fire our live loaders.
const _legacyAttTab = window.attTab;
window.attTab = function (name) {
  if (typeof _legacyAttTab === "function") _legacyAttTab(name);
  if (name === "report") loadAttendanceLive();
  if (name === "policy") loadAttendancePolicy();
  if (name === "log")    loadAttendanceEventLog();
};


async function loadDriverLicensesView() {
  const body = document.getElementById("lic-renewals-body");
  const status = document.getElementById("lic-panel-status");
  if (!body) return;

  // Wipe synchronously so any mockup-rendered rows can't flash through
  // while the live select is in flight.
  body.innerHTML = `<div style="padding:24px;text-align:center;color:var(--text-subtle);font-size:13px">Loading…</div>`;
  if (status) status.textContent = "—";
  // Hydrate the renewal-reminders settings card from dsp.metadata.licenses.
  const lic = window.RR?.dsp?.metadata?.licenses || {};
  const tg = document.getElementById("rr-lic-toggle");
  if (tg) tg.classList.toggle("on", lic.auto_reminders !== false);
  const blk = document.getElementById("rr-lic-block");
  if (blk) blk.classList.toggle("on", lic.block_past_expiry !== false);
  const days = document.getElementById("rr-lic-days");
  if (days) days.value = Array.isArray(lic.reminder_days) ? lic.reminder_days.join(", ") : "30, 14";
  const tpl = document.getElementById("rr-lic-template");
  if (tpl && lic.sms_template) tpl.value = lic.sms_template;

  const { data: rows, error } = await sb.from("drivers")
    .select("id, full_name, station:station_id (code), dl_number, dl_expires_on, status")
    .eq("dsp_id", window.RR.dsp.id)
    .not("dl_expires_on", "is", null)
    .order("dl_expires_on", { ascending: true })
    .limit(500);

  if (error) {
    body.innerHTML = `<div style="padding:16px;color:var(--red);font-size:13px">${escapeHtml(error.message)}</div>`;
    return;
  }
  if (!rows || rows.length === 0) {
    body.innerHTML = `<div style="padding:32px;text-align:center;color:var(--text-subtle);font-size:13px">
      <strong style="color:var(--text-muted);display:block;margin-bottom:4px">No license dates on file</strong>
      Open a driver record → License tab to add a license number and expiration.
    </div>`;
    if (status) status.textContent = "0 drivers with licenses";
    return;
  }

  const today = Date.now();
  const expired = rows.filter(r => new Date(r.dl_expires_on).getTime() < today).length;
  const within30 = rows.filter(r => {
    const t = new Date(r.dl_expires_on).getTime();
    return t >= today && t < today + 30 * 86400000;
  }).length;
  if (status) status.textContent = `${expired} expired · ${within30} within 30 days · ${rows.length} total`;

  body.innerHTML = `
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;overflow:hidden">
      <div style="display:grid;grid-template-columns:1fr 110px 110px 130px 90px;gap:12px;padding:10px 16px;background:var(--canvas);font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--text-muted)">
        <div>Driver</div>
        <div>Station</div>
        <div>DL number</div>
        <div>Expires</div>
        <div></div>
      </div>
      ${rows.map(renderLicenseRow).join("")}
    </div>`;
}

function renderLicenseRow(d) {
  const exp = new Date(d.dl_expires_on);
  const days = Math.floor((exp.getTime() - Date.now()) / 86400000);
  let bg = "";
  let pillStyle = "color:var(--text-subtle)";
  let label = `Expires in ${days}d`;
  if (days < 0) {
    bg = "background:rgba(220,38,38,.08)";
    pillStyle = "color:var(--red);font-weight:700";
    label = `Expired ${-days}d ago`;
  } else if (days <= 30) {
    bg = "background:rgba(245,158,11,.08)";
    pillStyle = "color:#B45309;font-weight:700";
    label = `Expires in ${days}d`;
  }
  const initials = displayDriverInitials(d);
  return `
    <div data-driver-id="${d.id}" data-rr-open-driver style="display:grid;grid-template-columns:1fr 110px 110px 130px 90px;gap:12px;padding:12px 16px;border-top:1px solid var(--border);align-items:center;cursor:pointer;${bg}">
      <div style="display:flex;align-items:center;gap:10px">
        <div class="avatar-sm tier-c">${initials}</div>
        <div><div style="font-size:13px;font-weight:600">${escapeHtml(displayDriverName(d))}</div></div>
      </div>
      <div style="font-size:13px">${escapeHtml(d.station?.code || "—")}</div>
      <div style="font-size:13px;font-family:'SF Mono',Menlo,monospace">${escapeHtml(d.dl_number || "—")}</div>
      <div style="font-size:13px">${exp.toLocaleDateString()}<div style="font-size:11px;${pillStyle}">${label}</div></div>
      <div><button class="btn btn-sm" data-rr-open-driver data-driver-id="${d.id}">Edit</button></div>
    </div>`;
}

const _legacyDrSub = window.drSub;
window.drSub = function (sub) {
  if (typeof _legacyDrSub === "function") _legacyDrSub(sub);
  if (sub === "licenses")   loadDriverLicensesView();
  if (sub === "roster")     loadDriversRoster();
  if (sub === "attendance") loadAttendanceLive();
};


// Capture-phase delegate for renewal-reminder settings (Drivers → Licenses).
document.addEventListener("click", async (e) => {
  const tg = e.target.closest("[data-rr-lic-toggle], [data-rr-lic-block]");
  if (tg) { e.preventDefault(); e.stopImmediatePropagation(); tg.classList.toggle("on"); return; }

  if (e.target.closest("[data-rr-lic-save]")) {
    e.preventDefault();
    e.stopImmediatePropagation();
    const status = document.getElementById("rr-lic-status");
    const enabled  = document.getElementById("rr-lic-toggle")?.classList.contains("on");
    const block    = document.getElementById("rr-lic-block")?.classList.contains("on");
    const daysRaw  = document.getElementById("rr-lic-days")?.value || "";
    const template = document.getElementById("rr-lic-template")?.value || "";
    const days = daysRaw.split(/[,\s]+/).map(s => parseInt(s, 10)).filter(n => Number.isFinite(n) && n > 0);

    status.className = "cal-edit-status";
    status.textContent = "Saving…";

    const { data: dsp, error: rErr } = await sb.from("dsps").select("metadata").eq("id", window.RR.dsp.id).single();
    if (rErr) { status.className = "cal-edit-status err"; status.textContent = rErr.message; return; }
    const md = dsp.metadata || {};
    md.licenses = {
      auto_reminders:    !!enabled,
      block_past_expiry: !!block,
      reminder_days:     days,
      sms_template:      template,
    };
    const { error: wErr } = await sb.from("dsps").update({ metadata: md }).eq("id", window.RR.dsp.id);
    if (wErr) { status.className = "cal-edit-status err"; status.textContent = wErr.message; return; }
    window.RR.dsp.metadata = md;
    status.className = "cal-edit-status ok";
    status.textContent = `Saved at ${new Date().toLocaleTimeString()}`;
  }
}, true);

function renderDriverStatusBadge(s) {
  const map = {
    onboarding: { label: "Onboarding", style: "background:rgba(124,58,237,.14);color:#7C3AED" },
    active:     { label: "Active",     style: "background:var(--green-soft);color:var(--green)" },
    leave:      { label: "On leave",   style: "background:var(--amber-soft);color:var(--amber)" },
    inactive:   { label: "Inactive",   style: "background:var(--canvas);color:var(--text-subtle)" },
    terminated: { label: "Terminated", style: "background:var(--red-soft);color:var(--red)" },
  };
  const v = map[s] || { label: s, style: "" };
  return `<span class="tag" style="${v.style}">${v.label}</span>`;
}

async function refreshDriverStatRow(rows) {
  // Active / onboarding / inactive counts.
  const counts = { active: 0, onboarding: 0, leave: 0, inactive: 0, terminated: 0 };
  for (const r of rows) counts[r.status] = (counts[r.status] || 0) + 1;
  const inactiveTotal = (counts.inactive || 0) + (counts.leave || 0) + (counts.terminated || 0);

  // At-risk: drivers with status='active' AND score < 70 (placeholder
  // until the at-risk model lands).
  const atRiskCount = rows.filter(r => r.status === "active" && (r.score ?? 999) < 70).length;

  // Update the stage-tab badges (Active / Onboarding / At risk / Inactive).
  const tabCounts = {
    active:     counts.active,
    onboarding: counts.onboarding,
    atrisk:     atRiskCount,
    inactive:   inactiveTotal,
  };
  Object.entries(tabCounts).forEach(([stage, n]) => {
    const el = document.querySelector(`.dr-subview .stage-tab[data-stage="${stage}"] .stage-tab-count`);
    if (el) el.textContent = n;
  });

  // Coachings in last 7 days.
  const sevenAgo = new Date(Date.now() - 7 * 86400000).toISOString();
  const { count: coachedCount } = await sb.from("coachings")
    .select("*", { count: "exact", head: true })
    .eq("dsp_id", window.RR.dsp.id)
    .gte("occurred_at", sevenAgo);

  // Avg score (over rows that have a score).
  const scored = rows.filter(r => r.score != null);
  const avgScore = scored.length === 0
    ? "—"
    : Math.round(scored.reduce((s, r) => s + Number(r.score), 0) / scored.length);

  const tiles = document.querySelectorAll(".driver-stat-row .stat-mini");
  if (tiles.length >= 4) {
    setStatTile(tiles[0], "Active",  counts.active,  `${counts.onboarding} onboarding · ${inactiveTotal} inactive`);
    setStatTile(tiles[1], "Avg score", avgScore,     "Per-driver score, latest");
    setStatTile(tiles[2], "At risk", atRiskCount,    "Active drivers below 70");
    setStatTile(tiles[3], "Coached this week", coachedCount ?? 0, "From the coachings log");
  }
}

function setStatTile(tile, label, value, sub) {
  tile.querySelector(".stat-mini-label").textContent = label;
  tile.querySelector(".stat-mini-value").textContent = value;
  const s = tile.querySelector(".stat-mini-sub");
  if (s) s.textContent = sub;
}

function tenureLabel(hireDate) {
  const d = new Date(hireDate);
  if (isNaN(d)) return "—";
  const months = Math.max(0, Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24 * 30)));
  if (months < 1) {
    const days = Math.max(0, Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24)));
    return `${days}d`;
  }
  return `${months} mo`;
}

// Show the driver's preferred first name (when set) followed by last_name.
// Falls back to first_name → full_name. Used everywhere drivers are listed.
function displayDriverName(d) {
  const pref = (d?.preferred_name || "").trim();
  const first = pref || (d?.first_name || "").trim();
  const last  = (d?.last_name || "").trim();
  if (first && last) return `${first} ${last}`;
  return (first || last || (d?.full_name || "")).trim();
}
function displayDriverInitials(d) {
  const pref = (d?.preferred_name || "").trim();
  const first = pref || (d?.first_name || "").trim();
  const last  = (d?.last_name || "").trim();
  if (first || last) {
    const a = first[0] || "";
    const b = last[0]  || "";
    return (a + b).toUpperCase() || "?";
  }
  return (d?.full_name || "").split(/\s+/).map(p => p[0]).filter(Boolean).slice(0, 2).join("").toUpperCase() || "?";
}

// ─── Add applicant ─────────────────────────────────────────────────────────
//
// We bind via event delegation on a data-attribute, not by overriding the
// mockup's window.submitAddApplicant(). Module top-level await means the
// global override happens later than DOM-paint, and inline onclick handlers
// would fire the mockup stub if the user clicked early.

async function doAddApplicant() {
  const fn    = document.getElementById("aa-fn").value.trim();
  const ln    = document.getElementById("aa-ln").value.trim();
  const phone = document.getElementById("aa-phone").value.trim();
  const email = document.getElementById("aa-email").value.trim();
  const source = (document.querySelector("#modal-add-applicant .cd-pill.active")?.textContent || "Indeed").toLowerCase();

  if (!fn && !ln) { toast("Add a name first", "warn"); return; }
  if (!phone && !email) { toast("Phone or email required", "warn"); return; }

  const payload = {
    dsp_short_code: window.RR.dsp.short_code,
    first_name: fn || null,
    last_name:  ln || null,
    full_name:  `${fn} ${ln}`.trim(),
    phone:      phone ? toE164(phone) : null,
    email:      email || null,
    source,
  };

  const { data: applicant, error } = await sb.rpc("intake_applicant", { p_payload: payload });
  if (error) { toast("Add failed: " + error.message, "warn"); return; }

  if ((applicant.phone || applicant.email) && applicant.status === "applied") {
    await sb.rpc("send_screening_link", { p_id: applicant.id });
  }

  closeModal("modal-add-applicant");
  await loadPipeline("all");
  toast(`${applicant.full_name} added · screening invite queued`, "success");
}

// ─── Add driver ────────────────────────────────────────────────────────────
//
// Mockup's submitAddDriver() and modal-add-driver were a simple form. We
// route the Drivers-page "Add driver" button to the same rich driver-record
// drawer used for editing — but in CREATE mode (no driverId). On save we
// insert directly into public.drivers (the update_driver_record RPC doesn't
// accept station_id today, so create mode bypasses it).

const _originalOpenModal = window.openModal;
window.openModal = function (id) {
  if (id === "modal-add-driver") { openDriverDrawer(null); return; }
  if (typeof _originalOpenModal === "function") _originalOpenModal(id);
};

let _driverStationsCache = null;
async function getDriverStationsCached() {
  if (_driverStationsCache) return _driverStationsCache;
  const dspId = window.RR?.dsp?.id;
  if (!dspId) return [];
  const { data, error } = await sb.from("stations")
    .select("id, code, name, active")
    .eq("dsp_id", dspId)
    .eq("active", true)
    .order("code");
  if (error) { console.warn("stations load:", error.message); return []; }
  _driverStationsCache = data || [];
  return _driverStationsCache;
}

// ─── Bulk ingest (paste from Indeed CSV/TSV) ───────────────────────────────
//
// Accepts tab-OR comma-delimited paste with a header row. Maps any of
// these header labels to our fields:
//   name     ← "name", "applicant name", "full name", "candidate name"
//   first    ← "first name", "first", "given name"
//   last     ← "last name", "last", "surname", "family name"
//   email    ← "email", "email address", "e-mail"
//   phone    ← "phone", "phone number", "mobile", "cell"
//
// At minimum we need (name OR first+last) and (phone OR email). Rows
// missing both are skipped with a counter shown in the result toast.

function parseBulkText(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) return { rows: [], skipped: 0, headers: [] };

  // Detect delimiter: tab if any tab in header, else comma.
  const delim = lines[0].includes("\t") ? "\t" : ",";
  const headers = splitCsv(lines[0], delim).map(h => h.toLowerCase().trim());

  const idx = (...names) => headers.findIndex(h => names.some(n => h === n || h.includes(n)));
  const iName  = idx("applicant name", "candidate name", "full name", "name");
  const iFirst = idx("first name", "first", "given");
  const iLast  = idx("last name", "last", "surname", "family");
  const iEmail = idx("email address", "e-mail", "email");
  const iPhone = idx("phone number", "phone", "mobile", "cell");

  const rows = [];
  let skipped = 0;
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsv(lines[i], delim);
    let first = iFirst >= 0 ? cols[iFirst]?.trim() : "";
    let last  = iLast  >= 0 ? cols[iLast]?.trim()  : "";
    const fullName = iName >= 0 ? cols[iName]?.trim() : "";

    if (!first && !last && fullName) {
      const parts = fullName.split(/\s+/);
      first = parts[0] || "";
      last  = parts.slice(1).join(" ");
    }
    const full = (fullName || `${first} ${last}`).trim();

    const email = iEmail >= 0 ? cols[iEmail]?.trim() : "";
    const phone = iPhone >= 0 ? cols[iPhone]?.trim() : "";

    if (!full)        { skipped++; continue; }
    if (!email && !phone) { skipped++; continue; }

    rows.push({
      first_name: first || null,
      last_name:  last  || null,
      full_name:  full,
      email:      email || null,
      phone:      phone ? toE164(phone) : null,
    });
  }
  return { rows, skipped, headers };
}

// Minimal CSV splitter: handles double-quoted fields with embedded commas.
function splitCsv(line, delim) {
  const out = [];
  let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (c === delim && !inQ) {
      out.push(cur); cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

// Loose phone normalizer → E.164. Stored as +1XXXXXXXXXX for US numbers,
// otherwise passes through anything already starting with +.
function toE164(raw) {
  const digits = String(raw).replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) return digits;
  if (digits.length === 10) return "+1" + digits;
  if (digits.length === 11 && digits.startsWith("1")) return "+" + digits;
  return digits ? "+" + digits : null;
}

async function doBulkIngest() {
  const text = document.getElementById("bi-paste").value;
  const { rows, skipped } = parseBulkText(text);
  if (rows.length === 0) {
    toast(`No importable rows. Need a header row with at least name + phone or email.`, "warn");
    return;
  }

  const btn = document.getElementById("bi-import-btn");
  btn.disabled = true;
  btn.textContent = `Importing 0 / ${rows.length}…`;

  let added = 0, dupes = 0, failed = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    btn.textContent = `Importing ${i + 1} / ${rows.length}…`;
    try {
      const { data: existing } = await sb.from("applicants")
        .select("id").eq("dsp_id", window.RR.dsp.id)
        .or(`email.eq.${row.email ?? "__none__"},phone.eq.${row.phone ?? "__none__"}`).limit(1);

      const { data: applicant, error } = await sb.rpc("intake_applicant", {
        p_payload: {
          dsp_short_code: window.RR.dsp.short_code,
          source: "indeed",
          ...row,
        },
      });
      if (error) { failed++; continue; }

      if (existing && existing.length > 0 && existing[0].id === applicant.id) {
        dupes++;
      } else {
        added++;
        if ((applicant.phone || applicant.email) && applicant.status === "applied") {
          await sb.rpc("send_screening_link", { p_id: applicant.id });
        }
      }
    } catch {
      failed++;
    }
  }

  closeModal("modal-bulk-ingest");
  await loadPipeline("all");
  toast(`Imported ${added} · ${dupes} duplicates · ${failed} failed${skipped ? ` · ${skipped} unparseable rows skipped` : ""}`,
    failed ? "warn" : "success");
}

// Capture-phase delegate for the two import buttons. Capture phase
// + stopImmediatePropagation guarantees we win even if the mockup's
// inline onclick somehow re-attaches.
document.addEventListener("click", (e) => {
  const add = e.target.closest("[data-rr-add-applicant]");
  if (add) {
    e.preventDefault();
    e.stopImmediatePropagation();
    doAddApplicant();
    return;
  }
  const bulk = e.target.closest("[data-rr-bulk-ingest]");
  if (bulk) {
    if (bulk.disabled) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    doBulkIngest();
  }
}, true);

// Sign-out hook: any element with [data-rr-signout] logs out.
document.addEventListener("click", async (e) => {
  if (e.target.closest("[data-rr-signout]")) {
    e.preventDefault();
    await sb.auth.signOut();
    location.replace("./login.html");
  }
});

// ─── Pipeline KPIs ─────────────────────────────────────────────────────────
//
// Hits the pipeline_kpis RPC and updates the Pipeline page's hp-show-rate /
// hp-hire-rate cells. RPC returns 0.75 / 0.75 fallback until the first
// interview day is closed; after that, rolling 30-day actuals.

// Selected lookback window for the KPI strip. Defaults to 4 weeks; the
// segmented control above the strip toggles between 7 / 28 / 3650.
let _kpiWindowDays = 28;

async function loadPipelineKpis() {
  syncKpiWindowToggle();

  const [{ data: kpi }, { data: funnel }] = await Promise.all([
    sb.rpc("pipeline_kpis",        { p_window_days: _kpiWindowDays }),
    sb.rpc("pipeline_funnel_kpis", { p_window_days: _kpiWindowDays }),
  ]);

  if (kpi) {
    setText("hp-show-rate", Math.round(Number(kpi.show_rate ?? 0) * 100));
    setText("hp-hire-rate", Math.round(Number(kpi.hire_rate ?? 0) * 100));
  }

  if (funnel) {
    setText("hp-contacted-pct", funnel.contacted_pct ?? 0);
    setText("hp-passed-pct",    funnel.passed_pct ?? 0);
    setText("hp-booked-pct",    funnel.booked_rate ?? 0);
    setText("hp-e2e",           funnel.e2e_pct ?? 0);
    const bsub = document.getElementById("hp-booked-sub");
    if (bsub) bsub.textContent = `${funnel.booked ?? 0} of ${funnel.invited ?? 0} sent a booking link`;
    const esub = document.getElementById("hp-e2e-sub");
    if (esub) esub.textContent = `${funnel.hired ?? 0} hired ÷ ${funnel.total ?? 0} applicants`;
  }

  renderWeeksStrip();
}

function syncKpiWindowToggle() {
  document.querySelectorAll("[data-rr-window]").forEach((b) => {
    b.classList.toggle("active", parseInt(b.getAttribute("data-rr-window"), 10) === _kpiWindowDays);
  });
}

// Capture-phase delegate for the window toggle.
document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-rr-window]");
  if (!btn) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  _kpiWindowDays = parseInt(btn.getAttribute("data-rr-window"), 10) || 28;
  loadPipelineKpis();
}, true);


// ─── Dynamic 5-week strip ──────────────────────────────────────────────────
//
// Renders the next five upcoming weeks (does NOT include the current week —
// that belongs to the Schedule view). Auto-refreshes at the Sunday→Monday
// rollover so dashboards left open across midnight don't drift.

function isoWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

let _weeksStripRolloverTimer = null;
function _scheduleWeeksStripRollover() {
  if (_weeksStripRolloverTimer) clearTimeout(_weeksStripRolloverTimer);
  const now = new Date();
  const next = new Date(now);
  const day = now.getDay();
  const daysUntilMonday = day === 1 ? 7 : (8 - day) % 7 || 7;
  next.setDate(now.getDate() + daysUntilMonday);
  next.setHours(0, 0, 1, 0);
  const ms = Math.max(60_000, next - now);
  _weeksStripRolloverTimer = setTimeout(() => {
    _weeksStripRolloverTimer = null;
    if (document.getElementById("hp-weeks-strip")) renderWeeksStrip();
  }, ms);
}

async function renderWeeksStrip() {
  const strip = document.getElementById("hp-weeks-strip");
  if (!strip) return;
  const dspId = window.RR?.dsp?.id;
  if (!dspId) return;

  // Start from NEXT Monday — current week lives in the Schedule view.
  const thisMonday = startOfWeekMonday(new Date());
  const monday = addDays(thisMonday, 7);
  const startIso = fmtIsoDate(monday);
  _scheduleWeeksStripRollover();

  // Build placeholders first so the strip never shows mockup data while
  // the live query is in flight.
  const placeholderWeeks = Array.from({ length: 5 }, (_, i) => isoWeek(addDays(monday, i * 7)));
  strip.innerHTML = `<span class="hp-weeks-strip-label">Next 5 wk</span>` +
    placeholderWeeks.map(n => `<span class="hp-week-cell"><span class="wk">W${n}</span> <span style="color:var(--text-subtle)">— / —</span></span>`).join("");

  // Pull 5 weeks of okami_grid + active driver count.
  const [gridRes, drvRes] = await Promise.all([
    sb.rpc("okami_grid", { p_start: startIso, p_weeks: 5 }),
    sb.from("drivers")
      .select("id, status", { count: "exact", head: true })
      .eq("dsp_id", dspId)
      .in("status", ["active", "onboarding"]),
  ]);
  if (gridRes.error) { console.warn("weeks strip:", gridRes.error.message); return; }

  const cells = gridRes.data || [];
  const available = drvRes.count || 0;
  const dpr = parseFloat(document.getElementById("okami-dpr")?.value) || 2.0;

  // Group target_routes per (date) summed across stations.
  const targetByDate = new Map();
  let cushionPct = 10;
  for (const c of cells) {
    if (c.cushion_pct != null) cushionPct = Number(c.cushion_pct);
    targetByDate.set(c.date, (targetByDate.get(c.date) || 0) + (c.target_routes || 0));
  }

  const out = [];
  for (let w = 0; w < 5; w++) {
    const wkStart = addDays(monday, w * 7);
    let routesMax = 0;
    for (let d = 0; d < 7; d++) {
      const t = targetByDate.get(fmtIsoDate(addDays(wkStart, d))) || 0;
      if (t > routesMax) routesMax = t;
    }
    const base = Math.round(routesMax * dpr);
    const cush = Math.ceil(base * (cushionPct / 100));
    const needed = base + cush;
    const gap = available - needed;
    const gapClass = gap >= 0 ? "ok" : (gap >= -10 ? "tight" : "short");
    const gapText = (gap >= 0 ? "+" : "") + gap;
    out.push(`<span class="hp-week-cell"><span class="wk">W${isoWeek(wkStart)}</span> ${available} / ${needed} <span class="gap ${gapClass}">${gapText}</span></span>`);
  }

  strip.innerHTML = `<span class="hp-weeks-strip-label">Next 5 wk</span>${out.join("")}`;
}


// ─── Interview Day ─────────────────────────────────────────────────────────
//
// `loadInterviewDay()` picks WHICH day to show:
//   1. If today has bookings, show today.
//   2. Otherwise, jump to the soonest future date that has bookings.
//   3. If no future bookings exist anywhere, default to today (empty).
//
// Operators can also navigate prev/next via buttons rendered in the
// header. State is held in module-scope `_ivDate` so re-renders survive.

let _ivDate = null;            // YYYY-MM-DD currently displayed
let _ivDayId = null;           // interview_days.id for the displayed date
let _ivDatesWithBookings = []; // sorted YYYY-MM-DD strings (today + future)

function dspTz() {
  return window.RR?.dsp?.timezone || "America/New_York";
}
function localDate(d) {
  return new Date(d).toLocaleDateString("en-CA", { timeZone: dspTz() });
}

async function loadInterviewDay() {
  const list = document.getElementById("iv-candidates");
  if (!list) return;

  // Pull all interview cal_events from yesterday onward to map out the
  // dates that have bookings. Used both for choosing the default date
  // and for prev/next navigation.
  const { data: events } = await sb.from("cal_events")
    .select("starts_at")
    .eq("dsp_id", window.RR.dsp.id)
    .eq("kind", "interview")
    .gte("starts_at", new Date(Date.now() - 86400000).toISOString())
    .in("status", ["scheduled","rescheduled","completed","no_show"])
    .order("starts_at", { ascending: true });

  const datesSet = new Set();
  for (const e of events ?? []) datesSet.add(localDate(e.starts_at));
  _ivDatesWithBookings = [...datesSet].sort();

  const today = localDate(new Date());
  if (!_ivDate) {
    if (_ivDatesWithBookings.includes(today)) _ivDate = today;
    else _ivDate = _ivDatesWithBookings[0] || today;
  }

  const { data: day, error: openErr } = await sb.rpc("open_interview_day", { p_date: _ivDate });
  if (openErr) { toast("Couldn't open interview day: " + openErr.message, "warn"); return; }
  _ivDayId = day.id;

  const { data: roster, error: rErr } = await sb.rpc("interview_day_roster", { p_day_id: day.id });
  if (rErr) { toast("Roster load failed: " + rErr.message, "warn"); return; }
  renderInterviewDay(day, roster ?? []);
}

function renderInterviewDay(day, rows) {
  const list = document.getElementById("iv-candidates");
  if (!list) return;

  // Date navigator + label injected just above the stat banner.
  renderInterviewDayNav(day);

  const booked   = rows.length;
  const hired    = rows.filter(r => r.outcome === "hired").length;
  const noHire   = rows.filter(r => r.outcome === "no_hire").length;
  const noShow   = rows.filter(r => r.outcome === "no_show").length;
  const remaining = booked - hired - noHire - noShow;

  setText("iv-booked",    booked);
  setText("iv-hired",     hired);
  setText("iv-nohire",    noHire);
  setText("iv-noshow",    noShow);
  setText("iv-remaining", remaining);

  const fill = document.getElementById("iv-progress-fill");
  if (fill) fill.style.width = booked === 0
    ? "0%"
    : Math.round(((booked - remaining) / booked) * 100) + "%";

  if (rows.length === 0) {
    list.innerHTML = `
      <div style="padding:48px;text-align:center;color:var(--text-subtle);font-size:13px;background:var(--surface);border:1px solid var(--border);border-radius:12px">
        <strong style="color:var(--text-muted);display:block;margin-bottom:4px">No interviews booked for ${day.date}</strong>
        When applicants book via Cal.com, they'll show up here.
      </div>`;
  } else {
    list.innerHTML = rows.map(renderInterviewCard).join("");
  }

  // Inject a Close-day link after the candidate list. Subtle by design —
  // operators close once at end of day, not a primary action.
  const wrap = list.parentNode;
  let closeBtn = wrap.querySelector("[data-rr-close-day]");
  if (!closeBtn) {
    closeBtn = document.createElement("button");
    closeBtn.className = "btn btn-sm";
    closeBtn.style.cssText = "margin-top:14px;font-size:12px;color:var(--text-subtle);background:transparent;border:1px solid var(--border)";
    closeBtn.dataset.rrCloseDay = "1";
    wrap.insertBefore(closeBtn, list.nextSibling);
  }
  closeBtn.disabled = day.closed_at != null;
  closeBtn.textContent = day.closed_at
    ? `Day closed · ${new Date(day.closed_at).toLocaleString()}`
    : "Close interview day";

  // Show "done" state once everyone is decided + day is closed.
  const done = document.getElementById("iv-done");
  if (done) {
    if (day.closed_at) {
      done.style.display = "";
      const sub = document.getElementById("iv-done-sub");
      if (sub) sub.textContent = `${hired} hired · ${noHire} no-hire · ${noShow} no-show`;
    } else {
      done.style.display = "none";
    }
  }
}

function renderInterviewDayNav(day) {
  // Find or create the nav row inside the Interview Day subview, just
  // before the iv-stats-banner.
  const subview = document.getElementById("pipe-sub-interview");
  const banner  = subview?.querySelector(".iv-stats-banner");
  if (!subview || !banner) return;

  let nav = subview.querySelector("[data-rr-iv-nav]");
  if (!nav) {
    nav = document.createElement("div");
    nav.setAttribute("data-rr-iv-nav", "1");
    nav.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:var(--s-3);background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:10px 14px";
    banner.parentNode.insertBefore(nav, banner);
  }

  const idx = _ivDatesWithBookings.indexOf(_ivDate);
  let prev, next;
  if (idx >= 0) {
    prev = idx > 0 ? _ivDatesWithBookings[idx - 1] : null;
    next = idx < _ivDatesWithBookings.length - 1 ? _ivDatesWithBookings[idx + 1] : null;
  } else {
    // Operator is viewing a date that has no bookings (e.g. today is empty
    // but they explicitly clicked Today). Fall back to nearest neighbors
    // on either side from the booked-dates list.
    prev = [..._ivDatesWithBookings].reverse().find(d => d < _ivDate) || null;
    next = _ivDatesWithBookings.find(d => d > _ivDate) || null;
  }

  const dt = new Date(_ivDate + "T12:00:00");
  const label = dt.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
  const today = localDate(new Date());
  const relative = _ivDate === today ? "Today" : (_ivDate < today ? "Past" : "Upcoming");

  nav.innerHTML = `
    <div>
      <div style="font-size:13px;font-weight:600">${label}</div>
      <div style="font-size:11px;color:var(--text-subtle);margin-top:2px">${relative}${day.closed_at ? " · day closed" : ""}</div>
    </div>
    <div style="display:flex;gap:6px">
      <button class="btn btn-sm" data-rr-iv-prev ${prev ? "" : "disabled"} style="font-size:11px">← Prev day</button>
      <button class="btn btn-sm" data-rr-iv-today style="font-size:11px">Today</button>
      <button class="btn btn-sm" data-rr-iv-next ${next ? "" : "disabled"} style="font-size:11px">Next day →</button>
    </div>`;
}

function renderInterviewCard(r) {
  const initials = (r.full_name || "")
    .split(/\s+/).map(p => p[0]).filter(Boolean).slice(0, 2).join("").toUpperCase() || "?";
  const time = r.starts_at
    ? new Date(r.starts_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : "—";
  const outcome = r.outcome;
  const sourceColors = {
    hired:   "background:rgba(22,163,74,.12);color:#16A34A",
    no_hire: "background:rgba(220,38,38,.12);color:#DC2626",
    no_show: "background:rgba(245,158,11,.18);color:#B45309",
  };
  const badge = outcome
    ? `<span class="iv-card-source" style="${sourceColors[outcome]}">${outcome.replace("_"," ")}</span>`
    : `<span class="iv-card-source" style="background:var(--accent-soft);color:var(--accent-text)">${r.source ?? "Indeed"}</span>`;

  const tags = [];
  if (r.video_url) tags.push(
    `<span class="iv-card-tag" data-rr-play-video data-video-url="${encodeURI(r.video_url)}" style="cursor:pointer">▶ Watch intro</span>`
  );

  return `
    <div class="iv-card" data-applicant-id="${r.applicant_id}" ${outcome ? `data-outcome="${outcome}"` : ""}>
      <div class="iv-card-time">${time}</div>
      <div class="iv-card-body">
        <div class="iv-card-header">
          <div class="iv-card-avatar tier-b">${initials}</div>
          <div>
            <div class="iv-card-name">${r.full_name ?? ""}</div>
            <div class="iv-card-meta">${[r.phone, r.email].filter(Boolean).join(" · ")}</div>
          </div>
          ${badge}
        </div>
        ${tags.length ? `<div class="iv-card-tags">${tags.join("")}</div>` : ""}
      </div>
      <div class="iv-card-actions">
        <button class="iv-action-btn nohire" data-rr-outcome="no_hire" ${outcome === "no_hire" ? "disabled" : ""}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>No Hire
        </button>
        <button class="iv-action-btn noshow" data-rr-outcome="no_show" ${outcome === "no_show" ? "disabled" : ""}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/></svg>No Show
        </button>
        <button class="iv-action-btn hired" data-rr-outcome="hired" ${outcome === "hired" ? "disabled" : ""}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>Hired
        </button>
      </div>
    </div>`;
}

function setText(id, txt) {
  const el = document.getElementById(id);
  if (el) el.textContent = txt;
}

// Capture-phase delegate for outcome + close-day buttons.
document.addEventListener("click", async (e) => {
  const outcomeBtn = e.target.closest("[data-rr-outcome]");
  if (outcomeBtn && !outcomeBtn.disabled) {
    e.preventDefault();
    e.stopImmediatePropagation();
    const card = outcomeBtn.closest(".iv-card");
    if (!card) return;
    const id = card.getAttribute("data-applicant-id");
    const outcome = outcomeBtn.getAttribute("data-rr-outcome");
    outcomeBtn.disabled = true;
    const { error } = await sb.rpc("record_outcome", {
      p_applicant_id: id, p_outcome: outcome, p_notes: null,
    });
    if (error) {
      toast("Action failed: " + error.message, "warn");
      outcomeBtn.disabled = false;
      return;
    }
    toast(
      outcome === "hired" ? "Hired ✓ · driver record created"
      : outcome === "no_hire" ? "Marked no hire"
      : "Marked no show",
      outcome === "hired" ? "success" : "warn",
    );
    await loadInterviewDay();
    await loadPipelineKpis();
    return;
  }

  // Interview Day prev/next/today
  const navBtn = e.target.closest("[data-rr-iv-prev],[data-rr-iv-next],[data-rr-iv-today]");
  if (navBtn && !navBtn.disabled) {
    e.preventDefault();
    e.stopImmediatePropagation();
    if (navBtn.hasAttribute("data-rr-iv-prev")) {
      const candidates = _ivDatesWithBookings.filter(d => d < _ivDate);
      _ivDate = candidates[candidates.length - 1] || _ivDate;
    } else if (navBtn.hasAttribute("data-rr-iv-next")) {
      const candidates = _ivDatesWithBookings.filter(d => d > _ivDate);
      _ivDate = candidates[0] || _ivDate;
    } else if (navBtn.hasAttribute("data-rr-iv-today")) {
      _ivDate = localDate(new Date());
    }
    _ivDayId = null;
    await loadInterviewDay();
    return;
  }

  const closeBtn = e.target.closest("[data-rr-close-day]");
  if (closeBtn && !closeBtn.disabled) {
    e.preventDefault();
    e.stopImmediatePropagation();
    if (!confirm("Close interview day? Anyone booked but not yet acted on will be marked No Show.")) return;
    closeBtn.disabled = true;
    // Close the DAY THE OPERATOR IS VIEWING, not whatever's "currently open"
    // server-side. Without p_day_id, the RPC defaults to today's open day,
    // which is empty if the operator was looking at a future booking.
    const { error } = await sb.rpc("close_interview_day", { p_day_id: _ivDayId });
    if (error) {
      toast("Close failed: " + error.message, "warn");
      closeBtn.disabled = false;
      return;
    }
    toast("Interview day closed · KPIs updated", "success");
    // After close, jump forward to the next future day with bookings (or
    // today if there isn't one) so the closed day stops monopolizing the view.
    const today = localDate(new Date());
    const futureBookings = _ivDatesWithBookings.filter(d => d > _ivDate);
    _ivDate = futureBookings[0] || today;
    _ivDayId = null;
    await loadInterviewDay();
    await loadPipelineKpis();
    await loadPipeline(getActiveStage());
  }
}, true);

// Hook pipeSub so switching to a tab kicks off the right load.
const _legacyPipeSub = window.pipeSub;
window.pipeSub = function (sub) {
  if (typeof _legacyPipeSub === "function") _legacyPipeSub(sub);
  if (sub === "interview") loadInterviewDay();
  if (sub === "calendar")  loadCalendarTab();
  if (sub === "referrals") loadReferralsTab();
  if (sub === "screening") loadScreeningQuestionsList();
  if (sub === "messages")  loadMessagesTab();
};


// ─── Referrals tab ─────────────────────────────────────────────────────────

let _refsLoaded = false;

async function loadReferralsTab() {
  await Promise.all([loadReferralsSummary(), loadReferralsLeaderboard()]);

  // First-load: wire settings inputs to autosave.
  if (!_refsLoaded) {
    _refsLoaded = true;
    document.getElementById("ref-toggle-enabled")?.addEventListener("click", async (e) => {
      e.preventDefault();
      const btn = e.currentTarget;
      btn.classList.toggle("on");
      await saveReferralSettings();
    });
    ["ref-weeks","ref-payout-input"].forEach(id => {
      document.getElementById(id)?.addEventListener("change", saveReferralSettings);
    });
  }

  // Set the master link preview from any first leaderboard row's link.
  const masterEl = document.getElementById("ref-master-link");
  if (masterEl) {
    const baseUrl = window.RR.dsp?.metadata?.public_base_url || "https://gorouteready.com";
    masterEl.textContent = `${baseUrl}/dashboard/refer.html?r=<driver-token>`;
  }
}

async function loadReferralsSummary() {
  const { data, error } = await sb.rpc("referral_summary");
  if (error || !data) return;
  setText("ref-active", data.active ?? 0);
  setText("ref-hired",  data.hired  ?? 0);
  setText("ref-payout", Math.round((data.payout_cents ?? 0) / 100));

  const tg = document.getElementById("ref-toggle-enabled");
  if (tg) tg.classList.toggle("on", !!data.enabled);
  setText("ref-auto-status", data.enabled ? "On" : "Off");
  const sub = document.getElementById("ref-auto-sub");
  if (sub) sub.textContent = data.enabled
    ? `Each new driver gets a referral SMS ${data.weeks ?? 4} week${data.weeks === 1 ? "" : "s"} after their hire date.`
    : "New hires don't get a referral SMS automatically.";

  const weeksEl = document.getElementById("ref-weeks");
  if (weeksEl) weeksEl.value = data.weeks ?? 4;
  const payIn = document.getElementById("ref-payout-input");
  if (payIn) payIn.value = Math.round((data.payout_cents ?? 0) / 100);
}

async function loadReferralsLeaderboard() {
  const list = document.getElementById("ref-leaderboard");
  if (!list) return;
  const { data: rows, error } = await sb.rpc("referral_leaderboard");
  if (error) {
    list.innerHTML = `<div style="padding:16px;color:var(--red);font-size:12px">${escapeHtml(error.message)}</div>`;
    return;
  }
  if (!rows || rows.length === 0) {
    list.innerHTML = `<div style="padding:24px;text-align:center;color:var(--text-subtle);font-size:12px"><strong style="color:var(--text-muted);display:block;margin-bottom:4px">No referrals yet</strong>Send drivers their links and the leaderboard fills in.</div>`;
    return;
  }
  list.innerHTML = rows.map((r, i) => `
    <div class="ref-leader-row">
      <div class="ref-leader-rank">${i + 1}</div>
      <div>
        <div class="ref-leader-name">${escapeHtml(r.full_name)}</div>
        <div class="ref-leader-meta">${r.hired_count} hired · ${r.active_count} active</div>
      </div>
      <button class="ref-action-btn ghost" data-rr-send-ref="${r.driver_id}">Send link</button>
    </div>`).join("");
}

async function saveReferralSettings() {
  const enabled = document.getElementById("ref-toggle-enabled")?.classList.contains("on");
  const weeks   = parseInt(document.getElementById("ref-weeks")?.value || "4", 10);
  const payout  = Math.round(parseFloat(document.getElementById("ref-payout-input")?.value || "0") * 100);
  const { error } = await sb.rpc("referral_settings_save", {
    p_payload: { enabled, weeks, payout_cents: payout },
  });
  if (error) { toast("Save failed: " + error.message, "warn"); return; }
  toast("Referral settings saved", "success");
  loadReferralsSummary();
}

// Capture-phase delegate for referral actions.
document.addEventListener("click", async (e) => {
  const sendBtn = e.target.closest("[data-rr-send-ref]");
  if (sendBtn && !sendBtn.disabled) {
    e.preventDefault();
    e.stopImmediatePropagation();
    const id = sendBtn.getAttribute("data-rr-send-ref");
    sendBtn.disabled = true;
    const { error } = await sb.rpc("send_referral_link", { p_driver_id: id });
    sendBtn.disabled = false;
    if (error) { toast("Send failed: " + error.message, "warn"); return; }
    toast("Referral link sent", "success");
    return;
  }
  const campBtn = e.target.closest("[data-rr-send-campaign]");
  if (campBtn && !campBtn.disabled) {
    e.preventDefault();
    e.stopImmediatePropagation();
    if (!confirm("Send the referral link to ALL active + onboarding drivers right now?")) return;
    campBtn.disabled = true;
    const { data, error } = await sb.rpc("send_referral_campaign");
    campBtn.disabled = false;
    if (error) { toast("Campaign failed: " + error.message, "warn"); return; }
    toast(`Campaign sent · ${data?.sent ?? 0} drivers`, "success");
    return;
  }
  const copyBtn = e.target.closest("[data-rr-copy-master-ref]");
  if (copyBtn) {
    e.preventDefault();
    e.stopImmediatePropagation();
    const txt = document.getElementById("ref-master-link")?.textContent;
    if (!txt) return;
    try { await navigator.clipboard.writeText(txt); toast("Link copied", "success"); }
    catch { toast("Couldn't copy — " + txt, "warn"); }
  }
}, true);


// ─── Calendar tab ──────────────────────────────────────────────────────────
//
// Top half  → upcoming bookings list (live cal_events).
// Bottom    → RouteReady-branded availability editor that pushes changes
//             through to Cal.com via the cal-availability edge function.

const CAL_DAY_LABELS = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];

const CAL_TZS = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Phoenix",
  "America/Los_Angeles",
  "America/Anchorage",
  "Pacific/Honolulu",
  "Etc/UTC",
];

async function loadCalendarTab() {
  await Promise.all([loadCalBookingsList(), loadCalAvailabilityEditor()]);
}

async function loadCalAvailabilityEditor() {
  const card = document.getElementById("cal-edit-card");
  const meta = document.getElementById("cal-edit-meta");
  if (!card) return;
  card.innerHTML = `<div style="padding:32px;text-align:center;color:var(--text-subtle);font-size:13px">Loading availability…</div>`;
  if (meta) meta.textContent = "";

  // Call the edge function. JWT-gated → uses the user's session.
  const { data, error } = await sb.functions.invoke("cal-availability", {
    method: "GET",
  });

  if (error || data?.error) {
    const msg = error?.message || data?.error || "Couldn't load availability";
    card.innerHTML = `
      <div style="padding:24px">
        <div style="font-size:13px;color:var(--red);font-weight:600;margin-bottom:8px">Couldn't load availability</div>
        <div style="font-size:12px;color:var(--text-subtle);line-height:1.5">${escapeHtml(msg)}</div>
      </div>`;
    return;
  }

  renderCalAvailabilityEditor(data);
  if (meta) meta.textContent = `Event "${data.eventType?.title || ""}" · ${data.eventType?.length ?? 30} min`;
}

function renderCalAvailabilityEditor(payload) {
  const card = document.getElementById("cal-edit-card");
  if (!card) return;

  const tz = payload.schedule?.timeZone || "America/New_York";
  const avail = payload.schedule?.availability || [];
  const locations = payload.eventType?.locations || [];

  // Collect ALL windows for each day. Each schedule block is shaped like
  //   { days: [0..6], startTime: "HH:MM:SS", endTime: "HH:MM:SS" }
  // and may apply to multiple days at once. We expand into per-day arrays
  // so the editor can surface (and re-edit) every window independently.
  const perDay = { 0:[], 1:[], 2:[], 3:[], 4:[], 5:[], 6:[] };
  for (const block of avail) {
    const start = (block.startTime || "09:00:00").slice(0, 5);
    const end   = (block.endTime   || "17:00:00").slice(0, 5);
    for (const d of (block.days || [])) {
      if (perDay[d]) perDay[d].push({ start, end });
    }
  }
  // Sort each day's windows by start time for predictable rendering.
  for (const d of Object.keys(perDay)) {
    perDay[d].sort((a, b) => a.start.localeCompare(b.start));
  }

  const loc = locations[0] || { type: "inPerson", address: "" };
  const isVideo = (loc.type || "").startsWith("integrations:") || loc.type === "link";
  const locDetail = loc.address || loc.link || "";

  const tzOptions = (CAL_TZS.includes(tz) ? CAL_TZS : [tz, ...CAL_TZS])
    .map(z => `<option value="${z}" ${z === tz ? "selected" : ""}>${z.replace("_"," ")}</option>`)
    .join("");

  const dayRows = Array.from({ length: 7 }, (_, d) => renderDayRow(d, perDay[d])).join("");

  card.innerHTML = `
    <div class="cal-edit-section">
      <div class="cal-edit-label">Time zone</div>
      <select id="cal-tz" class="cal-edit-input" style="max-width:280px">${tzOptions}</select>
    </div>

    <div class="cal-edit-section">
      <div class="cal-edit-label">Days &amp; times</div>
      <div id="cal-day-grid">${dayRows}</div>
    </div>

    <div class="cal-edit-section">
      <div class="cal-edit-label">Location</div>
      <div style="display:flex;gap:8px;align-items:center">
        <select id="cal-loc-type" class="cal-edit-input" style="max-width:200px">
          <option value="inPerson" ${!isVideo ? "selected" : ""}>In-person address</option>
          <option value="link"     ${isVideo  ? "selected" : ""}>Video / meeting link</option>
        </select>
      </div>
      <input id="cal-loc-detail" class="cal-edit-input cal-loc-detail" placeholder="${isVideo ? "https://meet.google.com/…" : "1234 Main St, City, State 00000"}" value="${escapeHtml(locDetail)}" />
    </div>

    <div class="cal-edit-foot">
      <div class="cal-edit-status" id="cal-edit-status"></div>
      <button class="btn btn-primary" data-rr-cal-save>Save availability</button>
    </div>`;

  wireDayRowEvents(card);
}

// Renders a single day row. `windows` is an array of { start, end }; if
// empty, the day is "off" and we render a single hidden window with
// default values so the user can flip the checkbox to enable it.
function renderDayRow(d, windows) {
  const on = windows.length > 0;
  const items = on ? windows : [{ start: "09:00", end: "17:00" }];
  const winHtml = items.map(w => renderDayWindow(w)).join("");
  return `
    <div class="cal-day-row ${on ? "" : "off"}" data-day="${d}">
      <label>
        <input type="checkbox" data-rr-day-on ${on ? "checked" : ""} />
        ${CAL_DAY_LABELS[d]}
      </label>
      <div class="cal-day-windows">
        ${winHtml}
        <button type="button" class="cal-add-window" data-rr-add-window ${on ? "" : "disabled"}>+ Add window</button>
      </div>
    </div>`;
}

function renderDayWindow(w, removable) {
  // The first window per day is always present; only extras get a remove
  // button. We render the remove button on every window and let the
  // wiring decide whether to actually remove (kept simple for now: any
  // window can be removed; if all are gone, the day flips to "off").
  return `
    <div class="cal-day-window">
      <input type="time" data-rr-day-start value="${w.start}" step="900" />
      <span class="cal-day-sep">to</span>
      <input type="time" data-rr-day-end value="${w.end}" step="900" />
      <button type="button" class="cal-remove-window" data-rr-remove-window aria-label="Remove">×</button>
    </div>`;
}

function wireDayRowEvents(card) {
  // Day-level on/off toggles enable/disable all the day's time inputs.
  card.querySelectorAll("[data-rr-day-on]").forEach((cb) => {
    cb.addEventListener("change", (e) => {
      const row = e.target.closest(".cal-day-row");
      const on  = e.target.checked;
      row.classList.toggle("off", !on);
      row.querySelectorAll('input[type=time]').forEach(t => { t.disabled = !on; });
      const addBtn = row.querySelector("[data-rr-add-window]");
      if (addBtn) addBtn.disabled = !on;
    });
  });
}

// Click delegate: add window / remove window inside a day row.
document.addEventListener("click", (e) => {
  const addBtn = e.target.closest("[data-rr-add-window]");
  if (addBtn && !addBtn.disabled) {
    e.preventDefault();
    e.stopImmediatePropagation();
    const row = addBtn.closest(".cal-day-row");
    if (!row) return;
    const wrap = row.querySelector(".cal-day-windows");
    const tmp = document.createElement("div");
    tmp.innerHTML = renderDayWindow({ start: "09:00", end: "17:00" });
    const newWin = tmp.firstElementChild;
    wrap.insertBefore(newWin, addBtn);
    return;
  }
  const remBtn = e.target.closest("[data-rr-remove-window]");
  if (remBtn) {
    e.preventDefault();
    e.stopImmediatePropagation();
    const win = remBtn.closest(".cal-day-window");
    const row = remBtn.closest(".cal-day-row");
    if (!win || !row) return;
    win.remove();
    // If no windows remain, flip the day to off so the layout stays sane.
    if (row.querySelectorAll(".cal-day-window").length === 0) {
      const cb = row.querySelector("[data-rr-day-on]");
      if (cb) { cb.checked = false; cb.dispatchEvent(new Event("change", { bubbles: true })); }
      // Re-add an empty default window so the user can re-enable the day.
      const wrap = row.querySelector(".cal-day-windows");
      const addBtn = wrap.querySelector("[data-rr-add-window]");
      const tmp = document.createElement("div");
      tmp.innerHTML = renderDayWindow({ start: "09:00", end: "17:00" });
      const def = tmp.firstElementChild;
      def.querySelectorAll('input[type=time]').forEach(t => { t.disabled = true; });
      wrap.insertBefore(def, addBtn);
    }
  }
}, true);

async function saveCalAvailability() {
  const card = document.getElementById("cal-edit-card");
  const status = document.getElementById("cal-edit-status");
  if (!card) return;

  const tz = card.querySelector("#cal-tz").value;
  const availability = [];
  card.querySelectorAll(".cal-day-row").forEach((row) => {
    const on = row.querySelector("[data-rr-day-on]").checked;
    if (!on) return;
    const day = parseInt(row.getAttribute("data-day"), 10);
    row.querySelectorAll(".cal-day-window").forEach((win) => {
      const start = win.querySelector("[data-rr-day-start]").value;
      const end   = win.querySelector("[data-rr-day-end]").value;
      if (!start || !end || start >= end) return;
      availability.push({
        days:      [day],
        startTime: start.length === 5 ? start + ":00" : start,
        endTime:   end.length   === 5 ? end   + ":00" : end,
      });
    });
  });

  const locType = card.querySelector("#cal-loc-type").value;
  const locDetail = card.querySelector("#cal-loc-detail").value.trim();
  const locations = [];
  if (locType === "link" && locDetail) {
    locations.push({ type: "link", link: locDetail });
  } else if (locType === "inPerson" && locDetail) {
    locations.push({ type: "inPerson", address: locDetail, displayLocationPublicly: true });
  }

  status.className = "cal-edit-status";
  status.textContent = "Saving…";

  const { data, error } = await sb.functions.invoke("cal-availability", {
    method: "POST",
    body: { timeZone: tz, availability, locations },
  });

  if (error || data?.error) {
    const msg = error?.message || data?.error || "Save failed";
    status.className = "cal-edit-status err";
    status.textContent = msg;
    return;
  }

  status.className = "cal-edit-status ok";
  status.textContent = `Saved at ${new Date().toLocaleTimeString()}`;
  await loadCalBookingsList();
}

// Capture-phase delegate for the save button.
document.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-rr-cal-save]");
  if (!btn) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  btn.disabled = true;
  try { await saveCalAvailability(); }
  finally { btn.disabled = false; }
}, true);

async function loadCalBookingsList() {
  const list = document.getElementById("cal-bookings-list");
  if (!list) return;
  list.innerHTML = `<div style="padding:24px;text-align:center;color:var(--text-subtle);font-size:13px">Loading…</div>`;

  const { data: rows, error } = await sb.from("cal_events")
    .select("id, applicant_id, kind, status, starts_at, ends_at, meeting_url, location, applicants:applicant_id (full_name, email, phone)")
    .eq("dsp_id", window.RR.dsp.id)
    .gte("starts_at", new Date(Date.now() - 1000 * 60 * 60 * 12).toISOString())
    .in("status", ["scheduled", "rescheduled"])
    .order("starts_at", { ascending: true })
    .limit(100);

  if (error) {
    list.innerHTML = `<div style="padding:24px;text-align:center;color:var(--red);font-size:13px">Couldn't load bookings: ${error.message}</div>`;
    return;
  }
  if (!rows || rows.length === 0) {
    list.innerHTML = `<div style="padding:32px;text-align:center;color:var(--text-subtle);font-size:13px"><strong style="color:var(--text-muted);display:block;margin-bottom:4px">No upcoming bookings</strong>Once applicants book a slot, their interview will land here.</div>`;
    return;
  }

  // Group by date so the list reads like a schedule.
  const byDate = new Map();
  for (const r of rows) {
    const d = new Date(r.starts_at);
    const key = d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
    if (!byDate.has(key)) byDate.set(key, []);
    byDate.get(key).push(r);
  }

  const html = [];
  for (const [date, items] of byDate) {
    html.push(`<div style="padding:10px 16px;background:var(--canvas);font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--text-muted);border-top:1px solid var(--border)">${date}</div>`);
    for (const r of items) {
      const start = new Date(r.starts_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      const end = r.ends_at ? new Date(r.ends_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";
      const a = r.applicants || {};
      const kindBadge = r.kind === "orientation"
        ? `<span style="font-size:10px;font-weight:700;padding:2px 7px;border-radius:5px;background:rgba(124,58,237,.12);color:#7C3AED;letter-spacing:.04em;text-transform:uppercase">Orientation</span>`
        : `<span style="font-size:10px;font-weight:700;padding:2px 7px;border-radius:5px;background:var(--accent-soft);color:var(--accent-text);letter-spacing:.04em;text-transform:uppercase">Interview</span>`;
      const statusBadge = r.status === "rescheduled"
        ? `<span style="font-size:10px;font-weight:600;color:#B45309;margin-left:6px">rescheduled</span>`
        : "";

      html.push(`
        <div style="display:grid;grid-template-columns:90px 1fr auto;gap:14px;align-items:center;padding:14px 16px;border-top:1px solid var(--border)">
          <div style="font-variant-numeric:tabular-nums;font-size:13px;font-weight:600">${start}<div style="font-size:11px;color:var(--text-subtle);font-weight:400">${end}</div></div>
          <div>
            <div style="font-size:13px;font-weight:600;margin-bottom:2px">${escapeHtml(a.full_name || "Unknown")}</div>
            <div style="font-size:11px;color:var(--text-subtle)">${[a.phone, a.email].filter(Boolean).join(" · ") || "no contact on file"}</div>
            <div style="margin-top:6px">${kindBadge}${statusBadge}</div>
          </div>
          <div>${r.meeting_url ? `<a class="btn btn-sm" href="${r.meeting_url}" target="_blank" rel="noreferrer">Join</a>` : ""}</div>
        </div>`);
    }
  }
  list.innerHTML = html.join("");
}


// ─── Settings → Screening Questions ────────────────────────────────────────
//
// The mockup has a static `.settings-section[data-set="screening"]` panel
// with hardcoded `<div class="question-row">` rows. We replace the row
// container with a live-rendered list backed by public.screening_questions
// CRUD. Inline edit toggles between a read row and a tiny form.

async function loadScreeningQuestionsList() {
  // Now lives inside the Pipeline → Screening subtab. Containers are
  // pre-rendered in the static HTML; we just fill the row list.
  const subview = document.getElementById("pipe-sub-screening");
  if (!subview) return;
  // Also rehydrate the video settings card.
  loadVideoScreeningSettings();
  const container = subview.querySelector("[data-rr-questions]");
  if (!container) return;

  const { data: rows, error } = await sb.from("screening_questions")
    .select("id, prompt, field_type, options, required, hard_filter, scoring, display_order, active")
    .eq("dsp_id", window.RR.dsp.id)
    .order("display_order", { ascending: true });
  if (error) {
    container.innerHTML = `<div style="padding:16px;color:var(--red);font-size:12px">${escapeHtml(error.message)}</div>`;
    return;
  }

  const sub = document.getElementById("rr-screening-sub");
  if (sub) sub.textContent = `${(rows ?? []).length} questions · sent to applicants via SMS or email.`;

  if (!rows || rows.length === 0) {
    container.innerHTML = `<div style="padding:16px;color:var(--text-subtle);font-size:13px">No questions yet — click + Add question to start.</div>`;
    return;
  }
  container.innerHTML = rows.map(renderScreeningQuestionRow).join("");
}

function renderScreeningQuestionRow(q) {
  const reqPill = q.required ? "Required" : "Optional";
  const subBits = [];
  subBits.push(({ yes_no: "Yes/No", single: "Single-select", multi: "Multi-select", text: "Text", number: "Number", date: "Date" })[q.field_type] || q.field_type);
  if (q.hard_filter && q.hard_filter.answer != null) subBits.push(`auto-fail if "${q.hard_filter.answer}"`);
  if (q.scoring) subBits.push("scoring");
  if (!q.active) subBits.push("disabled");

  return `
    <div class="question-row" data-question-id="${q.id}" ${q.active ? "" : 'style="opacity:.5"'}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="20 6 9 17 4 12"/></svg>
      <div class="question-text">${escapeHtml(q.prompt)}<small>${subBits.join(" · ")}</small></div>
      <span class="role-pill">${reqPill}</span>
      <button class="btn btn-sm" data-rr-edit-question="${q.id}">Edit</button>
      <button class="btn btn-sm" data-rr-toggle-question="${q.id}" data-active="${q.active}">${q.active ? "Disable" : "Enable"}</button>
      <button class="btn btn-sm" data-rr-delete-question="${q.id}" style="color:var(--red)">Delete</button>
    </div>`;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function openQuestionEditor(question) {
  const isEdit = !!question;
  const q = question || {
    prompt: "", field_type: "yes_no",
    options: ["Yes","No"], required: true,
    hard_filter: null, scoring: null,
    display_order: 99, active: true,
  };

  // Build a tiny modal inline (no need to add it to the static HTML).
  let m = document.getElementById("rr-question-modal");
  if (m) m.remove();
  m = document.createElement("div");
  m.id = "rr-question-modal";
  m.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:9999;display:flex;align-items:center;justify-content:center;padding:24px";
  m.innerHTML = `
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:22px;max-width:520px;width:100%;max-height:90vh;overflow:auto">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
        <h3 style="margin:0;font-size:17px;font-weight:600">${isEdit ? "Edit question" : "Add question"}</h3>
        <button data-rr-q-cancel style="background:none;border:0;font-size:20px;cursor:pointer;color:var(--text-muted)">×</button>
      </div>
      <label style="display:block;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted);margin-bottom:6px">Prompt</label>
      <textarea data-rr-q-prompt class="form-input" style="width:100%;min-height:60px;margin-bottom:14px">${escapeHtml(q.prompt)}</textarea>
      <label style="display:block;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted);margin-bottom:6px">Type</label>
      <select data-rr-q-type class="form-input" style="width:100%;margin-bottom:14px">
        ${["yes_no","single","multi","text","number","date"].map(v => `<option value="${v}" ${q.field_type === v ? "selected" : ""}>${v}</option>`).join("")}
      </select>
      <label style="display:block;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted);margin-bottom:6px">Options (one per line — only for single / multi)</label>
      <textarea data-rr-q-options class="form-input" style="width:100%;min-height:70px;margin-bottom:14px;font-family:monospace">${(q.options || []).join("\n")}</textarea>
      <label style="display:block;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted);margin-bottom:6px">Auto-decline if answer equals (leave blank for none)</label>
      <input data-rr-q-hardfail class="form-input" style="width:100%;margin-bottom:14px" value="${escapeHtml(q.hard_filter?.answer ?? "")}" placeholder="e.g. No" />
      <label style="display:flex;align-items:center;gap:10px;margin-bottom:8px"><input type="checkbox" data-rr-q-required ${q.required ? "checked" : ""}/>Required</label>
      <label style="display:flex;align-items:center;gap:10px;margin-bottom:14px"><input type="checkbox" data-rr-q-active ${q.active ? "checked" : ""}/>Active (shown to applicants)</label>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button class="btn" data-rr-q-cancel>Cancel</button>
        <button class="btn btn-primary" data-rr-q-save>${isEdit ? "Save changes" : "Add question"}</button>
      </div>
    </div>`;
  document.body.appendChild(m);

  m.addEventListener("click", async (e) => {
    if (e.target.closest("[data-rr-q-cancel]")) { m.remove(); return; }
    if (e.target.closest("[data-rr-q-save]")) {
      const prompt = m.querySelector("[data-rr-q-prompt]").value.trim();
      if (!prompt) { toast("Prompt is required", "warn"); return; }
      const fieldType = m.querySelector("[data-rr-q-type]").value;
      const optsText  = m.querySelector("[data-rr-q-options]").value.trim();
      const opts = optsText ? optsText.split(/\r?\n/).map(s => s.trim()).filter(Boolean) : null;
      const hardAns = m.querySelector("[data-rr-q-hardfail]").value.trim();
      const required = m.querySelector("[data-rr-q-required]").checked;
      const active = m.querySelector("[data-rr-q-active]").checked;

      const payload = {
        dsp_id: window.RR.dsp.id,
        prompt,
        field_type: fieldType,
        options: opts && (fieldType === "single" || fieldType === "multi") ? opts : null,
        required,
        hard_filter: hardAns ? { answer: hardAns } : null,
        scoring: q.scoring ?? null,
        display_order: q.display_order ?? 99,
        active,
      };
      if (isEdit) {
        const { error } = await sb.from("screening_questions").update(payload).eq("id", q.id);
        if (error) { toast("Save failed: " + error.message, "warn"); return; }
      } else {
        const { error } = await sb.from("screening_questions").insert(payload);
        if (error) { toast("Add failed: " + error.message, "warn"); return; }
      }
      m.remove();
      await loadScreeningQuestionsList();
      toast(isEdit ? "Question saved" : "Question added", "success");
    }
  });
}

// Capture-phase delegate for the question editor / toggle / delete / add.
document.addEventListener("click", async (e) => {
  const editBtn = e.target.closest("[data-rr-edit-question]");
  if (editBtn) {
    e.preventDefault(); e.stopImmediatePropagation();
    const id = editBtn.getAttribute("data-rr-edit-question");
    const { data: q, error } = await sb.from("screening_questions").select("*").eq("id", id).single();
    if (error) { toast("Couldn't load question", "warn"); return; }
    openQuestionEditor(q);
    return;
  }
  const delBtn = e.target.closest("[data-rr-delete-question]");
  if (delBtn) {
    e.preventDefault(); e.stopImmediatePropagation();
    if (!confirm("Delete this question? Existing responses will be removed.")) return;
    const id = delBtn.getAttribute("data-rr-delete-question");
    const { error } = await sb.from("screening_questions").delete().eq("id", id);
    if (error) { toast("Delete failed: " + error.message, "warn"); return; }
    await loadScreeningQuestionsList();
    toast("Question deleted", "warn");
    return;
  }
  const togBtn = e.target.closest("[data-rr-toggle-question]");
  if (togBtn) {
    e.preventDefault(); e.stopImmediatePropagation();
    const id = togBtn.getAttribute("data-rr-toggle-question");
    const wasActive = togBtn.getAttribute("data-active") === "true";
    const { error } = await sb.from("screening_questions").update({ active: !wasActive }).eq("id", id);
    if (error) { toast("Update failed: " + error.message, "warn"); return; }
    await loadScreeningQuestionsList();
    return;
  }
  const addBtn = e.target.closest("[data-rr-add-question]");
  if (addBtn) {
    e.preventDefault(); e.stopImmediatePropagation();
    openQuestionEditor(null);
  }
}, true);

// (Settings → Screening Questions was relocated to Pipeline → Screening.
//  No setSettingsSection hook needed.)


// ─── Video screening settings (Pipeline → Screening, lower card) ──────────

async function loadVideoScreeningSettings() {
  // Read straight from the cached dsp metadata (loaded at boot in window.RR.dsp).
  const v = window.RR?.dsp?.metadata?.video || {};
  const tg = document.getElementById("rr-video-enabled-toggle");
  if (tg) tg.classList.toggle("on", v.enabled !== false);
  const prompt = document.getElementById("rr-video-prompt");
  if (prompt) prompt.value = v.prompt || "Tell us about yourself and why you'd be a great fit for our team.";
  const max = document.getElementById("rr-video-max-seconds");
  if (max) max.value = v.max_seconds || 60;
}

async function saveVideoScreeningSettings() {
  const status = document.getElementById("rr-video-status");
  const enabled = document.getElementById("rr-video-enabled-toggle")?.classList.contains("on");
  const prompt  = document.getElementById("rr-video-prompt")?.value.trim() || "";
  const maxStr  = document.getElementById("rr-video-max-seconds")?.value;
  const max     = Math.min(180, Math.max(15, parseInt(maxStr || "60", 10)));

  status.className = "cal-edit-status";
  status.textContent = "Saving…";

  // Read current metadata, deep-merge the video block, write back.
  const { data: dsp, error: rErr } = await sb.from("dsps").select("metadata").eq("id", window.RR.dsp.id).single();
  if (rErr) { status.className = "cal-edit-status err"; status.textContent = rErr.message; return; }
  const md = dsp.metadata || {};
  md.video = { enabled, prompt, max_seconds: max };

  const { error: wErr } = await sb.from("dsps").update({ metadata: md }).eq("id", window.RR.dsp.id);
  if (wErr) { status.className = "cal-edit-status err"; status.textContent = wErr.message; return; }

  // Refresh the cached copy so subsequent loads see the new settings.
  window.RR.dsp.metadata = md;
  status.className = "cal-edit-status ok";
  status.textContent = `Saved at ${new Date().toLocaleTimeString()}`;
}

// Capture-phase delegate for the video toggle + save.
// ─── Driver detail drawer ─────────────────────────────────────────────────
//
// Opens when an operator clicks a row in the Drivers tab. Four internal
// tabs: Overview · License · Coaching · Documents.
//
// We also stub out the legacy mockup `openDriverDetail` so the old
// hardcoded "Marcus Davidson" aside drawer doesn't fire alongside ours.

window.openDriverDetail = function () { /* superseded by openDriverDrawer */ };

let _ddDriver = null;
let _ddTab = "overview";

async function openDriverDrawer(driverId) {
  let drawer = document.getElementById("rr-dd-drawer");
  if (drawer) drawer.remove();
  drawer = document.createElement("div");
  drawer.id = "rr-dd-drawer";
  drawer.innerHTML = `
    <style>
      #rr-dd-drawer{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9999;display:flex;justify-content:flex-end}
      #rr-dd-panel{width:560px;max-width:100%;background:var(--surface);height:100%;overflow-y:auto;border-left:1px solid var(--border);display:flex;flex-direction:column}
      .dd-head{padding:18px 22px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between}
      .dd-head h3{margin:0;font-size:18px;font-weight:600}
      .dd-head .sub{font-size:12px;color:var(--text-subtle);margin-top:2px}
      .dd-tabs{display:flex;gap:2px;background:var(--canvas);padding:3px;border-radius:8px;margin:14px 22px 0}
      .dd-tab{flex:1;background:transparent;border:0;font:inherit;font-size:12px;font-weight:600;color:var(--text-subtle);padding:8px 12px;border-radius:6px;cursor:pointer}
      .dd-tab.active{background:var(--surface);color:var(--text);box-shadow:var(--shadow-sm)}
      .dd-body{padding:18px 22px;flex:1}
      .dd-row{display:grid;grid-template-columns:160px 1fr;gap:12px;align-items:center;padding:8px 0;border-top:1px solid var(--border)}
      .dd-row:first-of-type{border-top:0}
      .dd-row label{font-size:12px;color:var(--text-muted);font-weight:500}
      .dd-row input,.dd-row select,.dd-row textarea{width:100%;background:var(--canvas);border:1px solid var(--border);border-radius:6px;padding:7px 10px;font:inherit;font-size:13px;color:var(--text)}
      .dd-row input:focus,.dd-row select:focus,.dd-row textarea:focus{outline:none;border-color:var(--accent)}
      .dd-foot{padding:14px 22px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:8px;background:var(--surface);position:sticky;bottom:0}
      .dd-list-row{display:grid;grid-template-columns:1fr auto;gap:12px;padding:12px 0;border-top:1px solid var(--border)}
      .dd-list-row:first-of-type{border-top:0}
      .dd-list-title{font-size:13px;font-weight:600}
      .dd-list-sub{font-size:11px;color:var(--text-subtle);margin-top:2px}
    </style>
    <div id="rr-dd-panel">
      <div class="dd-head">
        <div>
          <h3 id="rr-dd-title">Driver record</h3>
          <div class="sub" id="rr-dd-sub"></div>
        </div>
        <button id="rr-dd-close" style="background:none;border:0;font-size:22px;cursor:pointer;color:var(--text-muted);padding:0 6px">×</button>
      </div>
      <div class="dd-tabs">
        <button class="dd-tab active" data-rr-dd-tab="overview">Overview</button>
        <button class="dd-tab" data-rr-dd-tab="availability">Availability</button>
        <button class="dd-tab" data-rr-dd-tab="license">License</button>
        <button class="dd-tab" data-rr-dd-tab="coaching">Coaching</button>
        <button class="dd-tab" data-rr-dd-tab="documents">Documents</button>
      </div>
      <div class="dd-body" id="rr-dd-body"><div style="padding:32px;text-align:center;color:var(--text-subtle)">Loading…</div></div>
      <div class="dd-foot" id="rr-dd-foot"></div>
    </div>`;
  document.body.appendChild(drawer);

  drawer.addEventListener("click", (e) => {
    if (e.target === drawer || e.target.id === "rr-dd-close" || e.target.closest("[data-rr-dd-close]")) drawer.remove();
  });

  _ddTab = "overview";
  if (driverId) {
    await loadDriverDrawer(driverId);
  } else {
    // CREATE mode — empty placeholders, no fetch.
    _ddDriver = { driver: { id: null, status: "onboarding", hire_date: fmtIsoDate(new Date()) }, coachings: [], documents: [] };
    document.getElementById("rr-dd-title").textContent = "Add driver";
    document.getElementById("rr-dd-sub").textContent = "New record";
    // License / Coaching / Documents tabs need an existing driver — disable.
    drawer.querySelectorAll(".dd-tab").forEach(t => {
      const k = t.getAttribute("data-rr-dd-tab");
      if (k !== "overview") { t.disabled = true; t.style.opacity = "0.4"; t.style.cursor = "not-allowed"; }
    });
    renderDriverDrawerTab();
  }
}

async function loadDriverDrawer(driverId) {
  const { data, error } = await sb.rpc("driver_record", { p_id: driverId });
  if (error) { toast("Couldn't load driver: " + error.message, "warn"); return; }
  _ddDriver = data;

  const drv = data.driver;
  document.getElementById("rr-dd-title").textContent = displayDriverName(drv) || "—";
  const sub = [
    drv.station_id ? "Station —" : "No station",
    drv.hire_date ? `Hired ${new Date(drv.hire_date).toLocaleDateString()}` : null,
    drv.tier ? `Tier ${drv.tier}` : null,
  ].filter(Boolean).join(" · ");
  document.getElementById("rr-dd-sub").textContent = sub;

  renderDriverDrawerTab();
}

function renderDriverDrawerTab() {
  document.querySelectorAll("#rr-dd-drawer .dd-tab").forEach(t => {
    t.classList.toggle("active", t.getAttribute("data-rr-dd-tab") === _ddTab);
  });
  const body = document.getElementById("rr-dd-body");
  if (_ddTab === "overview")     renderOverviewForm(body, _ddDriver.driver);
  if (_ddTab === "availability") renderAvailabilityTab(body, _ddDriver.driver);
  if (_ddTab === "license")      renderLicenseTab(body, _ddDriver.driver);
  if (_ddTab === "coaching")     body.innerHTML = renderCoachingTab(_ddDriver.coachings);
  if (_ddTab === "documents")    body.innerHTML = renderDocumentsTab(_ddDriver.documents);
  setDriverDrawerFoot();
}

function setDriverDrawerFoot() {
  const foot = document.getElementById("rr-dd-foot");
  if (!foot) return;
  if (_ddTab === "overview" || _ddTab === "license") {
    foot.innerHTML = `<button class="btn btn-primary" data-rr-dd-save>Save record</button>`;
  } else if (_ddTab === "availability") {
    foot.innerHTML = `<button class="btn btn-primary" data-rr-avail-save>Save availability</button>`;
  } else {
    // Coaching / Documents add items inline; offer just a Close in the foot
    // so the layout is identical across tabs.
    foot.innerHTML = `<button class="btn" data-rr-dd-close>Close</button>`;
  }
}

function renderAvailabilityTab(body, d) {
  const v = (s) => escapeHtml(s ?? "");
  const meta = d.metadata || {};
  const avail = meta.availability || {};
  const days = avail.days || [];
  const notes = avail.notes || "";
  const isAvail = (k) => days.includes(k);
  const dayKey = ["mon","tue","wed","thu","fri","sat","sun"];
  const dayLabel = { mon:"Mon", tue:"Tue", wed:"Wed", thu:"Thu", fri:"Fri", sat:"Sat", sun:"Sun" };
  const checkboxes = dayKey.map(k => `
    <label style="display:flex;align-items:center;gap:8px;font-size:13px;padding:6px 10px;border:1px solid var(--border);border-radius:6px;cursor:pointer;background:var(--canvas);user-select:none">
      <input type="checkbox" data-rr-avail-day="${k}" ${isAvail(k) ? "checked" : ""}/>
      <span style="font-weight:600">${dayLabel[k]}</span>
    </label>`).join("");
  body.innerHTML = `
    <div class="dd-row" style="grid-template-columns:160px 1fr;align-items:flex-start">
      <label>Available days</label>
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px">${checkboxes}</div>
    </div>
    <div class="dd-row" style="grid-template-columns:160px 1fr;align-items:flex-start">
      <label>Notes</label>
      <textarea data-rr-avail-notes rows="3" placeholder="e.g. school pickup Wed afternoons · prefers AM routes" style="resize:vertical;min-height:64px">${v(notes)}</textarea>
    </div>`;
}

async function renderOverviewForm(body, d) {
  const showPronouns = window.RR.dsp?.metadata?.drivers?.show_pronouns !== false;
  const v = (s) => escapeHtml(s ?? "");
  const stations = await getDriverStationsCached();
  const stationOptions = `<option value="">— No station —</option>` +
    stations.map(s => `<option value="${s.id}" ${s.id === d.station_id ? "selected" : ""}>${escapeHtml(s.code)}${s.name ? ` · ${escapeHtml(s.name)}` : ""}</option>`).join("");
  const payRate = d.metadata?.pay?.hourly_rate ?? "";
  body.innerHTML = `
    <div class="dd-row"><label>Full name</label><input data-rr-dd-field="full_name" data-rr-capitalize autocapitalize="words" value="${v(d.full_name)}"/></div>
    <div class="dd-row"><label>Preferred name</label><input data-rr-dd-field="preferred_name" data-rr-capitalize autocapitalize="words" value="${v(d.preferred_name)}"/></div>
    ${showPronouns ? `<div class="dd-row"><label>Pronouns</label><input data-rr-dd-field="pronouns" placeholder="he/him · she/her · they/them" value="${v(d.pronouns)}"/></div>` : ""}
    <div class="dd-row"><label>Phone</label><input data-rr-dd-field="phone" value="${v(d.phone)}"/></div>
    <div class="dd-row"><label>Email</label><input data-rr-dd-field="email" value="${v(d.email)}"/></div>
    <div class="dd-row"><label>Address</label><input data-rr-dd-field="address" value="${v(d.address)}"/></div>
    <div class="dd-row"><label>Birthday</label><input type="date" data-rr-dd-field="birthday" value="${v(d.birthday)}"/></div>
    <div class="dd-row"><label>Station</label>
      <select data-rr-dd-field="station_id">${stationOptions}</select>
    </div>
    <div class="dd-row"><label>Hire date</label><input type="date" data-rr-dd-field="hire_date" value="${v(d.hire_date)}"/></div>
    <div class="dd-row"><label>Status</label>
      <select data-rr-dd-field="status">
        ${["onboarding","active","leave","inactive","terminated"].map(s => `<option value="${s}" ${s === d.status ? "selected" : ""}>${s}</option>`).join("")}
      </select>
    </div>
    <div class="dd-row"><label>Pay rate</label>
      <div style="display:flex;align-items:center;gap:6px">
        <span style="color:var(--text-subtle)">$</span>
        <input type="number" min="0" max="200" step="0.01" data-rr-dd-field="pay_hourly" placeholder="22.50" value="${v(payRate)}" style="max-width:120px"/>
        <span style="color:var(--text-subtle);font-size:12px">/ hour</span>
      </div>
    </div>
    <div class="dd-row"><label>Emergency contact</label><input data-rr-dd-field="emergency_contact_name" placeholder="Name" value="${v(d.emergency_contact_name)}"/></div>
    <div class="dd-row"><label>Emergency phone</label><input data-rr-dd-field="emergency_contact_phone" placeholder="Phone" value="${v(d.emergency_contact_phone)}"/></div>
    <div class="dd-row"><label>Background check</label><input type="datetime-local" data-rr-dd-field="background_check_completed_at" value="${v((d.background_check_completed_at || '').slice(0,16))}"/></div>
    <div class="dd-row"><label>Drug test</label><input type="datetime-local" data-rr-dd-field="drug_test_completed_at" value="${v((d.drug_test_completed_at || '').slice(0,16))}"/></div>
    <div class="dd-row"><label>Training scheduled</label><input type="datetime-local" data-rr-dd-field="training_scheduled_at" value="${v((d.training_scheduled_at || '').slice(0,16))}"/></div>
    <div class="dd-row"><label>Training date</label><input type="date" data-rr-dd-field="training_date" value="${v(d.training_date)}"/></div>`;
}

async function renderLicenseTab(body, d) {
  const v = (s) => escapeHtml(s ?? "");
  // Resolve a viewable URL for the stored DL image, if any.
  let imgUrl = null;
  if (d.dl_image_path) {
    const { data: signed } = await sb.storage.from("driver-documents")
      .createSignedUrl(d.dl_image_path, 60 * 60);
    imgUrl = signed?.signedUrl || null;
  }

  // Expiry visual: pill colors past = red, ≤30 days = amber, else neutral.
  let expiryPill = '<span style="color:var(--text-subtle);font-size:12px">No expiry on file</span>';
  if (d.dl_expires_on) {
    const exp = new Date(d.dl_expires_on);
    const days = Math.floor((exp.getTime() - Date.now()) / 86400000);
    let style = "background:var(--canvas);color:var(--text-muted)";
    let suffix = `${days} days from today`;
    if (days < 0)        { style = "background:var(--red-soft);color:var(--red)";   suffix = `Expired ${-days} days ago`; }
    else if (days <= 30) { style = "background:var(--amber-soft);color:var(--amber)"; suffix = `Expires in ${days} days`; }
    expiryPill = `<span class="tag" style="${style}">${exp.toLocaleDateString()} · ${suffix}</span>`;
  }

  body.innerHTML = `
    <div class="dd-row"><label>License number</label><input data-rr-dd-field="dl_number" placeholder="DL number" value="${v(d.dl_number)}"/></div>
    <div class="dd-row"><label>Expiration</label>
      <div>
        <input type="date" data-rr-dd-field="dl_expires_on" value="${v(d.dl_expires_on)}" style="margin-bottom:6px"/>
        ${expiryPill}
      </div>
    </div>

    <div style="margin-top:18px">
      <div style="font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--text-muted);margin-bottom:8px">License image</div>
      ${imgUrl
        ? `<a href="${imgUrl}" target="_blank" rel="noreferrer" style="display:block">
             <img src="${imgUrl}" style="max-width:100%;max-height:280px;border:1px solid var(--border);border-radius:8px;background:var(--canvas)" alt="Drivers license"/>
           </a>
           <div style="margin-top:8px;display:flex;gap:8px">
             <input type="file" id="rr-dl-file" accept="image/*" />
             <button class="btn btn-sm" data-rr-dl-upload>Replace</button>
             <button class="btn btn-sm" data-rr-dl-remove style="color:var(--red)">Remove</button>
           </div>`
        : `<div style="border:1px dashed var(--border);border-radius:8px;padding:24px;text-align:center;color:var(--text-subtle);font-size:13px;margin-bottom:10px">No image uploaded yet.</div>
           <div style="display:flex;gap:8px;align-items:center">
             <input type="file" id="rr-dl-file" accept="image/*" />
             <button class="btn btn-primary btn-sm" data-rr-dl-upload>Upload license image</button>
           </div>`}
    </div>`;
}

function renderCoachingTab(coachings) {
  const list = (coachings || []).map(c => `
    <div class="dd-list-row">
      <div>
        <div class="dd-list-title">${escapeHtml(c.summary || c.topic)}</div>
        <div class="dd-list-sub">${(c.topic || "").replace(/_/g," ")} · ${(c.type || "").replace(/_/g," ")} · ${new Date(c.occurred_at).toLocaleDateString()}</div>
        ${c.notes ? `<div style="font-size:12px;color:var(--text-muted);margin-top:6px;line-height:1.5">${escapeHtml(c.notes)}</div>` : ""}
      </div>
    </div>`).join("");
  return `
    <button class="btn btn-primary" data-rr-add-coaching style="margin-bottom:14px">+ Log coaching</button>
    <div>${list || `<div style="padding:24px;text-align:center;color:var(--text-subtle);font-size:13px">No coachings logged yet.</div>`}</div>`;
}

function renderDocumentsTab(docs) {
  const list = (docs || []).map(x => `
    <div class="dd-list-row">
      <div>
        <div class="dd-list-title">${escapeHtml(x.label || x.kind.replace(/_/g," "))}</div>
        <div class="dd-list-sub">${(x.kind || "").replace(/_/g," ")} · ${x.expires_on ? "Expires " + new Date(x.expires_on).toLocaleDateString() : "No expiry"}</div>
      </div>
      <div><button class="btn btn-sm" data-rr-doc-open="${escapeHtml(x.file_path)}">Open</button></div>
    </div>`).join("");
  return `
    <div style="display:flex;gap:8px;margin-bottom:14px">
      <select id="rr-doc-kind" class="dd-row-input" style="background:var(--canvas);border:1px solid var(--border);border-radius:6px;padding:7px 10px;font:inherit;font-size:13px">
        ${["drivers_license","mvr","dot_medical","background_check","social_security","i9","w4","direct_deposit","vehicle_registration","insurance","other"].map(k => `<option value="${k}">${k.replace(/_/g," ")}</option>`).join("")}
      </select>
      <input type="file" id="rr-doc-file" />
      <button class="btn btn-primary" data-rr-doc-upload>Upload</button>
    </div>
    <div>${list || `<div style="padding:24px;text-align:center;color:var(--text-subtle);font-size:13px">No documents on file.</div>`}</div>`;
}

// Title-case name fields when the operator leaves the input. Marked via
// data-rr-capitalize. Splits on whitespace, uppercases each word's first
// char, leaves the rest untouched (so 'McNeil' stays 'McNeil' if typed,
// but 'mcneil' becomes 'Mcneil' — operators can fix surname casing manually).
document.addEventListener("focusout", (e) => {
  const el = e.target;
  if (!el || !el.matches || !el.matches("[data-rr-capitalize]")) return;
  const raw = (el.value || "").trim();
  if (!raw) return;
  const titled = raw.split(/\s+/).map(w =>
    w.length === 0 ? w : w.charAt(0).toUpperCase() + w.slice(1)
  ).join(" ");
  if (titled !== el.value) el.value = titled;
});

// Click delegate for the drawer (tabs, save, coaching log, doc upload).
document.addEventListener("click", async (e) => {
  // Open drawer from row
  const row = e.target.closest("[data-rr-open-driver]");
  if (row) {
    const id = row.getAttribute("data-driver-id");
    if (id) await openDriverDrawer(id);
    return;
  }

  // Tab switch inside drawer
  const tab = e.target.closest("#rr-dd-drawer [data-rr-dd-tab]");
  if (tab) {
    e.preventDefault();
    e.stopImmediatePropagation();
    _ddTab = tab.getAttribute("data-rr-dd-tab");
    renderDriverDrawerTab();
    return;
  }

  // Availability save (own button — writes drivers.metadata.availability)
  if (e.target.closest("[data-rr-avail-save]")) {
    e.preventDefault();
    e.stopImmediatePropagation();
    const driverId = _ddDriver?.driver?.id;
    if (!driverId) { toast("Save the driver first, then set availability", "warn"); return; }
    const days = Array.from(document.querySelectorAll("#rr-dd-drawer [data-rr-avail-day]"))
      .filter(el => el.checked)
      .map(el => el.dataset.rrAvailDay);
    const notes = document.querySelector("#rr-dd-drawer [data-rr-avail-notes]")?.value || "";
    const meta = _ddDriver.driver.metadata || {};
    const newMeta = { ...meta, availability: { days, notes } };
    const { error } = await sb.from("drivers").update({ metadata: newMeta }).eq("id", driverId);
    if (error) { toast("Save failed: " + error.message, "warn"); return; }
    _ddDriver.driver.metadata = newMeta;
    toast("Availability saved", "success");
    const drawer3 = document.getElementById("rr-dd-drawer");
    if (drawer3) drawer3.remove();
    return;
  }

  // Save record
  if (e.target.closest("[data-rr-dd-save]")) {
    e.preventDefault();
    e.stopImmediatePropagation();
    const payload = {};
    document.querySelectorAll("#rr-dd-drawer [data-rr-dd-field]").forEach(el => {
      payload[el.getAttribute("data-rr-dd-field")] = el.value;
    });
    if (payload.first_name === undefined && payload.full_name) {
      const parts = (payload.full_name || "").split(/\s+/);
      payload.first_name = parts[0] || null;
      payload.last_name  = parts.slice(1).join(" ") || null;
    }

    const isCreate = !_ddDriver?.driver?.id;
    if (isCreate) {
      // Validation
      if (!payload.full_name || !payload.full_name.trim()) { toast("Full name required", "warn"); return; }
      if (!payload.phone && !payload.email) { toast("Phone or email required", "warn"); return; }
      const dspId = window.RR?.dsp?.id;
      if (!dspId) { toast("DSP not loaded — refresh and try again", "warn"); return; }

      // Build INSERT row, normalizing empty strings to null for typed columns.
      const blank = (v) => (v === "" || v == null ? null : v);
      const payHourly = payload.pay_hourly === "" || payload.pay_hourly == null ? null : Number(payload.pay_hourly);
      const insertRow = {
        dsp_id:                  dspId,
        station_id:              blank(payload.station_id),
        full_name:               payload.full_name.trim(),
        first_name:              blank(payload.first_name),
        last_name:               blank(payload.last_name),
        preferred_name:          blank(payload.preferred_name),
        pronouns:                blank(payload.pronouns),
        phone:                   payload.phone ? toE164(payload.phone) : null,
        email:                   blank(payload.email),
        address:                 blank(payload.address),
        birthday:                blank(payload.birthday),
        emergency_contact_name:  blank(payload.emergency_contact_name),
        emergency_contact_phone: blank(payload.emergency_contact_phone),
        hire_date:               blank(payload.hire_date) || fmtIsoDate(new Date()),
        status:                  blank(payload.status) || "onboarding",
        background_check_completed_at: blank(payload.background_check_completed_at),
        drug_test_completed_at:        blank(payload.drug_test_completed_at),
        training_scheduled_at:         blank(payload.training_scheduled_at),
        training_date:                 blank(payload.training_date),
        metadata:                Number.isFinite(payHourly) ? { pay: { hourly_rate: payHourly } } : {},
      };
      const { error } = await sb.from("drivers").insert(insertRow);
      if (error) { toast("Add failed: " + error.message, "warn"); return; }
      const drawer = document.getElementById("rr-dd-drawer");
      if (drawer) drawer.remove();
      await loadDriversRoster();
      toast(`${insertRow.full_name} added`, "success");
      return;
    }

    // EDIT — RPC doesn't include station_id or metadata; handle those via direct update.
    const stationId = payload.station_id;
    const payHourlyRaw = payload.pay_hourly;
    const rpcPayload = { ...payload };
    delete rpcPayload.station_id;
    delete rpcPayload.pay_hourly;
    const { error } = await sb.rpc("update_driver_record", { p_id: _ddDriver.driver.id, p_payload: rpcPayload });
    if (error) { toast("Save failed: " + error.message, "warn"); return; }
    if (stationId !== undefined && stationId !== _ddDriver.driver.station_id) {
      const { error: stErr } = await sb.from("drivers")
        .update({ station_id: stationId || null })
        .eq("id", _ddDriver.driver.id);
      if (stErr) { toast("Station save failed: " + stErr.message, "warn"); return; }
    }
    if (payHourlyRaw !== undefined) {
      const newRate = payHourlyRaw === "" ? null : Number(payHourlyRaw);
      const existingRate = _ddDriver.driver.metadata?.pay?.hourly_rate ?? null;
      if (newRate !== existingRate) {
        const newMeta = { ..._ddDriver.driver.metadata || {}, pay: { ...(_ddDriver.driver.metadata?.pay || {}), hourly_rate: newRate } };
        const { error: payErr } = await sb.from("drivers")
          .update({ metadata: newMeta })
          .eq("id", _ddDriver.driver.id);
        if (payErr) { toast("Pay rate save failed: " + payErr.message, "warn"); return; }
        _ddDriver.driver.metadata = newMeta;
      }
    }
    toast("Driver record saved", "success");
    const drawer2 = document.getElementById("rr-dd-drawer");
    if (drawer2) drawer2.remove();
    await loadDriversRoster();
    return;
  }

  // Add coaching
  if (e.target.closest("[data-rr-add-coaching]")) {
    e.preventDefault();
    e.stopImmediatePropagation();
    openCoachingForm(_ddDriver.driver.id);
    return;
  }

  // License-tab upload
  if (e.target.closest("[data-rr-dl-upload]")) {
    e.preventDefault();
    e.stopImmediatePropagation();
    const file = document.getElementById("rr-dl-file")?.files?.[0];
    if (!file) { toast("Choose an image first", "warn"); return; }
    const path = `${window.RR.dsp.id}/${_ddDriver.driver.id}/license-${Date.now()}-${file.name}`;
    const { error: upErr } = await sb.storage.from("driver-documents").upload(path, file, {
      contentType: file.type, upsert: false,
    });
    if (upErr) { toast("Upload failed: " + upErr.message, "warn"); return; }
    // Remove any previous DL image from storage so we don't accumulate.
    if (_ddDriver.driver.dl_image_path) {
      sb.storage.from("driver-documents").remove([_ddDriver.driver.dl_image_path]).catch(() => {});
    }
    const { error: updErr } = await sb.from("drivers")
      .update({ dl_image_path: path }).eq("id", _ddDriver.driver.id);
    if (updErr) { toast("Save failed: " + updErr.message, "warn"); return; }
    toast("License image saved", "success");
    await loadDriverDrawer(_ddDriver.driver.id);
    return;
  }
  if (e.target.closest("[data-rr-dl-remove]")) {
    e.preventDefault();
    e.stopImmediatePropagation();
    if (!confirm("Remove the license image?")) return;
    if (_ddDriver.driver.dl_image_path) {
      await sb.storage.from("driver-documents").remove([_ddDriver.driver.dl_image_path]).catch(() => {});
    }
    await sb.from("drivers").update({ dl_image_path: null }).eq("id", _ddDriver.driver.id);
    toast("License image removed", "warn");
    await loadDriverDrawer(_ddDriver.driver.id);
    return;
  }

  // Open document — fetch a signed URL
  const docBtn = e.target.closest("[data-rr-doc-open]");
  if (docBtn) {
    e.preventDefault();
    e.stopImmediatePropagation();
    const path = docBtn.getAttribute("data-rr-doc-open");
    const { data: signed } = await sb.storage.from("driver-documents").createSignedUrl(path, 60 * 60);
    if (signed?.signedUrl) window.open(signed.signedUrl, "_blank");
    return;
  }

  // Upload document
  if (e.target.closest("[data-rr-doc-upload]")) {
    e.preventDefault();
    e.stopImmediatePropagation();
    const file = document.getElementById("rr-doc-file")?.files?.[0];
    const kind = document.getElementById("rr-doc-kind")?.value;
    if (!file) { toast("Choose a file first", "warn"); return; }
    const path = `${window.RR.dsp.id}/${_ddDriver.driver.id}/${Date.now()}-${file.name}`;
    const { error: upErr } = await sb.storage.from("driver-documents").upload(path, file, {
      contentType: file.type, upsert: false,
    });
    if (upErr) { toast("Upload failed: " + upErr.message, "warn"); return; }
    const { error: insErr } = await sb.from("driver_documents").insert({
      dsp_id: window.RR.dsp.id,
      driver_id: _ddDriver.driver.id,
      kind, label: file.name, file_path: path,
      file_size: file.size, mime_type: file.type,
    });
    if (insErr) { toast("Save failed: " + insErr.message, "warn"); return; }
    toast("Document uploaded", "success");
    await loadDriverDrawer(_ddDriver.driver.id);
  }
}, true);

function openCoachingForm(driverId) {
  let m = document.getElementById("rr-coach-modal");
  if (m) m.remove();
  m = document.createElement("div");
  m.id = "rr-coach-modal";
  m.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:10000;display:flex;align-items:center;justify-content:center;padding:24px";
  m.innerHTML = `
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:22px;max-width:480px;width:100%">
      <h3 style="margin:0 0 14px;font-size:17px;font-weight:600">Log a coaching</h3>
      <label style="display:block;font-size:11px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--text-muted);margin-bottom:6px">Topic</label>
      <select id="rr-coach-topic" class="form-input" style="width:100%;margin-bottom:10px">
        ${["safety","performance","attendance","behavior","recognition","other"].map(t => `<option value="${t}">${t}</option>`).join("")}
      </select>
      <label style="display:block;font-size:11px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--text-muted);margin-bottom:6px">Type</label>
      <select id="rr-coach-type" class="form-input" style="width:100%;margin-bottom:10px">
        ${["in_person","sms","email","phone_call","video_call","documented_warning"].map(t => `<option value="${t}">${t.replace(/_/g," ")}</option>`).join("")}
      </select>
      <label style="display:block;font-size:11px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--text-muted);margin-bottom:6px">Summary</label>
      <input id="rr-coach-summary" class="form-input" style="width:100%;margin-bottom:10px" placeholder="One-line headline" />
      <label style="display:block;font-size:11px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--text-muted);margin-bottom:6px">Notes</label>
      <textarea id="rr-coach-notes" class="form-input" style="width:100%;min-height:90px;margin-bottom:14px"></textarea>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button class="btn" data-rr-coach-cancel>Cancel</button>
        <button class="btn btn-primary" data-rr-coach-save>Log it</button>
      </div>
    </div>`;
  document.body.appendChild(m);
  m.addEventListener("click", async (e) => {
    if (e.target.closest("[data-rr-coach-cancel]") || e.target === m) { m.remove(); return; }
    if (e.target.closest("[data-rr-coach-save]")) {
      const payload = {
        dsp_id: window.RR.dsp.id,
        driver_id: driverId,
        coach_user_id: window.RR.user.id,
        topic: document.getElementById("rr-coach-topic").value,
        type:  document.getElementById("rr-coach-type").value,
        summary: document.getElementById("rr-coach-summary").value.trim() || null,
        notes:   document.getElementById("rr-coach-notes").value.trim() || null,
      };
      if (!payload.summary && !payload.notes) { toast("Add a summary or notes", "warn"); return; }
      const { error } = await sb.from("coachings").insert(payload);
      if (error) { toast("Save failed: " + error.message, "warn"); return; }
      m.remove();
      toast("Coaching logged", "success");
      await loadDriverDrawer(driverId);
    }
  });
}


document.addEventListener("click", async (e) => {
  const tgBtn = e.target.closest("[data-rr-video-toggle]");
  if (tgBtn) {
    e.preventDefault();
    e.stopImmediatePropagation();
    tgBtn.classList.toggle("on");
    return;
  }
  const saveBtn = e.target.closest("[data-rr-video-save]");
  if (saveBtn) {
    e.preventDefault();
    e.stopImmediatePropagation();
    saveBtn.disabled = true;
    try { await saveVideoScreeningSettings(); }
    finally { saveBtn.disabled = false; }
  }
}, true);


// ─── Messages tab ─────────────────────────────────────────────────────────
//
// Lists every message_templates row for the DSP, grouped by trigger.
// Operator can edit subject/body. Tokens like {{first_name}} / {{link}}
// stay as-is in the text and the render_template SQL substitutes them
// at send time. Attachments are deferred to a follow-up.

const RR_TEMPLATE_LABELS = {
  "applicant.invite_screening": "Screening invitation",
  "applicant.invite_interview": "Interview booking",
  "applicant.invite_orientation": "Orientation booking",
  "applicant.outcome_hired": "Hired notice",
  "applicant.outcome_no_hire": "Not-hired notice",
  "applicant.outcome_no_show": "No-show notice",
  "applicant.decline": "Decline notice",
  "driver.referral_invite": "Driver referral invite",
};

async function loadMessagesTab() {
  const list = document.getElementById("rr-messages-list");
  if (!list) return;

  const { data: rows, error } = await sb.from("message_templates")
    .select("id, channel, key, name, subject, body, active")
    .eq("dsp_id", window.RR.dsp.id)
    .order("key", { ascending: true })
    .order("channel", { ascending: true });

  if (error) {
    list.innerHTML = `<div style="padding:24px;color:var(--red);font-size:13px">${escapeHtml(error.message)}</div>`;
    return;
  }
  if (!rows || rows.length === 0) {
    list.innerHTML = `<div style="padding:24px;text-align:center;color:var(--text-subtle);font-size:13px">No templates yet.</div>`;
    return;
  }

  list.innerHTML = rows.map(renderMessageRow).join("");
}

function renderMessageRow(t) {
  const label = RR_TEMPLATE_LABELS[t.key] || t.key;
  const preview = (t.subject || t.body || "").replace(/\s+/g, " ").trim();
  return `
    <div class="msg-row" data-template-id="${t.id}">
      <div>
        <div class="msg-row-label">${escapeHtml(label)}</div>
        <div class="msg-row-sub">${escapeHtml(t.key)}</div>
      </div>
      <div><span class="msg-channel-pill ${t.channel}">${t.channel}</span></div>
      <div class="msg-body-preview" title="${escapeHtml(preview)}">${escapeHtml(preview)}</div>
      <div style="text-align:right">
        <button class="btn btn-sm" data-rr-edit-template="${t.id}">Edit</button>
      </div>
    </div>`;
}

function openMessageEditor(template) {
  const t = template;
  const isEmail = t.channel === "email";
  // Local working copy of the attachments array — lets the operator
  // upload + remove files before saving.
  let attachments = Array.isArray(t.attachments) ? [...t.attachments] : [];

  let m = document.getElementById("rr-msg-modal");
  if (m) m.remove();
  m = document.createElement("div");
  m.id = "rr-msg-modal";
  m.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:9999;display:flex;align-items:center;justify-content:center;padding:24px";

  function attachmentsHtml() {
    if (attachments.length === 0) {
      return `<div style="font-size:12px;color:var(--text-subtle);padding:8px 0">No attachments yet.</div>`;
    }
    return attachments.map((a, i) => `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 10px;background:var(--canvas);border:1px solid var(--border);border-radius:8px;margin-top:6px">
        <div style="min-width:0">
          <div style="font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(a.name || "attachment")}</div>
          <div style="font-size:10px;color:var(--text-subtle)">${a.content_type || ""} · ${a.size ? Math.round(a.size/1024)+" KB" : ""}</div>
        </div>
        <div style="display:flex;gap:6px;flex-shrink:0">
          <a class="btn btn-sm" href="${a.url}" target="_blank" rel="noreferrer">Open</a>
          <button class="btn btn-sm" data-rr-att-remove="${i}" style="color:var(--red)">Remove</button>
        </div>
      </div>`).join("");
  }
  function rerenderAttachments() {
    const wrap = m.querySelector("[data-rr-att-list]");
    if (wrap) wrap.innerHTML = attachmentsHtml();
  }

  m.innerHTML = `
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:22px;max-width:640px;width:100%;max-height:90vh;overflow:auto">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
        <div>
          <h3 style="margin:0;font-size:17px;font-weight:600">${escapeHtml(RR_TEMPLATE_LABELS[t.key] || t.key)}</h3>
          <div style="font-size:11px;color:var(--text-subtle);margin-top:2px">${escapeHtml(t.key)} · ${t.channel}</div>
        </div>
        <button data-rr-msg-cancel style="background:none;border:0;font-size:20px;cursor:pointer;color:var(--text-muted)">×</button>
      </div>

      ${isEmail ? `
        <label style="display:block;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted);margin-bottom:6px">Subject</label>
        <input data-rr-msg-subject class="form-input" style="width:100%;margin-bottom:14px" value="${escapeHtml(t.subject || "")}" />
      ` : ""}

      <label style="display:block;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted);margin-bottom:6px">Body</label>
      <textarea data-rr-msg-body class="form-input" style="width:100%;min-height:160px;font-family:'SF Mono',Menlo,monospace;font-size:13px;line-height:1.5">${escapeHtml(t.body || "")}</textarea>
      <div style="font-size:11px;color:var(--text-subtle);margin-top:6px;line-height:1.5">
        Tokens: <code>{{first_name}}</code> · <code>{{link}}</code>. Paste any URL into the body — applicants tap it directly.
        ${!isEmail ? `<br/><strong style="color:var(--text-muted)">Keep SMS under 160 chars when possible</strong> — longer messages split into multiple texts.` : ""}
      </div>

      <div style="margin-top:18px">
        <label style="display:block;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted);margin-bottom:6px">Attachments</label>
        <div style="font-size:11px;color:var(--text-subtle);margin-bottom:8px">
          ${isEmail
            ? `Email attachments are sent as files (Resend fetches the URL)`
            : `SMS attachments turn the text into MMS — Twilio fetches each file. Up to 10 per message.`}
        </div>
        <div data-rr-att-list>${attachmentsHtml()}</div>
        <div style="display:flex;gap:8px;align-items:center;margin-top:10px">
          <input type="file" data-rr-att-file />
          <button class="btn btn-sm" data-rr-att-upload>Upload</button>
        </div>
      </div>

      <label style="display:flex;align-items:center;gap:10px;margin:18px 0 4px"><input type="checkbox" data-rr-msg-active ${t.active !== false ? "checked" : ""}/>Active (used for outgoing sends)</label>

      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:18px">
        <button class="btn" data-rr-msg-cancel>Cancel</button>
        <button class="btn btn-primary" data-rr-msg-save>Save</button>
      </div>
    </div>`;
  document.body.appendChild(m);

  m.addEventListener("click", async (e) => {
    if (e.target.closest("[data-rr-msg-cancel]")) { m.remove(); return; }

    const removeBtn = e.target.closest("[data-rr-att-remove]");
    if (removeBtn) {
      const idx = parseInt(removeBtn.getAttribute("data-rr-att-remove"), 10);
      attachments.splice(idx, 1);
      rerenderAttachments();
      return;
    }

    if (e.target.closest("[data-rr-att-upload]")) {
      const input = m.querySelector("[data-rr-att-file]");
      const file = input?.files?.[0];
      if (!file) { toast("Choose a file first", "warn"); return; }
      const path = `${window.RR.dsp.id}/${t.id}/${Date.now()}-${file.name}`;
      const { error: upErr } = await sb.storage.from("message-attachments").upload(path, file, {
        contentType: file.type, upsert: false,
      });
      if (upErr) { toast("Upload failed: " + upErr.message, "warn"); return; }
      const { data: pub } = sb.storage.from("message-attachments").getPublicUrl(path);
      attachments.push({
        name: file.name, url: pub.publicUrl,
        content_type: file.type, size: file.size,
      });
      input.value = "";
      rerenderAttachments();
      toast("Attachment uploaded", "success");
      return;
    }

    if (e.target.closest("[data-rr-msg-save]")) {
      const body = m.querySelector("[data-rr-msg-body]").value;
      if (!body.trim()) { toast("Body is required", "warn"); return; }
      const subject = isEmail ? m.querySelector("[data-rr-msg-subject]").value : t.subject;
      const active = m.querySelector("[data-rr-msg-active]").checked;
      const { error } = await sb.from("message_templates")
        .update({ body, subject, active, attachments })
        .eq("id", t.id);
      if (error) { toast("Save failed: " + error.message, "warn"); return; }
      m.remove();
      toast("Template saved", "success");
      await loadMessagesTab();
    }
  });
}

// Capture-phase delegate for the message-template Edit button.
document.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-rr-edit-template]");
  if (!btn) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  const id = btn.getAttribute("data-rr-edit-template");
  const { data: t, error } = await sb.from("message_templates").select("*").eq("id", id).single();
  if (error) { toast("Couldn't load template", "warn"); return; }
  openMessageEditor(t);
}, true);


// ─── Boot: if pipeline view is the default, populate immediately ──────────
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => { loadPipeline("all"); loadPipelineKpis(); });
} else {
  loadPipeline("all");
  loadPipelineKpis();
}


// ─── Live freshness: Realtime + window focus + interval ──────────────────
//
// Three layers so the operator never has to F5 to see new data:
//
//   1. Supabase Realtime channel — pushed updates from postgres on
//      tables enabled in the supabase_realtime publication (0024).
//      Debounced so a burst of writes doesn't hammer the renders.
//   2. window 'focus' — when the operator tabs back in.
//   3. setInterval — every 30s as a safety net for the rare case
//      Realtime drops (websocket disconnect).

function refreshActiveView() {
  const activeView = document.querySelector(".view.active")?.id || "";
  if (activeView === "view-pipeline") {
    const sub = document.querySelector("#view-pipeline .pipe-subview.active, #view-pipeline .pipe-subview[style*='display: \"\"']")?.id || "pipe-sub-funnel";
    if (sub === "pipe-sub-funnel" || !sub) {
      loadPipeline(getActiveStage());
      loadPipelineKpis();
    } else if (sub === "pipe-sub-interview")  loadInterviewDay();
    else if (sub === "pipe-sub-calendar")     loadCalendarTab();
    else if (sub === "pipe-sub-screening")    loadScreeningQuestionsList();
    else if (sub === "pipe-sub-messages")     loadMessagesTab();
    else if (sub === "pipe-sub-referrals")    loadReferralsTab();
  } else if (activeView === "view-drivers") {
    const subActive = document.querySelector(".dr-subview.active")?.id;
    if (subActive === "dr-sub-licenses") loadDriverLicensesView();
    else loadDriversRoster();
  }
}

let _refreshDebounce = null;
function scheduleRefresh() {
  clearTimeout(_refreshDebounce);
  _refreshDebounce = setTimeout(refreshActiveView, 600);
}

// Realtime subscriptions — one channel covers all the tables we care about.
sb.channel("rr-dashboard")
  .on("postgres_changes", { event: "*", schema: "public", table: "applicants" },          scheduleRefresh)
  .on("postgres_changes", { event: "*", schema: "public", table: "cal_events" },          scheduleRefresh)
  .on("postgres_changes", { event: "*", schema: "public", table: "sms_messages" },        scheduleRefresh)
  .on("postgres_changes", { event: "*", schema: "public", table: "email_messages" },      scheduleRefresh)
  .on("postgres_changes", { event: "*", schema: "public", table: "interview_outcomes" }, scheduleRefresh)
  .on("postgres_changes", { event: "*", schema: "public", table: "interview_days" },     scheduleRefresh)
  .on("postgres_changes", { event: "*", schema: "public", table: "drivers" },             scheduleRefresh)
  .on("postgres_changes", { event: "*", schema: "public", table: "coachings" },           scheduleRefresh)
  .on("postgres_changes", { event: "*", schema: "public", table: "driver_documents" },    scheduleRefresh)
  .subscribe();

window.addEventListener("focus", refreshActiveView);
setInterval(refreshActiveView, 30 * 1000);


// ─── Drag-to-reorder sidebar nav ─────────────────────────────────────────
//
// HTML5 drag-and-drop on .nav-item buttons. Final order saved to
// localStorage (per-user) and re-applied on every page load.

const RR_NAV_ORDER_KEY = "rr-nav-order-v1";

function applyStoredNavOrder() {
  const raw = localStorage.getItem(RR_NAV_ORDER_KEY);
  if (!raw) return;
  let order;
  try { order = JSON.parse(raw); } catch { return; }
  if (!Array.isArray(order)) return;

  const nav = document.querySelector(".sidebar nav, nav.sidebar-nav, nav") || document.querySelector(".nav-item")?.parentElement;
  if (!nav) return;

  const byView = new Map();
  nav.querySelectorAll(".nav-item[data-view]").forEach(el => byView.set(el.getAttribute("data-view"), el));
  for (const view of order) {
    const el = byView.get(view);
    if (el) nav.appendChild(el);  // appendChild moves the existing node
  }
}

function persistNavOrder() {
  const items = document.querySelectorAll(".nav-item[data-view]");
  const order = [...items].map(el => el.getAttribute("data-view"));
  localStorage.setItem(RR_NAV_ORDER_KEY, JSON.stringify(order));
}

function wireSidebarDrag() {
  const items = document.querySelectorAll(".nav-item[data-view]");
  if (items.length === 0) return;
  let dragged = null;

  items.forEach((el) => {
    el.setAttribute("draggable", "true");
    el.style.cursor = "grab";

    el.addEventListener("dragstart", (e) => {
      dragged = el;
      el.style.opacity = "0.4";
      e.dataTransfer.effectAllowed = "move";
      // Required for Firefox to fire the drag.
      try { e.dataTransfer.setData("text/plain", el.getAttribute("data-view") || ""); } catch { /* */ }
    });

    el.addEventListener("dragend", () => {
      el.style.opacity = "";
      dragged = null;
      persistNavOrder();
    });

    el.addEventListener("dragover", (e) => {
      e.preventDefault();
      if (!dragged || dragged === el) return;
      const rect = el.getBoundingClientRect();
      const before = (e.clientY - rect.top) < (rect.height / 2);
      el.parentNode.insertBefore(dragged, before ? el : el.nextSibling);
    });
  });
}

applyStoredNavOrder();
wireSidebarDrag();


// ─── Pin to Dashboard ─────────────────────────────────────────────────────
//
// Generalized pinning. Any element marked with the data attributes
//
//   data-rr-pinnable
//   data-rr-pin-kind="kpi" | "applicant" | "driver"
//   data-rr-pin-ref="<id-or-key>"
//   data-rr-pin-label="<friendly label>"
//
// becomes pinnable. Long-press (~500ms mousedown / touchstart) reveals
// a small floating "📌 Pin" button. Click it to pin / unpin. Pinned
// items render as cards on the Dashboard view.
//
// Storage: localStorage 'rr-pins-v2' = [{kind, ref, label}, …].
// Cross-device persistence (per app_user) lands in a follow-up.

const RR_PINS_KEY = "rr-pins-v2";
function readPins() {
  try { return JSON.parse(localStorage.getItem(RR_PINS_KEY) || "[]"); }
  catch { return []; }
}
function writePins(pins) {
  localStorage.setItem(RR_PINS_KEY, JSON.stringify(pins));
}
function isPinned(kind, ref) {
  return readPins().some(p => p.kind === kind && p.ref === ref);
}
function togglePin(kind, ref, label) {
  const pins = readPins();
  const idx = pins.findIndex(p => p.kind === kind && p.ref === ref);
  if (idx >= 0) pins.splice(idx, 1);
  else          pins.push({ kind, ref, label, pinned_at: new Date().toISOString() });
  writePins(pins);
  renderPinnedDashboard();
  return idx < 0;
}

let _pressTimer = null;
let _pressTarget = null;

function startPress(e, target) {
  _pressTarget = target;
  _pressTimer = setTimeout(() => {
    if (_pressTarget) showPinOverlay(_pressTarget);
  }, 500);
}
function cancelPress() {
  if (_pressTimer) { clearTimeout(_pressTimer); _pressTimer = null; }
  _pressTarget = null;
}

document.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  // Don't long-press on actual buttons / form fields inside pinnables.
  if (e.target.closest("button, input, select, textarea, a")) return;
  const target = e.target.closest("[data-rr-pinnable]");
  if (target) startPress(e, target);
});
document.addEventListener("mouseup", cancelPress);
document.addEventListener("mouseleave", cancelPress);
document.addEventListener("touchstart", (e) => {
  if (e.target.closest("button, input, select, textarea, a")) return;
  const target = e.target.closest("[data-rr-pinnable]");
  if (target) startPress(e, target);
}, { passive: true });
document.addEventListener("touchend", cancelPress);
document.addEventListener("touchcancel", cancelPress);

function showPinOverlay(target) {
  const kind  = target.getAttribute("data-rr-pin-kind");
  const ref   = target.getAttribute("data-rr-pin-ref");
  const label = target.getAttribute("data-rr-pin-label");
  if (!kind || !ref) return;

  // Remove any existing overlay.
  document.getElementById("rr-pin-overlay")?.remove();

  const rect = target.getBoundingClientRect();
  const pinned = isPinned(kind, ref);

  const ov = document.createElement("div");
  ov.id = "rr-pin-overlay";
  ov.style.cssText = `
    position:fixed; z-index:9998;
    left:${Math.min(rect.right - 180, window.innerWidth - 200)}px;
    top:${Math.max(8, rect.top - 44)}px;
    background:var(--surface); border:1px solid var(--border);
    border-radius:10px; padding:6px 6px 6px 10px;
    box-shadow:0 6px 20px rgba(0,0,0,.25);
    display:flex; align-items:center; gap:8px;
    animation:rr-pop .12s ease-out;
    font-size:12px;
  `;
  ov.innerHTML = `
    <button class="btn btn-sm btn-primary" data-rr-pin-confirm style="font-size:12px;display:flex;align-items:center;gap:6px;margin:0">
      <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14l-1.5-3.5V8a5.5 5.5 0 0 0-11 0v5.5z"/></svg>
      ${pinned ? "Unpin" : "Pin to dashboard"}
    </button>
    <button data-rr-pin-cancel aria-label="Cancel" style="background:none;border:0;font-size:18px;line-height:1;padding:2px 6px;cursor:pointer;color:var(--text-muted)">×</button>`;
  document.body.appendChild(ov);

  const close = () => { ov.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);

  ov.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.target.closest("[data-rr-pin-cancel]")) { close(); return; }
    if (e.target.closest("[data-rr-pin-confirm]")) {
      const nowPinned = togglePin(kind, ref, label);
      toast(nowPinned ? `Pinned "${label}"` : `Unpinned "${label}"`, "success");
      close();
    }
  });
}


// ─── Hover pin icon (the easy desktop path) ──────────────────────────────
//
// In addition to the long-press gesture, every pinnable element gets a
// small floating pin icon visible on hover. One click toggles. This is
// the primary desktop interaction; long-press is the touch fallback.

function ensurePinIcon(el) {
  if (el.querySelector(":scope > .rr-pin-icon")) return;
  const kind = el.getAttribute("data-rr-pin-kind");
  const ref  = el.getAttribute("data-rr-pin-ref");
  if (!kind || !ref) return;

  // Position the icon absolutely; only show on hover. Inline styles so
  // we don't need extra CSS edits in the static HTML.
  if (getComputedStyle(el).position === "static") el.style.position = "relative";
  const icon = document.createElement("button");
  icon.className = "rr-pin-icon";
  icon.type = "button";
  icon.setAttribute("aria-label", "Pin to dashboard");
  icon.setAttribute("title", "Pin to dashboard");
  icon.style.cssText = `
    position:absolute; top:6px; right:6px; z-index:5;
    background:var(--surface); border:1px solid var(--border);
    border-radius:6px; padding:4px;
    width:24px; height:24px; cursor:pointer;
    display:none; align-items:center; justify-content:center;
    color:var(--text-muted);
  `;
  icon.innerHTML = `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2.2"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14l-1.5-3.5V8a5.5 5.5 0 0 0-11 0v5.5z"/></svg>`;
  el.appendChild(icon);

  el.addEventListener("mouseenter", () => { icon.style.display = "flex"; updatePinIconState(icon, kind, ref); });
  el.addEventListener("mouseleave", () => { icon.style.display = "none"; });
  icon.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const lab = el.getAttribute("data-rr-pin-label");
    const nowPinned = togglePin(kind, ref, lab);
    updatePinIconState(icon, kind, ref);
    toast(nowPinned ? `Pinned "${lab}"` : `Unpinned "${lab}"`, "success");
  });
}

function updatePinIconState(icon, kind, ref) {
  const on = isPinned(kind, ref);
  icon.style.color      = on ? "var(--accent-text)" : "var(--text-muted)";
  icon.style.background = on ? "var(--accent-soft)" : "var(--surface)";
  icon.style.borderColor = on ? "var(--accent)"     : "var(--border)";
}

// Walk the DOM whenever a render changes things, to ensure all pinnable
// elements have their hover icon. MutationObserver handles dynamic
// renders (loadPipeline, loadDriversRoster, etc.).
function syncPinIcons() {
  document.querySelectorAll("[data-rr-pinnable]").forEach(ensurePinIcon);
}
syncPinIcons();
new MutationObserver(syncPinIcons).observe(document.body, { childList: true, subtree: true });


// ─── Dashboard pinned cards ──────────────────────────────────────────────

function renderPinnedDashboard() {
  const queue = document.getElementById("action-queue");
  if (!queue) return;
  // Wipe previously-rendered RR pinned cards (idempotent re-render).
  queue.querySelectorAll(".task-card.rr-pinned").forEach(c => c.remove());

  const pins = readPins();
  if (pins.length === 0) return;

  for (const p of pins) {
    const card = buildPinnedCard(p);
    if (card) queue.insertBefore(card, queue.firstChild);
  }
}

function buildPinnedCard(p) {
  const card = document.createElement("div");
  card.className = "task-card rr-pinned";
  card.dataset.sev = "info";
  card.dataset.rrPinKind = p.kind;
  card.dataset.rrPinRef  = p.ref;

  card.innerHTML = `
    <div class="task-tools">
      <button class="task-tool" type="button" aria-label="Unpin"
              onclick="event.stopPropagation();window.RR_unpin('${p.kind}','${p.ref}');">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>
    <div class="task-head">
      <div class="task-eyebrow">${p.kind === "kpi" ? "Pipeline KPI" : p.kind === "applicant" ? "Applicant" : p.kind === "driver" ? "Driver" : p.kind}</div>
      <div class="task-title">${escapeHtml(p.label || p.ref)}</div>
    </div>
    <div class="task-msg" data-rr-pin-body>Loading…</div>
  `;
  // Async hydrate the card body based on kind.
  hydratePinnedCard(card, p);
  return card;
}

window.RR_unpin = function (kind, ref) {
  const pins = readPins().filter(p => !(p.kind === kind && p.ref === ref));
  writePins(pins);
  renderPinnedDashboard();
  toast("Unpinned", "warn");
};

async function hydratePinnedCard(card, p) {
  const body = card.querySelector("[data-rr-pin-body]");
  if (!body) return;

  if (p.kind === "kpi") {
    const [{ data: k }, { data: f }] = await Promise.all([
      sb.rpc("pipeline_kpis",        { p_window_days: 28 }),
      sb.rpc("pipeline_funnel_kpis", { p_window_days: 28 }),
    ]);
    const map = {
      contacted_pct: f?.contacted_pct,
      passed_pct:    f?.passed_pct,
      booked_rate:   f?.booked_rate,
      e2e_pct:       f?.e2e_pct,
      show_rate:     k ? Math.round(Number(k.show_rate ?? 0) * 100) : 0,
      hire_rate:     k ? Math.round(Number(k.hire_rate ?? 0) * 100) : 0,
    };
    const v = map[p.ref];
    body.innerHTML = `<span style="font-size:32px;font-weight:700;color:var(--text);letter-spacing:-.02em">${v ?? "—"}%</span>`;
    return;
  }

  if (p.kind === "applicant") {
    const { data: a } = await sb.from("applicants")
      .select("id, full_name, status, phone, email")
      .eq("id", p.ref).maybeSingle();
    if (!a) { body.innerHTML = `<span style="color:var(--text-subtle)">Removed.</span>`; return; }
    body.innerHTML = `<strong>${escapeHtml(a.full_name)}</strong> · ${a.status}<br/><span style="color:var(--text-subtle);font-size:12px">${a.phone || a.email || ""}</span>`;
    return;
  }

  if (p.kind === "driver") {
    const { data: d } = await sb.from("drivers")
      .select("id, full_name, status, hire_date")
      .eq("id", p.ref).maybeSingle();
    if (!d) { body.innerHTML = `<span style="color:var(--text-subtle)">Removed.</span>`; return; }
    const days = d.hire_date ? Math.floor((Date.now() - new Date(d.hire_date).getTime()) / 86400000) : null;
    body.innerHTML = `<strong>${escapeHtml(displayDriverName(d))}</strong> · ${d.status}${days != null ? ` · ${days}d` : ""}`;
    return;
  }

  body.innerHTML = `<span style="color:var(--text-subtle)">Pinned (${p.kind})</span>`;
}

// Re-render pinned dashboard cards on dashboard view + on data change.
const _origRefresh = refreshActiveView;
function refreshWithPins() {
  _origRefresh();
  if (document.querySelector(".view.active")?.id === "view-dashboard") {
    renderPinnedDashboard();
    if (typeof loadDashboardTasks === "function") loadDashboardTasks();
    if (typeof loadDashboardWeather === "function") loadDashboardWeather();
  }
}
window.addEventListener("focus", () => {
  if (document.querySelector(".view.active")?.id === "view-dashboard") {
    renderPinnedDashboard();
    if (typeof loadDashboardTasks === "function") loadDashboardTasks();
    if (typeof loadDashboardWeather === "function") loadDashboardWeather();
  }
});

// Initial load: if the dashboard is the active view at boot, populate the tasks card.
if (document.querySelector(".view.active")?.id === "view-dashboard") {
  setTimeout(() => { loadDashboardTasks?.(); loadDashboardWeather?.(); }, 0);
}

// Initial render on load.
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", renderPinnedDashboard);
} else {
  renderPinnedDashboard();
}

// Pop animation
const _styleEl = document.createElement("style");
_styleEl.textContent = `@keyframes rr-pop{from{opacity:0;transform:scale(.92)}to{opacity:1;transform:scale(1)}} [data-rr-pinnable]{user-select:none}
[data-rr-pool-shift]{cursor:grab}
[data-rr-pool-shift]:hover{box-shadow:0 1px 4px rgba(0,0,0,.06);transform:translateY(-1px)}
[data-rr-pool-shift].rr-dragging{opacity:.5}
.cal-cell.rr-drop-active{background:var(--accent-soft) !important;outline:2px dashed var(--accent);outline-offset:-2px}
/* Slim, subtle scrollbar on the Open Shifts pool so it doesn't read as a 'gray band' */
aside.driver-pool { scrollbar-width: thin; scrollbar-color: var(--border-strong) transparent; }
aside.driver-pool::-webkit-scrollbar { width: 6px; }
aside.driver-pool::-webkit-scrollbar-track { background: transparent; }
aside.driver-pool::-webkit-scrollbar-thumb { background: var(--border-strong); border-radius: 3px; }
aside.driver-pool::-webkit-scrollbar-thumb:hover { background: var(--text-subtle); }
/* OKAMI table — strip every mockup pill/color (operator wanted plain table) */
.plan-gap, .plan-gap.ok, .plan-gap.warn, .plan-gap.bad { color: var(--text-muted) !important; }
.plan-status-pill, .plan-status-pill.ok, .plan-status-pill.warn, .plan-status-pill.bad {
  background: transparent !important; color: var(--text-muted) !important; border: 0 !important;
  font-weight: 500 !important; padding: 0 !important;
}
.plan-status-pill .dot { display: none !important; }
.strategy-pill, .strategy-pill.active, .strategy-pill.active.hire, .strategy-pill.active.adw, .strategy-pill.active.ot, .strategy-pill.active.seasonal {
  background: transparent !important; color: var(--text-muted) !important; border-color: transparent !important;
  font-weight: 500 !important;
}
/* Kill HVE row highlights + the tag pills on week labels */
.okami-table tr.hve, .okami-table tr.hve > td { background: transparent !important; }
.okami-week-tag, .okami-week-tag.hve, .okami-week-tag.peak, .okami-week-tag.cycle { display: none !important; }
.plan-calc-sub { display: none !important; }
/* Hide the Strategy / Hire by / Status columns (operator: not needed) */
.okami-table th:nth-child(6),
.okami-table th:nth-child(7),
.okami-table th:nth-child(8),
.okami-table tr:not(.okami-detail) > td:nth-child(6),
.okami-table tr:not(.okami-detail) > td:nth-child(7),
.okami-table tr:not(.okami-detail) > td:nth-child(8) { display: none !important; }
/* Kill mockup row decorations: cycle-end blue underline + HVE yellow stripe. */
.okami-table tbody tr.cycle-end { border-bottom: 1px solid var(--border) !important; background: transparent !important; }
.okami-table tbody tr.hve { background: transparent !important; }`;
document.head.appendChild(_styleEl);


// ─── OKAMI (demand) + Schedule (supply) ───────────────────────────────────
//
// OKAMI: 3-week per-day per-station route TARGET grid. Editable.
// Schedule: 3-week per-day per-station coverage view (filled vs needed),
// plus time-off and open-shifts panels.

const RR_SCHED_WEEKS = 3;
const RR_DAY_SHORT   = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];

function startOfWeekMonday(d) {
  const date = new Date(d);
  const day = date.getDay();             // 0=Sun, 1=Mon, ...
  const diff = day === 0 ? -6 : 1 - day; // shift back to Monday
  date.setDate(date.getDate() + diff);
  date.setHours(0, 0, 0, 0);
  return date;
}
function fmtIsoDate(d) { return d.toISOString().slice(0, 10); }
function fmtMD(d) { return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }); }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }


// NOTE — earlier iteration of this code overwrote the OKAMI table and
// Schedule subview innerHTML, replacing the polished mockup layout with
// a generic grid. Operator pushed back; mockup design is the source of
// truth. Wiring live data INTO the mockup elements (without touching
// the structure) is queued as a follow-up.
//
// For now: leave the mockup OKAMI + Schedule views untouched. Schema
// (0025) and RPCs are still deployed and usable from SQL / future UI.

let _okamiStations = [];
let _schedDriverList = [];
let _okamiStart = null;
let _schedStart = null;

async function loadOkamiView() {
  await renderOkamiLive();
  bindOkamiHandlers();
}

// ─── OKAMI · 13-week list (live render + save) ─────────────────────────────

const RR_OKAMI_WEEKS = 13;
const RR_OKAMI_HIRE_LEAD_DAYS = 28; // training/onboarding lead time

function isoWeekNumber(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
}

let _okamiActiveCount = 0;
let _okamiCushionPct = 10;

async function renderOkamiLive() {
  const tbody = document.getElementById("okami-tbody");
  if (!tbody) return;
  const dspId = window.RR?.dsp?.id;
  if (!dspId) return;

  // Always anchor OKAMI to the actual current week so the 13-week planner
  // rolls forward as the calendar advances. Operator's schedule view has
  // prev/next navigation; OKAMI is always 'this week + 12'.
  _okamiStart = fmtIsoDate(startOfWeekMonday(new Date()));
  const start = new Date(_okamiStart + "T12:00:00");

  const [gridRes, drvRes] = await Promise.all([
    sb.rpc("okami_grid", { p_start: _okamiStart, p_weeks: RR_OKAMI_WEEKS }),
    sb.from("drivers")
      .select("id, status", { count: "exact", head: true })
      .eq("dsp_id", dspId)
      .in("status", ["active", "onboarding"]),
  ]);

  if (gridRes.error) { console.warn("okami_grid:", gridRes.error.message); return; }
  if (drvRes.error)  { console.warn("driver count:", drvRes.error.message); return; }

  const cells = gridRes.data || [];
  _okamiActiveCount = drvRes.count || 0;
  if (cells.length && cells[0].cushion_pct != null) {
    _okamiCushionPct = Number(cells[0].cushion_pct) || 10;
  }

  // Sum target_routes per ISO date across all stations.
  const totalsByDate = new Map();
  for (const c of cells) {
    totalsByDate.set(c.date, (totalsByDate.get(c.date) || 0) + (c.target_routes || 0));
  }

  // Reflect real cushion into the knob if its value differs.
  const cushionInput = document.getElementById("okami-cushion");
  const cushionVal   = document.getElementById("okami-cushion-val");
  if (cushionInput && Number(cushionInput.value) !== Math.round(_okamiCushionPct)) {
    cushionInput.value = Math.round(_okamiCushionPct);
    if (cushionVal) cushionVal.innerHTML = `${Math.round(_okamiCushionPct)}<span class="frac">%</span>`;
  }

  const dpr = parseFloat(document.getElementById("okami-dpr")?.value) || 2.0;

  // Mockup only assigned id='okami-row-N' to the first three rows; rows
  // 3..12 had no id, so the older lookup silently skipped them and W21
  // through W30 never got their labels rewritten. Use every non-detail
  // row inside #okami-tbody in document order instead.
  const okTbody = document.getElementById("okami-tbody");
  const allOkamiRows = okTbody
    ? Array.from(okTbody.querySelectorAll("tr:not(.okami-detail)"))
    : [];

  for (let w = 0; w < RR_OKAMI_WEEKS; w++) {
    const row = allOkamiRows[w];
    if (!row) continue;
    const weekStart = addDays(start, w * 7);
    const weekEnd   = addDays(weekStart, 6);

    // Routes per day across the week, then peak.
    let routesMax = 0;
    for (let d = 0; d < 7; d++) {
      const iso = fmtIsoDate(addDays(weekStart, d));
      const t = totalsByDate.get(iso) || 0;
      if (t > routesMax) routesMax = t;
    }

    const base    = Math.round(routesMax * dpr);
    const cushion = (_okamiCushionPct || 0) / 100;
    const needed  = base + Math.ceil(base * cushion);
    const gap     = _okamiActiveCount - needed;
    const hireBy  = addDays(weekStart, -RR_OKAMI_HIRE_LEAD_DAYS);

    // Update week label + dates (without disturbing the expand button or tags).
    const labelEl = row.querySelector(".plan-week-label");
    const datesEl = row.querySelector(".plan-week-dates");
    if (labelEl) labelEl.textContent = `W${isoWeekNumber(weekStart)}`;
    if (datesEl) datesEl.textContent = `${fmtMD(weekStart)}–${weekEnd.getDate()}`;

    // Routes (max) is now READ-ONLY — operator edits per-day in the
    // daily drill-down panel and Routes (max) reflects the peak day.
    // Editing the cell directly used to overwrite all 7 days, which
    // destroyed per-day variation. Set readOnly + light styling so it
    // looks like a display value, not an input.
    const input = row.querySelector(".plan-route-input");
    if (input) {
      input.value = routesMax;
      input.readOnly = true;
      input.style.background = "transparent";
      input.style.border = "0";
      input.style.cursor = "default";
      input.title = "Edit per-day values in the drill-down panel";
    }

    const tdCells = row.querySelectorAll("td");
    // [0]=Week, [1]=Routes input, [2]=Needed, [3]=Available, [4]=Gap, [5]=Strategy, [6]=Hire by, [7]=Status
    if (tdCells[2]) tdCells[2].innerHTML = `<div class="plan-calc">${needed}</div>`;
    if (tdCells[3]) tdCells[3].innerHTML = `<div class="plan-calc">${_okamiActiveCount}</div>`;

    // Plain numbers — no color codes / pills (operator wanted less noise).
    const gapEl = tdCells[4]?.querySelector(".plan-gap");
    if (gapEl) {
      gapEl.textContent = (gap >= 0 ? "+" : "") + gap;
      gapEl.classList.remove("ok", "warn", "bad");
    }

    const stratEl = tdCells[5]?.querySelector(".strategy-pills");
    if (stratEl) {
      const text = gap >= 0 ? "Hold" : (gap >= -10 ? "+8h OT" : "Hire");
      stratEl.innerHTML = `<span style="font-size:12px;color:var(--text-muted)">${text}</span>`;
    }

    const hireByEl = tdCells[6]?.querySelector(".plan-calc");
    if (hireByEl) {
      hireByEl.textContent = gap >= 0 ? "—" : fmtMD(hireBy);
    }

    const statusPill = tdCells[7]?.querySelector(".plan-status-pill");
    if (statusPill) {
      statusPill.classList.remove("ok", "warn", "bad");
      const text = gap >= 0 ? "On track" : (gap >= -10 ? "Tight" : "Critical");
      statusPill.outerHTML = `<span style="font-size:12px;color:var(--text-muted)">${text}</span>`;
    }
  }

  // Update top hires-needed summary cell, if present.
  let totalHires = 0;
  for (let w = 0; w < RR_OKAMI_WEEKS; w++) {
    const row = allOkamiRows[w];
    const gapEl = row?.querySelectorAll("td")[4]?.querySelector(".plan-gap");
    if (!gapEl) continue;
    const g = parseInt(gapEl.textContent, 10);
    if (Number.isFinite(g) && g < 0) totalHires += -g;
  }
  const sumValue = document.querySelector(".okami-summary-grid .okami-sum:first-child .okami-sum-value");
  if (sumValue) sumValue.textContent = totalHires;
}

let _okamiBound = false;
let _okamiSaveTimers = new Map();
const _okamiDirtyWeeks = new Set();

function _setOkamiSaveStatus(text, kind) {
  const el = document.getElementById("rr-okami-save-status");
  if (!el) return;
  el.textContent = text || "";
  el.style.color = kind === "warn" ? "var(--red)" : kind === "ok" ? "var(--green)" : "var(--text-subtle)";
}

function bindOkamiHandlers() {
  if (_okamiBound) return;
  _okamiBound = true;

  // The mockup's recalcOkami fires on every DPR / ADW / OT / cushion
  // slider tick and writes hardcoded okamiAvail values to every row's
  // cells, overwriting our live render. Neutralize it so only our
  // renderOkamiLive controls the table.
  window.recalcOkami = function () {
    if (typeof renderOkamiLive === "function") renderOkamiLive();
  };

  // Save plan button now triggers a full regenerate of schedule shifts
  // from the current OKAMI demand. Daily values auto-save in the
  // drilldown panel; this button is the explicit "sync schedule with
  // plan" action that also trims any drift.
  const saveBtn = document.getElementById("rr-okami-save-plan");
  if (saveBtn) {
    saveBtn.addEventListener("click", async () => {
      const dspId = window.RR?.dsp?.id;
      if (!dspId) { _setOkamiSaveStatus("DSP not loaded", "warn"); return; }
      saveBtn.disabled = true;
      _setOkamiSaveStatus("Regenerating shifts…");
      try {
        const { data: rows, error } = await sb.from("okami_demand")
          .select("date, station_id")
          .eq("dsp_id", dspId);
        if (error) throw error;
        for (const r of (rows || [])) {
          const { error: gErr } = await sb.rpc("generate_shifts_for_date", { p_date: r.date, p_station_id: r.station_id });
          if (gErr) throw gErr;
        }
        _setOkamiSaveStatus(`Synced ${rows?.length || 0} day${rows?.length === 1 ? "" : "s"} ✓`, "ok");
        setTimeout(() => _setOkamiSaveStatus(""), 2500);
        await renderOkamiLive();
      } catch (err) {
        _setOkamiSaveStatus("Failed: " + (err.message || err), "warn");
      } finally {
        saveBtn.disabled = false;
      }
    });
  }

  // Cushion slider — save on commit (mouseup/keyup), not every drag tick.
  const cushion = document.getElementById("okami-cushion");
  if (cushion) {
    cushion.addEventListener("change", async () => {
      const pct = parseInt(cushion.value, 10) || 0;
      const { error } = await sb.rpc("okami_set_cushion", { p_pct: pct });
      if (error) { toast("Save failed: " + error.message, "warn"); return; }
      _okamiCushionPct = pct;
      await renderOkamiLive();
    });
  }
  // DPR + ADW + OT are UI-only (no storage yet); recalc on change.
  ["okami-dpr", "okami-adw", "okami-ot"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("change", () => renderOkamiLive());
  });

  // Override the mockup toggle so the drill-down panel renders from real data.
  window.okamiToggleDaily = function (weekIdx) {
    const detail = document.getElementById(`okami-detail-${weekIdx}`);
    const btn = document.querySelector(`#okami-row-${weekIdx} .okami-expand-btn`);
    if (!detail || !btn) return;
    const isOpen = detail.classList.toggle("open");
    btn.classList.toggle("expanded", isOpen);
    if (isOpen) renderOkamiDailyPanel(weekIdx);
  };
}

async function saveOkamiWeek(w, routesMax) {
  const dspId = window.RR?.dsp?.id;
  if (!dspId) return;
  if (!_okamiStart) return;
  const weekStart = addDays(new Date(_okamiStart + "T12:00:00"), w * 7);

  // Need station list — fetch once and cache on _okamiStations.
  if (!_okamiStations || _okamiStations.length === 0) {
    const { data, error } = await sb.from("stations")
      .select("id, code, active")
      .eq("dsp_id", dspId)
      .eq("active", true);
    if (error) { toast("Save failed: " + error.message, "warn"); return; }
    _okamiStations = data || [];
  }
  if (_okamiStations.length === 0) {
    toast("No stations configured — add a station before setting OKAMI", "warn");
    return;
  }

  // Single-station mode: full value to the first station, zero out the
  // rest. Splitting across stations introduced rounding drift when the
  // value couldn't be divided evenly.
  const calls = [];
  for (let d = 0; d < 7; d++) {
    const iso = fmtIsoDate(addDays(weekStart, d));
    _okamiStations.forEach((s, idx) => {
      calls.push(sb.rpc("okami_set_target", { p_date: iso, p_station_id: s.id, p_target: idx === 0 ? routesMax : 0 }));
    });
  }
  const results = await Promise.all(calls);
  const firstErr = results.find(r => r.error);
  if (firstErr) { toast("Save failed: " + firstErr.error.message, "warn"); return; }
  await renderOkamiLive();
}

// ─── OKAMI · daily drill-down panel (PR C) ─────────────────────────────────

const RR_OKAMI_DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const _okamiDailySaveTimers = new Map();
let _okamiDailyDelegated = false;

async function recommendOkamiCushion(dspId) {
  const since = new Date(); since.setDate(since.getDate() - 30);
  const sinceIso = fmtIsoDate(since);
  const [scheduledRes, absentRes] = await Promise.all([
    sb.from("shifts").select("id", { count: "exact", head: true })
      .eq("dsp_id", dspId).gte("date", sinceIso)
      .in("status", ["scheduled", "completed", "called_off", "no_show"]),
    sb.from("shifts").select("id", { count: "exact", head: true })
      .eq("dsp_id", dspId).gte("date", sinceIso)
      .in("status", ["called_off", "no_show"]),
  ]);
  if (scheduledRes.error || absentRes.error) {
    return { percent: 10, source: "Using default — no data yet", absences: 0, total: 0 };
  }
  const total = scheduledRes.count || 0;
  const absences = absentRes.count || 0;
  if (total === 0) {
    return { percent: 10, source: "No scheduled shifts in last 30d", absences: 0, total: 0 };
  }
  const rate = absences / total;
  const recommended = Math.max(5, Math.min(20, Math.round(rate * 100 * 1.5)));
  return {
    percent: recommended,
    absences,
    total,
    source: `${absences} callout${absences === 1 ? "" : "s"} + no-shows over ${total} scheduled last 30d = ${(rate * 100).toFixed(1)}% absence · 1.5× safety`,
  };
}

async function renderOkamiDailyPanel(weekIdx) {
  const container = document.getElementById(`okami-detail-content-${weekIdx}`);
  if (!container) return;
  const dspId = window.RR?.dsp?.id;
  if (!dspId) return;
  if (!_okamiStart) return;

  const weekStart = addDays(new Date(_okamiStart + "T12:00:00"), weekIdx * 7);
  const startIso = fmtIsoDate(weekStart);
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const todayIso = fmtIsoDate(new Date());

  container.innerHTML = `<div style="padding:18px;color:var(--text-subtle);font-size:12px">Loading…</div>`;

  const [gridRes, recommendation] = await Promise.all([
    sb.rpc("okami_grid", { p_start: startIso, p_weeks: 1 }),
    recommendOkamiCushion(dspId),
  ]);
  if (gridRes.error) {
    container.innerHTML = `<div style="padding:18px;color:var(--red);font-size:12px">Failed to load: ${escapeHtml(gridRes.error.message)}</div>`;
    return;
  }
  const cells = gridRes.data || [];

  // Sum target_routes per date across stations.
  const totalsByDate = new Map();
  for (const c of cells) {
    totalsByDate.set(c.date, (totalsByDate.get(c.date) || 0) + (c.target_routes || 0));
  }

  const cushionPct = _okamiCushionPct || 10;
  const dailyRoutes = days.map(d => totalsByDate.get(fmtIsoDate(d)) || 0);
  // ceil to match generate_shifts on the server — shifts-to-schedule = shifts created.
  const dailyShifts = dailyRoutes.map(r => Math.ceil(r * (1 + cushionPct / 100)));
  const totalRoutes = dailyRoutes.reduce((s, n) => s + n, 0);
  const totalShifts = dailyShifts.reduce((s, n) => s + n, 0);
  const peakRoutes  = dailyRoutes.reduce((m, n) => n > m ? n : m, 0);
  const extraTotal  = totalShifts - totalRoutes;

  const headerLabel = `W${isoWeekNumber(weekStart)} · ${fmtMD(weekStart)}–${addDays(weekStart, 6).getDate()}`;

  container.innerHTML = `
    <div class="okami-daily-panel" style="grid-template-columns:1fr">
      <div class="okami-daily-grid">
        <div class="okami-daily-grid-head">
          <div>${escapeHtml(headerLabel)}</div>
          ${RR_OKAMI_DAY_LABELS.map(l => `<div>${l}</div>`).join("")}
        </div>
        <div class="okami-daily-row">
          <div class="okami-daily-label">Routes planned</div>
          ${days.map((d, i) => {
            const iso = fmtIsoDate(d);
            const isToday = iso === todayIso;
            return `<div class="okami-daily-cell${isToday ? " is-today" : ""}"><input type="number" min="0" max="200" value="${dailyRoutes[i]}" data-rr-okami-daily="${weekIdx}" data-iso="${iso}"/></div>`;
          }).join("")}
        </div>
      </div>
      <div style="grid-column:1 / -1;display:flex;justify-content:space-between;font-size:11px;color:var(--text-subtle);padding:10px 4px 0">
        <span>Week total <strong style="color:var(--text)">${totalRoutes}</strong> routes</span>
        <span>Peak day <strong style="color:var(--text)">${peakRoutes} routes</strong> · cushion applied in Schedule</span>
      </div>
    </div>`;

  bindOkamiDailyDelegation();
}

function bindOkamiDailyDelegation() {
  if (_okamiDailyDelegated) return;
  _okamiDailyDelegated = true;
  const tbody = document.getElementById("okami-tbody");
  if (!tbody) return;

  tbody.addEventListener("input", (e) => {
    const inp = e.target.closest("input[data-rr-okami-daily]");
    if (!inp) return;
    const weekIdx = parseInt(inp.dataset.rrOkamiDaily, 10);
    const iso = inp.dataset.iso;
    if (!iso || !Number.isFinite(weekIdx)) return;
    const key = `${weekIdx}|${iso}`;
    const prev = _okamiDailySaveTimers.get(key);
    if (prev) clearTimeout(prev);
    _okamiDailySaveTimers.set(key, setTimeout(() => saveOkamiDaily(weekIdx, iso, parseInt(inp.value, 10) || 0), 400));
  });

  tbody.addEventListener("change", async (e) => {
    const cushionInp = e.target.closest("input[data-rr-okami-cushion-pct]");
    if (cushionInp) {
      const pct = Math.max(0, Math.min(50, parseInt(cushionInp.value, 10) || 0));
      const { error } = await sb.rpc("okami_set_cushion", { p_pct: pct });
      if (error) { toast("Save failed: " + error.message, "warn"); return; }
      _okamiCushionPct = pct;
      const topInp = document.getElementById("okami-cushion");
      if (topInp) topInp.value = pct;
      const topVal = document.getElementById("okami-cushion-val");
      if (topVal) topVal.innerHTML = `${pct}<span class="frac">%</span>`;
      const openIdx = openOkamiDetailIndex();
      if (openIdx != null) renderOkamiDailyPanel(openIdx);
      renderOkamiLive();
      return;
    }
  });

  tbody.addEventListener("click", async (e) => {
    const apply = e.target.closest("[data-rr-okami-apply-rec]");
    if (!apply) return;
    const pct = parseInt(apply.dataset.rrOkamiApplyRec, 10);
    if (!Number.isFinite(pct)) return;
    const { error } = await sb.rpc("okami_set_cushion", { p_pct: pct });
    if (error) { toast("Save failed: " + error.message, "warn"); return; }
    _okamiCushionPct = pct;
    const topInp = document.getElementById("okami-cushion");
    if (topInp) topInp.value = pct;
    const topVal = document.getElementById("okami-cushion-val");
    if (topVal) topVal.innerHTML = `${pct}<span class="frac">%</span>`;
    const openIdx = openOkamiDetailIndex();
    if (openIdx != null) renderOkamiDailyPanel(openIdx);
    renderOkamiLive();
    toast(`Cushion set to ${pct}%`, "success");
  });
}

function openOkamiDetailIndex() {
  for (let i = 0; i < RR_OKAMI_WEEKS; i++) {
    const d = document.getElementById(`okami-detail-${i}`);
    if (d && d.classList.contains("open")) return i;
  }
  return null;
}

async function saveOkamiDaily(weekIdx, iso, routes) {
  const dspId = window.RR?.dsp?.id;
  if (!dspId) return;
  if (!_okamiStations || _okamiStations.length === 0) {
    const { data, error } = await sb.from("stations")
      .select("id, code, active")
      .eq("dsp_id", dspId)
      .eq("active", true);
    if (error) { toast("Save failed: " + error.message, "warn"); return; }
    _okamiStations = data || [];
  }
  if (_okamiStations.length === 0) {
    toast("No stations configured — add a station before setting OKAMI", "warn");
    return;
  }
  // Single-station mode: write the full value to the first station and
  // zero out the rest. Avoids the rounding drift you'd get from
  // round(routes / station_count) when station_count > 1.
  const calls = _okamiStations.map((s, idx) =>
    sb.rpc("okami_set_target", { p_date: iso, p_station_id: s.id, p_target: idx === 0 ? routes : 0 })
  );
  const results = await Promise.all(calls);
  const firstErr = results.find(r => r.error);
  if (firstErr) { toast("Save failed: " + firstErr.error.message, "warn"); return; }
  // Refresh both: the open detail panel (totals) and the 13-week list (peak day → Routes(max)).
  const openIdx = openOkamiDetailIndex();
  if (openIdx != null) renderOkamiDailyPanel(openIdx);
  renderOkamiLive();
}

// ─── Settings · Scheduling (block hours, cushion, waves) ───────────────────

async function loadSchedulingSettings() {
  const dspId = window.RR?.dsp?.id;
  if (!dspId) return;
  if (!_schedStart) _schedStart = fmtIsoDate(startOfWeekMonday(new Date()));

  const { data, error } = await sb.rpc("scheduling_settings_for_week", { p_week_start: _schedStart });
  if (error) { console.warn("scheduling settings load:", error.message); return; }
  const s = data || {};

  const blockEl  = document.getElementById("rr-set-block-hours");
  const cushEl   = document.getElementById("rr-set-cushion-pct");
  const maxDaysEl = document.getElementById("rr-set-max-days");
  const wavesEl  = document.getElementById("rr-set-waves");
  const statusEl = document.getElementById("rr-set-sched-status");

  if (blockEl)   blockEl.value   = s.default_block_hours ?? 10;
  if (cushEl)    cushEl.value    = s.cushion_pct ?? 10;
  if (maxDaysEl) maxDaysEl.value = s.max_days_per_week ?? 5;
  const overrideEl = document.getElementById("rr-set-availability-override");
  if (overrideEl) overrideEl.checked = !!s.allow_availability_override;
  // Cache the effective settings so auto-assign reads the per-week values.
  window._rrEffectiveSettings = s;
  if (wavesEl) {
    const waves = Array.isArray(s.waves) && s.waves.length ? s.waves : [{ start: "07:00" }];
    wavesEl.innerHTML = waves.map(w => _renderWaveRow(w.start)).join("");
  }
  // Cache finalized state for guard checks.
  window._rrWeekFinalized = !!s.finalized;
  _updateFinalizeButton();
  if (statusEl) {
    statusEl.style.color = "var(--text-subtle)";
    statusEl.textContent = s.is_inherited
      ? "Inherited from a previous week — Save to make this week's settings independent"
      : `Custom settings for week of ${_schedStart}`;
  }
}

function _renderWaveRow(start) {
  return `<div data-rr-wave style="display:flex;gap:6px;align-items:center">
    <input type="time" class="form-input" data-rr-wave-time value="${escapeHtml(start || "07:00")}" style="max-width:140px"/>
    <button type="button" class="btn btn-sm" data-rr-remove-wave style="color:var(--red)">Remove</button>
  </div>`;
}

document.addEventListener("click", async (e) => {
  // Add a wave row.
  if (e.target.id === "rr-set-add-wave") {
    e.preventDefault();
    const wavesEl = document.getElementById("rr-set-waves");
    if (!wavesEl) return;
    // Suggest the next slot 25 min after the last wave.
    const lastInput = wavesEl.querySelector("[data-rr-wave]:last-child [data-rr-wave-time]");
    let next = "07:00";
    if (lastInput?.value) {
      const [h, m] = lastInput.value.split(":").map(n => parseInt(n, 10));
      const total = h * 60 + m + 25;
      next = `${String(Math.floor(total / 60) % 24).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
    }
    wavesEl.insertAdjacentHTML("beforeend", _renderWaveRow(next));
    return;
  }

  // Remove a wave row.
  if (e.target.matches?.("[data-rr-remove-wave]")) {
    e.preventDefault();
    const row = e.target.closest("[data-rr-wave]");
    if (row) row.remove();
    return;
  }

  // Save scheduling settings.
  if (e.target.id === "rr-set-sched-save") {
    e.preventDefault();
    const dspId = window.RR?.dsp?.id;
    if (!dspId) return;
    if (!_schedStart) _schedStart = fmtIsoDate(startOfWeekMonday(new Date()));

    const block = parseInt(document.getElementById("rr-set-block-hours")?.value, 10) || 10;
    const cushion = parseInt(document.getElementById("rr-set-cushion-pct")?.value, 10) || 0;
    const maxDays = Math.max(1, Math.min(7, parseInt(document.getElementById("rr-set-max-days")?.value, 10) || 5));
    const allowOverride = !!document.getElementById("rr-set-availability-override")?.checked;
    const waves = Array.from(document.querySelectorAll("#rr-set-waves [data-rr-wave-time]"))
      .map(inp => ({ start: inp.value || "07:00" }))
      .filter(w => w.start);
    if (waves.length === 0) waves.push({ start: "07:00" });
    const tz = (Intl?.DateTimeFormat?.().resolvedOptions().timeZone) || "UTC";

    const status = document.getElementById("rr-set-sched-status");
    if (status) { status.style.color = "var(--text-subtle)"; status.textContent = "Saving for week…"; }

    const { error: upErr } = await sb.rpc("upsert_scheduling_settings", {
      p_payload: {
        week_start: _schedStart,
        default_block_hours: block,
        cushion_pct: cushion,
        max_days_per_week: maxDays,
        allow_availability_override: allowOverride,
        waves,
        timezone: tz,
      },
    });
    if (upErr) {
      if (status) { status.style.color = "var(--red)"; status.textContent = "Failed: " + upErr.message; }
      return;
    }
    if (status) status.textContent = "Saved · syncing this week…";

    const { error: regenErr } = await sb.rpc("regenerate_week_shifts", { p_week_start: _schedStart });
    if (regenErr) {
      if (status) { status.style.color = "var(--red)"; status.textContent = "Saved · sync failed: " + regenErr.message; }
      toast("Settings saved · sync failed: " + regenErr.message, "warn");
      return;
    }

    if (status) {
      status.style.color = "var(--green)";
      status.textContent = `Saved for week of ${_schedStart} ✓`;
    }
    setTimeout(() => { if (status) status.textContent = ""; }, 3000);
    toast("Scheduling settings saved for this week", "success");

    // Refresh schedule view if active.
    if (typeof renderScheduleWeek === "function") {
      const sub = document.getElementById("sched-sub-week");
      if (sub) renderScheduleWeek();
    }
    // Reload settings panel so the inheritance hint updates.
    loadSchedulingSettings();
    return;
  }
});

// ─── Schedule · Finalize-and-push + live-edit guard ────────────────────

function _updateFinalizeButton() {
  const btn = document.getElementById("schedule-cta");
  if (!btn) return;
  const isFinal = !!window._rrWeekFinalized;
  btn.innerHTML = isFinal
    ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Live · Unfinalize`
    : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg> Finalize &amp; push to drivers`;
  btn.style.background = isFinal ? "var(--green)" : "";
  btn.style.borderColor = isFinal ? "var(--green)" : "";
  btn.title = isFinal ? "This week is live · drivers see it" : "Push this week's schedule to drivers";
}

async function _setWeekFinalized(target) {
  const dspId = window.RR?.dsp?.id;
  if (!dspId || !_schedStart) return;
  const { error } = await sb.rpc("set_schedule_finalized", { p_week_start: _schedStart, p_finalized: target });
  if (error) { toast("Failed: " + error.message, "warn"); return; }
  window._rrWeekFinalized = target;
  _updateFinalizeButton();
  toast(target ? "Schedule finalized · drivers can see it" : "Unfinalized · back to draft", "success");
}

// Returns true if the operator confirms editing a live schedule. Always true
// when the week isn't finalized.
function _confirmLiveScheduleEdit() {
  if (!window._rrWeekFinalized) return true;
  return confirm("This week's schedule is LIVE — drivers may have already seen it.\n\nMake the change anyway?");
}

document.addEventListener("click", async (e) => {
  if (e.target.closest("#schedule-cta")) {
    e.preventDefault();
    const target = !window._rrWeekFinalized;
    if (target) {
      if (!confirm("Finalize this week and mark it as live for drivers? Edits after this will trigger a warning prompt.")) return;
    }
    await _setWeekFinalized(target);
  }
});

async function loadScheduleView() {
  // Force-clear the mockup HTML the moment the view opens so static
  // rows like 'Marcus Davidson' / 'Tasha Reyes' can't flash through
  // while the live render is in flight.
  _clearScheduleMockup();
  loadTimeOffList();
  loadOpenShifts();
  await renderScheduleWeek();
  bindSchedWeekNav();
  loadSchedulingSettings();
}

function _clearScheduleMockup() {
  // Neutralize the mockup OKAMI day-shifts injector — it runs 50ms after
  // view switch and stamps 'ø XX shifts' onto every cell head, undoing
  // our live render.
  if (typeof window !== "undefined") {
    window.okamiRenderScheduleDayHeaders = function () {};
  }
  const sub = document.getElementById("sched-sub-week");
  if (!sub) return;
  const wrap = sub.querySelector(".cal-wrap");
  if (wrap) {
    Array.from(wrap.children).forEach(el => {
      if (!el.classList.contains("head")) el.remove();
    });
    // Strip any leftover .day-shifts spans on heads.
    wrap.querySelectorAll(".cal-cell-head .day-shifts").forEach(el => el.remove());
  }
  const aside = sub.querySelector("aside.driver-pool");
  if (aside) {
    Array.from(aside.children).forEach(el => {
      if (!el.classList.contains("pool-head") && el.tagName !== "INPUT") el.remove();
    });
  }
  // Remove the dynamically-injected mockup license banner if present.
  const lic = document.getElementById("sched-license-banner");
  if (lic) lic.remove();
}

// Override the mockup AI-schedule modal — replace with a real auto-fill that
// creates open shifts wherever OKAMI demand exceeds current shift count.
window.openAiSchedule = async function () {
  await autoFillScheduleWeek();
};

async function autoFillScheduleWeek() {
  const dspId = window.RR?.dsp?.id;
  if (!dspId) { toast("DSP not loaded", "warn"); return; }
  if (!_schedStart) _schedStart = fmtIsoDate(startOfWeekMonday(new Date()));
  if (!_confirmLiveScheduleEdit()) return;

  // Use generate_shifts_for_date instead of raw create_shift — this both
  // FILLS gaps and TRIMS excess, so the schedule mirrors OKAMI exactly
  // and any drifted-up counts get cleaned up.
  const { data: cells, error } = await sb.rpc("okami_grid", { p_start: _schedStart, p_weeks: 1 });
  if (error) { toast("Sync failed: " + error.message, "warn"); return; }

  const dateStations = new Map();
  for (const c of (cells || [])) {
    if (!c.station_id) continue;
    dateStations.set(`${c.date}|${c.station_id}`, { date: c.date, station_id: c.station_id });
  }
  if (dateStations.size === 0) { toast("No OKAMI demand for this week", "warn"); return; }

  const calls = Array.from(dateStations.values()).map(d =>
    sb.rpc("generate_shifts_for_date", { p_date: d.date, p_station_id: d.station_id })
  );

  const results = await Promise.all(calls);
  const failed = results.filter(r => r.error);
  if (failed.length === calls.length) {
    toast("Sync failed: " + (failed[0].error?.message || "unknown error"), "warn");
    return;
  }
  if (failed.length > 0) {
    toast(`Synced ${calls.length - failed.length} of ${calls.length} day-stations · ${failed.length} failed`, "warn");
  } else {
    // Now try to auto-assign drivers to the freshly-generated open shifts
    // based on each driver's availability metadata.
    const assigned = await autoAssignDriversForWeek();
    if (assigned > 0) {
      toast(`Schedule synced · ${assigned} shift${assigned === 1 ? "" : "s"} auto-assigned`, "success");
    } else {
      toast("Schedule synced with OKAMI plan", "success");
    }
  }
  await renderScheduleWeek();
}

// Auto-assign drivers to open shifts in the current week based on each
// driver's metadata.availability.days (mon/tue/wed/...). Skips drivers who
// are on approved PTO that day or already have a shift on that date.
// Picks the least-loaded eligible driver each round so workload spreads.
async function autoAssignDriversForWeek() {
  const dspId = window.RR?.dsp?.id;
  if (!dspId || !_schedStart) return 0;

  const weekEnd = addDays(new Date(_schedStart + "T12:00:00"), 6);
  const weekEndIso = fmtIsoDate(weekEnd);

  // Read the per-week settings (max days + override) so the cap and
  // override flag come from the visible week, not stale DSP metadata.
  let maxDays = 5;
  let allowOverride = false;
  try {
    const { data: ws } = await sb.rpc("scheduling_settings_for_week", { p_week_start: _schedStart });
    if (ws) {
      maxDays = Math.max(1, Math.min(7, ws.max_days_per_week ?? 5));
      allowOverride = !!ws.allow_availability_override;
    }
  } catch (_) { /* fall back to defaults */ }

  // Query shifts directly (instead of via schedule_grid) so we always get
  // the is_cushion column even on DBs that haven't run migration 0027.
  const [driversRes, ptoRes, shiftsRes] = await Promise.all([
    sb.from("drivers")
      .select("id, full_name, metadata")
      .eq("dsp_id", dspId)
      .eq("status", "active"),
    sb.from("time_off_requests")
      .select("driver_id, start_date, end_date")
      .eq("dsp_id", dspId)
      .eq("status", "approved")
      .lte("start_date", weekEndIso)
      .gte("end_date", _schedStart),
    sb.from("shifts")
      .select("id, date, station_id, driver_id, status, starts_at, ends_at, is_cushion")
      .eq("dsp_id", dspId)
      .gte("date", _schedStart)
      .lte("date", weekEndIso),
  ]);

  if (driversRes.error || shiftsRes.error) {
    console.warn("auto-assign load failed:", driversRes.error || shiftsRes.error);
    return 0;
  }

  const drivers = driversRes.data || [];
  const pto     = ptoRes.data     || [];
  let   shifts  = shiftsRes.data  || [];

  // Aggressive reset: unassign EVERY driver from EVERY shift so the
  // priority sort (regular → cushion) runs from a clean slate. Anything
  // good will be re-assigned identically in the loop below; anything
  // misplaced gets re-prioritized.
  const allAssigned = shifts.filter(sh => sh.driver_id && sh.status === "scheduled");
  if (allAssigned.length > 0) {
    const ids = allAssigned.map(sh => sh.id);
    const { error: clearErr } = await sb.from("shifts")
      .update({ driver_id: null })
      .in("id", ids);
    if (clearErr) {
      console.warn("auto-assign clear failed:", clearErr);
    } else {
      const cleared = new Set(ids);
      shifts = shifts.map(sh => cleared.has(sh.id) ? { ...sh, driver_id: null } : sh);
    }
  }

  const DOW = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

  // Per-driver: dates already booked (so we don't double-assign one driver
  // to two shifts on the same day).
  const driverShiftDates = new Map();
  for (const sh of shifts) {
    if (!sh.driver_id) continue;
    if (!driverShiftDates.has(sh.driver_id)) driverShiftDates.set(sh.driver_id, new Set());
    driverShiftDates.get(sh.driver_id).add(sh.date);
  }

  // PTO map: driver_id -> Set<iso>.
  const driverPtoDates = new Map();
  for (const t of pto) {
    if (!driverPtoDates.has(t.driver_id)) driverPtoDates.set(t.driver_id, new Set());
    let cur = new Date(t.start_date + "T12:00:00");
    const end = new Date(t.end_date + "T12:00:00");
    while (cur <= end) {
      driverPtoDates.get(t.driver_id).add(fmtIsoDate(cur));
      cur = addDays(cur, 1);
    }
  }

  // Sort: date asc → regular shifts before cushion (extras) → starts_at asc.
  // Default rule per the operator: fill non-cushion before EX shifts so the
  // buffer only gets a driver after all the planned routes are covered.
  const openShifts = shifts.filter(sh => !sh.driver_id && sh.status === "scheduled")
    .sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      const ac = a.is_cushion ? 1 : 0;
      const bc = b.is_cushion ? 1 : 0;
      if (ac !== bc) return ac - bc;
      return (a.starts_at || "").localeCompare(b.starts_at || "");
    });

  let assigned = 0;
  for (const sh of openShifts) {
    const dt = new Date(sh.date + "T12:00:00");
    const dow = DOW[dt.getDay()];

    // Try strict-availability candidates first; if override is allowed
    // and none match, fall through to "any active non-PTO driver".
    const baseFilter = (d) => {
      if (driverPtoDates.get(d.id)?.has(sh.date)) return false;
      if (driverShiftDates.get(d.id)?.has(sh.date)) return false;
      if ((driverShiftDates.get(d.id)?.size || 0) >= maxDays) return false;
      return true;
    };
    let candidates = drivers.filter(d => {
      const days = (d.metadata?.availability?.days) || [];
      if (!days.includes(dow)) return false;
      return baseFilter(d);
    });
    if (candidates.length === 0 && allowOverride) {
      candidates = drivers.filter(baseFilter);
    }


    if (candidates.length === 0) continue;

    candidates.sort((a, b) => {
      const ac = driverShiftDates.get(a.id)?.size || 0;
      const bc = driverShiftDates.get(b.id)?.size || 0;
      return ac - bc;
    });
    const driver = candidates[0];

    const { error } = await sb.rpc("assign_shift", { p_id: sh.id, p_driver_id: driver.id });
    if (error) continue;

    if (!driverShiftDates.has(driver.id)) driverShiftDates.set(driver.id, new Set());
    driverShiftDates.get(driver.id).add(sh.date);
    assigned += 1;
  }

  return assigned;
}

function renderScheduleGrid() { /* removed */ }

// ─── Schedule · Week view (read-only render) ───────────────────────────────

function fmtTimeShort(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }).toLowerCase().replace(" ", "");
  } catch { return ""; }
}

// Format a 'HH:MM' wave-time string as e.g. '1:00pm'. Used when we don't
// have a full timestamp — only a configured wave start.
function fmtWaveTime(hhmm) {
  if (!hhmm) return "";
  const parts = String(hhmm).split(":");
  const h = parseInt(parts[0], 10);
  const m = parts.length > 1 ? parseInt(parts[1], 10) : 0;
  if (!Number.isFinite(h)) return hhmm;
  const hour12 = h === 0 ? 12 : (h > 12 ? h - 12 : h);
  const ampm = h >= 12 ? "pm" : "am";
  return `${hour12}:${String(m || 0).padStart(2, "0")}${ampm}`;
}

// Add `hours` to an 'HH:MM' string, returning the new 'HH:MM'. Wraps midnight.
function addHoursToWaveTime(hhmm, hours) {
  if (!hhmm) return "";
  const parts = String(hhmm).split(":");
  const h = parseInt(parts[0], 10);
  const m = parts.length > 1 ? parseInt(parts[1], 10) : 0;
  if (!Number.isFinite(h)) return hhmm;
  const total = (h * 60 + m + (hours || 0) * 60 + 24 * 60) % (24 * 60);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function _schedShiftChip(sh) {
  const r = sh.route_code ? escapeHtml(sh.route_code) : (sh.starts_at ? fmtTimeShort(sh.starts_at) : "shift");
  const time = (sh.starts_at && sh.ends_at) ? `${fmtTimeShort(sh.starts_at)} – ${fmtTimeShort(sh.ends_at)}` : "";
  const ex = sh.is_cushion
    ? `<span style="display:inline-block;background:#FEF3C7;color:#92400E;font-size:9px;font-weight:700;padding:0 4px;border-radius:3px;margin-left:4px;letter-spacing:.04em">EX</span>`
    : "";
  const baseStyle = sh.is_cushion ? 'border-color:#FCD34D;' : '';
  return `<div class="shift-chip" data-rr-shift-id="${sh.id}" style="${baseStyle}cursor:pointer" title="Click to remove shift"><div class="shift-chip-route">${r}${ex}</div>${time ? `<div class="shift-chip-time">${time}</div>` : ""}</div>`;
}

function _schedDriverInitials(name) {
  return (name || "").split(/\s+/).map(p => p[0]).filter(Boolean).slice(0, 2).join("").toUpperCase() || "?";
}

async function renderScheduleWeek() {
  const sub = document.getElementById("sched-sub-week");
  if (!sub) return;
  const dspId = window.RR?.dsp?.id;
  if (!dspId) return;

  if (!_schedStart) _schedStart = fmtIsoDate(startOfWeekMonday(new Date()));
  const weekStart = new Date(_schedStart + "T12:00:00");
  const weekEnd   = addDays(weekStart, 6);
  const weekEndIso = fmtIsoDate(weekEnd);
  const todayIso  = fmtIsoDate(new Date());

  const [gridRes, driversRes, toRes] = await Promise.all([
    sb.rpc("schedule_grid", { p_start: _schedStart, p_weeks: 1 }),
    sb.from("drivers")
      .select("id, full_name, first_name, last_name, preferred_name, status, station_id, hire_date, tier, metadata, station:station_id (code)")
      .eq("dsp_id", dspId)
      .eq("status", "active")
      .order("full_name"),
    sb.from("time_off_requests")
      .select("id, driver_id, start_date, end_date, status")
      .eq("dsp_id", dspId)
      .eq("status", "approved")
      .lte("start_date", weekEndIso)
      .gte("end_date", _schedStart),
  ]);

  if (gridRes.error)    { console.warn("schedule_grid:", gridRes.error.message); return; }
  if (driversRes.error) { console.warn("drivers load:", driversRes.error.message); return; }
  if (toRes.error)      { console.warn("time_off load:", toRes.error.message); return; }

  const grid    = gridRes.data    || { coverage: [], shifts: [] };
  const drivers = driversRes.data || [];
  const timeOff = toRes.data      || [];

  _schedDriverList = drivers; // existing add-shift modal reads this list

  // Index shifts by driver/date and collect open shifts by date.
  const shiftsByDriverDate = new Map();
  const openShiftsByDate = new Map();
  const hoursPerDriver = new Map(); // driver_id -> total HOURS this week
  const shiftCountPerDriver = new Map(); // driver_id -> shift count (for least-loaded sort)
  const _shiftHours = (sh) => {
    if (sh.starts_at && sh.ends_at) {
      const h = (new Date(sh.ends_at) - new Date(sh.starts_at)) / 3600000;
      if (h > 0 && h <= 24) return h;
    }
    return Number(sh.block_hours) || 10;
  };
  for (const sh of (grid.shifts || [])) {
    if (sh.driver_id) {
      const k = `${sh.driver_id}|${sh.date}`;
      if (!shiftsByDriverDate.has(k)) shiftsByDriverDate.set(k, []);
      shiftsByDriverDate.get(k).push(sh);
      hoursPerDriver.set(sh.driver_id, (hoursPerDriver.get(sh.driver_id) || 0) + _shiftHours(sh));
      shiftCountPerDriver.set(sh.driver_id, (shiftCountPerDriver.get(sh.driver_id) || 0) + 1);
    } else {
      if (!openShiftsByDate.has(sh.date)) openShiftsByDate.set(sh.date, []);
      openShiftsByDate.get(sh.date).push(sh);
    }
  }

  // Index PTO by driver.
  const ptoByDriver = new Map();
  for (const t of timeOff) {
    if (!ptoByDriver.has(t.driver_id)) ptoByDriver.set(t.driver_id, []);
    ptoByDriver.get(t.driver_id).push(t);
  }
  const ptoOn = (driverId, iso) => (ptoByDriver.get(driverId) || []).some(t => iso >= t.start_date && iso <= t.end_date);

  // Coverage rolled up by date.
  // needed comes from okami_grid (source of truth). filled is computed
  // CLIENT-SIDE from shifts assigned to drivers we actually render
  // (status='active'); the server's grid.filled also counts shifts
  // assigned to inactive / terminated drivers that don't appear in the
  // grid, which made coverage display ghost-filled cells.
  const visibleDriverIds = new Set(drivers.map(d => d.id));
  const coverageByDate = new Map();
  for (const c of (grid.coverage || [])) {
    const a = coverageByDate.get(c.date) || { needed: 0, filled: 0 };
    a.needed += (c.needed || 0);
    coverageByDate.set(c.date, a);
  }
  for (const sh of (grid.shifts || [])) {
    if (!sh.driver_id) continue;
    if (!visibleDriverIds.has(sh.driver_id)) continue;
    if (!["scheduled", "completed"].includes(sh.status)) continue;
    const a = coverageByDate.get(sh.date) || { needed: 0, filled: 0 };
    a.filled += 1;
    coverageByDate.set(sh.date, a);
  }
  let totalNeeded = 0, totalFilled = 0;
  for (const a of coverageByDate.values()) { totalNeeded += a.needed; totalFilled += a.filled; }
  const pct = totalNeeded ? Math.round(totalFilled / totalNeeded * 100) : 0;

  // Virtual open shifts: for each (date, station), needed − filled minus
  // any real unassigned shift rows already in the DB. Filled here only
  // counts shifts assigned to VISIBLE active drivers (matches the
  // coverage-strip math), so orphan shifts assigned to inactive drivers
  // don't suppress legitimate virtual open chips.
  const realOpenByDateStation = new Map();
  const visibleFilledByDateStation = new Map();
  for (const sh of (grid.shifts || [])) {
    const k = `${sh.date}|${sh.station_id}`;
    if (!sh.driver_id) {
      realOpenByDateStation.set(k, (realOpenByDateStation.get(k) || 0) + 1);
    } else if (visibleDriverIds.has(sh.driver_id) && ["scheduled", "completed"].includes(sh.status)) {
      visibleFilledByDateStation.set(k, (visibleFilledByDateStation.get(k) || 0) + 1);
    }
  }
  // Virtual chips get the wave time at their position in the day's lineup.
  // Single-wave config → every virtual chip shows the same wave time.
  const wavesArr = (window.RR?.dsp?.metadata?.scheduling?.waves) || [{ start: "07:00" }];
  const waveCount = Math.max(1, wavesArr.length);
  const virtualByDate = new Map();
  for (const c of (grid.coverage || [])) {
    const k = `${c.date}|${c.station_id}`;
    const real = realOpenByDateStation.get(k) || 0;
    const filled = visibleFilledByDateStation.get(k) || 0;
    const v = Math.max(0, (c.needed || 0) - filled - real);
    if (v > 0) {
      const list = virtualByDate.get(c.date) || [];
      const startPos = (filled + real);
      for (let i = 0; i < v; i++) {
        const pos = startPos + i;
        const waveStart = wavesArr[pos % waveCount]?.start || "07:00";
        list.push({ station_id: c.station_id, station_code: c.station_code, wave_start: waveStart });
      }
      virtualByDate.set(c.date, list);
    }
  }
  let totalVirtual = 0;
  for (const list of virtualByDate.values()) totalVirtual += list.length;

  // ── Toolbar
  const labelEl = sub.querySelector(".sched-week-label");
  if (labelEl) {
    labelEl.textContent = `${weekStart.toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${weekEnd.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;
  }
  const subLineEl = sub.querySelector(".sched-week-sub");
  if (subLineEl) {
    subLineEl.innerHTML = `<span style="color:var(--accent-text);cursor:pointer" data-rr-goto-okami>Adjust in OKAMI →</span>`;
  }

  // Page-sub line in the header (Schedule view) — replace the mockup
  // 'Week of May 1–7 · 78 drivers · ...' with live numbers.
  const pageSub = document.getElementById("rr-sched-page-sub");
  if (pageSub) {
    const wkRange = `${weekStart.toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${weekEnd.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
    pageSub.textContent = `Week of ${wkRange} · ${drivers.length} active driver${drivers.length === 1 ? "" : "s"}`;
  }

  // ── KPI strip (hours, coverage, open shifts, violations) + per-day status
  // computed from the same data as the grid below.
  const days = Array.from({ length: 7 }, (_, i) => fmtIsoDate(addDays(weekStart, i)));
  const totalHoursWeek = Array.from(hoursPerDriver.values()).reduce((s, n) => s + n, 0);
  // Real open shifts (unassigned scheduled rows) — sum across all dates.
  let totalRealOpen = 0;
  for (const list of openShiftsByDate.values()) totalRealOpen += list.length;
  const totalAllOpen = totalRealOpen + totalVirtual;
  // Per-day fill: needed (from coverageByDate), filled (visible-driver shifts).
  const fillByDate = new Map();
  for (const iso of days) {
    const c = coverageByDate.get(iso) || { needed: 0, filled: 0 };
    fillByDate.set(iso, c);
  }
  // Overtime hours per driver: hours-scheduled-this-week beyond 40, billed
  // at time-and-a-half. Pay rate comes from drivers.metadata.pay.hourly_rate.
  let totalOvertimeHrs = 0;
  let estimatedOvertimeCost = 0;
  for (const d of drivers) {
    const hrs = hoursPerDriver.get(d.id) || 0;
    const ot  = Math.max(0, hrs - 40);
    if (ot <= 0) continue;
    totalOvertimeHrs += ot;
    const rate = Number(d.metadata?.pay?.hourly_rate) || 0;
    estimatedOvertimeCost += ot * rate * 1.5;
  }

  // Rule violations across assigned shifts in the week (now includes WOC).
  const violations = await _computeWeekViolations(grid.shifts || [], drivers, timeOff, _schedStart, fmtIsoDate(weekEnd));

  let kpis = sub.querySelector("#rr-sched-kpis");
  if (!kpis) {
    kpis = document.createElement("div");
    kpis.id = "rr-sched-kpis";
    kpis.style.cssText = "display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:8px;margin-bottom:var(--s-3)";
    const toolbar = sub.querySelector(".sched-toolbar");
    if (toolbar) toolbar.insertAdjacentElement("afterend", kpis);
  } else {
    kpis.style.gridTemplateColumns = "repeat(5,minmax(0,1fr))";
  }
  const kpiCard = (label, value, sublabel, tone) => {
    const c = tone === "bad" ? "var(--red)" : tone === "warn" ? "var(--amber)" : tone === "ok" ? "var(--green)" : "var(--text)";
    return `<div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:10px 12px">
      <div style="font-size:10px;font-weight:600;color:var(--text-muted);letter-spacing:.06em;text-transform:uppercase">${label}</div>
      <div style="font-size:18px;font-weight:700;color:${c};letter-spacing:-.02em;margin-top:2px;line-height:1.2">${value}</div>
      <div style="font-size:11px;color:var(--text-subtle);margin-top:1px">${sublabel}</div>
    </div>`;
  };
  const coverageTone = pct >= 100 ? "ok" : pct >= 90 ? "warn" : "bad";
  const violationsTone = violations.length === 0 ? "ok" : violations.length <= 3 ? "warn" : "bad";
  const otTone = totalOvertimeHrs === 0 ? "ok" : totalOvertimeHrs <= 10 ? "warn" : "bad";
  const otValue = totalOvertimeHrs === 0 ? "0h" : `${Math.round(totalOvertimeHrs * 10) / 10}h`;
  const otSub = totalOvertimeHrs === 0
    ? "no OT"
    : (estimatedOvertimeCost > 0 ? `~$${Math.round(estimatedOvertimeCost).toLocaleString()} @ 1.5×` : "above 40h/week");
  kpis.innerHTML =
    kpiCard("Hours scheduled", `${Math.round(totalHoursWeek)}h`, `${shiftCountPerDriver.size} driver${shiftCountPerDriver.size === 1 ? "" : "s"}`, "default") +
    kpiCard("Overtime", otValue, otSub, otTone) +
    kpiCard("Coverage", `${pct}%`, `${totalFilled} / ${totalNeeded} shifts`, coverageTone) +
    kpiCard("Open shifts", String(totalAllOpen), totalAllOpen === 0 ? "fully covered" : "drivers needed", totalAllOpen === 0 ? "ok" : "warn") +
    kpiCard("Rule violations", String(violations.length), violations.length === 0 ? "all clear" : "click to review", violationsTone);
  kpis.dataset.rrViolations = JSON.stringify(violations);

  // ── Day headers (skip first cell which is "Driver")
  const headRow = sub.querySelector(".cal-grid.head");
  if (headRow) {
    const heads = headRow.querySelectorAll(".cal-cell-head");
    for (let i = 0; i < 7; i++) {
      const cellHead = heads[i + 1];
      if (!cellHead) break;
      const dt = addDays(weekStart, i);
      const iso = fmtIsoDate(dt);
      const c = fillByDate.get(iso) || { needed: 0, filled: 0 };
      cellHead.classList.toggle("today", iso === todayIso);
      let status = "";
      if (c.needed > 0) {
        if (c.filled >= c.needed) {
          status = `<div style="font-size:10px;font-weight:600;color:var(--green);margin-top:2px">✓ Complete</div>`;
        } else {
          const tone = c.filled === 0 ? "var(--red)" : "var(--amber)";
          status = `<div style="font-size:10px;font-weight:600;color:${tone};margin-top:2px">${c.filled} / ${c.needed}</div>`;
        }
      }
      cellHead.innerHTML = `${RR_DAY_SHORT[dt.getDay()]}<span class="day-num">${dt.getDate()}</span>${status}`;
    }
  }

  // ── Driver rows + Unassigned + Coverage strip
  const wrap = sub.querySelector(".cal-wrap");
  if (!wrap) return;
  Array.from(wrap.children).forEach(el => {
    if (!el.classList.contains("head")) el.remove();
  });

  const driverRowsHtml = drivers.map(d => {
    const initials = displayDriverInitials(d);
    const display = displayDriverName(d);
    const tier = d.tier ? `tier-${String(d.tier).toLowerCase()}` : "tier-c";
    const station = d.station?.code || "—";
    const tenure = d.hire_date ? tenureLabel(d.hire_date) : "—";
    const totalHours = hoursPerDriver.get(d.id) || 0;
    const shiftCount = shiftCountPerDriver.get(d.id) || 0;
    const hoursLabel = totalHours > 0
      ? `${Math.round(totalHours * 10) / 10}h scheduled · ${shiftCount} shift${shiftCount === 1 ? "" : "s"}`
      : "0h scheduled";
    const cells = days.map(iso => {
      const cls = `cal-cell${iso === todayIso ? " today" : ""}`;
      const data = `data-rr-cell="driver-day" data-rr-cell-date="${iso}" data-rr-cell-driver="${d.id}"${d.station_id ? ` data-rr-cell-station="${d.station_id}"` : ""}`;
      if (ptoOn(d.id, iso))
        return `<div class="${cls}" ${data}><div class="shift-chip timeoff"><div class="shift-chip-route">PTO</div></div></div>`;
      const list = shiftsByDriverDate.get(`${d.id}|${iso}`) || [];
      if (list.length === 0)
        return `<div class="${cls}" ${data}><div class="shift-chip off">Off</div></div>`;
      return `<div class="${cls}" ${data}>${list.map(_schedShiftChip).join("")}</div>`;
    }).join("");
    return `<div class="cal-grid">
      <div class="cal-row-label"><div class="avatar-sm ${tier}">${initials}</div><div><div class="cal-row-label-name">${escapeHtml(display)}</div><div class="cal-row-label-meta">${escapeHtml(station)} · ${escapeHtml(tenure)} · ${escapeHtml(hoursLabel)}</div></div></div>
      ${cells}
    </div>`;
  }).join("");

  // Unassigned slots → one row per Potential Driver (PD). Total PD rows
  // equal the peak unfilled day across the week. For each PD row r, each
  // day cell shows an open chip if that day still has unfilled demand at
  // slot index r — real open shifts first, then virtual chips computed
  // from OKAMI demand.
  const stationCodeById = new Map();
  for (const c of (grid.coverage || [])) {
    if (c.station_id) stationCodeById.set(c.station_id, c.station_code);
  }
  const openSlotsByDate = new Map();
  for (const iso of days) {
    const slots = [];
    for (const sh of (openShiftsByDate.get(iso) || [])) {
      slots.push({
        kind: "real",
        shift_id: sh.id,
        route_code: sh.route_code,
        station_code: stationCodeById.get(sh.station_id) || "open",
        starts_at: sh.starts_at,
        ends_at: sh.ends_at,
        is_cushion: sh.is_cushion,
      });
    }
    for (const v of (virtualByDate.get(iso) || [])) {
      slots.push({ kind: "virtual", station_id: v.station_id, station_code: v.station_code, wave_start: v.wave_start });
    }
    openSlotsByDate.set(iso, slots);
  }
  let peakUnfilled = 0;
  for (const slots of openSlotsByDate.values()) {
    if (slots.length > peakUnfilled) peakUnfilled = slots.length;
  }

  const pdRowsHtml = peakUnfilled === 0 ? "" : Array.from({ length: peakUnfilled }, (_, r) => {
    const cells = days.map(iso => {
      const cls = `cal-cell${iso === todayIso ? " today" : ""}`;
      const slots = openSlotsByDate.get(iso) || [];
      if (r >= slots.length) return `<div class="${cls}"><div class="shift-chip off"></div></div>`;
      const slot = slots[r];
      const data = `data-rr-cell="open" data-rr-cell-date="${iso}"`;
      if (slot.kind === "real") {
        const startLbl = slot.starts_at ? fmtTimeShort(slot.starts_at) : "";
        const endLbl   = slot.ends_at   ? fmtTimeShort(slot.ends_at)   : "";
        const label = startLbl && endLbl ? `${startLbl} – ${endLbl}` : (startLbl || slot.route_code || "open");
        const ex = slot.is_cushion
          ? `<span style="display:inline-block;background:#FEF3C7;color:#92400E;font-size:9px;font-weight:700;padding:0 4px;border-radius:3px;margin-left:4px;letter-spacing:.04em">EX</span>`
          : "";
        const style = slot.is_cushion ? ' style="border-color:#FCD34D"' : "";
        return `<div class="${cls}" ${data}><div class="shift-chip open" data-rr-shift-id="${slot.shift_id}"${style}>+ ${escapeHtml(label)}${ex}</div></div>`;
      }
      const blockH = window.RR?.dsp?.metadata?.scheduling?.default_block_hours || 10;
      const vStart = fmtWaveTime(slot.wave_start);
      const vEnd   = fmtWaveTime(addHoursToWaveTime(slot.wave_start, blockH));
      const virtLabel = vStart && vEnd ? `${vStart} – ${vEnd}` : (vStart || "open");
      return `<div class="${cls}" ${data}><div class="shift-chip open" data-rr-virtual-station="${slot.station_id}" style="opacity:.65;border-style:dashed" title="From OKAMI demand · drag a driver to fill">+ ${escapeHtml(virtLabel)}</div></div>`;
    }).join("");
    const pdNum = r + 1;
    return `<div class="cal-grid" style="background:var(--canvas)">
      <div class="cal-row-label" style="background:var(--canvas)">
        <div class="avatar-sm" style="background:var(--canvas);color:var(--text-subtle);border:1.5px dashed var(--border-strong);font-weight:700;font-size:11px">PD</div>
        <div><div class="cal-row-label-name" style="color:var(--text-muted)">PD ${pdNum}</div><div class="cal-row-label-meta">Potential driver slot</div></div>
      </div>
      ${cells}
    </div>`;
  }).join("");

  // Coverage strip.
  const covCellCls = (filled, needed) => {
    if (needed === 0) return "coverage-cell full";
    if (filled >= needed) return "coverage-cell full";
    if (filled >= needed * 0.95) return "coverage-cell partial";
    return "coverage-cell gap";
  };
  const coverageStripHtml = `<div class="coverage-strip">
    <div class="coverage-cell">Coverage</div>
    ${days.map(iso => { const a = coverageByDate.get(iso) || { needed: 0, filled: 0 }; return `<div class="${covCellCls(a.filled, a.needed)}">${a.filled} / ${a.needed}</div>`; }).join("")}
  </div>`;

  const emptyHtml = drivers.length === 0
    ? `<div style="padding:32px;text-align:center;color:var(--text-subtle);font-size:13px">No active drivers yet. <span style="color:var(--accent-text);cursor:pointer" data-rr-goto-drivers>Add drivers →</span></div>`
    : "";

  // PD rows removed — Open Shifts pool on the right covers the same need
  // without taking grid real estate. Coverage strip stays.
  wrap.insertAdjacentHTML("beforeend", driverRowsHtml + coverageStripHtml + emptyHtml);

  // Strip mockup-injected banners that reference fake RR_DRIVERS data.
  const lic = document.getElementById("sched-license-banner");
  if (lic) lic.remove();

  renderSchedOpenShiftsPool(sub, grid.shifts || [], drivers, hoursPerDriver, shiftCountPerDriver, ptoByDriver);
}

let _poolSortMode = "day"; // 'day' | 'wave'

function renderSchedOpenShiftsPool(sub, allShifts, drivers, hoursPerDriver, shiftCountPerDriver, ptoByDriver) {
  const aside = sub.querySelector("aside.driver-pool");
  if (!aside) return;

  // Open shifts = unassigned scheduled shifts in the visible week.
  const openShifts = (allShifts || []).filter(sh => !sh.driver_id && sh.status === "scheduled");
  const sorted = [...openShifts].sort((a, b) => {
    if (_poolSortMode === "wave") {
      const at = (a.starts_at || "").slice(11, 16);
      const bt = (b.starts_at || "").slice(11, 16);
      if (at !== bt) return at < bt ? -1 : 1;
      return a.date < b.date ? -1 : 1;
    }
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return (a.starts_at || "").localeCompare(b.starts_at || "");
  });

  const dayLabel = (iso) => {
    const d = new Date(iso + "T12:00:00");
    return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  };

  const shiftItem = (sh, opts) => {
    const showDayLabel = !opts || opts.includeDay !== false;
    const time = (sh.starts_at && sh.ends_at) ? `${fmtTimeShort(sh.starts_at)} – ${fmtTimeShort(sh.ends_at)}` : "";
    const ex = sh.is_cushion
      ? `<span style="display:inline-block;background:#FEF3C7;color:#92400E;font-size:9px;font-weight:700;padding:0 4px;border-radius:3px;margin-left:6px;letter-spacing:.04em">EX</span>`
      : "";
    const route = sh.route_code ? `<span style="font-weight:600">${escapeHtml(sh.route_code)}</span>` : "";
    const headLine = showDayLabel
      ? `<div style="font-size:12px;font-weight:600;color:var(--text)">${dayLabel(sh.date)}${ex}</div>
         <div style="font-size:11px;color:var(--text-subtle);font-variant-numeric:tabular-nums">${time}${route ? ` · ${route}` : ""}</div>`
      : `<div style="font-size:12px;font-weight:600;color:var(--text);font-variant-numeric:tabular-nums">${time}${ex}</div>${route ? `<div style="font-size:11px;color:var(--text-subtle)">${route}</div>` : ""}`;
    return `<div class="rr-pool-shift" draggable="true"
        data-rr-pool-shift="${sh.id}" data-rr-pool-shift-date="${sh.date}"
        style="display:flex;align-items:center;gap:10px;padding:6px 10px;border:1px solid var(--border);border-radius:8px;background:var(--surface);cursor:grab;margin-bottom:4px"
        title="Drag onto a driver to assign">
      <div style="flex:1;min-width:0">${headLine}</div>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px;color:var(--text-subtle);flex-shrink:0"><circle cx="9" cy="5" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="19" r="1"/></svg>
    </div>`;
  };

  // Group by day when sortMode === 'day' (more legible).
  let listHtml;
  if (sorted.length === 0) {
    listHtml = '<div style="padding:14px;font-size:12px;color:var(--text-subtle);text-align:center">All shifts assigned</div>';
  } else if (_poolSortMode === "day") {
    const byDay = new Map();
    for (const sh of sorted) {
      if (!byDay.has(sh.date)) byDay.set(sh.date, []);
      byDay.get(sh.date).push(sh);
    }
    listHtml = Array.from(byDay.entries()).map(([d, list]) =>
      `<div style="margin-bottom:10px"><div style="font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--text-muted);margin:8px 0 6px">${dayLabel(d)} · ${list.length}</div>${list.map(sh => shiftItem(sh, { includeDay: false })).join("")}</div>`
    ).join("");
  } else {
    listHtml = sorted.map(shiftItem).join("");
  }

  aside.innerHTML = `
    <div class="pool-head">
      <span>Open shifts</span>
      <span style="font-weight:600;letter-spacing:0;text-transform:none;color:var(--text-subtle);font-size:11px">${openShifts.length} open</span>
    </div>
    <button type="button" id="rr-unassign-week"
      style="width:100%;margin-bottom:8px;padding:6px 10px;font-size:11px;font-weight:600;color:var(--red);background:transparent;border:1px solid var(--border);border-radius:6px;cursor:pointer">
      Unassign all shifts this week
    </button>
    <div style="display:flex;gap:4px;background:var(--canvas);padding:3px;border-radius:6px;margin-bottom:8px">
      <button type="button" class="rr-pool-sort-btn" data-rr-pool-sort="day"
        style="flex:1;border:0;background:${_poolSortMode === 'day' ? 'var(--surface)' : 'transparent'};font:inherit;font-size:11px;font-weight:600;color:${_poolSortMode === 'day' ? 'var(--text)' : 'var(--text-muted)'};padding:5px 8px;border-radius:4px;cursor:pointer">Day</button>
      <button type="button" class="rr-pool-sort-btn" data-rr-pool-sort="wave"
        style="flex:1;border:0;background:${_poolSortMode === 'wave' ? 'var(--surface)' : 'transparent'};font:inherit;font-size:11px;font-weight:600;color:${_poolSortMode === 'wave' ? 'var(--text)' : 'var(--text-muted)'};padding:5px 8px;border-radius:4px;cursor:pointer">Wave time</button>
    </div>
    <div>${listHtml}</div>
    ${(() => {
      const ptoDrivers = drivers.filter(d => ptoByDriver?.has(d.id));
      if (ptoDrivers.length === 0) return "";
      const item = (d) => {
        const t = (ptoByDriver.get(d.id) || [])[0];
        const range = t ? `PTO ${t.start_date.slice(5)}–${t.end_date.slice(5)}` : "Off";
        return `<div style="display:flex;align-items:center;gap:8px;padding:6px 10px;font-size:11px;color:var(--text-subtle)"><span>${escapeHtml(displayDriverName(d))}</span><span style="margin-left:auto">${escapeHtml(range)}</span></div>`;
      };
      return `<div style="margin-top:14px;border-top:1px solid var(--border);padding-top:10px">
        <div style="font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--text-muted);margin-bottom:6px">PTO this week</div>
        ${ptoDrivers.map(item).join("")}
      </div>`;
    })()}
  `;
}

let _schedNavBound = false;
function bindSchedWeekNav() {
  if (_schedNavBound) return;
  const sub = document.getElementById("sched-sub-week");
  if (!sub) return;
  _schedNavBound = true;

  sub.addEventListener("click", (e) => {
    const arrow = e.target.closest(".sched-week-arrow");
    if (arrow) {
      const arrows = sub.querySelectorAll(".sched-week-nav .sched-week-arrow");
      const isPrev = arrows[0] === arrow;
      const cur = new Date((_schedStart || fmtIsoDate(startOfWeekMonday(new Date()))) + "T12:00:00");
      _schedStart = fmtIsoDate(addDays(cur, isPrev ? -7 : 7));
      renderScheduleWeek();
      loadSchedulingSettings();
      return;
    }
    const todayBtn = e.target.closest(".sched-week-nav .btn");
    if (todayBtn && todayBtn.textContent.trim() === "Today") {
      _schedStart = fmtIsoDate(startOfWeekMonday(new Date()));
      renderScheduleWeek();
      loadSchedulingSettings();
      return;
    }
    if (e.target.closest("[data-rr-goto-okami]"))   { if (typeof window.goto === "function") window.goto("okami"); return; }
    if (e.target.closest("[data-rr-goto-drivers]")) { if (typeof window.goto === "function") window.goto("drivers"); return; }

    // Click an ASSIGNED shift chip (not open, off, or timeoff) → confirm + delete.
    const assignedChip = e.target.closest(".shift-chip[data-rr-shift-id]");
    if (assignedChip
        && !assignedChip.classList.contains("open")
        && !assignedChip.classList.contains("off")
        && !assignedChip.classList.contains("timeoff")) {
      e.stopPropagation();
      const id = assignedChip.dataset.rrShiftId;
      if (!id) return;
      if (!_confirmLiveScheduleEdit()) return;
      if (!confirm("Remove this shift?")) return;
      sb.from("shifts").delete().eq("id", id).then(({ error }) => {
        if (error) { toast("Delete failed: " + error.message, "warn"); return; }
        toast("Shift removed", "success");
        renderScheduleWeek();
      });
      return;
    }

    // Click empty driver-row cell → open add-shift modal pre-filled.
    const cell = e.target.closest('[data-rr-cell="driver-day"]');
    if (cell) {
      const hasShift = cell.querySelector(".shift-chip:not(.off):not(.timeoff)");
      if (hasShift) return;
      const date = cell.dataset.rrCellDate;
      const stationId = cell.dataset.rrCellStation;
      const driverId = cell.dataset.rrCellDriver;
      if (!date || !stationId) {
        toast(stationId ? "" : "Driver has no station — assign one in the Drivers page", "warn");
        return;
      }
      openAddShiftModal(date, stationId, driverId);
    }
  });

  // ── KPI: clicking the Rule violations card opens a list modal.
  sub.addEventListener("click", (e) => {
    const kpiHost = document.getElementById("rr-sched-kpis");
    if (!kpiHost) return;
    if (!e.target.closest("#rr-sched-kpis > div:nth-child(5)")) return;
    let v = [];
    try { v = JSON.parse(kpiHost.dataset.rrViolations || "[]"); } catch {}
    let m = document.getElementById("rr-violations-modal");
    if (m) m.remove();
    m = document.createElement("div");
    m.id = "rr-violations-modal";
    m.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9999;display:flex;align-items:center;justify-content:center;padding:24px";
    const list = v.length === 0
      ? '<div style="padding:24px;text-align:center;color:var(--text-subtle)">No rule violations this week ✓</div>'
      : v.map(x => `<div style="padding:10px 14px;border-top:1px solid var(--border);display:flex;gap:12px;align-items:center"><div style="flex:1"><div style="font-size:13px;font-weight:600">${escapeHtml(x.driver)}</div><div style="font-size:11px;color:var(--text-subtle)">${escapeHtml(x.note)}</div></div><span style="font-size:10px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--red)">${x.kind.replace(/_/g, " ")}</span></div>`).join("");
    m.innerHTML = `
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;max-width:540px;width:100%;max-height:80vh;overflow-y:auto">
        <div style="display:flex;align-items:center;justify-content:space-between;padding:16px 18px;border-bottom:1px solid var(--border)">
          <div><div style="font-size:14px;font-weight:600">Rule violations</div><div style="font-size:12px;color:var(--text-subtle)">${v.length} this week</div></div>
          <button type="button" id="rr-vio-close" style="background:none;border:0;font-size:22px;cursor:pointer;color:var(--text-muted);padding:0 6px">×</button>
        </div>
        <div>${list}</div>
      </div>`;
    document.body.appendChild(m);
    m.addEventListener("click", (ev) => { if (ev.target === m || ev.target.id === "rr-vio-close") m.remove(); });
  });

  // ── Pool sort toggle (Day / Wave time)
  sub.addEventListener("click", (e) => {
    const sortBtn = e.target.closest("[data-rr-pool-sort]");
    if (!sortBtn) return;
    const mode = sortBtn.dataset.rrPoolSort;
    if (!mode || mode === _poolSortMode) return;
    _poolSortMode = mode;
    renderScheduleWeek();
  });

  // ── Unassign all shifts this week
  sub.addEventListener("click", async (e) => {
    if (e.target.id !== "rr-unassign-week") return;
    e.preventDefault();
    const dspId = window.RR?.dsp?.id;
    if (!dspId || !_schedStart) return;
    if (!_confirmLiveScheduleEdit()) return;
    const weekEndIso = fmtIsoDate(addDays(new Date(_schedStart + "T12:00:00"), 6));
    if (!confirm(`Unassign every driver from every shift between ${_schedStart} and ${weekEndIso}?\n\nShifts stay; only the driver assignments are cleared.`)) return;
    e.target.disabled = true;
    e.target.textContent = "Unassigning…";
    const { error, count } = await sb.from("shifts")
      .update({ driver_id: null }, { count: "exact" })
      .eq("dsp_id", dspId)
      .gte("date", _schedStart)
      .lte("date", weekEndIso)
      .not("driver_id", "is", null);
    e.target.disabled = false;
    e.target.textContent = "Unassign all shifts this week";
    if (error) { toast("Unassign failed: " + error.message, "warn"); return; }
    toast(`Unassigned ${count ?? "all"} shifts for the week`, "success");
    renderScheduleWeek();
  });

  // ── Drag-and-drop: pool SHIFT → driver-day cell.
  sub.addEventListener("dragstart", (e) => {
    const ps = e.target.closest("[data-rr-pool-shift]");
    if (!ps) return;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("application/x-rr-shift", JSON.stringify({
      id: ps.dataset.rrPoolShift,
      date: ps.dataset.rrPoolShiftDate,
    }));
    ps.classList.add("rr-dragging");
  });
  sub.addEventListener("dragend", (e) => {
    const ps = e.target.closest("[data-rr-pool-shift]");
    if (ps) ps.classList.remove("rr-dragging");
    sub.querySelectorAll(".rr-drop-active").forEach(el => el.classList.remove("rr-drop-active"));
  });
  sub.addEventListener("dragover", (e) => {
    const cell = e.target.closest('[data-rr-cell="driver-day"]');
    if (!cell) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    cell.classList.add("rr-drop-active");
  });
  sub.addEventListener("dragleave", (e) => {
    const cell = e.target.closest('[data-rr-cell="driver-day"]');
    if (cell) cell.classList.remove("rr-drop-active");
  });
  sub.addEventListener("drop", async (e) => {
    const cell = e.target.closest('[data-rr-cell="driver-day"]');
    if (!cell) return;
    e.preventDefault();
    cell.classList.remove("rr-drop-active");
    const raw = e.dataTransfer.getData("application/x-rr-shift");
    if (!raw) return;
    let payload;
    try { payload = JSON.parse(raw); } catch { return; }
    if (!payload?.id) return;
    const driverId = cell.dataset.rrCellDriver;
    if (!driverId) return;
    await assignShiftToDriverWithRules(payload.id, payload.date, driverId, cell);
  });
}

// Pre-assign rule check. Returns a list of human-readable violation
// strings; empty means clear to assign.
// Per-week violation summary for the KPI strip. Walks every assigned shift
// and surfaces issues operators care about: PTO conflicts, double-booking,
// over the max-days cap, and (when override is off) availability mismatches.
async function _computeWeekViolations(shifts, drivers, timeOff, weekStartIso, weekEndIso) {
  const violations = [];

  // Per-week settings.
  let maxDays = 5;
  let allowOverride = false;
  try {
    const { data: ws } = await sb.rpc("scheduling_settings_for_week", { p_week_start: weekStartIso });
    if (ws) {
      maxDays = Math.max(1, Math.min(7, ws.max_days_per_week ?? 5));
      allowOverride = !!ws.allow_availability_override;
    }
  } catch (_) {}

  const drvById = new Map(drivers.map(d => [d.id, d]));
  const ptoByDriver = new Map();
  for (const t of timeOff) {
    if (!ptoByDriver.has(t.driver_id)) ptoByDriver.set(t.driver_id, []);
    ptoByDriver.get(t.driver_id).push(t);
  }

  // Group assigned shifts per driver to detect over-cap and double-booking.
  const datesByDriver = new Map();
  for (const sh of shifts) {
    if (!sh.driver_id || sh.status !== "scheduled") continue;
    if (!datesByDriver.has(sh.driver_id)) datesByDriver.set(sh.driver_id, []);
    datesByDriver.get(sh.driver_id).push(sh);
  }

  const DOW = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

  for (const [driverId, list] of datesByDriver) {
    const d = drvById.get(driverId);
    if (!d) continue;
    const display = displayDriverName(d);

    // Over max-days
    const distinctDates = new Set(list.map(sh => sh.date));
    if (distinctDates.size > maxDays) {
      violations.push({ driver: display, date: null, kind: "max_days", note: `${distinctDates.size} shifts (cap ${maxDays})` });
    }

    // Double-bookings + PTO + availability per shift
    const seenDates = new Set();
    for (const sh of list) {
      if (seenDates.has(sh.date)) {
        violations.push({ driver: display, date: sh.date, kind: "double_book", note: `Two shifts on ${sh.date}` });
      }
      seenDates.add(sh.date);

      // PTO
      const ptos = ptoByDriver.get(driverId) || [];
      if (ptos.some(t => sh.date >= t.start_date && sh.date <= t.end_date)) {
        violations.push({ driver: display, date: sh.date, kind: "pto", note: `Approved PTO on ${sh.date}` });
      }

      // Availability (skipped when override on)
      if (!allowOverride) {
        const days = (d.metadata?.availability?.days) || [];
        if (days.length > 0) {
          const dt = new Date(sh.date + "T12:00:00");
          if (!days.includes(DOW[dt.getDay()])) {
            violations.push({ driver: display, date: sh.date, kind: "availability", note: `Not available on ${dt.toLocaleDateString(undefined, { weekday: "long" })}` });
          }
        }
      }
    }

    // ── Working hours compliance (WOC) ────────────────────────────────
    const WOC = { max_hours_per_week: 55, max_consecutive_days: 6, min_rest_hours: 10 };

    // Total hours this week
    const totalHrs = list.reduce((s, sh) => {
      if (sh.starts_at && sh.ends_at) return s + Math.max(0, (new Date(sh.ends_at) - new Date(sh.starts_at)) / 3600000);
      return s + (Number(sh.block_hours) || 10);
    }, 0);
    if (totalHrs > WOC.max_hours_per_week) {
      violations.push({ driver: display, date: null, kind: "woc_max_hours",
        note: `${Math.round(totalHrs)}h scheduled (cap ${WOC.max_hours_per_week}h)` });
    }

    // Max consecutive days — sort dates, find longest run.
    const sortedDates = [...new Set(list.map(sh => sh.date))].sort();
    let runStart = null, runLen = 0, maxRun = 0;
    for (const iso of sortedDates) {
      if (!runStart) { runStart = iso; runLen = 1; }
      else {
        const prev = new Date(runStart + "T12:00:00");
        const cur  = new Date(iso + "T12:00:00");
        const diff = Math.round((cur - prev) / 86400000);
        if (diff === runLen) runLen += 1;
        else { if (runLen > maxRun) maxRun = runLen; runStart = iso; runLen = 1; }
      }
    }
    if (runLen > maxRun) maxRun = runLen;
    if (maxRun > WOC.max_consecutive_days) {
      violations.push({ driver: display, date: null, kind: "woc_consecutive",
        note: `${maxRun} days in a row (cap ${WOC.max_consecutive_days})` });
    }

    // Min rest between consecutive shifts.
    const sortedShifts = [...list].filter(sh => sh.starts_at && sh.ends_at)
      .sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at));
    for (let i = 1; i < sortedShifts.length; i++) {
      const prev = sortedShifts[i - 1];
      const curr = sortedShifts[i];
      const gap = (new Date(curr.starts_at) - new Date(prev.ends_at)) / 3600000;
      if (gap >= 0 && gap < WOC.min_rest_hours) {
        violations.push({ driver: display, date: curr.date, kind: "woc_rest",
          note: `Only ${gap.toFixed(1)}h rest before ${curr.date} (min ${WOC.min_rest_hours}h)` });
      }
    }
  }

  return violations;
}

async function _checkAssignViolations(shiftId, shiftDate, driverId) {
  const dspId = window.RR?.dsp?.id;
  if (!dspId || !_schedStart) return [];
  const violations = [];

  // Per-week settings (max-days + override flag).
  let maxDays = 5;
  let allowOverride = false;
  try {
    const { data: ws } = await sb.rpc("scheduling_settings_for_week", { p_week_start: _schedStart });
    if (ws) {
      maxDays = Math.max(1, Math.min(7, ws.max_days_per_week ?? 5));
      allowOverride = !!ws.allow_availability_override;
    }
  } catch (_) {}

  const weekEnd = addDays(new Date(_schedStart + "T12:00:00"), 6);
  const weekEndIso = fmtIsoDate(weekEnd);

  const [drvRes, ptoRes, shiftsRes, candidateRes] = await Promise.all([
    sb.from("drivers").select("id, full_name, metadata").eq("id", driverId).single(),
    sb.from("time_off_requests").select("start_date, end_date")
      .eq("dsp_id", dspId).eq("driver_id", driverId).eq("status", "approved")
      .lte("start_date", weekEndIso).gte("end_date", _schedStart),
    sb.from("shifts").select("id, date, status, driver_id, starts_at, ends_at, block_hours")
      .eq("dsp_id", dspId).eq("driver_id", driverId)
      .gte("date", _schedStart).lte("date", weekEndIso),
    // The candidate shift itself (need its start/end to evaluate WOC).
    sb.from("shifts").select("id, date, starts_at, ends_at, block_hours").eq("id", shiftId).single(),
  ]);

  const driver = drvRes.data;
  if (!driver) { violations.push("Driver not found"); return violations; }

  // PTO check
  for (const t of (ptoRes.data || [])) {
    if (shiftDate >= t.start_date && shiftDate <= t.end_date) {
      violations.push(`Driver has approved PTO on ${shiftDate}`);
      break;
    }
  }

  // Already-shifted-that-day check
  const sameDay = (shiftsRes.data || []).find(sh => sh.date === shiftDate && sh.id !== shiftId && sh.status === "scheduled");
  if (sameDay) violations.push(`Driver already has a shift on ${shiftDate}`);

  // Max-days check (count distinct dates assigned this week, excluding the
  // shift being moved if it's already assigned to this driver — not the case here).
  const datesThisWeek = new Set((shiftsRes.data || []).filter(sh => sh.status === "scheduled").map(sh => sh.date));
  if (!datesThisWeek.has(shiftDate) && datesThisWeek.size >= maxDays) {
    violations.push(`Driver already has ${datesThisWeek.size} shifts this week (cap: ${maxDays})`);
  }

  // Availability check (skip if override is on)
  if (!allowOverride) {
    const days = (driver.metadata?.availability?.days) || [];
    const DOW = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
    const dt = new Date(shiftDate + "T12:00:00");
    const dow = DOW[dt.getDay()];
    if (days.length === 0) {
      violations.push("Driver has no availability set");
    } else if (!days.includes(dow)) {
      violations.push(`Driver isn't available on ${dt.toLocaleDateString(undefined, { weekday: "long" })}`);
    }
  }

  // ── Working hours compliance (WOC) on the proposed assignment.
  const WOC = { max_hours_per_week: 55, max_consecutive_days: 6, min_rest_hours: 10 };
  const candShift = candidateRes?.data;
  const existing = (shiftsRes.data || []).filter(sh => sh.status === "scheduled" && sh.id !== shiftId);
  const allShifts = [...existing, candShift].filter(Boolean);
  const shiftHours = (sh) => {
    if (sh.starts_at && sh.ends_at) return Math.max(0, (new Date(sh.ends_at) - new Date(sh.starts_at)) / 3600000);
    return Number(sh.block_hours) || 10;
  };
  // Total hours
  const totalHrs = allShifts.reduce((s, sh) => s + shiftHours(sh), 0);
  if (totalHrs > WOC.max_hours_per_week) {
    violations.push(`Would push driver to ${Math.round(totalHrs)}h this week (cap ${WOC.max_hours_per_week}h)`);
  }
  // Consecutive days
  const sortedDates = [...new Set(allShifts.map(sh => sh.date))].sort();
  let runStart = null, runLen = 0, maxRun = 0;
  for (const iso of sortedDates) {
    if (!runStart) { runStart = iso; runLen = 1; }
    else {
      const prev = new Date(runStart + "T12:00:00");
      const cur  = new Date(iso + "T12:00:00");
      const diff = Math.round((cur - prev) / 86400000);
      if (diff === runLen) runLen += 1;
      else { if (runLen > maxRun) maxRun = runLen; runStart = iso; runLen = 1; }
    }
  }
  if (runLen > maxRun) maxRun = runLen;
  if (maxRun > WOC.max_consecutive_days) {
    violations.push(`Would put driver on ${maxRun} consecutive days (cap ${WOC.max_consecutive_days})`);
  }
  // Min rest between adjacent shifts
  const sortedShifts = allShifts.filter(sh => sh.starts_at && sh.ends_at)
    .sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at));
  for (let i = 1; i < sortedShifts.length; i++) {
    const gap = (new Date(sortedShifts[i].starts_at) - new Date(sortedShifts[i - 1].ends_at)) / 3600000;
    if (gap >= 0 && gap < WOC.min_rest_hours) {
      violations.push(`Less than ${WOC.min_rest_hours}h rest between shifts (${gap.toFixed(1)}h)`);
      break;
    }
  }

  return violations;
}

async function assignShiftToDriverWithRules(shiftId, shiftDate, driverId, cell) {
  if (!_confirmLiveScheduleEdit()) return;
  const violations = await _checkAssignViolations(shiftId, shiftDate, driverId);
  if (violations.length > 0) {
    const msg = "Rule violations:\n\n• " + violations.join("\n• ") + "\n\nSchedule anyway?";
    if (!confirm(msg)) return;
  }
  const { error } = await sb.rpc("assign_shift", { p_id: shiftId, p_driver_id: driverId });
  if (error) { toast("Assign failed: " + error.message, "warn"); return; }
  toast(violations.length > 0 ? "Assigned (override)" : "Shift assigned", "success");
  renderScheduleWeek();
}

function openAddShiftModal(date, stationId, prefDriverId) {
  let m = document.getElementById("rr-shift-modal");
  if (m) m.remove();
  m = document.createElement("div");
  m.id = "rr-shift-modal";
  m.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:10000;display:flex;align-items:center;justify-content:center;padding:24px";
  m.innerHTML = `
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:22px;max-width:440px;width:100%">
      <h3 style="margin:0 0 14px;font-size:17px;font-weight:600">Add shift</h3>
      <label style="display:block;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted);margin-bottom:6px">Date</label>
      <input type="date" id="rr-sh-date" class="form-input" style="width:100%;margin-bottom:10px" value="${date}"/>
      <label style="display:block;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted);margin-bottom:6px">Driver (optional · leave blank for open shift)</label>
      <select id="rr-sh-driver" class="form-input" style="width:100%;margin-bottom:10px">
        <option value="">— Open shift —</option>
        ${_schedDriverList.map(d => `<option value="${d.id}"${prefDriverId === d.id ? " selected" : ""}>${escapeHtml(displayDriverName(d))}</option>`).join("")}
      </select>
      <label style="display:block;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted);margin-bottom:6px">Route</label>
      <input id="rr-sh-route" class="form-input" style="width:100%;margin-bottom:14px" placeholder="e.g. KMO1-14B"/>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button class="btn" data-rr-sh-cancel>Cancel</button>
        <button class="btn btn-primary" data-rr-sh-save>Add shift</button>
      </div>
    </div>`;
  document.body.appendChild(m);
  m.addEventListener("click", async (e) => {
    if (e.target.closest("[data-rr-sh-cancel]") || e.target === m) { m.remove(); return; }
    if (e.target.closest("[data-rr-sh-save]")) {
      const payload = {
        date: document.getElementById("rr-sh-date").value,
        station_id: stationId,
        driver_id: document.getElementById("rr-sh-driver").value || null,
        route_code: document.getElementById("rr-sh-route").value.trim() || null,
      };
      if (!_confirmLiveScheduleEdit()) return;
      const { error } = await sb.rpc("create_shift", { p_payload: payload });
      if (error) { toast("Save failed: " + error.message, "warn"); return; }
      m.remove();
      toast("Shift added", "success");
      loadScheduleView();
    }
  });
}

function openAssignShiftModal(shiftId) {
  let m = document.getElementById("rr-shift-modal");
  if (m) m.remove();
  m = document.createElement("div");
  m.id = "rr-shift-modal";
  m.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:10000;display:flex;align-items:center;justify-content:center;padding:24px";
  m.innerHTML = `
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:22px;max-width:380px;width:100%">
      <h3 style="margin:0 0 14px;font-size:17px;font-weight:600">Assign shift</h3>
      <select id="rr-as-driver" class="form-input" style="width:100%;margin-bottom:14px">
        ${_schedDriverList.map(d => `<option value="${d.id}">${escapeHtml(displayDriverName(d))}</option>`).join("")}
      </select>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button class="btn" data-rr-as-cancel>Cancel</button>
        <button class="btn btn-primary" data-rr-as-save>Assign</button>
      </div>
    </div>`;
  document.body.appendChild(m);
  m.addEventListener("click", async (e) => {
    if (e.target.closest("[data-rr-as-cancel]") || e.target === m) { m.remove(); return; }
    if (e.target.closest("[data-rr-as-save]")) {
      if (!_confirmLiveScheduleEdit()) return;
      const did = document.getElementById("rr-as-driver").value;
      const { error } = await sb.rpc("assign_shift", { p_id: shiftId, p_driver_id: did });
      if (error) { toast("Assign failed: " + error.message, "warn"); return; }
      m.remove();
      toast("Shift assigned", "success");
      loadScheduleView();
    }
  });
}


// ─── Time off ─────────────────────────────────────────────────────────────

async function loadTimeOffList() {
  const sub = document.getElementById("sched-sub-timeoff");
  if (!sub) return;
  const { data: rows, error } = await sb.from("time_off_requests")
    .select("id, driver_id, start_date, end_date, reason, status, decided_at, drivers:driver_id (full_name)")
    .eq("dsp_id", window.RR.dsp.id)
    .order("start_date", { ascending: false })
    .limit(200);
  if (error) { sub.innerHTML = `<div style="padding:24px;color:var(--red)">${escapeHtml(error.message)}</div>`; return; }

  const pending = (rows || []).filter(r => r.status === "pending");
  const past    = (rows || []).filter(r => r.status !== "pending");

  sub.innerHTML = `
    <div style="margin-bottom:var(--s-3);display:flex;align-items:center;justify-content:space-between">
      <h3 style="margin:0;font-size:15px;font-weight:600">Time off</h3>
      <button class="btn btn-sm btn-primary" data-rr-add-time-off>+ Add request</button>
    </div>
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;overflow:hidden">
      <div style="padding:8px 14px;background:var(--canvas);font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--text-muted)">Pending (${pending.length})</div>
      ${pending.length === 0 ? `<div style="padding:18px;text-align:center;color:var(--text-subtle);font-size:13px">No pending requests.</div>` : pending.map(timeOffRow).join("")}
      <div style="padding:8px 14px;background:var(--canvas);font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--text-muted);border-top:1px solid var(--border)">Past (${past.length})</div>
      ${past.length === 0 ? `<div style="padding:18px;text-align:center;color:var(--text-subtle);font-size:13px">No past requests.</div>` : past.map(timeOffRow).join("")}
    </div>`;
}

function timeOffRow(r) {
  const range = r.start_date === r.end_date
    ? new Date(r.start_date + "T12:00:00").toLocaleDateString()
    : `${new Date(r.start_date + "T12:00:00").toLocaleDateString()} → ${new Date(r.end_date + "T12:00:00").toLocaleDateString()}`;
  const statusColor = {
    pending:   "color:#B45309",
    approved:  "color:var(--green)",
    denied:    "color:var(--red)",
    cancelled: "color:var(--text-subtle)",
  }[r.status];
  return `
    <div style="display:grid;grid-template-columns:1fr 1fr 100px 1fr auto;gap:10px;align-items:center;padding:10px 14px;border-top:1px solid var(--border)">
      <div><div style="font-size:13px;font-weight:600">${escapeHtml(r.drivers?.full_name || "—")}</div></div>
      <div style="font-size:12px">${range}</div>
      <div style="font-size:11px;font-weight:700;${statusColor};text-transform:uppercase">${r.status}</div>
      <div style="font-size:12px;color:var(--text-subtle)">${escapeHtml(r.reason || "")}</div>
      <div>${r.status === "pending" ? `
        <button class="btn btn-sm" data-rr-time-off-decide="${r.id}" data-decision="approve">Approve</button>
        <button class="btn btn-sm" data-rr-time-off-decide="${r.id}" data-decision="deny" style="color:var(--red)">Deny</button>
      ` : ""}</div>
    </div>`;
}

document.addEventListener("click", async (e) => {
  if (e.target.closest("[data-rr-add-time-off]")) {
    e.preventDefault(); e.stopImmediatePropagation();
    openTimeOffModal();
  }
  const dec = e.target.closest("[data-rr-time-off-decide]");
  if (dec) {
    e.preventDefault(); e.stopImmediatePropagation();
    const id = dec.getAttribute("data-rr-time-off-decide");
    const d  = dec.getAttribute("data-decision");
    const { error } = await sb.rpc("decide_time_off", { p_id: id, p_decision: d, p_notes: null });
    if (error) { toast("Update failed: " + error.message, "warn"); return; }
    toast(`Marked ${d}d`, "success");
    loadTimeOffList();
  }
}, true);

function openTimeOffModal() {
  let m = document.getElementById("rr-shift-modal");
  if (m) m.remove();
  m = document.createElement("div");
  m.id = "rr-shift-modal";
  m.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:10000;display:flex;align-items:center;justify-content:center;padding:24px";
  m.innerHTML = `
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:22px;max-width:440px;width:100%">
      <h3 style="margin:0 0 14px;font-size:17px;font-weight:600">Time off request</h3>
      <label style="display:block;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted);margin-bottom:6px">Driver</label>
      <select id="rr-to-driver" class="form-input" style="width:100%;margin-bottom:10px">
        ${_schedDriverList.map(d => `<option value="${d.id}">${escapeHtml(displayDriverName(d))}</option>`).join("")}
      </select>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">
        <div><label style="display:block;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted);margin-bottom:6px">Start</label><input type="date" id="rr-to-start" class="form-input" style="width:100%"/></div>
        <div><label style="display:block;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted);margin-bottom:6px">End</label><input type="date" id="rr-to-end" class="form-input" style="width:100%"/></div>
      </div>
      <label style="display:block;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted);margin-bottom:6px">Reason</label>
      <input id="rr-to-reason" class="form-input" style="width:100%;margin-bottom:14px" placeholder="Vacation / personal / sick / …"/>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button class="btn" data-rr-to-cancel>Cancel</button>
        <button class="btn btn-primary" data-rr-to-save>Save request</button>
      </div>
    </div>`;
  document.body.appendChild(m);
  m.addEventListener("click", async (e) => {
    if (e.target.closest("[data-rr-to-cancel]") || e.target === m) { m.remove(); return; }
    if (e.target.closest("[data-rr-to-save]")) {
      const payload = {
        driver_id: document.getElementById("rr-to-driver").value,
        start_date: document.getElementById("rr-to-start").value,
        end_date:   document.getElementById("rr-to-end").value,
        reason:     document.getElementById("rr-to-reason").value.trim() || null,
      };
      if (!payload.start_date || !payload.end_date) { toast("Pick a date range", "warn"); return; }
      const { error } = await sb.rpc("request_time_off", { p_payload: payload });
      if (error) { toast("Save failed: " + error.message, "warn"); return; }
      m.remove();
      toast("Time off saved", "success");
      loadTimeOffList();
    }
  });
}


// ─── Open shifts ─────────────────────────────────────────────────────────

async function loadOpenShifts() {
  const sub = document.getElementById("sched-sub-open");
  if (!sub) return;
  const today = fmtIsoDate(new Date());
  const { data: rows, error } = await sb.from("shifts")
    .select("id, date, station_id, route_code, status, station:station_id (code)")
    .eq("dsp_id", window.RR.dsp.id)
    .is("driver_id", null)
    .gte("date", today)
    .order("date", { ascending: true })
    .limit(500);
  if (error) { sub.innerHTML = `<div style="padding:24px;color:var(--red)">${escapeHtml(error.message)}</div>`; return; }

  if (!rows || rows.length === 0) {
    sub.innerHTML = `<div style="padding:32px;text-align:center;color:var(--text-subtle);font-size:13px"><strong style="color:var(--text-muted);display:block;margin-bottom:4px">No open shifts</strong>Add shifts from the Week view, or leave the driver picker blank when adding to create one.</div>`;
    return;
  }
  sub.innerHTML = `
    <h3 style="margin:0 0 var(--s-3);font-size:15px;font-weight:600">Open shifts (${rows.length})</h3>
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;overflow:hidden">
      <div style="display:grid;grid-template-columns:130px 90px 1fr 100px;gap:10px;padding:8px 14px;background:var(--canvas);font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--text-muted)">
        <div>Date</div><div>Station</div><div>Route</div><div></div>
      </div>
      ${rows.map(r => `
        <div style="display:grid;grid-template-columns:130px 90px 1fr 100px;gap:10px;align-items:center;padding:10px 14px;border-top:1px solid var(--border)">
          <div style="font-size:13px;font-weight:600">${new Date(r.date + "T12:00:00").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}</div>
          <div style="font-size:13px">${escapeHtml(r.station?.code || "—")}</div>
          <div style="font-size:13px;font-family:'SF Mono',Menlo,monospace;color:var(--text-muted)">${escapeHtml(r.route_code || "—")}</div>
          <div><button class="btn btn-sm btn-primary" data-rr-shift-id="${r.id}">Assign</button></div>
        </div>`).join("")}
    </div>`;
}


// Hook view + sub-view loaders.
const _origGotoForSched = window.goto;
window.goto = function (view) {
  if (typeof _origGotoForSched === "function") _origGotoForSched(view);
  if (view === "schedule") loadScheduleView();
  if (view === "okami")    loadOkamiView();
};

const _origRefreshSched = refreshActiveView;
function refreshActiveViewWithSched() {
  _origRefreshSched();
  const v = document.querySelector(".view.active")?.id;
  if (v === "view-schedule") loadScheduleView();
  if (v === "view-okami")    loadOkamiView();
}
// Replace the inner loop's reference too: we monkey-patch by re-binding.
window.addEventListener("focus", () => {
  const v = document.querySelector(".view.active")?.id;
  if (v === "view-schedule") loadScheduleView();
  if (v === "view-okami")    loadOkamiView();
});
