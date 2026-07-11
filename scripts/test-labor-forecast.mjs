#!/usr/bin/env node
// Tests for dashboard/forecast-core.js — the shared labor-forecast math.
// Run: node scripts/test-labor-forecast.mjs (also part of `npm test`).

import assert from "node:assert/strict";
import {
  assessPlan,
  coverageKind,
  driversNeeded,
  effectiveSupply,
  isoAddDays,
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

console.log(`test-labor-forecast: ${passed} passed${process.exitCode ? " (with failures)" : ""}`);
