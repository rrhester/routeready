// Hard-rule + run-mode fixture tests (R001-R011).

import { test } from "node:test";
import assert from "node:assert/strict";
import { runEngine } from "../src/index.ts";
import { driver, input, shift } from "./helpers.ts";

function uncoveredRule(result: ReturnType<typeof runEngine>, shiftId: string) {
  const u = result.uncovered_shifts.find((s) => s.shift_id === shiftId);
  assert.ok(u, `expected ${shiftId} uncovered`);
  return u.top_block_reasons.map((r) => r.rule);
}

test("R002 — inactive driver is not auto-filled", () => {
  const r = runEngine(
    input({
      shifts: [shift({ shift_id: "s1" })],
      drivers: [driver({ driver_id: "d1", status: "inactive" })],
    }),
  );
  assert.equal(r.summary_metrics.filled_shifts, 0);
  assert.ok(uncoveredRule(r, "s1").includes("R002"));
});

test("R002 — onboarding eligible only when configured", () => {
  const base = {
    shifts: [shift({ shift_id: "s1" })],
    drivers: [driver({ driver_id: "d1", status: "onboarding" })],
  };
  assert.equal(runEngine(input(base)).summary_metrics.filled_shifts, 0);
  assert.equal(
    runEngine(
      input({ ...base, settings: { eligible_driver_status: "active_and_onboarding" } }),
    ).summary_metrics.filled_shifts,
    1,
  );
});

test("R003 — expired license blocks, expiry on shift date is valid", () => {
  const expired = runEngine(
    input({
      shifts: [shift({ shift_id: "s1", date: "2026-05-25" })],
      drivers: [
        driver({ driver_id: "d1", license_expiration_date: "2026-05-24" }),
      ],
    }),
  );
  assert.ok(uncoveredRule(expired, "s1").includes("R003"));

  const onDate = runEngine(
    input({
      shifts: [shift({ shift_id: "s1", date: "2026-05-25" })],
      drivers: [
        driver({ driver_id: "d1", license_expiration_date: "2026-05-25" }),
      ],
    }),
  );
  assert.equal(onDate.summary_metrics.filled_shifts, 1);
});

test("R003 — missing license blocks and warns", () => {
  const r = runEngine(
    input({
      shifts: [shift({ shift_id: "s1" })],
      drivers: [driver({ driver_id: "d1", license_expiration_date: null })],
    }),
  );
  assert.equal(r.summary_metrics.filled_shifts, 0);
  assert.ok(
    r.warnings.some((w) => w.type === "license_expiration_missing"),
  );
});

test("R004 — XL route requires xl certification", () => {
  const r = runEngine(
    input({
      shifts: [shift({ shift_id: "s1", route_type: "XL" })],
      drivers: [
        driver({ driver_id: "d1", xl_certified: false }),
        driver({ driver_id: "d2", xl_certified: true }),
      ],
    }),
  );
  assert.equal(r.assigned_shifts[0].driver_id, "d2");
});

test("R005 — PTO on the shift date blocks the driver", () => {
  const r = runEngine(
    input({
      shifts: [shift({ shift_id: "s1", date: "2026-05-25" })],
      drivers: [
        driver({ driver_id: "d1", pto_records: [{ date: "2026-05-25" }] }),
      ],
    }),
  );
  assert.ok(uncoveredRule(r, "s1").includes("R005"));
});

test("R007 — max days caps a driver's unique scheduled dates", () => {
  const dates = [
    "2026-05-24",
    "2026-05-25",
    "2026-05-26",
    "2026-05-27",
    "2026-05-28",
    "2026-05-29",
    "2026-05-30",
  ];
  const r = runEngine(
    input({
      shifts: dates.map((d, i) => shift({ shift_id: `s${i}`, date: d })),
      drivers: [driver({ driver_id: "d1" })],
      settings: { weekly_hour_cap_enforcement: false, max_days: 6 },
    }),
  );
  assert.equal(r.summary_metrics.filled_shifts, 6);
  assert.equal(r.summary_metrics.uncovered_shifts, 1);
});

test("R008 — weekly hour cap blocks once projected hours exceed cap", () => {
  const dates = [
    "2026-05-24",
    "2026-05-25",
    "2026-05-26",
    "2026-05-27",
    "2026-05-28",
  ];
  const r = runEngine(
    input({
      shifts: dates.map((d, i) => shift({ shift_id: `s${i}`, date: d })),
      drivers: [driver({ driver_id: "d1" })],
      settings: { weekly_hour_cap: 40, max_days_enforcement: false },
    }),
  );
  assert.equal(r.summary_metrics.filled_shifts, 4);
});

test("R008 — weekly cap counts net (post-lunch) on-the-clock hours", () => {
  // Five 10h shifts, cap 48. Gross would be 50h (only 4 fit); net of a
  // 30-min lunch per shift it is 47.5h, so all five fit.
  const dates = [
    "2026-05-24", "2026-05-25", "2026-05-26", "2026-05-27", "2026-05-28",
  ];
  const r = runEngine(
    input({
      shifts: dates.map((d, i) => shift({
        shift_id: `s${i}`,
        date: d,
        start_time: `${d}T09:00`,
        end_time: `${d}T19:00`,
      })),
      drivers: [driver({ driver_id: "d1" })],
      settings: {
        weekly_hour_cap: 48,
        max_days_enforcement: false,
        woc_enforcement: false,
      },
    }),
  );
  assert.equal(r.summary_metrics.filled_shifts, 5);
});

test("R009 — minimum rest blocks a too-close second shift", () => {
  const r = runEngine(
    input({
      shifts: [
        shift({
          shift_id: "a",
          date: "2026-05-25",
          start_time: "2026-05-25T09:00",
          end_time: "2026-05-25T19:00",
        }),
        shift({
          shift_id: "b",
          date: "2026-05-26",
          start_time: "2026-05-26T03:00",
          end_time: "2026-05-26T13:00",
        }),
      ],
      drivers: [driver({ driver_id: "d1" })],
    }),
  );
  assert.equal(r.summary_metrics.filled_shifts, 1);
  assert.ok(uncoveredRule(r, "b").includes("R009"));
});

test("R010 — same-day double assignment is blocked by default", () => {
  const r = runEngine(
    input({
      shifts: [
        shift({ shift_id: "a", date: "2026-05-25", start_time: "2026-05-25T06:00" }),
        shift({ shift_id: "b", date: "2026-05-25", start_time: "2026-05-25T20:00" }),
      ],
      drivers: [driver({ driver_id: "d1" })],
    }),
  );
  assert.equal(r.summary_metrics.filled_shifts, 1);
});

