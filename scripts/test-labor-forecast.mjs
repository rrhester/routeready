#!/usr/bin/env node
// Tests for dashboard/forecast-core.js — the shared labor-forecast math.
// Run: node scripts/test-labor-forecast.mjs (also part of `npm test`).

import assert from "node:assert/strict";
import {
  assessPlan,
  coverageKind,
  dayCoverage,
  driversNeeded,
  driversNeededMix,
  driversNeededWeek,
  effectiveSupply,
  isoAddDays,
  XL_SEATS_PER_ROUTE,
  XL_CERT_SEATS_PER_ROUTE,
  FORECAST_KIND_LABEL,
  FORECAST_KIND_CLASS,
} from "../dashboard/forecast-core.js";

let passed = 0;
function t(name, fn) {
  try { fn(); passed++; }
  catch (e) { console.error(`✗ ${name}\n  ${e.message}`); process.exitCode = 1; }
}

// Build a 13-week plan quickly. Each spec: { needed, avail } (+ overrides).
function mkWeeks(specs, startIso = "2026-07-06") {
  return specs.map((s, i) => ({
    idx: i,
    weekStartIso: isoAddDays(startIso, i * 7),
    label: `W${27 + i}`,
    dates: `wk${i}`,
    ...s,
  }));
}

// ── isoAddDays ──────────────────────────────────────────────────────────────

t("isoAddDays adds and subtracts across month boundaries", () => {
  assert.equal(isoAddDays("2026-07-06", 7), "2026-07-13");
  assert.equal(isoAddDays("2026-07-06", -28), "2026-06-08");
  assert.equal(isoAddDays("2026-01-01", -1), "2025-12-31");
});

// ── driversNeeded ───────────────────────────────────────────────────────────

t("driversNeeded = ceil(routes × dpr × (1+pad%))", () => {
  assert.equal(driversNeeded(40, { driversPerRoute: 2, padPct: 10 }), 88);
  assert.equal(driversNeeded(41, { driversPerRoute: 2, padPct: 15 }), Math.ceil(41 * 2 * 1.15));
  assert.equal(driversNeeded(0, { driversPerRoute: 2, padPct: 10 }), 0);
});

t("driversNeeded clamps bad inputs to sane defaults", () => {
  assert.equal(driversNeeded(10, {}), 20);                       // dpr defaults to 2
  assert.equal(driversNeeded(10, { driversPerRoute: 99 }), 50);  // dpr capped at 5
  assert.equal(driversNeeded(10, { driversPerRoute: 2, padPct: -5 }), 20); // pad floor 0
});

// ── driversNeededMix (XL-aware demand) ───────────────────────────────────────

t("driversNeededMix constants: XL route dispatches 2 seats, 1 certified", () => {
  assert.equal(XL_SEATS_PER_ROUTE, 2);
  assert.equal(XL_CERT_SEATS_PER_ROUTE, 1);
});

t("driversNeededMix: standard-only mix == driversNeeded (no behavior change)", () => {
  for (const [routes, pad] of [[40, 10], [41, 15], [33, 0], [7, 50]]) {
    const mix = driversNeededMix({ standard: routes, xl: 0 }, { driversPerRoute: 2, padPct: pad });
    assert.equal(mix.total, driversNeeded(routes, { driversPerRoute: 2, padPct: pad }),
      `standard-only ${routes}@${pad}%`);
    assert.equal(mix.xlCertified, 0);
    assert.equal(mix.xlHelpers, 0);
  }
});

t("driversNeededMix: at the default ratio 2, XL routes cost 4 each", () => {
  // 20 standard (×2) + 5 XL (×4) = 40 + 20 = 60 bodies, +15% pad = 69.
  const m = driversNeededMix({ standard: 20, xl: 5 }, { driversPerRoute: 2, padPct: 15 });
  assert.equal(m.total, Math.ceil((20 * 2 + 5 * 4) * 1.15)); // 69
  // Of the XL side: 5 routes × 2 certified × 1.15 = 11.5 → 12 certified,
  // 5 × 2 helpers × 1.15 = 11.5 → 12 helpers.
  assert.equal(m.xlCertified, Math.ceil(5 * 2 * 1.15)); // 12
  assert.equal(m.xlHelpers, Math.ceil(5 * 2 * 1.15));   // 12
  assert.equal(m.standardRoutes, 20);
  assert.equal(m.xlRoutes, 5);
});

