// RouteReady Driver Scheduling Engine — shared type definitions.
// See engine/SPEC.md for the authoritative specification.

export const ENGINE_VERSION = "1.0.0";

// ---------------------------------------------------------------------------
// Canonical enums
// ---------------------------------------------------------------------------

export type RouteType = "standard" | "step_van" | "xl" | "edv";
export type EmploymentType = "full_time" | "part_time";
export type DriverStatus =
  | "active"
  | "onboarding"
  | "inactive"
  | "suspended"
  | "terminated";

export type RunMode = "fill_empty_only" | "rebuild_unlocked" | "full_rebuild";
export type WindowType = "schedule_week" | "rolling_7_days" | "pay_period";
export type EligibleDriverStatus = "active_only" | "active_and_onboarding";
export type PatternStrength = "off" | "low" | "medium" | "high";
export type AttendanceWeight = "low" | "medium" | "high";
export type SameDayPolicy = "block" | "allow";
export type SchedulingMethod =
  | "fair_rotation"
  | "seniority"
  | "full_time_priority"
  | "availability_first"
  | "alphabetical"
  | "attendance_priority"
  | "random";
export type AssignmentMode = "sequential_fill" | "rotational_fill";

export type AssignmentSource =
  | "locked"
  | "preserved"
  | "pattern_pass"
  | "auto_fill"
  | "swap"
  | "fifth_day"
  | "pin_lock";

// ---------------------------------------------------------------------------
// Raw inputs (as supplied by callers — loosely typed, normalized at entry)
// ---------------------------------------------------------------------------

export interface TimeWindow {
  start: string; // "HH:MM"
  end: string; // "HH:MM"
}

/** Per-weekday availability. Keys are day-of-week 0 (Sun) .. 6 (Sat). */
export type WeeklyAvailability = Record<string, TimeWindow[]>;

export interface ShiftInput {
  shift_id: string;
  date: string; // ISO date, required
  start_time: string; // ISO datetime (DSP-local), required
  end_time?: string | null;
  duration_hours?: number | null;
  service_type?: string | null;
  route_type: string; // normalized to RouteType at entry
  // "regular" | "helper" (+ manual kinds). A "helper" seat on an XL route is
  // the ride-along body that needs NO certification — only the driver seat is
  // cert-gated (see R004). Defaults to "regular".
  shift_kind?: string | null;
  wave?: string | null;
  assigned_driver_id?: string | null;
  is_locked?: boolean;
  override_reason?: string | null;
  override_ack_by?: string | null;
}

export interface PtoRecord {
  date: string;
  hours?: number | null;
}

export interface AttendanceEvent {
  date: string;
  type: string;
}

export interface DriverInput {
  driver_id: string;
  first_name: string;
  last_name: string;
  status: string; // normalized to DriverStatus
  employment_type: string; // normalized to EmploymentType
  hire_date: string; // ISO date
  license_expiration_date?: string | null;
  dot_certified?: boolean;
  xl_certified?: boolean;
  edv_certified?: boolean;
  saved_availability?: WeeklyAvailability | null;
  preferred_availability?: WeeklyAvailability | null;
  pto_records?: PtoRecord[];
  attendance_score?: number | null;
  attendance_events?: AttendanceEvent[];
  /** True when the driver is on a Final corrective action. */
  attendance_final?: boolean;
  /** Per-weekday affinity (0-100), index 0=Sun..6=Sat — how often the
   *  driver was scheduled on each weekday over the rolling period. */
  weekday_affinity?: number[] | null;
  /** Driver opted in to working an extra (5th) day when coverage needs it. */
  fifth_day_ok?: boolean;
}

/** A previously-assigned shift, used only by R012 (historical patterns). */
export interface HistoryShift {
  driver_id: string;
  date: string;
  duration_hours?: number | null;
}

export interface DspConfig {
  dsp_week_start_day?: number; // 0-6
  dsp_timezone?: string;
  dsp_blackout_dates?: string[];
}

export interface PayPeriod {
  start: string;
  end: string;
}

