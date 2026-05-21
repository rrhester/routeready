// R017 — Preferred availability [SOFT / SCORE]. Never a hard block.

import type { NormalizedDriver, NormalizedShift, Settings } from "../types.ts";
import { fitsAvailability } from "../runtime.ts";

export function inPreferredWindow(
  shift: NormalizedShift,
  driver: NormalizedDriver,
): boolean {
  if (driver.preferred_availability === null) return false;
  return fitsAvailability(driver.preferred_availability, shift);
}

export function preferredPoints(
  shift: NormalizedShift,
  driver: NormalizedDriver,
  settings: Settings,
): number {
  if (!settings.preferred_availability_priority) return 0;
  return inPreferredWindow(shift, driver) ? 10 : 0;
}
