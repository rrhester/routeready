// Step 6 — Main assignment pass (R016: rotational or sequential fill).
//
// Outer layering — two route phases so DOT-required routes are always
// filled before any DOT-certified driver is spent on a standard route
// (SPEC Route Fill Order):
//   Phase 1 — DOT-required shifts only.
//   Phase 2 — XL shifts (fill before standard so scarce drivers go to XL
//             first and standard routes are the ones left open).
//   Phase 3 — standard shifts only.
//
// Within each route phase, runs TWO target-aware passes:
//   Pass A — only drivers under target_days_per_week claim shifts.
//            This honors the soft cap — engine prefers spreading work
//            across drivers who haven't hit their target yet.
//   Pass B — every still-eligible driver can claim. This is the "OT
//            escape hatch" — runs only when coverage still has open
//            shifts after Pass A.
//
// target_days_per_week=0 collapses to a single pass (no soft cap).

import type { NormalizedDriver, ScoreComponents } from "../types.ts";
import {
  type EngineContext,
  isDotRoute,
  uniqueDatesInWindow,
} from "../runtime.ts";
import { type WorkingSchedule, applyAssignment } from "../plan.ts";
import type { ShiftPlan } from "../plan.ts";
import { orderDrivers } from "../rules/r015_method.ts";
import { computeScore } from "./step7_scoring.ts";
import {
  type EligibilityMatrix,
  recomputeDriverColumn,
} from "./step3_eligibility.ts";

type Phase = "dot" | "xl" | "standard";

interface Candidate {
  plan: ShiftPlan;
  score: number;
  components: ScoreComponents;
}

function planInPhase(plan: ShiftPlan, phase: Phase): boolean {
  const dot = isDotRoute(plan.shift);
  if (phase === "dot") return dot;
  // DOT routes are handled in the dot phase; exclude them from the rest.
  if (dot) return false;
  // XL routes fill before standard routes, so when drivers are scarce the
  // standard routes are the ones left open (operator: "XL first").
  const xl = plan.shift.route_type === "xl";
  return phase === "xl" ? xl : !xl;
}

/** Best eligible open shift for one driver within a phase, or null. */
export function bestShiftForDriver(
  ctx: EngineContext,
  ws: WorkingSchedule,
  matrix: EligibilityMatrix,
  driver: NormalizedDriver,
  methodRank: number,
  phase: Phase,
): Candidate | null {
  const state = ws.states.get(driver.driver_id);
  if (!state) return null;
  let best: Candidate | null = null;

  for (const [shiftId, row] of matrix) {
    const cell = row.get(driver.driver_id);
    if (!cell || !cell.eligible) continue;
    const plan = ws.planByShiftId.get(shiftId);
    if (!plan || !plan.open || !planInPhase(plan, phase)) continue;

    const { total, components } = computeScore(ctx, plan.shift, driver, state, methodRank);
    if (best === null || isBetter(plan, total, best, ctx.settings.rotation_start_day)) {
      best = { plan, score: total, components };
    }
  }
  return best;
}

/** Days a shift's weekday sits after the configured rotation start day. */
function rotationRank(dow: number, startDow: number): number {
  return (dow - startDow + 7) % 7;
}

// Sort key: score desc, rotation-day asc, start_time asc, shift_id asc.
function isBetter(
  plan: ShiftPlan,
  score: number,
  best: Candidate,
  startDow: number,
): boolean {
  if (score !== best.score) return score > best.score;
  const a = plan.shift;
  const b = best.plan.shift;
  const ra = rotationRank(a.dow, startDow);
  const rb = rotationRank(b.dow, startDow);
  if (ra !== rb) return ra < rb;
  if (a.date !== b.date) return a.date < b.date;
  if (a.start_ms !== b.start_ms) return a.start_ms < b.start_ms;
  return a.shift_id < b.shift_id;
}

/** Pass-A skip predicate: true when the driver is already at-or-over their
 *  target. Existing assigned days (including pin_lock and any locked
 *  input shifts) count toward the target via uniqueDatesInWindow. */
