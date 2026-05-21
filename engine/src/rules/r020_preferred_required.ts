// R020 — Preferred availability required [HARD if enabled].
//
// When enabled (baseline mode), a driver may only be assigned to a shift
// that falls inside their preferred availability. A driver with no
// preferred availability on file is not scheduled at all.

import type {
  BlockReason,
  NormalizedDriver,
  NormalizedShift,
  Settings,
} from "../types.ts";
import { DOW_NAMES } from "../dates.ts";
import { inPreferredWindow } from "./r017_preferred.ts";

export function checkPreferredRequired(
  shift: NormalizedShift,
  driver: NormalizedDriver,
  settings: Settings,
): BlockReason | null {
  if (!settings.preferred_availability_required) return null;
  if (driver.preferred_availability === null) {
    return { rule: "R020", message: "No preferred availability on file" };
  }
  if (inPreferredWindow(shift, driver)) return null;
  return {
    rule: "R020",
    message: `${DOW_NAMES[shift.dow]} is not a preferred day`,
  };
}
