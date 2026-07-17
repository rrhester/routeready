// ─── repair-engine.js · Repair Center deterministic logic ──────────────────
//
// The single source of truth (client-side) for the Repair Center's
// vocabulary and math:
//   1. stage model + allowed transitions — mirrors
//      public._repair_stage_next_allowed() in migration 0486 (tests pin
//      the two with a shared fixture; change BOTH or neither)
//   2. availability + shop-status vocabularies and display treatment
//   3. timers — every duration is derived from raw timestamps
//   4. money — integer cents only, never floats, never AI
//   5. queue filtering/sorting helpers
//
// Pure module: no DOM, no Supabase, no Date.now(). Callers pass
// `nowIso` wherever "now" matters — that is what makes this testable
// from node (scripts/test-repair-engine.mjs) and safe to import from
// the browser UI.

// ── Stage model ─────────────────────────────────────────────────────────
export const STAGES = [
  "reported", "review", "quoting", "quotes_in", "awaiting_approval",
  "approved", "scheduled", "at_shop", "ready_for_pickup",
  "quality_check", "returned", "closed", "cancelled",
];

export const STAGE_LABEL = {
  reported: "Reported",
  review: "Needs review",
  quoting: "Requesting quotes",
  quotes_in: "Quotes received",
  awaiting_approval: "Awaiting approval",
  approved: "Approved",
  scheduled: "Scheduled",
  at_shop: "At shop",
  ready_for_pickup: "Ready for pickup",
  quality_check: "Quality check",
  returned: "Returned to service",
  closed: "Closed",
  cancelled: "Cancelled",
};

// Display tone for the stage pill. Red is EARNED, never a default:
// overdue/grounded states get their tone from flags, not the stage.
export const STAGE_TONE = {
  reported: "neutral",
  review: "warn",
  quoting: "info",
  quotes_in: "info",
  awaiting_approval: "warn",
  approved: "slate",
  scheduled: "slate",
  at_shop: "info",
  ready_for_pickup: "ok",
  quality_check: "slate",
  returned: "ok",
  closed: "neutral",
  cancelled: "neutral",
};

// Mirrors public._repair_stage_next_allowed() (migration 0486).
export const STAGE_TRANSITIONS = {
  reported:          ["review", "quoting", "scheduled", "at_shop", "cancelled"],
  review:            ["reported", "quoting", "scheduled", "at_shop", "cancelled"],
  quoting:           ["quotes_in", "awaiting_approval", "cancelled"],
  quotes_in:         ["quoting", "awaiting_approval", "cancelled"],
  awaiting_approval: ["approved", "quoting", "cancelled"],
  approved:          ["scheduled", "at_shop", "quoting", "cancelled"],
  scheduled:         ["at_shop", "approved", "cancelled"],
  at_shop:           ["ready_for_pickup", "cancelled"],
  ready_for_pickup:  ["quality_check", "at_shop"],
  quality_check:     ["returned", "at_shop"],
  returned:          ["closed"],
  closed:            [],
  cancelled:         [],
};

export function canTransition(from, to) {
  return (STAGE_TRANSITIONS[from] || []).includes(to);
}

export function isOpenStage(stage) {
  return stage !== "closed" && stage !== "cancelled";
}

// ── Availability (vehicle-facing) ───────────────────────────────────────
export const AVAILABILITY_LABEL = {
  in_service: "In service",
  limited: "Limited use",
  grounded: "Grounded",
  at_shop: "At shop",
  ready_for_pickup: "Ready for pickup",
  returned: "Returned",
};

// Dot-status treatment (matches the Fleet roster's .fl-opstat colors:
// green operational, red grounded/out, amber limited).
export const AVAILABILITY_TONE = {
  in_service: "g",
  limited: "a",
  grounded: "r",
  at_shop: "r",
  ready_for_pickup: "r",
  returned: "g",
};

// ── Shop-visit status ───────────────────────────────────────────────────
export const SHOP_STATUS_LABEL = {
  awaiting_dropoff: "Awaiting drop-off",
  checked_in: "Checked in",
  diagnosing: "Diagnosis in progress",
  awaiting_authorization: "Awaiting authorization",
  parts_hold: "Waiting on parts",
  in_repair: "Repair in progress",
  delayed: "Delayed",
  ready: "Ready for pickup",
  picked_up: "Picked up",
};

