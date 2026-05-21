// Step 8d — Fifth-Day Fill (optional final pass).
//
// After every other pass, shifts can still be open because every
// remaining driver is already at their max allowable days. This pass
// layers in ONE extra ("5th") day for drivers who opted in
// (fifth_day_ok), assigning each to an open shift — provided it breaks
// no other rule. Only the max-days cap is relaxed; WOC (consecutive
// days + weekly hours), license, availability, certification and
// one-shift-per-day are all still enforced. Each opted-in driver picks
// up at most one extra day.

import type { EngineContext } from "../runtime.ts";
import { type WorkingSchedule, applyAssignment } from "../plan.ts";
import { evaluateEligibility } from "../eligibility.ts";
import { orderDrivers } from "../rules/r015_method.ts";

export function runFifthDayFill(
  ctx: EngineContext,
  ws: WorkingSchedule,
): number {
  if (!ctx.settings.fifth_day_fill) return 0;

  // Eligibility with the max-days cap lifted; every other enabled rule
  // still gates, so a 5th day can never violate WOC or license.
  const relaxedCtx: EngineContext = {
    ...ctx,
    settings: { ...ctx.settings, max_days_enforcement: false },
  };

  const order = orderDrivers(ctx, ws.states);
  const extraGiven = new Set<string>();

  const openPlans = ws.plans
    .filter((p) => p.open)
    .sort((a, b) =>
      a.shift.date !== b.shift.date
        ? (a.shift.date < b.shift.date ? -1 : 1)
        : a.shift.start_ms !== b.shift.start_ms
          ? a.shift.start_ms - b.shift.start_ms
          : (a.shift.shift_id < b.shift.shift_id ? -1 : 1),
    );

  let filled = 0;
  for (const plan of openPlans) {
    for (const driver of order) {
      if (!driver.fifth_day_ok) continue;
      if (extraGiven.has(driver.driver_id)) continue;
      const state = ws.states.get(driver.driver_id);
      if (!state) continue;
      if (!evaluateEligibility(plan.shift, driver, state, relaxedCtx).eligible) {
        continue;
      }
      applyAssignment(ws, plan, driver.driver_id, "fifth_day");
      extraGiven.add(driver.driver_id);
      filled += 1;
      break;
    }
  }
  return filled;
}
