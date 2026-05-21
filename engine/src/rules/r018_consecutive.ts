// R018 — Consecutive working days [SOFT / SCORE]. Never a hard block.

import type { DriverState, NormalizedShift, Settings } from "../types.ts";
import { addDays } from "../dates.ts";
import { assignedDates } from "../runtime.ts";

export function consecutivePoints(
  shift: NormalizedShift,
  state: DriverState,
  settings: Settings,
): number {
  if (!settings.consecutive_working_days) return 0;
  const dates = assignedDates(state);
  dates.delete(shift.date);
  const hasPrev = dates.has(addDays(shift.date, -1));
  const hasNext = dates.has(addDays(shift.date, 1));
  if (hasPrev && hasNext) return 15; // fills a single-day gap
  if (hasPrev || hasNext) return 10; // creates an adjacency
  return 0; // isolated single day
}
