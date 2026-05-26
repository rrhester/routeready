// Step 10 — Explanation engine. Builds one record per assigned shift and
// one per uncovered shift. Skipped (driver, shift) pairs are aggregated
// into the uncovered record's top_block_reasons — never stored per pair.

import type {
  AssignmentExplanation,
  BlockReasonAgg,
  UnscheduledDriver,
  Warning,
} from "../types.ts";
import type { EngineContext } from "../runtime.ts";
import type { WorkingSchedule } from "../plan.ts";
import { DOW_NAMES } from "../dates.ts";
import { evaluateEligibility } from "../eligibility.ts";
import { orderDrivers } from "../rules/r015_method.ts";
import { computeScore } from "./step7_scoring.ts";

const HARD_CHECKS = [
  "R002",
  "R003",
  "R004",
  "R005",
  "R006",
  "R007",
  "R008",
  "R009",
  "R010",
  "R011",
  "R019",
  "R020",
  "R021",
];

export interface UncoveredInfo {
  shift_id: string;
  top_block_reasons: BlockReasonAgg[];
  summary: string;
}

function clock(min: number): string {
  const m = ((min % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

export function buildAssignmentExplanations(
  ctx: EngineContext,
  ws: WorkingSchedule,
  warnings: Warning[],
): AssignmentExplanation[] {
  const rank = new Map<string, number>();
  orderDrivers(ctx, ws.states).forEach((d, i) => rank.set(d.driver_id, i + 1));

  const warningsByShift = new Map<string, string[]>();
  for (const w of warnings) {
    if (w.shift_id === undefined) continue;
    const list = warningsByShift.get(w.shift_id) ?? [];
    list.push(w.type);
    warningsByShift.set(w.shift_id, list);
  }

  const out: AssignmentExplanation[] = [];
  for (const plan of ws.plans) {
    const driverId = plan.assignedDriverId;
    if (driverId === null) continue;
    const driver = ctx.driverById.get(driverId);
    const state = ws.states.get(driverId);
    if (!driver || !state) continue;

    const base = {
      driver_id: driverId,
      assigned: state.assigned.filter(
        (a) => a.shift_id !== plan.shift.shift_id,
      ),
    };
    const { components, total } = computeScore(
      ctx,
      plan.shift,
      driver,
      base,
      rank.get(driverId) ?? ctx.drivers.length,
    );

    const dow = DOW_NAMES[plan.shift.dow];
    out.push({
      shift_id: plan.shift.shift_id,
      driver_id: driverId,
      decision: "assigned",
      hard_checks_passed: [...HARD_CHECKS],
      score_components: components,
      total_score: total,
      warnings: warningsByShift.get(plan.shift.shift_id) ?? [],
      summary:
        `Assigned ${driver.first_name} ${driver.last_name} to ${dow} ` +
        `${plan.shift.date} (${plan.shift.route_type}) via ${plan.source}; ` +
        `score ${total} [historical ${components.historical}, ` +
        `attendance ${components.attendance}, preferred ${components.preferred}, ` +
        `consecutive ${components.consecutive}, method ${components.method}].`,
    });
  }
  return out;
}

export function buildUncovered(
  ctx: EngineContext,
  ws: WorkingSchedule,
): UncoveredInfo[] {
  const out: UncoveredInfo[] = [];
  for (const plan of ws.plans) {
    if (plan.assignedDriverId !== null || plan.closed) continue;

    const byRule = new Map<string, { count: number; message: string }>();
    for (const driver of ctx.drivers) {
      const state = ws.states.get(driver.driver_id);
      if (!state) continue;
      const cell = evaluateEligibility(plan.shift, driver, state, ctx);
      if (cell.eligible) continue;
      const reason = cell.block_reasons[0];
      const entry = byRule.get(reason.rule);
      if (entry) entry.count += 1;
      else byRule.set(reason.rule, { count: 1, message: reason.message });
    }

    const top: BlockReasonAgg[] = [...byRule.entries()]
      .map(([rule, v]) => ({ rule, count: v.count, message: v.message }))
      .sort((a, b) =>
        a.count !== b.count
          ? b.count - a.count
          : a.rule < b.rule
            ? -1
            : 1,
      );

    const dow = DOW_NAMES[plan.shift.dow];
    const detail =
      top.length > 0
        ? top.map((r) => `${r.count} ${r.message}`).join("; ")
        : "no eligible drivers available";
    out.push({
      shift_id: plan.shift.shift_id,
      top_block_reasons: top,
      summary:
        `${dow} ${plan.shift.date} ${clock(plan.shift.start_min)} ` +
        `${plan.shift.route_type} route uncovered: ${detail}.`,
    });
  }
  return out;
}

/**
 * Per-driver "why didn't this driver get any shifts" diagnostics. Only
 * drivers with zero assignments are listed. `eligible_somewhere` true means
 * the driver was schedulable but every shift went to another driver.
 */
export function buildUnscheduledDrivers(
  ctx: EngineContext,
  ws: WorkingSchedule,
): UnscheduledDriver[] {
  const out: UnscheduledDriver[] = [];
  for (const driver of ctx.drivers) {
    const state = ws.states.get(driver.driver_id);
    if (!state || state.assigned.length > 0) continue;

    let eligibleSomewhere = false;
    const byRule = new Map<string, { count: number; message: string }>();
    for (const plan of ws.plans) {
      if (plan.closed) continue;
      const cell = evaluateEligibility(plan.shift, driver, state, ctx);
      if (cell.eligible) {
        eligibleSomewhere = true;
        continue;
      }
      // Only aggregate reasons for shifts that ended up UNCOVERED — those
      // are the shifts the driver could plausibly have filled. Being
      // blocked from a shift another driver took is not informative.
      if (plan.assignedDriverId === null) {
        const reason = cell.block_reasons[0];
        const entry = byRule.get(reason.rule);
        if (entry) entry.count += 1;
        else byRule.set(reason.rule, { count: 1, message: reason.message });
      }
    }

    out.push({
      driver_id: driver.driver_id,
      eligible_somewhere: eligibleSomewhere,
      block_reasons: [...byRule.entries()]
        .map(([rule, v]) => ({ rule, count: v.count, message: v.message }))
        .sort((a, b) =>
          a.count !== b.count ? b.count - a.count : a.rule < b.rule ? -1 : 1,
        ),
    });
  }
  return out;
}
