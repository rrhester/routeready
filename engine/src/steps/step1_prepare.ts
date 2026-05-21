// Step 1 — Prepare schedule per run mode (R001).
// After this step every shift is locked-assigned, preserved, closed
// (blackout, empty), or open and ready for auto-fill.

import type { AssignmentSource } from "../types.ts";
import type { EngineContext } from "../runtime.ts";
import type { ShiftPlan } from "../plan.ts";

export function prepareSchedule(ctx: EngineContext): ShiftPlan[] {
  const mode = ctx.settings.run_mode;
  const preserveLocked = ctx.settings.preserve_locked_assignments;

  return ctx.shifts.map((shift): ShiftPlan => {
    const orig = shift.original_assigned_driver_id;
    const locked = shift.is_locked;
    let assignedDriverId: string | null = null;
    let source: AssignmentSource | null = null;

    if (orig !== null && orig !== "") {
      if (mode === "fill_empty_only") {
        assignedDriverId = orig;
        source = locked ? "locked" : "preserved";
      } else if (mode === "rebuild_unlocked") {
        if (locked) {
          assignedDriverId = orig;
          source = "locked";
        }
      } else {
        // full_rebuild — clears unlocked; clears locked only when
        // preserve_locked_assignments is false.
        if (locked && preserveLocked) {
          assignedDriverId = orig;
          source = "locked";
        }
      }
    }

    const isBlackout = ctx.blackout.has(shift.date);
    let open = assignedDriverId === null;
    let closed = false;
    if (isBlackout) {
      open = false; // a blackout shift is never auto-filled
      if (assignedDriverId === null) closed = true;
    }

    return { shift, assignedDriverId, source, open, closed };
  });
}
