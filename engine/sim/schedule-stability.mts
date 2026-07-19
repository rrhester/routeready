// Schedule-stability simulation.
//
// Rolls a roster of N drivers forward over W weeks, feeding each week's
// assignments back in as history, and measures how often a driver keeps the
// SAME working weekdays from one week to the next. This is the real meaning of
// "do schedules stay the same" — the engine itself is deterministic (identical
// inputs -> byte-identical output), so the interesting question is week-over-
// week churn, which R012 historical-pattern protection is built to suppress.
//
// Three optional dimensions layer on top of the base weekday-stability run:
//   • attrition — each week a fraction of drivers separate and are replaced by
//     fresh (cold-start, no-history) hires. Stability is then reported over
//     TENURED drivers (active in both weeks) so separations don't masquerade
//     as churn, alongside the roster-turnover rate itself.
//   • availability — each driver gets a FIXED set of available weekdays
//     (saved_availability + availability_enforcement). Structural constraint:
//     a driver can only ever work their available days.
//   • route-type (pairing) stability — for cells a driver works in two
//     consecutive weeks, how often the ROUTE TYPE (standard/xl) is the same.
//
// Run:  node --experimental-strip-types engine/sim/schedule-stability.mts
//   flags: --drivers=100 --weeks=12 --demand=0.85 --protection=high --seed=1
//          --xl=0.12          fraction of routes that are XL
//          --attrition=0.02   weekly separation rate (0 = fixed roster)
//          --availability     enable per-driver fixed available-day profiles
//   Pass --protection=off to see the un-stabilised baseline for comparison.