test("R011 — blackout date shift is closed, not uncovered", () => {
  const r = runEngine(
    input({
      shifts: [shift({ shift_id: "s1", date: "2026-05-25" })],
      drivers: [driver({ driver_id: "d1" })],
      dsp: { dsp_blackout_dates: ["2026-05-25"] },
    }),
  );
  assert.equal(r.summary_metrics.closed_shifts, 1);
  assert.equal(r.summary_metrics.uncovered_shifts, 0);
  assert.equal(r.summary_metrics.filled_shifts, 0);
});

test("R001 — fill_empty_only preserves an existing assignment", () => {
  const r = runEngine(
    input({
      shifts: [
        shift({ shift_id: "s1", assigned_driver_id: "d1" }),
        shift({ shift_id: "s2", date: "2026-05-26" }),
      ],
      drivers: [driver({ driver_id: "d1" }), driver({ driver_id: "d2" })],
    }),
  );
  const s1 = r.assigned_shifts.find((a) => a.shift_id === "s1");
  assert.equal(s1?.driver_id, "d1");
  assert.equal(s1?.source, "preserved");
});

test("R001 — rebuild_unlocked clears unlocked, keeps locked", () => {
  const r = runEngine(
    input({
      shifts: [
        shift({ shift_id: "locked", assigned_driver_id: "d1", is_locked: true }),
        shift({
          shift_id: "loose",
          date: "2026-05-26",
          assigned_driver_id: "d1",
        }),
      ],
      drivers: [driver({ driver_id: "d1" }), driver({ driver_id: "d2" })],
      settings: { run_mode: "rebuild_unlocked" },
    }),
  );
  assert.equal(
    r.assigned_shifts.find((a) => a.shift_id === "locked")?.source,
    "locked",
  );
  // The unlocked shift was cleared and re-filled by auto-fill.
  assert.equal(
    r.assigned_shifts.find((a) => a.shift_id === "loose")?.source,
    "auto_fill",
  );
});

test("locked assignment violating a hard rule surfaces as a violation", () => {
  const r = runEngine(
    input({
      shifts: [
        shift({
          shift_id: "s1",
          date: "2026-05-25",
          assigned_driver_id: "d1",
          is_locked: true,
        }),
      ],
      drivers: [
        driver({ driver_id: "d1", pto_records: [{ date: "2026-05-25" }] }),
      ],
    }),
  );
  const v = r.violations.find((x) => x.rule === "R005");
  assert.ok(v);
  assert.equal(v.severity, "critical");
});

test("override_ack_by downgrades a locked violation to acknowledged", () => {
  const r = runEngine(
    input({
      shifts: [
        shift({
          shift_id: "s1",
          date: "2026-05-25",
          assigned_driver_id: "d1",
          is_locked: true,
          override_ack_by: "mgr-9",
        }),
      ],
      drivers: [
        driver({ driver_id: "d1", pto_records: [{ date: "2026-05-25" }] }),
      ],
    }),
  );
  assert.equal(
    r.violations.find((x) => x.rule === "R005")?.severity,
    "acknowledged",
  );
});

// --- R019 (WOC) + DOT-first route fill order -------------------------------

test("R019 — WOC blocks a 7th consecutive working day", () => {
  // Seven standard shifts, one per day across the schedule week. With only
  // WOC enforced, exactly six get filled and the 7th is blocked.
  const shifts = [];
  for (let i = 0; i < 7; i++) {
    const date = `2026-05-${String(24 + i).padStart(2, "0")}`;
    shifts.push(shift({ shift_id: `s${i}`, date }));
  }
  const r = runEngine(
    input({
      shifts,
      drivers: [driver({ driver_id: "d1" })],
      settings: {
        max_days_enforcement: false,
        weekly_hour_cap_enforcement: false,
        woc_enforcement: true,
      },
    }),
  );
  assert.equal(r.summary_metrics.filled_shifts, 6);
  assert.equal(r.summary_metrics.uncovered_shifts, 1);
  const blocked = r.uncovered_shifts[0];
  assert.ok(blocked.top_block_reasons.some((b) => b.rule === "R019"));
});

test("R019 — six consecutive working days are allowed", () => {
  const shifts = [];
  for (let i = 0; i < 6; i++) {
    const date = `2026-05-${String(24 + i).padStart(2, "0")}`;
    shifts.push(shift({ shift_id: `s${i}`, date }));
  }
  const r = runEngine(
    input({
      shifts,
      drivers: [driver({ driver_id: "d1" })],
      settings: {
        max_days_enforcement: false,
        weekly_hour_cap_enforcement: false,
        woc_enforcement: true,
      },
    }),
  );
  assert.equal(r.summary_metrics.filled_shifts, 6);
});

test("R019 — WOC honors a DSP-set max consecutive days", () => {
  // Five consecutive shifts, limit set to 4: four fill, the 5th blocks.
  const shifts = [];
  for (let i = 0; i < 5; i++) {
    const date = `2026-05-${String(24 + i).padStart(2, "0")}`;
    shifts.push(shift({ shift_id: `s${i}`, date }));
  }
  const r = runEngine(
    input({
      shifts,
      drivers: [driver({ driver_id: "d1" })],
      settings: {
        max_days_enforcement: false,
        weekly_hour_cap_enforcement: false,
        woc_enforcement: true,
        woc_max_consecutive_days: 4,
      },
    }),
  );
  assert.equal(r.summary_metrics.filled_shifts, 4);
  assert.equal(r.summary_metrics.uncovered_shifts, 1);
  assert.ok(
    r.uncovered_shifts[0].top_block_reasons.some((b) => b.rule === "R019"),
  );
});

test("R019 — disabled WOC allows a 7th consecutive day", () => {
  const shifts = [];
  for (let i = 0; i < 7; i++) {
    const date = `2026-05-${String(24 + i).padStart(2, "0")}`;
    shifts.push(shift({ shift_id: `s${i}`, date }));
  }
  const r = runEngine(
    input({
      shifts,
      drivers: [driver({ driver_id: "d1" })],
      settings: {
        max_days_enforcement: false,
        weekly_hour_cap_enforcement: false,
        woc_enforcement: false,
      },
    }),
  );
  assert.equal(r.summary_metrics.filled_shifts, 7);
});

