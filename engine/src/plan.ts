// Mutable working schedule shared across algorithm steps. The orchestrator
// owns mutation; steps call applyAssignment — rule checks stay pure.

import type {
  AssignedRef,
  AssignmentSource,
  DriverState,
  NormalizedShift,
  ScoreComponents,
} from "./types.ts";

export interface ShiftPlan {
  shift: NormalizedShift;
  assignedDriverId: string | null;
  source: AssignmentSource | null;
  /** Empty and available for auto-fill. */
  open: boolean;
  /** Blackout date with no assignment — reported as closed, not uncovered. */
  closed: boolean;
  /** Score the winning driver earned (auto_fill only; explains the pick). */
  score?: number;
  /** Per-factor breakdown of `score` (preferred, method, target_days, …). */
  scoreComponents?: ScoreComponents;
}

export interface WorkingSchedule {
  plans: ShiftPlan[];
  planByShiftId: Map<string, ShiftPlan>;
  states: Map<string, DriverState>;
}

export function assignedRefOf(
  shift: NormalizedShift,
  source: AssignmentSource,
): AssignedRef {
  return {
    shift_id: shift.shift_id,
    date: shift.date,
    dow: shift.dow,
    start_ms: shift.start_ms,
    end_ms: shift.end_ms,
    duration_hours: shift.duration_hours,
    source,
  };
}

/** Assign a driver to an open shift and update that driver's state. */
export function applyAssignment(
  ws: WorkingSchedule,
  plan: ShiftPlan,
  driverId: string,
  source: AssignmentSource,
  score?: number,
  scoreComponents?: ScoreComponents,
): void {
  plan.assignedDriverId = driverId;
  plan.source = source;
  plan.open = false;
  if (score !== undefined) plan.score = score;
  if (scoreComponents !== undefined) plan.scoreComponents = scoreComponents;
  const state = ws.states.get(driverId);
  if (state) state.assigned.push(assignedRefOf(plan.shift, source));
}
