// What-If planning engine tests.
import { test } from "node:test";
import assert from "node:assert/strict";

import { applyScenario, runWhatIf, type Scenario } from "../src/whatif.ts";
import { mkDrivers, mkInput, mkRoutes } from "./helpers.ts";

test("applyScenario never mutates the original input", () => {
  const input = mkInput({ drivers: mkDrivers(5), routes: mkRoutes(3) });
  const snapshot = JSON.stringify(input);
  const scenario: Scenario = {
    kind: "pto_event",
    addRoutesPerDay: 2,
    ptoDriverDays: [{ driverId: "d0", days: ["mon"] }],
    certLoss: [{ driverId: "d1", cert: "xl" }],
    removeDriverIds: ["d2"],
  };
  applyScenario(input, scenario);
  assert.equal(JSON.stringify(input), snapshot, "original untouched");
});

test("route_growth raises demand and shrinks remaining capacity", () => {
  const input = mkInput({ drivers: mkDrivers(10), routes: mkRoutes(5) });
  const base = runWhatIf(input, { kind: "route_growth", addRoutesPerDay: 0 });
  const grown = runWhatIf(input, { kind: "route_growth", addRoutesPerDay: 3 });
  assert.ok(grown.comfortableRemaining <= base.comfortableRemaining);
  assert.ok(grown.maximumRemaining <= base.maximumRemaining);
});

test("status is critical when even Maximum cannot cover demand", () => {
  // 3 drivers, demand 9/day → uncoverable at every tier.
  const r = runWhatIf(mkInput({ drivers: mkDrivers(3), routes: mkRoutes(9) }), {
    kind: "route_growth",
    addRoutesPerDay: 0,
  });
  assert.equal(r.canCover, false);
  assert.equal(r.status, "critical");
  assert.ok(r.weeklyShortage > 0);
  assert.ok(r.driversNeeded > 0);
});

test("hiring_plan can flip a critical scenario to covered", () => {
  const input = mkInput({ drivers: mkDrivers(3), routes: mkRoutes(8) });
  const before = runWhatIf(input, { kind: "route_growth", addRoutesPerDay: 0 });
  assert.equal(before.canCover, false);

  const newHires = mkDrivers(8).map((d, i) => ({ ...d, id: `hire${i}` }));
  const after = runWhatIf(input, { kind: "hiring_plan", addDrivers: newHires });
  assert.equal(after.canCover, true);
  assert.notEqual(after.status, "critical");
});

test("driver_attrition reduces capacity (more drivers needed)", () => {
  const input = mkInput({ drivers: mkDrivers(8), routes: mkRoutes(6) });
  const before = runWhatIf(input, { kind: "route_growth", addRoutesPerDay: 0 });
  const after = runWhatIf(input, { kind: "driver_attrition", removeDriverIds: ["d0", "d1", "d2"] });
  assert.ok(after.driversNeeded >= before.driversNeeded);
});

test("certification_loss drops coverage for cert-gated routes", () => {
  const drivers = mkDrivers(4).map((d) => ({
    ...d,
    certifications: { dot: false, xl: true, edv: false },
  }));
  const input = mkInput({ drivers, routes: mkRoutes(3, ["mon", "tue", "wed", "thu", "fri"], "xl") });
  const before = runWhatIf(input, { kind: "route_growth", addRoutesPerDay: 0 });
  const after = runWhatIf(input, {
    kind: "certification_loss",
    certLoss: drivers.map((d) => ({ driverId: d.id, cert: "xl" as const })),
  });
  assert.ok(before.canCover);
  assert.equal(after.canCover, false, "no XL-certified drivers left");
});

test("recommended FT + PT hires sum to driversNeeded (85% FT split)", () => {
  const r = runWhatIf(mkInput({ drivers: mkDrivers(2), routes: mkRoutes(9) }), {
    kind: "route_growth",
    addRoutesPerDay: 0,
  });
  assert.equal(r.recommendedFtHires + r.recommendedPtHires, r.driversNeeded);
  assert.ok(r.recommendedFtHires >= r.recommendedPtHires, "FT-weighted");
});

test("confidence is high when comfortably covered, low when critical", () => {
  const easy = runWhatIf(mkInput({ drivers: mkDrivers(20), routes: mkRoutes(3) }), {
    kind: "route_growth",
    addRoutesPerDay: 0,
  });
  const hard = runWhatIf(mkInput({ drivers: mkDrivers(2), routes: mkRoutes(10) }), {
    kind: "route_growth",
    addRoutesPerDay: 0,
  });
  assert.ok(easy.confidenceScore > hard.confidenceScore);
  assert.equal(easy.status, "green");
  assert.equal(hard.status, "critical");
});

test("prime_week multiplier scales demand", () => {
  const input = mkInput({ drivers: mkDrivers(10), routes: mkRoutes(4) });
  const sim = applyScenario(input, { kind: "prime_week", routeMultiplier: 1.5 });
  for (const r of sim.routes) assert.equal(r.routeTarget, 6); // 4 * 1.5
});
