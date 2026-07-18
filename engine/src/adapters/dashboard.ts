// Adapter: maps the RouteReady operator-dashboard data shapes onto the
// engine's EngineInput, runs the engine, and returns the ScheduleResult.
//
// The dashboard's Supabase layer (dashboard/live.js) is responsible for
// loading rows and pre-deriving the fields below; this adapter keeps the
// engine itself free of any dashboard/Supabase knowledge.

import { runEngine } from "../orchestrator.ts";
import {
  EngineError,
  type AdHocConstraint,
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
  /** True when the driver is on a Final corrective action. */
  final_corrective_action?: boolean;
  /** Per-weekday affinity (0-100), index 0=Sun..6=Sat — how often the
   *  driver was scheduled on each weekday over the rolling period. */
  weekday_affinity?: number[] | null;
  /** Driver opted in to working an extra (5th) day. */
  fifth_day_ok?: boolean;
  /** "full_time" | "part_time" (ft/pt variants accepted); null/unknown =
   *  full_time. Feeds the full_time_priority scheduling method. */
  employment_type?: string | null;
  /** Attendance/reliability score 0-100 (the roster's drivers.score;
   *  <70 reads as at-risk). Feeds attendance_priority ordering and the
   *  R013 smooth attendance score. null = unknown (engine defaults 50). */
  attendance_score?: number | null;
}

export interface DashboardShift {
  id: string;
  date: string;
  starts_at?: string | null;
  ends_at?: string | null;
  duration_hours?: number | null;
  route_type: RouteType;
  shift_kind?: string | null;
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
  /** WOC (Working Hours Compliance) — caps consecutive days + weekly hours. */
  woc?: boolean;
  /** WOC: maximum consecutive working days (1-7, default 6). */
  woc_max_consecutive_days?: number;
  /** WOC: maximum scheduled hours per week (1-168, default 40). */
  woc_max_hours?: number;
  /** When true, Final-corrective-action drivers are scheduled last. */
  attendance_penalty?: boolean;
  /** Driver fill priority: "seniority" (default) or "random". */
  fill_priority?: string;
  /** Weekday (0=Sun..6=Sat) the shift-fill rotation starts on. */
  rotation_start_day?: number;
  consecutive_days?: boolean;
  /** true (default) = rotational fill (even spread); false = sequential. */
  spread_evenly?: boolean;
  /** Rotational fill: shifts per driver before rotating (1-4, default 1). */
  rotation_batch?: number;
  /** Preferred Availability Enhancement — post-pass preferred-day swaps. */
  preferred_enhancement?: boolean;
  preferred_enhancement_contiguous?: boolean;
  preferred_enhancement_extra?: boolean;
  /** Driver Affinity Enhancement — post-pass weekday-affinity swaps. */
  affinity_enhancement?: boolean;
  /** Weekday priority order (0=Sun..6=Sat) the affinity sweep follows. */
  affinity_day_order?: number[];
  /** Fifth-Day Fill — final pass layering an extra day onto open shifts
   *  for drivers who opted in. */
  fifth_day_fill?: boolean;
  /** When the 5th-day pass runs, allow it to ignore driver availability. */
  fifth_day_override_availability?: boolean;
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
  /** Run mode: "full_rebuild" (default), "rebuild_unlocked", "fill_empty_only". */
  run_mode?: "full_rebuild" | "rebuild_unlocked" | "fill_empty_only";
  /** Keep locked assignments verbatim under full_rebuild. Default true. */
  preserve_locked_assignments?: boolean;
  /** Full scheduling-method picker (overrides fill_priority/tiebreaker when set). */
  scheduling_method?:
    | "fair_rotation"
    | "seniority"
    | "full_time_priority"
    | "availability_first"
    | "alphabetical"
    | "attendance_priority"
    | "random";
  /** Same-day double-shift policy. */
  same_day_multi_shift?: "block" | "allow";
  /** Historical pattern protection: off / low / medium / high. */
  historical_pattern_protection?: "off" | "low" | "medium" | "high";
  /** How many weeks back the historical pattern pre-pass looks. */
  history_window_weeks?: 4 | 6 | 8;
  /** Smooth attendance scoring on/off. */
  attendance_scheduling?: boolean;
  /** Attendance score weight: low / medium / high. */
  attendance_weight?: "low" | "medium" | "high";
  /** Max-days cap window: this week / rolling 7 days / pay period. */
  max_days_window?: "schedule_week" | "rolling_7_days" | "pay_period";
  /** Soft per-driver target days/week. Engine deprioritizes placements
   *  past this number — drivers stay at or below the target unless
   *  coverage would suffer. Distinct from max_days (hard cap). */
  target_days_per_week?: number;
  /** Weekly-hour cap window. */
  weekly_hour_window?: "schedule_week" | "rolling_7_days" | "pay_period";
  /** Whether PTO hours count toward the weekly hour cap. */
  pto_counts_toward_cap?: boolean;
  /** Hours-per-day to assume when a PTO record has no hours value. */
  pto_default_hours?: number;
  /** Minimum rest between two consecutive shifts. */
  min_rest_hours?: number;
  /** Block drivers from non-preferred days entirely (hard rule). */
  preferred_availability_required?: boolean;
  /** Notify drivers when the 5th-day pass assigns them an extra shift. */
  fifth_day_notify?: boolean;
}

