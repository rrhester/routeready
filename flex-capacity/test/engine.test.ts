// Core flex-capacity engine tests.
import { test } from "node:test";
import assert from "node:assert/strict";

import { computeFlexCapacity, coachingFor } from "../src/engine.ts";
import { canWorkAtTier } from "../src/helpers.ts";
import { DEFAULT_CONFIG } from "../src/types.ts";
import { mkDriver, mkDrivers, mkInput, mkRoutes, WEEKDAYS } from "./helpers.ts";

test("tiers are monotonic: comfortable ≤ stretch ≤ maximum every day", () => {
  // Mix of preferred/non-preferred, opted-in, and partially-scheduled drivers.
  const drivers = [
    ...mkDrivers(5),
    mkDriver({ id: "np", preferred: [] }), // available but no preferred days
    mkDriver({ id: "v", preferred: [], fifthDayOptIn: true, scheduledDays: ["mon", "tue", "wed", "thu"] }),
    mkDriver({ id: "x", scheduledDays: ["mon", "tue", "wed", "thu"] }), // at 4 days, no opt-in
  ];
  const res = computeFlexCapacity(mkInput({ drivers, routes: mkRoutes(3) }));
  for (const d of res.days) {
    assert.ok(d.comfortableDrivers <= d.stretchDrivers, `comf≤stretch ${d.day}`);
    assert.ok(d.stretchDrivers <= d.maximumDrivers, `stretch≤max ${d.day}`);
    assert.ok(d.comfortableFlexRoutes <= d.stretchFlexRoutes);
    assert.ok(d.stretchFlexRoutes <= d.maximumFlexRoutes);
  }
});

test("flex never goes negative (clamped)", () => {
  // 2 drivers, demand 5 → shortage, but flex must clamp to 0 not -3.
  const res = computeFlexCapacity(mkInput({ drivers: mkDrivers(2), routes: mkRoutes(5) }));
  for (const d of res.days) {
    assert.equal(d.comfortableFlexRoutes, 0);
    assert.equal(d.stretchFlexRoutes, 0);
    assert.equal(d.maximumFlexRoutes, 0);
  }
});

test("PTO removes a driver from that day's capacity", () => {
  const drivers = [mkDriver({ id: "a" }), mkDriver({ id: "b", pto: ["mon"] })];
  const res = computeFlexCapacity(mkInput({ drivers, routes: mkRoutes(0) }));
  const mon = res.days.find((d) => d.day === "mon")!;
  const tue = res.days.find((d) => d.day === "tue")!;
  assert.equal(mon.maximumDrivers, 1, "b is on PTO Monday");
  assert.equal(tue.maximumDrivers, 2, "both available Tuesday");
});

test("certification gating: XL route only counts XL-certified drivers", () => {
  const drivers = [
    mkDriver({ id: "plain" }),
    mkDriver({ id: "xl", certifications: { dot: false, xl: true, edv: false } }),
  ];
  const res = computeFlexCapacity(mkInput({ drivers, routes: mkRoutes(0, WEEKDAYS, "xl") }));
  for (const d of res.days) assert.equal(d.maximumDrivers, 1, `only xl driver counts ${d.day}`);
});

test("5th day: only opted-in drivers count at Stretch; Maximum counts regardless", () => {
  const cfg = DEFAULT_CONFIG;
  const optedIn = mkDriver({ id: "v", fifthDayOptIn: true, scheduledDays: ["mon", "tue", "wed", "thu"] });
  const notIn = mkDriver({ id: "n", fifthDayOptIn: false, scheduledDays: ["mon", "tue", "wed", "thu"] });
  // Friday is their 5th day (already at 4 scheduled days).
  assert.equal(canWorkAtTier(optedIn, "fri", "stretch", cfg, undefined), true);
  assert.equal(canWorkAtTier(notIn, "fri", "stretch", cfg, undefined), false);
  assert.equal(canWorkAtTier(notIn, "fri", "maximum", cfg, undefined), true);
  // Neither is "comfortable" on a 5th day.
  assert.equal(canWorkAtTier(optedIn, "fri", "comfortable", cfg, undefined), false);
});

test("hour cap blocks an additional day when it would exceed the cap", () => {
  // 4 days * 10h = 40h scheduled, cap 45 → a 5th 10h block (→50) exceeds cap.
  const d = mkDriver({
    id: "c",
    scheduledDays: ["mon", "tue", "wed", "thu"],
    scheduledHours: 40,
    weeklyHourCap: 45,
    maxDaysPerWeek: 6,
    fifthDayOptIn: true,
  });
  assert.equal(canWorkAtTier(d, "fri", "maximum", DEFAULT_CONFIG, undefined), false);
});

test("weekly rollup + route increase = flex / 7", () => {
  // 10 always-preferred drivers, demand 5/day Mon–Fri.
  const res = computeFlexCapacity(mkInput({ drivers: mkDrivers(10), routes: mkRoutes(5) }));
  const w = res.weekly;
  assert.equal(w.weeklyRequiredRoutes, 25); // 5 days * 5
  assert.equal(w.weeklyComfortableDriverDays, 50); // 5 days * 10
  assert.equal(w.weeklyComfortableFlex, 25);
  assert.equal(w.weeklyComfortableRouteIncrease, Math.round((25 / 7) * 10) / 10);
});

test("KPI: capacity = current peak + rounded availability", () => {
  const routes = [
    ...mkRoutes(5, ["mon", "tue", "wed", "thu"]),
    { day: "fri" as const, routeTarget: 8 }, // peak day
  ];
  const res = computeFlexCapacity(mkInput({ drivers: mkDrivers(12), routes }));
  assert.equal(res.kpi.currentRoutes, 8, "peak day target");
  assert.equal(res.kpi.comfortableCapacity, 8 + res.kpi.comfortableRoutesAvailable);
  assert.ok(res.kpi.comfortableRoutesAvailable >= 0);
});

test("coaching thresholds map growth → green/yellow/red", () => {
  const weekly = {
    weeklyRequiredRoutes: 0,
    weeklyComfortableDriverDays: 0,
    weeklyStretchDriverDays: 0,
    weeklyMaximumDriverDays: 0,
    weeklyComfortableFlex: 0,
    weeklyStretchFlex: 0,
    weeklyMaximumFlex: 0,
    weeklyComfortableRouteIncrease: 5,
    weeklyStretchRouteIncrease: 12,
    weeklyMaximumRouteIncrease: 20,
  };
  assert.equal(coachingFor(weekly, 4).status, "green"); // within comfortable
  assert.equal(coachingFor(weekly, 10).status, "yellow"); // within stretch
  assert.equal(coachingFor(weekly, 15).status, "red"); // beyond stretch
});

test("inputs are not mutated by computeFlexCapacity", () => {
  const input = mkInput({ drivers: mkDrivers(3), routes: mkRoutes(2) });
  const snapshot = JSON.stringify(input);
  computeFlexCapacity(input);
  assert.equal(JSON.stringify(input), snapshot);
});
