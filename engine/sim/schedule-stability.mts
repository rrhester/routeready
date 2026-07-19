// Schedule-stability simulation.
//
// Rolls a FIXED roster of N drivers forward over W weeks, feeding each week's
// assignments back in as history, and measures how often a driver keeps the
// SAME working weekdays from one week to the next. This is the real meaning of
// "do schedules stay the same" — the engine itself is deterministic (identical
// inputs -> byte-identical output), so the interesting question is week-over-
// week churn, which R012 historical-pattern protection is built to suppress.
//
// Run:  node --experimental-strip-types engine/sim/schedule-stability.mts
//   flags: --drivers=100 --weeks=12 --demand=0.85 --protection=high --seed=1
//          --xl=0.12  (fraction of routes that are XL)
//   Pass --protection=off to see the un-stabilised baseline for comparison.

import { runEngine } from "../src/index.ts";
import { addDays, dayOfWeek } from "../src/dates.ts";
import type {
  DriverInput,
  EngineInput,
  HistoryShift,
  PatternStrength,
  ShiftInput,
} from "../src/types.ts";

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------
function arg(name: string, dflt: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : dflt;
}
const N_DRIVERS = parseInt(arg("drivers", "100"), 10);
const N_WEEKS = parseInt(arg("weeks", "12"), 10);
const DEMAND = parseFloat(arg("demand", "0.85")); // routes as a fraction of full 6-day capacity
const XL_FRAC = parseFloat(arg("xl", "0.12"));
const PROTECTION = arg("protection", "high") as PatternStrength;
const SEED = parseInt(arg("seed", "1"), 10);

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32) — the harness is reproducible; the ENGINE
// never sees randomness.
// ---------------------------------------------------------------------------
function mulberry32(a: number) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(SEED);
const randInt = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
const pick = <T,>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];

// ---------------------------------------------------------------------------
// Roster — fixed for the whole run
// ---------------------------------------------------------------------------
function buildRoster(n: number): DriverInput[] {
  const drivers: DriverInput[] = [];
  for (let i = 0; i < n; i++) {
    const id = `d${String(i + 1).padStart(3, "0")}`;
    const partTime = rnd() < 0.18;
    drivers.push({
      driver_id: id,
      first_name: "Driver",
      last_name: id,
      status: "active",
      employment_type: partTime ? "part_time" : "full_time",
      hire_date: `20${randInt(18, 25)}-0${randInt(1, 9)}-1${randInt(0, 9)}`,
      license_expiration_date: "2030-01-01",
      xl_certified: rnd() < 0.35,
      // Attendance clustered high, with a tail of weaker drivers.
      attendance_score: Math.min(100, Math.round(70 + rnd() * 30 - (rnd() < 0.15 ? 30 : 0))),
    });
  }
  return drivers;
}

// ---------------------------------------------------------------------------
// Weekly open shifts. Mon–Sat operating week (skip Sunday). Demand per day is
// a fraction of full driver capacity, with small week-to-week noise so the
// simulation isn't a fixed template the engine could trivially memorise.
// ---------------------------------------------------------------------------
const OP_DAYS = [1, 2, 3, 4, 5, 6]; // Mon..Sat as offsets from the Sunday week start

function buildWeekShifts(weekStart: string, roster: DriverInput[]): ShiftInput[] {
  const fullPerDay = Math.round(roster.length); // 1 route/driver/day = full capacity
  const shifts: ShiftInput[] = [];
  let seq = 0;
  for (const off of OP_DAYS) {
    const date = addDays(weekStart, off);
    const noise = 0.9 + rnd() * 0.2; // ±10%
    const routes = Math.max(1, Math.round(fullPerDay * DEMAND * noise));
    for (let r = 0; r < routes; r++) {
      const xl = rnd() < XL_FRAC;
      shifts.push({
        shift_id: `${date}-r${seq++}`,
        date,
        start_time: `${date}T09:00`,
        route_type: xl ? "xl" : "standard",
      });
    }
  }
  return shifts;
}

// ---------------------------------------------------------------------------
// Run the rolling simulation
// ---------------------------------------------------------------------------
const roster = buildRoster(N_DRIVERS);
const WEEK0 = "2026-01-04"; // a Sunday
const HISTORY_WINDOW = 8;

// history accumulates real assignments; we keep ~window weeks of it
let history: HistoryShift[] = [];
// per-week per-driver set of weekdays worked (0=Sun..6=Sat)
const weekdaySets: Array<Map<string, Set<number>>> = [];
const coverage: Array<{ total: number; filled: number }> = [];

