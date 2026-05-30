// ============================================================================
// Flex Capacity — Supabase adapter
// ============================================================================
// Maps live Supabase rows into the engine's normalized FlexInput. The engine
// stays pure and DB-agnostic; ALL knowledge of real table/column shapes lives
// here. The edge function (supabase/functions/flex-capacity) does the queries
// and hands the rows to buildFlexInput().
//
// Real shapes (confirmed against migrations):
//   drivers.metadata.availability.{days,preferred_days,fifth_day_ok}
//   drivers.{dot_certified,xl_certified,edv_certified,status}
//   time_off_requests.{driver_id,start_date,end_date,status}
//   shifts.{driver_id,date,starts_at,ends_at,block_hours,status}
//   okami_demand.{date,target_routes,service_type_id}
//   scheduling_settings.{default_block_hours,max_days_per_week,weekly_hour_cap,cushion_pct}
// ============================================================================

import {
  DAY_KEYS,
  type DayKey,
  type FlexDriver,
  type FlexInput,
  type FlexRouteDay,
  type RouteType,
} from "./types.ts";

// ── Loose row shapes (only the fields we read) ───────────────────────────────

export interface DriverRow {
  id: string;
  status: string;
  dot_certified?: boolean | null;
  xl_certified?: boolean | null;
  edv_certified?: boolean | null;
  metadata?: {
    availability?: {
      days?: string[] | null;
      preferred_days?: string[] | null;
      fifth_day_ok?: boolean | null;
    } | null;
  } | null;
  // Optional future-model signals.
  attendance_score?: number | null;
  performance_score?: number | null;
}

export interface TimeOffRow {
  driver_id: string;
  start_date: string; // ISO date (inclusive)
  end_date: string; // ISO date (inclusive)
  status?: string | null;
}

export interface ShiftRow {
  driver_id?: string | null;
  date: string; // ISO date
  starts_at?: string | null;
  ends_at?: string | null;
  block_hours?: number | null;
  status?: string | null;
  shift_kind?: string | null;
}

export interface DemandRow {
  date: string; // ISO date
  target_routes?: number | null;
  service_type_id?: string | null;
}

export interface SchedulingSettings {
  default_block_hours?: number | null;
  max_days_per_week?: number | null;
  weekly_hour_cap?: number | null;
  cushion_pct?: number | null;
}

