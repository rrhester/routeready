// Reports Builder — config-driven operational reports over RouteReady data.
//
// Self-contained ES module (same pattern as workbook.js): live.js imports it,
// injects the workbook-creation dependency via initReportsBuilder(), and
// exposes openReportsBuilder() on window for the app-launcher button.
//
// Architecture: three separated layers so future categories (Fleet, Schedule,
// Attendance, Hiring, Compliance) plug in without UI rewrites —
//   1. RB_FIELDS      · field key → column label + mapper over an enriched row
//   2. RB_REPORTS     · report definitions (id, category, title, fields, …)
//   3. fetchPeopleData· one dsp-scoped data pull per category, cached per open
// The modal renders whatever the configs describe; "Open in Workbook",
// CSV, and Print all consume the same {headers, rows} matrix.

function _sb() { return (window.RR && window.RR.sb) || window.sb || null; }
function _dsp() { return (window.RR && window.RR.dsp) || null; }
function _toast(msg, kind) {
  if (typeof window.toast === "function") window.toast(msg, kind);
  else console.log("[reports toast]", kind || "", msg);
}
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const DASH = "—";
const DAY_LABEL = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };

function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
function yesNo(v) { return v === true ? "Yes" : v === false ? "No" : DASH; }
function dayList(arr) {
  if (!Array.isArray(arr) || !arr.length) return DASH;
  return arr.map((d) => DAY_LABEL[String(d).slice(0, 3).toLowerCase()] || cap(String(d))).join(", ");
}

// "2y 4m" tenure from a hire date; hires this month read as "New".
function tenureText(hireDate) {
  if (!hireDate) return DASH;
  const h = new Date(hireDate + "T00:00:00");
  if (isNaN(h)) return DASH;
  const now = new Date();
  let months = (now.getFullYear() - h.getFullYear()) * 12 + (now.getMonth() - h.getMonth());
  if (now.getDate() < h.getDate()) months--;
  if (months < 1) return "New";
  const y = Math.floor(months / 12), m = months % 12;
  return y ? `${y}y${m ? ` ${m}m` : ""}` : `${m}m`;
}

// ─── Field catalog ───────────────────────────────────────────────────────────
// Mappers receive an enriched person: the drivers row plus { tenure, risk,
// attendancePct, lastCoachingDate } derived in fetchPeopleData.

const RB_FIELDS = {
  driverName: { label: "Driver Name", map: (p) => p.preferred_name || p.full_name || DASH },
  phoneNumber: { label: "Phone Number", map: (p) => p.phone || DASH },
  email: { label: "Email", map: (p) => p.email || DASH },
  hireDate: { label: "Hire Date", map: (p) => p.hire_date || DASH },
  tenure: { label: "Tenure", map: (p) => p.tenure },
  status: { label: "Status", map: (p) => cap(p.status) || DASH },
  role: { label: "Role", map: (p) => (p.is_trainer ? "Trainer" : "Driver") },
  dotCert: { label: "DOT", map: (p) => yesNo(!!p.dot_certified) },
  xlCert: { label: "XL", map: (p) => yesNo(!!p.xl_certified) },
  edvCert: { label: "EDV", map: (p) => yesNo(!!p.edv_certified) },
  licenseExpiration: { label: "License Expiration", map: (p) => p.dl_expires_on || DASH },
  emergencyContactName: { label: "Emergency Contact Name", map: (p) => p.emergency_contact_name || DASH },
  emergencyContactPhone: { label: "Emergency Contact Phone", map: (p) => p.emergency_contact_phone || DASH },
  preferredDays: { label: "Preferred Days", map: (p) => dayList(p._avail.preferred_days) },
  availability: { label: "Availability", map: (p) => dayList(p._avail.days) },
  overtimePreference: { label: "Overtime Preference", map: (p) => yesNo(typeof p._avail.fifth_day_ok === "boolean" ? p._avail.fifth_day_ok : null) },
  attendanceRisk: { label: "Risk Level", map: (p) => p.risk },
  attendanceStatus: { label: "Attendance Status", map: (p) => (p.attendancePct == null ? DASH : p.attendancePct + "%") },
  lastCoachingDate: { label: "Last Coaching Date", map: (p) => p.lastCoachingDate || DASH },
};

