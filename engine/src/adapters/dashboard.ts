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
  max_days?: boolean;
  availability?: boolean;
  pto_block?: boolean;
  max_hours?: boolean;
  pto_count_in_cap?: boolean;
  consecutive_days?: boolean;
  tiebreaker?: string;
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

const PTO_HOURS_PER_DAY = 8;
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

function buildSettings(payload: PlanPayload): RawSettings {
  const r = payload.rules ?? {};
  const method = r.tiebreaker === "seniority" ? "seniority" : "fair_rotation";
  return {
    run_mode: "fill_empty_only",
    eligible_driver_status: "active_and_onboarding",
    license_enforcement: r.dl_valid !== false,
    certification_enforcement: true,
    pto_protection: r.pto_block !== false,
    availability_enforcement: r.availability !== false,
    max_days_enforcement: r.max_days !== false,
    max_days: Math.max(1, Math.min(7, Math.round(payload.max_days || 6))),
    weekly_hour_cap_enforcement: r.max_hours !== false,
    weekly_hour_cap: payload.weekly_hour_cap ?? 40,
    pto_counts_toward_cap: r.pto_count_in_cap === true,
    pto_default_hours: PTO_HOURS_PER_DAY,
    min_rest_enforcement: false,
    same_day_multi_shift: "block",
    historical_pattern_protection: "off",
    attendance_scheduling: false,
    scheduling_method: method,
    assignment_mode: "rotational_fill",
    preferred_availability_priority: true,
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
