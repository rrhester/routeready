// ─── forecast-core.js · shared labor-forecast math ─────────────────────────
//
// The single source of truth for every number the 13-week labor forecast
// shows: drivers-needed, effective supply, per-week coverage status, hire-by
// deadlines, and the plan-level prescription ("hire N by DATE" vs "hiring
// window passed — mitigate"). The OKAMI planner, the Targets gap card, and
// the Risk Forecast intel view all call into this module so they can never
// disagree with each other again (they previously carried three separate
// copies of the math and four risk vocabularies — product audit #84).
//
// Pure module: no DOM, no Supabase, no Date.now(). Callers pass `todayIso`
// explicitly, which is what makes this testable from node
// (scripts/test-labor-forecast.mjs) and safe to run anywhere.

// One risk vocabulary. `kind` is the canonical value everywhere; CLASS maps
// onto the legacy CSS class names already shipped in inline-styles.css so
// the visual layer didn't need a token migration in the same PR.
export const FORECAST_KIND_LABEL = { ok: "On track", watch: "Watch", risk: "At risk" };
export const FORECAST_KIND_CLASS = { ok: "ok", watch: "tight", risk: "risk" };

// Coverage thresholds (effective available ÷ needed). Below 80% a week IS
// at risk regardless of what any planning-strategy column claims; 80–95%
// is worth watching because one bad callout day breaks it.
const COVERAGE_RISK  = 0.80;
const COVERAGE_WATCH = 0.95;

// ── Small pure date helpers (ISO yyyy-mm-dd strings in/out) ───────────────

