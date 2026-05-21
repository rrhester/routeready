// Step 3 — Build the (driver, open-shift) eligibility matrix.
// Rows exist only for open shifts; a row is dropped once the shift is filled.

import type { EligibilityCell } from "../types.ts";
import type { EngineContext } from "../runtime.ts";
import type { WorkingSchedule } from "../plan.ts";
import { evaluateEligibility } from "../eligibility.ts";

/** shiftId -> (driverId -> eligibility). */
export type EligibilityMatrix = Map<string, Map<string, EligibilityCell>>;

export function buildEligibilityMatrix(
  ctx: EngineContext,
  ws: WorkingSchedule,
): EligibilityMatrix {
  const matrix: EligibilityMatrix = new Map();
  for (const plan of ws.plans) {
    if (!plan.open) continue;
    const row = new Map<string, EligibilityCell>();
    for (const driver of ctx.drivers) {
      const state = ws.states.get(driver.driver_id);
      if (!state) continue;
      row.set(
        driver.driver_id,
        evaluateEligibility(plan.shift, driver, state, ctx),
      );
    }
    matrix.set(plan.shift.shift_id, row);
  }
  return matrix;
}

/** Re-evaluate one driver's cells across every still-open shift. */
export function recomputeDriverColumn(
  ctx: EngineContext,
  ws: WorkingSchedule,
  matrix: EligibilityMatrix,
  driverId: string,
): void {
  const driver = ctx.driverById.get(driverId);
  const state = ws.states.get(driverId);
  if (!driver || !state) return;
  for (const [shiftId, row] of matrix) {
    const plan = ws.planByShiftId.get(shiftId);
    if (!plan) continue;
    row.set(driverId, evaluateEligibility(plan.shift, driver, state, ctx));
  }
}
