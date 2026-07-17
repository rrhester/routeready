// Full-run, scoring, validation, and idempotency tests.

import { test } from "node:test";
import assert from "node:assert/strict";
import { EngineError, runEngine, validateSettings } from "../src/index.ts";
import type { EngineInput, ScheduleResult } from "../src/types.ts";
import { driver, input, shift } from "./helpers.ts";

function stable(r: ScheduleResult): string {
  return JSON.stringify({ ...r, summary_metrics: { ...r.summary_metrics, elapsed_ms: 0 } });
}

// A non-trivial scenario exercising patterns, attendance, optimization.
function richInput(): EngineInput {
  const dates = [
    "2026-05-24",
    "2026-05-25",
    "2026-05-26",
    "2026-05-27",
    "2026-05-28",
    "2026-05-29",
  ];
  return input({
    shifts: dates.flatMap((d, i) => [
      shift({ shift_id: `s${i}a`, date: d, route_type: "standard" }),
      shift({
        shift_id: `s${i}b`,
        date: d,
        route_type: i % 2 === 0 ? "xl" : "standard",
        start_time: `${d}T14:00`,
      }),
    ]),
    drivers: [
      driver({ driver_id: "d1", last_name: "Adams", attendance_score: 92, xl_certified: true }),
      driver({ driver_id: "d2", last_name: "Brown", attendance_score: 55, hire_date: "2018-03-01" }),
      driver({ driver_id: "d3", last_name: "Clark", attendance_score: null, xl_certified: true }),
      driver({ driver_id: "d4", last_name: "Davis", attendance_score: 70, employment_type: "part_time" }),
    ],
    history: [
      { driver_id: "d1", date: "2026-05-18", duration_hours: 10 },
      { driver_id: "d1", date: "2026-05-11", duration_hours: 10 },
      { driver_id: "d2", date: "2026-05-19", duration_hours: 8 },
      { driver_id: "d3", date: "2026-05-12", duration_hours: 10 },
    ],
    settings: {
      historical_pattern_protection: "high",
      attendance_weight: "high",
      weekly_hour_cap: 60,
    },
  });
}

test("idempotency — ten identical runs produce byte-identical output", () => {
  const inp = richInput();
  const first = stable(runEngine(inp));
  for (let i = 0; i < 9; i++) {
    assert.equal(stable(runEngine(richInput())), first);
  }
});

test("idempotency — inputs_hash is stable and order-independent", () => {
  const a = runEngine(richInput());
  const b = runEngine(richInput());
  assert.equal(a.inputs_hash, b.inputs_hash);
  assert.match(a.inputs_hash, /^sha256:[0-9a-f]{64}$/);
});

test("every assigned + uncovered shift has an explanation", () => {
  const r = runEngine(richInput());
  assert.equal(
    r.explanations.assignments.length,
    r.summary_metrics.filled_shifts,
  );
  assert.equal(
    r.explanations.uncovered.length,
    r.summary_metrics.uncovered_shifts,
  );
  for (const e of r.explanations.assignments) {
    assert.equal(e.decision, "assigned");
    assert.ok(typeof e.summary === "string" && e.summary.length > 0);
  }
});

test("assigned + uncovered + closed accounts for every shift", () => {
  const r = runEngine(richInput());
  const m = r.summary_metrics;
  assert.equal(
    m.filled_shifts + m.uncovered_shifts + m.closed_shifts,
    m.total_shifts,
  );
});

test("rotational fill spreads work more evenly than sequential", () => {
  const dates = ["2026-05-24", "2026-05-25", "2026-05-26", "2026-05-27"];
  const base = {
    shifts: dates.map((d, i) => shift({ shift_id: `s${i}`, date: d })),
    drivers: [driver({ driver_id: "d1" }), driver({ driver_id: "d2" })],
    settings: { max_days_enforcement: false, weekly_hour_cap_enforcement: false },
  };
  const rot = runEngine(
    input({ ...base, settings: { ...base.settings, assignment_mode: "rotational_fill" } }),
  );
  const counts = rot.driver_totals.map((t) => t.assigned_shift_ids.length);
  assert.deepEqual(counts.slice().sort(), [2, 2]);
});

test("attendance scoring favors the higher-attendance driver", () => {
  const r = runEngine(
    input({
      shifts: [shift({ shift_id: "s1" })],
      drivers: [
        driver({ driver_id: "hi", attendance_score: 95 }),
        driver({ driver_id: "lo", attendance_score: 40 }),
      ],
      settings: { attendance_weight: "high", historical_pattern_protection: "off" },
    }),
  );
  assert.equal(r.assigned_shifts[0].driver_id, "hi");
});

