// Adapter: maps the RouteReady operator-dashboard data shapes onto the
// engine's EngineInput, runs the engine, and returns the ScheduleResult.
//
// The dashboard's Supabase layer (dashboard/live.js) is responsible for
// loading rows and pre-deriving the fields below; this adapter keeps the
// engine itself free of any dashboard/Supabase knowledge.

import { runEngine } from "../orchestrator.ts";
import {
  EngineError,
  type DriverInput,
  type EngineInput,
  type RawSettings,
  type RouteType,
  type ScheduleResult,
  type ShiftInput,
  type WeeklyAvailability,
} from "../types.ts";

export interface DashboardDriver {
  id: string;
  full_name?: string | null;
  status?: string | null;
  hire_date?: string | null;
  dl_expires_on?: string | null;
  dot_certified?: boolean;
  xl_certified?: boolean;
  /** Day-of-week indices (0=Sun) the driver can work; null = no data. */
  available_dows?: number[] | null;
  /** Day-of-week indices the driver prefers; null/empty = none. */
  preferred_dows?: number[] | null;
}

export interface DashboardShift {
  id: string;
  date: string;
  starts_at?: string | null;
  ends_at?: string | null;
  duration_hours?: number | null;
  route_type: RouteType;
  assigned_driver_id?: string | null;
  is_locked?: boolean;
}

export interface DashboardPto {
  driver_id: string;
  date: string;
}

export interface DashboardRules {
  dl_valid?: boolean;
  /** Block scheduling this many days before a license expires (0 = expired only). */
  dl_protection_days?: number;
  include_onboarding?: boolean;
  availability?: boolean;
  preferred_days?: boolean;
  pto_block?: boolean;
  min_rest?: boolean;
  max_hours?: boolean;
  woc?: boolean;
  consecutive_days?: boolean;
  /** true (default) = rotational fill (even spread); false = sequential. */
  spread_evenly?: boolean;
  /** Rotational fill: shifts per driver before rotating (1-4, default 1). */
  rotation_batch?: number;
  /** Preferred Availability Enhancement — post-pass preferred-day swaps. */
  preferred_enhancement?: boolean;
  preferred_enhancement_contiguous?: boolean;
  preferred_enhancement_extra?: boolean;
  tiebreaker?: string;
  /**
   * Boundary mode "Auto Fill only Preferred Availability" — the engine
   * ignores every other rule and assigns drivers only to shifts on their
   * preferred days.
   */
  preferred_only?: boolean;
  /**
   * Boundary mode "Auto Fill Availability" — the engine ignores every
   * other rule and assigns drivers across their full availability.
   */
  availability_only?: boolean;
}

export interface PlanPayload {
  schedule_week_start: string;
  max_days: number;
  weekly_hour_cap?: number;
  blackout_dates?: string[];
  rules?: DashboardRules;
  drivers: DashboardDriver[];
  shifts: DashboardShift[];
  pto?: DashboardPto[];
}

// PTO / approved day off always counts as 10 hours toward the weekly cap.
const PTO_HOURS_PER_DAY = 10;
// A permissive window: a listed day-of-week means "available all day".
const ALL_DAY: WeeklyAvailability[string] = [{ start: "00:00", end: "48:00" }];

function splitName(full: string): { first: string; last: string } {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: "Driver", last: "Driver" };
  if (parts.length === 1) return { first: parts[0], last: parts[0] };
  const last = parts[parts.length - 1];
  return { first: parts.slice(0, -1).join(" "), last };
}

function availabilityFromDows(
  dows: number[] | null | undefined,
): WeeklyAvailability | null {
  // null/undefined = no availability data on file -> no constraint.
  // An array (even empty) = the operator configured availability; days
  // not listed are treated as unavailable.
  if (dows == null) return null;
  const av: WeeklyAvailability = {};
  for (const dow of dows) {
    if (Number.isInteger(dow) && dow >= 0 && dow <= 6) {
      av[String(dow)] = ALL_DAY;
    }
  }
  return av;
}

