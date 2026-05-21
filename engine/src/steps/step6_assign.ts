// Step 6 — Main assignment pass (R016: rotational or sequential fill).
//
// Runs in two phases so DOT-required routes are always filled before any
// DOT-certified driver is spent on a standard route (SPEC Route Fill Order):
//   Phase 1 — DOT-required shifts only.
//   Phase 2 — standard shifts only.
// Within each phase the configured rotational/sequential logic applies.

import type { NormalizedDriver } from "../types.ts";
import { type EngineContext, isDotRoute } from "../runtime.ts";
import { type WorkingSchedule, applyAssignment } from "../plan.ts";
import type { ShiftPlan } from "../plan.ts";
import { orderDrivers } from "../rules/r015_method.ts";
import { computeScore } from "./step7_scoring.ts";
import {
  type EligibilityMatrix,
  recomputeDriverColumn,
} from "./step3_eligibility.ts";

type Phase = "dot" | "standard";

interface Candidate {
  plan: ShiftPlan;
  score: number;
}

function planInPhase(plan: ShiftPlan, phase: Phase): boolean {
  const dot = isDotRoute(plan.shift);
  return phase === "dot" ? dot : !dot;
}

/** Best eligible open shift for one driver within a phase, or null. */
export function bestShiftForDriver(
  ctx: EngineContext,
  ws: WorkingSchedule,
  matrix: EligibilityMatrix,
  driver: NormalizedDriver,
  methodRank: number,
  phase: Phase,
): Candidate | null {
  const state = ws.states.get(driver.driver_id);
  if (!state) return null;
  let best: Candidate | null = null;

  for (const [shiftId, row] of matrix) {
    const cell = row.get(driver.driver_id);
    if (!cell || !cell.eligible) continue;
    const plan = ws.planByShiftId.get(shiftId);
    if (!plan || !plan.open || !planInPhase(plan, phase)) continue;

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

function runPhase(
  ctx: EngineContext,
  ws: WorkingSchedule,
  matrix: EligibilityMatrix,
  phase: Phase,
): void {
  const order = orderDrivers(ctx, ws.states);
  const rankMap = new Map<string, number>();
  order.forEach((d, i) => rankMap.set(d.driver_id, i + 1));

  const assignOne = (driver: NormalizedDriver): boolean => {
    const rank = rankMap.get(driver.driver_id) ?? order.length;
    const best = bestShiftForDriver(ctx, ws, matrix, driver, rank, phase);
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

export function runMainPass(
  ctx: EngineContext,
  ws: WorkingSchedule,
  matrix: EligibilityMatrix,
): void {
  runPhase(ctx, ws, matrix, "dot");
  runPhase(ctx, ws, matrix, "standard");
}
