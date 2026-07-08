// R004 — Route certification [HARD if enabled].

import type {
  BlockReason,
  NormalizedDriver,
  NormalizedShift,
  Settings,
} from "../types.ts";

export function checkCertification(
  shift: NormalizedShift,
  driver: NormalizedDriver,
  settings: Settings,
): BlockReason | null {
  if (!settings.certification_enforcement) return null;
  if (shift.route_type === "step_van" && !driver.dot_certified) {
    return {
      rule: "R004",
      message: "Missing DOT certification for step_van route",
    };
  }
  if (shift.route_type === "xl" && !driver.xl_certified) {
    return { rule: "R004", message: "Missing XL certification" };
  }
  if (shift.route_type === "edv" && !driver.edv_certified) {
    return { rule: "R004", message: "Missing EDV certification" };
  }
  return null;
}
