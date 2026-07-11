// materializeScenario tests — deterministic count → Scenario expansion.
import { test } from "node:test";
import assert from "node:assert/strict";

import { materializeScenario } from "../src/simple.ts";
import { runWhatIf } from "../src/whatif.ts";
import { mkDriver, mkDrivers, mkInput, mkRoutes } from "./helpers.ts";

test("demand-only simple scenario carries routes + multiplier through", () => {
  const input = mkInput({ drivers: mkDrivers(10), routes: mkRoutes(6) });
  const s = materializeScenario(input, { addRoutesPerDay: 4, routeMultiplier: 1.25 });
  assert.equal(s.kind, "prime_week");
  assert.equal(s.addRoutesPerDay, 4);
  assert.equal(s.routeMultiplier, 1.25);
  assert.equal(s.removeDriverIds, undefined);
  assert.equal(s.calloutDriverDays, undefined);
  assert.equal(s.growthRoutesPerDay, 4);
});

test("attrition removes the most-scheduled drivers first, deterministically", () => {
  const drivers = [
    mkDriver({ id: "light", scheduledDays: ["mon"] }),
    mkDriver({ id: "heavy", scheduledDays: ["mon", "tue", "wed", "thu"] }),
    mkDriver({ id: "mid", scheduledDays: ["mon", "tue"] }),
  ];
  const input = mkInput({ drivers, routes: mkRoutes(2) });
  const s = materializeScenario(input, { attritionCount: 2 });
  assert.equal(s.kind, "driver_attrition");
  assert.deepEqual(s.removeDriverIds, ["heavy", "mid"]);
  // Same input, same answer — no randomness.
  assert.deepEqual(materializeScenario(input, { attritionCount: 2 }).removeDriverIds, ["heavy", "mid"]);
});

test("callouts land on a scheduled day and never overlap attrition picks", () => {
  const drivers = [
    mkDriver({ id: "a", scheduledDays: ["wed", "thu"] }),
    mkDriver({ id: "b", scheduledDays: ["tue"] }),
    mkDriver({ id: "c", scheduledDays: [] }), // falls back to first available day
  ];
  const input = mkInput({ drivers, routes: mkRoutes(2) });
  const s = materializeScenario(input, { attritionCount: 1, calloutCount: 2 });
  assert.deepEqual(s.removeDriverIds, ["a"]); // most scheduled leaves
  assert.deepEqual(s.calloutDriverDays, [
    { driverId: "b", days: ["tue"] },  // their scheduled day
    { driverId: "c", days: ["mon"] },  // fallback: first available
  ]);
});

test("counts clamp to the roster and inactive drivers are never picked", () => {
  const drivers = [
    mkDriver({ id: "on" }),
    mkDriver({ id: "off", active: false }),
  ];
  const input = mkInput({ drivers, routes: mkRoutes(1) });
  const s = materializeScenario(input, { attritionCount: 99, calloutCount: 99 });
  assert.deepEqual(s.removeDriverIds, ["on"]);
  assert.equal(s.calloutDriverDays, undefined); // nobody left to call out
});

test("a zeroed simple scenario is a no-op verdict on current demand", () => {
  const input = mkInput({ drivers: mkDrivers(8), routes: mkRoutes(6) });
  const s = materializeScenario(input, { addRoutesPerDay: 0 });
  assert.equal(s.kind, "route_growth");
  const verdict = runWhatIf(input, s);
  // 8 fully-preferred drivers vs 6 routes/day = comfortably covered.
  assert.equal(verdict.status, "green");
  assert.equal(verdict.canCover, true);
  assert.equal(verdict.driversNeeded, 0);
});

test("materialized scenario stresses the engine the way the counts imply", () => {
  // 8 drivers / 6 routes/day is green; losing 3 workhorses should not be.
  const drivers = mkDrivers(8).map((d, i) => ({ ...d, scheduledDays: i < 4 ? ["mon", "tue", "wed", "thu"] as const : [] }));
  const input = mkInput({ drivers: drivers.map((d) => ({ ...d, scheduledDays: [...d.scheduledDays] })), routes: mkRoutes(6) });
  const verdict = runWhatIf(input, materializeScenario(input, { attritionCount: 3 }));
  assert.ok(verdict.status !== "green", `expected stress, got ${verdict.status}`);
  assert.ok(verdict.driversNeeded > 0);
});
