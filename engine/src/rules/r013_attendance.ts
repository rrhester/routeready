// R013 — Attendance [SCORE]. Influences priority, never blocks.

import type { NormalizedDriver, Settings } from "../types.ts";

const ATTENDANCE_WEIGHT: Record<string, number> = {
  low: 0.4,
  medium: 1.0,
  high: 1.6,
};

/** Effective attendance score — a missing score is treated as neutral (50). */
export function attendanceScore(driver: NormalizedDriver): number {
  return driver.attendance_score ?? 50;
}

/** Raw (unrounded) attendance score contribution. */
export function attendancePoints(
  driver: NormalizedDriver,
  settings: Settings,
): number {
  if (!settings.attendance_scheduling) return 0;
  const mult = ATTENDANCE_WEIGHT[settings.attendance_weight];
  return ((attendanceScore(driver) - 50) / 50) * 25 * mult;
}
