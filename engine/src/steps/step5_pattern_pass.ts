// Step 5 — Pattern preservation pass (R012, `high` strength only).
// Each driver, in scheduling-method order, claims their highest-affinity
// open shifts up to min(avg_weekly_days, max_days).

import type { EngineContext } from "../runtime.ts";
import { type WorkingSchedule, applyAssignment } from "../plan.ts";
import type { ShiftPlan } from "../plan.ts";
import { uniqueDatesInWindow } from "../runtime.ts";
import { orderDrivers } from "../rules/r015_method.ts";
import { HIGH_AFFINITY_THRESHOLD } from "../rules/r012_patterns.ts";
import {
  type EligibilityMatrix,
  recomputeDriverColumn,
} from "./step3_eligibility.ts";

export function runPatternPass(
  ctx: EngineContext,
  ws: WorkingSchedule,
  matrix: EligibilityMatrix,
): void {
  if (ctx.settings.historical_pattern_protection !== "high") return;

  for (const driver of orderDrivers(ctx, ws.states)) {
    const pattern = ctx.patterns.get(driver.driver_id);
    const state = ws.states.get(driver.driver_id);
    if (!pattern || !state) continue;

    const target = Math.floor(
      Math.min(pattern.avg_weekly_days, ctx.settings.max_days),
    );
    let budget =
      target - uniqueDatesInWindow(state, ctx.scheduleWeek).size;
    if (budget <= 0) continue;

    const candidates: ShiftPlan[] = [];
    for (const plan of ws.plans) {
      if (!plan.open) continue;
      if (
        pattern.day_of_week_affinity[plan.shift.dow] < HIGH_AFFINITY_THRESHOLD
      ) {
        continue;
      }
      candidates.push(plan);
    }
    candidates.sort((a, b) => {
      const fa = pattern.day_of_week_affinity[a.shift.dow];
      const fb = pattern.day_of_week_affinity[b.shift.dow];
      if (fa !== fb) return fb - fa; // highest affinity first
      if (a.shift.date !== b.shift.date) {
        return a.shift.date < b.shift.date ? -1 : 1;
      }
      if (a.shift.start_ms !== b.shift.start_ms) {
        return a.shift.start_ms - b.shift.start_ms;
      }
      return a.shift.shift_id < b.shift.shift_id ? -1 : 1;
    });

    for (const plan of candidates) {
      if (budget <= 0) break;
      if (!plan.open) continue;
      const cell = matrix.get(plan.shift.shift_id)?.get(driver.driver_id);
      if (!cell || !cell.eligible) continue;
      applyAssignment(ws, plan, driver.driver_id, "pattern_pass");
      matrix.delete(plan.shift.shift_id);
      recomputeDriverColumn(ctx, ws, matrix, driver.driver_id);
      budget -= 1;
    }
  }
}
