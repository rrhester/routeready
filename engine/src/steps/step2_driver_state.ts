// Step 2 — Initialize driver state. Locked/preserved assignments are seeded
// so they count toward caps, max-days, and rest from the start.

import type { DriverState } from "../types.ts";
import type { EngineContext } from "../runtime.ts";
import { type ShiftPlan, assignedRefOf } from "../plan.ts";

export function initDriverState(
  ctx: EngineContext,
  plans: ShiftPlan[],
): Map<string, DriverState> {
  const states = new Map<string, DriverState>();
  for (const d of ctx.drivers) {
    states.set(d.driver_id, { driver_id: d.driver_id, assigned: [] });
  }

  for (const plan of plans) {
    if (plan.assignedDriverId === null || plan.source === null) continue;
    const state = states.get(plan.assignedDriverId);
    // Assignment to an unknown driver is surfaced as a violation in Step 9;
    // no state to seed here.
    if (state) state.assigned.push(assignedRefOf(plan.shift, plan.source));
  }

  for (const state of states.values()) {
    state.assigned.sort((a, b) =>
      a.shift_id < b.shift_id ? -1 : a.shift_id > b.shift_id ? 1 : 0,
    );
  }
  return states;
}