test("DOT-first — a DOT route is filled before a standard route", () => {
  // One driver, two shifts on the same date: a DOT (step_van) route and a
  // standard route. Same-day rule means the driver can take only one — the
  // two-phase fill order must spend them on the DOT route.
  const r = runEngine(
    input({
      shifts: [
        shift({ shift_id: "s_std", date: "2026-05-25", route_type: "standard" }),
        shift({ shift_id: "s_dot", date: "2026-05-25", route_type: "step_van" }),
      ],
      drivers: [driver({ driver_id: "d1", dot_certified: true })],
    }),
  );
  const dot = r.assigned_shifts.find((a) => a.shift_id === "s_dot");
  assert.ok(dot, "DOT route should be filled first");
  assert.equal(dot.driver_id, "d1");
  assert.ok(
    r.uncovered_shifts.some((u) => u.shift_id === "s_std"),
    "standard route should be left uncovered",
  );
});

// --- R020 — baseline preferred-availability-only mode ----------------------

test("R020 — baseline mode schedules only on preferred days", () => {
  // d_pref prefers Mondays; d_none has no preferred availability.
  const r = runEngine(
    input({
      shifts: [
        shift({ shift_id: "mon", date: "2026-05-25" }), // Monday
        shift({ shift_id: "tue", date: "2026-05-26" }), // Tuesday
      ],
      drivers: [
        driver({
          driver_id: "d_pref",
          preferred_availability: { "1": [{ start: "00:00", end: "48:00" }] },
        }),
        driver({ driver_id: "d_none" }),
      ],
      settings: { preferred_availability_required: true },
    }),
  );
  // d_pref takes Monday; Tuesday + d_none get nothing.
  assert.equal(
    r.assigned_shifts.find((a) => a.shift_id === "mon")?.driver_id,
    "d_pref",
  );
  assert.ok(r.uncovered_shifts.some((u) => u.shift_id === "tue"));
  assert.equal(r.summary_metrics.filled_shifts, 1);
});

test("R020 — driver with no preferred availability is not scheduled", () => {
  const r = runEngine(
    input({
      shifts: [shift({ shift_id: "s1", date: "2026-05-25" })],
      drivers: [driver({ driver_id: "d1" })],
      settings: { preferred_availability_required: true },
    }),
  );
  assert.equal(r.summary_metrics.filled_shifts, 0);
  assert.ok(uncoveredRule(r, "s1").includes("R020"));
});

// --- R006 availability-required (Auto Fill Availability mode) ---------------

test("R006 — availability-required blocks a driver with no availability", () => {
  const r = runEngine(
    input({
      shifts: [shift({ shift_id: "s1", date: "2026-05-25" })],
      drivers: [driver({ driver_id: "d1" })],
      settings: { availability_enforcement: true, availability_required: true },
    }),
  );
  assert.equal(r.summary_metrics.filled_shifts, 0);
  assert.ok(uncoveredRule(r, "s1").includes("R006"));
});

test("R006 — availability mode schedules within full availability", () => {
  const r = runEngine(
    input({
      shifts: [
        shift({ shift_id: "mon", date: "2026-05-25" }), // Monday
        shift({ shift_id: "tue", date: "2026-05-26" }), // Tuesday
      ],
      drivers: [
        driver({
          driver_id: "d1",
          saved_availability: { "1": [{ start: "00:00", end: "48:00" }] },
        }),
      ],
      settings: { availability_enforcement: true, availability_required: true },
    }),
  );
  assert.equal(
    r.assigned_shifts.find((a) => a.shift_id === "mon")?.driver_id,
    "d1",
  );
  assert.ok(r.uncovered_shifts.some((u) => u.shift_id === "tue"));
});

// --- Max allowable days per week (0-7) -------------------------------------

test("R007 — max_days caps a driver inside the preferred boundary", () => {
  const shifts = [];
  for (let i = 0; i < 7; i++) {
    const date = `2026-05-${String(24 + i).padStart(2, "0")}`;
    shifts.push(shift({ shift_id: `s${i}`, date }));
  }
  const allDays: Record<string, { start: string; end: string }[]> = {};
  for (let d = 0; d < 7; d++) allDays[String(d)] = [{ start: "00:00", end: "48:00" }];
  const r = runEngine(
    input({
      shifts,
      drivers: [driver({ driver_id: "d1", preferred_availability: allDays })],
      settings: {
        preferred_availability_required: true,
        max_days_enforcement: true,
        max_days: 3,
      },
    }),
  );
  assert.equal(r.summary_metrics.filled_shifts, 3);
});

test("R007 — max_days of 0 schedules nobody", () => {
  const r = runEngine(
    input({
      shifts: [shift({ shift_id: "s1", date: "2026-05-25" })],
      drivers: [driver({ driver_id: "d1" })],
      settings: { max_days_enforcement: true, max_days: 0 },
    }),
  );
  assert.equal(r.summary_metrics.filled_shifts, 0);
  assert.ok(uncoveredRule(r, "s1").includes("R007"));
});

// --- Rotational batch size -------------------------------------------------

test("rotation_batch_size controls shifts per driver before rotating", () => {
  // Four shifts on four consecutive dates, two equally-eligible drivers.
  const mk = (batch: number) =>
    runEngine(
      input({
        shifts: [
          shift({ shift_id: "s1", date: "2026-05-24" }),
          shift({ shift_id: "s2", date: "2026-05-25" }),
          shift({ shift_id: "s3", date: "2026-05-26" }),
          shift({ shift_id: "s4", date: "2026-05-27" }),
        ],
        drivers: [driver({ driver_id: "d1" }), driver({ driver_id: "d2" })],
        settings: {
          assignment_mode: "rotational_fill",
          rotation_batch_size: batch,
          max_days_enforcement: false,
          weekly_hour_cap_enforcement: false,
          woc_enforcement: false,
          // Soft scoring off so the optimizer doesn't reshuffle — keeps
          // the test focused on the rotation batch behavior.
          consecutive_working_days: false,
          historical_pattern_protection: "off",
          attendance_scheduling: false,
          preferred_availability_priority: false,
        },
      }),
    );
  const datesOf = (r: ReturnType<typeof runEngine>, id: string) =>
    r.driver_totals.find((t) => t.driver_id === id)?.assigned_dates ?? [];

  // Batch 1 — strict alternation: d1 gets dates 1 & 3.
  const b1 = mk(1);
  assert.deepEqual(datesOf(b1, "d1"), ["2026-05-24", "2026-05-26"]);

  // Batch 2 — d1 claims the first two before d2's turn.
  const b2 = mk(2);
  assert.deepEqual(datesOf(b2, "d1"), ["2026-05-24", "2026-05-25"]);
  assert.deepEqual(datesOf(b2, "d2"), ["2026-05-26", "2026-05-27"]);
});

