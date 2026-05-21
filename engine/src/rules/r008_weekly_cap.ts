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

// Each scheduled shift includes an unpaid 30-min lunch, so the weekly
// cap is measured in on-the-clock (net) hours: gross shift hours minus
// this per-shift deduction. Keeps the cap consistent with the hours
// shown in the dashboard's Driver column.
const LUNCH_HOURS = 0.5;

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
  const shiftsInWindow = state.assigned.filter(
    (a) => inRange(a.date, range[0], range[1]),
  ).length;
  const pto = s.pto_counts_toward_cap
    ? ptoHoursInWindow(driver, range, s)
    : 0;
  // Net of the per-shift lunch (the candidate shift included). PTO is
  // not a worked shift, so it carries no lunch deduction.
  const netWork = Math.max(0, work - shiftsInWindow * LUNCH_HOURS);
  const netShift = Math.max(0, shift.duration_hours - LUNCH_HOURS);
  const projected = netWork + pto + netShift;
  if (projected > s.weekly_hour_cap) {
    return {
      rule: "R008",
      message: `Would reach ${Math.round(projected * 10) / 10}h on the clock, over ${s.weekly_hour_cap}h weekly cap`,
    };
  }
  return null;
}
