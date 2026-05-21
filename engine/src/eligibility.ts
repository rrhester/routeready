// Hard-rule eligibility evaluation for a single (driver, shift) pair.
// Rules run in the SPEC §Step-3 order and short-circuit on first block.

import type {
  BlockReason,
  DriverState,
  EligibilityCell,
  NormalizedDriver,
  NormalizedShift,
} from "./types.ts";
import type { EngineContext } from "./runtime.ts";
import { checkBlackout } from "./rules/r011_blackout.ts";
import { checkStatus } from "./rules/r002_status.ts";
import { checkLicense } from "./rules/r003_license.ts";
import { checkCertification } from "./rules/r004_certification.ts";
import { checkPto } from "./rules/r005_pto.ts";
import { checkAvailability } from "./rules/r006_availability.ts";
import { checkSameDay } from "./rules/r010_same_day.ts";
import { checkMaxDays } from "./rules/r007_max_days.ts";
import { checkWeeklyCap } from "./rules/r008_weekly_cap.ts";
import { checkMinRest } from "./rules/r009_min_rest.ts";

const PASS: EligibilityCell = Object.freeze({
  eligible: true,
  block_reasons: [],
});

export function evaluateEligibility(
  shift: NormalizedShift,
  driver: NormalizedDriver,
  state: DriverState,
  ctx: EngineContext,
): EligibilityCell {
  const s = ctx.settings;
  const block =
    checkBlackout(shift, ctx.blackout) ??
    checkStatus(driver, s) ??
    checkLicense(shift, driver, s) ??
    checkCertification(shift, driver, s) ??
    checkPto(shift, driver, s) ??
    checkAvailability(shift, driver, s) ??
    checkSameDay(shift, state, s) ??
    checkMaxDays(shift, state, ctx) ??
    checkWeeklyCap(shift, driver, state, ctx) ??
    checkMinRest(shift, state, s);

  if (block) return { eligible: false, block_reasons: [block] };
  return PASS;
}

/**
 * Run every hard rule without short-circuiting and return all block reasons.
 * Used by Step 9 to fully describe a violating manual/locked assignment.
 */
export function collectBlocks(
  shift: NormalizedShift,
  driver: NormalizedDriver,
  state: DriverState,
  ctx: EngineContext,
): BlockReason[] {
  const s = ctx.settings;
  const reasons: BlockReason[] = [];
  const push = (r: BlockReason | null): void => {
    if (r) reasons.push(r);
  };
  push(checkBlackout(shift, ctx.blackout));
  push(checkStatus(driver, s));
  push(checkLicense(shift, driver, s));
  push(checkCertification(shift, driver, s));
  push(checkPto(shift, driver, s));
  push(checkAvailability(shift, driver, s));
  push(checkSameDay(shift, state, s));
  push(checkMaxDays(shift, state, ctx));
  push(checkWeeklyCap(shift, driver, state, ctx));
  push(checkMinRest(shift, state, s));
  return reasons;
}
