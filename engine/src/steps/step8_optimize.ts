// Step 8 — Soft optimization pass (bounded to 3 iterations). Applies the
// single best score-improving driver swap each iteration; a swap must keep
// both drivers eligible, touch no locked/preserved assignment, and improve
// the aggregate score by at least +5 (SPEC §Step 8).

import type { DriverState } from "../types.ts";
import type { EngineContext } from "../runtime.ts";
import { type WorkingSchedule, assignedRefOf } from "../plan.ts";
import type { ShiftPlan } from "../plan.ts";
import { evaluateEligibility } from "../eligibility.ts";
import { orderDrivers } from "../rules/r015_method.ts";
import { computeScore } from "./step7_scoring.ts";

const MIN_IMPROVEMENT = 5;
const MAX_ITERATIONS = 3;

interface Swap {
  p1: ShiftPlan;
  p2: ShiftPlan;
  delta: number;
}

function stateWithout(state: DriverState, shiftId: string): DriverState {
  return {
    driver_id: state.driver_id,
    assigned: state.assigned.filter((a) => a.shift_id !== shiftId),
  };
}

function isSwappable(plan: ShiftPlan): boolean {
  return (
    plan.assignedDriverId !== null &&
    (plan.source === "auto_fill" ||
      plan.source === "pattern_pass" ||
      plan.source === "swap")
  );
}

export function runOptimization(
  ctx: EngineContext,
  ws: WorkingSchedule,
): number {
  let iterations = 0;
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const swap = findBestSwap(ctx, ws);
    if (!swap) break;
    applySwap(ws, swap);
    iterations += 1;
  }
  return iterations;
}

function findBestSwap(ctx: EngineContext, ws: WorkingSchedule): Swap | null {
  const rank = new Map<string, number>();
  orderDrivers(ctx, ws.states).forEach((d, i) => rank.set(d.driver_id, i + 1));
  const swappable = ws.plans.filter(isSwappable);

  let best: Swap | null = null;
  for (let i = 0; i < swappable.length; i++) {
    for (let j = i + 1; j < swappable.length; j++) {
      const p1 = swappable[i];
      const p2 = swappable[j];
      const d1 = p1.assignedDriverId as string;
      const d2 = p2.assignedDriverId as string;
      if (d1 === d2) continue;

      const driver1 = ctx.driverById.get(d1);
      const driver2 = ctx.driverById.get(d2);
      const state1 = ws.states.get(d1);
      const state2 = ws.states.get(d2);
      if (!driver1 || !driver2 || !state1 || !state2) continue;

      const base1 = stateWithout(state1, p1.shift.shift_id);
      const base2 = stateWithout(state2, p2.shift.shift_id);

      // Post-swap eligibility: each driver gives up their shift, takes the other.
      const d2TakesP1 = evaluateEligibility(p1.shift, driver2, base2, ctx);
      const d1TakesP2 = evaluateEligibility(p2.shift, driver1, base1, ctx);
      if (!d2TakesP1.eligible || !d1TakesP2.eligible) continue;

      const current =
        computeScore(ctx, p1.shift, driver1, base1, rank.get(d1) ?? 0).total +
        computeScore(ctx, p2.shift, driver2, base2, rank.get(d2) ?? 0).total;
      const swapped =
        computeScore(ctx, p1.shift, driver2, base2, rank.get(d2) ?? 0).total +
        computeScore(ctx, p2.shift, driver1, base1, rank.get(d1) ?? 0).total;
      const delta = swapped - current;
      if (delta < MIN_IMPROVEMENT) continue;

      if (best === null || delta > best.delta) {
        best = { p1, p2, delta };
      }
    }
  }
  return best;
}

function applySwap(ws: WorkingSchedule, swap: Swap): void {
  const { p1, p2 } = swap;
  const d1 = p1.assignedDriverId as string;
  const d2 = p2.assignedDriverId as string;
  const state1 = ws.states.get(d1);
  const state2 = ws.states.get(d2);
  if (!state1 || !state2) return;

  state1.assigned = state1.assigned.filter(
    (a) => a.shift_id !== p1.shift.shift_id,
  );
  state2.assigned = state2.assigned.filter(
    (a) => a.shift_id !== p2.shift.shift_id,
  );

  p1.assignedDriverId = d2;
  p1.source = "swap";
  p2.assignedDriverId = d1;
  p2.source = "swap";
  state2.assigned.push(assignedRefOf(p1.shift, "swap"));
  state1.assigned.push(assignedRefOf(p2.shift, "swap"));
  state1.assigned.sort((a, b) =>
    a.shift_id < b.shift_id ? -1 : a.shift_id > b.shift_id ? 1 : 0,
  );
  state2.assigned.sort((a, b) =>
    a.shift_id < b.shift_id ? -1 : a.shift_id > b.shift_id ? 1 : 0,
  );
}