function mapDriver(
  raw: DashboardDriver,
  ptoByDriver: Map<string, string[]>,
): DriverInput {
  const status = String(raw.status ?? "").toLowerCase();
  const name = splitName(String(raw.full_name ?? raw.id));
  return {
    driver_id: String(raw.id),
    first_name: name.first,
    last_name: name.last,
    status: status === "onboarding" ? "onboarding" : "active",
    employment_type: "full_time",
    hire_date: raw.hire_date && raw.hire_date.length >= 10
      ? raw.hire_date.slice(0, 10)
      : "2000-01-01",
    license_expiration_date: raw.dl_expires_on
      ? raw.dl_expires_on.slice(0, 10)
      : null,
    dot_certified: raw.dot_certified === true,
    xl_certified: raw.xl_certified === true,
    saved_availability: availabilityFromDows(raw.available_dows),
    preferred_availability: availabilityFromDows(raw.preferred_dows),
    pto_records: (ptoByDriver.get(String(raw.id)) ?? []).map((date) => ({
      date,
      hours: PTO_HOURS_PER_DAY,
    })),
    attendance_score: null,
  };
}

function mapShift(raw: DashboardShift): ShiftInput {
  const start = raw.starts_at ?? `${raw.date}T00:00:00`;
  // Only pass end_time when it post-dates the start (guards bad rows).
  const end =
    raw.ends_at && raw.starts_at && raw.ends_at > raw.starts_at
      ? raw.ends_at
      : null;
  return {
    shift_id: String(raw.id),
    date: raw.date,
    start_time: start,
    end_time: end,
    duration_hours:
      typeof raw.duration_hours === "number" && raw.duration_hours > 0
        ? raw.duration_hours
        : null,
    route_type: raw.route_type,
    assigned_driver_id: raw.assigned_driver_id ?? null,
    is_locked: raw.is_locked === true,
  };
}

/** Clamp the DSP-entered max-days value to the engine's 0-7 range. */
function clampMaxDays(value: number | undefined): number {
  return Math.max(0, Math.min(7, Math.round(value ?? 6)));
}

// A boundary mode strips the engine to a single behavior: assign each
// driver only within one availability boundary, up to the DSP's max
// allowable days per week. Every other rule is disabled so that one
// boundary can be verified in isolation. (R002 driver-status and R010
// one-shift-per-day still apply — they are physical constraints, not
// configurable rules.)
interface EnhancementFlags {
  on: boolean;
  contiguous: boolean;
  extra: boolean;
}

interface LicenseFlags {
  on: boolean;
  protectionDays: number;
}

function boundaryModeSettings(
  boundary: "preferred" | "availability",
  maxDays: number,
  assignmentMode: "rotational_fill" | "sequential_fill",
  rotationBatch: number,
  enh: EnhancementFlags,
  license: LicenseFlags,
): RawSettings {
  return {
    run_mode: "full_rebuild",
    eligible_driver_status: "active_and_onboarding",
    // The license rule composes with the boundary modes — a driver with
    // an expired (or soon-to-expire) license is skipped, the rest of the
    // team fills normally.
    license_enforcement: license.on,
    license_protection_days: license.protectionDays,
    certification_enforcement: false,
    pto_protection: false,
    availability_enforcement: boundary === "availability",
    availability_required: boundary === "availability",
    max_days_enforcement: true,
    max_days: maxDays,
    weekly_hour_cap_enforcement: false,
    pto_counts_toward_cap: false,
    min_rest_enforcement: false,
    woc_enforcement: false,
    same_day_multi_shift: "block",
    historical_pattern_protection: "off",
    attendance_scheduling: false,
    scheduling_method: "seniority",
    assignment_mode: assignmentMode,
    rotation_batch_size: rotationBatch,
    preferred_availability_priority: false,
    preferred_availability_required: boundary === "preferred",
    // The enhancement is a no-op under the preferred-only boundary
    // (every shift is already on a preferred day), so it's forced off
    // there.
    preferred_enhancement: boundary === "preferred" ? false : enh.on,
    preferred_enhancement_contiguous: enh.contiguous,
    preferred_enhancement_extra: enh.extra,
    consecutive_working_days: false,
  };
}

