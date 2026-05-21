// R015 — Scheduling method [ORDERING]. Determines the order in which
// drivers are evaluated in the main assignment pass. Eligibility is
// independent of ordering. Every method tie-breaks seniority → alphabetical.

import type { DriverState, NormalizedDriver } from "../types.ts";
import { epochDay } from "../dates.ts";
import {
  type EngineContext,
  compareSeniority,
  uniqueDatesInWindow,
  workHoursInWindow,
} from "../runtime.ts";

/** Count of weekdays a driver lists saved availability for (null = all 7). */
function availabilityBreadth(driver: NormalizedDriver): number {
  if (driver.saved_availability === null) return 7;
  let count = 0;
  for (const key of Object.keys(driver.saved_availability)) {
    const windows = driver.saved_availability[key];
    if (windows && windows.length > 0) count += 1;
  }
  return count;
}

interface FairKey {
  hours: number;
  days: number;
  sinceLast: number;
}

/** Order drivers for the main assignment pass per the configured method. */
export function orderDrivers(
  ctx: EngineContext,
  states: Map<string, DriverState>,
): NormalizedDriver[] {
  const method = ctx.settings.scheduling_method;
  const drivers = [...ctx.drivers];

  const fairKeys = new Map<string, FairKey>();
  if (method === "fair_rotation") {
    const weekStartDay = epochDay(ctx.scheduleWeek[0]);
    const lastByDriver = new Map<string, string>();
    for (const h of ctx.history) {
      const cur = lastByDriver.get(h.driver_id);
      if (cur === undefined || h.date > cur) {
        lastByDriver.set(h.driver_id, h.date);
      }
    }
    for (const d of drivers) {
      const st = states.get(d.driver_id);
      const assigned = st ? st.assigned : [];
      let last = lastByDriver.get(d.driver_id);
      for (const a of assigned) {
        if (last === undefined || a.date > last) last = a.date;
      }
      fairKeys.set(d.driver_id, {
        hours: st ? workHoursInWindow(st, ctx.scheduleWeek) : 0,
        days: st ? uniqueDatesInWindow(st, ctx.scheduleWeek).size : 0,
        sinceLast:
          last === undefined
            ? Number.MAX_SAFE_INTEGER
            : weekStartDay - epochDay(last),
      });
    }
  }

  drivers.sort((a, b) => {
    switch (method) {
      case "fair_rotation": {
        const ka = fairKeys.get(a.driver_id) as FairKey;
        const kb = fairKeys.get(b.driver_id) as FairKey;
        if (ka.hours !== kb.hours) return ka.hours - kb.hours;
        if (ka.days !== kb.days) return ka.days - kb.days;
        if (ka.sinceLast !== kb.sinceLast) return ka.sinceLast - kb.sinceLast;
        return compareSeniority(a, b);
      }
      case "seniority":
        return compareSeniority(a, b);
      case "full_time_priority": {
        if (a.employment_type !== b.employment_type) {
          return a.employment_type === "full_time" ? -1 : 1;
        }
        return compareSeniority(a, b);
      }
      case "alphabetical": {
        if (a.sort_key !== b.sort_key) return a.sort_key < b.sort_key ? -1 : 1;
        return a.driver_id < b.driver_id ? -1 : 1;
      }
      case "attendance_priority": {
        const sa = a.attendance_score ?? 50;
        const sb = b.attendance_score ?? 50;
        if (sa !== sb) return sb - sa;
        return compareSeniority(a, b);
      }
      case "availability_first": {
        const ba = availabilityBreadth(a);
        const bb = availabilityBreadth(b);
        if (ba !== bb) return bb - ba;
        return compareSeniority(a, b);
      }
    }
  });
  return drivers;
}

/** Score-friendly value derived from a 1-based method rank (SPEC §Step 7). */
export function methodPoints(rank: number, driverCount: number): number {
  if (driverCount <= 1) return 20;
  return (20 * (driverCount - rank)) / (driverCount - 1);
}
