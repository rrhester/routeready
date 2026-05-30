// ============================================================================
// RouteReady Flex Capacity Engine — Types
// ============================================================================
//
// Purpose: model how many ADDITIONAL routes a DSP can absorb using *existing*
// driver availability before it must hire. This is an OPERATIONAL PLANNING
// metric. It is deliberately NOT a staffing metric, NOT a headcount metric,
// and NOT an FT/PT metric — FT/PT composition is computed elsewhere and stays
// independent.
//
// The business question every type here serves:
//   "If Amazon increased routes tomorrow, how many additional routes could
//    this DSP realistically absorb?"
//
// The model answers it at three operating tiers (Comfortable / Stretch /
// Maximum), per day and rolled up for the week.
// ============================================================================

/** Canonical day key, matching the app's availability storage order. */
export type DayKey = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

export const DAY_KEYS: readonly DayKey[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

/** The three capacity operating states, ordered by disruption (low → high). */
export type CapacityTier = "comfortable" | "stretch" | "maximum";

/** Route-type → certification gate. A day's routeType decides which cert a
 *  driver must hold to count toward that day's capacity. "standard"/undefined
 *  requires nothing. */
export type RouteType = "standard" | "xl" | "edv" | "dot" | (string & {});

/** Driver certifications (hard gates relative to a day's route type). */
export interface DriverCertifications {
  dot: boolean;
  xl: boolean;
  edv: boolean;
}

/**
 * A single driver, normalized for the flex engine. The Supabase adapter
 * (see adapter.ts) maps live rows (drivers.metadata.availability.*, certs,
 * time_off_requests, scheduling_settings, and the current week's shifts)
 * into this shape. The engine never touches the database directly.
 */
export interface FlexDriver {
  id: string;
  /** Only active drivers contribute capacity. */
  active: boolean;

  // ── Availability (the heart of flex capacity) ───────────────────────────
  /** Days the driver CAN work (drivers.metadata.availability.days). */
  available: DayKey[];
  /** Days the driver PREFERS (subset of `available`). Drives the
   *  Comfortable tier. (drivers.metadata.availability.preferred_days) */
  preferred: DayKey[];
  /** Driver opted in to a voluntary 5th working day
   *  (drivers.metadata.availability.fifth_day_ok). */
  fifthDayOptIn: boolean;

  // ── This-week state ─────────────────────────────────────────────────────
  /** Days the driver is OFF this week (PTO), from time_off_requests. */
  pto: DayKey[];
  /** Days the driver is ALREADY scheduled this week. */
  scheduledDays: DayKey[];
  /** Hours already scheduled this week (sum of assigned shift hours). */
  scheduledHours: number;

  // ── Hard limits ─────────────────────────────────────────────────────────
  /** Weekly hour cap (scheduling_settings.weekly_hour_cap). */
  weeklyHourCap: number;
  /** Hours a single shift/block consumes (scheduling_settings.default_block_hours). */
  blockHours: number;
  /** Hard cap on working days per week (scheduling_settings.max_days_per_week). */
  maxDaysPerWeek: number;
  certifications: DriverCertifications;

  // ── Optional signals (reserved for future models; see README) ───────────
  /** 0–100; lower = more callout risk. Reserved for attendance modeling. */
  attendanceScore?: number;
  /** 0–100; reserved for performance modeling. */
  performanceScore?: number;
  /** Lower = more senior. Reserved for prioritization/tiebreaks. */
  seniorityRank?: number;
  /** Per-day affinity 0–100; reserved for schedule-disruption scoring. */
  affinity?: Partial<Record<DayKey, number>>;
}

/** Route demand for a single day of the week. */
export interface FlexRouteDay {
  day: DayKey;
  /** Planned routes for the day (okami_demand.target_routes, optionally
   *  cushion-adjusted by the adapter). */
  routeTarget: number;
  /** Route type, gating which certs are required to serve it. */
  routeType?: RouteType;
  /** Optional forecast (e.g. Amazon-provided), surfaced for context only. */
  routeForecast?: number;
}

/** Tunable knobs. Defaults match the app's conventions and are safe. */
export interface FlexConfig {
  /** A day beyond this count of already-scheduled days is a "5th day"
   *  (requires opt-in for Stretch). Default 4 — matches the app's
   *  FT (≥4 days) / fifth-day model. */
  fifthDayThreshold: number;
  /** FT share of recommended hires when capacity is exhausted (0–1).
   *  Default 0.85 — matches RouteReady's 85% FT target. The remainder is PT.
   *  NOTE: this is only used to SPLIT a hiring recommendation; flex capacity
   *  itself never depends on FT/PT ratios. */
  hireFullTimeShare: number;
}

export const DEFAULT_CONFIG: FlexConfig = {
  fifthDayThreshold: 4,
  hireFullTimeShare: 0.85,
};

/** The complete input to the flex engine for one DSP-week. */
export interface FlexInput {
  /** ISO date (Monday) of the week being analyzed. Context only. */
  weekStart: string;
  drivers: FlexDriver[];
  /** Route demand, one entry per day present in the plan. */
  routes: FlexRouteDay[];
  /** Optional config override (merged over DEFAULT_CONFIG). */
  config?: Partial<FlexConfig>;
}

/** Per-day capacity result. `*FlexRoutes` are clamped to ≥ 0 for display. */
export interface DayCapacity {
  day: DayKey;
  requiredRoutes: number;
  comfortableDrivers: number;
  stretchDrivers: number;
  maximumDrivers: number;
  /** max(0, comfortableDrivers − requiredRoutes) */
  comfortableFlexRoutes: number;
  /** max(0, stretchDrivers − requiredRoutes) */
  stretchFlexRoutes: number;
  /** max(0, maximumDrivers − requiredRoutes) */
  maximumFlexRoutes: number;
}

/** Weekly rollup + the headline "additional routes per day" figures. */
export interface WeeklyCapacity {
  weeklyRequiredRoutes: number;
  weeklyComfortableDriverDays: number;
  weeklyStretchDriverDays: number;
  weeklyMaximumDriverDays: number;
  /** Driver-day surplus over the week (NOT clamped — can be negative). */
  weeklyComfortableFlex: number;
  weeklyStretchFlex: number;
  weeklyMaximumFlex: number;
  /** Surplus driver-days converted to additional routes/day (flex / 7). */
  weeklyComfortableRouteIncrease: number;
  weeklyStretchRouteIncrease: number;
  weeklyMaximumRouteIncrease: number;
}

/** A KPI-ready headline (matches the spec's KPI + hover deep-dive). */
export interface FlexKpi {
  /** Representative current daily routes (peak day by default). */
  currentRoutes: number;
  /** currentRoutes + rounded comfortable/stretch/maximum increase. */
  comfortableCapacity: number;
  stretchCapacity: number;
  maximumCapacity: number;
  /** Additional routes available at each tier (capacity − current, ≥ 0). */
  comfortableRoutesAvailable: number;
  stretchRoutesAvailable: number;
  maximumRoutesAvailable: number;
  /** Coaching color for a given projected growth (see coachingFor). */
  status: FlexStatus;
  coaching: string;
}

/** KPI coaching state (3 states; What-If adds "critical"). */
export type FlexStatus = "green" | "yellow" | "red";

/** Full engine output. */
export interface FlexResult {
  weekStart: string;
  days: DayCapacity[];
  weekly: WeeklyCapacity;
  kpi: FlexKpi;
  config: FlexConfig;
}