t("driversNeededMix: pure XL day, no pad", () => {
  const m = driversNeededMix({ standard: 0, xl: 3 }, { driversPerRoute: 2, padPct: 0 });
  assert.equal(m.total, 12);        // 3 × 4
  assert.equal(m.xlCertified, 6);   // 3 × 2
  assert.equal(m.xlHelpers, 6);     // 3 × 2
});

t("driversNeededMix: HELPER-type routes cost 4 each at ratio 2, none certified", () => {
  // 10 standard (×2) + 2 helper-routes (×4) = 28 bodies, +15% = 33.
  const m = driversNeededMix({ standard: 10, xl: 0, helperRoutes: 2 }, { driversPerRoute: 2, padPct: 15 });
  assert.equal(m.total, Math.ceil((10 * 2 + 2 * 4) * 1.15)); // 33
  assert.equal(m.xlCertified, 0);                            // no certs on helper routes
  assert.equal(m.xlHelpers, Math.ceil(2 * 2 * 1.15));        // 5 helper bodies
  assert.equal(m.helperRoutes, 2);
});

t("driversNeededMix: XL + helper-route mix stacks; helpers pool", () => {
  const m = driversNeededMix({ standard: 5, xl: 1, helperRoutes: 1 }, { driversPerRoute: 2, padPct: 0 });
  assert.equal(m.total, 5 * 2 + 4 + 4);        // 18
  assert.equal(m.xlCertified, 2);              // only the XL route needs certs
  assert.equal(m.xlHelpers, 2 + 2);            // helpers from both kinds
});

t("driversNeededMix: omitted helperRoutes behaves exactly as before", () => {
  const a = driversNeededMix({ standard: 20, xl: 5 }, { driversPerRoute: 2, padPct: 15 });
  const b = driversNeededMix({ standard: 20, xl: 5, helperRoutes: 0 }, { driversPerRoute: 2, padPct: 15 });
  assert.deepEqual(a, b);
});

t("driversNeededMix: XL cost scales with the drivers-per-route ratio", () => {
  // Fill-the-seats ratio (1): an XL route costs just the 2 who dispatch —
  // 1 certified + 1 helper. 9 standard + 1 XL at +20% pad = ceil(11 × 1.2).
  const m = driversNeededMix({ standard: 9, xl: 1 }, { driversPerRoute: 1, padPct: 20 });
  assert.equal(m.total, Math.ceil((9 * 1 + 1 * 2) * 1.2)); // 14
  assert.equal(m.xlCertified, Math.ceil(1 * 1 * 1.2));     // 2 (rounded up)
  assert.equal(m.xlHelpers, Math.ceil(1 * 1 * 1.2));       // 2 (rounded up)
  // HELPER-type routes scale the same way, still no certs.
  const h = driversNeededMix({ standard: 0, xl: 0, helperRoutes: 3 }, { driversPerRoute: 1, padPct: 0 });
  assert.equal(h.total, 6);       // 3 routes × 2 seats
  assert.equal(h.xlCertified, 0);
  assert.equal(h.xlHelpers, 3);   // one helper seat per route
});

t("driversNeededMix: explicit xlDriversPerRoute override still wins", () => {
  const m = driversNeededMix({ standard: 0, xl: 1 }, { driversPerRoute: 1, xlDriversPerRoute: 4, padPct: 0 });
  assert.equal(m.total, 4);
});

// ── driversNeededWeek (week-coverage demand) ────────────────────────────────

t("driversNeededWeek: week coverage binds — 37 routes/day, 4-day drivers, +20%", () => {
  // The operator's own scenario: 37 flat all week = 259 driver-shifts.
  // 259 ÷ 4 = 64.75 dominates the 37-seat peak day → ceil(64.75 × 1.2) = 78.
  const r = driversNeededWeek(
    { weekSeats: 259, peakSeats: 37 },
    { daysPerWeek: 4, padPct: 20 },
  );
  assert.equal(r.total, 78);
});

