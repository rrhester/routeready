// R005 — PTO conflict [HARD if enabled].

import type {
  BlockReason,
  NormalizedDriver,
  NormalizedShift,
  Settings,
} from "../types.ts";

export function checkPto(
  shift: NormalizedShift,
  driver: NormalizedDriver,
  settings: Settings,
): BlockReason | null {
  if (!settings.pto_protection) return null;
  if (driver.pto_dates.has(shift.date)) {
    return { rule: "R005", message: `Approved PTO on ${shift.date}` };
  }
  return null;
}