import { runEngine } from "../src/index.ts";
import { addDays, dayOfWeek } from "../src/dates.ts";
import type {
  DriverInput,
  EngineInput,
  HistoryShift,
  PatternStrength,
  ShiftInput,
  WeeklyAvailability,
} from "../src/types.ts";

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------
function arg(name: string, dflt: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : dflt;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const N_DRIVERS = parseInt(arg("drivers", "100"), 10);
const N_WEEKS = parseInt(arg("weeks", "12"), 10);
const DEMAND = parseFloat(arg("demand", "0.85")); // routes as a fraction of full 6-day capacity
const XL_FRAC = parseFloat(arg("xl", "0.12"));
const PROTECTION = arg("protection", "high") as PatternStrength;
const ATTRITION = parseFloat(arg("attrition", "0")); // weekly separation rate
const USE_AVAIL = flag("availability");
// Weekly per-driver probability of tweaking one available weekday (only when
// --availability is on). 0 = availability is frozen for a driver's tenure;
// a small value (e.g. 0.02) models "very little availability change".
const AVAIL_CHURN = parseFloat(arg("avail-churn", "0"));
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

// ---------------------------------------------------------------------------
// Driver factory. A monotonic counter keeps ids unique as hires replace
// separations, so history never collides across a recycled slot.
// ---------------------------------------------------------------------------
const OP_DAYS = [1, 2, 3, 4, 5, 6]; // Mon..Sat as offsets from the Sunday week start
const ALLDAY: WeeklyAvailability[string] = [{ start: "00:00", end: "23:59" }];

let nextId = 0;
function makeDriver(): DriverInput {
  const id = `d${String(++nextId).padStart(4, "0")}`;
  const partTime = rnd() < 0.18;

  let saved: WeeklyAvailability | null = null;
  if (USE_AVAIL) {
    // Full-timers available 5–6 weekdays, part-timers 3–4. Choose which of the
    // six operating weekdays are available; this profile is FIXED for the
    // driver's whole tenure (that is the structural stability floor).
    const nAvail = partTime ? randInt(3, 4) : randInt(5, 6);
    const pool = [...OP_DAYS];
    // shuffle (Fisher–Yates with the seeded rng)
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    saved = {};
    for (const off of pool.slice(0, nAvail)) saved[String(off % 7)] = ALLDAY;
  }

  return {
    driver_id: id,
    first_name: "Driver",
    last_name: id,
    status: "active",
    employment_type: partTime ? "part_time" : "full_time",
    hire_date: `20${randInt(18, 25)}-0${randInt(1, 9)}-1${randInt(0, 9)}`,
    license_expiration_date: "2030-01-01",
    xl_certified: rnd() < 0.35,
    attendance_score: Math.min(100, Math.round(70 + rnd() * 30 - (rnd() < 0.15 ? 30 : 0))),
    saved_availability: saved,
  };
}

let roster: DriverInput[] = Array.from({ length: N_DRIVERS }, makeDriver);

// Swap one of a driver's available weekdays for a currently-unavailable one,
// keeping the day COUNT the same (a driver whose availability "changes a
// little" — same load, different day). Returns true if a swap happened.
function tweakAvailability(d: DriverInput): boolean {
  const av = d.saved_availability;
  if (!av) return false;
  const on = OP_DAYS.filter((off) => av[String(off % 7)] !== undefined);
  const off = OP_DAYS.filter((o) => av[String(o % 7)] === undefined);
  if (on.length === 0 || off.length === 0) return false;
  const drop = on[Math.floor(rnd() * on.length)];
  const add = off[Math.floor(rnd() * off.length)];
  const next: WeeklyAvailability = { ...av };
  delete next[String(drop % 7)];
  next[String(add % 7)] = ALLDAY;
  d.saved_availability = next;
  return true;
}

// ---------------------------------------------------------------------------
// Weekly open shifts. Mon–Sat operating week (skip Sunday). Demand per day is
// a fraction of full driver capacity, with small week-to-week noise.
// ---------------------------------------------------------------------------
function buildWeekShifts(weekStart: string, size: number): ShiftInput[] {
  const shifts: ShiftInput[] = [];
  let seq = 0;
  for (const off of OP_DAYS) {
    const date = addDays(weekStart, off);
    const noise = 0.9 + rnd() * 0.2; // ±10%
    const routes = Math.max(1, Math.round(size * DEMAND * noise));
    for (let r = 0; r < routes; r++) {
      shifts.push({
        shift_id: `${date}-r${seq++}`,
        date,
        start_time: `${date}T09:00`,
        route_type: rnd() < XL_FRAC ? "xl" : "standard",
      });
    }
  }
  return shifts;
}

// ---------------------------------------------------------------------------
// Roll the rolling simulation forward
// ---------------------------------------------------------------------------
const WEEK0 = "2026-01-04"; // a Sunday
const HISTORY_WINDOW = 8;

let history: HistoryShift[] = [];
interface WeekSnap {
  active: Set<string>; // driver ids on the roster this week
  days: Map<string, Set<number>>; // id -> weekdays worked
  route: Map<string, Map<number, string>>; // id -> (dow -> route_type)
}
const snaps: WeekSnap[] = [];
const coverage: Array<{ total: number; filled: number }> = [];
let totalSeparations = 0;
let totalAvailTweaks = 0;

for (let w = 0; w < N_WEEKS; w++) {
  // Attrition: separate drivers, then backfill to hold roster size.
  if (w > 0 && ATTRITION > 0) {
    const kept: DriverInput[] = [];
    for (const d of roster) {
      if (rnd() < ATTRITION) totalSeparations++;
      else kept.push(d);
    }
    while (kept.length < N_DRIVERS) kept.push(makeDriver());
    roster = kept;
  }

  // Availability drift: a small fraction of drivers change one available day.
  if (w > 0 && USE_AVAIL && AVAIL_CHURN > 0) {
    for (const d of roster) {
      if (rnd() < AVAIL_CHURN && tweakAvailability(d)) totalAvailTweaks++;
    }
  }

  const weekStart = addDays(WEEK0, w * 7);
  const shifts = buildWeekShifts(weekStart, roster.length);

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
      availability_enforcement: USE_AVAIL,
    },
  };

  const res = runEngine(input);

  const days = new Map<string, Set<number>>();
  const route = new Map<string, Map<number, string>>();
  const newHistory: HistoryShift[] = [];
  const shiftMeta = new Map(shifts.map((s) => [s.shift_id, s]));
  for (const a of res.assigned_shifts) {
    const s = shiftMeta.get(a.shift_id)!;
    const dow = dayOfWeek(s.date);
    if (!days.has(a.driver_id)) days.set(a.driver_id, new Set());
    days.get(a.driver_id)!.add(dow);
    if (!route.has(a.driver_id)) route.set(a.driver_id, new Map());
    route.get(a.driver_id)!.set(dow, s.route_type);
    newHistory.push({ driver_id: a.driver_id, date: s.date, duration_hours: 10 });
  }

  snaps.push({ active: new Set(roster.map((d) => d.driver_id)), days, route });
  coverage.push({ total: res.summary_metrics.total_shifts, filled: res.summary_metrics.filled_shifts });

  history = [...history, ...newHistory].filter(
    (h) => (Date.parse(weekStart) - Date.parse(h.date)) / 86400000 <= HISTORY_WINDOW * 7,
  );
}

