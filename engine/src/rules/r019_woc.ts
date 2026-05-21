// R019 — Working Hours Compliance (WOC): 7th consecutive working day [HARD].
// Six consecutive worked days are allowed; a 7th is blocked. Only assigned
// shift days count toward the streak — PTO / approved days off are days
// *off* and never extend a working streak.

import type {
  BlockReason,
  DriverState,
  NormalizedShift,
  Settings,
} from "../types.ts";
import { addDays } from "../dates.ts";
import { assignedDates } from "../runtime.ts";

/** Maximum consecutive working days WOC permits. The 7th day is blocked. */
export const WOC_MAX_CONSECUTIVE_DAYS = 6;

export function checkWoc(
  shift: NormalizedShift,
  state: DriverState,
  settings: Settings,
): BlockReason | null {
  if (!settings.woc_enforcement) return null;

  const dates = assignedDates(state);
  dates.add(shift.date);

  // Length of the maximal consecutive run that contains the shift date.
  let run = 1;
  let cursor = addDays(shift.date, -1);
  while (dates.has(cursor)) {
    run += 1;
    cursor = addDays(cursor, -1);
  }
  cursor = addDays(shift.date, 1);
  while (dates.has(cursor)) {
    run += 1;
    cursor = addDays(cursor, 1);
  }

  if (run > WOC_MAX_CONSECUTIVE_DAYS) {
    return {
      rule: "R019",
      message: `WOC: would be consecutive working day #${run} (7th day blocked)`,
    };
  }
  return null;
}
