#!/usr/bin/env node
// Tests for dashboard/repair/repair-engine.js — the Repair Center's
// stage machine, timers, money math, and queue logic.
// Run: node scripts/test-repair-engine.mjs (also part of `npm test`).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  STAGES, STAGE_LABEL, STAGE_TONE, STAGE_TRANSITIONS,
  canTransition, isOpenStage,
  AVAILABILITY_LABEL, AVAILABILITY_TONE, SHOP_STATUS_LABEL, SHOP_STATUS_TONE,
  msBetween, formatDuration, daysDown, daysDownTone, promiseState, downSince,
  formatCents, sumCents, varianceCents, variancePct,
  attentionScore, filterQueue, sortQueue, summarize,
  formatWhen, formatDay, vehicleShortDesc, parseOdometer, ODOMETER_MAX,
} from "../dashboard/repair/repair-engine.js";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (f) => JSON.parse(readFileSync(join(here, "../tests/fixtures/repair", f), "utf8"));

let passed = 0;
function t(name, fn) {
  try { fn(); passed++; }
  catch (e) { console.error(`✗ ${name}\n  ${e.message}`); process.exitCode = 1; }
}

const NOW = "2026-07-14T12:00:00Z";

// ── Stage machine ───────────────────────────────────────────────────────
t("every stage has a label and a tone", () => {
  for (const s of STAGES) {
    assert.ok(STAGE_LABEL[s], `label for ${s}`);
    assert.ok(STAGE_TONE[s], `tone for ${s}`);
  }
});

t("transition map covers every stage and only known stages", () => {
  for (const s of STAGES) {
    assert.ok(Array.isArray(STAGE_TRANSITIONS[s]), `transitions for ${s}`);
    for (const to of STAGE_TRANSITIONS[s]) {
      assert.ok(STAGES.includes(to), `${s} -> ${to} targets a known stage`);
      assert.notEqual(to, s, `${s} never transitions to itself`);
    }
  }
});

t("transition map matches the SQL fixture (migration 0486)", () => {
  // stage-transitions.json is the shared contract; migration 0486's
  // _repair_stage_next_allowed() was generated from the same table.
  const sql = fx("stage-transitions.json");
  assert.deepEqual(STAGE_TRANSITIONS, sql);
});

t("terminal stages have no exits", () => {
  assert.deepEqual(STAGE_TRANSITIONS.closed, []);
  assert.deepEqual(STAGE_TRANSITIONS.cancelled, []);
});

t("core lifecycle path is walkable", () => {
  const path = ["reported", "quoting", "quotes_in", "awaiting_approval",
    "approved", "scheduled", "at_shop", "ready_for_pickup",
    "quality_check", "returned", "closed"];
  for (let i = 0; i < path.length - 1; i++) {
    assert.ok(canTransition(path[i], path[i + 1]), `${path[i]} -> ${path[i + 1]}`);
  }
});

t("emergency tow-in path skips quoting", () => {
  assert.ok(canTransition("reported", "at_shop"));
});

t("QC failure returns the van to the shop", () => {
  assert.ok(canTransition("quality_check", "at_shop"));
  assert.ok(!canTransition("quality_check", "closed"));
});

t("cancel is not available after return", () => {
  assert.ok(!canTransition("returned", "cancelled"));
});

t("isOpenStage", () => {
  assert.ok(isOpenStage("at_shop"));
  assert.ok(!isOpenStage("closed"));
  assert.ok(!isOpenStage("cancelled"));
});

t("availability + shop-status vocab complete", () => {
  for (const k of Object.keys(AVAILABILITY_LABEL)) assert.ok(AVAILABILITY_TONE[k], k);
  for (const k of Object.keys(SHOP_STATUS_LABEL)) assert.ok(SHOP_STATUS_TONE[k], k);
  // Red is earned: only "delayed" may be red among shop statuses.
  const red = Object.entries(SHOP_STATUS_TONE).filter(([, v]) => v === "bad").map(([k]) => k);
  assert.deepEqual(red, ["delayed"]);
});

