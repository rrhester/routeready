// Reports Builder — config-driven operational reports over RouteReady data.
//
// Self-contained ES module (same pattern as workbook.js): live.js imports it,
// injects the workbook-creation dependency via initReportsBuilder(), and
// registers renderReportsInto() as the Workbooks view's Reports screen.
//
// Architecture: three separated layers so future categories (Fleet, Schedule,
// Attendance, Hiring, Compliance) plug in without UI rewrites —
//   1. RB_FIELDS      · field key → column label + mapper over an enriched row
//   2. RB_REPORTS     · report definitions (id, category, title, fields, …)
//   3. fetchPeopleData· one dsp-scoped data pull per category, cached per open
// The screen renders whatever the configs describe; "Open in Workbook",
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

// ─── Schedule report fields ──────────────────────────────────────────────────
// Mappers receive an enriched shift row from fetchScheduleData.

function timeText(ts) {
  if (!ts) return DASH;
  const d = new Date(ts);
  if (isNaN(d)) return DASH;
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

const SHIFT_STATUS_LABEL = { scheduled: "Scheduled", completed: "Completed", late: "Late", no_show: "No-Show", called_off: "Called Off", vto: "VTO" };
function shiftStatusText(s) {
  return SHIFT_STATUS_LABEL[s] || cap(String(s || "").replace(/_/g, " ")) || DASH;
}

const RB_SCHED_FIELDS = {
  date: { label: "Date", map: (s) => s.date || DASH },
  day: { label: "Day", map: (s) => s._day },
  schedDriverName: { label: "Driver", map: (s) => s._driver },
  routeCode: { label: "Route", map: (s) => s.route_code || (s.is_cushion ? "Cushion" : DASH) },
  startTime: { label: "Start", map: (s) => s._start },
  endTime: { label: "End", map: (s) => s._end },
  blockHours: { label: "Hours", map: (s) => (s.block_hours ?? DASH) },
  shiftStatus: { label: "Status", map: (s) => s._status },
  shiftNotes: { label: "Notes", map: (s) => s.notes || DASH },
};
const RB_SCHED_ORDER = ["date", "day", "schedDriverName", "routeCode", "startTime", "endTime", "blockHours", "shiftStatus", "shiftNotes"];

// ─── Attendance report fields ────────────────────────────────────────────────
// Mappers receive a per-driver aggregate from fetchAttendanceData. The catalog
// is deliberately wide — the owner picks four fields for a light standing
// report or everything for a full attendance-file dump. Semantics mirror the
// live Attendance screen: excused shifts (a "deny" attendance decision) are
// stripped from every counter, VTO never counts against the driver, and
// coaching fields only count policy-produced attendance coachings.

const pctText = (v) => (v == null ? DASH : v + "%");

const RB_ATT_FIELDS = {
  // Driver
  attDriverName: { label: "Driver", map: (a) => a.name },
  attDriverStatus: { label: "Driver Status", map: (a) => a.driverStatus },
  attStation: { label: "Station", map: (a) => a.station },
  attHireDate: { label: "Hire Date", map: (a) => a.hireDate || DASH },
  attTenure: { label: "Tenure", map: (a) => a.tenure },
  // Shift counts
  scheduled: { label: "Scheduled", map: (a) => a.scheduled },
  worked: { label: "Worked", map: (a) => a.worked },
  onTime: { label: "On Time", map: (a) => a.onTime },
  hoursScheduled: { label: "Scheduled Hrs", map: (a) => a.hoursScheduled },
  hoursWorked: { label: "Worked Hrs", map: (a) => a.hoursWorked },
  // Rates
  completion: { label: "Attendance %", map: (a) => pctText(a.pct) },
  onTimePct: { label: "On-Time %", map: (a) => pctText(a.onTimePct) },
  lateRate: { label: "Late %", map: (a) => pctText(a.latePct) },
  absenceRate: { label: "Absence %", map: (a) => pctText(a.absencePct) },
  // Policy & points — always computed over the policy's rolling decay
  // window (not the report period), so they match the Attendance screen.
  policyPoints: { label: "Points", map: (a) => (a.policyPoints == null ? DASH : a.policyPoints) },
  policyOccurrences: { label: "Occurrences", map: (a) => (a.policyOccurrences == null ? DASH : a.policyOccurrences) },
  policyStanding: { label: "Standing", map: (a) => a.policyStanding || DASH },
  pointsToNext: { label: "Pts to Next", map: (a) => (a.pointsToNext == null ? DASH : a.pointsToNext) },
  nextStep: { label: "Next Step", map: (a) => a.nextStep || DASH },
  pointsBreakdown: { label: "Points Breakdown", map: (a) => a.pointsBreakdown || DASH },
  expiringPoints: { label: "Expiring Soon", map: (a) => (a.expiringPoints == null ? DASH : a.expiringPoints) },
  nextDecayDate: { label: "Next Decay", map: (a) => a.nextDecayDate || DASH },
  // Exceptions
  totalExceptions: { label: "Exceptions", map: (a) => a.totalExceptions },
  noShows: { label: "No-Shows", map: (a) => a.noShow },
  callOffs: { label: "Call-Offs", map: (a) => a.callOff },
  lates: { label: "Lates", map: (a) => a.late },
  excused: { label: "Excused", map: (a) => a.excused },
  // VTO — operator-granted, never scores and never counts against the
  // driver, but the owner still wants the give-backs on paper.
  vto: { label: "VTO", map: (a) => a.vto },
  vtoHours: { label: "VTO Hrs", map: (a) => a.vtoHours },
  vtoRate: { label: "VTO %", map: (a) => pctText(a.vtoPct) },
  lastVto: { label: "Last VTO", map: (a) => a.lastVto || DASH },
  // Exception history
  lastException: { label: "Last Exception", map: (a) => a.lastException || DASH },
  lastExceptionType: { label: "Last Exception Type", map: (a) => a.lastExceptionType || DASH },
  lastNoShow: { label: "Last No-Show", map: (a) => a.lastNoShow || DASH },
  lastCallOff: { label: "Last Call-Off", map: (a) => a.lastCallOff || DASH },
  lastLate: { label: "Last Late", map: (a) => a.lastLate || DASH },
  exceptionDay: { label: "Top Exception Day", map: (a) => a.exceptionDay || DASH },
  // Streaks & trend
  currentStreak: { label: "Clean Streak", map: (a) => (a.countable ? a.currentStreak : DASH) },
  bestStreak: { label: "Best Streak", map: (a) => (a.countable ? a.bestStreak : DASH) },
  trend: { label: "Trend", map: (a) => a.trend },
  perfect: { label: "Perfect", map: (a) => a.perfect },
  // Risk & coaching
  attRisk: { label: "Risk Level", map: (a) => a.risk },
  coachingCount: { label: "Coachings", map: (a) => a.coachings },
  lastCoachingDate: { label: "Last Coaching", map: (a) => a.lastCoachingDate || DASH },
  lastCoachingSeverity: { label: "Coaching Level", map: (a) => a.lastCoachingSeverity || DASH },
};

// Picker groups — rendered as sections so 33 checkboxes stay scannable.
// Column order in the sheet follows this same order.
const RB_ATT_GROUPS = [
  { label: "Driver", keys: ["attDriverName", "attDriverStatus", "attStation", "attHireDate", "attTenure"] },
  { label: "Shift counts", keys: ["scheduled", "worked", "onTime", "hoursScheduled", "hoursWorked"] },
  { label: "Rates", keys: ["completion", "onTimePct", "lateRate", "absenceRate"] },
  { label: "Policy & points", keys: ["policyPoints", "policyOccurrences", "policyStanding", "pointsToNext", "nextStep", "pointsBreakdown", "expiringPoints", "nextDecayDate"] },
  { label: "Exceptions", keys: ["totalExceptions", "noShows", "callOffs", "lates", "excused"] },
  { label: "VTO", keys: ["vto", "vtoHours", "vtoRate", "lastVto"] },
  { label: "Exception history", keys: ["lastException", "lastExceptionType", "lastNoShow", "lastCallOff", "lastLate", "exceptionDay"] },
  { label: "Streaks & trend", keys: ["currentStreak", "bestStreak", "trend", "perfect"] },
  { label: "Risk & coaching", keys: ["attRisk", "coachingCount", "lastCoachingDate", "lastCoachingSeverity"] },
];
const RB_ATT_ORDER = RB_ATT_GROUPS.flatMap((g) => g.keys);

const RB_ATT_PICKER_LABEL = {
  attDriverName: "Driver Name",
  scheduled: "Scheduled Shifts",
  worked: "Worked Shifts",
  onTime: "On-Time Shifts (no lates)",
  hoursScheduled: "Scheduled Hours",
  hoursWorked: "Worked Hours",
  completion: "Attendance %",
  onTimePct: "On-Time %",
  lateRate: "Late %",
  absenceRate: "Absence %",
  policyPoints: "Policy Points (rolling)",
  policyOccurrences: "Counted Occurrences",
  policyStanding: "Policy Standing",
  pointsToNext: "Points to Next Step",
  nextStep: "Next Ladder Step",
  pointsBreakdown: "Points Breakdown",
  expiringPoints: "Points Expiring in 14 Days",
  nextDecayDate: "Next Points Decay Date",
  totalExceptions: "Total Exceptions",
  excused: "Excused Absences",
  vto: "VTO Count (Voluntary Time Off)",
  vtoHours: "VTO Hours",
  vtoRate: "VTO % of Scheduled",
  lastVto: "Last VTO Date",
  lastException: "Last Exception Date",
  exceptionDay: "Most Common Exception Day",
  currentStreak: "Current Clean Streak",
  bestStreak: "Longest Clean Streak",
  trend: "Attendance Trend",
  perfect: "Perfect Attendance",
  attRisk: "Attendance Risk",
  coachingCount: "Attendance Coachings",
  lastCoachingDate: "Last Coaching Date",
  lastCoachingSeverity: "Last Coaching Severity",
};

// One-click starting points: a light standing report, the classic summary,
// the whole catalog, or a blank slate to build from scratch.
const RB_ATT_PRESETS = [
  ["light", "Light", ["attDriverName", "completion", "policyPoints", "policyStanding", "attRisk"]],
  ["standard", "Standard", ["attDriverName", "scheduled", "worked", "completion", "noShows", "callOffs", "lates", "vto", "policyPoints", "policyStanding", "attRisk"]],
  ["full", "Everything", RB_ATT_ORDER],
  ["none", "Clear", []],
];

// ─── Forms report fields ─────────────────────────────────────────────────────
// Unlike the other sources, the Forms report's columns are *dynamic*: they come
// from whichever form the operator picks, so the catalog is rebuilt per form
// (formsCatalogFrom below). Every column is fixed metadata (driver / when /
// review state) plus one column per input field on the form, mapped from the
// submission's `answers` blob (keyed by field id). This is what makes "create a
// form → generate its report" work: any published form becomes reportable.

// Field types that collect no answer — skipped so they never become columns.
const FORM_NON_INPUT = new Set(["section_header", "divider", "instructions"]);

// Human labels for a field with no author-set label, by type. Mirrors the
// builder's _FIELD_TYPE_LABELS so headers read the same as the form.
const FORM_TYPE_LABEL = {
  short_text: "Short text", long_text: "Long text", email: "Email", phone: "Phone",
  number: "Number", single_choice: "Single choice", multi_choice: "Multi-select",
  dropdown: "Dropdown", yes_no: "Yes / No", rating: "Rating", date: "Date", time: "Time",
  photo: "Photo", file: "File", signature: "Signature", gps: "GPS location",
};

// Submission triage states → display label (mirrors live.js _SUBM_STATUS).
const FORM_SUBM_STATUS = { submitted: "Submitted", reviewed: "Reviewed", follow_up: "Needs follow-up", resolved: "Resolved" };
function submStatusText(s) { return FORM_SUBM_STATUS[s] || cap(String(s || "").replace(/_/g, " ")) || "Submitted"; }
function submittedText(ts) {
  if (!ts) return DASH;
  const d = new Date(ts);
  if (isNaN(d)) return DASH;
  return d.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

// Plain-text rendering of one answer value — collapses signatures, photos,
// GPS, files, arrays, and booleans to something a report cell can hold.
function fmtAnswer(v, field) {
  if (v == null || v === "") return DASH;
  const t = field && field.type;
  if (t === "signature" || (typeof v === "string" && v.startsWith("data:image"))) return "Signed";
  if (v && typeof v === "object" && !Array.isArray(v) && "lat" in v && "lng" in v) {
    const acc = v.accuracy ? ` (±${v.accuracy}m)` : "";
    return `${Number(v.lat).toFixed(5)}, ${Number(v.lng).toFixed(5)}${acc}`;
  }
  if (v && typeof v === "object" && !Array.isArray(v) && (v.path || v.name)) {
    return v.error ? "Upload failed" : (v.name || "Attachment");
  }
  if (Array.isArray(v)) return v.length ? v.join(", ") : DASH;
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

// Constant metadata columns present on every Forms report. Driver + when lead;
// review state trails after the form's own answer columns.
const FORM_META = {
  fsDriver: { label: "Driver", map: (s) => s.driver_name || DASH },
  fsSubmitted: { label: "Submitted", map: (s) => submittedText(s.submitted_at) },
  fsStatus: { label: "Status", map: (s) => submStatusText(s.status) },
  fsFlagged: { label: "Flagged", map: (s) => (s.flagged ? "Yes" : "No") },
  fsNotes: { label: "Review Notes", map: (s) => s.notes || DASH },
};

// Build a { cat, order } field catalog for one form. Answer columns are keyed
// by field id (unique per form) so they never collide with the fs* meta keys.
function formsCatalogFrom(form) {
  const cat = {
    fsDriver: FORM_META.fsDriver,
    fsSubmitted: FORM_META.fsSubmitted,
    fsStatus: FORM_META.fsStatus,
    fsFlagged: FORM_META.fsFlagged,
    fsNotes: FORM_META.fsNotes,
  };
  const fieldOrder = [];
  for (const f of (Array.isArray(form && form.fields) ? form.fields : [])) {
    if (!f || !f.id || FORM_NON_INPUT.has(f.type)) continue;
    const field = f;
    cat[f.id] = {
      label: f.label || FORM_TYPE_LABEL[f.type] || "Field",
      map: (s) => fmtAnswer((s.answers && typeof s.answers === "object" ? s.answers : {})[field.id], field),
    };
    fieldOrder.push(f.id);
  }
  // Driver + when, then the form's answers, then the review columns.
  const order = ["fsDriver", "fsSubmitted", ...fieldOrder, "fsStatus", "fsFlagged", "fsNotes"];
  return { cat, order };
}

// ─── Report catalog ──────────────────────────────────────────────────────────

const RB_CATEGORIES = [
  { key: "people", label: "People", enabled: true },
  { key: "fleet", label: "Fleet", enabled: false },
  { key: "schedule", label: "Schedule", enabled: true },
  { key: "attendance", label: "Attendance", enabled: true },
  { key: "forms", label: "Forms", enabled: true },
  { key: "hiring", label: "Hiring", enabled: false },
  { key: "compliance", label: "Compliance", enabled: false },
  { key: "custom", label: "Custom", enabled: false },
];

const RB_REPORTS = [
  { id: "custom-people", category: "people", source: "people", title: "People Report", description: "Choose the fields to include. The report updates as you pick.", fields: [], custom: true },
  { id: "custom-schedule", category: "schedule", source: "schedule", title: "Schedule Report", description: "One row per shift for the period — open shifts show as “Open”.", fields: [], custom: true },
  { id: "custom-attendance", category: "attendance", source: "attendance", title: "Attendance Report", description: "Per-driver attendance — points, standing, and decay follow your attendance policy's rolling window no matter which period you pick. Excused shifts and VTO never count against a driver.", fields: [], custom: true },
  { id: "custom-forms", category: "forms", source: "forms", title: "Forms Report", description: "Pick a form to turn its submissions into a report — one row per submission, one column per field.", fields: [], custom: true },
];

// Per-source wiring: field catalog, picker order, and the data fetch.
// (fetch functions are declared below; function-hoisting makes this safe.)
const RB_SOURCES = {
  people: { fields: RB_FIELDS, order: RB_CUSTOM_FIELDS, pickerLabels: RB_PICKER_LABEL, noun: ["person", "people"], ranges: null },
  schedule: {
    fields: RB_SCHED_FIELDS, order: RB_SCHED_ORDER, pickerLabels: {}, noun: ["shift", "shifts"],
    ranges: [["week", "This week (Mon–Sun)"], ["today", "Today"], ["next7", "Next 7 days"], ["last7", "Last 7 days"]],
  },
  attendance: {
    fields: RB_ATT_FIELDS, order: RB_ATT_ORDER, groups: RB_ATT_GROUPS, presets: RB_ATT_PRESETS,
    pickerLabels: RB_ATT_PICKER_LABEL, noun: ["driver", "drivers"],
    ranges: [["policy", "Policy window (rolling decay)"], ["7", "Last 7 days"], ["14", "Last 14 days"], ["30", "Last 30 days"], ["60", "Last 60 days"], ["90", "Last 90 days"]],
  },
  // Forms · fields + order are dynamic (built per selected form), so the
  // static entries here are just placeholders; fieldsFor/orderFor read the
  // live catalog off RB.forms instead.
  forms: {
    fields: FORM_META, order: [], pickerLabels: {}, noun: ["submission", "submissions"],
    ranges: [["all", "All time"], ["7", "Last 7 days"], ["30", "Last 30 days"], ["90", "Last 90 days"]],
  },
};

// Field catalog + order for a source. Forms is dynamic (per selected form);
// everything else is the static config above.
function fieldsFor(source) { return source === "forms" ? RB.forms.catalog : (RB_SOURCES[source] || RB_SOURCES.people).fields; }
function orderFor(source) { return source === "forms" ? RB.forms.order : (RB_SOURCES[source] || RB_SOURCES.people).order; }

// ─── Data layer ──────────────────────────────────────────────────────────────

const RB = {
  deps: {},          // { createReportWorkbook } injected by live.js
  data: null,        // enriched people rows, cached while the screen is open
  loading: null,     // in-flight people promise
  cache: new Map(),  // "<source>|<range>" -> rows (schedule / attendance)
  report: null,      // selected report def
  source: "people",
  sel: {
    people: new Set(["driverName", "phoneNumber", "email", "status"]),
    schedule: new Set(["date", "schedDriverName", "routeCode", "startTime", "shiftStatus"]),
    attendance: new Set(["attDriverName", "scheduled", "worked", "completion", "noShows", "callOffs", "lates", "vto", "policyPoints", "policyStanding", "attRisk"]),
    forms: new Set(),  // populated by selectForm from the chosen form's fields
  },
  range: { schedule: "week", attendance: "policy", forms: "all" },
  // Forms source state: the operator's form list, the picked form, and its
  // dynamically-built column catalog.
  forms: { list: [], formId: "", catalog: {}, order: [], loaded: false },
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

// ─── Schedule + attendance data ─────────────────────────────────────────────

function isoDay(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function scheduleRangeBounds(range) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const add = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  if (range === "today") return [isoDay(today), isoDay(today)];
  if (range === "next7") return [isoDay(today), isoDay(add(today, 6))];
  if (range === "last7") return [isoDay(add(today, -6)), isoDay(today)];
  const dow = (today.getDay() + 6) % 7; // Monday-anchored week
  const mon = add(today, -dow);
  return [isoDay(mon), isoDay(add(mon, 6))];
}

async function fetchScheduleData(range, force) {
  const key = "schedule|" + (range || "week");
  if (!force && RB.cache.has(key)) return RB.cache.get(key);
  const sb = _sb(), dsp = _dsp();
  if (!sb || !dsp) throw new Error("no session");
  const [lo, hi] = scheduleRangeBounds(range || "week");
  const [shifts, drv] = await Promise.all([
    sb.from("shifts")
      .select("driver_id, date, starts_at, ends_at, route_code, status, block_hours, notes, is_cushion")
      .eq("dsp_id", dsp.id)
      .gte("date", lo).lte("date", hi)
      .order("date").order("starts_at")
      .limit(5000),
    sb.from("drivers").select("id, full_name, preferred_name").eq("dsp_id", dsp.id).limit(2000)
      .then((r) => r, () => ({ data: [] })),
  ]);
  if (shifts.error) throw shifts.error;
  const nameBy = new Map((drv.data || []).map((d) => [d.id, d.preferred_name || d.full_name]));
  const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const rows = (shifts.data || []).map((s) => {
    const d = new Date(s.date + "T00:00:00");
    return {
      ...s,
      _driver: s.driver_id ? nameBy.get(s.driver_id) || "Driver" : "Open",
      _day: isNaN(d) ? DASH : DOW[d.getDay()],
      _start: timeText(s.starts_at),
      _end: timeText(s.ends_at),
      _status: shiftStatusText(s.status),
    };
  });
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : String(a.starts_at || "").localeCompare(String(b.starts_at || "")) || a._driver.localeCompare(b._driver)));
  RB.cache.set(key, rows);
  return rows;
}

// Coachings count only when the attendance policy produced them — same
// filter as the live Attendance screen (triggering shift stamped, or a
// policy source tag from the approval auto-fire / report send / backfill).
const ATT_POLICY_COACH_SOURCES = new Set(["auto_accrual", "attendance_decide", "report"]);
const ATT_SEV_LABEL = { verbal: "Verbal", concern: "Concern", written: "Written", warning: "Warning", final: "Final", termination: "Termination" };
const ATT_EXCEPTION_LABEL = { late: "Late", no_show: "No-Show", called_off: "Call-Off" };

// Highest ladder rung whose threshold the driver's points have reached —
// same walk as live.js's _evalLadderRung (ladder arrives sorted ascending).
function attLadderRung(ladder, points) {
  let rung = null;
  for (const r of (ladder || [])) {
    if (points >= r.threshold) rung = r;
    else break;
  }
  return rung;
}

async function fetchAttendanceData(range, force) {
  // The normalized attendance policy (injected by live.js). Points,
  // standing, and decay fields all derive from it; when it's not
  // available those fields render as "—" and the window falls back to 90d.
  const EVAL = typeof RB.deps.evalPolicy === "function" ? (RB.deps.evalPolicy() || null) : null;
  const decayDays = EVAL && Number(EVAL.decay_days) > 0 ? Number(EVAL.decay_days) : 90;
  const days = range === "policy" ? decayDays : Math.max(1, parseInt(range, 10) || 30);
  const key = "attendance|" + (range === "policy" ? "policy" : days) + "|" + decayDays;
  if (!force && RB.cache.has(key)) return RB.cache.get(key);
  const sb = _sb(), dsp = _dsp();
  if (!sb || !dsp) throw new Error("no session");
  // Fetch the wider of the two windows: report counters use the picked
  // period, rolling points always use the policy decay window.
  const fetchDays = Math.max(days, decayDays);
  const from = new Date(); from.setDate(from.getDate() - (fetchDays - 1));
  const reportFrom = new Date(); reportFrom.setDate(reportFrom.getDate() - (days - 1));
  const reportFromIso = isoDay(reportFrom);
  const decayFrom = new Date(); decayFrom.setDate(decayFrom.getDate() - (decayDays - 1));
  const decayFromIso = isoDay(decayFrom);
  const [drv, shifts, dec, coach] = await Promise.all([
    sb.from("drivers")
      .select("id, full_name, preferred_name, status, hire_date, station:station_id (code)")
      .eq("dsp_id", dsp.id)
      .neq("status", "terminated")
      .order("full_name")
      .limit(1000),
    sb.from("shifts")
      .select("id, driver_id, status, date, block_hours")
      .eq("dsp_id", dsp.id)
      .in("status", ["completed", "late", "no_show", "called_off", "vto"])
      .gte("date", isoDay(from))
      .order("date")
      .limit(20000),
    // Operator "deny" decisions = excused shifts; strip from every counter.
    sb.from("attendance_decisions")
      .select("shift_id")
      .eq("dsp_id", dsp.id)
      .eq("decision", "deny")
      .gte("created_at", from.toISOString())
      .limit(5000)
      .then((r) => r, () => ({ data: [] })),
    sb.from("coachings")
      .select("driver_id, severity, occurred_at, triggering_shift_id, metadata")
      .eq("dsp_id", dsp.id)
      .eq("topic", "attendance")
      .eq("driver_visible", true)
      .is("archived_at", null)
      .gte("occurred_at", reportFrom.toISOString())
      .order("occurred_at", { ascending: false })
      .limit(5000)
      .then((r) => r, () => ({ data: [] })),
  ]);
  if (drv.error) throw drv.error;
  if (shifts.error) throw shifts.error;

  const excusedIds = new Set((dec.data || []).map((d) => d.shift_id));

  const coachBy = new Map(); // driver_id → { n, last, lastSev } (rows arrive newest-first)
  for (const c of (coach.data || [])) {
    if (c.triggering_shift_id == null && !ATT_POLICY_COACH_SOURCES.has(c.metadata && c.metadata.source)) continue;
    const a = coachBy.get(c.driver_id) || { n: 0, last: null, lastSev: null };
    a.n++;
    if (!a.last) { a.last = String(c.occurred_at || "").slice(0, 10); a.lastSev = ATT_SEV_LABEL[c.severity] || cap(c.severity) || null; }
    coachBy.set(c.driver_id, a);
  }

  // Trend halves: recent half = the last ceil(days/2) days of the window.
  const mid = new Date(); mid.setDate(mid.getDate() - (Math.ceil(days / 2) - 1));
  const midIso = isoDay(mid);

  // Per-event point values from the policy. A kind with no Event block
  // (or 0 points) is logged but never scores — same as the live screen.
  const PTS = {
    late: EVAL && EVAL.events.late ? Number(EVAL.events.late.points) || 0 : 0,
    called_off: EVAL && EVAL.events.callout ? Number(EVAL.events.callout.points) || 0 : 0,
    no_show: EVAL && EVAL.events.no_show ? Number(EVAL.events.no_show.points) || 0 : 0,
  };
  // An event's points fall off decayDays after its date; "expiring soon"
  // means within the next 14 days.
  const expireCutoff = new Date(); expireCutoff.setDate(expireCutoff.getDate() - (decayDays - 14));
  const expireCutoffIso = isoDay(expireCutoff);

  const blank = () => ({
    scheduled: 0, worked: 0, onTime: 0, late: 0, noShow: 0, callOff: 0, vto: 0, excused: 0,
    hoursScheduled: 0, hoursWorked: 0,
    lastException: null, lastExceptionType: null, lastNoShow: null, lastCallOff: null, lastLate: null,
    vtoHours: 0, lastVto: null,
    dayCounts: [0, 0, 0, 0, 0, 0, 0],
    run: 0, bestStreak: 0,
    oldWorked: 0, oldCountable: 0, newWorked: 0, newCountable: 0,
    points: 0, occ: 0, expiring: 0, oldestCounted: null,
    pLate: 0, pCallOff: 0, pNoShow: 0,
  });
  const agg = new Map();
  for (const sh of (shifts.data || [])) { // rows arrive date-ascending
    if (!sh.driver_id) continue;
    let a = agg.get(sh.driver_id);
    if (!a) { a = blank(); agg.set(sh.driver_id, a); }
    const hrs = Number(sh.block_hours) || 0;
    const inReport = sh.date >= reportFromIso;
    if (inReport) { a.scheduled++; a.hoursScheduled += hrs; }
    // Excused and VTO count toward volume only — they never touch rates,
    // exception counters, points, or the clean streak.
    if (excusedIds.has(sh.id)) { if (inReport) a.excused++; continue; }
    if (sh.status === "vto") {
      if (inReport) { a.vto++; a.vtoHours += hrs; a.lastVto = sh.date; } // ascending order
      continue;
    }
    // Rolling points over the policy decay window, independent of the
    // report period.
    const pts = PTS[sh.status] || 0;
    if (EVAL && pts > 0 && sh.date >= decayFromIso) {
      a.points += pts;
      a.occ++;
      if (sh.date <= expireCutoffIso) a.expiring += pts;
      if (!a.oldestCounted) a.oldestCounted = sh.date; // ascending order
      if (sh.status === "late") a.pLate++;
      else if (sh.status === "called_off") a.pCallOff++;
      else if (sh.status === "no_show") a.pNoShow++;
    }
    if (!inReport) continue;
    const workedShift = sh.status === "completed" || sh.status === "late";
    if (sh.date >= midIso) { a.newCountable++; if (workedShift) a.newWorked++; }
    else { a.oldCountable++; if (workedShift) a.oldWorked++; }
    if (workedShift) {
      a.worked++;
      a.hoursWorked += hrs;
      if (sh.status === "completed") a.onTime++;
      a.run++;
      if (a.run > a.bestStreak) a.bestStreak = a.run;
    } else {
      a.run = 0; // an absence breaks the clean streak; a late doesn't
    }
    if (sh.status !== "completed") {
      a.lastException = sh.date;
      a.lastExceptionType = ATT_EXCEPTION_LABEL[sh.status] || cap(sh.status);
      const d = new Date(sh.date + "T00:00:00");
      if (!isNaN(d)) a.dayCounts[d.getDay()]++;
      if (sh.status === "late") a.lastLate = sh.date;
      else if (sh.status === "no_show") { a.noShow++; a.lastNoShow = sh.date; }
      else if (sh.status === "called_off") { a.callOff++; a.lastCallOff = sh.date; }
    }
    if (sh.status === "late") a.late++;
  }

  // High/Medium/Low mirrors the roster risk model's attendance half
  const RANK = { High: 0, Medium: 1, Low: 2 };
  const MON_FIRST = [1, 2, 3, 4, 5, 6, 0];
  const rows = (drv.data || []).map((p) => {
    const a = agg.get(p.id) || blank();
    const countable = a.worked + a.noShow + a.callOff;
    const pct = countable ? Math.round((a.worked / countable) * 100) : null;
    let risk = "Low";
    if (a.noShow >= 1 || a.callOff >= 3) risk = "High";
    else if (a.callOff >= 1 || a.late >= 2 || (pct != null && pct < 85)) risk = "Medium";
    // Trend needs a real sample on both halves of the window.
    let trend = DASH;
    if (a.oldCountable >= 3 && a.newCountable >= 3) {
      const diff = Math.round((a.newWorked / a.newCountable) * 100) - Math.round((a.oldWorked / a.oldCountable) * 100);
      trend = diff >= 5 ? "Improving" : diff <= -5 ? "Slipping" : "Steady";
    }
    let exceptionDay = null, exceptionDayMax = 0;
    for (const i of MON_FIRST) {
      if (a.dayCounts[i] > exceptionDayMax) { exceptionDayMax = a.dayCounts[i]; exceptionDay = DAY_LABEL[["sun", "mon", "tue", "wed", "thu", "fri", "sat"][i]]; }
    }
    // Policy standing from the rolling point total — ladder walk, then the
    // first-30 strict rule, mirroring the live Attendance screen.
    let policyPoints = null, policyOccurrences = null, policyStanding = null,
      pointsToNext = null, nextStep = null, pointsBreakdown = null,
      expiringPoints = null, nextDecayDate = null;
    if (EVAL) {
      policyPoints = a.points;
      policyOccurrences = a.occ;
      expiringPoints = a.expiring;
      if (a.oldestCounted) {
        const dd = new Date(a.oldestCounted + "T00:00:00");
        if (!isNaN(dd)) { dd.setDate(dd.getDate() + decayDays); nextDecayDate = isoDay(dd); }
      }
      const parts = [];
      if (a.pLate) parts.push(`${a.pLate} late × ${PTS.late}`);
      if (a.pCallOff) parts.push(`${a.pCallOff} call-off × ${PTS.called_off}`);
      if (a.pNoShow) parts.push(`${a.pNoShow} no-show × ${PTS.no_show}`);
      pointsBreakdown = parts.join(" · ") || null;
      if (!EVAL.enabled) {
        policyStanding = "Policy off";
      } else {
        const rung = attLadderRung(EVAL.ladder, a.points);
        policyStanding = rung ? (ATT_SEV_LABEL[rung.severity] || cap(rung.severity)) : "Clear";
        if (EVAL.first_30 && EVAL.first_30.active && p.hire_date && a.occ > 0 &&
            (policyStanding === "Clear" || policyStanding === "Verbal")) {
          const sinceHire = Math.floor((Date.now() - new Date(p.hire_date + "T12:00:00").getTime()) / 86400000);
          if (sinceHire >= 0 && sinceHire <= (EVAL.first_30.days || 30)) policyStanding = "Written · 1st 30";
        }
        const next = (EVAL.ladder || []).find((r) => r.threshold > a.points);
        if (next) {
          pointsToNext = next.threshold - a.points;
          nextStep = ATT_SEV_LABEL[next.severity] || cap(next.severity);
        }
      }
    }
    const co = coachBy.get(p.id) || { n: 0, last: null, lastSev: null };
    return {
      name: p.preferred_name || p.full_name || DASH,
      driverStatus: cap(p.status) || DASH,
      station: (p.station && p.station.code) || DASH,
      hireDate: p.hire_date || null,
      tenure: tenureText(p.hire_date),
      scheduled: a.scheduled, worked: a.worked, onTime: a.onTime,
      hoursScheduled: a.hoursScheduled, hoursWorked: a.hoursWorked,
      countable, pct,
      onTimePct: countable ? Math.round((a.onTime / countable) * 100) : null,
      latePct: countable ? Math.round((a.late / countable) * 100) : null,
      absencePct: countable ? Math.round(((a.noShow + a.callOff) / countable) * 100) : null,
      totalExceptions: a.noShow + a.callOff + a.late,
      noShow: a.noShow, callOff: a.callOff, late: a.late, excused: a.excused,
      vto: a.vto, vtoHours: a.vtoHours, lastVto: a.lastVto,
      vtoPct: a.scheduled ? Math.round((a.vto / a.scheduled) * 100) : null,
      lastException: a.lastException, lastExceptionType: a.lastExceptionType,
      lastNoShow: a.lastNoShow, lastCallOff: a.lastCallOff, lastLate: a.lastLate,
      exceptionDay,
      currentStreak: a.run, bestStreak: a.bestStreak,
      trend,
      perfect: countable ? (a.noShow + a.callOff + a.late === 0 ? "Yes" : "No") : DASH,
      risk,
      policyPoints, policyOccurrences, policyStanding, pointsToNext, nextStep,
      pointsBreakdown, expiringPoints, nextDecayDate,
      coachings: co.n, lastCoachingDate: co.last, lastCoachingSeverity: co.lastSev,
    };
  });
  // Highest rolling points first (the Attendance screen's default), then
  // risk, then name — so the report leads with who needs attention.
  rows.sort((x, y) => ((y.policyPoints || 0) - (x.policyPoints || 0)) || (RANK[x.risk] - RANK[y.risk]) || x.name.localeCompare(y.name));
  RB.cache.set(key, rows);
  return rows;
}

// ─── Forms data ──────────────────────────────────────────────────────────────

// The operator's forms (with their field defs, so the report catalog needs no
// extra round-trip). list_forms already excludes archived forms and returns
// full rows including `fields`.
async function fetchFormsList(force) {
  if (RB.forms.loaded && !force) return RB.forms.list;
  const sb = _sb(), dsp = _dsp();
  if (!sb || !dsp) throw new Error("no session");
  const { data, error } = await sb.rpc("list_forms");
  if (error) throw error;
  RB.forms.list = (Array.isArray(data) ? data : []).map((f) => ({
    id: f.id,
    title: f.title || "Untitled form",
    status: f.status,
    fields: Array.isArray(f.fields) ? f.fields : [],
  }));
  RB.forms.loaded = true;
  return RB.forms.list;
}

// One row per submission for the selected form, honoring the period filter.
async function fetchFormSubmissionsData(force) {
  const formId = RB.forms.formId;
  if (!formId) return [];
  const range = RB.range.forms || "all";
  const key = "forms|" + formId + "|" + range;
  if (!force && RB.cache.has(key)) return RB.cache.get(key);
  const sb = _sb(), dsp = _dsp();
  if (!sb || !dsp) throw new Error("no session");
  const { data, error } = await sb.rpc("list_form_submissions", { p_form_id: formId });
  if (error) throw error;
  let rows = Array.isArray(data) ? data : [];
  if (range !== "all") {
    const days = parseInt(range, 10) || 30;
    const from = Date.now() - days * 86400000;
    rows = rows.filter((s) => { const t = s.submitted_at ? Date.parse(s.submitted_at) : NaN; return Number.isFinite(t) && t >= from; });
  }
  RB.cache.set(key, rows);
  return rows;
}

function getRows(source, force) {
  if (source === "schedule") return fetchScheduleData(RB.range.schedule, force);
  if (source === "attendance") return fetchAttendanceData(RB.range.attendance, force);
  if (source === "forms") return fetchFormSubmissionsData(force);
  return fetchPeopleData(force);
}

// ─── Matrix builder (shared by preview, workbook, CSV, print) ────────────────

function reportFields(report) {
  const order = orderFor(report.source);
  return report.custom ? order.filter((k) => RB.sel[report.source].has(k)) : report.fields;
}

function buildMatrix(report, rows) {
  const cat = fieldsFor(report.source);
  const keys = reportFields(report);
  return {
    headers: keys.map((k) => cat[k].label),
    rows: rows.map((r) => keys.map((k) => cat[k].map(r))),
  };
}

// Display title — for a Forms report, name the selected form so the workbook,
// print header, and CSV filename read like "Morning DVIC · Submissions".
function reportTitle() {
  if (RB.source === "forms") {
    const f = RB.forms.list.find((x) => x.id === RB.forms.formId);
    return (f && f.title ? f.title : "Form") + " · Submissions";
  }
  return RB.report.title;
}

// Data provider for live report workbooks — workbook.js calls this (via
// registerReportProvider in live.js) with the stored report spec whenever a
// live report is opened, and rewrites the sheet with what it returns.
export async function buildReportData(spec) {
  const source = spec && RB_SOURCES[spec.source] ? spec.source : "people";

  // Forms is self-contained: the workbook may be re-opened in a later session
  // with an empty RB, so rebuild the column catalog straight from the form's
  // current fields (get_form) and pull fresh submissions for it.
  if (source === "forms") {
    const formId = spec && spec.formId;
    if (!formId) return null;
    const sb = _sb(), dsp = _dsp();
    if (!sb || !dsp) return null;
    const [{ data: form }, subs] = await Promise.all([
      sb.rpc("get_form", { p_id: formId }).then((r) => r, () => ({ data: null })),
      sb.rpc("list_form_submissions", { p_form_id: formId }).then((r) => r, () => ({ data: [] })),
    ]);
    let rows = Array.isArray(subs && subs.data) ? subs.data : [];
    const range = (spec && spec.range) || "all";
    if (range !== "all") {
      const days = parseInt(range, 10) || 30;
      const from = Date.now() - days * 86400000;
      rows = rows.filter((s) => { const t = s.submitted_at ? Date.parse(s.submitted_at) : NaN; return Number.isFinite(t) && t >= from; });
    }
    const { cat } = formsCatalogFrom(form || {});
    const keys = (Array.isArray(spec && spec.fields) ? spec.fields : []).filter((k) => cat[k]);
    if (!keys.length) return null;
    return {
      headers: keys.map((k) => cat[k].label),
      rows: rows.map((r) => keys.map((k) => cat[k].map(r))),
    };
  }

  let rows;
  if (source === "schedule") rows = await fetchScheduleData((spec && spec.range) || "week", true);
  else if (source === "attendance") rows = await fetchAttendanceData((spec && spec.range) || "30", true);
  else rows = await fetchPeopleData(true); // always fresh — that's the point
  const cat = RB_SOURCES[source].fields;
  const keys = (Array.isArray(spec && spec.fields) ? spec.fields : []).filter((k) => cat[k]);
  if (!keys.length) return null;
  return {
    headers: keys.map((k) => cat[k].label),
    rows: rows.map((r) => keys.map((k) => cat[k].map(r))),
  };
}

function toCsv(headers, rows) {
  const cell = (v) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return [headers, ...rows].map((r) => r.map(cell).join(",")).join("\r\n");
}

// ─── Reports screen ──────────────────────────────────────────────────────────
// Rendered as a full page inside the Workbooks view (the strip's Reports
// tab), not a modal. workbook.js mounts it via registerReportsScreen.

export function renderReportsInto(container) {
  if (!_sb() || !_dsp()) {
    container.innerHTML = `<div class="rr-empty"><div class="rr-empty-title">Sign in to build reports</div></div>`;
    return;
  }
  RB.report = RB_REPORTS[0];
  RB.source = "people";
  RB.data = null; // fresh data each visit — reports reflect the operation now
  RB.cache = new Map();
  // Re-pull the forms list each visit (forms may have been created/edited);
  // keep the last-picked form id so re-selecting it feels sticky.
  RB.forms = { list: [], formId: RB.forms.formId || "", catalog: {}, order: [], loaded: false };

  container.innerHTML = `
    <div class="rr-reports-surface" data-rb-root>
      <div class="rb-body">
        <nav class="rb-cats" aria-label="Report categories">
          ${RB_CATEGORIES.map((c) => `
            <button type="button" class="rb-cat ${c.key === "people" ? "is-active" : ""}" data-rb-cat="${c.key}" ${c.enabled ? "" : "disabled"}>
              ${esc(c.label)}${c.enabled ? "" : `<span class="rb-soon">Soon</span>`}
            </button>`).join("")}
        </nav>
        <div class="rb-main" data-rb-main></div>
        <div class="rb-preview" data-rb-preview>
          <div class="rb-preview-blank">Pick fields to preview the report.</div>
        </div>
      </div>
      <div class="rb-foot">
        <span class="rb-foot-spacer"></span>
        <button class="btn btn-ghost btn-sm" type="button" data-rb-act="csv" disabled>Download CSV</button>
        <button class="btn btn-ghost btn-sm" type="button" data-rb-act="print" disabled>Print</button>
        <button class="btn btn-primary btn-sm" type="button" data-rb-act="workbook" disabled>Open in Workbook</button>
      </div>
    </div>`;
  const wrap = container.querySelector("[data-rb-root]");

  const els = {
    main: wrap.querySelector("[data-rb-main]"),
    preview: wrap.querySelector("[data-rb-preview]"),
    foot: { csv: wrap.querySelector('[data-rb-act="csv"]'), print: wrap.querySelector('[data-rb-act="print"]'), workbook: wrap.querySelector('[data-rb-act="workbook"]') },
  };

  const footState = () => {
    const ready = !!RB.report && reportFields(RB.report).length > 0;
    els.foot.csv.disabled = !ready;
    els.foot.print.disabled = !ready;
    els.foot.workbook.disabled = !ready;
  };

  const renderCustomPanel = () => {
    const src = RB_SOURCES[RB.source];
    const sel = RB.sel[RB.source];
    const cat = fieldsFor(RB.source);
    const order = orderFor(RB.source);
    const fieldRow = (k) => `
          <label class="rb-field-check">
            <input type="checkbox" data-rb-field="${k}" ${sel.has(k) ? "checked" : ""}>
            <span>${esc((src.pickerLabels && src.pickerLabels[k]) || (cat[k] && cat[k].label) || k)}</span>
          </label>`;
    // Forms leads with a form picker — the report is built from that form's
    // submissions, so choosing the form defines the columns.
    const formPicker = RB.source === "forms" ? `
      <label class="rb-range-row">
        <span class="rb-range-label">Form</span>
        <select class="rb-range-sel" data-rb-form aria-label="Form">
          ${RB.forms.list.map((f) => `<option value="${esc(f.id)}" ${RB.forms.formId === f.id ? "selected" : ""}>${esc(f.title)}${f.status && f.status !== "published" ? " (" + esc(f.status) + ")" : ""}</option>`).join("")}
        </select>
      </label>` : "";
    els.main.innerHTML = `
      <p class="rb-main-head">${esc(RB.report.title)}</p>
      <p class="rb-main-sub">${esc(RB.report.description)}</p>
      ${formPicker}
      ${src.ranges ? `
      <label class="rb-range-row">
        <span class="rb-range-label">Period</span>
        <select class="rb-range-sel" data-rb-range aria-label="Report period">
          ${src.ranges.map(([v, label]) => `<option value="${v}" ${RB.range[RB.source] === v ? "selected" : ""}>${esc(label)}</option>`).join("")}
        </select>
      </label>` : ""}
      ${src.presets ? `
      <div class="rb-presets" role="group" aria-label="Quick picks">
        <span class="rb-presets-label">Quick picks</span>
        ${src.presets.map(([id, label]) => `<button type="button" class="rb-preset" data-rb-preset="${id}">${esc(label)}</button>`).join("")}
      </div>` : ""}
      <div class="rb-fields">
        ${src.groups
          ? src.groups.map((g) => `<p class="rb-field-group">${esc(g.label)}</p>` + g.keys.map(fieldRow).join("")).join("")
          : order.map(fieldRow).join("")}
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
    els.preview.innerHTML = `<div class="rb-state"><span class="rb-spinner" aria-hidden="true"></span>Loading report data…</div>`;
    let data;
    try { data = await getRows(report.source, retry === true); }
    catch (e) {
      console.warn("reports data:", e && e.message);
      if (RB.report !== report || !wrap.isConnected) return;
      RB.loading = null;
      els.preview.innerHTML = `<div class="rb-state is-error">Unable to load report data.<button type="button" class="btn btn-ghost btn-sm" data-rb-retry>Retry</button></div>`;
      footState();
      return;
    }
    if (RB.report !== report || !wrap.isConnected) return; // navigated away while loading
    const noun = (RB_SOURCES[report.source] || RB_SOURCES.people).noun;
    if (!data.length) {
      els.preview.innerHTML = `<div class="rb-state">No ${esc(noun[1])} found for this period.</div>`;
      footState();
      return;
    }
    const { headers, rows } = buildMatrix(report, data);
    const shown = rows.slice(0, 25);
    els.preview.innerHTML = `
      <p class="rb-preview-title">${esc(reportTitle())}</p>
      <p class="rb-preview-sub">${rows.length} ${rows.length === 1 ? esc(noun[0]) : esc(noun[1])}${rows.length > shown.length ? ` · showing first ${shown.length}` : ""}</p>
      <div class="rb-table-wrap">
        <table class="rb-table">
          <thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead>
          <tbody>${shown.map((r) => `<tr>${r.map((v) => `<td>${esc(v)}</td>`).join("")}</tr>`).join("")}</tbody>
        </table>
      </div>`;
    footState();
  };

  // Pick a form: rebuild its column catalog and default-select driver + when +
  // every input field (review columns stay opt-in).
  const selectForm = (id) => {
    RB.forms.formId = id;
    const form = RB.forms.list.find((f) => f.id === id) || null;
    const { cat, order } = formsCatalogFrom(form || {});
    RB.forms.catalog = cat;
    RB.forms.order = order;
    const sel = new Set(["fsDriver", "fsSubmitted", "fsStatus"]);
    for (const f of (form && form.fields) || []) {
      if (f && f.id && !FORM_NON_INPUT.has(f.type)) sel.add(f.id);
    }
    RB.sel.forms = sel;
  };

  // Forms category: load the operator's form list, then render the picker.
  const enterFormsSource = async () => {
    els.main.innerHTML = `<div class="rb-state"><span class="rb-spinner" aria-hidden="true"></span>Loading forms…</div>`;
    els.preview.innerHTML = `<div class="rb-preview-blank">Pick a form to build its submission report.</div>`;
    footState();
    let list;
    try { list = await fetchFormsList(); }
    catch (e) {
      console.warn("reports forms list:", e && e.message);
      if (RB.source !== "forms" || !wrap.isConnected) return;
      els.main.innerHTML = `<div class="rb-state is-error">Couldn't load your forms.<button type="button" class="btn btn-ghost btn-sm" data-rb-forms-retry>Retry</button></div>`;
      return;
    }
    if (RB.source !== "forms" || !wrap.isConnected) return; // navigated away
    if (!list.length) {
      els.main.innerHTML = `
        <p class="rb-main-head">${esc(RB.report.title)}</p>
        <p class="rb-main-sub">${esc(RB.report.description)}</p>
        <div class="rb-state">No forms yet. Build a form on the Workflows page — its submissions will be reportable here.</div>`;
      footState();
      return;
    }
    // Keep the last-picked form if it still exists, else pick the first.
    if (!RB.forms.formId || !list.some((f) => f.id === RB.forms.formId)) selectForm(list[0].id);
    else selectForm(RB.forms.formId);
    renderCustomPanel();
    footState();
    renderPreview();
  };

  const selectReport = (id) => {
    const report = RB_REPORTS.find((r) => r.id === id);
    if (!report) return;
    RB.report = report;
    RB.source = report.source;
    if (report.source === "forms") { enterFormsSource(); return; }
    renderCustomPanel();
    footState();
    renderPreview();
  };

  const currentMatrix = async () => {
    const rows = await getRows(RB.source);
    return buildMatrix(RB.report, rows);
  };

  const doCsv = async () => {
    try {
      const { headers, rows } = await currentMatrix();
      const blob = new Blob(["\ufeff" + toCsv(headers, rows)], { type: "text/csv;charset=utf-8" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = reportTitle().replace(/[^\w]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() + ".csv";
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    } catch (_) { _toast("Unable to load report data", "error"); }
  };

  const doPrint = async () => {
    try {
      const { headers, rows } = await currentMatrix();
      const win = window.open("", "_blank");
      if (!win) { _toast("Allow pop-ups to print reports", "warn"); return; }
      win.document.write(`<!doctype html><html><head><title>${esc(reportTitle())}</title><style>
        body{font:13px/1.45 -apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#111827;margin:32px}
        h1{font-size:18px;margin:0 0 2px} p{margin:0 0 16px;color:#6B7280;font-size:12px}
        table{border-collapse:collapse;width:100%} th,td{border:1px solid #D1D5DB;padding:5px 8px;text-align:left;font-size:12px}
        th{background:#F3F4F6;font-weight:600}
      </style></head><body>
        <h1>${esc(reportTitle())}</h1>
        <p>${esc(_dsp().name || "")} · ${rows.length} ${esc(rows.length === 1 ? (RB_SOURCES[RB.source] || RB_SOURCES.people).noun[0] : (RB_SOURCES[RB.source] || RB_SOURCES.people).noun[1])} · ${new Date().toLocaleDateString()}</p>
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
      const title = reportTitle();
      await RB.deps.createReportWorkbook({
        title,
        description: RB.report.description,
        headers,
        rows,
        report: {
          source: RB.source,
          fields: reportFields(RB.report),
          live: RB.live,
          range: RB.range[RB.source] || null,
          formId: RB.source === "forms" ? RB.forms.formId : undefined,
        },
      });
      _toast(`Opening “${title}” in Workbooks${RB.live ? " — it refreshes on every open" : ""}`, "success");
    } catch (e) {
      console.warn("report → workbook:", e && e.message);
      els.foot.workbook.disabled = false;
      els.foot.workbook.textContent = "Open in Workbook";
      _toast("Couldn't create the workbook", "error");
    }
  };

  wrap.addEventListener("change", (e) => {
    const live = e.target.closest("[data-rb-live]");
    if (live) { RB.live = live.getAttribute("data-rb-live") === "1"; return; }
    const form = e.target.closest("[data-rb-form]");
    if (form) { selectForm(form.value); renderCustomPanel(); footState(); renderPreview(); return; }
    const range = e.target.closest("[data-rb-range]");
    if (range) { RB.range[RB.source] = range.value; renderPreview(); return; }
    const f = e.target.closest("[data-rb-field]");
    if (!f) return;
    const key = f.getAttribute("data-rb-field");
    if (f.checked) RB.sel[RB.source].add(key); else RB.sel[RB.source].delete(key);
    footState();
    renderPreview();
  });
  wrap.addEventListener("click", (e) => {
    if (e.target.closest("[data-rb-retry]")) { renderPreview(true); return; }
    if (e.target.closest("[data-rb-forms-retry]")) { RB.forms.loaded = false; enterFormsSource(); return; }
    const preset = e.target.closest("[data-rb-preset]");
    if (preset) {
      const src = RB_SOURCES[RB.source];
      const p = (src.presets || []).find((x) => x[0] === preset.getAttribute("data-rb-preset"));
      if (p) {
        RB.sel[RB.source] = new Set(p[2]);
        renderCustomPanel();
        footState();
        renderPreview();
      }
      return;
    }
    const cat = e.target.closest("[data-rb-cat]");
    if (cat && !cat.disabled) {
      wrap.querySelectorAll(".rb-cat").forEach((b) => b.classList.toggle("is-active", b === cat));
      selectReport("custom-" + cat.getAttribute("data-rb-cat"));
      return;
    }
    const act = e.target.closest("[data-rb-act]");
    if (act && !act.disabled) {
      const a = act.getAttribute("data-rb-act");
      if (a === "csv") doCsv();
      else if (a === "print") doPrint();
      else if (a === "workbook") doWorkbook();
    }
  });

  selectReport("custom-people"); // the screen lands straight on the field picker
}