function buildSettings(payload: PlanPayload): RawSettings {
  const r = payload.rules ?? {};
  const maxDays = clampMaxDays(payload.max_days);
  // Fill order — rotational (spread evenly) unless explicitly sequential.
  const assignmentMode =
    r.spread_evenly === false ? "sequential_fill" : "rotational_fill";
  // Rotational batch — shifts per driver before the cycle rotates (1-4).
  const rotationBatch = Math.max(1, Math.min(4, Math.round(r.rotation_batch ?? 1)));
  // Preferred Availability Enhancement flags.
  const enh: EnhancementFlags = {
    on: r.preferred_enhancement === true,
    contiguous: r.preferred_enhancement_contiguous !== false,
    extra: r.preferred_enhancement_extra === true,
  };
  // Driver-license rule + DSP protection window.
  const license: LicenseFlags = {
    on: r.dl_valid !== false,
    protectionDays: Math.max(0, Math.min(365, Math.round(r.dl_protection_days ?? 0))),
  };

  // Boundary modes are mutually exclusive; preferred wins if both are set.
  if (r.preferred_only === true) {
    return boundaryModeSettings("preferred", maxDays, assignmentMode, rotationBatch, enh, license);
  }
  if (r.availability_only === true) {
    return boundaryModeSettings("availability", maxDays, assignmentMode, rotationBatch, enh, license);
  }

  const method = r.tiebreaker === "seniority" ? "seniority" : "fair_rotation";
  return {
    // Auto-schedule always performs a FULL REBUILD (SPEC Default Schedule
    // Behavior); locked manual assignments are still preserved + validated.
    run_mode: "full_rebuild",
    eligible_driver_status:
      r.include_onboarding !== false ? "active_and_onboarding" : "active_only",
    license_enforcement: license.on,
    license_protection_days: license.protectionDays,
    certification_enforcement: true,
    pto_protection: r.pto_block !== false,
    availability_enforcement: r.availability !== false,
    max_days_enforcement: true,
    max_days: maxDays,
    weekly_hour_cap_enforcement: r.max_hours !== false,
    weekly_hour_cap: payload.weekly_hour_cap ?? 40,
    // PTO / approved day off always counts toward the 40-hour cap (hard rule).
    pto_counts_toward_cap: true,
    pto_default_hours: PTO_HOURS_PER_DAY,
    min_rest_enforcement: r.min_rest !== false,
    // WOC — blocks a 7th consecutive working day.
    woc_enforcement: r.woc !== false,
    // A driver works at most one shift per day — a physical constraint,
    // never operator-configurable.
    same_day_multi_shift: "block",
    historical_pattern_protection: "off",
    attendance_scheduling: false,
    scheduling_method: method,
    assignment_mode: assignmentMode,
    rotation_batch_size: rotationBatch,
    preferred_availability_priority: r.preferred_days !== false,
    preferred_enhancement: enh.on,
    preferred_enhancement_contiguous: enh.contiguous,
    preferred_enhancement_extra: enh.extra,
    consecutive_working_days: r.consecutive_days === true,
  };
}

/**
 * Plan a schedule week from dashboard-shaped data. Throws EngineError on
 * structurally invalid input (the caller should surface this to the
 * operator rather than crash).
 */
export function planScheduleWeek(payload: PlanPayload): ScheduleResult {
  if (!payload || typeof payload !== "object") {
    throw new EngineError("planScheduleWeek: payload required");
  }
  const ptoByDriver = new Map<string, string[]>();
  for (const p of payload.pto ?? []) {
    const list = ptoByDriver.get(p.driver_id) ?? [];
    list.push(p.date);
    ptoByDriver.set(p.driver_id, list);
  }

  const drivers = payload.drivers
    .filter((d) => {
      const s = String(d.status ?? "").toLowerCase();
      return s === "active" || s === "onboarding";
    })
    .map((d) => mapDriver(d, ptoByDriver));

  const input: EngineInput = {
    schedule_week_start: payload.schedule_week_start,
    shifts: payload.shifts.map(mapShift),
    drivers,
    dsp: { dsp_blackout_dates: payload.blackout_dates ?? [] },
    settings: buildSettings(payload),
  };
  return runEngine(input);
}
