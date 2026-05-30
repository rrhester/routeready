// Daily-max (by hour cap) tests.
import { test } from "node:test";
import assert from "node:assert/strict";

import { computeDailyMax, withHires, STANDARD_SCENARIOS } from "../src/daily-max.ts";
import { mkDriver } from "./helpers.ts";

const ALL = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

test("40h vs 50h differ for a driver available more days than the cap allows", () => {
  // Available 6 days, 10h blocks, opted into 5th day, maxDays 7.
  const d = mkDriver({
    id: "a",
    available: ["mon", "tue", "wed", "thu", "fri", "sat"],
    maxDaysPerWeek: 7,
    fifthDayOptIn: true,
  });
  const at40 = computeDailyMax([d], { label: "40", capHours: 40, fifthDayPolicy: "none" });
  const at50 = computeDailyMax([d], { label: "50", capHours: 50, fifthDayPolicy: "all" });
  // 40h → 4 of 6 days = 0.67/day; 50h → 5 of 6 = 0.83/day. Summed over 6 days:
  const sum40 = at40.perDayRaw.reduce((s, x) => s + x.routes, 0);
  const sum50 = at50.perDayRaw.reduce((s, x) => s + x.routes, 0);
  assert.ok(Math.abs(sum40 - 4) < 1e-9, "40h budget = 4 driver-days");
  assert.ok(Math.abs(sum50 - 5) < 1e-9, "50h budget = 5 driver-days");
  assert.ok(sum50 > sum40);
});

test("driver available ≤ cap days is unaffected by 40 vs 50", () => {
  const d = mkDriver({ id: "b", available: ["mon", "tue", "wed", "thu"], maxDaysPerWeek: 7 });
  const at40 = computeDailyMax([d], { label: "40", capHours: 40, fifthDayPolicy: "none" });
  const at50 = computeDailyMax([d], { label: "50", capHours: 50, fifthDayPolicy: "all" });
  // 4 available, budget 4 either way → full 1.0 on each of the 4 days.
  for (const day of ["mon", "tue", "wed", "thu"] as const) {
    assert.equal(at40.perDay.find((x) => x.day === day)!.routes, 1);
    assert.equal(at50.perDay.find((x) => x.day === day)!.routes, 1);
  }
});

test("voluntary 5th day only extends opted-in drivers", () => {
  const opted = mkDriver({ id: "o", available: [...ALL], maxDaysPerWeek: 7, fifthDayOptIn: true });
  const notOpted = mkDriver({ id: "n", available: [...ALL], maxDaysPerWeek: 7, fifthDayOptIn: false });
  const vol = computeDailyMax([opted, notOpted], { label: "v", capHours: 50, fifthDayPolicy: "voluntary" });
  // opted: 5/7 each day; notOpted: 4/7 each day → 9/7 per day total.
  const monRaw = vol.perDayRaw.find((x) => x.day === "mon")!.routes;
  assert.ok(Math.abs(monRaw - 9 / 7) < 1e-9, "opted 5 + non-opted 4 over 7 days");
});

test("PT hire is capped at its max days regardless of hour cap", () => {
  // No base drivers; 1 PT hire available 7d, maxDays 3.
  const pool = withHires([], 0, 1, { ptMaxDays: 3 });
  const r = computeDailyMax(pool, { label: "50all", capHours: 50, fifthDayPolicy: "all" });
  const total = r.perDayRaw.reduce((s, x) => s + x.routes, 0);
  assert.ok(Math.abs(total - 3) < 1e-9, "PT contributes only 3 driver-days even at 50h");
});

test("hiring +10 FT / +5 PT raises every day's capacity", () => {
  const base = [mkDriver({ id: "x", available: ["mon", "tue", "wed"], maxDaysPerWeek: 5 })];
  const scen = STANDARD_SCENARIOS[2]!; // ≤50h everyone
  const before = computeDailyMax(base, scen);
  const after = computeDailyMax(withHires(base, 10, 5), scen);
  for (const day of ALL) {
    const b = before.perDay.find((x) => x.day === day)!.routes;
    const a = after.perDay.find((x) => x.day === day)!.routes;
    assert.ok(a >= b, `${day} not lower after hiring`);
  }
  // 10 FT (7d, 5/7 each) + 5 PT (3/7 each) = (50+15)/7 ≈ 9.3 added per day.
  const addedMon = after.perDayRaw.find((x) => x.day === "mon")!.routes -
    before.perDayRaw.find((x) => x.day === "mon")!.routes;
  assert.ok(Math.abs(addedMon - 65 / 7) < 1e-6);
});

test("inputs are not mutated", () => {
  const drivers = [mkDriver({ id: "x", available: [...ALL], maxDaysPerWeek: 7 })];
  const snap = JSON.stringify(drivers);
  withHires(drivers, 3, 2);
  computeDailyMax(drivers, STANDARD_SCENARIOS[0]!);
  assert.equal(JSON.stringify(drivers), snap);
});
