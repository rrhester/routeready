// R007 — Max days per window [HARD if enabled].

import type { BlockReason, DriverState, NormalizedShift } from "../types.ts";
import { inRange } from "../dates.ts";
import {
  type EngineContext,
  uniqueDatesInWindow,
  windowRange,
} from "../runtime.ts";

export function checkMaxDays(
  shift: NormalizedShift,
  state: DriverState,
  ctx: EngineContext,
): BlockReason | null {
  if (!ctx.settings.max_days_enforcement) return null;
  const range = windowRange(ctx.settings.max_days_window, shift, ctx);
  // A shift outside the window does not affect that window's day count.
  if (!inRange(shift.date, range[0], range[1])) return null;

  const dates = uniqueDatesInWindow(state, range);
  dates.add(shift.date);
  if (dates.size > ctx.settings.max_days) {
    return {
      rule: "R007",
      message: `Would exceed max ${ctx.settings.max_days} days in ${ctx.settings.max_days_window}`,
    };
  }
  return null;
}