export interface BuildOptions {
  weekStart: string;
  driverRows: DriverRow[];
  timeOffRows: TimeOffRow[];
  shiftRows: ShiftRow[];
  demandRows: DemandRow[];
  settings: SchedulingSettings;
  /** Map service_type_id → RouteType (so cert gating works). Optional. */
  serviceTypeToRoute?: (serviceTypeId: string | null | undefined) => RouteType;
  /** Apply the cushion buffer to route demand (ceil(target × (1+cushion%))).
   *  Default true — matches the demand the DSP actually has to cover. */
  applyCushion?: boolean;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** ISO date → DayKey, computed in UTC to avoid timezone drift. */
export function dayKeyFromISO(iso: string): DayKey {
  const d = new Date(iso + "T00:00:00Z");
  // getUTCDay: 0=Sun..6=Sat → map into our mon-first DAY_KEYS order.
  const jsDow = d.getUTCDay();
  const monFirst = (jsDow + 6) % 7; // Mon=0 … Sun=6
  return DAY_KEYS[monFirst]!;
}

/** Normalize a stored day list (['mon','tue',…]) to validated DayKeys. */
function normalizeDays(list: string[] | null | undefined): DayKey[] {
  if (!Array.isArray(list)) return [];
  const set = new Set(DAY_KEYS);
  const out: DayKey[] = [];
  for (const raw of list) {
    const k = String(raw).toLowerCase().slice(0, 3) as DayKey;
    if (set.has(k) && !out.includes(k)) out.push(k);
  }
  return out;
}

function shiftHours(s: ShiftRow, blockFallback: number): number {
  if (s.starts_at && s.ends_at) {
    const h = (new Date(s.ends_at).getTime() - new Date(s.starts_at).getTime()) / 3_600_000;
    if (h > 0 && h <= 24) return h;
  }
  return Number(s.block_hours) || blockFallback;
}

// ── Build ────────────────────────────────────────────────────────────────────

/**
 * Assemble a FlexInput from live Supabase rows for one DSP-week.
 *
 * - Only `active` drivers are included (capacity is about who can absorb work).
 * - PTO is expanded from approved time_off_requests into per-day off-days
 *   intersected with this week.
 * - Current scheduled days/hours come from real assigned shifts (training /
 *   ride-along shifts are excluded — they don't consume route capacity).
 * - Route demand is summed per day from okami_demand, cushion applied by
 *   default. The route type for each day is the dominant service type.
 */
export function buildFlexInput(opts: BuildOptions): FlexInput {
  const {
    weekStart,
    driverRows,
    timeOffRows,
    shiftRows,
    demandRows,
    settings,
    serviceTypeToRoute,
    applyCushion = true,
  } = opts;

  const blockHours = Number(settings.default_block_hours) || 10;
  const maxDays = Number(settings.max_days_per_week) || 5;
  const weeklyHourCap = Number(settings.weekly_hour_cap) || maxDays * blockHours;
  const cushionPct = applyCushion ? Number(settings.cushion_pct) || 0 : 0;

  // PTO by driver → set of DayKeys within this week.
  const ptoByDriver = new Map<string, Set<DayKey>>();
  for (const t of timeOffRows) {
    if (t.status && t.status !== "approved") continue;
    let cur = new Date(t.start_date + "T00:00:00Z");
    const end = new Date(t.end_date + "T00:00:00Z");
    while (cur <= end) {
      const iso = cur.toISOString().slice(0, 10);
      const set = ptoByDriver.get(t.driver_id) ?? new Set<DayKey>();
      set.add(dayKeyFromISO(iso));
      ptoByDriver.set(t.driver_id, set);
      cur = new Date(cur.getTime() + 86_400_000);
    }
  }

  // Current scheduled days + hours by driver (assigned, non-training shifts).
  const schedDays = new Map<string, Set<DayKey>>();
  const schedHours = new Map<string, number>();
  for (const s of shiftRows) {
    if (!s.driver_id) continue;
    if (s.status && !["scheduled", "completed"].includes(s.status)) continue;
    if (s.shift_kind === "training" || s.shift_kind === "ride_along") continue;
    const day = dayKeyFromISO(s.date);
    const ds = schedDays.get(s.driver_id) ?? new Set<DayKey>();
    ds.add(day);
    schedDays.set(s.driver_id, ds);
    schedHours.set(s.driver_id, (schedHours.get(s.driver_id) ?? 0) + shiftHours(s, blockHours));
  }

  const drivers: FlexDriver[] = driverRows
    .filter((d) => d.status === "active")
    .map((d) => {
      const av = d.metadata?.availability ?? {};
      return {
        id: d.id,
        active: true,
        available: normalizeDays(av.days),
        preferred: normalizeDays(av.preferred_days),
        fifthDayOptIn: av.fifth_day_ok === true,
        pto: [...(ptoByDriver.get(d.id) ?? [])],
        scheduledDays: [...(schedDays.get(d.id) ?? [])],
        scheduledHours: schedHours.get(d.id) ?? 0,
        weeklyHourCap,
        blockHours,
        maxDaysPerWeek: maxDays,
        certifications: {
          dot: d.dot_certified === true,
          xl: d.xl_certified === true,
          edv: d.edv_certified === true,
        },
        attendanceScore: d.attendance_score ?? undefined,
        performanceScore: d.performance_score ?? undefined,
      } satisfies FlexDriver;
    });

  // Route demand per day (sum target_routes; cushion applied; dominant type).
  const byDay = new Map<DayKey, { routes: number; types: Map<string, number> }>();
  for (const r of demandRows) {
    const day = dayKeyFromISO(r.date);
    const slot = byDay.get(day) ?? { routes: 0, types: new Map<string, number>() };
    const t = Number(r.target_routes) || 0;
    slot.routes += t;
    if (r.service_type_id) slot.types.set(r.service_type_id, (slot.types.get(r.service_type_id) ?? 0) + t);
    byDay.set(day, slot);
  }
  const routes: FlexRouteDay[] = [...byDay.entries()].map(([day, slot]) => {
    const target = cushionPct > 0 ? Math.ceil(slot.routes * (1 + cushionPct / 100)) : slot.routes;
    // Dominant service type for the day → route type for cert gating.
    let domId: string | null = null;
    let domN = -1;
    for (const [id, n] of slot.types) if (n > domN) { domN = n; domId = id; }
    const routeType: RouteType = serviceTypeToRoute ? serviceTypeToRoute(domId) : "standard";
    return { day, routeTarget: target, routeType };
  });

  return { weekStart, drivers, routes };
}