// --- Preferred Availability Enhancement ------------------------------------

test("Preferred Availability Enhancement swaps both drivers onto preferred days", () => {
  const mon: Record<string, { start: string; end: string }[]> = {
    "1": [{ start: "00:00", end: "48:00" }],
  };
  const tue: Record<string, { start: string; end: string }[]> = {
    "2": [{ start: "00:00", end: "48:00" }],
  };
  const base = {
    shifts: [
      shift({ shift_id: "sMon", date: "2026-05-25" }), // Monday
      shift({ shift_id: "sTue", date: "2026-05-26" }), // Tuesday
    ],
    drivers: [
      driver({ driver_id: "dA", preferred_availability: tue }),
      driver({ driver_id: "dB", preferred_availability: mon }),
    ],
  };
  const baseSettings = {
    preferred_availability_priority: false,
    consecutive_working_days: false,
    historical_pattern_protection: "off" as const,
    attendance_scheduling: false,
    max_days_enforcement: false,
    weekly_hour_cap_enforcement: false,
    woc_enforcement: false,
  };

  // Without the enhancement the main pass puts each driver on the wrong day.
  const off = runEngine(
    input({ ...base, settings: { ...baseSettings, preferred_enhancement: false } }),
  );
  assert.equal(off.assigned_shifts.find((a) => a.shift_id === "sMon")?.driver_id, "dA");
  assert.equal(off.assigned_shifts.find((a) => a.shift_id === "sTue")?.driver_id, "dB");

  // With it on, the post-pass swaps them both onto their preferred day.
  const on = runEngine(
    input({ ...base, settings: { ...baseSettings, preferred_enhancement: true } }),
  );
  assert.equal(on.assigned_shifts.find((a) => a.shift_id === "sTue")?.driver_id, "dA");
  assert.equal(on.assigned_shifts.find((a) => a.shift_id === "sMon")?.driver_id, "dB");
});

test("Driver Affinity Enhancement swaps drivers onto favored weekdays", () => {
  const base = {
    shifts: [
      shift({ shift_id: "sMon", date: "2026-05-25" }), // Monday  (dow 1)
      shift({ shift_id: "sTue", date: "2026-05-26" }), // Tuesday (dow 2)
    ],
    drivers: [
      // dA favors Tuesday, dB favors Monday — the opposite of the
      // natural fill order.
      driver({ driver_id: "dA", weekday_affinity: [0, 0, 100, 0, 0, 0, 0] }),
      driver({ driver_id: "dB", weekday_affinity: [0, 100, 0, 0, 0, 0, 0] }),
    ],
  };
  const baseSettings = {
    consecutive_working_days: false,
    max_days_enforcement: false,
    weekly_hour_cap_enforcement: false,
    woc_enforcement: false,
  };

  // Without the enhancement the natural fill puts each driver on the
  // wrong weekday.
  const off = runEngine(
    input({ ...base, settings: { ...baseSettings } }),
  );
  assert.equal(off.assigned_shifts.find((a) => a.shift_id === "sMon")?.driver_id, "dA");
  assert.equal(off.assigned_shifts.find((a) => a.shift_id === "sTue")?.driver_id, "dB");

  // With it on, the final post-pass swaps them onto their favored day.
  const on = runEngine(
    input({ ...base, settings: { ...baseSettings, affinity_enhancement: true } }),
  );
  assert.equal(on.assigned_shifts.find((a) => a.shift_id === "sTue")?.driver_id, "dA");
  assert.equal(on.assigned_shifts.find((a) => a.shift_id === "sMon")?.driver_id, "dB");
});

test("Fifth-Day Fill layers an extra day for an opted-in driver", () => {
  const dates = [
    "2026-05-24", "2026-05-25", "2026-05-26", "2026-05-27", "2026-05-28",
  ];
  const shifts = dates.map((d, i) => shift({ shift_id: `s${i}`, date: d }));

  // max_days = 4 caps the driver at four days.
  const off = runEngine(
    input({
      shifts,
      drivers: [driver({ driver_id: "d1", fifth_day_ok: true })],
      settings: { max_days: 4 },
    }),
  );
  assert.equal(off.summary_metrics.filled_shifts, 4);

  // With the 5th-day pass on, the opted-in driver picks up the 5th.
  const on = runEngine(
    input({
      shifts,
      drivers: [driver({ driver_id: "d1", fifth_day_ok: true })],
      settings: { max_days: 4, fifth_day_fill: true },
    }),
  );
  assert.equal(on.summary_metrics.filled_shifts, 5);

  // A driver who did NOT opt in stays capped at four.
  const noOptIn = runEngine(
    input({
      shifts,
      drivers: [driver({ driver_id: "d2" })],
      settings: { max_days: 4, fifth_day_fill: true },
    }),
  );
  assert.equal(noOptIn.summary_metrics.filled_shifts, 4);
});

test("Fifth-Day Fill — availability override places a 5th day off-availability", () => {
  const dates = [
    "2026-05-24", "2026-05-25", "2026-05-26", "2026-05-27", "2026-05-28",
  ];
  const shifts = dates.map((d, i) => shift({ shift_id: `s${i}`, date: d }));
  // Driver available Sun-Wed only; the 5th shift falls on Thursday.
  const avail = {
    "0": [{ start: "00:00", end: "48:00" }],
    "1": [{ start: "00:00", end: "48:00" }],
    "2": [{ start: "00:00", end: "48:00" }],
    "3": [{ start: "00:00", end: "48:00" }],
  };
  const mk = () => driver({
    driver_id: "d1", fifth_day_ok: true, saved_availability: avail,
  });

  // Override off: the Thursday shift is off-availability, stays open.
  const off = runEngine(
    input({
      shifts,
      drivers: [mk()],
      settings: { max_days: 4, fifth_day_fill: true, availability_enforcement: true },
    }),
  );
  assert.equal(off.summary_metrics.filled_shifts, 4);

  // Override on: the 5th day lands despite availability.
  const on = runEngine(
    input({
      shifts,
      drivers: [mk()],
      settings: {
        max_days: 4,
        fifth_day_fill: true,
        availability_enforcement: true,
        fifth_day_override_availability: true,
      },
    }),
  );
  assert.equal(on.summary_metrics.filled_shifts, 5);
});

// --- R003 license protection window ----------------------------------------