// ── Timers ──────────────────────────────────────────────────────────────
t("msBetween handles missing and bad input", () => {
  assert.equal(msBetween(null, NOW), null);
  assert.equal(msBetween(NOW, null), null);
  assert.equal(msBetween("garbage", NOW), null);
  assert.equal(msBetween("2026-07-14T11:00:00Z", NOW), 3600 * 1000);
});

t("formatDuration", () => {
  assert.equal(formatDuration(null), "—");
  assert.equal(formatDuration(0), "now");
  assert.equal(formatDuration(45 * 60000), "45m");
  assert.equal(formatDuration(3 * 3600e3), "3h");
  assert.equal(formatDuration(26 * 3600e3), "1d 2h");
  assert.equal(formatDuration(96 * 3600e3), "4d");
});

t("daysDown + tone thresholds (3d amber, 7d red)", () => {
  assert.equal(daysDown("2026-07-10T06:00:00Z", NOW), 4);
  assert.equal(daysDownTone(null), "");
  assert.equal(daysDownTone(0), "");
  assert.equal(daysDownTone(2), "");
  assert.equal(daysDownTone(3), "warn");
  assert.equal(daysDownTone(6), "warn");
  assert.equal(daysDownTone(7), "bad");
});

t("promiseState — revised beats promised; ready is never overdue", () => {
  const overdue = promiseState({ promised_completion_at: "2026-07-13T22:00:00Z" }, NOW);
  assert.equal(overdue.state, "overdue");
  assert.ok(overdue.overdueMs > 0);

  const revised = promiseState({
    promised_completion_at: "2026-07-13T22:00:00Z",
    revised_completion_at: "2026-07-16T22:00:00Z",
  }, NOW);
  assert.equal(revised.state, "on_track");

  const dueSoon = promiseState({ promised_completion_at: "2026-07-14T20:00:00Z" }, NOW);
  assert.equal(dueSoon.state, "due_soon");

  const ready = promiseState({
    promised_completion_at: "2026-07-13T22:00:00Z",
    ready_for_pickup_at: "2026-07-14T07:40:00Z",
  }, NOW);
  assert.equal(ready.state, "met");

  assert.equal(promiseState(null, NOW).state, "none");
  assert.equal(promiseState({}, NOW).state, "none");
});

t("downSince prefers Fleet grounding truth", () => {
  assert.equal(downSince({
    availability: "grounded", grounded_since: "2026-07-09T18:41:00Z",
  }), "2026-07-09T18:41:00Z");
  assert.equal(downSince({
    stage: "at_shop", availability: "at_shop",
    dropped_off_at: "2026-07-10T07:15:00Z",
  }), "2026-07-10T07:15:00Z");
  assert.equal(downSince({ availability: "in_service" }), null);
});

// ── Money ───────────────────────────────────────────────────────────────
t("formatCents", () => {
  assert.equal(formatCents(61240), "$612.40");
  assert.equal(formatCents(0), "$0.00");
  assert.equal(formatCents(-6200), "-$62.00");
  assert.equal(formatCents(483000), "$4,830.00");
  assert.equal(formatCents(null), "—");
  assert.equal(formatCents(NaN), "—");
});

t("sumCents ignores nulls, rounds strays", () => {
  assert.equal(sumCents([100, null, 250, undefined, NaN]), 350);
  assert.equal(sumCents([]), 0);
  assert.equal(sumCents(null), 0);
  assert.equal(sumCents([33.3]), 33);
});

t("variance math", () => {
  assert.equal(varianceCents(78000, 84200), 6200);
  assert.equal(varianceCents(null, 84200), null);
  assert.ok(Math.abs(variancePct(78000, 84200) - 7.9487) < 0.001);
  assert.equal(variancePct(0, 100), null);
});