export function isoAddDays(iso, days) {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// ── Demand ─────────────────────────────────────────────────────────────────

// drivers needed = ceil(peak routes × drivers-per-route × (1 + pad%)).
// driversPerRoute comes from hiring settings (the same ratio the staffing
// outlook uses) so the two surfaces agree; 2 (1 primary + 1 backup) is the
// long-standing default when the setting is absent.
export function driversNeeded(routesPeak, opts = {}) {
  const routes = Number(routesPeak) || 0;
  if (routes <= 0) return 0;
  const dpr = clamp(Number(opts.driversPerRoute), 1, 5, 2);
  const pad = clamp(Number(opts.padPct), 0, 200, 0);
  return Math.ceil(routes * dpr * (1 + pad / 100));
}

// ── XL routes ────────────────────────────────────────────────────────────────
// A standard route dispatches ONE person and costs `driversPerRoute` roster
// bodies (the DSP's rostering ratio: 1 = just fill the seat, 2 = a full
// backup per seat). An XL route DISPATCHES with TWO people on the road — one
// XL-certified driver and one helper (no cert) — so it costs two on-road
// seats, each carried at the SAME drivers-per-route ratio as a standard
// seat. At the long-standing default ratio of 2 that's the familiar 4
// bodies per XL route (2 certified + 2 helpers); at a ratio of 1 it's the
// 2 who actually dispatch (1 certified + 1 helper).
export const XL_SEATS_PER_ROUTE      = 2; // on-road bodies an XL route dispatches
export const XL_CERT_SEATS_PER_ROUTE = 1; // of those, must hold xl_certified

// driversNeeded, but for a peak-day route MIX that separates two-seat routes
// from standard ones. `mix` = { standard, xl, helperRoutes } route counts on
// the week's busiest (peak) day:
//   · standard      — cost `driversPerRoute` each (default 2)
//   · xl            — cost `xlDriversPerRoute` each (default 2 seats ×
//                     driversPerRoute): half must be XL-certified, half
//                     ride as helpers
//   · helperRoutes  — the HELPER service type: an SP-style route that
//                     dispatches driver + helper. Same two-seat cost as XL
//                     but NOBODY needs a certification.
// The pad is a whole-plan buffer, so it applies uniformly to every seat.
//
// Returns { total, xlCertified, xlHelpers, standardRoutes, xlRoutes,
// helperRoutes }. `total` is the authoritative bodies-needed number and
// stays byte-identical to driversNeeded(standard, …) when xl and
// helperRoutes are 0, so a DSP running neither sees no change. `xlHelpers`
// counts ALL helper bodies (XL + helper-route ones). The sub-totals are
// each rounded up independently (conservative); treat them as "at least
// this many of that kind".
export function driversNeededMix(mix, opts = {}) {
  const std = Math.max(0, Number(mix && mix.standard) || 0);
  const xl  = Math.max(0, Number(mix && mix.xl) || 0);
  const hr  = Math.max(0, Number(mix && mix.helperRoutes) || 0);
  const dpr    = clamp(Number(opts.driversPerRoute), 1, 5, 2);
  const xlDpr  = clamp(Number(opts.xlDriversPerRoute), 1, 10, XL_SEATS_PER_ROUTE * dpr);
  const xlCert = clamp(Number(opts.xlCertifiedPerRoute), 0, xlDpr, XL_CERT_SEATS_PER_ROUTE * dpr);
  const pad    = clamp(Number(opts.padPct), 0, 200, 0);
  const mult   = 1 + pad / 100;
  const total       = Math.ceil((std * dpr + xl * xlDpr + hr * xlDpr) * mult);
  const xlCertified = Math.ceil(xl * xlCert * mult);
  const xlHelpers   = Math.ceil((xl * (xlDpr - xlCert) + hr * (xlDpr - xlCert)) * mult);
  return { total, xlCertified, xlHelpers, standardRoutes: std, xlRoutes: xl, helperRoutes: hr };
}

// ── Supply ─────────────────────────────────────────────────────────────────

// Effective supply for a future week = bodies on payroll, minus onboarding
// drivers who won't be road-ready yet, minus projected attrition between now
// and then, discounted by the observed callout rate (a body that won't show
// on the peak day doesn't cover the peak day). Every deduction is returned
// separately so the UI can show its work instead of a mystery number.
export function effectiveSupply(weekIndex, rawAvail, rates = {}) {
  const idx   = Math.max(0, Number(weekIndex) || 0);
  const avail = Math.max(0, Number(rawAvail) || 0);
  const notReady = Math.min(avail, Math.max(0, Number(rates.onboardingNotReady) || 0));
  const attrRate = clamp(Number(rates.weeklyAttritionRate), 0, 0.10, 0);
  const callRate = clamp(Number(rates.calloutRate), 0, 0.50, 0);
  // Hypothetical hires (the calculator's "what if I hire N arriving week X").
  // They join the body count before the callout discount — a new hire calls
  // out at the same observed rate as everyone else — but are exempt from the
  // attrition decay, which is computed off the CURRENT roster only.
  const extraHires = Math.max(0, Math.round(Number(rates.extraHires) || 0));

  // Attrition compounds week over week; week 0 is "now", so no decay yet.
  const attritionLoss = Math.round(avail * (1 - Math.pow(1 - attrRate, idx)));
  const bodies = Math.max(0, avail - notReady - attritionLoss) + extraHires;
  const calloutLoss = Math.round(bodies * callRate);
  const effective = Math.max(0, bodies - calloutLoss);
  return { rawAvail: avail, notReadyOnboarding: notReady, attritionLoss, extraHires, calloutLoss, effective };
}

export function coverageKind(needed, avail) {
  const n = Number(needed) || 0;
  if (n <= 0) return "ok";
  const cov = (Number(avail) || 0) / n;
  if (cov < COVERAGE_RISK)  return "risk";
  if (cov < COVERAGE_WATCH) return "watch";
  return "ok";
}

// ── Plan assessment ────────────────────────────────────────────────────────
//
// weeks: [{ idx, weekStartIso, label, dates, needed, avail,
//           routesMax?, isSimulated?, onPto?, onTimeOff? }]
// opts:  { todayIso (required),
//          hireLeadDays = 28,
//          calloutRate = 0,               // fraction of shifts lost, 0..0.5
//          weeklyAttritionRate = 0,       // fraction of actives lost / week
//          onboardingNotReadyByWeek = {}, // { weekStartIso: count }
//          horizonWeeks = 4,
//          extraSupply = null,            // { fromIso, count } — hypothetical
//                                         // hires on the roster from fromIso on
//          demandOverride = null }        // { driversPerRoute, padPct } —
//                                         // recompute needed from routesMax
//                                         // (weeks without routesMax keep
//                                         // their planned needed)
//
// Returns { weeks, worstWeek, driverWeeksShort, horizon, trend, firstBreak,
//           headline, prescription } — everything the gap card and the risk
// panel render, precomputed in one place.
export function assessPlan(weeks, opts = {}) {
  const todayIso = String(opts.todayIso || "");
  if (!todayIso) throw new Error("assessPlan: opts.todayIso is required");
  const leadDays = Number.isFinite(Number(opts.hireLeadDays)) ? Number(opts.hireLeadDays) : 28;
  const horizonN = Math.max(1, Number(opts.horizonWeeks) || 4);
  const notReadyBy = opts.onboardingNotReadyByWeek || {};

  const extraSupply = opts.extraSupply && Number(opts.extraSupply.count) > 0 && opts.extraSupply.fromIso
    ? { fromIso: String(opts.extraSupply.fromIso), count: Math.round(Number(opts.extraSupply.count)) }
    : null;
  const demandOverride = opts.demandOverride || null;

  const assessed = (weeks || []).map((w, i) => {
    const idx = Number.isFinite(Number(w.idx)) ? Number(w.idx) : i;
    // When the sandbox overrides demand (dpr / pad), recompute needed from
    // the route counts. Prefer the XL-aware peak-day mix when the caller
    // carried one; XL routes keep their 4-per-route cost (driversNeededMix's
    // default) even as the standard dpr dial moves. Weeks without a mix fall
    // back to the flat single-count path.
    const overrideMix = demandOverride && w.routesMix
      ? driversNeededMix(w.routesMix, demandOverride)
      : null;
    const needed = overrideMix
      ? overrideMix.total
      : (demandOverride && Number.isFinite(Number(w.routesMax))
        ? driversNeeded(w.routesMax, demandOverride)
        : Math.max(0, Number(w.needed) || 0));
    // Of the drivers needed, how many must be XL-certified — recomputed under
    // an override, else passed through from the caller's own XL-aware render.
    const xlCertifiedNeeded = overrideMix
      ? overrideMix.xlCertified
      : Math.max(0, Number(w.xlCertifiedNeeded) || 0);
    const supply = effectiveSupply(idx, w.avail, {
      onboardingNotReady: notReadyBy[w.weekStartIso] || 0,
      weeklyAttritionRate: opts.weeklyAttritionRate,
      calloutRate: opts.calloutRate,
      extraHires: extraSupply && w.weekStartIso && w.weekStartIso >= extraSupply.fromIso
        ? extraSupply.count : 0,
    });
    const gap = supply.effective - needed;
    const kind = coverageKind(needed, supply.effective);
    const coveragePct = needed > 0
      ? Math.round((supply.effective / needed) * 100)
      : 100;
    const hireByIso = w.weekStartIso ? isoAddDays(w.weekStartIso, -leadDays) : null;
    // A short week is "reachable" while there's still time for a hire made
    // by the hire-by date to be road-ready when the week starts. Once the
    // hire-by date is behind us, hiring can no longer save that week —
    // only mitigation (OT, voluntary 5th days, flex) can.
    const hireByStatus = gap >= 0 || !hireByIso ? null
      : (hireByIso >= todayIso ? "open" : "past");
    return {
      ...w, idx, needed, xlCertifiedNeeded, supply, effAvail: supply.effective,
      gap, kind, coveragePct, hireByIso, hireByStatus,
    };
  });

  // Worst week = deepest shortfall; ties go to the earliest week.
  let worstWeek = assessed[0] || null;
  for (const w of assessed) if (w.gap < worstWeek.gap) worstWeek = w;

  const driverWeeksShort = assessed.reduce((s, w) => s + Math.max(0, -w.gap), 0);

  const horizonWeeksArr = assessed.slice(0, horizonN);
  const horizon = {
    weeks: horizonN,
    needed: horizonWeeksArr.reduce((s, w) => s + w.needed, 0),
    effAvail: horizonWeeksArr.reduce((s, w) => s + w.effAvail, 0),
    driverWeeksShort: horizonWeeksArr.reduce((s, w) => s + Math.max(0, -w.gap), 0),
  };

  // Trend across the horizon — improving / steady / declining on the
  // effective coverage ratio.
  let trend = "steady";
  if (horizonWeeksArr.length >= 2) {
    const covOf = (w) => (w.needed > 0 ? w.effAvail / w.needed : 1);
    const delta = covOf(horizonWeeksArr[horizonWeeksArr.length - 1]) - covOf(horizonWeeksArr[0]);
    if (delta > 0.05) trend = "improving";
    else if (delta < -0.05) trend = "declining";
  }

  const firstBreak = assessed.find((w) => w.kind === "risk")
    || assessed.find((w) => w.kind === "watch")
    || null;

  // Headline = the worst signal we're showing, so the pill can never read
  // calmer than the strip below it.
  const thisWeek = assessed[0] || null;
  const thisCovPct = thisWeek ? thisWeek.coveragePct : 100;
  let headline = "ok";
  if (
    assessed.some((w) => w.kind === "risk")
    || thisCovPct < COVERAGE_RISK * 100
    || (trend === "declining" && horizon.driverWeeksShort > 0)
    || horizon.driverWeeksShort >= 30
  ) headline = "risk";
  else if (
    assessed.some((w) => w.kind === "watch")
    || thisCovPct < COVERAGE_WATCH * 100
    || horizon.driverWeeksShort >= 5
    || trend === "declining"
  ) headline = "watch";

  // Prescription. One hire covers a seat in every week after they're
  // road-ready, so the number to hire is the DEEPEST reachable weekly
  // shortfall — never the sum of weekly gaps (that unit is driver-weeks).
  const shortWeeks   = assessed.filter((w) => w.gap < 0);
  const reachable    = shortWeeks.filter((w) => w.hireByStatus === "open");
  const unreachable  = shortWeeks.filter((w) => w.hireByStatus === "past");
  let prescription;
  if (!shortWeeks.length) {
    prescription = { action: "none" };
  } else if (reachable.length) {
    const hires = Math.max(...reachable.map((w) => -w.gap));
    const firstReachable = reachable[0];
    prescription = {
      action: "hire",
      hires,
      deadlineIso: firstReachable.hireByIso,
      firstReachable,
      unreachable,
    };
  } else {
    // Weeks without a weekStartIso can't carry a hire-by at all — they
    // fall in neither bucket, so mitigate from the full short list.
    const pool = unreachable.length ? unreachable : shortWeeks;
    const shortNow = Math.max(...pool.map((w) => -w.gap));
    prescription = {
      action: "mitigate",
      shortNow,
      firstShort: pool[0],
      // Hires started today land here — everything before it needs OT /
      // voluntary 5th days / flex coverage instead.
      readyByIso: isoAddDays(todayIso, leadDays),
      unreachable,
    };
  }

  return { weeks: assessed, worstWeek, driverWeeksShort, horizon, trend, firstBreak, headline, prescription };
}

function clamp(v, lo, hi, fallback) {
  if (!Number.isFinite(v)) return fallback;
  return Math.max(lo, Math.min(hi, v));
}