export const SHOP_STATUS_TONE = {
  awaiting_dropoff: "slate",
  checked_in: "info",
  diagnosing: "warn",
  awaiting_authorization: "warn",
  parts_hold: "warn",
  in_repair: "info",
  delayed: "bad",
  ready: "ok",
  picked_up: "neutral",
};

// Picker order for the In-Shop Tracker's status update. Deliberately
// excludes 'awaiting_dropoff' (pre-check-in) and 'picked_up' (owned by
// the dedicated pickup action so its timestamps stay consistent —
// migration 0489 refuses it through the generic update too).
export const SHOP_STATUS_FLOW = [
  "checked_in", "diagnosing", "awaiting_authorization",
  "parts_hold", "in_repair", "delayed", "ready",
];

// ── Quote-request status (per shop × case) ──────────────────────────────
export const REQUEST_STATUS_LABEL = {
  queued: "Queued",
  sent: "Sent",
  opened: "Opened",
  submitted: "Quote received",
  declined: "Declined",
  expired: "Expired",
  revoked: "Revoked",
  failed: "Send failed",
};

export const REQUEST_STATUS_TONE = {
  queued: "neutral",
  sent: "info",
  opened: "info",
  submitted: "ok",
  declined: "warn",
  expired: "neutral",
  revoked: "neutral",
  failed: "bad",       // a failed shop communication is a serious state
};

export const SHOP_CLASS_LABEL = {
  preferred: "Preferred",
  approved: "Approved",
  emergency: "Emergency",
  blocked: "Blocked",
};

// ── Quote status (per quote version) ────────────────────────────────────
export const QUOTE_STATUS_LABEL = {
  draft: "Draft",
  submitted: "Submitted",
  superseded: "Superseded",
  accepted: "Accepted",
  declined: "Declined",
  expired: "Expired",
};

export const QUOTE_STATUS_TONE = {
  draft: "neutral",
  submitted: "info",
  superseded: "neutral",
  accepted: "ok",
  declined: "neutral",
  expired: "neutral",
};

// ── Authorization vocabulary (Phase 5) ──────────────────────────────────
// Mirrors migration 0488's repair_authorizations checks.
export const AUTH_TYPE_LABEL = {
  full: "Approved in full",
  selected_lines: "Selected lines approved",
  diagnostics_only: "Diagnostics only",
  not_to_exceed: "Not-to-exceed cap",
};

export const AUTH_STATUS_LABEL = {
  issued: "Awaiting shop acknowledgement",
  acknowledged: "Acknowledged by shop",
  superseded: "Superseded",
  revoked: "Revoked",
};

// Calm by design: an un-acknowledged authorization is a normal working
// state (amber only via age, handled by the caller), never red.
export const AUTH_STATUS_TONE = {
  issued: "info",
  acknowledged: "ok",
  superseded: "neutral",
  revoked: "warn",
};

export const SHOP_CLASS_TONE = {
  preferred: "ok",
  approved: "neutral",
  emergency: "warn",
  blocked: "bad",
};

export const SEVERITY_LABEL = { low: "Low", medium: "Medium", high: "High", critical: "Critical" };
export const CATEGORY_OPTIONS = [
  "mechanical", "electrical", "brakes", "tires", "body", "glass", "hvac",
  "engine", "transmission", "suspension", "doors", "collision",
  "preventive", "other",
];

// ── Timers (all derived; never stored) ──────────────────────────────────
const MS_H = 3600 * 1000;
const MS_D = 24 * MS_H;

// Milliseconds between two ISO timestamps; null when either is missing.
export function msBetween(fromIso, toIso) {
  if (!fromIso || !toIso) return null;
  const a = Date.parse(fromIso);
  const b = Date.parse(toIso);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return b - a;
}

// "4d 6h" / "6h" / "22m" / "now" — compact operational duration.
export function formatDuration(ms) {
  if (ms == null || !Number.isFinite(ms)) return "—";
  const abs = Math.max(0, ms);
  const d = Math.floor(abs / MS_D);
  const h = Math.floor((abs % MS_D) / MS_H);
  const m = Math.floor((abs % MS_H) / 60000);
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return `${h}h`;
  if (m > 0) return `${m}m`;
  return "now";
}

// Whole days down (floor), for the roster-style square badge.
export function daysDown(sinceIso, nowIso) {
  const ms = msBetween(sinceIso, nowIso);
  return ms == null ? null : Math.max(0, Math.floor(ms / MS_D));
}

