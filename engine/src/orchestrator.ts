// Orchestrator — a thin sequencer for Step 1 .. Step 10 (SPEC §6, §9).
// All heavy logic lives in the step/rule modules; this file wires them up,
// validates input, and assembles the ScheduleResult.

import {
  ENGINE_VERSION,
  EngineError,
  type AssignedShiftOut,
  type DriverTotal,
  type EngineInput,
  type NormalizedDriver,
  type NormalizedShift,
  type ScheduleResult,
  type SummaryMetrics,
  type UncoveredExplanation,
} from "./types.ts";
import { addDays, isValidDate } from "./dates.ts";
import { validateSettings } from "./settings.ts";
import { normalizeDriver, normalizeShift } from "./normalize.ts";
import {
  type EngineContext,
  ptoHoursInWindow,
  uniqueDatesInWindow,
  workHoursInWindow,
} from "./runtime.ts";
import { inputsHash } from "./hash.ts";
import type { WorkingSchedule } from "./plan.ts";
import { indexAdHoc } from "./adhoc.ts";
import { prepareSchedule } from "./steps/step1_prepare.ts";
import { applyDriverDayLocks } from "./steps/step1_5_locks.ts";
import { initDriverState } from "./steps/step2_driver_state.ts";
import { buildEligibilityMatrix } from "./steps/step3_eligibility.ts";
import { computePatterns } from "./steps/step4_patterns.ts";
import { runPatternPass } from "./steps/step5_pattern_pass.ts";
import { runMainPass } from "./steps/step6_assign.ts";
import { runOptimization } from "./steps/step8_optimize.ts";
import { runPreferredEnhancement } from "./steps/step8b_preferred_enhancement.ts";
import { runAffinityEnhancement } from "./steps/step8c_affinity_enhancement.ts";
import { runFifthDayFill } from "./steps/step8d_fifth_day_fill.ts";
import { validate } from "./steps/step9_validate.ts";
import {
  buildAssignmentExplanations,
  buildUncovered,
  buildUnscheduledDrivers,
} from "./steps/step10_explain.ts";
import { inPreferredWindow } from "./rules/r017_preferred.ts";

function buildContext(input: EngineInput): EngineContext {
  if (!input || typeof input !== "object") {
    throw new EngineError("Engine input must be an object");
  }
  if (!input.schedule_week_start || !isValidDate(input.schedule_week_start)) {
    throw new EngineError("Invalid or missing schedule_week_start");
  }
  if (!Array.isArray(input.shifts) || !Array.isArray(input.drivers)) {
    throw new EngineError("Engine input requires shifts[] and drivers[]");
  }

  const settings = validateSettings(input.settings);

  const shifts: NormalizedShift[] = input.shifts.map(normalizeShift);
  shifts.sort((a, b) =>
    a.shift_id < b.shift_id ? -1 : a.shift_id > b.shift_id ? 1 : 0,
  );
  const seenShift = new Set<string>();
  for (const s of shifts) {
    if (seenShift.has(s.shift_id)) {
      throw new EngineError(`Duplicate shift_id: ${s.shift_id}`);
    }
    seenShift.add(s.shift_id);
  }

  // Isolate malformed driver records: one bad field (hire_date, PTO date,
  // affinity, …) previously threw and nuked scheduling for the ENTIRE DSP.
  // Drop the offending driver with a warning and continue instead.
  const droppedDrivers: { driver_id: string; error: string }[] = [];
  const drivers: NormalizedDriver[] = [];
  for (const raw of input.drivers) {
    try {
      drivers.push(normalizeDriver(raw));
    } catch (e) {
      droppedDrivers.push({
        driver_id: raw && raw.driver_id != null ? String(raw.driver_id) : "(no id)",
        error: (e instanceof Error && e.message) || String(e),
      });
    }
  }
  if (droppedDrivers.length && typeof console !== "undefined" && console.warn) {
    console.warn(
      `[scheduling-engine] dropped ${droppedDrivers.length} malformed driver record(s):`,
      droppedDrivers,
    );
  }
  drivers.sort((a, b) =>
    a.driver_id < b.driver_id ? -1 : a.driver_id > b.driver_id ? 1 : 0,
  );
  const driverById = new Map<string, NormalizedDriver>();
  for (const d of drivers) {
    if (driverById.has(d.driver_id)) {
      throw new EngineError(`Duplicate driver_id: ${d.driver_id}`);
    }
    driverById.set(d.driver_id, d);
  }

  const dsp = input.dsp ?? {};
  const weekStartDay = dsp.dsp_week_start_day ?? 0;
  if (!Number.isInteger(weekStartDay) || weekStartDay < 0 || weekStartDay > 6) {
    throw new EngineError("dsp_week_start_day must be an integer 0-6");
  }
  const blackout = new Set<string>();
  for (const d of dsp.dsp_blackout_dates ?? []) {
    if (!isValidDate(d)) throw new EngineError(`Invalid blackout date: ${d}`);
    blackout.add(d);
  }

  let payPeriod: [string, string] | null = null;
  if (input.pay_period) {
    if (
      !isValidDate(input.pay_period.start) ||
      !isValidDate(input.pay_period.end) ||
      input.pay_period.end < input.pay_period.start
    ) {
      throw new EngineError("Invalid pay_period range");
    }
    payPeriod = [input.pay_period.start, input.pay_period.end];
  }
  if (
    (settings.max_days_window === "pay_period" ||
      settings.weekly_hour_window === "pay_period") &&
    payPeriod === null
  ) {
    throw new EngineError(
      "pay_period window selected but no pay_period dates supplied",
    );
  }

  const history = (input.history ?? []).filter((h) => {
    if (!isValidDate(h.date)) {
      throw new EngineError(`Invalid history date: ${h.date}`);
    }
    return true;
  });

  return {
    settings,
    drivers,
    driverById,
    droppedDrivers,
    shifts,
    blackout,
    weekStartDay,
    scheduleWeek: [
      input.schedule_week_start,
      addDays(input.schedule_week_start, 6),
    ],
    payPeriod,
    history,
    patterns: new Map(),
    adHoc: indexAdHoc(input.ad_hoc_constraints),
  };
}

