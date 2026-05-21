// R008 — Weekly hour cap [HARD if enabled].

import type {
  BlockReason,
  NormalizedDriver,
  NormalizedShift,
  DriverState,
} from "../types.ts";
import { inRange } from "../dates.ts";
import {
  type EngineContext,
  ptoHoursInWindow,
  windowRange,
  workHoursInWindow,
} from "../runtime.ts";

export function checkWeeklyCap(
  shift: NormalizedShift,
  driver: NormalizedDriver,
  state: DriverState,
  ctx: EngineContext,
): BlockReason | null {
  const s = ctx.settings;
  if (!s.weekly_hour_cap_enforcement) return null;
  const range = windowRange(s.weekly_hour_window, shift, ctx);
  if (!inRange(shift.date, range[0], range[1])) return null;

  const work = workHoursInWindow(state, range);
  const pto = s.pto_counts_toward_cap
    ? ptoHoursInWindow(driver, range, s)
    : 0;
  const projected = work + pto + shift.duration_hours;
  if (projected > s.weekly_hour_cap) {
    return {
      rule: "R008",
      message: `Would reach ${projected}h, over ${s.weekly_hour_cap}h weekly cap`,
    };
  }
  return null;
}