test("R003 — protection window blocks a soon-to-expire driver, others fill", () => {
  const r = runEngine(
    input({
      shifts: [shift({ shift_id: "s1", date: "2026-05-25" })],
      drivers: [
        driver({ driver_id: "a_soon", license_expiration_date: "2026-05-28" }),
        driver({ driver_id: "b_ok", license_expiration_date: "2026-12-01" }),
      ],
      settings: { license_protection_days: 7 },
    }),
  );
  assert.equal(r.summary_metrics.filled_shifts, 1);
  assert.equal(r.assigned_shifts[0]?.driver_id, "b_ok");
});

test("R003 — protection window of 0 only blocks once expired", () => {
  const r = runEngine(
    input({
      shifts: [shift({ shift_id: "s1", date: "2026-05-25" })],
      drivers: [driver({ driver_id: "d1", license_expiration_date: "2026-05-26" })],
      settings: { license_protection_days: 0 },
    }),
  );
  assert.equal(r.summary_metrics.filled_shifts, 1);
});

// --- Attendance Penalty ----------------------------------------------------

test("attendance penalty rotates Final-corrective drivers last", () => {
  const base = {
    shifts: [shift({ shift_id: "s1", date: "2026-05-25" })],
    drivers: [
      // a_sr is the more senior driver but on a Final corrective action.
      driver({ driver_id: "a_sr", hire_date: "2019-01-01", attendance_final: true }),
      driver({ driver_id: "b_jr", hire_date: "2023-01-01" }),
    ],
  };
  // Without the penalty: seniority wins — a_sr takes the shift.
  assert.equal(
    runEngine(input(base)).assigned_shifts[0]?.driver_id,
    "a_sr",
  );
  // With the penalty: a_sr rotates last, so b_jr takes the shift.
  assert.equal(
    runEngine(input({ ...base, settings: { attendance_penalty: true } }))
      .assigned_shifts[0]?.driver_id,
    "b_jr",
  );
});

test("attendance penalty schedules Final-corrective drivers last, not just later", () => {
  // Two drivers, two days, soft target of 1 day each. A mere pick-order
  // penalty would still split the days 1-and-1; schedule-last means the
  // clean driver absorbs BOTH days (the target is soft) and the
  // Final-corrective driver gets nothing.
  const base = {
    shifts: [
      shift({ shift_id: "s1", date: "2026-05-25" }),
      shift({ shift_id: "s2", date: "2026-05-26" }),
    ],
    drivers: [
      driver({ driver_id: "a_fca", attendance_final: true }),
      driver({ driver_id: "b_ok" }),
    ],
  };
  const r = runEngine(
    input({
      ...base,
      settings: { attendance_penalty: true, target_days_per_week: 1 },
    }),
  );
  assert.equal(r.summary_metrics.filled_shifts, 2);
  for (const a of r.assigned_shifts) assert.equal(a.driver_id, "b_ok");
  // Sanity: without the penalty the soft target splits the days 1-and-1.
  const off = runEngine(
    input({ ...base, settings: { target_days_per_week: 1 } }),
  );
  const counts = new Map<string, number>();
  for (const a of off.assigned_shifts) {
    counts.set(a.driver_id, (counts.get(a.driver_id) ?? 0) + 1);
  }
  assert.equal(counts.get("a_fca"), 1);
  assert.equal(counts.get("b_ok"), 1);
});

test("attendance penalty never leaves an XL route open — FCA driver still covers it", () => {
  // The FCA driver is the only XL-certified one. Schedule-last must not
  // strand the XL route: coverage (XL above all) beats keeping a
  // Final-corrective driver off the schedule.
  const r = runEngine(
    input({
      shifts: [
        shift({ shift_id: "s_xl", date: "2026-05-25", route_type: "xl" }),
        shift({ shift_id: "s_std", date: "2026-05-25" }),
      ],
      drivers: [
        driver({ driver_id: "a_fca", xl_certified: true, attendance_final: true }),
        driver({ driver_id: "b_ok" }),
      ],
      settings: { attendance_penalty: true },
    }),
  );
  const byShift = new Map(r.assigned_shifts.map((a) => [a.shift_id, a.driver_id]));
  assert.equal(byShift.get("s_xl"), "a_fca");
  assert.equal(byShift.get("s_std"), "b_ok");
});

// --- Random order + rotation start day -------------------------------------

test("random scheduling method is deterministic per week", () => {
  const mk = () =>
    runEngine(
      input({
        shifts: [shift({ shift_id: "s1", date: "2026-05-25" })],
        drivers: [
          driver({ driver_id: "d1" }),
          driver({ driver_id: "d2" }),
          driver({ driver_id: "d3" }),
        ],
        settings: { scheduling_method: "random" },
      }),
    );
  // Re-running the same week yields the identical assignment.
  assert.equal(mk().assigned_shifts[0]?.driver_id, mk().assigned_shifts[0]?.driver_id);
});

test("rotation_start_day fills the chosen weekday first", () => {
  // One driver, max_days 1: with the rotation starting on Saturday the
  // driver's single shift lands on Saturday, not Sunday.
  const shifts = [];
  for (let i = 0; i < 7; i++) {
    shifts.push(shift({ shift_id: `s${i}`, date: `2026-05-${String(24 + i).padStart(2, "0")}` }));
  }
  const r = runEngine(
    input({
      shifts,
      drivers: [driver({ driver_id: "d1" })],
      settings: {
        max_days_enforcement: true,
        max_days: 1,
        weekly_hour_cap_enforcement: false,
        woc_enforcement: false,
        rotation_start_day: 6, // Saturday
      },
    }),
  );
  assert.equal(r.summary_metrics.filled_shifts, 1);
  // 2026-05-30 is the Saturday of this Sun-start week.
  assert.equal(r.assigned_shifts[0]?.shift_id, "s6");
});

test("driver_lock_to_day — Wednesday pin places driver on the Wed shift", () => {
  // Week of 2026-05-24 (Sun). Wednesday is 2026-05-27 (dow=3).
  const r = runEngine(
    input({
      shifts: [
        shift({ shift_id: "s_sun", date: "2026-05-24" }),
        shift({ shift_id: "s_wed", date: "2026-05-27" }),
        shift({ shift_id: "s_sat", date: "2026-05-30" }),
      ],
      drivers: [
        driver({ driver_id: "alice", last_name: "Alice" }),
        driver({ driver_id: "bob",   last_name: "Bob" }),
      ],
      ad_hoc_constraints: [
        { id: "r1", kind: "driver_lock_to_day", payload: { driver_id: "alice", dow: 3 }, hardness: "hard" },
      ],
      settings: { max_days_enforcement: false, woc_enforcement: false },
    }),
  );
  const wed = r.assigned_shifts.find(a => a.shift_id === "s_wed");
  assert.equal(wed?.driver_id, "alice", "Alice should be pinned to the Wednesday shift");
  assert.equal(wed?.source, "pin_lock");
});

