// Step 8b — Preferred Availability Enhancement (optional post-pass).
//
// After the schedule is built, swap pairs of non-preferred-day shifts so
// BOTH drivers land on a preferred day. A swap trades driver A's shift on
// day D (D not preferred for A) with driver B's shift on day E (E not
// preferred for B), where B prefers D and A prefers E — a clean 1-for-1
// trade, so each driver keeps the same shift count.
//
// Deterministic: drivers scanned in fill order, shifts in date order,
// first rule-legal match wins. Each swap moves two (driver, shift) pairs
// from non-preferred onto preferred days, so the pass strictly converges.

import type { DriverState } from "../types.ts";
import type { EngineContext } from "../runtime.ts";
import { type ShiftPlan, type WorkingSchedule, assignedRefOf } from "../plan.ts";
import { addDays } from "../dates.ts";
import { evaluateEligibility } from "../eligibility.ts";
import { orderDrivers } from "../rules/r015_method.ts";
import { inPreferredWindow } from "../rules/r017_preferred.ts";

/** Number of maximal consecutive-day runs in a set of ISO dates. */
function runCount(dates: string[]): number {
  const sorted = [...new Set(dates)].sort();
  if (sorted.length === 0) return 0;
  let runs = 1;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] !== addDays(sorted[i - 1], 1)) runs += 1;
  }
  return runs;
}

function stateWithout(state: DriverState, shiftId: string): DriverState {
  return {
    driver_id: state.driver_id,
    assigned: state.assigned.filter((a) => a.shift_id !== shiftId),
  };
}

function sortBySid(state: DriverState): void {
  state.assigned.sort((a, b) =>
    a.shift_id < b.shift_id ? -1 : a.shift_id > b.shift_id ? 1 : 0,
  );
}

/** Trade two plans' drivers (1-for-1 swap), updating both driver states. */
function applySwap(
  ws: WorkingSchedule,
  planA: ShiftPlan,
  planB: ShiftPlan,
): void {
  const a = planA.assignedDriverId as string;
  const b = planB.assignedDriverId as string;
  const stateA = ws.states.get(a);
  const stateB = ws.states.get(b);
  if (!stateA || !stateB) return;

  stateA.assigned = stateA.assigned.filter(
    (x) => x.shift_id !== planA.shift.shift_id,
  );
  stateB.assigned = stateB.assigned.filter(
    (x) => x.shift_id !== planB.shift.shift_id,
  );
  planA.assignedDriverId = b;
  planA.source = "swap";
  planB.assignedDriverId = a;
  planB.source = "swap";
  stateB.assigned.push(assignedRefOf(planA.shift, "swap"));
  stateA.assigned.push(assignedRefOf(planB.shift, "swap"));
  sortBySid(stateA);
  sortBySid(stateB);
}

/** One rotation pass; returns true once a swap is applied. */
function onePass(
  ctx: EngineContext,
  ws: WorkingSchedule,
  allowScatter: boolean,
): boolean {
  const order = orderDrivers(ctx, ws.states);

  for (const a of order) {
    const stateA = ws.states.get(a.driver_id);
    if (!stateA) continue;
    const aRefs = [...stateA.assigned].sort((x, y) =>
      x.date < y.date ? -1 : x.date > y.date ? 1 : 0,
    );

    for (const refA of aRefs) {
      const planA = ws.planByShiftId.get(refA.shift_id);
      if (!planA || planA.assignedDriverId !== a.driver_id) continue;
      if (inPreferredWindow(planA.shift, a)) continue; // already preferred

      for (const b of order) {
        if (b.driver_id === a.driver_id) continue;
        const stateB = ws.states.get(b.driver_id);
        if (!stateB) continue;
        // B must prefer A's day.
        if (!inPreferredWindow(planA.shift, b)) continue;

        const bRefs = [...stateB.assigned].sort((x, y) =>
          x.date < y.date ? -1 : x.date > y.date ? 1 : 0,
        );
        for (const refB of bRefs) {
          if (refB.date === refA.date) continue;
          const planB = ws.planByShiftId.get(refB.shift_id);
          if (!planB || planB.assignedDriverId !== b.driver_id) continue;
          if (inPreferredWindow(planB.shift, b)) continue;
          // A must prefer B's day.
          if (!inPreferredWindow(planB.shift, a)) continue;

          // Rule-legal: each driver eligible for the other's shift, with
          // their own swapped-out shift removed from their state first.
          const baseA = stateWithout(stateA, refA.shift_id);
          const baseB = stateWithout(stateB, refB.shift_id);
          if (!evaluateEligibility(planB.shift, a, baseA, ctx).eligible) {
            continue;
          }
          if (!evaluateEligibility(planA.shift, b, baseB, ctx).eligible) {
            continue;
          }

          // Contiguity: in the first rotation, neither driver's count of
          // separate day-blocks may increase.
          if (!allowScatter) {
            const aBefore = stateA.assigned.map((x) => x.date);
            const bBefore = stateB.assigned.map((x) => x.date);
            const aAfter = aBefore
              .filter((d) => d !== refA.date)
              .concat(refB.date);
            const bAfter = bBefore
              .filter((d) => d !== refB.date)
              .concat(refA.date);
            if (runCount(aAfter) > runCount(aBefore)) continue;
            if (runCount(bAfter) > runCount(bBefore)) continue;
          }

          applySwap(ws, planA, planB);
          return true;
        }
      }
    }
  }
  return false;
}

/** Run the enhancement; returns the number of swaps applied. */
export function runPreferredEnhancement(
  ctx: EngineContext,
  ws: WorkingSchedule,
): number {
  if (!ctx.settings.preferred_enhancement) return 0;
  let swaps = 0;
  if (ctx.settings.preferred_enhancement_contiguous) {
    while (onePass(ctx, ws, false)) swaps += 1;
  }
  if (ctx.settings.preferred_enhancement_extra) {
    while (onePass(ctx, ws, true)) swaps += 1;
  }
  return swaps;
}
