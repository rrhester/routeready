// Tests for the dashboard adapter (Supabase shapes -> EngineInput).

import { test } from "node:test";
import assert from "node:assert/strict";
import { planScheduleWeek } from "../src/adapters/dashboard.ts";
import type { PlanPayload } from "../src/adapters/dashboard.ts";

function basePayload(over: Partial<PlanPayload> = {}): PlanPayload {
  return {
    schedule_week_start: "2026-05-24",
    max_days: 5,
    drivers: [],
    shifts: [],
    pto: [],
    ...over,
  };
}

const d = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  full_name: `First ${id}`,
  status: "active",
  hire_date: "2021-01-01",
  dl_expires_on: "2030-01-01",
  dot_certified: true,
  xl_certified: true,
  available_dows: null,
  preferred_dows: null,
  ...over,
});

const s = (id: string, date: string, over: Record<string, unknown> = {}) => ({
  id,
  date,
  starts_at: `${date}T09:00:00`,
  ends_at: `${date}T19:00:00`,
  route_type: "standard" as const,
  ...over,
});

test("adapter assigns an open shift to an eligible driver", () => {
  const r = planScheduleWeek(
    basePayload({
      drivers: [d("d1")],
      shifts: [s("s1", "2026-05-25")],
    }),
  );
  assert.equal(r.assigned_shifts.length, 1);
  assert.equal(r.assigned_shifts[0].driver_id, "d1");
});

test("adapter expands PTO and blocks that date", () => {
  const r = planScheduleWeek(
    basePayload({
      drivers: [d("d1")],
      shifts: [s("s1", "2026-05-25")],
      pto: [{ driver_id: "d1", date: "2026-05-25" }],
    }),
  );
  assert.equal(r.assigned_shifts.length, 0);
  assert.ok(
    r.uncovered_shifts[0].top_block_reasons.some((b) => b.rule === "R005"),
  );
});

test("adapter routes XL shifts to xl-certified drivers", () => {
  const r = planScheduleWeek(
    basePayload({
      drivers: [
        d("plain", { xl_certified: false }),
        d("xl", { xl_certified: true }),
      ],
      shifts: [s("s1", "2026-05-25", { route_type: "xl" })],
    }),
  );
  assert.equal(r.assigned_shifts[0]?.driver_id, "xl");
});

test("adapter filters out non-active/onboarding drivers", () => {
  const r = planScheduleWeek(
    basePayload({
      drivers: [d("gone", { status: "terminated" })],
      shifts: [s("s1", "2026-05-25")],
    }),
  );
  assert.equal(r.assigned_shifts.length, 0);
});

test("adapter keeps a locked pre-assignment (fill_empty_only)", () => {
  const r = planScheduleWeek(
    basePayload({
      drivers: [d("d1"), d("d2")],
      shifts: [
        s("locked", "2026-05-25", {
          assigned_driver_id: "d1",
          is_locked: true,
        }),
        s("open", "2026-05-26"),
      ],
    }),
  );
  assert.equal(
    r.assigned_shifts.find((a) => a.shift_id === "locked")?.driver_id,
    "d1",
  );
});

test("adapter availability blocks an unavailable day-of-week", () => {
  // 2026-05-25 is a Monday (dow 1); driver only works Tue-Fri.
  const r = planScheduleWeek(
    basePayload({
      rules: { availability: true },
      drivers: [d("d1", { available_dows: [2, 3, 4, 5] })],
      shifts: [s("s1", "2026-05-25")],
    }),
  );
  assert.equal(r.assigned_shifts.length, 0);
  assert.ok(
    r.uncovered_shifts[0].top_block_reasons.some((b) => b.rule === "R006"),
  );
});

test("adapter include_onboarding=false blocks onboarding drivers", () => {
  const base = {
    drivers: [d("ob", { status: "onboarding" })],
    shifts: [s("s1", "2026-05-25")],
  };
  assert.equal(
    planScheduleWeek(basePayload(base)).assigned_shifts.length,
    1,
    "onboarding driver schedulable by default",
  );
  assert.equal(
    planScheduleWeek(
      basePayload({ ...base, rules: { include_onboarding: false } }),
    ).assigned_shifts.length,
    0,
    "onboarding driver blocked when include_onboarding is off",
  );
});