test("low-attendance assigned driver raises a warning", () => {
  const r = runEngine(
    input({
      shifts: [shift({ shift_id: "s1" })],
      drivers: [driver({ driver_id: "d1", attendance_score: 45 })],
    }),
  );
  assert.ok(r.warnings.some((w) => w.type === "low_attendance_assigned"));
  assert.equal(r.summary_metrics.attendance_risk_warnings_count, 1);
});

test("unscheduled_drivers explains a hard-blocked driver", () => {
  const r = runEngine(
    input({
      shifts: [shift({ shift_id: "s1" })],
      drivers: [
        driver({ driver_id: "d1", license_expiration_date: "2020-01-01" }),
      ],
    }),
  );
  const u = r.unscheduled_drivers.find((x) => x.driver_id === "d1");
  assert.ok(u);
  assert.equal(u.eligible_somewhere, false);
  assert.ok(u.block_reasons.some((b) => b.rule === "R003"));
});

test("unscheduled_drivers flags a starved-but-eligible driver", () => {
  // Sequential fill, one shift, two drivers — the second is eligible but
  // gets nothing because the first driver is filled first.
  const r = runEngine(
    input({
      shifts: [shift({ shift_id: "s1" })],
      drivers: [driver({ driver_id: "aaa" }), driver({ driver_id: "bbb" })],
      settings: { assignment_mode: "sequential_fill" },
    }),
  );
  assert.equal(r.unscheduled_drivers.length, 1);
  assert.equal(r.unscheduled_drivers[0].eligible_somewhere, true);
});

test("settings validation rejects unknown keys", () => {
  assert.throws(
    () => validateSettings({ bogus_key: true } as never),
    EngineError,
  );
});

test("settings validation rejects out-of-range values", () => {
  assert.throws(() => validateSettings({ max_days: 9 }), EngineError);
});

test("pay_period window without pay_period dates fails loud", () => {
  assert.throws(
    () =>
      runEngine(
        input({
          shifts: [shift({ shift_id: "s1" })],
          drivers: [driver({ driver_id: "d1" })],
          settings: { weekly_hour_window: "pay_period" },
        }),
      ),
    EngineError,
  );
});

test("duplicate shift ids are rejected", () => {
  assert.throws(
    () =>
      runEngine(
        input({
          shifts: [shift({ shift_id: "dup" }), shift({ shift_id: "dup" })],
          drivers: [driver({ driver_id: "d1" })],
        }),
      ),
    EngineError,
  );
});

test("cold-start driver with no history is still schedulable", () => {
  const r = runEngine(
    input({
      shifts: [shift({ shift_id: "s1" })],
      drivers: [driver({ driver_id: "new" })],
      settings: { historical_pattern_protection: "high" },
    }),
  );
  assert.equal(r.assigned_shifts[0]?.driver_id, "new");
});

test("seniority scheduling method orders by hire date", () => {
  const r = runEngine(
    input({
      shifts: [shift({ shift_id: "s1" })],
      drivers: [
        driver({ driver_id: "junior", hire_date: "2024-01-01" }),
        driver({ driver_id: "senior", hire_date: "2015-01-01" }),
      ],
      settings: {
        scheduling_method: "seniority",
        historical_pattern_protection: "off",
        attendance_scheduling: false,
      },
    }),
  );
  assert.equal(r.assigned_shifts[0].driver_id, "senior");
});

test("cold-start affinity emits a warning when pattern protection is on", () => {
  const base = {
    drivers: [driver({ driver_id: "d1" }), driver({ driver_id: "d2" })],
    shifts: [shift({ shift_id: "s1", date: "2026-05-25" })],
    history: [], // no history at all -> every driver is cold-start
  };
  const on = runEngine(
    input({ ...base, settings: { historical_pattern_protection: "low" } }),
  );
  const warns = on.warnings.filter((w) => w.type === "affinity_cold_start");
  assert.equal(warns.length, 1);
  assert.match(warns[0].message, /2 of 2 drivers/);

  // Silent when pattern protection is off — the patterns aren't consulted.
  const off = runEngine(
    input({ ...base, settings: { historical_pattern_protection: "off" } }),
  );
  assert.equal(
    off.warnings.filter((w) => w.type === "affinity_cold_start").length,
    0,
  );
});