/** Raw settings — booleans may also be supplied as "on" / "off" strings. */
export type RawBool = boolean | "on" | "off";

export interface RawSettings {
  run_mode?: RunMode;
  preserve_locked_assignments?: RawBool;
  eligible_driver_status?: EligibleDriverStatus;
  license_enforcement?: RawBool;
  license_protection_days?: number;
  certification_enforcement?: RawBool;
  pto_protection?: RawBool;
  availability_enforcement?: RawBool;
  availability_required?: RawBool;
  max_days_enforcement?: RawBool;
  max_days?: number;
  max_days_window?: WindowType;
  /** Soft per-driver target days/week. Engine scores against placements
   *  beyond this number — drivers stay at or below the target unless
   *  coverage would otherwise suffer. Distinct from max_days, which is
   *  a hard cap. Default 5. */
  target_days_per_week?: number;
  weekly_hour_cap_enforcement?: RawBool;
  weekly_hour_cap?: number;
  weekly_hour_window?: WindowType;
  pto_counts_toward_cap?: RawBool;
  pto_default_hours?: number;
  min_rest_enforcement?: RawBool;
  min_rest_hours?: number;
  woc_enforcement?: RawBool;
  woc_max_consecutive_days?: number;
  same_day_multi_shift?: SameDayPolicy;
  historical_pattern_protection?: PatternStrength;
  history_window_weeks?: 4 | 6 | 8;
  attendance_scheduling?: RawBool;
  attendance_penalty?: RawBool;
  attendance_weight?: AttendanceWeight;
  performance_scheduling?: RawBool;
  scheduling_method?: SchedulingMethod;
  assignment_mode?: AssignmentMode;
  rotation_batch_size?: number;
  rotation_start_day?: number;
  preferred_availability_priority?: RawBool;
  preferred_availability_required?: RawBool;
  preferred_enhancement?: RawBool;
  preferred_enhancement_contiguous?: RawBool;
  preferred_enhancement_extra?: RawBool;
  affinity_enhancement?: RawBool;
  affinity_day_order?: number[];
  fifth_day_fill?: RawBool;
  fifth_day_override_availability?: RawBool;
  consecutive_working_days?: RawBool;
}

export interface EngineInput {
  /** Week-start date (inclusive) of the schedule week being built. */
  schedule_week_start: string;
  shifts: ShiftInput[];
  drivers: DriverInput[];
  history?: HistoryShift[];
  dsp?: DspConfig;
  settings?: RawSettings;
  pay_period?: PayPeriod;
  /** Active ad-hoc constraints — recurring rules the operator has set up
   *  (driver_pair_forbidden, driver_lock_to_day, etc). v1 of the heuristic
   *  honors driver_lock_to_day; the rest are forwarded only for the CP-SAT
   *  path and ignored here. */
  ad_hoc_constraints?: AdHocConstraint[];
}

/** Shape of one ad-hoc constraint row (from public.ad_hoc_constraints). */
export interface AdHocConstraint {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  hardness: "hard" | "soft";
  weight?: number | null;
}

// ---------------------------------------------------------------------------
// Validated settings (every field present, defaults applied)
// ---------------------------------------------------------------------------