// Custom-report picker order (the full catalog, spec order).
const RB_CUSTOM_FIELDS = [
  "driverName", "phoneNumber", "email", "hireDate", "tenure", "status", "role",
  "dotCert", "xlCert", "edvCert", "licenseExpiration",
  "emergencyContactName", "emergencyContactPhone",
  "preferredDays", "availability", "overtimePreference",
  "attendanceRisk", "lastCoachingDate",
];

// Custom picker shows friendlier labels for a few fields than the tight
// column headers used in the sheet itself.
const RB_PICKER_LABEL = {
  dotCert: "DOT Certification", xlCert: "XL Certification", edvCert: "EDV Certification",
  attendanceRisk: "Attendance Risk",
};

// ─── Report catalog ──────────────────────────────────────────────────────────

const RB_CATEGORIES = [
  { key: "people", label: "People", enabled: true },
  { key: "fleet", label: "Fleet", enabled: false },
  { key: "schedule", label: "Schedule", enabled: false },
  { key: "attendance", label: "Attendance", enabled: false },
  { key: "hiring", label: "Hiring", enabled: false },
  { key: "compliance", label: "Compliance", enabled: false },
  { key: "custom", label: "Custom", enabled: false },
];

const RB_REPORTS = [
  { id: "custom-people", category: "people", title: "People Report", description: "Pick exactly the people fields you need.", fields: [], custom: true },
];

// ─── Data layer ──────────────────────────────────────────────────────────────

const RB = {
  deps: {},          // { createReportWorkbook } injected by live.js
  data: null,        // enriched people rows, cached while the modal is open
  loading: null,     // in-flight promise
  report: null,      // selected report def
  customSel: new Set(["driverName", "phoneNumber", "email", "status"]),
  live: true,        // live-updating workbook vs point-in-time snapshot
};

export function initReportsBuilder(deps) { RB.deps = deps || {}; }

const SEV_RANK = { verbal: 1, concern: 1, written: 2, warning: 2, final: 3, termination: 4 };

async function fetchPeopleData(force) {
  if (RB.data && !force) return RB.data;
  if (RB.loading && !force) return RB.loading;
  const sb = _sb(), dsp = _dsp();
  if (!sb || !dsp) throw new Error("no session");
  const d30 = new Date(); d30.setDate(d30.getDate() - 30);
  const d14 = new Date(); d14.setDate(d14.getDate() - 14);
  const iso = (d) => d.toISOString().slice(0, 10);
  RB.loading = (async () => {
    const [drv, coach, att] = await Promise.all([
      sb.from("drivers")
        .select("id, full_name, preferred_name, email, phone, status, hire_date, is_trainer, dot_certified, xl_certified, edv_certified, dl_expires_on, emergency_contact_name, emergency_contact_phone, metadata")
        .eq("dsp_id", dsp.id)
        .neq("status", "terminated")
        .order("full_name")
        .limit(1000),
      sb.from("coachings")
        .select("driver_id, occurred_at, severity, resolved_at")
        .eq("dsp_id", dsp.id)
        .is("archived_at", null)
        .order("occurred_at", { ascending: false })
        .limit(2000)
        .then((r) => r, () => ({ data: [] })),
      sb.from("shifts")
        .select("driver_id, status, date")
        .eq("dsp_id", dsp.id)
        .in("status", ["completed", "late", "no_show", "called_off"])
        .gte("date", iso(d30))
        .limit(20000)
        .then((r) => r, () => ({ data: [] })),
    ]);
    if (drv.error) throw drv.error;

    // per-driver coaching + attendance aggregates (same worked/eligible
    // model and High/Medium/Low thresholds as the roster risk model)
    const coachBy = new Map();
    for (const c of (coach.data || [])) {
      const a = coachBy.get(c.driver_id) || { last: null, topSev: 0 };
      if (!a.last) a.last = String(c.occurred_at || "").slice(0, 10); // rows arrive newest-first
      if (!c.resolved_at) a.topSev = Math.max(a.topSev, SEV_RANK[c.severity] || 0);
      coachBy.set(c.driver_id, a);
    }
    const attBy = new Map();
    const iso14 = iso(d14);
    for (const sh of (att.data || [])) {
      if (!sh.driver_id) continue;
      const a = attBy.get(sh.driver_id) || { worked: 0, eligible: 0, noShow30: 0, callOffs30: 0, late14: 0 };
      if (sh.status === "completed" || sh.status === "late") a.worked++;
      if (sh.status === "no_show") a.noShow30++;
      if (sh.status === "called_off") a.callOffs30++;
      if (sh.status === "late" && sh.date >= iso14) a.late14++;
      a.eligible++;
      attBy.set(sh.driver_id, a);
    }

    const people = (drv.data || []).map((p) => {
      const meta = p.metadata && typeof p.metadata === "object" ? p.metadata : {};
      const avail = meta.availability && typeof meta.availability === "object" ? meta.availability : {};
      const co = coachBy.get(p.id) || { last: null, topSev: 0 };
      const at = attBy.get(p.id) || null;
      const pct = at && at.eligible ? Math.round((at.worked / at.eligible) * 100) : null;
      let risk = "Low";
      if (co.topSev >= 3 || (at && at.noShow30 >= 1) || (at && at.callOffs30 >= 3)) risk = "High";
      else if (co.topSev === 2 || (at && at.callOffs30 >= 1) || (at && at.late14 >= 2) || (pct != null && pct < 85)) risk = "Medium";
      return { ...p, _avail: avail, tenure: tenureText(p.hire_date), attendancePct: pct, risk, lastCoachingDate: co.last };
    });
    RB.data = people;
    RB.loading = null;
    return people;
  })();
  return RB.loading;
}

