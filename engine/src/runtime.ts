// Engine-wide context + shared runtime queries (windows, availability,
// driver-state aggregates). Pure functions only — no mutation here.

import {
  type DriverPattern,
  type DriverState,
  type HistoryShift,
  type NormalizedDriver,
  type NormalizedShift,
  type Settings,
  type WeeklyAvailability,
  type WindowType,
} from "./types.ts";
import { addDays, clockToMinutes, inRange } from "./dates.ts";
import { type AdHocIndex } from "./adhoc.ts";

export interface EngineContext {
  settings: Settings;
  drivers: NormalizedDriver[];
  driverById: Map<string, NormalizedDriver>;
  /** Malformed driver records dropped during normalization (see buildContext). */
  droppedDrivers: { driver_id: string; error: string }[];
  shifts: NormalizedShift[];
  blackout: Set<string>;
  weekStartDay: number;
  scheduleWeek: [string, string];
  payPeriod: [string, string] | null;
  history: HistoryShift[];
  patterns: Map<string, DriverPattern>;
  /** Compiled ad-hoc rule index (exclude_from_day, blackouts, etc). */
  adHoc: AdHocIndex;
}

/** Inclusive [start, end] date range for a window type, relative to a shift. */
export function windowRange(
  type: WindowType,
  shift: NormalizedShift,
  ctx: EngineContext,
): [string, string] {
  if (type === "schedule_week") return ctx.scheduleWeek;
  if (type === "rolling_7_days") return [addDays(shift.date, -6), shift.date];
  // pay_period — presence guaranteed by orchestrator entry check.
  return ctx.payPeriod as [string, string];
}

// ---------------------------------------------------------------------------
// Driver-state aggregates
// ---------------------------------------------------------------------------

export function assignedDates(state: DriverState): Set<string> {
  const set = new Set<string>();
  for (const a of state.assigned) set.add(a.date);
  return set;
}

export function uniqueDatesInWindow(
  state: DriverState,
  range: [string, string],
): Set<string> {
  const set = new Set<string>();
  for (const a of state.assigned) {
    if (inRange(a.date, range[0], range[1])) set.add(a.date);
  }
  return set;
}

export function workHoursInWindow(
  state: DriverState,
  range: [string, string],
): number {
  let total = 0;
  for (const a of state.assigned) {
    if (inRange(a.date, range[0], range[1])) total += a.duration_hours;
  }
  return total;
}

export function ptoHoursInWindow(
  driver: NormalizedDriver,
  range: [string, string],
  settings: Settings,
): number {
  let total = 0;
  for (const date of driver.pto_dates) {
    if (!inRange(date, range[0], range[1])) continue;
    total += driver.pto_hours.get(date) ?? settings.pto_default_hours;
  }
  return total;
}

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

/**
 * True when the shift's day-of-week + start/end time fall inside one of the
 * driver's availability windows for that day. A day with no listed window
 * means the driver is unavailable that day.
 */
export function fitsAvailability(
  av: WeeklyAvailability,
  shift: NormalizedShift,
): boolean {
  const windows = av[String(shift.dow)];
  if (windows === undefined || windows.length === 0) return false;
  for (const w of windows) {
    const start = clockToMinutes(w.start);
    const end = clockToMinutes(w.end);
    if (start <= shift.start_min && end >= shift.end_min) return true;
  }
  return false;
}

/**
 * True when a shift is a DOT-required route. DOT routes (Step Van, XL, and
 * any future DOT-marked route) must be filled before DOT-certified drivers
 * are spent on standard routes — see Step 6's two-phase fill order.
 */
export function isDotRoute(shift: NormalizedShift): boolean {
  return shift.route_type === "step_van" || shift.route_type === "xl";
}

/** Seniority/alphabetical comparison: negative when `a` should rank first. */
export function compareSeniority(
  a: NormalizedDriver,
  b: NormalizedDriver,
): number {
  // Earlier hire_date = more senior = ranks first.
  if (a.hire_date !== b.hire_date) return a.hire_date < b.hire_date ? -1 : 1;
  if (a.sort_key !== b.sort_key) return a.sort_key < b.sort_key ? -1 : 1;
  return a.driver_id < b.driver_id ? -1 : a.driver_id > b.driver_id ? 1 : 0;
}
