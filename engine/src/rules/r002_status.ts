// R002 — Driver status [HARD].

import type { BlockReason, NormalizedDriver, Settings } from "../types.ts";

export function checkStatus(
  driver: NormalizedDriver,
  settings: Settings,
): BlockReason | null {
  if (driver.status === "active") return null;
  if (
    driver.status === "onboarding" &&
    settings.eligible_driver_status === "active_and_onboarding"
  ) {
    return null;
  }
  return {
    rule: "R002",
    message: `Driver status is ${driver.status}, not eligible for auto-fill`,
  };
}