test("adapter always blocks a same-day double assignment", () => {
  // A driver works at most one shift per day — not operator-configurable.
  const base = {
    drivers: [d("d1")],
    shifts: [
      s("a", "2026-05-25", { starts_at: "2026-05-25T06:00:00", ends_at: "2026-05-25T10:00:00" }),
      s("b", "2026-05-25", { starts_at: "2026-05-25T14:00:00", ends_at: "2026-05-25T18:00:00" }),
    ],
  };
  assert.equal(planScheduleWeek(basePayload(base)).assigned_shifts.length, 1);
  assert.equal(
    planScheduleWeek(basePayload({ ...base, rules: { min_rest: false } }))
      .assigned_shifts.length,
    1,
  );
});

test("adapter min_rest blocks a too-close next-day shift", () => {
  const base = {
    drivers: [d("d1")],
    shifts: [
      s("a", "2026-05-25", { starts_at: "2026-05-25T12:00:00", ends_at: "2026-05-25T23:00:00" }),
      s("b", "2026-05-26", { starts_at: "2026-05-26T05:00:00", ends_at: "2026-05-26T15:00:00" }),
    ],
  };
  // 6h gap < 10h: with min_rest on (default) only one shift fits.
  assert.equal(planScheduleWeek(basePayload(base)).assigned_shifts.length, 1);
  assert.equal(
    planScheduleWeek(basePayload({ ...base, rules: { min_rest: false } }))
      .assigned_shifts.length,
    2,
  );
});

test("adapter spread_evenly toggles rotational vs sequential fill", () => {
  const base = {
    drivers: [d("a-driver"), d("b-driver")],
    shifts: [
      s("s1", "2026-05-25"),
      s("s2", "2026-05-26"),
      s("s3", "2026-05-27"),
      s("s4", "2026-05-28"),
    ],
  };
  // Default (rotational): work spreads evenly, 2 shifts each.
  const even = planScheduleWeek(
    basePayload({
      ...base,
      max_days: 7,
      rules: { woc: false },
    }),
  );
  const evenCounts = even.driver_totals
    .map((t) => t.assigned_shift_ids.length)
    .sort();
  assert.deepEqual(evenCounts, [2, 2]);

  // Sequential: the first driver is filled to capacity before the next.
  const seq = planScheduleWeek(
    basePayload({
      ...base,
      max_days: 7,
      rules: { woc: false, spread_evenly: false },
    }),
  );
  const seqCounts = seq.driver_totals
    .map((t) => t.assigned_shift_ids.length)
    .sort();
  assert.deepEqual(seqCounts, [0, 4]);
});

test("adapter run is idempotent", () => {
  const mk = () =>
    planScheduleWeek(
      basePayload({
        drivers: [d("d1"), d("d2"), d("d3")],
        shifts: [
          s("s1", "2026-05-25"),
          s("s2", "2026-05-26"),
          s("s3", "2026-05-27"),
        ],
      }),
    );
  assert.equal(JSON.stringify(mk().assigned_shifts), JSON.stringify(mk().assigned_shifts));
});

test("adapter lets the pto_default_hours setting govern PTO hours", () => {
  // One PTO day + an 8h default: the record must carry NO hours value so
  // the setting applies (10 was previously stamped on every record).
  const r = planScheduleWeek(
    basePayload({
      drivers: [d("d1")],
      shifts: [s("s1", "2026-05-26")],
      pto: [{ driver_id: "d1", date: "2026-05-25" }],
      rules: { pto_default_hours: 8 },
    }),
  );
  const t = r.driver_totals.find((x) => x.driver_id === "d1");
  assert.equal(t?.pto_hours, 8);
});