test("driver_lock_to_day — PTO overrides the lock (no violation)", () => {
  // Alice is pinned to Wednesday but has PTO on Wed 2026-05-27.
  // The lock should go silent — Bob takes the Wednesday shift, no error.
  const r = runEngine(
    input({
      shifts: [
        shift({ shift_id: "s_wed", date: "2026-05-27" }),
      ],
      drivers: [
        driver({
          driver_id: "alice",
          last_name: "Alice",
          pto_records: [{ date: "2026-05-27", hours: 10 }],
        }),
        driver({ driver_id: "bob", last_name: "Bob" }),
      ],
      ad_hoc_constraints: [
        { id: "r1", kind: "driver_lock_to_day", payload: { driver_id: "alice", dow: 3 }, hardness: "hard" },
      ],
      settings: { pto_protection: true, max_days_enforcement: false, woc_enforcement: false },
    }),
  );
  const wed = r.assigned_shifts.find(a => a.shift_id === "s_wed");
  assert.equal(wed?.driver_id, "bob", "Bob should take Wednesday when Alice is on PTO");
  // Pin going silent for a week is NOT a violation.
  assert.deepEqual(r.violations, []);
});

test("driver_lock_to_day — soft hardness is ignored by the heuristic (v1)", () => {
  // Soft lock-to-day rules are only honored by CP-SAT in v1. The
  // heuristic ignores them and assigns normally.
  const r = runEngine(
    input({
      shifts: [
        shift({ shift_id: "s_wed", date: "2026-05-27" }),
      ],
      drivers: [
        driver({ driver_id: "alice", last_name: "Z_alice" }), // sorts last
        driver({ driver_id: "bob",   last_name: "A_bob"  }), // sorts first
      ],
      ad_hoc_constraints: [
        { id: "r1", kind: "driver_lock_to_day", payload: { driver_id: "alice", dow: 3 }, hardness: "soft", weight: 100 },
      ],
      settings: {
        scheduling_method: "alphabetical",
        max_days_enforcement: false,
        woc_enforcement: false,
      },
    }),
  );
  // Bob sorts first alphabetically; soft rule is ignored → Bob wins.
  assert.equal(r.assigned_shifts.find(a => a.shift_id === "s_wed")?.driver_id, "bob");
});

test("driver_lock_to_day — unknown driver in payload is silently skipped", () => {
  const r = runEngine(
    input({
      shifts: [shift({ shift_id: "s_wed", date: "2026-05-27" })],
      drivers: [driver({ driver_id: "alice" })],
      ad_hoc_constraints: [
        { id: "r1", kind: "driver_lock_to_day", payload: { driver_id: "ghost", dow: 3 }, hardness: "hard" },
      ],
      settings: { max_days_enforcement: false, woc_enforcement: false },
    }),
  );
  // Schedule still fills — bad rule is silently dropped, not an error.
  assert.equal(r.summary_metrics.filled_shifts, 1);
  assert.equal(r.assigned_shifts[0]?.driver_id, "alice");
});

test("R021 — driver_exclude_from_day blocks the driver on that DOW", () => {
  // Bob is excluded from Wednesdays. Alice has to take the Wed shift.
  const r = runEngine(
    input({
      shifts: [shift({ shift_id: "s_wed", date: "2026-05-27" })],
      drivers: [
        driver({ driver_id: "alice", last_name: "Z_alice" }),
        driver({ driver_id: "bob",   last_name: "A_bob" }),
      ],
      ad_hoc_constraints: [
        { id: "r1", kind: "driver_exclude_from_day",
          payload: { driver_id: "bob", dow: 3 }, hardness: "hard" },
      ],
      settings: {
        scheduling_method: "alphabetical",
        max_days_enforcement: false, woc_enforcement: false,
      },
    }),
  );
  // Bob sorts first alphabetically but is excluded → Alice gets it.
  assert.equal(r.assigned_shifts.find(a => a.shift_id === "s_wed")?.driver_id, "alice");
});

test("R021 — date_blackout_driver blocks the driver inside the range", () => {
  const r = runEngine(
    input({
      shifts: [
        shift({ shift_id: "s_mon", date: "2026-05-25" }),
        shift({ shift_id: "s_tue", date: "2026-05-26" }),
        shift({ shift_id: "s_wed", date: "2026-05-27" }),
      ],
      drivers: [
        driver({ driver_id: "alice", last_name: "A_alice" }),
        driver({ driver_id: "bob",   last_name: "B_bob" }),
      ],
      ad_hoc_constraints: [
        { id: "r1", kind: "date_blackout_driver",
          payload: { driver_id: "alice", date_from: "2026-05-25", date_to: "2026-05-26" },
          hardness: "hard" },
      ],
      settings: {
        scheduling_method: "alphabetical",
        max_days_enforcement: false, woc_enforcement: false,
      },
    }),
  );
  // Alice blocked Mon + Tue but free on Wed. Bob takes Mon + Tue.
  const monDriver = r.assigned_shifts.find(a => a.shift_id === "s_mon")?.driver_id;
  const tueDriver = r.assigned_shifts.find(a => a.shift_id === "s_tue")?.driver_id;
  assert.notEqual(monDriver, "alice");
  assert.notEqual(tueDriver, "alice");
});

test("R007 — driver_max_days_override caps tighter than the global", () => {
  // Global max_days = 5; Alice has an override to 2. Even with 4 open
  // shifts she can only be on 2 of them.
  const r = runEngine(
    input({
      shifts: [
        shift({ shift_id: "s_mon", date: "2026-05-25" }),
        shift({ shift_id: "s_tue", date: "2026-05-26" }),
        shift({ shift_id: "s_wed", date: "2026-05-27" }),
        shift({ shift_id: "s_thu", date: "2026-05-28" }),
      ],
      drivers: [driver({ driver_id: "alice" })],
      ad_hoc_constraints: [
        { id: "r1", kind: "driver_max_days_override",
          payload: { driver_id: "alice", max_days: 2 }, hardness: "hard" },
      ],
      settings: {
        max_days_enforcement: true, max_days: 5,
        weekly_hour_cap_enforcement: false, woc_enforcement: false,
      },
    }),
  );
  // 2 of 4 shifts filled (Alice's per-driver cap), 2 uncovered.
  assert.equal(r.summary_metrics.filled_shifts, 2);
});

