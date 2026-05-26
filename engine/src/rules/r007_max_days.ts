// R007 — Max days per window [HARD if enabled].
//
// Honors per-driver overrides from the ad-hoc rule
// driver_max_days_override (the driver's tighter cap wins over the
// global setting).

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
  // Per-driver override from driver_max_days_override (ad-hoc rule).
  // The tighter (lower) cap wins.
  const override = ctx.adHoc.maxDaysOverride.get(state.driver_id);
  const cap = override !== undefined
    ? Math.min(ctx.settings.max_days, override)
    : ctx.settings.max_days;
  if (dates.size > cap) {
    const note = override !== undefined && override === cap
      ? ` (per-driver override)`
      : "";
    return {
      rule: "R007",
      message: `Would exceed max ${cap} days in ${ctx.settings.max_days_window}${note}`,
    };
  }
  return null;
}