t("driversNeededWeek: peak-day floor binds when the week is light", () => {
  // 40 seats on one day, nothing else: 40 ÷ 5 = 8 but the day still needs 40.
  const r = driversNeededWeek({ weekSeats: 40, peakSeats: 40 }, { daysPerWeek: 5, padPct: 0 });
  assert.equal(r.total, 40);
});

t("driversNeededWeek: coverage == peak when demand is flat over `days` days", () => {
  // 10 seats/day Mon–Fri, 5-day drivers: 50 ÷ 5 = 10 = the peak. +10% → 11.
  const r = driversNeededWeek({ weekSeats: 50, peakSeats: 10 }, { daysPerWeek: 5, padPct: 10 });
  assert.equal(r.total, 11);
});

t("driversNeededWeek: certified + helper sub-totals get the same max(peak, week÷days)", () => {
  // 2 XL routes every day of a 7-day week: 14 cert seats, peak 2.
  // 4-day drivers → 14 ÷ 4 = 3.5 certified → 4 (no pad). Helpers identical.
  const r = driversNeededWeek(
    { weekSeats: 98, peakSeats: 14, weekCertSeats: 14, peakCertSeats: 2, weekHelperSeats: 14, peakHelperSeats: 2 },
    { daysPerWeek: 4, padPct: 0 },
  );
  assert.equal(r.xlCertified, 4);
  assert.equal(r.xlHelpers, 4);
});

t("dayCoverage: short when the day can't fill its routes", () => {
  assert.deepEqual(dayCoverage(37, 30, 20), { status: "short", short: 7 });
});

t("dayCoverage: thin fills the routes but misses the padded target", () => {
  assert.equal(dayCoverage(37, 41, 20).status, "thin"); // padded target ceil(44.4)=45
  assert.equal(dayCoverage(37, 44, 20).status, "thin");
});

t("dayCoverage: ok at the padded target; zero-route days are trivially ok", () => {
  assert.equal(dayCoverage(37, 45, 20).status, "ok");
  assert.equal(dayCoverage(0, 0, 20).status, "ok");
});

t("driversNeededWeek: clamps bad inputs — days to [1,7] default 5, negatives to 0", () => {
  assert.equal(driversNeededWeek({ weekSeats: 50, peakSeats: 10 }, {}).total, 10);          // days defaults 5
  assert.equal(driversNeededWeek({ weekSeats: 70, peakSeats: 10 }, { daysPerWeek: 99 }).total, 10); // capped at 7
  assert.equal(driversNeededWeek({ weekSeats: -5, peakSeats: -2 }, { daysPerWeek: 4 }).total, 0);
});

t("driversNeededMix: negative / missing inputs floor to zero", () => {
  const m = driversNeededMix({ standard: -5, xl: undefined }, {});
  assert.equal(m.total, 0);
  assert.equal(m.xlCertified, 0);
  assert.equal(m.xlHelpers, 0);
});

t("assessPlan: demandOverride recomputes from routesMix, XL at 2 seats × ratio", () => {
  const weeks = mkWeeks([
    // needed here is a stale flat number; the override should ignore it and
    // recompute from the mix (10 standard ×2 + 4 XL ×4 = 36, +10% = 40).
    { needed: 999, avail: 50, routesMax: 14, routesMix: { standard: 10, xl: 4 } },
  ]);
  const r = assessPlan(weeks, {
    todayIso: "2026-07-06",
    demandOverride: { driversPerRoute: 2, padPct: 10 },
  });
  assert.equal(r.weeks[0].needed, Math.ceil((10 * 2 + 4 * 4) * 1.10)); // 40
  assert.equal(r.weeks[0].xlCertifiedNeeded, Math.ceil(4 * 2 * 1.10)); // 9
});

t("assessPlan: demandOverride prefers demandWeek (week-coverage) over routesMix", () => {
  const weeks = mkWeeks([
    // Carries BOTH: demandWeek must win. 259 shifts ÷ 4 = 64.75 → ×1.2 = 78.
    { needed: 999, avail: 80, routesMax: 37,
      routesMix: { standard: 37, xl: 0 },
      demandWeek: { weekSeats: 259, peakSeats: 37 } },
  ]);
  const r = assessPlan(weeks, {
    todayIso: "2026-07-06",
    demandOverride: { daysPerWeek: 4, padPct: 20 },
  });
  assert.equal(r.weeks[0].needed, 78);
});