export interface PlanPayload {
  schedule_week_start: string;
  max_days: number;
  weekly_hour_cap?: number;
  /** IANA timezone of the DSP (e.g. "America/Chicago"). When set, shift
   *  timestamps that carry a zone (Postgres timestamptz serializations)
   *  are converted to DSP-local WALL-CLOCK time before the engine sees
   *  them, so time-of-day semantics (rest gaps, future availability
   *  windows) match how the operator reads the schedule. Zone-less
   *  strings are assumed to already be wall clock and pass through. */
  dsp_timezone?: string | null;
  blackout_dates?: string[];
  rules?: DashboardRules;
  drivers: DashboardDriver[];
  shifts: DashboardShift[];
  pto?: DashboardPto[];
  /** Active ad-hoc constraints (from public.current_ad_hoc_constraints).
   *  Forwarded to the engine so the heuristic can honor driver_lock_to_day
   *  pins. CP-SAT compiles every kind; heuristic v1 only acts on lock-to-day. */
  ad_hoc_constraints?: AdHocConstraint[];
}

// Fallback hours-per-PTO-day for the pto_default_hours SETTING when the
// operator hasn't set one. PTO records themselves are passed to the engine
// with no hours value, so the setting (not this constant) governs how many
// hours each PTO day counts toward the weekly cap.
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
  // Employment type — sanitize here (the engine's normalizer THROWS on
  // unknown values, which would drop the driver): pt variants map to
  // part_time, anything else (incl. missing data) defaults to full_time.
  const emp = String(raw.employment_type ?? "").toLowerCase().replace(/[\s-]+/g, "_");
  return {
    driver_id: String(raw.id),
    first_name: name.first,
    last_name: name.last,
    status: status === "onboarding" ? "onboarding" : "active",
    employment_type:
      emp === "part_time" || emp === "parttime" || emp === "pt"
        ? "part_time"
        : "full_time",
    // A MISSING hire date must not make the driver the most senior (seniority
    // sorts ascending, so "2000-01-01" put unknown-tenure drivers at the front
    // of every priority queue — a data gap becoming top scheduling priority).
    // Default unknown tenure to a far-future date so they sort LEAST senior;
    // hire_date is only used for seniority ordering in the engine.
    hire_date: raw.hire_date && raw.hire_date.length >= 10
      ? raw.hire_date.slice(0, 10)
      : "2999-12-31",
    license_expiration_date: raw.dl_expires_on
      ? raw.dl_expires_on.slice(0, 10)
      : null,
    dot_certified: raw.dot_certified === true,
    xl_certified: raw.xl_certified === true,
    saved_availability: availabilityFromDows(raw.available_dows),
    preferred_availability: availabilityFromDows(raw.preferred_dows),
    // No hours on the record → the engine applies the pto_default_hours
    // setting per day. Stamping a literal here (the old behavior) silently
    // overrode that setting for every DSP.
    pto_records: (ptoByDriver.get(String(raw.id)) ?? []).map((date) => ({
      date,
      hours: null,
    })),
    // Clamped — the engine's normalizer THROWS outside 0-100, which
    // would drop the driver entirely over a bad score value.
    attendance_score:
      typeof raw.attendance_score === "number" && isFinite(raw.attendance_score)
        ? Math.max(0, Math.min(100, raw.attendance_score))
        : null,
    attendance_final: raw.final_corrective_action === true,
    weekday_affinity:
      Array.isArray(raw.weekday_affinity) && raw.weekday_affinity.length === 7
        ? raw.weekday_affinity
        : null,
    fifth_day_ok: raw.fifth_day_ok === true,
  };
}