export interface Settings {
  run_mode: RunMode;
  preserve_locked_assignments: boolean;
  eligible_driver_status: EligibleDriverStatus;
  license_enforcement: boolean;
  /** Block scheduling this many days before a license's expiration (0 = only block once expired). */
  license_protection_days: number;
  certification_enforcement: boolean;
  pto_protection: boolean;
  availability_enforcement: boolean;
  availability_required: boolean;
  max_days_enforcement: boolean;
  max_days: number;
  max_days_window: WindowType;
  /** Soft target days per driver per week. Engine deprioritizes placements
   *  that would take a driver past this number. Distinct from max_days
   *  (hard cap). 0 disables the soft cap. */
  target_days_per_week: number;
  weekly_hour_cap_enforcement: boolean;
  weekly_hour_cap: number;
  weekly_hour_window: WindowType;
  pto_counts_toward_cap: boolean;
  pto_default_hours: number;
  min_rest_enforcement: boolean;
  min_rest_hours: number;
  woc_enforcement: boolean;
  /** WOC: maximum consecutive working days a driver may be scheduled (1-7). */
  woc_max_consecutive_days: number;
  same_day_multi_shift: SameDayPolicy;
  historical_pattern_protection: PatternStrength;
  history_window_weeks: 4 | 6 | 8;
  attendance_scheduling: boolean;
  /** When true, drivers on a Final corrective action are ordered last. */
  attendance_penalty: boolean;
  attendance_weight: AttendanceWeight;
  performance_scheduling: boolean;
  scheduling_method: SchedulingMethod;
  assignment_mode: AssignmentMode;
  /** Rotational fill: shifts assigned per driver before rotating (1-4). */
  rotation_batch_size: number;
  /** Day-of-week (0=Sun..6=Sat) the shift-fill rotation starts on. */
  rotation_start_day: number;
  preferred_availability_priority: boolean;
  preferred_availability_required: boolean;
  /** Preferred Availability Enhancement — post-pass preferred-day swaps. */
  preferred_enhancement: boolean;
  /** Sub-option: run the contiguity-preserving swap rotation. */
  preferred_enhancement_contiguous: boolean;
  /** Sub-option: also run extra rotations that may scatter day-blocks. */
  preferred_enhancement_extra: boolean;
  /** Driver Affinity Enhancement — post-pass swapping drivers onto the
   *  weekdays they have historically been scheduled on most. */
  affinity_enhancement: boolean;
  /** Weekday priority order (0=Sun..6=Sat) the affinity sweep follows;
   *  earlier days are settled and locked before later days. */
  affinity_day_order: number[];
  /** Final pass: layer an extra (5th) day onto open shifts for drivers
   *  who opted in, without violating WOC or license rules. */
  fifth_day_fill: boolean;
  /** When the 5th-day pass runs, also relax driver availability — a
   *  5th day may land on any day (WOC + license still gate it). */
  fifth_day_override_availability: boolean;
  consecutive_working_days: boolean;
}

// ---------------------------------------------------------------------------
// Normalized internal model
// ---------------------------------------------------------------------------

export interface NormalizedShift {
  shift_id: string;
  date: string;
  dow: number; // 0-6
  start_ms: number;
  end_ms: number;
  duration_hours: number;
  start_min: number; // minutes-of-day of start
  end_min: number; // minutes-of-day of end (may exceed 1440 for overnight)
  route_type: RouteType;
  shift_kind: string; // "regular" | "helper" | manual kinds
  service_type: string | null;
  wave: string | null;
  is_locked: boolean;
  override_reason: string | null;
  override_ack_by: string | null;
  original_assigned_driver_id: string | null;
}

export interface NormalizedDriver {
  driver_id: string;
  first_name: string;
  last_name: string;
  status: DriverStatus;
  employment_type: EmploymentType;
  hire_date: string;
  license_expiration_date: string | null;
  dot_certified: boolean;
  xl_certified: boolean;
  edv_certified: boolean;
  saved_availability: WeeklyAvailability | null;
  preferred_availability: WeeklyAvailability | null;
  pto_dates: Set<string>;
  pto_hours: Map<string, number>;
  attendance_score: number | null;
  attendance_events: AttendanceEvent[];
  /** True when the driver is on a Final corrective action. */
  attendance_final: boolean;
  /** Per-weekday affinity (0-100), index 0=Sun..6=Sat - or null when
   *  no rolling history is available for the driver. */
  weekday_affinity: number[] | null;
  /** Driver opted in to working an extra (5th) day when coverage needs it. */
  fifth_day_ok: boolean;
  /** Stable alphabetical key: lowercased "last first". */
  sort_key: string;
}

// ---------------------------------------------------------------------------
// Mutable run-time state
// ---------------------------------------------------------------------------

export interface AssignedRef {
  shift_id: string;
  date: string;
  dow: number;
  start_ms: number;
  end_ms: number;
  duration_hours: number;
  source: AssignmentSource;
}