test("adapter maps employment_type variants for full_time_priority", () => {
  // Same profile except employment type; full_time_priority must hand the
  // single shift to the full-time driver even though "pt" sorts first
  // alphabetically. "pt"/"part-time" variants normalize to part_time.
  const r = planScheduleWeek(
    basePayload({
      drivers: [
        d("a-part", { employment_type: "pt" }),
        d("b-full", { employment_type: "Full Time" }),
      ],
      shifts: [s("s1", "2026-05-25")],
      rules: { scheduling_method: "full_time_priority" },
    }),
  );
  assert.equal(r.assigned_shifts[0]?.driver_id, "b-full");
});

test("adapter warns on missing hire dates under seniority ordering", () => {
  const mk = (method: "seniority" | "fair_rotation") =>
    planScheduleWeek(
      basePayload({
        drivers: [d("d1", { hire_date: null }), d("d2")],
        shifts: [s("s1", "2026-05-25")],
        rules: { scheduling_method: method },
      }),
    );
  const warned = mk("seniority").warnings.filter(
    (w) => w.type === "hire_date_missing",
  );
  assert.equal(warned.length, 1);
  assert.equal(warned[0].driver_id, "d1");
  // Only relevant when seniority ordering is in play.
  const silent = mk("fair_rotation").warnings.filter(
    (w) => w.type === "hire_date_missing",
  );
  assert.equal(silent.length, 0);
});

test("adapter converts zoned timestamps to DSP-local wall clock", () => {
  // 2026-05-25T12:30:00Z is 07:30 in Chicago. With the conversion, two
  // Chicago shifts 21:00→(next day)07:00 read as a 10h wall-clock gap
  // and pass a 10h min-rest; fed raw UTC they'd read identically (no
  // DST in May) — so instead prove the conversion via the DST fall-back
  // night below, and here just prove zone-less inputs pass through.
  const r = planScheduleWeek(
    basePayload({
      dsp_timezone: "America/Chicago",
      drivers: [d("d1")],
      shifts: [s("s1", "2026-05-25", {
        starts_at: "2026-05-25T12:30:00Z",
        ends_at: "2026-05-25T22:30:00Z",
      })],
    }),
  );
  assert.equal(r.assigned_shifts.length, 1);
});

test("adapter rest math is wall-clock across the DST fall-back", () => {
  // Fall-back night (America/Chicago, 2026-11-01 02:00 CDT → 01:00 CST):
  // shift A ends 00:30 CDT (05:30Z), shift B starts 10:00 CST (16:00Z).
  // Elapsed time is 10.5h (would PASS a 10h min-rest on raw UTC), but the
  // WALL CLOCK — how the operator and driver read the schedule — shows
  // only 9.5h, so with the timezone conversion the engine must refuse.
  // (The server-side gate (0500) checks absolute time, so the regulatory
  // floor is still enforced independently.)
  const mk = (tz: string | null) =>
    planScheduleWeek(
      basePayload({
        schedule_week_start: "2026-11-01", // a Sunday
        dsp_timezone: tz,
        drivers: [d("d1")],
        rules: { min_rest_hours: 10, same_day_multi_shift: "allow" },
        shifts: [
          s("sa", "2026-11-01", {
            starts_at: "2026-10-31T19:30:00-05:00", // 7:30pm CDT Sat... shift runs into Sun
            ends_at:   "2026-11-01T05:30:00Z",      // 00:30 CDT Sunday
          }),
          s("sb", "2026-11-01", {
            starts_at: "2026-11-01T16:00:00Z",      // 10:00 CST Sunday
            ends_at:   "2026-11-02T02:00:00Z",      // 20:00 CST Sunday
          }),
        ],
      }),
    );
  const withTz = mk("America/Chicago");
  // Wall-clock gap 00:30 → 10:00 is 9.5h < 10h — one shift must be refused.
  assert.equal(withTz.assigned_shifts.length, 1,
    "wall-clock rest must block the second same-night shift");
  // Raw UTC (no tz): elapsed 10.5h ≥ 10h — both shifts assign.
  const withoutTz = mk(null);
  assert.equal(withoutTz.assigned_shifts.length, 2,
    "without tz the naive-UTC gap is 10.5h and both assign");
});