t("assessPlan: no override passes through the caller's XL-aware needed", () => {
  const weeks = mkWeeks([
    { needed: 40, avail: 50, routesMax: 14, routesMix: { standard: 10, xl: 4 }, xlCertifiedNeeded: 9 },
  ]);
  const r = assessPlan(weeks, { todayIso: "2026-07-06" });
  assert.equal(r.weeks[0].needed, 40);            // untouched
  assert.equal(r.weeks[0].xlCertifiedNeeded, 9);  // passed through
});

// ── coverageKind ────────────────────────────────────────────────────────────

t("coverageKind thresholds: <80% risk, <95% watch, else ok", () => {
  assert.equal(coverageKind(100, 79), "risk");
  assert.equal(coverageKind(100, 80), "watch");
  assert.equal(coverageKind(100, 94), "watch");
  assert.equal(coverageKind(100, 95), "ok");
  assert.equal(coverageKind(0, 0), "ok"); // no demand = nothing to break
});

t("kind label/class maps cover the full vocabulary", () => {
  for (const k of ["ok", "watch", "risk"]) {
    assert.ok(FORECAST_KIND_LABEL[k], `label for ${k}`);
    assert.ok(FORECAST_KIND_CLASS[k], `class for ${k}`);
  }
  assert.equal(FORECAST_KIND_LABEL.watch, "Watch");
  assert.equal(FORECAST_KIND_LABEL.risk, "At risk");
});

// ── effectiveSupply ─────────────────────────────────────────────────────────

t("effectiveSupply week 0 with no rates = raw available", () => {
  const s = effectiveSupply(0, 65, {});
  assert.deepEqual(
    [s.rawAvail, s.notReadyOnboarding, s.attritionLoss, s.calloutLoss, s.effective],
    [65, 0, 0, 0, 65],
  );
});

t("effectiveSupply subtracts not-ready onboarding drivers", () => {
  const s = effectiveSupply(0, 65, { onboardingNotReady: 4 });
  assert.equal(s.effective, 61);
});

t("effectiveSupply compounds attrition by week index", () => {
  // 2%/wk on 100 bodies: wk0 = 0 lost, wk1 = 2, wk10 ≈ 18.
  assert.equal(effectiveSupply(0, 100, { weeklyAttritionRate: 0.02 }).attritionLoss, 0);
  assert.equal(effectiveSupply(1, 100, { weeklyAttritionRate: 0.02 }).attritionLoss, 2);
  const wk10 = effectiveSupply(10, 100, { weeklyAttritionRate: 0.02 }).attritionLoss;
  assert.ok(wk10 >= 17 && wk10 <= 19, `wk10 loss ${wk10}`);
});

t("effectiveSupply discounts callout rate after other deductions", () => {
  // 100 bodies − 10 not ready = 90; 5% callouts → −5 (rounded) → 85.
  const s = effectiveSupply(0, 100, { onboardingNotReady: 10, calloutRate: 0.05 });
  assert.equal(s.calloutLoss, 5);
  assert.equal(s.effective, 85);
});

t("effectiveSupply never goes negative and clamps silly rates", () => {
  assert.equal(effectiveSupply(5, 3, { onboardingNotReady: 99 }).effective, 0);
  // calloutRate capped at 50%, attrition at 10%/wk.
  assert.equal(effectiveSupply(0, 100, { calloutRate: 9 }).calloutLoss, 50);
  assert.equal(effectiveSupply(1, 100, { weeklyAttritionRate: 5 }).attritionLoss, 10);
});

// ── assessPlan · gaps, statuses, rollups ───────────────────────────────────

t("assessPlan requires todayIso", () => {
  assert.throws(() => assessPlan([], {}), /todayIso/);
});