export interface DriverState {
  driver_id: string;
  assigned: AssignedRef[];
}

export interface DriverPattern {
  driver_id: string;
  day_of_week_affinity: number[]; // length 7
  avg_weekly_days: number;
  avg_weekly_hours: number;
  weeks_with_data: number;
  cold_start: boolean;
}

// ---------------------------------------------------------------------------
// Eligibility + scoring
// ---------------------------------------------------------------------------

export interface BlockReason {
  rule: string;
  message: string;
}

export interface EligibilityCell {
  eligible: boolean;
  block_reasons: BlockReason[];
}

export interface ScoreComponents {
  historical: number;
  attendance: number;
  preferred: number;
  consecutive: number;
  method: number;
  performance: number;
  /** Per-driver soft-target penalty (R022). Negative when a candidate
   *  would take the driver past target_days_per_week; 0 otherwise. */
  target_days: number;
}

// ---------------------------------------------------------------------------
// Output schema
// ---------------------------------------------------------------------------

export interface AssignedShiftOut {
  shift_id: string;
  driver_id: string;
  source: AssignmentSource;
  /** Final score the winning driver earned for this shift (auto_fill only;
   *  null for locked/preserved/5th-day where no scoring ran). Surfaced so
   *  the dashboard can explain "why this driver got this shift". */
  total_score?: number | null;
  /** Per-factor score breakdown for the winning assignment (see
   *  ScoreComponents). Lets the operator see which factors influenced the
   *  pick and by how much. */
  score_components?: ScoreComponents | null;
}

export interface BlockReasonAgg {
  rule: string;
  count: number;
  message: string;
}

export interface UncoveredShiftOut {
  shift_id: string;
  top_block_reasons: BlockReasonAgg[];
  summary: string;
}

export interface DriverTotal {
  driver_id: string;
  assigned_shift_ids: string[];
  assigned_dates: string[];
  work_hours: number;
  pto_hours: number;
  total_counted_hours: number;
  max_days_used: number;
}

export interface Violation {
  severity: "critical" | "acknowledged";
  rule: string;
  shift_id?: string;
  driver_id?: string;
  message: string;
}

export interface Warning {
  type: string;
  shift_id?: string;
  driver_id?: string;
  message: string;
}

export interface AssignmentExplanation {
  shift_id: string;
  driver_id: string;
  decision: "assigned";
  hard_checks_passed: string[];
  score_components: ScoreComponents;
  total_score: number;
  warnings: string[];
  summary: string;
}

export interface UncoveredExplanation {
  shift_id: string;
  decision: "uncovered";
  top_block_reasons: BlockReasonAgg[];
  summary: string;
}

/** A driver that received zero assignments, with the reason(s) why. */
export interface UnscheduledDriver {
  driver_id: string;
  /** True if eligible for at least one shift but lost it to other drivers. */
  eligible_somewhere: boolean;
  block_reasons: BlockReasonAgg[];
}

export interface SummaryMetrics {
  engine_version: string;
  total_shifts: number;
  filled_shifts: number;
  uncovered_shifts: number;
  closed_shifts: number;
  drivers_scheduled: number;
  avg_hours_per_scheduled_driver: number;
  drivers_near_weekly_cap: number;
  drivers_near_max_days: number;
  historical_pattern_preservation_pct: number;
  preferred_availability_match_pct: number;
  attendance_risk_warnings_count: number;
  optimization_iterations: number;
  elapsed_ms: number;
}

export interface ScheduleResult {
  assigned_shifts: AssignedShiftOut[];
  uncovered_shifts: UncoveredShiftOut[];
  driver_totals: DriverTotal[];
  violations: Violation[];
  warnings: Warning[];
  explanations: {
    assignments: AssignmentExplanation[];
    uncovered: UncoveredExplanation[];
  };
  unscheduled_drivers: UnscheduledDriver[];
  summary_metrics: SummaryMetrics;
  inputs_hash: string;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Thrown on invalid input or settings. Fails loud at entry, never mid-run. */
export class EngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngineError";
  }
}
