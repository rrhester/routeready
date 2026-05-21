// R006 — Saved availability [HARD if enabled].

import type {
  BlockReason,
  NormalizedDriver,
  NormalizedShift,
  Settings,
} from "../types.ts";
import { DOW_NAMES } from "../dates.ts";
import { fitsAvailability } from "../runtime.ts";

export function checkAvailability(
  shift: NormalizedShift,
  driver: NormalizedDriver,
  settings: Settings,
): BlockReason | null {
  if (!settings.availability_enforcement) return null;
  if (driver.saved_availability === null) {
    // No saved availability on file. Normally not a constraint (missing
    // data, not a block) — but in availability-required mode the driver
    // cannot be scheduled at all.
    if (settings.availability_required) {
      return { rule: "R006", message: "No availability on file" };
    }
    return null;
  }
  if (fitsAvailability(driver.saved_availability, shift)) return null;
  return {
    rule: "R006",
    message: `Outside saved availability for ${DOW_NAMES[shift.dow]}`,
  };
}
