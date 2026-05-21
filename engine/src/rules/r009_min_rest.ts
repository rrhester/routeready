// R009 — Minimum rest between shifts [HARD if enabled].

import type {
  BlockReason,
  DriverState,
  NormalizedShift,
  Settings,
} from "../types.ts";
import { MS_PER_HOUR } from "../dates.ts";

export function checkMinRest(
  shift: NormalizedShift,
  state: DriverState,
  settings: Settings,
): BlockReason | null {
  if (!settings.min_rest_enforcement) return null;
  const minMs = settings.min_rest_hours * MS_PER_HOUR;

  for (const a of state.assigned) {
    if (a.shift_id === shift.shift_id) continue;
    let gap: number;
    if (a.end_ms <= shift.start_ms) {
      gap = shift.start_ms - a.end_ms; // candidate after the assigned shift
    } else if (shift.end_ms <= a.start_ms) {
      gap = a.start_ms - shift.end_ms; // candidate before the assigned shift
    } else {
      gap = -1; // overlapping shifts
    }
    if (gap < minMs) {
      return {
        rule: "R009",
        message: `Less than ${settings.min_rest_hours}h rest from shift ${a.shift_id}`,
      };
    }
  }
  return null;
}