test("R021 — soft hardness is ignored by the heuristic", () => {
  // Soft excludes are CP-SAT only in v1. Heuristic ignores them.
  const r = runEngine(
    input({
      shifts: [shift({ shift_id: "s_wed", date: "2026-05-27" })],
      drivers: [driver({ driver_id: "alice" })],
      ad_hoc_constraints: [
        { id: "r1", kind: "driver_exclude_from_day",
          payload: { driver_id: "alice", dow: 3 },
          hardness: "soft", weight: 10 },
      ],
      settings: { max_days_enforcement: false, woc_enforcement: false },
    }),
  );
  // Soft exclude ignored — alice gets the shift.
  assert.equal(r.assigned_shifts.find(a => a.shift_id === "s_wed")?.driver_id, "alice");
});

test("driver_lock_to_day — overrides saved availability (operator override)", () => {
  // Chucky's saved availability doesn't include Sundays, but the
  // operator pinned him to Sundays anyway. The pin wins — saved
  // availability is a preference, not a hard absence.
  const r = runEngine(
    input({
      shifts: [
        shift({ shift_id: "s_sun", date: "2026-05-24" }), // dow=0
      ],
      drivers: [
        driver({
          driver_id: "chucky", last_name: "Cheese",
          // No Sunday (0) listed → R006 would normally block.
          saved_availability: { "1": [{ start: "00:00", end: "48:00" }] },
        }),
      ],
      ad_hoc_constraints: [
        { id: "r1", kind: "driver_lock_to_day",
          payload: { driver_id: "chucky", dow: 0 }, hardness: "hard" },
      ],
      settings: {
        availability_enforcement: true,
        max_days_enforcement: false, woc_enforcement: false,
      },
    }),
  );
  // Pin overrides R006 — chucky takes Sunday.
  assert.equal(r.assigned_shifts.find(a => a.shift_id === "s_sun")?.driver_id, "chucky");
});

test("driver_lock_to_day — still blocked by hard rules (license expired)", () => {
  // Chucky pinned to Sunday but license is expired. Pin must yield.
  const r = runEngine(
    input({
      shifts: [shift({ shift_id: "s_sun", date: "2026-05-24" })],
      drivers: [
        driver({
          driver_id: "chucky", last_name: "Cheese",
          license_expiration_date: "2026-05-01", // expired
        }),
        driver({ driver_id: "bob", last_name: "Bob" }),
      ],
      ad_hoc_constraints: [
        { id: "r1", kind: "driver_lock_to_day",
          payload: { driver_id: "chucky", dow: 0 }, hardness: "hard" },
      ],
      settings: {
        license_enforcement: true,
        max_days_enforcement: false, woc_enforcement: false,
      },
    }),
  );
  // Chucky's license is expired → pin yields → Bob takes Sunday.
  assert.equal(r.assigned_shifts.find(a => a.shift_id === "s_sun")?.driver_id, "bob");
});

test("driver_lock_to_day — Preferred Enhancement must NOT swap a pinned shift", () => {
  // The original operator bug: Chucky pinned to Monday. Bob prefers
  // Mondays; Chucky prefers Tuesdays. Without the fix, the preferred-
  // availability enhancement would swap them so both land on preferred
  // days — but the pin would be broken. With the fix, Chucky stays
  // pinned to Monday even though it's not his preferred day.
  const r = runEngine(
    input({
      shifts: [
        shift({ shift_id: "s_mon", date: "2026-05-25" }), // Mon
        shift({ shift_id: "s_tue", date: "2026-05-26" }), // Tue
      ],
      drivers: [
        driver({
          driver_id: "chucky", last_name: "Cheese",
          preferred_availability: { "2": [{ start: "00:00", end: "48:00" }] }, // prefers Tue
        }),
        driver({
          driver_id: "bob", last_name: "Bob",
          preferred_availability: { "1": [{ start: "00:00", end: "48:00" }] }, // prefers Mon
        }),
      ],
      ad_hoc_constraints: [
        { id: "r1", kind: "driver_lock_to_day",
          payload: { driver_id: "chucky", dow: 1 }, hardness: "hard" },
      ],
      settings: {
        preferred_enhancement: true,
        preferred_enhancement_contiguous: false,
        preferred_enhancement_extra: true,
        max_days_enforcement: false, woc_enforcement: false,
      },
    }),
  );
  // The pin must survive: chucky stays on Monday.
  assert.equal(
    r.assigned_shifts.find(a => a.shift_id === "s_mon")?.driver_id,
    "chucky",
    "preferred enhancement must not break a pinned (locked) assignment",
  );
});

test("driver_lock_to_day — Affinity Enhancement must NOT swap a pinned shift", () => {
  // Symmetric test for the affinity enhancement. Chucky pinned to Mon,
  // but his historical weekday affinity favors Wednesday. Without the
  // fix, the affinity sweep would swap him to Wed; with the fix, the
  // pin holds.
  const r = runEngine(
    input({
      shifts: [
        shift({ shift_id: "s_mon", date: "2026-05-25" }), // Mon (dow=1)
        shift({ shift_id: "s_wed", date: "2026-05-27" }), // Wed (dow=3)
      ],
      drivers: [
        driver({
          driver_id: "chucky", last_name: "Cheese",
          // Strong Wed affinity, no Mon affinity.
          weekday_affinity: [0, 0, 0, 100, 0, 0, 0],
        }),
        driver({
          driver_id: "bob", last_name: "Bob",
          // Strong Mon affinity.
          weekday_affinity: [0, 100, 0, 0, 0, 0, 0],
        }),
      ],
      ad_hoc_constraints: [
        { id: "r1", kind: "driver_lock_to_day",
          payload: { driver_id: "chucky", dow: 1 }, hardness: "hard" },
      ],
      settings: {
        affinity_enhancement: true,
        affinity_day_order: [1, 3, 0, 2, 4, 5, 6],
        max_days_enforcement: false, woc_enforcement: false,
      },
    }),
  );
  assert.equal(
    r.assigned_shifts.find(a => a.shift_id === "s_mon")?.driver_id,
    "chucky",
    "affinity enhancement must not break a pinned (locked) assignment",
  );
});