t("assessPlan worst week is the deepest shortfall, not the sum", () => {
  const a = assessPlan(
    mkWeeks([
      { needed: 90, avail: 65 },  // −25
      { needed: 100, avail: 65 }, // −35  ← worst
      { needed: 80, avail: 65 },  // −15
    ]),
    { todayIso: "2026-07-01" },
  );
  assert.equal(a.worstWeek.gap, -35);
  assert.equal(a.driverWeeksShort, 25 + 35 + 15); // labeled driver-weeks, not drivers
});

t("assessPlan horizon sums only the first N weeks", () => {
  const a = assessPlan(
    mkWeeks([
      { needed: 70, avail: 65 }, { needed: 70, avail: 65 },
      { needed: 70, avail: 65 }, { needed: 70, avail: 65 },
      { needed: 200, avail: 65 }, // outside 4-wk horizon
    ]),
    { todayIso: "2026-07-01" },
  );
  assert.equal(a.horizon.driverWeeksShort, 5 * 4);
});

t("assessPlan trend declines when horizon coverage erodes", () => {
  const declining = assessPlan(
    mkWeeks([
      { needed: 65, avail: 65 }, { needed: 75, avail: 65 },
      { needed: 85, avail: 65 }, { needed: 95, avail: 65 },
    ]),
    { todayIso: "2026-07-01" },
  );
  assert.equal(declining.trend, "declining");
  const steady = assessPlan(
    mkWeeks([{ needed: 65, avail: 65 }, { needed: 65, avail: 65 }]),
    { todayIso: "2026-07-01" },
  );
  assert.equal(steady.trend, "steady");
});

t("assessPlan headline never calmer than the worst week", () => {
  const a = assessPlan(
    mkWeeks([{ needed: 65, avail: 65 }, { needed: 100, avail: 65 }]),
    { todayIso: "2026-07-01" },
  );
  assert.equal(a.weeks[1].kind, "risk");
  assert.equal(a.headline, "risk");
});

// ── assessPlan · hire-by reachability + prescription ───────────────────────

t("prescription: hire = deepest REACHABLE shortfall, by earliest deadline", () => {
  // Today 2026-07-01, lead 28d → weeks starting ≥ 2026-07-29 are reachable.
  const a = assessPlan(
    mkWeeks([
      { needed: 92, avail: 65 },  // starts 07-06, hire-by 06-08 → past
      { needed: 70, avail: 65 },  // 07-13 → past
      { needed: 70, avail: 65 },  // 07-20 → past
      { needed: 70, avail: 65 },  // 07-27 → past
      { needed: 100, avail: 65 }, // 08-03, hire-by 07-06 → open, −35
      { needed: 90, avail: 65 },  // 08-10 → open, −25
    ]),
    { todayIso: "2026-07-01", hireLeadDays: 28 },
  );
  assert.equal(a.prescription.action, "hire");
  assert.equal(a.prescription.hires, 35);            // deepest reachable, NOT 27+5+5+5+35+25
  assert.equal(a.prescription.deadlineIso, "2026-07-06");
  assert.equal(a.prescription.unreachable.length, 4);
  assert.equal(a.weeks[0].hireByStatus, "past");
  assert.equal(a.weeks[4].hireByStatus, "open");
});

t("prescription: all short weeks past their hire window → mitigate", () => {
  const a = assessPlan(
    mkWeeks([{ needed: 92, avail: 65 }, { needed: 70, avail: 68 }]),
    { todayIso: "2026-07-10", hireLeadDays: 28 }, // both hire-bys long past
  );
  assert.equal(a.prescription.action, "mitigate");
  assert.equal(a.prescription.shortNow, 27);
  assert.equal(a.prescription.firstShort.idx, 0);
  assert.equal(a.prescription.readyByIso, "2026-08-07"); // today + 28
});

t("prescription: fully staffed plan → none", () => {
  const a = assessPlan(
    mkWeeks([{ needed: 60, avail: 65 }, { needed: 62, avail: 65 }]),
    { todayIso: "2026-07-01" },
  );
  assert.equal(a.prescription.action, "none");
  assert.equal(a.worstWeek.gap, 3); // "worst" = smallest surplus when nothing is short
});

