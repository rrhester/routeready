// R012 — Historical pattern protection [SCORE + optional pre-pass].
// Pattern *computation* lives in steps/step4_patterns.ts; this file holds
// the scoring contribution and the per-strength bonus ceiling.

import type { DriverPattern, PatternStrength } from "../types.ts";

/** Threshold above which a DOW counts as a "strong" historical day. */
export const HIGH_AFFINITY_THRESHOLD = 0.75;

export function patternMaxBonus(strength: PatternStrength): number {
  switch (strength) {
    case "off":
      return 0;
    case "low":
      return 10;
    case "medium":
      return 25;
    case "high":
      return 50;
  }
}

/** Raw (unrounded) historical-pattern score for a driver on a given DOW. */
export function historicalPoints(
  pattern: DriverPattern,
  dow: number,
  strength: PatternStrength,
): number {
  if (strength === "off") return 0;
  return pattern.day_of_week_affinity[dow] * patternMaxBonus(strength);
}