// Badge tone against Amazon's repair-completion pressure:
// quiet < 3d, amber 3–6d, red ≥ 7d (half the 14-day limit).
export function daysDownTone(days) {
  if (days == null) return "";
  if (days >= 7) return "bad";
  if (days >= 3) return "warn";
  return "";
}

// The promise clock for an active shop visit.  Revised beats promised;
// a case that is ready for pickup is never "overdue".
export function promiseState(visit, nowIso) {
  if (!visit) return { state: "none", dueIso: null, overdueMs: null };
  const due = visit.revised_completion_at || visit.promised_completion_at || null;
  if (!due) return { state: "none", dueIso: null, overdueMs: null };
  if (visit.ready_for_pickup_at || visit.shop_status === "ready" || visit.shop_status === "picked_up") {
    return { state: "met", dueIso: due, overdueMs: null };
  }
  const over = msBetween(due, nowIso);
  if (over == null) return { state: "none", dueIso: due, overdueMs: null };
  if (over > 0) return { state: "overdue", dueIso: due, overdueMs: over };
  if (over > -MS_D) return { state: "due_soon", dueIso: due, overdueMs: null };
  return { state: "on_track", dueIso: due, overdueMs: null };
}

// Out-of-service clock for a case: grounded_since wins (Fleet truth),
// else drop-off, else nothing.
export function downSince(row) {
  if (!row) return null;
  if (row.grounded_since && (row.availability === "grounded"
      || row.operational_status === "grounded")) return row.grounded_since;
  if (row.availability === "at_shop" || row.stage === "at_shop") {
    return row.dropped_off_at || row.grounded_since || null;
  }
  return row.grounded_since || null;
}

// ── Money (integer cents; deterministic) ────────────────────────────────
export function formatCents(cents) {
  if (cents == null || !Number.isFinite(cents)) return "—";
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.round(cents));
  const dollars = Math.floor(abs / 100);
  const rem = String(abs % 100).padStart(2, "0");
  return `${sign}$${dollars.toLocaleString("en-US")}.${rem}`;
}

// Sum of line cents, ignoring null/NaN — used for quote/invoice totals
// in later phases; already the single place money math lives.
export function sumCents(values) {
  let total = 0;
  for (const v of values || []) {
    if (Number.isFinite(v)) total += Math.round(v);
  }
  return total;
}

// Variance of an invoice against an authorization.
export function varianceCents(approvedCents, invoiceCents) {
  if (!Number.isFinite(approvedCents) || !Number.isFinite(invoiceCents)) return null;
  return Math.round(invoiceCents) - Math.round(approvedCents);
}

export function variancePct(approvedCents, invoiceCents) {
  const d = varianceCents(approvedCents, invoiceCents);
  if (d == null || !approvedCents) return null;
  return (d / Math.abs(approvedCents)) * 100;
}

// Odometer sanity. Accepts "44,318", "44318 mi", etc. (non-digits are
// stripped, like the Fleet mileage inputs), but refuses implausible
// readings BEFORE they reach the integer RPC parameter — the highest
// real-world odometers are ~1M miles, and Postgres int4 tops out at
// 2.1B, so a fat-fingered 11-digit entry otherwise surfaces as a raw
// "out of range for type integer" database error.
// Returns { ok, value, reason }: value is null for blank input (ok) and
// reason is 'not_a_number' | 'too_large' when ok is false.
export const ODOMETER_MAX = 2_000_000;
export function parseOdometer(raw) {
  if (raw == null || String(raw).trim() === "") return { ok: true, value: null, reason: null };
  const digits = String(raw).replace(/[^\d]/g, "");
  if (digits === "") return { ok: false, value: null, reason: "not_a_number" };
  const n = parseInt(digits, 10);
  if (!Number.isFinite(n)) return { ok: false, value: null, reason: "not_a_number" };
  if (n > ODOMETER_MAX) return { ok: false, value: null, reason: "too_large" };
  return { ok: true, value: n, reason: null };
}

