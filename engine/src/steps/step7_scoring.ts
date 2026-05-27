// Step 7 — Scoring. Each component is rounded to an integer so that score
// sums are order-independent and byte-deterministic (SPEC §8).

import type {
  DriverState,
  NormalizedDriver,
  NormalizedShift,
  ScoreComponents,
} from "../types.ts";
import type { EngineContext } from "../runtime.ts";
import { historicalPoints } from "../rules/r012_patterns.ts";
import { attendancePoints } from "../rules/r013_attendance.ts";
import { preferredPoints } from "../rules/r017_preferred.ts";
import { consecutivePoints } from "../rules/r018_consecutive.ts";
import { methodPoints } from "../rules/r015_method.ts";
import { targetCapPoints } from "../rules/r022_target_days.ts";

export interface ScoreResult {
  components: ScoreComponents;
  total: number;
}

/**
 * Score a candidate (driver, shift). `state` must be the driver's state
 * WITHOUT the candidate shift (the shift is being considered for addition).
 * `methodRank` is the driver's 1-based rank in the main-pass ordering.
 */
export function computeScore(
  ctx: EngineContext,
  shift: NormalizedShift,
  driver: NormalizedDriver,
  state: DriverState,
  methodRank: number,
): ScoreResult {
  const pattern = ctx.patterns.get(driver.driver_id);
  const historical =
    pattern === undefined
      ? 0
      : Math.round(
          historicalPoints(
            pattern,
            shift.dow,
            ctx.settings.historical_pattern_protection,
          ),
        );
  const attendance = Math.round(attendancePoints(driver, ctx.settings));
  const preferred = Math.round(preferredPoints(shift, driver, ctx.settings));
  const consecutive = Math.round(
    consecutivePoints(shift, state, ctx.settings),
  );
  const method = Math.round(methodPoints(methodRank, ctx.drivers.length));
  const performance = 0; // R014 — reserved, always 0 in v1.
  const target_days = Math.round(
    targetCapPoints(shift, state, ctx, ctx.settings),
  );

  const components: ScoreComponents = {
    historical,
    attendance,
    preferred,
    consecutive,
    method,
    performance,
    target_days,
  };
  return {
    components,
    total:
      historical + attendance + preferred + consecutive + method + performance + target_days,
  };
}