// Convert a zone-carrying ISO timestamp to DSP-local wall clock
// ("YYYY-MM-DDTHH:MM:SS"). The engine's date math is deliberately
// timezone-naive, so what we feed it defines the semantics: with this
// conversion, rest gaps are WALL-CLOCK hours — the way dispatchers and
// drivers read a schedule. (On the two DST nights a year wall-clock and
// elapsed hours differ by 1h; the server-side compliance gate (0500)
// checks the absolute timestamps, so the regulatory floor still holds.)
// Zone-less inputs are already wall clock — converting them through
// Date would REINTERPRET them in the runtime's zone — so they pass
// through untouched, as does anything Intl can't make sense of.
function toLocalWallClock(
  iso: string | null | undefined,
  tz: string | null | undefined,
): string | null {
  if (!iso) return null;
  if (!tz || !/(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(iso)) return iso;
  const t = new Date(iso);
  if (isNaN(t.getTime())) return iso;
  try {
    const parts: Record<string, string> = {};
    for (const p of new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hour12: false,
    }).formatToParts(t)) {
      parts[p.type] = p.value;
    }
    const hh = parts.hour === "24" ? "00" : parts.hour;
    return `${parts.year}-${parts.month}-${parts.day}T${hh}:${parts.minute}:${parts.second}`;
  } catch {
    return iso;
  }
}