// ---------------------------------------------------------------------------
// Stability metrics — compare each week against the previous week, over
// drivers TENURED across both weeks (present on both rosters).
// ---------------------------------------------------------------------------
function jaccard(a: Set<number>, b: Set<number>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

let pairCount = 0;
let identical = 0;
let sameCount = 0;
let jSum = 0;
let daysChanged = 0;
let routeCells = 0;
let routeSame = 0;

for (let w = 1; w < snaps.length; w++) {
  const prev = snaps[w - 1];
  const cur = snaps[w];
  for (const id of cur.active) {
    if (!prev.active.has(id)) continue; // new hire — no prior week to compare
    const a = prev.days.get(id) ?? new Set<number>();
    const b = cur.days.get(id) ?? new Set<number>();
    pairCount++;
    const j = jaccard(a, b);
    jSum += j;
    if (j === 1) identical++;
    if (a.size === b.size) sameCount++;
    let diff = 0;
    for (const x of a) if (!b.has(x)) diff++;
    for (const x of b) if (!a.has(x)) diff++;
    daysChanged += diff;
    // route-type consistency on days worked in BOTH weeks
    const ra = prev.route.get(id);
    const rb = cur.route.get(id);
    if (ra && rb) {
      for (const dow of a) {
        if (b.has(dow)) {
          routeCells++;
          if (ra.get(dow) === rb.get(dow)) routeSame++;
        }
      }
    }
  }
}

// Routine adherence across the run: what fraction of a driver's worked days
// each week are "core" days (worked in ≥75% of the weeks they were active).
const activeWeeks = new Map<string, number>();
const dowWorked = new Map<string, number[]>();
for (const snap of snaps) {
  for (const id of snap.active) activeWeeks.set(id, (activeWeeks.get(id) ?? 0) + 1);
  for (const [id, days] of snap.days) {
    if (!dowWorked.has(id)) dowWorked.set(id, new Array(7).fill(0));
    for (const dow of days) dowWorked.get(id)![dow]++;
  }
}
let coreNum = 0;
let coreDen = 0;
for (const [id, counts] of dowWorked) {
  const wk = activeWeeks.get(id) ?? 1;
  const core = new Set<number>();
  counts.forEach((c, dow) => {
    if (c / wk >= 0.75) core.add(dow);
  });
  for (const snap of snaps) {
    const days = snap.days.get(id);
    if (!days) continue;
    for (const dow of days) {
      coreDen++;
      if (core.has(dow)) coreNum++;
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
  snaps.reduce((s, snap) => {
    let t = 0;
    for (const days of snap.days.values()) t += days.size;
    return s + t / snap.active.size;
  }, 0) / snaps.length;

console.log("═".repeat(66));
console.log(" RouteReady — schedule-stability simulation");
console.log("═".repeat(66));
console.log(` roster: ${N_DRIVERS} drivers   weeks: ${N_WEEKS}   demand: ${pct(DEMAND)} of capacity`);
console.log(` XL routes: ${pct(XL_FRAC)}   pattern-protection: ${PROTECTION}   seed: ${SEED}`);
console.log(
  ` attrition: ${ATTRITION > 0 ? pct(ATTRITION) + "/wk" : "off"}   availability constraints: ${
    USE_AVAIL ? "on" : "off"
  }${USE_AVAIL && AVAIL_CHURN > 0 ? `   avail-drift: ${pct(AVAIL_CHURN)}/driver/wk` : ""}`,
);
console.log("─".repeat(66));
console.log(` avg coverage           : ${pct(avgCov)}  (${avgFilled.toFixed(0)} routes/wk filled)`);
console.log(` avg days worked/driver : ${avgDaysPerDriver.toFixed(2)} / week`);
if (ATTRITION > 0) {
  const perWk = totalSeparations / (N_WEEKS - 1);
  console.log(
    ` roster turnover        : ${totalSeparations} separations over ${N_WEEKS - 1} wks ` +
      `(${perWk.toFixed(1)}/wk, ${pct(perWk / N_DRIVERS)} of roster/wk)`,
  );
}
if (USE_AVAIL && AVAIL_CHURN > 0) {
  console.log(
    ` availability changes   : ${totalAvailTweaks} over ${N_WEEKS - 1} wks ` +
      `(${(totalAvailTweaks / (N_WEEKS - 1)).toFixed(1)} drivers/wk changed a day)`,
  );
}
console.log("─".repeat(66));
console.log(" WEEK-OVER-WEEK STABILITY" + (ATTRITION > 0 ? " (tenured drivers, vs prior week)" : " (per driver, vs prior week)"));
console.log(`   identical weekday set : ${pct(identical / pairCount)}  ← schedule unchanged`);
console.log(`   same # of days worked : ${pct(sameCount / pairCount)}`);
console.log(`   mean day overlap (Jaccard): ${(jSum / pairCount).toFixed(3)}`);
console.log(`   avg weekdays changed  : ${(daysChanged / pairCount).toFixed(2)} per driver/week`);
console.log(`   same route type on repeated days: ${routeCells ? pct(routeSame / routeCells) : "n/a"}`);
console.log("─".repeat(66));
console.log(" ROUTINE ADHERENCE (across the whole run)");
console.log(
  `   worked days that are "core" days (worked in ≥75% of active weeks): ${pct(coreNum / coreDen)}`,
);
console.log("═".repeat(66));