// Dollar input → integer cents WITHOUT float multiplication ("1,234.56"
// → 123456 by string math). Blank is ok/null (caller decides if it's
// required). Rejects negatives, junk, more than two decimal places, and
// fat-fingered amounts over $1M (mirrors the odometer guard: better a
// friendly warning than an integer-overflow database error).
export const MONEY_MAX_CENTS = 100_000_000; // $1,000,000.00
export function parseMoney(raw) {
  if (raw == null || String(raw).trim() === "") return { ok: true, cents: null, reason: null };
  const s = String(raw).replace(/[$,\s]/g, "");
  if (s.includes("-")) return { ok: false, cents: null, reason: "negative" };
  if (!/^\d*(\.\d*)?$/.test(s) || s === "" || s === ".") {
    return { ok: false, cents: null, reason: "not_a_number" };
  }
  const [d = "0", c = ""] = s.split(".");
  if (c.length > 2) return { ok: false, cents: null, reason: "too_precise" };
  const cents = parseInt(d || "0", 10) * 100 + parseInt((c + "00").slice(0, 2), 10);
  if (!Number.isFinite(cents)) return { ok: false, cents: null, reason: "not_a_number" };
  if (cents > MONEY_MAX_CENTS) return { ok: false, cents: null, reason: "too_large" };
  return { ok: true, cents, reason: null };
}

// ── Quote comparison (Phase 5) ──────────────────────────────────────────
// Everything here is DISPLAY math over totals the server already
// computed and stored — no authoritative money is produced client-side.

// The quotes worth comparing: submitted or accepted (drafts and
// superseded versions are noise).
export function comparableQuotes(quotes) {
  return (quotes || []).filter((q) => q.status === "submitted" || q.status === "accepted");
}

