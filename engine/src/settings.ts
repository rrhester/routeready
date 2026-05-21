// Settings validation. Rejects unknown keys/values, applies defaults,
// and enforces valid ranges. Fails loud at entry (SPEC §9).

import {
  EngineError,
  type RawBool,
  type RawSettings,
  type Settings,
} from "./types.ts";

const KNOWN_KEYS = new Set<keyof RawSettings>([
  "run_mode",
  "preserve_locked_assignments",
  "eligible_driver_status",
  "license_enforcement",
  "certification_enforcement",
  "pto_protection",
  "availability_enforcement",
  "max_days_enforcement",
  "max_days",
  "max_days_window",
  "weekly_hour_cap_enforcement",
  "weekly_hour_cap",
  "weekly_hour_window",
  "pto_counts_toward_cap",
  "pto_default_hours",
  "min_rest_enforcement",
  "min_rest_hours",
  "woc_enforcement",
  "same_day_multi_shift",
  "historical_pattern_protection",
  "history_window_weeks",
  "attendance_scheduling",
  "attendance_weight",
  "performance_scheduling",
  "scheduling_method",
  "assignment_mode",
  "preferred_availability_priority",
  "consecutive_working_days",
]);

function bool(value: RawBool | undefined, key: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (value === true || value === "on") return true;
  if (value === false || value === "off") return false;
  throw new EngineError(`Setting "${key}" must be on/off, got ${String(value)}`);
}

function oneOf<T extends string>(
  value: T | undefined,
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  if (value === undefined) return fallback;
  if (!allowed.includes(value)) {
    throw new EngineError(
      `Setting "${key}" must be one of ${allowed.join("|")}, got ${String(value)}`,
    );
  }
  return value;
}

function num(
  value: number | undefined,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new EngineError(`Setting "${key}" must be a number`);
  }
  if (value < min || value > max) {
    throw new EngineError(`Setting "${key}" out of range [${min}, ${max}]`);
  }
  return value;
}

export function validateSettings(raw: RawSettings | undefined): Settings {
  const r = raw ?? {};
  for (const key of Object.keys(r)) {
    if (!KNOWN_KEYS.has(key as keyof RawSettings)) {
      throw new EngineError(`Unknown setting "${key}"`);
    }
  }

  const historyWeeks = r.history_window_weeks ?? 4;
  if (historyWeeks !== 4 && historyWeeks !== 6 && historyWeeks !== 8) {
    throw new EngineError(`Setting "history_window_weeks" must be 4, 6, or 8`);
  }

  return {
    run_mode: oneOf(
      r.run_mode,
      "run_mode",
      ["fill_empty_only", "rebuild_unlocked", "full_rebuild"] as const,
      "fill_empty_only",
    ),
    preserve_locked_assignments: bool(
      r.preserve_locked_assignments,
      "preserve_locked_assignments",
      true,
    ),
    eligible_driver_status: oneOf(
      r.eligible_driver_status,
      "eligible_driver_status",
      ["active_only", "active_and_onboarding"] as const,
      "active_only",
    ),
    license_enforcement: bool(r.license_enforcement, "license_enforcement", true),
    certification_enforcement: bool(
      r.certification_enforcement,
      "certification_enforcement",
      true,
    ),
    pto_protection: bool(r.pto_protection, "pto_protection", true),
    availability_enforcement: bool(
      r.availability_enforcement,
      "availability_enforcement",
      false,
    ),
    max_days_enforcement: bool(r.max_days_enforcement, "max_days_enforcement", true),
    max_days: num(r.max_days, "max_days", 6, 1, 7),
    max_days_window: oneOf(
      r.max_days_window,
      "max_days_window",
      ["schedule_week", "rolling_7_days", "pay_period"] as const,
      "schedule_week",
    ),
    weekly_hour_cap_enforcement: bool(
      r.weekly_hour_cap_enforcement,
      "weekly_hour_cap_enforcement",
      true,
    ),
    weekly_hour_cap: num(r.weekly_hour_cap, "weekly_hour_cap", 50, 0, 168),
    weekly_hour_window: oneOf(
      r.weekly_hour_window,
      "weekly_hour_window",
      ["schedule_week", "rolling_7_days", "pay_period"] as const,
      "schedule_week",
    ),
    pto_counts_toward_cap: bool(
      r.pto_counts_toward_cap,
      "pto_counts_toward_cap",
      true,
    ),
    pto_default_hours: num(r.pto_default_hours, "pto_default_hours", 10, 0, 24),
    min_rest_enforcement: bool(r.min_rest_enforcement, "min_rest_enforcement", true),
    min_rest_hours: num(r.min_rest_hours, "min_rest_hours", 10, 0, 48),
    woc_enforcement: bool(r.woc_enforcement, "woc_enforcement", true),
    same_day_multi_shift: oneOf(
      r.same_day_multi_shift,
      "same_day_multi_shift",
      ["block", "allow"] as const,
      "block",
    ),
    historical_pattern_protection: oneOf(
      r.historical_pattern_protection,
      "historical_pattern_protection",
      ["off", "low", "medium", "high"] as const,
      "medium",
    ),
    history_window_weeks: historyWeeks,
    attendance_scheduling: bool(
      r.attendance_scheduling,
      "attendance_scheduling",
      true,
    ),
    attendance_weight: oneOf(
      r.attendance_weight,
      "attendance_weight",
      ["low", "medium", "high"] as const,
      "medium",
    ),
    performance_scheduling: bool(
      r.performance_scheduling,
      "performance_scheduling",
      false,
    ),
    scheduling_method: oneOf(
      r.scheduling_method,
      "scheduling_method",
      [
        "fair_rotation",
        "seniority",
        "full_time_priority",
        "availability_first",
        "alphabetical",
        "attendance_priority",
      ] as const,
      "fair_rotation",
    ),
    assignment_mode: oneOf(
      r.assignment_mode,
      "assignment_mode",
      ["sequential_fill", "rotational_fill"] as const,
      "rotational_fill",
    ),
    preferred_availability_priority: bool(
      r.preferred_availability_priority,
      "preferred_availability_priority",
      true,
    ),
    consecutive_working_days: bool(
      r.consecutive_working_days,
      "consecutive_working_days",
      true,
    ),
  };
}