// ─── Matrix builder (shared by preview, workbook, CSV, print) ────────────────

function reportFields(report) {
  return report.custom ? RB_CUSTOM_FIELDS.filter((k) => RB.customSel.has(k)) : report.fields;
}

function buildMatrix(report, people) {
  const keys = reportFields(report);
  return {
    headers: keys.map((k) => RB_FIELDS[k].label),
    rows: people.map((p) => keys.map((k) => RB_FIELDS[k].map(p))),
  };
}

// Data provider for live report workbooks — workbook.js calls this (via
// registerReportProvider in live.js) with the stored report spec whenever a
// live report is opened, and rewrites the sheet with what it returns.
export async function buildReportData(spec) {
  const people = await fetchPeopleData(true); // always fresh — that's the point
  const keys = (Array.isArray(spec && spec.fields) ? spec.fields : []).filter((k) => RB_FIELDS[k]);
  if (!keys.length) return null;
  return {
    headers: keys.map((k) => RB_FIELDS[k].label),
    rows: people.map((p) => keys.map((k) => RB_FIELDS[k].map(p))),
  };
}

function toCsv(headers, rows) {
  const cell = (v) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return [headers, ...rows].map((r) => r.map(cell).join(",")).join("\r\n");
}

// ─── Modal ───────────────────────────────────────────────────────────────────

