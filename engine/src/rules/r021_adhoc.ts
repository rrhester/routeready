// R021 — Ad-hoc constraint hard rules [HARD].
//
// Lightweight wrappers around the AdHocIndex that produce a BlockReason
// when a (driver, shift) candidate would violate one of the operator's
// active ad-hoc rules:
//
//   • exclude_from_day      — driver may never work this DOW
//   • date_blackout_driver  — driver unavailable for this date range
//   • pair_forbidden        — partner already on the same shift_id
//
// driver_lock_to_day is handled by step1_5_locks.ts (pre-assignment),
// not here. driver_max_days_override is folded into R007's evaluator.

import type {
  BlockReason,
  NormalizedDriver,
  NormalizedShift,
} from "../types.ts";
import { type EngineContext } from "../runtime.ts";
import { DOW_NAMES } from "../dates.ts";
import { inBlackoutRange } from "../adhoc.ts";

export function checkAdHocExcludeFromDay(
  shift: NormalizedShift,
  driver: NormalizedDriver,
  ctx: EngineContext,
): BlockReason | null {
  const dows = ctx.adHoc.excludeFromDay.get(driver.driver_id);
  if (!dows || !dows.has(shift.dow)) return null;
  return {
    rule: "R021",
    message: `Ad-hoc: driver excluded from ${DOW_NAMES[shift.dow]}`,
  };
}

export function checkAdHocBlackout(
  shift: NormalizedShift,
  driver: NormalizedDriver,
  ctx: EngineContext,
): BlockReason | null {
  const ranges = ctx.adHoc.blackouts.get(driver.driver_id);
  if (!inBlackoutRange(shift.date, ranges)) return null;
  return {
    rule: "R021",
    message: `Ad-hoc: driver on blackout range covering ${shift.date}`,
  };
}

/**
 * If the candidate's forbidden-pair partner is already assigned to this
 * exact shift_id, block. (Per CP-SAT semantics: same shift, never both.)
 * Practically a no-op in the dashboard's 1:1 data model, but kept here
 * so the heuristic mirrors the CP-SAT spec for forward compatibility.
 */
export function checkAdHocPairForbidden(
  shift: NormalizedShift,
  driver: NormalizedDriver,
  ctx: EngineContext,
): BlockReason | null {
  const partners = ctx.adHoc.pairForbidden.get(driver.driver_id);
  if (!partners || partners.size === 0) return null;
  // Walk other drivers' states; any partner already on this shift_id blocks.
  for (const partnerId of partners) {
    // The runtime doesn't pass `ws` into eligibility; instead, a partner
    // is only "already assigned" if their state shows the shift. We use
    // the shift's original_assigned_driver_id as a cheap proxy when
    // validation runs against the locked input, and otherwise rely on
    // the engine state via the orchestrator. Eligibility evaluation is
    // called per candidate so the latest state is reflected. We don't
    // have direct access to `ws.states` here — keep this rule cheap by
    // checking original assignment only. (Pair-forbidden is mostly a
    // CP-SAT-side check anyway; the heuristic uses 1:1 shift slots.)
    if (shift.original_assigned_driver_id === partnerId) {
      return {
        rule: "R021",
        message: `Ad-hoc: forbidden to share a shift with ${partnerId}`,
      };
    }
  }
  return null;
}