function mapShift(raw: DashboardShift, tz: string | null): ShiftInput {
  const startLocal = toLocalWallClock(raw.starts_at, tz);
  const endLocal = toLocalWallClock(raw.ends_at, tz);
  const start = startLocal ?? `${raw.date}T00:00:00`;
  // Only pass end_time when it post-dates the start (guards bad rows).
  const end =
    endLocal && startLocal && endLocal > startLocal
      ? endLocal
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
    shift_kind: raw.shift_kind ?? "regular",
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

interface WocFlags {
  on: boolean;
  maxConsecutiveDays: number;
  maxHours: number;
}

interface AffinityFlags {
  on: boolean;
  dayOrder: number[] | undefined;
}

function boundaryModeSettings(
  boundary: "preferred" | "availability",
  maxDays: number,
  assignmentMode: "rotational_fill" | "sequential_fill",
  rotationBatch: number,
  enh: EnhancementFlags,
  license: LicenseFlags,
  woc: WocFlags,
  affinity: AffinityFlags,
  fifthDayFill: boolean,
  fifthDayOverrideAvail: boolean,
  attendancePenalty: boolean,
  schedulingMethod: "seniority" | "random",
  rotationStartDay: number,
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
    // WOC composes with the boundary modes — a single Working Hours
    // Compliance rule capping consecutive days + weekly hours.
    weekly_hour_cap_enforcement: woc.on,
    weekly_hour_cap: woc.maxHours,
    pto_counts_toward_cap: false,
    min_rest_enforcement: false,
    woc_enforcement: woc.on,
    woc_max_consecutive_days: woc.maxConsecutiveDays,
    same_day_multi_shift: "block",
    historical_pattern_protection: "off",
    attendance_scheduling: false,
    attendance_penalty: attendancePenalty,
    scheduling_method: schedulingMethod,
    rotation_start_day: rotationStartDay,
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
    // Driver Affinity Enhancement composes with both boundary modes.
    affinity_enhancement: affinity.on,
    affinity_day_order: affinity.dayOrder,
    fifth_day_fill: fifthDayFill,
    fifth_day_override_availability: fifthDayOverrideAvail,
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
  // WOC (Working Hours Compliance) — one rule, two DSP-set limits:
  // max consecutive working days and max scheduled hours per week.
  const woc: WocFlags = {
    on: r.woc !== false,
    maxConsecutiveDays: Math.max(1, Math.min(7, Math.round(r.woc_max_consecutive_days ?? 6))),
    maxHours: Math.max(1, Math.min(168, Math.round(r.woc_max_hours ?? payload.weekly_hour_cap ?? 40))),
  };
  // Driver Affinity Enhancement — final post-pass swapping drivers onto
  // their historically-favored weekdays, in the DSP's day-priority order.
  const affinity: AffinityFlags = {
    on: r.affinity_enhancement === true,
    dayOrder: Array.isArray(r.affinity_day_order) ? r.affinity_day_order : undefined,
  };
  // Fifth-Day Fill — final pass layering an extra day onto open shifts
  // for drivers who opted in.
  const fifthDayFill = r.fifth_day_fill === true;
  const fifthDayOverrideAvail = r.fifth_day_override_availability === true;
  // Attendance Penalty — Final-corrective-action drivers scheduled last.
  const attendancePenalty = r.attendance_penalty === true;
  // Who fills first — seniority (default) or a stable random order.
  const schedulingMethod = r.fill_priority === "random" ? "random" : "seniority";
  // Which weekday the shift-fill rotation starts on (0=Sun..6=Sat).
  const rotationStartDay = Math.max(0, Math.min(6, Math.round(r.rotation_start_day ?? 0)));

  // Run mode — defaults to full_rebuild (the historical behavior). Operators
  // can opt into rebuild_unlocked ("keep my pinned ones") or fill_empty_only
  // ("just fill the holes, don't touch existing").
  const runMode =
    r.run_mode === "fill_empty_only" || r.run_mode === "rebuild_unlocked"
      ? r.run_mode
      : "full_rebuild";
  const preserveLocked = r.preserve_locked_assignments !== false;

  // Full scheduling-method picker. When supplied, overrides the legacy
  // fill_priority/tiebreaker pair. Falls back to those for backwards compat.
  const METHOD_SET = new Set([
    "fair_rotation",
    "seniority",
    "full_time_priority",
    "availability_first",
    "alphabetical",
    "attendance_priority",
    "random",
  ]);
  const explicitMethod = (typeof r.scheduling_method === "string" &&
    METHOD_SET.has(r.scheduling_method)) ? r.scheduling_method : null;

  // Same-day double-shift policy. Default block (one shift per driver per day).
  const sameDay = r.same_day_multi_shift === "allow" ? "allow" : "block";

  // Historical pattern protection. Off by default (legacy) — operators turn
  // it on per DSP to surface the R012 score component + Step 5 pre-pass.
  const PATTERN_SET = new Set(["off", "low", "medium", "high"]);
  const patternStrength = (typeof r.historical_pattern_protection === "string" &&
    PATTERN_SET.has(r.historical_pattern_protection))
      ? r.historical_pattern_protection
      : "off";
  const historyWeeks = r.history_window_weeks === 6 || r.history_window_weeks === 8
    ? r.history_window_weeks
    : 4;

  // Smooth attendance scoring (R013). Off by default. When on, weight is
  // low/medium/high — scales the ±25-point contribution by 0.4/1.0/1.6.
  const attendanceScheduling = r.attendance_scheduling === true;
  const ATT_WEIGHT_SET = new Set(["low", "medium", "high"]);
  const attendanceWeight = (typeof r.attendance_weight === "string" &&
    ATT_WEIGHT_SET.has(r.attendance_weight)) ? r.attendance_weight : "medium";

  // Per-rule windows. Default to schedule_week (the historical behavior).
  // rolling_7_days = a 7-day window ending on the shift date; pay_period
  // requires a pay_period range on the EngineInput, which we don't currently
  // forward — so callers requesting pay_period get rolling_7_days instead.
  const WINDOW_SET = new Set(["schedule_week", "rolling_7_days"]);
  const maxDaysWindow = (typeof r.max_days_window === "string" &&
    WINDOW_SET.has(r.max_days_window)) ? r.max_days_window : "schedule_week";
  // Soft target days/week (default 4 — most DSPs run 4-day weeks with
  // 10h shifts before OT).
  const targetDays = Math.max(0, Math.min(7,
    Math.round(r.target_days_per_week ?? 4)));
  const weeklyHourWindow = (typeof r.weekly_hour_window === "string" &&
    WINDOW_SET.has(r.weekly_hour_window)) ? r.weekly_hour_window : "schedule_week";

  const ptoCountsTowardCap = r.pto_counts_toward_cap !== false;
  const ptoDefaultHours = Math.max(0, Math.min(24,
    Math.round(r.pto_default_hours ?? PTO_HOURS_PER_DAY)));
  const minRestHours = Math.max(0, Math.min(48,
    Math.round(r.min_rest_hours ?? 10)));

  // Boundary modes are mutually exclusive; preferred wins if both are set.
  if (r.preferred_only === true) {
    return boundaryModeSettings("preferred", maxDays, assignmentMode, rotationBatch, enh, license, woc, affinity, fifthDayFill, fifthDayOverrideAvail, attendancePenalty, schedulingMethod, rotationStartDay);
  }
  if (r.availability_only === true) {
    return boundaryModeSettings("availability", maxDays, assignmentMode, rotationBatch, enh, license, woc, affinity, fifthDayFill, fifthDayOverrideAvail, attendancePenalty, schedulingMethod, rotationStartDay);
  }

  // Pick the final scheduling method: explicit picker > legacy
  // fill_priority/tiebreaker. Legacy fallback preserves old DSP setups.
  const legacyMethod = r.tiebreaker === "seniority" ? "seniority" : "fair_rotation";
  const finalMethod = explicitMethod
    ?? (schedulingMethod === "random" ? "random" : legacyMethod);

  return {
    run_mode: runMode,
    preserve_locked_assignments: preserveLocked,
    eligible_driver_status:
      r.include_onboarding !== false ? "active_and_onboarding" : "active_only",
    license_enforcement: license.on,
    license_protection_days: license.protectionDays,
    certification_enforcement: true,
    pto_protection: r.pto_block !== false,
    availability_enforcement: r.availability !== false,
    availability_required: false,
    max_days_enforcement: true,
    max_days: maxDays,
    max_days_window: maxDaysWindow,
    target_days_per_week: targetDays,
    // WOC (Working Hours Compliance) governs the weekly-hours cap.
    weekly_hour_cap_enforcement: woc.on,
    weekly_hour_cap: woc.maxHours,
    weekly_hour_window: weeklyHourWindow,
    pto_counts_toward_cap: ptoCountsTowardCap,
    pto_default_hours: ptoDefaultHours,
    min_rest_enforcement: r.min_rest !== false,
    min_rest_hours: minRestHours,
    // WOC — also caps consecutive working days.
    woc_enforcement: woc.on,
    woc_max_consecutive_days: woc.maxConsecutiveDays,
    same_day_multi_shift: sameDay,
    historical_pattern_protection: patternStrength,
    history_window_weeks: historyWeeks,
    attendance_scheduling: attendanceScheduling,
    attendance_penalty: attendancePenalty,
    attendance_weight: attendanceWeight,
    scheduling_method: finalMethod,
    assignment_mode: assignmentMode,
    rotation_batch_size: rotationBatch,
    rotation_start_day: rotationStartDay,
    preferred_availability_priority: r.preferred_days !== false,
    preferred_availability_required: r.preferred_availability_required === true,
    preferred_enhancement: enh.on,
    preferred_enhancement_contiguous: enh.contiguous,
    preferred_enhancement_extra: enh.extra,
    affinity_enhancement: affinity.on,
    affinity_day_order: affinity.dayOrder,
    fifth_day_fill: fifthDayFill,
    fifth_day_override_availability: fifthDayOverrideAvail,
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

  const eligibleRaw = payload.drivers.filter((d) => {
    const s = String(d.status ?? "").toLowerCase();
    return s === "active" || s === "onboarding";
  });
  const drivers = eligibleRaw.map((d) => mapDriver(d, ptoByDriver));

  const settings = buildSettings(payload);
  const tz = typeof payload.dsp_timezone === "string" && payload.dsp_timezone
    ? payload.dsp_timezone
    : null;
  const input: EngineInput = {
    schedule_week_start: payload.schedule_week_start,
    shifts: payload.shifts.map((s) => mapShift(s, tz)),
    drivers,
    dsp: { dsp_blackout_dates: payload.blackout_dates ?? [] },
    settings,
    ad_hoc_constraints: payload.ad_hoc_constraints,
  };
  const result = runEngine(input);

  // Data-quality notice: under Seniority ordering, a driver with no hire
  // date on file gets a far-future sentinel and always ranks LEAST senior
  // (mapDriver above). Deliberate — a data gap must not become top
  // priority — but invisible to the operator unless surfaced.
  if (settings.scheduling_method === "seniority") {
    for (const d of eligibleRaw) {
      if (d.hire_date && d.hire_date.length >= 10) continue;
      result.warnings.push({
        type: "hire_date_missing",
        driver_id: String(d.id),
        message:
          `${String(d.full_name ?? d.id)} has no hire date on file — ` +
          "ranked least-senior by the Seniority scheduling method until one is set",
      });
    }
  }
  return result;
}