t("parseOdometer — blank ok, units stripped, junk and overflow refused", () => {
  assert.deepEqual(parseOdometer(""), { ok: true, value: null, reason: null });
  assert.deepEqual(parseOdometer(null), { ok: true, value: null, reason: null });
  assert.deepEqual(parseOdometer("44,318"), { ok: true, value: 44318, reason: null });
  assert.deepEqual(parseOdometer("44318 mi"), { ok: true, value: 44318, reason: null });
  assert.deepEqual(parseOdometer("abc"), { ok: false, value: null, reason: "not_a_number" });
  // The exact fat-finger case from the field: 11 digits overflows int4.
  assert.deepEqual(parseOdometer("75765765765"), { ok: false, value: null, reason: "too_large" });
  assert.equal(parseOdometer(String(ODOMETER_MAX)).ok, true);
  assert.equal(parseOdometer(String(ODOMETER_MAX + 1)).ok, false);
});

// ── Queue logic on realistic fixtures ───────────────────────────────────
const rows = fx("queue.json");

t("fixtures load with the documented shapes", () => {
  assert.ok(rows.length >= 6);
  for (const r of rows) {
    assert.ok(STAGES.includes(r.stage), `stage ${r.stage}`);
    assert.ok(r.case_number.startsWith("RC-"));
  }
});

t("attentionScore floats overdue + long-grounded to the top", () => {
  const sorted = sortQueue(rows, NOW, "attention");
  // RC-0141: grounded 4d AND past promise — must lead.
  assert.equal(sorted[0].case_number, "RC-2026-0141");
  // RC-0140: grounded longest + awaiting approval — must be next.
  assert.equal(sorted[1].case_number, "RC-2026-0140");
});

t("filterQueue — grounded only", () => {
  const g = filterQueue(rows, { groundedOnly: true, nowIso: NOW });
  assert.ok(g.length >= 2);
  for (const r of g) {
    assert.ok(r.availability === "grounded" || r.operational_status === "grounded");
  }
});

t("filterQueue — overdue only", () => {
  const o = filterQueue(rows, { overdueOnly: true, nowIso: NOW });
  assert.deepEqual(o.map((r) => r.case_number).sort(), ["RC-2026-0141"]);
});

t("filterQueue — search hits unit, VIN, WO number", () => {
  assert.equal(filterQueue(rows, { search: "RR-104", nowIso: NOW }).length, 1);
  assert.equal(filterQueue(rows, { search: "48213", nowIso: NOW }).length, 1);
  assert.equal(filterQueue(rows, { search: "zebra", nowIso: NOW }).length, 0);
});

t("filterQueue — openOnly default excludes closed", () => {
  const open = filterQueue(rows, { nowIso: NOW });
  assert.ok(open.every((r) => isOpenStage(r.stage)));
  const all = filterQueue(rows, { openOnly: false, nowIso: NOW });
  assert.ok(all.length > open.length);
});

t("summarize matches the fixture's known truth", () => {
  const s = summarize(rows, NOW);
  assert.equal(s.open_cases, rows.filter((r) => isOpenStage(r.stage)).length);
  assert.equal(s.grounded, 2);
  assert.equal(s.past_promise, 1);
  assert.equal(s.waiting_on_parts, 1);
  assert.equal(s.approved_total_cents, 61240 + 73600);
  assert.equal(s.ready_for_pickup, 1);
});

// ── Formatting ──────────────────────────────────────────────────────────
t("formatWhen / formatDay tolerate junk", () => {
  assert.equal(formatWhen(null, NOW), "—");
  assert.equal(formatWhen("garbage", NOW), "—");
  assert.equal(formatDay(null), "—");
  assert.ok(formatDay("2026-07-10T07:15:00Z").includes("Jul"));
});

t("vehicleShortDesc", () => {
  assert.equal(vehicleShortDesc({
    vehicle_year: 2022, vehicle_make: "Ford", vehicle_model: "Transit 250",
  }), "'22 Ford Transit 250");
  assert.equal(vehicleShortDesc({}), "");
  assert.equal(vehicleShortDesc(null), "");
});

console.log(`test-repair-engine: ${passed} passed${process.exitCode ? " (with failures)" : ""}`);
