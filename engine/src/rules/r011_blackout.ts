// R011 — Blackout dates [HARD].

import type { BlockReason, NormalizedShift } from "../types.ts";

export function checkBlackout(
  shift: NormalizedShift,
  blackout: Set<string>,
): BlockReason | null {
  if (blackout.has(shift.date)) {
    return { rule: "R011", message: `${shift.date} is a DSP blackout date` };
  }
  return null;
}
