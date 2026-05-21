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
  // No saved availability at all = no constraint (missing data, not a block).
  if (driver.saved_availability === null) return null;
  if (fitsAvailability(driver.saved_availability, shift)) return null;
  return {
    rule: "R006",
    message: `Outside saved availability for ${DOW_NAMES[shift.dow]}`,
  };
}