// Conservative line matching key: same wording (case/punctuation
// insensitive) = same work item. Fuzzy matching is deliberately NOT
// attempted — a wrong merge is worse than an unmatched row.
export function normalizeLineKey(description) {
  return String(description || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const quoteTotal = (q) => q.grand_total_cents ?? q.shop_reported_total_cents ?? null;

// Side-by-side matrix over the comparable quotes:
//   quotes   — sorted cheapest-first (unknown totals last), each with
//              total + delta vs the cheapest
//   rows     — union of line items grouped by normalizeLineKey; each
//              row has cells keyed by quote id ({cents, count} or null)
//   warnings — scope differences in plain words (per-quote missing
//              items, totals-only quotes) — flagged, never "corrected"
export function buildComparison(quotes) {
  const qs = comparableQuotes(quotes);
  const sorted = [...qs].sort((a, b) => {
    const ta = quoteTotal(a); const tb = quoteTotal(b);
    if (ta == null && tb == null) return 0;
    if (ta == null) return 1;
    if (tb == null) return -1;
    return ta - tb;
  });
  const cheapest = sorted.find((q) => quoteTotal(q) != null) || null;

  const rows = [];
  const byKey = new Map();
  for (const q of sorted) {
    for (const li of q.line_items || []) {
      if (li.category === "tax") continue; // compared via totals, not scope
      const key = normalizeLineKey(li.description);
      if (!key) continue;
      let row = byKey.get(key);
      if (!row) {
        row = { key, description: li.description, category: li.category, cells: {} };
        byKey.set(key, row);
        rows.push(row);
      }
      const cell = row.cells[q.id] || { cents: 0, count: 0 };
      cell.cents += Number.isFinite(li.line_total_cents) ? Math.round(li.line_total_cents) : 0;
      cell.count += 1;
      row.cells[q.id] = cell;
    }
  }

  const warnings = [];
  if (sorted.length >= 2) {
    for (const q of sorted) {
      const name = q.vendor_name || "A shop";
      if (!(q.line_items || []).some((li) => li.category !== "tax")) {
        warnings.push(`${name} sent a total without line detail — scope can't be compared.`);
        continue;
      }
      const missing = rows.filter((r) => !r.cells[q.id]).map((r) => r.description);
      if (missing.length) {
        const head = missing.slice(0, 4).join(", ");
        const more = missing.length > 4 ? ` +${missing.length - 4} more` : "";
        warnings.push(`${name} doesn't include: ${head}${more}.`);
      }
    }
  }

  return {
    quotes: sorted.map((q) => {
      const total = quoteTotal(q);
      const base = cheapest ? quoteTotal(cheapest) : null;
      return {
        ...q,
        compare_total_cents: total,
        delta_vs_cheapest_cents:
          total != null && base != null && q !== cheapest ? total - base : null,
        is_cheapest: cheapest != null && q.id === cheapest.id,
      };
    }),
    rows,
    warnings,
  };
}

// ── Queue helpers ───────────────────────────────────────────────────────
// Attention rank drives the "Needs attention" list and default queue
// sort: overdue promises and old grounded vans float to the top.
export function attentionScore(row, nowIso) {
  if (!row || !isOpenStage(row.stage)) return 0;
  let score = 0;
  const p = promiseState(row, nowIso);
  if (p.state === "overdue") score += 500 + Math.min(300, Math.floor((p.overdueMs || 0) / MS_D) * 50);
  const grounded = row.availability === "grounded" || row.operational_status === "grounded";
  if (grounded) {
    score += 200;
    const d = daysDown(row.grounded_since, nowIso);
    if (d != null) score += Math.min(280, d * 40);
  }
  if (row.stage === "awaiting_approval") score += 120;
  if (row.stage === "ready_for_pickup") score += 100;
  if (row.stage === "reported" || row.stage === "review") score += 60;
  if (row.severity === "critical") score += 80;
  else if (row.severity === "high") score += 40;
  return score;
}

export function filterQueue(rows, f = {}) {
  const q = (f.search || "").trim().toLowerCase();
  return (rows || []).filter((r) => {
    if (f.openOnly !== false && !isOpenStage(r.stage)) return false;
    if (f.stage && r.stage !== f.stage) return false;
    if (f.station && r.station_code !== f.station) return false;
    if (f.vendorId && r.vendor_id !== f.vendorId) return false;
    if (f.groundedOnly && !(r.availability === "grounded" || r.operational_status === "grounded")) return false;
    if (f.overdueOnly && promiseState(r, f.nowIso).state !== "overdue") return false;
    if (q) {
      const hay = [
        r.case_number, r.title, r.component, r.category,
        r.vehicle_name, r.vehicle_nickname, r.vehicle_vin, r.vehicle_plate,
        r.vendor_name, r.ro_code, r.shop_work_order_number,
      ].filter(Boolean).join(" ").toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

export function sortQueue(rows, nowIso, mode = "attention") {
  const copy = [...(rows || [])];
  if (mode === "reported") {
    copy.sort((a, b) => String(b.reported_at || "").localeCompare(String(a.reported_at || "")));
  } else if (mode === "updated") {
    copy.sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")));
  } else {
    copy.sort((a, b) =>
      (attentionScore(b, nowIso) - attentionScore(a, nowIso))
      || String(b.reported_at || "").localeCompare(String(a.reported_at || "")));
  }
  return copy;
}

// Summary counts computed client-side from queue rows (mirror of the
// repair_center_summary RPC for optimistic refresh).
export function summarize(rows, nowIso) {
  const open = (rows || []).filter((r) => isOpenStage(r.stage));
  const c = (fn) => open.filter(fn).length;
  return {
    open_cases: open.length,
    // Matches repair_center_summary(): the case's availability field
    // (a van waiting for pickup is out of service but not "grounded").
    grounded: c((r) => r.availability === "grounded"),
    needs_review: c((r) => r.stage === "reported" || r.stage === "review"),
    quoting: c((r) => r.stage === "quoting" || r.stage === "quotes_in"),
    awaiting_approval: c((r) => r.stage === "awaiting_approval"),
    scheduled: c((r) => r.stage === "approved" || r.stage === "scheduled"),
    at_shop: c((r) => r.stage === "at_shop"),
    waiting_on_parts: c((r) => r.shop_status === "parts_hold"),
    past_promise: c((r) => promiseState(r, nowIso).state === "overdue"),
    ready_for_pickup: c((r) => r.stage === "ready_for_pickup" || r.stage === "quality_check"),
    approved_total_cents: sumCents(open.map((r) => r.approved_total_cents)),
    estimate_total_cents: sumCents(open.filter((r) => r.approved_total_cents == null)
      .map((r) => r.estimate_total_cents)),
  };
}

// ── Formatting helpers shared by the UI ─────────────────────────────────
export function formatWhen(iso, nowIso) {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const now = nowIso ? Date.parse(nowIso) : t;
  const d = new Date(t);
  const sameDay = new Date(now).toDateString() === d.toDateString();
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  if (sameDay) return time;
  const day = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `${day}, ${time}`;
}

export function formatDay(iso) {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function vehicleShortDesc(r) {
  if (!r) return "";
  const bits = [];
  if (r.vehicle_year) bits.push(`'${String(r.vehicle_year).slice(-2)}`);
  if (r.vehicle_make) bits.push(r.vehicle_make);
  if (r.vehicle_model) bits.push(r.vehicle_model);
  return bits.join(" ");
}
