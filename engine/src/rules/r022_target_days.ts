// R022 — Soft target days per driver per week [SCORE].
//
// The DSP sets a target (e.g. 4 days) below the hard max_days cap. The
// engine deprioritizes any placement that would push a driver beyond
// their target — they're still eligible, but other drivers with room
// under their own target are picked first.
//
// Scoring rationale:
//   • Below target → 0 (no signal; other components decide)
//   • At or over target → -100 × (projected_days − target)
//
// The -100 step is calibrated against the other components (historical
// ~50, attendance ~40, preferred ~10, method ~20) — strong enough that
// an over-target driver loses to any under-target driver who's even
// passably eligible, weak enough that when ALL eligible drivers are at
// their target, the engine still picks one and fills the shift. That's
// the "consider OT" escape hatch the operator asked for.
//
// 0 disables the soft cap entirely.

import type { DriverState, NormalizedShift, Settings } from "../types.ts";
import { type EngineContext, uniqueDatesInWindow } from "../runtime.ts";

export function targetCapPoints(
  shift: NormalizedShift,
  state: DriverState,
  ctx: EngineContext,
  settings: Settings,
): number {
  const target = settings.target_days_per_week;
  if (target <= 0) return 0;
  // The candidate shift adds a date only if it's not already in the
  // driver's state (R010 same-day blocks otherwise — but the score is
  // computed for non-same-day candidates, so projected = current + 1).
  const dates = uniqueDatesInWindow(state, ctx.scheduleWeek);
  const isSameDate = dates.has(shift.date);
  const projected = isSameDate ? dates.size : dates.size + 1;
  if (projected <= target) return 0;
  // Linear penalty per day over the target — preference is to spread
  // OT across many drivers rather than stack on one.
  return -(projected - target) * 100;
}