function isAtOrOverTarget(
  ctx: EngineContext,
  ws: WorkingSchedule,
  driver: NormalizedDriver,
): boolean {
  const target = ctx.settings.target_days_per_week;
  if (target <= 0) return false; // soft cap disabled
  const state = ws.states.get(driver.driver_id);
  if (!state) return false;
  return uniqueDatesInWindow(state, ctx.scheduleWeek).size >= target;
}

function runFillCycle(
  ctx: EngineContext,
  ws: WorkingSchedule,
  matrix: EligibilityMatrix,
  phase: Phase,
  order: NormalizedDriver[],
  rankMap: Map<string, number>,
  driverSkip: (driver: NormalizedDriver) => boolean,
): void {
  const assignOne = (driver: NormalizedDriver): boolean => {
    if (driverSkip(driver)) return false;
    const rank = rankMap.get(driver.driver_id) ?? order.length;
    const best = bestShiftForDriver(ctx, ws, matrix, driver, rank, phase);
    if (!best) return false;
    applyAssignment(ws, best.plan, driver.driver_id, "auto_fill", best.score, best.components);
    matrix.delete(best.plan.shift.shift_id);
    recomputeDriverColumn(ctx, ws, matrix, driver.driver_id);
    return true;
  };

  if (ctx.settings.assignment_mode === "sequential_fill") {
    for (const driver of order) {
      while (assignOne(driver)) {
        /* keep filling this driver until blocked */
      }
    }
    return;
  }
  // Rotational fill — each driver claims up to `rotation_batch_size`
  // shifts before the cycle rotates to the next driver, then repeats.
  const batch = Math.max(1, ctx.settings.rotation_batch_size);
  let progress = true;
  while (progress) {
    progress = false;
    for (const driver of order) {
      for (let i = 0; i < batch; i++) {
        if (assignOne(driver)) progress = true;
        else break;
      }
    }
  }
}

function runPhase(
  ctx: EngineContext,
  ws: WorkingSchedule,
  matrix: EligibilityMatrix,
  phase: Phase,
): void {
  const order = orderDrivers(ctx, ws.states);
  const rankMap = new Map<string, number>();
  order.forEach((d, i) => rankMap.set(d.driver_id, i + 1));

  // Attendance Penalty ("Schedule Final-corrective drivers last") is a
  // tiered fill, not just a pick order: drivers in good standing fill
  // first — past their soft target if coverage needs it — and a
  // Final-corrective driver only claims what clean drivers cannot
  // legally cover. Coverage still wins: the FCA tiers run before the
  // phase ends, and phases fill dot → xl → standard, so an XL route is
  // never left open when an FCA driver is the only one certified for it.
  const fcaLast = ctx.settings.attendance_penalty;
  const skips: Array<(driver: NormalizedDriver) => boolean> = fcaLast
    ? [
        // A — clean drivers under target.
        (d) => d.attendance_final || isAtOrOverTarget(ctx, ws, d),
        // B — clean drivers past target (soft-cap escape).
        (d) => d.attendance_final,
        // C — Final-corrective drivers under target.
        (d) => !d.attendance_final || isAtOrOverTarget(ctx, ws, d),
        // D — Final-corrective drivers past target (last resort).
        (d) => !d.attendance_final,
      ]
    : [
        // Pass A — only drivers UNDER their target_days_per_week can
        // claim. Re-evaluated per call (day-count grows as they're
        // assigned), so a driver naturally drops out of Pass A once they
        // hit target. Target 0 collapses to "always true" — no soft cap.
        (d) => isAtOrOverTarget(ctx, ws, d),
        // Pass B — coverage escape hatch. Any still-eligible driver may
        // claim remaining open shifts, even past their target. This is
        // the OT mode — only kicks in when Pass A couldn't cover.
        () => false,
      ];
  for (const skip of skips) {
    runFillCycle(ctx, ws, matrix, phase, order, rankMap, skip);
  }
}

export function runMainPass(
  ctx: EngineContext,
  ws: WorkingSchedule,
  matrix: EligibilityMatrix,
): void {
  runPhase(ctx, ws, matrix, "dot");
  runPhase(ctx, ws, matrix, "xl");
  runPhase(ctx, ws, matrix, "standard");
}