for (let w = 0; w < N_WEEKS; w++) {
  const weekStart = addDays(WEEK0, w * 7);
  const shifts = buildWeekShifts(weekStart, roster);

  const input: EngineInput = {
    schedule_week_start: weekStart,
    shifts,
    drivers: roster,
    history,
    settings: {
      historical_pattern_protection: PROTECTION,
      history_window_weeks: HISTORY_WINDOW,
      target_days_per_week: 5,
      scheduling_method: "fair_rotation",
      weekly_hour_cap: 60,
    },
  };

  const res = runEngine(input);

  // record weekday set per driver + build this week's history rows
  const dayset = new Map<string, Set<number>>();
  const newHistory: HistoryShift[] = [];
  const shiftDate = new Map(shifts.map((s) => [s.shift_id, s.date]));
  for (const a of res.assigned_shifts) {
    const date = shiftDate.get(a.shift_id)!;
    if (!dayset.has(a.driver_id)) dayset.set(a.driver_id, new Set());
    dayset.get(a.driver_id)!.add(dayOfWeek(date));
    newHistory.push({ driver_id: a.driver_id, date, duration_hours: 10 });
  }
  weekdaySets.push(dayset);
  coverage.push({ total: res.summary_metrics.total_shifts, filled: res.summary_metrics.filled_shifts });

  // roll history forward, keep only the last HISTORY_WINDOW weeks
  history = [...history, ...newHistory].filter(
    (h) => (Date.parse(weekStart) - Date.parse(h.date)) / 86400000 <= HISTORY_WINDOW * 7,
  );
}

// ---------------------------------------------------------------------------
// Stability metrics — compare each week against the previous week
// ---------------------------------------------------------------------------
function jaccard(a: Set<number>, b: Set<number>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

let pairCount = 0;
let identical = 0; // same exact weekday set
let sameCount = 0; // same NUMBER of days (schedule "size" unchanged)
let jSum = 0;
let daysChanged = 0;

for (let w = 1; w < weekdaySets.length; w++) {
  const prev = weekdaySets[w - 1];
  const cur = weekdaySets[w];
  for (const d of roster) {
    const a = prev.get(d.driver_id) ?? new Set<number>();
    const b = cur.get(d.driver_id) ?? new Set<number>();
    pairCount++;
    const j = jaccard(a, b);
    jSum += j;
    if (j === 1) identical++;
    if (a.size === b.size) sameCount++;
    // symmetric difference size
    let diff = 0;
    for (const x of a) if (!b.has(x)) diff++;
    for (const x of b) if (!a.has(x)) diff++;
    daysChanged += diff;
  }
}

// "sticky day" view: for each (driver, weekday) how consistently is it worked?
const dowWorked = new Map<string, number[]>(); // driver -> count per dow
for (const set of weekdaySets) {
  for (const [id, days] of set) {
    if (!dowWorked.has(id)) dowWorked.set(id, new Array(7).fill(0));
    for (const dow of days) dowWorked.get(id)![dow]++;
  }
}
// a driver's "core days" = weekdays worked in >=75% of weeks; measure what
// fraction of their working days each week are core days (routine adherence)
let coreAdherenceNum = 0;
let coreAdherenceDen = 0;
for (const [id, counts] of dowWorked) {
  const core = new Set<number>();
  counts.forEach((c, dow) => {
    if (c / N_WEEKS >= 0.75) core.add(dow);
  });
  for (const set of weekdaySets) {
    const days = set.get(id);
    if (!days || days.size === 0) continue;
    for (const dow of days) {
      coreAdherenceDen++;
      if (core.has(dow)) coreAdherenceNum++;
    }
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
const pct = (x: number) => (x * 100).toFixed(1) + "%";
const avgCov =
  coverage.reduce((s, c) => s + (c.total ? c.filled / c.total : 1), 0) / coverage.length;
const avgFilled = coverage.reduce((s, c) => s + c.filled, 0) / coverage.length;
const avgDaysPerDriver =
  weekdaySets.reduce((s, set) => {
    let t = 0;
    for (const days of set.values()) t += days.size;
    return s + t / roster.length;
  }, 0) / weekdaySets.length;

console.log("═".repeat(66));
console.log(" RouteReady — schedule-stability simulation");
console.log("═".repeat(66));
console.log(
  ` roster: ${N_DRIVERS} drivers   weeks: ${N_WEEKS}   demand: ${pct(DEMAND)} of capacity`,
);
console.log(
  ` XL routes: ${pct(XL_FRAC)}   pattern-protection: ${PROTECTION}   seed: ${SEED}`,
);
console.log("─".repeat(66));
console.log(` avg coverage           : ${pct(avgCov)}  (${avgFilled.toFixed(0)} routes/wk filled)`);
console.log(` avg days worked/driver : ${avgDaysPerDriver.toFixed(2)} / week`);
console.log("─".repeat(66));
console.log(" WEEK-OVER-WEEK STABILITY (per driver, vs the previous week)");
console.log(`   identical weekday set : ${pct(identical / pairCount)}  ← schedule unchanged`);
console.log(`   same # of days worked : ${pct(sameCount / pairCount)}`);
console.log(`   mean day overlap (Jaccard): ${(jSum / pairCount).toFixed(3)}`);
console.log(`   avg weekdays changed  : ${(daysChanged / pairCount).toFixed(2)} per driver/week`);
console.log("─".repeat(66));
console.log(" ROUTINE ADHERENCE (across the whole run)");
console.log(
  `   worked days that are "core" days (worked in ≥75% of weeks): ${pct(
    coreAdherenceNum / coreAdherenceDen,
  )}`,
);
console.log("═".repeat(66));