test("R022 — target_days_per_week deprioritizes drivers over their target", () => {
  // Two eligible drivers, 5 shifts. target=4, max_days=6.
  // Without R022 (target=0), fair rotation would split work roughly 3+2.
  // With target=4, the engine should still fill all 5 shifts because no
  // alternative driver exists — but it should spread, not stack one.
  // Stronger signal: when one driver is at target and another is under,
  // the under-target driver wins each round until they catch up.
  const dates = ["2026-05-24","2026-05-25","2026-05-26","2026-05-27","2026-05-28"];
  const r = runEngine(
    input({
      shifts: dates.map((d, i) => shift({ shift_id: `s${i}`, date: d })),
      drivers: [
        driver({ driver_id: "alice", last_name: "A_alice" }),
        driver({ driver_id: "bob",   last_name: "B_bob" }),
      ],
      settings: {
        max_days_enforcement: true, max_days: 6,
        target_days_per_week: 4,
        scheduling_method: "fair_rotation",
        weekly_hour_cap_enforcement: false, woc_enforcement: false,
      },
    }),
  );
  // All 5 shifts assigned (coverage wins even with target soft-cap).
  assert.equal(r.summary_metrics.filled_shifts, 5);
  // Spread roughly 3-2 — neither driver over their target of 4.
  const aliceShifts = r.driver_totals.find(t => t.driver_id === "alice")?.assigned_shift_ids.length ?? 0;
  const bobShifts   = r.driver_totals.find(t => t.driver_id === "bob")?.assigned_shift_ids.length ?? 0;
  assert.ok(aliceShifts <= 4 && bobShifts <= 4,
    `neither driver should exceed target=4 when spread is possible (got alice=${aliceShifts}, bob=${bobShifts})`);
});

test("R022 — target_days_per_week=0 disables the soft cap (no behavior change)", () => {
  const dates = ["2026-05-24","2026-05-25","2026-05-26","2026-05-27"];
  const r = runEngine(
    input({
      shifts: dates.map((d, i) => shift({ shift_id: `s${i}`, date: d })),
      drivers: [driver({ driver_id: "alice" })],
      settings: {
        max_days_enforcement: true, max_days: 6,
        target_days_per_week: 0, // disabled
        weekly_hour_cap_enforcement: false, woc_enforcement: false,
      },
    }),
  );
  // All 4 shifts to alice — soft cap disabled.
  assert.equal(r.summary_metrics.filled_shifts, 4);
});

test("R022 — coverage wins when ALL eligible drivers are at target", () => {
  // 6 shifts, 1 driver, target=4, max_days=6. Soft cap penalizes days
  // 5 and 6 — but they're the ONLY option, so the engine fills them.
  const dates = ["2026-05-24","2026-05-25","2026-05-26","2026-05-27","2026-05-28","2026-05-29"];
  const r = runEngine(
    input({
      shifts: dates.map((d, i) => shift({ shift_id: `s${i}`, date: d })),
      drivers: [driver({ driver_id: "alice" })],
      settings: {
        max_days_enforcement: true, max_days: 6,
        target_days_per_week: 4,
        weekly_hour_cap_enforcement: false, woc_enforcement: false,
      },
    }),
  );
  // All 6 fill — coverage need overrides the soft cap.
  assert.equal(r.summary_metrics.filled_shifts, 6);
});

test("R022 two-phase · pin doesn't push driver into OT when another under-target driver is eligible", () => {
  // Charlie pinned to Mon + Thu (2 pin_lock days). target=4. Renee
  // has zero shifts. There are 5 standard shifts on five different
  // weekdays. With the two-phase fill, Charlie tops out at 4 days
  // (his 2 pins + 2 auto-fill from Pass A) and Renee picks up the
  // 5th day (her first) in Pass A — Charlie should NOT be pushed to
  // a 5th day because Renee was still under target.
  const dates = ["2026-05-24", "2026-05-25", "2026-05-26", "2026-05-28", "2026-05-29"];
  // Mon = 2026-05-25, Thu = 2026-05-28.
  const r = runEngine(
    input({
      shifts: dates.map((d, i) => shift({ shift_id: `s${i}`, date: d })),
      drivers: [
        driver({ driver_id: "charlie", last_name: "Charlie" }),
        driver({ driver_id: "renee",   last_name: "Renee" }),
      ],
      ad_hoc_constraints: [
        { id: "r1", kind: "driver_lock_to_day",
          payload: { driver_id: "charlie", dow: 1 }, hardness: "hard" },
        { id: "r2", kind: "driver_lock_to_day",
          payload: { driver_id: "charlie", dow: 4 }, hardness: "hard" },
      ],
      settings: {
        target_days_per_week: 4,
        max_days_enforcement: true, max_days: 6,
        weekly_hour_cap_enforcement: false, woc_enforcement: false,
        scheduling_method: "fair_rotation",
      },
    }),
  );
  // 5 shifts, all should be covered.
  assert.equal(r.summary_metrics.filled_shifts, 5);
  const charlieDays = r.driver_totals.find(t => t.driver_id === "charlie")?.assigned_shift_ids.length ?? 0;
  const reneeDays   = r.driver_totals.find(t => t.driver_id === "renee")?.assigned_shift_ids.length ?? 0;
  // The two-phase fix's correctness condition: neither driver pushed
  // past target=4. (Charlie has 2 pins so he can take 0-2 more in
  // Pass A; Renee has 0 pins so she can take 1-4 in Pass A.) The
  // engine can split the 3 unpinned shifts either way as long as
  // neither goes over 4.
  assert.ok(charlieDays <= 4, `charlie should not exceed target=4 (got ${charlieDays})`);
  assert.ok(reneeDays   <= 4, `renee should not exceed target=4 (got ${reneeDays})`);
  // Charlie's pinned days must still be in his roster.
  assert.ok(charlieDays >= 2, "charlie must still have both his pins");
});

test("R022 two-phase · OT escape kicks in when coverage demands it", () => {
  // 5 shifts, 1 driver, target=4, max_days=6. Pass A places 4 shifts
  // (driver hits target). Pass B handles the 5th — the driver goes to
  // 5 days because nobody else is eligible.
  const dates = ["2026-05-24", "2026-05-25", "2026-05-26", "2026-05-27", "2026-05-28"];
  const r = runEngine(
    input({
      shifts: dates.map((d, i) => shift({ shift_id: `s${i}`, date: d })),
      drivers: [driver({ driver_id: "alice" })],
      settings: {
        target_days_per_week: 4,
        max_days_enforcement: true, max_days: 6,
        weekly_hour_cap_enforcement: false, woc_enforcement: false,
      },
    }),
  );
  // All 5 fill — coverage need overrides the soft target via Pass B.
  assert.equal(r.summary_metrics.filled_shifts, 5);
});
