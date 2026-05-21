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