t("short weeks without weekStartIso still get a mitigation prescription", () => {
  const a = assessPlan(
    [{ idx: 0, label: "W28", dates: "x", needed: 92, avail: 65 }], // no weekStartIso
    { todayIso: "2026-07-10" },
  );
  assert.equal(a.prescription.action, "mitigate");
  assert.equal(a.prescription.shortNow, 27);
  assert.equal(a.weeks[0].hireByIso, null);
});

t("covered weeks carry no hire-by status", () => {
  const a = assessPlan(
    mkWeeks([{ needed: 60, avail: 65 }]),
    { todayIso: "2026-07-01" },
  );
  assert.equal(a.weeks[0].hireByStatus, null);
});

t("assessPlan folds rates + onboarding gating into the gaps", () => {
  const weeks = mkWeeks([
    { needed: 65, avail: 68 }, // healthy on paper…
    { needed: 65, avail: 68 },
  ]);
  const a = assessPlan(weeks, {
    todayIso: "2026-07-01",
    calloutRate: 0.06,
    weeklyAttritionRate: 0.01,
    onboardingNotReadyByWeek: { [weeks[0].weekStartIso]: 5, [weeks[1].weekStartIso]: 5 },
  });
  // wk0: 68 − 5 notReady = 63, −4 callouts (6%) = 59 → short 6.
  assert.equal(a.weeks[0].effAvail, 59);
  assert.equal(a.weeks[0].gap, -6);
  assert.equal(a.weeks[0].kind, "watch"); // 59/65 ≈ 91%
});

// ── Calculator options · extraSupply + demandOverride ─────────────────────

t("extraSupply adds hires only from their arrival week forward", () => {
  const weeks = mkWeeks([
    { needed: 80, avail: 65 }, // −15
    { needed: 80, avail: 65 }, // −15, hires arrive here
    { needed: 80, avail: 65 }, // −15
  ]);
  const a = assessPlan(weeks, {
    todayIso: "2026-07-01",
    extraSupply: { fromIso: weeks[1].weekStartIso, count: 10 },
  });
  assert.equal(a.weeks[0].effAvail, 65);
  assert.equal(a.weeks[0].supply.extraHires, 0);
  assert.equal(a.weeks[1].effAvail, 75);
  assert.equal(a.weeks[1].supply.extraHires, 10);
  assert.equal(a.weeks[2].effAvail, 75);
});

t("extra hires call out at the observed rate like everyone else", () => {
  // 90 bodies + 10 hires = 100 × 10% callouts → 90 effective.
  const weeks = mkWeeks([{ needed: 95, avail: 90 }]);
  const a = assessPlan(weeks, {
    todayIso: "2026-07-01",
    calloutRate: 0.10,
    extraSupply: { fromIso: weeks[0].weekStartIso, count: 10 },
  });
  assert.equal(a.weeks[0].supply.calloutLoss, 10);
  assert.equal(a.weeks[0].effAvail, 90);
});

t("demandOverride recomputes needed from routesMax; weeks without keep planned", () => {
  const weeks = mkWeeks([
    { needed: 88, avail: 65, routesMax: 40 }, // 40 × 1.5 × 1.0 = 60
    { needed: 70, avail: 65 },                // no routesMax → planned 70 stands
  ]);
  const a = assessPlan(weeks, {
    todayIso: "2026-07-01",
    demandOverride: { driversPerRoute: 1.5, padPct: 0 },
  });
  assert.equal(a.weeks[0].needed, 60);
  assert.equal(a.weeks[0].gap, 5);
  assert.equal(a.weeks[1].needed, 70);
});

t("calculator options change the prescription end to end", () => {
  const weeks = mkWeeks([
    { needed: 70, avail: 65 }, { needed: 70, avail: 65 },
    { needed: 70, avail: 65 }, { needed: 70, avail: 65 },
    { needed: 70, avail: 65 }, { needed: 70, avail: 65 },
  ]);
  const base = assessPlan(weeks, { todayIso: "2026-07-01" });
  assert.equal(base.prescription.action, "hire");
  const fixed = assessPlan(weeks, {
    todayIso: "2026-07-01",
    extraSupply: { fromIso: weeks[0].weekStartIso, count: 5 },
  });
  assert.equal(fixed.prescription.action, "none");
});

console.log(`test-labor-forecast: ${passed} passed${process.exitCode ? " (with failures)" : ""}`);
