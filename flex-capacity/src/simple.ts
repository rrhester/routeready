// ============================================================================
// Flex Capacity — Simplified scenario materialization
// ============================================================================
// The what-if UI speaks in counts ("3 callouts", "2 drivers quit", "+6
// routes/day") — it doesn't know driver ids. materializeScenario() turns
// those counts into a full Scenario against the input's own roster,
// DETERMINISTICALLY, so the same request always simulates the same drivers
// (no randomness — reruns are comparable and results are explainable).
//
// Selection policy: most-impactful-first. Attrition removes the drivers
// carrying the most scheduled days (losing your workhorses is the honest
// stress test); callouts hit the next-most-scheduled drivers on their first
// scheduled day (a callout only matters on a day they were counted on).
// ============================================================================

import type { FlexDriver, FlexInput } from "./types.ts";
import type { Scenario, ScenarioKind } from "./whatif.ts";

/** What a slider panel can express without knowing driver ids. */
export interface SimpleScenario {
  /** Add this many routes to every day's target. */
  addRoutesPerDay?: number;
  /** Multiply every day's target (e.g. 1.25 for Prime Week). */
  routeMultiplier?: number;
  /** N drivers call out on a day they were scheduled to work. */
  calloutCount?: number;
  /** N drivers leave the roster entirely. */
  attritionCount?: number;
  label?: string;
}

/** Stable most-impactful-first ordering: scheduled load desc, then id. */
function byImpact(a: FlexDriver, b: FlexDriver): number {
  const load = b.scheduledDays.length - a.scheduledDays.length;
  return load !== 0 ? load : a.id.localeCompare(b.id);
}

function clampCount(n: unknown, max: number): number {
  const v = Math.floor(Number(n) || 0);
  return Math.max(0, Math.min(max, v));
}

export function materializeScenario(input: FlexInput, simple: SimpleScenario): Scenario {
  const pool = [...input.drivers].filter((d) => d.active).sort(byImpact);

  const attritionCount = clampCount(simple.attritionCount, pool.length);
  const removed = pool.slice(0, attritionCount);
  const removeDriverIds = removed.map((d) => d.id);

  // Callouts come from the drivers still on the roster after attrition, and
  // only from drivers who have a day to lose (scheduled first, else an
  // available day — a callout from someone contributing nothing is a no-op
  // and would silently understate the scenario).
  const remaining = pool.slice(attritionCount)
    .filter((d) => d.scheduledDays.length > 0 || d.available.length > 0);
  const calloutCount = clampCount(simple.calloutCount, remaining.length);
  const calloutDriverDays = remaining.slice(0, calloutCount).map((d) => ({
    driverId: d.id,
    days: [d.scheduledDays[0] ?? d.available[0]],
  }));

  const addRoutesPerDay = Math.max(0, Math.round(Number(simple.addRoutesPerDay) || 0));
  const routeMultiplier = Number(simple.routeMultiplier) > 0 ? Number(simple.routeMultiplier) : 1;

  // Kind is descriptive only — pick the dominant effect for the label.
  const kind: ScenarioKind = attritionCount > 0 ? "driver_attrition"
    : calloutCount > 0 ? "callout_event"
    : routeMultiplier > 1 ? "prime_week"
    : "route_growth";

  return {
    kind,
    label: simple.label,
    ...(addRoutesPerDay ? { addRoutesPerDay } : {}),
    ...(routeMultiplier !== 1 ? { routeMultiplier } : {}),
    ...(removeDriverIds.length ? { removeDriverIds } : {}),
    ...(calloutDriverDays.length ? { calloutDriverDays } : {}),
    growthRoutesPerDay: addRoutesPerDay,
  };
}