export function openReportsBuilder() {
  if (!_sb() || !_dsp()) { _toast("Sign in to build reports", "warn"); return; }
  document.getElementById("rr-reports-modal")?.remove();
  RB.report = null;
  RB.data = null; // fresh data each open — reports reflect the roster now

  const wrap = document.createElement("div");
  wrap.className = "rr-modal-backdrop";
  wrap.id = "rr-reports-modal";
  wrap.innerHTML = `
    <div class="rr-modal-panel rb-panel" role="dialog" aria-modal="true" aria-label="Reports Builder">
      <div class="rr-modal-head">
        <div class="rr-modal-head-content">
          <p class="rr-modal-title">Reports Builder</p>
          <p class="rr-modal-sub">Create operational reports from RouteReady data. People, fleet, schedule, attendance, hiring, and compliance reports.</p>
        </div>
        <button class="rr-modal-close" type="button" data-rb-close aria-label="Close">×</button>
      </div>
      <div class="rb-body">
        <nav class="rb-cats" aria-label="Report categories">
          ${RB_CATEGORIES.map((c) => `
            <button type="button" class="rb-cat ${c.key === "people" ? "is-active" : ""}" data-rb-cat="${c.key}" ${c.enabled ? "" : "disabled"}>
              ${esc(c.label)}${c.enabled ? "" : `<span class="rb-soon">Soon</span>`}
            </button>`).join("")}
        </nav>
        <div class="rb-main" data-rb-main></div>
        <div class="rb-preview" data-rb-preview>
          <div class="rb-preview-blank">Select a report to preview it here.</div>
        </div>
      </div>
      <div class="rr-modal-foot rb-foot">
        <button class="rr-modal-btn" type="button" data-rb-close>Cancel</button>
        <span class="rb-foot-spacer"></span>
        <button class="rr-modal-btn" type="button" data-rb-act="csv" disabled>Download CSV</button>
        <button class="rr-modal-btn" type="button" data-rb-act="print" disabled>Print</button>
        <button class="rr-modal-btn primary" type="button" data-rb-act="workbook" disabled>Open in Workbook</button>
      </div>
    </div>`;
  document.body.appendChild(wrap);

  const els = {
    main: wrap.querySelector("[data-rb-main]"),
    preview: wrap.querySelector("[data-rb-preview]"),
    foot: { csv: wrap.querySelector('[data-rb-act="csv"]'), print: wrap.querySelector('[data-rb-act="print"]'), workbook: wrap.querySelector('[data-rb-act="workbook"]') },
  };

  const close = () => wrap.remove();

  const footState = () => {
    const ready = !!RB.report && reportFields(RB.report).length > 0;
    els.foot.csv.disabled = !ready;
    els.foot.print.disabled = !ready;
    els.foot.workbook.disabled = !ready;
  };

  const renderCustomPanel = () => {
    els.main.innerHTML = `
      <p class="rb-main-head">People Report</p>
      <p class="rb-main-sub">Choose the fields to include. The report updates as you pick.</p>
      <div class="rb-fields">
        ${RB_CUSTOM_FIELDS.map((k) => `
          <label class="rb-field-check">
            <input type="checkbox" data-rb-field="${k}" ${RB.customSel.has(k) ? "checked" : ""}>
            <span>${esc(RB_PICKER_LABEL[k] || RB_FIELDS[k].label)}</span>
          </label>`).join("")}
      </div>
      <p class="rb-main-head rb-live-head">Data updates</p>
      <div class="rb-live-opts">
        <label class="rb-live-opt">
          <input type="radio" name="rb-live" data-rb-live="1" ${RB.live ? "checked" : ""}>
          <span><strong>Live</strong> — the workbook refreshes from RouteReady data every time it's opened.</span>
        </label>
        <label class="rb-live-opt">
          <input type="radio" name="rb-live" data-rb-live="0" ${RB.live ? "" : "checked"}>
          <span><strong>Snapshot</strong> — keeps the data exactly as it is right now.</span>
        </label>
      </div>`;
  };

  const renderPreview = async (retry) => {
    if (!RB.report) return;
    const report = RB.report;
    const keys = reportFields(report);
    if (!keys.length) {
      els.preview.innerHTML = `<div class="rb-preview-blank">Select at least one field to preview.</div>`;
      footState();
      return;
    }
    els.preview.innerHTML = `<div class="rb-state"><span class="rb-spinner" aria-hidden="true"></span>Loading people data…</div>`;
    let people;
    try { people = await fetchPeopleData(retry === true); }
    catch (e) {
      console.warn("reports data:", e && e.message);
      if (RB.report !== report) return;
      RB.loading = null;
      els.preview.innerHTML = `<div class="rb-state is-error">Unable to load report data.<button type="button" class="btn btn-ghost btn-sm" data-rb-retry>Retry</button></div>`;
      footState();
      return;
    }
    if (RB.report !== report) return; // selection changed while loading
    if (!people.length) {
      els.preview.innerHTML = `<div class="rb-state">No people records found.</div>`;
      footState();
      return;
    }
    const { headers, rows } = buildMatrix(report, people);
    const shown = rows.slice(0, 12);
    els.preview.innerHTML = `
      <p class="rb-preview-title">${esc(report.title)}</p>
      <p class="rb-preview-sub">${rows.length} ${rows.length === 1 ? "person" : "people"} · showing first ${shown.length}</p>
      <div class="rb-table-wrap">
        <table class="rb-table">
          <thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead>
          <tbody>${shown.map((r) => `<tr>${r.map((v) => `<td>${esc(v)}</td>`).join("")}</tr>`).join("")}</tbody>
        </table>
      </div>`;
    footState();
  };

  const selectReport = (id) => {
    const report = RB_REPORTS.find((r) => r.id === id);
    if (!report) return;
    RB.report = report;
    renderCustomPanel();
    footState();
    renderPreview();
  };

  const currentMatrix = async () => {
    const people = await fetchPeopleData();
    return buildMatrix(RB.report, people);
  };

  const doCsv = async () => {
    try {
      const { headers, rows } = await currentMatrix();
      const blob = new Blob(["﻿" + toCsv(headers, rows)], { type: "text/csv;charset=utf-8" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = RB.report.title.replace(/[^\w]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() + ".csv";
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    } catch (_) { _toast("Unable to load report data", "error"); }
  };

  const doPrint = async () => {
    try {
      const { headers, rows } = await currentMatrix();
      const win = window.open("", "_blank");
      if (!win) { _toast("Allow pop-ups to print reports", "warn"); return; }
      win.document.write(`<!doctype html><html><head><title>${esc(RB.report.title)}</title><style>
        body{font:13px/1.45 -apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#111827;margin:32px}
        h1{font-size:18px;margin:0 0 2px} p{margin:0 0 16px;color:#6B7280;font-size:12px}
        table{border-collapse:collapse;width:100%} th,td{border:1px solid #D1D5DB;padding:5px 8px;text-align:left;font-size:12px}
        th{background:#F3F4F6;font-weight:600}
      </style></head><body>
        <h1>${esc(RB.report.title)}</h1>
        <p>${esc(_dsp().name || "")} · ${rows.length} ${rows.length === 1 ? "person" : "people"} · ${new Date().toLocaleDateString()}</p>
        <table><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead>
        <tbody>${rows.map((r) => `<tr>${r.map((v) => `<td>${esc(v)}</td>`).join("")}</tr>`).join("")}</tbody></table>
      </body></html>`);
      win.document.close();
      win.focus();
      setTimeout(() => { try { win.print(); } catch (_) {} }, 150);
    } catch (_) { _toast("Unable to load report data", "error"); }
  };

  const doWorkbook = async () => {
    if (typeof RB.deps.createReportWorkbook !== "function") { _toast("Workbooks aren't available here", "warn"); return; }
    els.foot.workbook.disabled = true;
    els.foot.workbook.textContent = "Creating…";
    try {
      const { headers, rows } = await currentMatrix();
      const title = RB.report.title;
      await RB.deps.createReportWorkbook({
        title,
        description: RB.report.description,
        headers,
        rows,
        report: { source: "people", fields: reportFields(RB.report), live: RB.live },
      });
      close();
      _toast(`Opening “${title}” in Workbooks${RB.live ? " — it refreshes on every open" : ""}`, "success");
    } catch (e) {
      console.warn("report → workbook:", e && e.message);
      els.foot.workbook.disabled = false;
      els.foot.workbook.textContent = "Open in Workbook";
      _toast("Couldn't create the workbook", "error");
    }
  };

  wrap.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Escape") close(); });
  wrap.addEventListener("change", (e) => {
    const live = e.target.closest("[data-rb-live]");
    if (live) { RB.live = live.getAttribute("data-rb-live") === "1"; return; }
    const f = e.target.closest("[data-rb-field]");
    if (!f) return;
    const key = f.getAttribute("data-rb-field");
    if (f.checked) RB.customSel.add(key); else RB.customSel.delete(key);
    footState();
    renderPreview();
  });
  wrap.addEventListener("click", async (e) => {
    if (e.target === wrap || e.target.closest("[data-rb-close]")) { close(); return; }
    if (e.target.closest("[data-rb-retry]")) { renderPreview(true); return; }
    const act = e.target.closest("[data-rb-act]");
    if (act && !act.disabled) {
      const a = act.getAttribute("data-rb-act");
      if (a === "csv") doCsv();
      else if (a === "print") doPrint();
      else if (a === "workbook") doWorkbook();
    }
  });

  selectReport("custom-people"); // the builder lands straight on the field picker
  setTimeout(() => wrap.querySelector("[data-rb-close]")?.focus(), 30);
}
