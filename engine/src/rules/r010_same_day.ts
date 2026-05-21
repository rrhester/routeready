// R010 — Same-day multi-shift policy [HARD].

import type { BlockReason, DriverState, NormalizedShift, Settings } from "../types.ts";

export function checkSameDay(
  shift: NormalizedShift,
  state: DriverState,
  settings: Settings,
): BlockReason | null {
  if (settings.same_day_multi_shift === "allow") return null;
  for (const a of state.assigned) {
    if (a.shift_id === shift.shift_id) continue;
    if (a.date === shift.date) {
      return {
        rule: "R010",
        message: `Already assigned a shift on ${shift.date}`,
      };
    }
  }
  return null;
}
