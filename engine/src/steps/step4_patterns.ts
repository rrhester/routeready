// Step 4 — Compute historical patterns per driver (R012).

import type { DriverPattern } from "../types.ts";
import type { EngineContext } from "../runtime.ts";
import { dayOfWeek, epochDay } from "../dates.ts";

interface WeekBucket {
  dates: Set<string>;
  dows: Set<number>;
  hours: number;
}

export function computePatterns(
  ctx: EngineContext,
): Map<string, DriverPattern> {
  const windowWeeks = ctx.settings.history_window_weeks;
  const coldStartCutoff = Math.ceil(windowWeeks / 2);
  const weekStartEpoch = epochDay(ctx.scheduleWeek[0]);

  const byDriver = new Map<string, Map<number, WeekBucket>>();
  for (const h of ctx.history) {
    const offset = weekStartEpoch - epochDay(h.date);
    if (offset < 1) continue; // not strictly before the schedule week
    const weekIndex = Math.floor((offset - 1) / 7);
    if (weekIndex >= windowWeeks) continue;

    let weeks = byDriver.get(h.driver_id);
    if (!weeks) {
      weeks = new Map();
      byDriver.set(h.driver_id, weeks);
    }
    let bucket = weeks.get(weekIndex);
    if (!bucket) {
      bucket = { dates: new Set(), dows: new Set(), hours: 0 };
      weeks.set(weekIndex, bucket);
    }
    bucket.dates.add(h.date);
    bucket.dows.add(dayOfWeek(h.date));
    bucket.hours += h.duration_hours ?? 10;
  }

  const patterns = new Map<string, DriverPattern>();
  for (const driver of ctx.drivers) {
    const weeks = byDriver.get(driver.driver_id) ?? new Map<number, WeekBucket>();
    const weeksWithData = weeks.size;
    const coldStart = weeksWithData < coldStartCutoff;

    const affinity = new Array<number>(7).fill(0);
    if (coldStart) {
      affinity.fill(0.5);
    } else {
      for (let dow = 0; dow < 7; dow++) {
        let count = 0;
        for (const bucket of weeks.values()) {
          if (bucket.dows.has(dow)) count += 1;
        }
        affinity[dow] = count / windowWeeks;
      }
    }

    let totalDates = 0;
    let totalHours = 0;
    for (const bucket of weeks.values()) {
      totalDates += bucket.dates.size;
      totalHours += bucket.hours;
    }
    const denom = weeksWithData > 0 ? weeksWithData : 1;

    patterns.set(driver.driver_id, {
      driver_id: driver.driver_id,
      day_of_week_affinity: affinity,
      avg_weekly_days: weeksWithData > 0 ? totalDates / denom : 0,
      avg_weekly_hours: weeksWithData > 0 ? totalHours / denom : 0,
      weeks_with_data: weeksWithData,
      cold_start: coldStart,
    });
  }
  return patterns;
}
