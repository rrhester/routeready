// ============================================================================
// Flex Capacity — Daily Max route capacity (by weekly hour cap)
// ============================================================================
// Answers, per day: "How many routes could we run if everyone worked up to
// their availability, capped at N weekly hours?" — using a DISTRIBUTED model
// so a 40h cap and a 50h cap give different per-day numbers.
//
// Distributed model: a driver available on D days but allowed only B working
// days (B = floor(cap ÷ block), bounded by their max-days) spreads evenly, so
// they contribute B/D of a route to EACH available day. Summed across drivers
// and rounded, that's the day's realistic max route count. (A driver who can
// work all their available days contributes a full 1.0 to each.)
//
// The "5th day" policy controls who may exceed the standard 40h week:
//   none       — nobody works beyond the 40h budget (e.g. the ≤40h view).
//   voluntary  — only drivers who opted in may work a 5th day.
//   all        — everyone works up to the cap (forced 5th day if available).
// ============================================================================

import type { DayKey, FlexDriver } from "./types.ts";
import { DAY_KEYS } from "./types.ts";

/** Standard (non-overtime) work week, in hours — the baseline budget that a
 *  5th day extends beyond. */
const BASE_WEEK_HOURS = 40;

export type FifthDayPolicy = "none" | "voluntary" | "all";

export interface DailyMaxScenario {
  /** Human label, e.g. "≤40h" or "≤50h · everyone 5th day". */
  label: string;
  /** Weekly hour cap (e.g. 40 or 50). */
  capHours: number;
  /** Who may work beyond the 40h base week. */
  fifthDayPolicy: FifthDayPolicy;
}

export interface DailyMaxResult {
  scenario: DailyMaxScenario;
  /** Rounded routes per day (display). */
  perDay: { day: DayKey; routes: number }[];
  /** Unrounded routes per day (for deltas / further math). */
  perDayRaw: { day: DayKey; routes: number }[];
  /** Peak day's rounded routes. */
  peak: number;
  /** Bottleneck (lowest) day's rounded routes among operating days. */
  bottleneck: number;
}

/** Per-driver working-day budget under a scenario (the # of days they'd work). */
function dayBudget(d: FlexDriver, scenario: DailyMaxScenario): number {
  const block = d.blockHours > 0 ? d.blockHours : 10;
  const baseDays = Math.floor(BASE_WEEK_HOURS / block);
  const capDays = Math.floor(scenario.capHours / block);
  let policyDays: number;
  switch (scenario.fifthDayPolicy) {
    case "none":
      policyDays = baseDays;
      break;
    case "all":
      policyDays = capDays;
      break;
    case "voluntary":
      policyDays = d.fifthDayOptIn ? capDays : baseDays;
      break;
  }
  // Bounded by the driver's own max days/week and their availability count.
  const avail = d.available.length;
  return Math.max(0, Math.min(avail, policyDays, d.maxDaysPerWeek));
}

/**
 * Compute per-day max route capacity under a scenario.
 *
 * @param drivers  the pool (only `active` drivers contribute).
 * @param scenario cap + 5th-day policy.
 * @param days     which days to report (default Mon–Sun). PTO is intentionally
 *                 NOT subtracted — this is a structural capacity/planning
 *                 number ("what could we handle"), not a this-week roster.
 */
export function computeDailyMax(
  drivers: FlexDriver[],
  scenario: DailyMaxScenario,
  days: readonly DayKey[] = DAY_KEYS,
): DailyMaxResult {
  const raw = new Map<DayKey, number>();
  for (const day of days) raw.set(day, 0);

  for (const d of drivers) {
    if (!d.active) continue;
    const n = d.available.length;
    if (n === 0) continue;
    const budget = dayBudget(d, scenario);
    if (budget === 0) continue;
    const contribution = budget / n; // spread evenly across available days
    for (const day of d.available) {
      if (raw.has(day)) raw.set(day, raw.get(day)! + contribution);
    }
  }

  const perDayRaw = days.map((day) => ({ day, routes: raw.get(day) ?? 0 }));
  const perDay = perDayRaw.map((x) => ({ day: x.day, routes: Math.round(x.routes) }));
  const counts = perDay.map((x) => x.routes);
  return {
    scenario,
    perDay,
    perDayRaw,
    peak: counts.length ? Math.max(...counts) : 0,
    bottleneck: counts.length ? Math.min(...counts) : 0,
  };
}

// ── Hire profiles for the "what if I hired X" what-if ────────────────────────

/** A synthetic Full-Time hire: available all 7 days, opted into the 5th day,
 *  works up to whatever the scenario cap allows (DSP sets the cap). */
export function ftHire(id: string, blockHours = 10): FlexDriver {
  return {
    id,
    active: true,
    available: [...DAY_KEYS],
    preferred: [],
    fifthDayOptIn: true,
    pto: [],
    scheduledDays: [],
    scheduledHours: 0,
    weeklyHourCap: 50,
    blockHours,
    maxDaysPerWeek: 7,
    certifications: { dot: false, xl: false, edv: false },
  };
}

/** A synthetic Part-Time hire: available any day, works up to `maxDays` (default 3). */
export function ptHire(id: string, maxDays = 3, blockHours = 10): FlexDriver {
  return {
    id,
    active: true,
    available: [...DAY_KEYS],
    preferred: [],
    fifthDayOptIn: false,
    pto: [],
    scheduledDays: [],
    scheduledHours: 0,
    weeklyHourCap: maxDays * blockHours,
    blockHours,
    maxDaysPerWeek: maxDays,
    certifications: { dot: false, xl: false, edv: false },
  };
}

/** Add N FT + M PT synthetic hires to a pool (non-mutating). */
export function withHires(
  drivers: FlexDriver[],
  ftCount: number,
  ptCount: number,
  opts: { ptMaxDays?: number; blockHours?: number } = {},
): FlexDriver[] {
  const block = opts.blockHours ?? 10;
  const ptDays = opts.ptMaxDays ?? 3;
  const hires: FlexDriver[] = [];
  for (let i = 0; i < ftCount; i++) hires.push(ftHire(`__ft_hire_${i}`, block));
  for (let i = 0; i < ptCount; i++) hires.push(ptHire(`__pt_hire_${i}`, ptDays, block));
  return [...drivers, ...hires];
}

/** The three standard scenarios the operator asked for. */
export const STANDARD_SCENARIOS: DailyMaxScenario[] = [
  { label: "≤40h", capHours: 40, fifthDayPolicy: "none" },
  { label: "≤50h · opted-in 5th day", capHours: 50, fifthDayPolicy: "voluntary" },
  { label: "≤50h · everyone 5th day", capHours: 50, fifthDayPolicy: "all" },
];