function buildDriverTotals(ctx: EngineContext, ws: WorkingSchedule): DriverTotal[] {
  const week = ctx.scheduleWeek;
  return ctx.drivers.map((driver): DriverTotal => {
    const state = ws.states.get(driver.driver_id);
    const assigned = state ? state.assigned : [];
    const ids = assigned.map((a) => a.shift_id).sort();
    const dates = [...new Set(assigned.map((a) => a.date))].sort();
    const work = state ? workHoursInWindow(state, week) : 0;
    const pto = ptoHoursInWindow(driver, week, ctx.settings);
    return {
      driver_id: driver.driver_id,
      assigned_shift_ids: ids,
      assigned_dates: dates,
      work_hours: work,
      pto_hours: pto,
      total_counted_hours:
        work + (ctx.settings.pto_counts_toward_cap ? pto : 0),
      max_days_used: state ? uniqueDatesInWindow(state, week).size : 0,
    };
  });
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function runEngine(input: EngineInput): ScheduleResult {
  const startedAt = Date.now();
  const ctx = buildContext(input);

  // Step 1-2 — prepare schedule + seed driver state.
  const plans = prepareSchedule(ctx);
  const states = initDriverState(ctx, plans);
  const planByShiftId = new Map(plans.map((p) => [p.shift.shift_id, p]));
  const ws: WorkingSchedule = { plans, planByShiftId, states };

  // Step 1.5 — apply operator pin rules (driver_lock_to_day).
  // Eligibility is evaluated before pre-assignment so PTO, availability,
  // cert, license, and rest rules naturally override pins. If a pinned
  // driver can't be placed on their DOW (e.g. they're on PTO), the pin
  // goes silent for the week — no violation flagged. The pass returns
  // per-rule warnings ("pin_not_applied") naming the actual blocker,
  // surfaced in the final result so operators can diagnose why a pin
  // didn't fire (cert mismatch, PTO, blackout, etc).
  const lockWarnings = applyDriverDayLocks(ctx, ws, input.ad_hoc_constraints ?? []);

  // Step 3 — eligibility matrix.
  const matrix = buildEligibilityMatrix(ctx, ws);

  // Step 4 — historical patterns.
  ctx.patterns = computePatterns(ctx);

  // Step 5 — pattern preservation pass (high strength only).
  runPatternPass(ctx, ws, matrix);

  // Step 6-7 — main assignment pass with scoring.
  runMainPass(ctx, ws, matrix);

  // Step 8 — bounded soft-optimization swaps.
  const optimizationIterations = runOptimization(ctx, ws);

  // Step 8b — Preferred Availability Enhancement (optional preferred-day
  // swap pass). No-op unless enabled in settings.
  runPreferredEnhancement(ctx, ws);

  // Step 8c — Driver Affinity Enhancement (optional historical-pattern
  // swap pass). Runs last so it sees the final schedule. No-op unless
  // enabled in settings.
  runAffinityEnhancement(ctx, ws);

  // Step 9 — final validation.
  const { violations, warnings } = validate(ctx, ws);
  // Surface Step 1.5 pin-yield warnings alongside the validation warnings.
  warnings.push(...lockWarnings);

  // Historical-pattern cold start: drivers with history in fewer than
  // ceil(window/2) of the lookback weeks get a NEUTRAL 0.5 affinity on
  // every weekday (Step 4) — patterns silently stop steering their
  // placements. Only worth saying when pattern protection is actually on.
  if (ctx.settings.historical_pattern_protection !== "off") {
    const coldCount = ctx.drivers.filter(
      (d) => ctx.patterns.get(d.driver_id)?.cold_start,
    ).length;
    if (coldCount > 0) {
      const windowWeeks = ctx.settings.history_window_weeks;
      warnings.push({
        type: "affinity_cold_start",
        message:
          `${coldCount} of ${ctx.drivers.length} drivers have schedule history in fewer than ` +
          `${Math.ceil(windowWeeks / 2)} of the last ${windowWeeks} weeks — historical patterns are ` +
          "neutral for them this run (they'll kick in as more weeks accumulate)",
      });
    }
  }

  // Step 9b — Fifth-Day Fill. Runs AFTER validation: it intentionally
  // takes opted-in drivers one day past the max-days cap, so validating
  // it against that cap would be a false positive. The pass self-
  // enforces WOC + license, so nothing real goes unchecked.
  runFifthDayFill(ctx, ws);

  // Step 10 — explanations.
  const assignmentExplanations = buildAssignmentExplanations(
    ctx,
    ws,
    warnings,
  );
  const uncovered = buildUncovered(ctx, ws);
  const unscheduledDrivers = buildUnscheduledDrivers(ctx, ws);

  // --- Assemble output ----------------------------------------------------
  const assigned: AssignedShiftOut[] = [];
  let filled = 0;
  let closed = 0;
  let preservedPatternMatch = 0;
  let preferredMatch = 0;
  for (const plan of ws.plans) {
    if (plan.closed) closed += 1;
    if (plan.assignedDriverId === null || plan.source === null) continue;
    filled += 1;
    assigned.push({
      shift_id: plan.shift.shift_id,
      driver_id: plan.assignedDriverId,
      source: plan.source,
      total_score: plan.score ?? null,
      score_components: plan.scoreComponents ?? null,
    });
    const pattern = ctx.patterns.get(plan.assignedDriverId);
    if (pattern && pattern.day_of_week_affinity[plan.shift.dow] >= 0.5) {
      preservedPatternMatch += 1;
    }
    const driver = ctx.driverById.get(plan.assignedDriverId);
    if (driver && inPreferredWindow(plan.shift, driver)) preferredMatch += 1;
  }
  assigned.sort((a, b) =>
    a.shift_id < b.shift_id ? -1 : a.shift_id > b.shift_id ? 1 : 0,
  );

  const driverTotals = buildDriverTotals(ctx, ws);
  const driversScheduled = driverTotals.filter(
    (t) => t.assigned_shift_ids.length > 0,
  );
  const totalWorkHours = driversScheduled.reduce(
    (sum, t) => sum + t.work_hours,
    0,
  );

  violations.sort(
    (a, b) =>
      (a.shift_id ?? "").localeCompare(b.shift_id ?? "") ||
      a.rule.localeCompare(b.rule) ||
      (a.driver_id ?? "").localeCompare(b.driver_id ?? ""),
  );
  warnings.sort(
    (a, b) =>
      a.type.localeCompare(b.type) ||
      (a.shift_id ?? "").localeCompare(b.shift_id ?? "") ||
      (a.driver_id ?? "").localeCompare(b.driver_id ?? ""),
  );

  const uncoveredExplanations: UncoveredExplanation[] = uncovered.map((u) => ({
    shift_id: u.shift_id,
    decision: "uncovered",
    top_block_reasons: u.top_block_reasons,
    summary: u.summary,
  }));

  const metrics: SummaryMetrics = {
    engine_version: ENGINE_VERSION,
    total_shifts: ctx.shifts.length,
    filled_shifts: filled,
    uncovered_shifts: uncovered.length,
    closed_shifts: closed,
    drivers_scheduled: driversScheduled.length,
    avg_hours_per_scheduled_driver:
      driversScheduled.length === 0
        ? 0
        : round1(totalWorkHours / driversScheduled.length),
    drivers_near_weekly_cap: warnings.filter(
      (w) => w.type === "near_weekly_cap",
    ).length,
    drivers_near_max_days: warnings.filter((w) => w.type === "near_max_days")
      .length,
    historical_pattern_preservation_pct:
      filled === 0 ? 0 : round1((preservedPatternMatch / filled) * 100),
    preferred_availability_match_pct:
      filled === 0 ? 0 : round1((preferredMatch / filled) * 100),
    attendance_risk_warnings_count: warnings.filter(
      (w) => w.type === "low_attendance_assigned",
    ).length,
    optimization_iterations: optimizationIterations,
    elapsed_ms: Date.now() - startedAt,
  };

  return {
    assigned_shifts: assigned,
    uncovered_shifts: uncovered.map((u) => ({
      shift_id: u.shift_id,
      top_block_reasons: u.top_block_reasons,
      summary: u.summary,
    })),
    driver_totals: driverTotals,
    violations,
    warnings,
    explanations: {
      assignments: assignmentExplanations.sort((a, b) =>
        a.shift_id < b.shift_id ? -1 : a.shift_id > b.shift_id ? 1 : 0,
      ),
      uncovered: uncoveredExplanations,
    },
    unscheduled_drivers: unscheduledDrivers,
    summary_metrics: metrics,
    inputs_hash: inputsHash(input),
  };
}
