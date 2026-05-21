// R003 — License validity through shift date [HARD if enabled].

import type {
  BlockReason,
  NormalizedDriver,
  NormalizedShift,
  Settings,
} from "../types.ts";

export function checkLicense(
  shift: NormalizedShift,
  driver: NormalizedDriver,
  settings: Settings,
): BlockReason | null {
  if (!settings.license_enforcement) return null;
  if (driver.license_expiration_date === null) {
    return { rule: "R003", message: "License expiration date missing" };
  }
  // A license expiring on the shift date IS valid for that date.
  if (driver.license_expiration_date < shift.date) {
    return {
      rule: "R003",
      message: `License expired ${driver.license_expiration_date}`,
    };
  }
  return null;
}
