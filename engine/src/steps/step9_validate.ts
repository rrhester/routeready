// Step 9 — Final validation. Re-checks hard rules against the final
// schedule and produces critical/acknowledged violations plus warnings.

import type { DriverState, Violation, Warning } from "../types.ts";
import type { EngineContext } from "../runtime.ts";
import type { WorkingSchedule } from "../plan.ts";
import {
  uniqueDatesInWindow,
  ptoHoursInWindow,
  workHoursInWindow,
} from "../runtime.ts";
import { collectBlocks } from "../eligibility.ts";
import { attendanceScore } from "../rules/r013_attendance.ts";
import { inPreferredWindow } from "../rules/r017_preferred.ts";

export interface ValidationResult {
  violations: Violation[];
  warnings: Warning[];
}

function without(state: DriverState, shiftId: string): DriverState {
  return {
    driver_id: state.driver_id,
    assigned: state.assigned.filter((a) => a.shift_id !== shiftId),
  };
}

export function validate(
  ctx: EngineContext,
  ws: WorkingSchedule,
): ValidationResult {
  const violations: Violation[] = [];
  const warnings: Warning[] = [];
  const s = ctx.settings;
  const week = ctx.scheduleWeek;

  // --- Violations: every assignment re-checked against hard rules ----------
  for (const plan of ws.plans) {
    const driverId = plan.assignedDriverId;
    if (driverId === null) continue;
    const driver = ctx.driverById.get(driverId);
    if (!driver) {
      violations.push({
        severity: "critical",
        rule: "R002",
        shift_id: plan.shift.shift_id,
        driver_id: driverId,
        message: `Assigned driver "${driverId}" not found in driver list`,
      });
      continue;
    }
    const state = ws.states.get(driverId) as DriverState;
    const blocks = collectBlocks(
      plan.shift,
      driver,
      without(state, plan.shift.shift_id),
      ctx,
    );
    if (blocks.length === 0) continue;

    const acknowledged =
      plan.source === "locked" &&
      plan.shift.override_ack_by !== null &&
      plan.shift.override_ack_by !== "";
    const tag =
      plan.source === "locked"
        ? " (locked manual override)"
        : plan.source === "preserved"
          ? " (preserved assignment)"
          : "";
    for (const b of blocks) {
      violations.push({
        severity: acknowledged ? "acknowledged" : "critical",
        rule: b.rule,
        shift_id: plan.shift.shift_id,
        driver_id: driverId,
        message: b.message + tag,
      });
    }
  }

  // --- Driver-level warnings ----------------------------------------------
  for (const driver of ctx.drivers) {
    if (s.license_enforcement && driver.license_expiration_date === null) {
      warnings.push({
        type: "license_expiration_missing",
        driver_id: driver.driver_id,
        message: `Driver ${driver.driver_id} has no license expiration date on file`,
      });
    }
    const state = ws.states.get(driver.driver_id);
    if (!state) continue;
    const weekDates = uniqueDatesInWindow(state, week);
    if (weekDates.size === 0) continue;

    if (s.max_days_enforcement && weekDates.size >= s.max_days - 1) {
      warnings.push({
        type: "near_max_days",
        driver_id: driver.driver_id,
        message: `Driver ${driver.driver_id} is at ${weekDates.size}/${s.max_days} days`,
      });
    }
    if (s.weekly_hour_cap_enforcement) {
      const work = workHoursInWindow(state, week);
      const pto = s.pto_counts_toward_cap
        ? ptoHoursInWindow(driver, week, s)
        : 0;
      const counted = work + pto;
      if (counted <= s.weekly_hour_cap && s.weekly_hour_cap - counted <= 10) {
        warnings.push({
          type: "near_weekly_cap",
          driver_id: driver.driver_id,
          message: `Driver ${driver.driver_id} is at ${counted}/${s.weekly_hour_cap} hours`,
        });
      }
    }
    if (driver.attendance_score !== null && attendanceScore(driver) < 60) {
      warnings.push({
        type: "low_attendance_assigned",
        driver_id: driver.driver_id,
        message: `Driver ${driver.driver_id} assigned with low attendance score ${driver.attendance_score}`,
      });
    }
  }

  // --- Per-assignment warnings --------------------------------------------
  for (const plan of ws.plans) {
    const driverId = plan.assignedDriverId;
    if (driverId === null) continue;
    const driver = ctx.driverById.get(driverId);
    if (!driver) continue;

    if (
      s.preferred_availability_priority &&
      driver.preferred_availability !== null &&
      !inPreferredWindow(plan.shift, driver)
    ) {
      warnings.push({
        type: "assigned_outside_preferred",
        shift_id: plan.shift.shift_id,
        driver_id: driverId,
        message: `${plan.shift.shift_id} is outside ${driverId}'s preferred availability`,
      });
    }
    if (s.historical_pattern_protection !== "off") {
      const pattern = ctx.patterns.get(driverId);
      if (pattern && pattern.day_of_week_affinity[plan.shift.dow] === 0) {
        warnings.push({
          type: "historical_pattern_disrupted",
          shift_id: plan.shift.shift_id,
          driver_id: driverId,
          message: `${driverId} assigned to a 0-affinity day on ${plan.shift.date}`,
        });
      }
    }
  }

  return { violations, warnings };
}
