// Step 1.5 — Apply driver_lock_to_day ad-hoc constraints.
//
// Operator-authored recurring rules of the form "driver X works on weekday
// Y, every week." Implemented as a hard pre-assignment pass: for each
// matching shift in the schedule week, claim the first eligible open one
// for the locked driver before the rest of the engine runs.
//
// Eligibility for the lock pass deliberately relaxes the soft-preference
// rules — saved availability (R006) and preferred-required (R020) are
// IGNORED during pre-assignment because an explicit pin is the operator
// overriding those preferences. ("I know Chucky usually doesn't work
// Sundays. I'm pinning him to Sundays anyway.") Hard compliance rules
// (PTO, license, cert, WOC, max-days, weekly cap, min rest, same-day
// block, blackout, status) all still apply — a pin can never cause one
// of those.
//
// If no shift is eligible on the matching DOW even with availability
// relaxed (driver is on PTO that day, or it would break WOC, etc), the
// pin goes silent for that week — no violation, the rule just doesn't
// fire and the schedule fills around it.

import type { AdHocConstraint, NormalizedDriver, Settings } from "../types.ts";
import type { EngineContext } from "../runtime.ts";
import { dayOfWeek } from "../dates.ts";
import { evaluateEligibility } from "../eligibility.ts";
import { type ShiftPlan, type WorkingSchedule, applyAssignment } from "../plan.ts";

interface LockRule {
  driver: NormalizedDriver;
  dow: number;
}

/** Parse + validate the driver_lock_to_day payload. Skips malformed rules. */
function parseLockRule(
  raw: AdHocConstraint,
  ctx: EngineContext,
): LockRule | null {
  if (raw.kind !== "driver_lock_to_day") return null;
  if (raw.hardness !== "hard") return null; // v1: only hard locks pre-assign
  const did = raw.payload?.driver_id;
  const dow = raw.payload?.dow;
  if (typeof did !== "string" || typeof dow !== "number") return null;
  if (!Number.isInteger(dow) || dow < 0 || dow > 6) return null;
  const driver = ctx.driverById.get(did);
  if (!driver) return null;
  return { driver, dow };
}

/**
 * Apply every active driver_lock_to_day rule by claiming an eligible open
 * shift on the matching DOW for that driver. Source = "locked" so later
 * steps treat it like any other pinned manual assignment.
 */
export function applyDriverDayLocks(
  ctx: EngineContext,
  ws: WorkingSchedule,
  constraints: AdHocConstraint[],
): void {
  const rules: LockRule[] = [];
  for (const c of constraints) {
    const r = parseLockRule(c, ctx);
    if (r) rules.push(r);
  }
  if (rules.length === 0) return;

  // Relaxed eligibility context: pins override saved availability + the
  // preferred-required boundary. They do NOT override hard compliance
  // rules. See file-level comment.
  const relaxedSettings: Settings = {
    ...ctx.settings,
    availability_enforcement: false,
    availability_required: false,
    preferred_availability_required: false,
  };
  const relaxedCtx: EngineContext = { ...ctx, settings: relaxedSettings };

  // Sort by driver_id for determinism. Same driver appearing twice with
  // different DOWs gets both rules applied (pinned to multiple days).
  rules.sort((a, b) => {
    if (a.driver.driver_id !== b.driver.driver_id) {
      return a.driver.driver_id < b.driver.driver_id ? -1 : 1;
    }
    return a.dow - b.dow;
  });

  for (const rule of rules) {
    // Candidate open shifts on the locked DOW, sorted by date then start
    // time then shift_id for a stable pick when several match.
    const candidates: ShiftPlan[] = ws.plans
      .filter((p) => p.open && dayOfWeek(p.shift.date) === rule.dow)
      .sort((a, b) => {
        if (a.shift.date !== b.shift.date) {
          return a.shift.date < b.shift.date ? -1 : 1;
        }
        if (a.shift.start_ms !== b.shift.start_ms) {
          return a.shift.start_ms - b.shift.start_ms;
        }
        return a.shift.shift_id < b.shift.shift_id ? -1 : 1;
      });

    for (const plan of candidates) {
      const state = ws.states.get(rule.driver.driver_id);
      if (!state) break;
      const cell = evaluateEligibility(plan.shift, rule.driver, state, relaxedCtx);
      if (!cell.eligible) continue;
      applyAssignment(ws, plan, rule.driver.driver_id, "locked");
      break; // one shift per (driver, DOW) — the rule is satisfied
    }
  }
}
