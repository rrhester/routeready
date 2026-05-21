// R003 — License validity through shift date [HARD if enabled].
//
// A driver is blocked when their license is expired on the shift date.
// The DSP may also set a protection window: when license_protection_days
// is greater than zero, a driver is blocked once a shift falls within
// that many days of the expiration date (the expiration day itself
// included). A blocked driver is simply skipped for that shift — every
// other rule still applies to the rest of the team.

import type {
  BlockReason,
  NormalizedDriver,
  NormalizedShift,
  Settings,
} from "../types.ts";
import { daysBetween } from "../dates.ts";

export function checkLicense(
  shift: NormalizedShift,
  driver: NormalizedDriver,
  settings: Settings,
): BlockReason | null {
  if (!settings.license_enforcement) return null;
  if (driver.license_expiration_date === null) {
    return { rule: "R003", message: "License expiration date missing" };
  }

  // Days from the shift date to the expiration date. Negative = the
  // license is already expired on the shift date.
  const daysToExpiry = daysBetween(shift.date, driver.license_expiration_date);

  if (daysToExpiry < 0) {
    return {
      rule: "R003",
      message: `License expired ${driver.license_expiration_date}`,
    };
  }

  const window = settings.license_protection_days;
  if (window > 0 && daysToExpiry <= window) {
    return {
      rule: "R003",
      message:
        `License expires ${driver.license_expiration_date} — within the ` +
        `${window}-day protection window`,
    };
  }
  return null;
}
