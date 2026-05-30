// ============================================================================
// Flex Capacity Engine — Core calculation
// ============================================================================
// Deterministic, pure functions. Given a FlexInput (drivers + route demand for
// a DSP-week), produce per-day and weekly capacity at the three tiers, plus a
// KPI-ready headline. No I/O, no randomness, no mutation of inputs.
//
// All arithmetic follows the spec exactly:
//   comfortableFlexRoutes = max(0, comfortableDrivers − requiredRoutes)
//   weeklyComfortableFlex = Σ comfortableDrivers − Σ requiredRoutes
//   weeklyComfortableRouteIncrease = weeklyComfortableFlex / 7
// ============================================================================

import {
  DEFAULT_CONFIG,
  type DayCapacity,
  type FlexConfig,
  type FlexInput,
  type FlexKpi,
  type FlexResult,
  type FlexStatus,
  type WeeklyCapacity,
} from "./types.ts";
import { canWorkAtTier, clampNonNeg, round1 } from "./helpers.ts";

const WEEK_DAYS = 7;

function resolveConfig(input: FlexInput): FlexConfig {
  return { ...DEFAULT_CONFIG, ...(input.config ?? {}) };
}

/** Count drivers who can occupy a route slot on a given day at each tier. */
function countDayCapacity(input: FlexInput, route: FlexInput["routes"][number], cfg: FlexConfig): DayCapacity {
  let comfortable = 0;
  let stretch = 0;
  let maximum = 0;

  for (const d of input.drivers) {
    // Evaluate from the most permissive tier down so we can short-circuit:
    // monotonicity guarantees comfortable ⊆ stretch ⊆ maximum.
    if (canWorkAtTier(d, route.day, "maximum", cfg, route.routeType)) {
      maximum += 1;
      if (canWorkAtTier(d, route.day, "stretch", cfg, route.routeType)) {
        stretch += 1;
        if (canWorkAtTier(d, route.day, "comfortable", cfg, route.routeType)) {
          comfortable += 1;
        }
      }
    }
  }

  const required = route.routeTarget;
  return {
    day: route.day,
    requiredRoutes: required,
    comfortableDrivers: comfortable,
    stretchDrivers: stretch,
    maximumDrivers: maximum,
    comfortableFlexRoutes: clampNonNeg(comfortable - required),
    stretchFlexRoutes: clampNonNeg(stretch - required),
    maximumFlexRoutes: clampNonNeg(maximum - required),
  };
}

/** Roll per-day capacity up to the week and convert surplus driver-days into
 *  an "additional routes per day" figure. */
function rollUpWeek(days: DayCapacity[]): WeeklyCapacity {
  let req = 0;
  let comfDD = 0;
  let strDD = 0;
  let maxDD = 0;
  for (const d of days) {
    req += d.requiredRoutes;
    comfDD += d.comfortableDrivers;
    strDD += d.stretchDrivers;
    maxDD += d.maximumDrivers;
  }
  const comfortableFlex = comfDD - req;
  const stretchFlex = strDD - req;
  const maximumFlex = maxDD - req;
  return {
    weeklyRequiredRoutes: req,
    weeklyComfortableDriverDays: comfDD,
    weeklyStretchDriverDays: strDD,
    weeklyMaximumDriverDays: maxDD,
    weeklyComfortableFlex: comfortableFlex,
    weeklyStretchFlex: stretchFlex,
    weeklyMaximumFlex: maximumFlex,
    weeklyComfortableRouteIncrease: round1(comfortableFlex / WEEK_DAYS),
    weeklyStretchRouteIncrease: round1(stretchFlex / WEEK_DAYS),
    weeklyMaximumRouteIncrease: round1(maximumFlex / WEEK_DAYS),
  };
}

/** Representative "current routes" for the headline = the peak day's target.
 *  The pool has to cover the busiest day, so peak is the honest baseline. */
function peakDailyRoutes(input: FlexInput): number {
  let peak = 0;
  for (const r of input.routes) if (r.routeTarget > peak) peak = r.routeTarget;
  return peak;
}

/**
 * Coaching color for a given amount of projected route GROWTH (additional
 * routes/day Amazon might add). With no growth specified we report against
 * the comfortable headroom itself (growth = 0 ⇒ green when any comfortable
 * capacity exists).
 *   green  — growth fits within Comfortable capacity (normal patterns).
 *   yellow — growth fits within Stretch capacity (flexibility / 5th days).
 *   red    — growth exceeds Stretch; sustainable absorption is unavailable
 *            and the DSP should plan to hire.
 */
export function coachingFor(
  weekly: WeeklyCapacity,
  growthRoutesPerDay: number,
): { status: FlexStatus; coaching: string } {
  const comfortable = weekly.weeklyComfortableRouteIncrease;
  const stretch = weekly.weeklyStretchRouteIncrease;

  if (growthRoutesPerDay <= comfortable) {
    return {
      status: "green",
      coaching:
        "DSP can absorb projected growth using preferred schedules and normal operating patterns.",
    };
  }
  if (growthRoutesPerDay <= stretch) {
    return {
      status: "yellow",
      coaching:
        "DSP can absorb projected growth using schedule flexibility, non-preferred days, and voluntary 5th-day participation.",
    };
  }
  return {
    status: "red",
    coaching:
      "DSP lacks sufficient route absorption capacity and should hire additional drivers.",
  };
}

/** Build the KPI headline (current routes + per-tier capacity & availability). */
export function buildKpi(input: FlexInput, weekly: WeeklyCapacity, growthRoutesPerDay = 0): FlexKpi {
  const current = peakDailyRoutes(input);
  // Additional routes/day available at each tier (never negative).
  const comfAvail = clampNonNeg(Math.round(weekly.weeklyComfortableRouteIncrease));
  const strAvail = clampNonNeg(Math.round(weekly.weeklyStretchRouteIncrease));
  const maxAvail = clampNonNeg(Math.round(weekly.weeklyMaximumRouteIncrease));
  const { status, coaching } = coachingFor(weekly, growthRoutesPerDay);
  return {
    currentRoutes: current,
    comfortableCapacity: current + comfAvail,
    stretchCapacity: current + strAvail,
    maximumCapacity: current + maxAvail,
    comfortableRoutesAvailable: comfAvail,
    stretchRoutesAvailable: strAvail,
    maximumRoutesAvailable: maxAvail,
    status,
    coaching,
  };
}

/**
 * Main entry point. Compute full flex capacity for a DSP-week.
 *
 * @param input  drivers + route demand for the week.
 * @param growthRoutesPerDay  optional projected daily route growth used only
 *        to color the KPI coaching; capacity numbers are independent of it.
 */
export function computeFlexCapacity(input: FlexInput, growthRoutesPerDay = 0): FlexResult {
  const config = resolveConfig(input);
  const days = input.routes.map((r) => countDayCapacity(input, r, config));
  const weekly = rollUpWeek(days);
  const kpi = buildKpi(input, weekly, growthRoutesPerDay);
  return { weekStart: input.weekStart, days, weekly, kpi, config };
}
