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
  // An XL route dispatches one XL-certified driver + one helper. The helper
  // seat (shift_kind "helper") carries route_type "xl" for grouping but needs
  // no certification — only the driver seat is gated. Mirrors
  // rr_solver/eligibility.py.
  if (
    shift.route_type === "xl" &&
    shift.shift_kind !== "helper" &&
    !driver.xl_certified
  ) {
    return { rule: "R004", message: "Missing XL certification" };
  }
  if (shift.route_type === "edv" && !driver.edv_certified) {
    return { rule: "R004", message: "Missing EDV certification" };
  }
  return null;
}
