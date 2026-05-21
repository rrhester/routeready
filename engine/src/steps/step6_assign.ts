// Step 6 — Main assignment pass (R016: rotational or sequential fill).

import type { NormalizedDriver } from "../types.ts";
import type { EngineContext } from "../runtime.ts";
import { type WorkingSchedule, applyAssignment } from "../plan.ts";
import type { ShiftPlan } from "../plan.ts";
import { orderDrivers } from "../rules/r015_method.ts";
import { computeScore } from "./step7_scoring.ts";
import {
  type EligibilityMatrix,
  recomputeDriverColumn,
} from "./step3_eligibility.ts";

interface Candidate {
  plan: ShiftPlan;
  score: number;
}

/** Best eligible open shift for one driver, or null when none fits. */
export function bestShiftForDriver(
  ctx: EngineContext,
  ws: WorkingSchedule,
  matrix: EligibilityMatrix,
  driver: NormalizedDriver,
  methodRank: number,
): Candidate | null {
  const state = ws.states.get(driver.driver_id);
  if (!state) return null;
  let best: Candidate | null = null;

  for (const [shiftId, row] of matrix) {
    const cell = row.get(driver.driver_id);
    if (!cell || !cell.eligible) continue;
    const plan = ws.planByShiftId.get(shiftId);
    if (!plan || !plan.open) continue;

    const { total } = computeScore(ctx, plan.shift, driver, state, methodRank);
    if (best === null || isBetter(plan, total, best)) {
      best = { plan, score: total };
    }
  }
  return best;
}

// Sort key: score desc, date asc, start_time asc, shift_id asc.
function isBetter(plan: ShiftPlan, score: number, best: Candidate): boolean {
  if (score !== best.score) return score > best.score;
  const a = plan.shift;
  const b = best.plan.shift;
  if (a.date !== b.date) return a.date < b.date;
  if (a.start_ms !== b.start_ms) return a.start_ms < b.start_ms;
  return a.shift_id < b.shift_id;
}

export function runMainPass(
  ctx: EngineContext,
  ws: WorkingSchedule,
  matrix: EligibilityMatrix,
): void {
  const order = orderDrivers(ctx, ws.states);
  const rankMap = new Map<string, number>();
  order.forEach((d, i) => rankMap.set(d.driver_id, i + 1));

  const assignOne = (driver: NormalizedDriver): boolean => {
    const rank = rankMap.get(driver.driver_id) ?? order.length;
    const best = bestShiftForDriver(ctx, ws, matrix, driver, rank);
    if (!best) return false;
    applyAssignment(ws, best.plan, driver.driver_id, "auto_fill");
    matrix.delete(best.plan.shift.shift_id);
    recomputeDriverColumn(ctx, ws, matrix, driver.driver_id);
    return true;
  };

  if (ctx.settings.assignment_mode === "sequential_fill") {
    for (const driver of order) {
      while (assignOne(driver)) {
        /* keep filling this driver until blocked */
      }
    }
  } else {
    let progress = true;
    while (progress) {
      progress = false;
      for (const driver of order) {
        if (assignOne(driver)) progress = true;
      }
    }
  }
}
