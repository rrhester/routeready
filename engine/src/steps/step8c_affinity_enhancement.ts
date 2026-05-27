// Step 8c — Driver Affinity Enhancement (optional post-pass).
//
// After every other pass (including the Preferred Availability
// Enhancement) the schedule is final except for affinity. This pass
// does 1-for-1 weekday swaps so drivers land on the weekdays they have
// historically been scheduled on most ("affinity"). A swap trades
// driver A's shift on weekday D for driver B's shift on weekday E when:
//   • total affinity strictly increases, and
//   • the driver taking weekday D has higher D-affinity than the one
//     leaving it (the target day genuinely improves), and
//   • both drivers stay rule-legal on the other's shift.
//
// The DSP picks the weekday priority order. Days are processed in that
// order; once a day is processed its shifts are locked, so a high-
// priority day's placement is protected from a later, lower-priority
// day's swaps.

import type { DriverState, NormalizedDriver } from "../types.ts";
import type { EngineContext } from "../runtime.ts";
import { type ShiftPlan, type WorkingSchedule, assignedRefOf } from "../plan.ts";
import { evaluateEligibility } from "../eligibility.ts";
import { orderDrivers } from "../rules/r015_method.ts";

/** A driver's affinity (0-100) for one weekday; 0 when no history. */
function affinityOf(driver: NormalizedDriver, dow: number): number {
  const a = driver.weekday_affinity;
  return a && a.length === 7 ? a[dow] : 0;
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

/** One pass for a target weekday; returns true once a swap is applied. */
function onePassForDay(
  ctx: EngineContext,
  ws: WorkingSchedule,
  day: number,
  locked: Set<string>,
): boolean {
  const order = orderDrivers(ctx, ws.states);
  const driverById = new Map(order.map((d) => [d.driver_id, d]));

  for (const planA of ws.plans) {
    if (planA.shift.dow !== day) continue;
    if (!planA.assignedDriverId || locked.has(planA.shift.shift_id)) continue;
    // Never swap a shift the operator explicitly locked or pinned —
    // a pin (source="locked") reflects explicit operator intent that
    // must survive every later pass.
    if (planA.source === "locked" || planA.source === "preserved" || planA.source === "pin_lock") continue;
    const a = driverById.get(planA.assignedDriverId);
    const stateA = ws.states.get(planA.assignedDriverId);
    if (!a || !stateA) continue;

    let best: { planB: ShiftPlan; gain: number } | null = null;
    for (const planB of ws.plans) {
      if (planB.shift.dow === day) continue; // must be a different weekday
      if (!planB.assignedDriverId || locked.has(planB.shift.shift_id)) continue;
      if (planB.source === "locked" || planB.source === "preserved" || planB.source === "pin_lock") continue;
      if (planB.assignedDriverId === a.driver_id) continue;
      const b = driverById.get(planB.assignedDriverId);
      const stateB = ws.states.get(planB.assignedDriverId);
      if (!b || !stateB) continue;

      const dA = planA.shift.dow;
      const dB = planB.shift.dow;
      const before = affinityOf(a, dA) + affinityOf(b, dB);
      const after = affinityOf(a, dB) + affinityOf(b, dA);
      if (after <= before) continue;
      // The target day must genuinely improve: the driver moving onto
      // weekday `day` must have higher affinity for it than the one
      // leaving.
      if (affinityOf(b, dA) <= affinityOf(a, dA)) continue;

      // Rule-legal: each driver eligible for the other's shift, with
      // their own swapped-out shift removed from their state first.
      const baseA = stateWithout(stateA, planA.shift.shift_id);
      const baseB = stateWithout(stateB, planB.shift.shift_id);
      if (!evaluateEligibility(planB.shift, a, baseA, ctx).eligible) continue;
      if (!evaluateEligibility(planA.shift, b, baseB, ctx).eligible) continue;

      const gain = after - before;
      if (
        best === null ||
        gain > best.gain ||
        (gain === best.gain &&
          planB.shift.shift_id < best.planB.shift.shift_id)
      ) {
        best = { planB, gain };
      }
    }
    if (best) {
      applySwap(ws, planA, best.planB);
      return true;
    }
  }
  return false;
}

/** Run the affinity enhancement; returns the number of swaps applied. */
export function runAffinityEnhancement(
  ctx: EngineContext,
  ws: WorkingSchedule,
): number {
  if (!ctx.settings.affinity_enhancement) return 0;
  const locked = new Set<string>();
  let swaps = 0;
  for (const day of ctx.settings.affinity_day_order) {
    while (onePassForDay(ctx, ws, day, locked)) swaps += 1;
    // Settle this weekday: lock every assigned shift on it so a later,
    // lower-priority day's pass can't disturb a high-priority day.
    for (const plan of ws.plans) {
      if (plan.shift.dow === day && plan.assignedDriverId) {
        locked.add(plan.shift.shift_id);
      }
    }
  }
  return swaps;
}
