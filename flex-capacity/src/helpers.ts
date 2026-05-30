// ============================================================================
// Flex Capacity Engine — Helpers
// ============================================================================
// Pure, side-effect-free predicates and small utilities. These encode the
// HARD constraints (always enforced) and the per-tier SOFT gates. Keeping
// them isolated makes the tier rules in engine.ts read declaratively and
// makes every rule independently unit-testable.
// ============================================================================

import type {
  CapacityTier,
  DayKey,
  FlexConfig,
  FlexDriver,
  RouteType,
} from "./types.ts";

/** Round to 1 decimal — used for the "routes per day" increases so the KPI
 *  doesn't show noisy long decimals. */
export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Never display a negative flex figure (spec: displayFlex = max(0, flex)). */
export function clampNonNeg(n: number): number {
  return n < 0 ? 0 : n;
}

/** Does the day's route type require a certification the driver must hold? */
export function meetsCertForRoute(driver: FlexDriver, routeType: RouteType | undefined): boolean {
  switch (routeType) {
    case "xl":
      return driver.certifications.xl;
    case "edv":
      return driver.certifications.edv;
    case "dot":
      return driver.certifications.dot;
    // "standard" / undefined / any unknown type → no cert gate.
    default:
      return true;
  }
}

/** Is the driver already working this day (so they occupy a route slot)? */
export function isScheduledOn(driver: FlexDriver, day: DayKey): boolean {
  return driver.scheduledDays.includes(day);
}

/**
 * HARD constraints — enforced for EVERY tier. A driver who fails any of these
 * simply cannot serve a route on `day`, regardless of how aggressively we
 * plan. These mirror the scheduling engine's non-negotiable rules:
 *   active · available that day · not on PTO · within the weekly hour cap ·
 *   within the max-days cap · holds the cert the route type requires.
 *
 * Capacity accounting note: a driver ALREADY scheduled on `day` is occupying
 * one of that day's route slots, so their hours/day for that slot are already
 * spent — we don't re-charge the hour/day caps against them. For a driver NOT
 * yet scheduled on `day`, taking an additional route would add one block and
 * one day, so both caps are checked against the projected new total.
 */
export function passesHardConstraints(driver: FlexDriver, day: DayKey, routeType: RouteType | undefined): boolean {
  if (!driver.active) return false;
  if (!driver.available.includes(day)) return false;
  if (driver.pto.includes(day)) return false;
  if (!meetsCertForRoute(driver, routeType)) return false;

  if (!isScheduledOn(driver, day)) {
    // Adding a brand-new day for this driver — check the caps against the
    // projected totals.
    if (driver.scheduledHours + driver.blockHours > driver.weeklyHourCap) return false;
    if (driver.scheduledDays.length + 1 > driver.maxDaysPerWeek) return false;
  }
  return true;
}

/** Would assigning `day` to this driver be their "5th day" (a day beyond
 *  their normal cadence)? Only meaningful for a day they're not already on. */
export function isExtraDay(driver: FlexDriver, day: DayKey, cfg: FlexConfig): boolean {
  if (isScheduledOn(driver, day)) return false; // already part of their week
  return driver.scheduledDays.length >= cfg.fifthDayThreshold;
}

/**
 * Can this driver occupy a route slot on `day` at the given tier?
 *
 * Tiers are monotonic — comfortable ⊆ stretch ⊆ maximum — so the per-day
 * driver counts are non-decreasing across tiers, and therefore so are the
 * flex figures. The ONLY differences are the soft gates layered on top of
 * the shared hard constraints:
 *
 *   Comfortable — preferred day AND not an extra (5th) day. Sustainable,
 *                 retention-friendly, no schedule-pattern disruption.
 *   Stretch     — non-preferred days allowed; a 5th day is allowed only for
 *                 drivers who VOLUNTEERED (fifthDayOptIn). Temporary spikes.
 *   Maximum     — hard constraints only. Non-preferred days and 5th days
 *                 allowed regardless of opt-in (ignores comfort/retention).
 *                 Theoretical ceiling, not a sustainable operating state.
 */
export function canWorkAtTier(
  driver: FlexDriver,
  day: DayKey,
  tier: CapacityTier,
  cfg: FlexConfig,
  routeType: RouteType | undefined,
): boolean {
  if (!passesHardConstraints(driver, day, routeType)) return false;

  const extra = isExtraDay(driver, day, cfg);

  switch (tier) {
    case "comfortable":
      return driver.preferred.includes(day) && !extra;
    case "stretch":
      // Non-preferred OK; 5th day only if the driver opted in.
      return !extra || driver.fifthDayOptIn;
    case "maximum":
      // Hard constraints already satisfied; ignore comfort/retention.
      return true;
  }
}
