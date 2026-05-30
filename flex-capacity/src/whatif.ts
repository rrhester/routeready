// ============================================================================
// Flex Capacity — What-If Planning Engine
// ============================================================================
// Runs hypothetical scenarios on top of the SAME capacity model. Scenarios
// NEVER mutate live data: every scenario is applied to a deep clone of the
// input (temporary simulation overrides only), then scored with the core
// engine. The output answers "can the DSP cover this?" with actionable
// shortages, remaining capacity, hiring recommendations, and risk signals.
// ============================================================================

import {
  DEFAULT_CONFIG,
  type DayCapacity,
  type DayKey,
  type DriverCertifications,
  type FlexConfig,
  type FlexDriver,
  type FlexInput,
} from "./types.ts";
import { computeFlexCapacity } from "./engine.ts";

// ── Scenario definitions ────────────────────────────────────────────────────

export type ScenarioKind =
  | "route_growth"
  | "prime_week"
  | "peak_planning"
  | "hiring_plan"
  | "pto_event"
  | "callout_event"
  | "driver_attrition"
  | "certification_loss"
  | "attendance_risk";

/** A driver-scoped, day-scoped event (PTO / callout). */
export interface DriverDays {
  driverId: string;
  days: DayKey[];
}

/**
 * A what-if scenario. Fields are additive overrides — set only the ones a
 * given scenario needs. Multiple effects can be combined in one scenario.
 */
export interface Scenario {
  kind: ScenarioKind;
  label?: string;

  // Demand overrides ────────────────────────────────────────────────
  /** route_growth: add this many routes to EVERY day's target. */
  addRoutesPerDay?: number;
  /** prime_week / peak_planning: multiply every day's target (e.g. 1.5). */
  routeMultiplier?: number;

  // Roster overrides ────────────────────────────────────────────────
  /** hiring_plan: extra drivers to add to the pool. */
  addDrivers?: FlexDriver[];
  /** driver_attrition: driver ids to remove from the pool. */
  removeDriverIds?: string[];

  // Event overrides ─────────────────────────────────────────────────
  /** pto_event: add PTO days to specific drivers. */
  ptoDriverDays?: DriverDays[];
  /** callout_event: drivers unavailable on specific days (treated as off). */
  calloutDriverDays?: DriverDays[];
  /** certification_loss: revoke a cert from a driver. */
  certLoss?: { driverId: string; cert: keyof DriverCertifications }[];
  /** attendance_risk: exclude drivers whose attendanceScore is below this. */
  attendanceRiskThreshold?: number;

  /** Projected daily route growth used for coaching color (defaults to the
   *  scenario's own added routes/day when omitted). */
  growthRoutesPerDay?: number;
}

// ── What-If output ──────────────────────────────────────────────────────────

export type WhatIfStatus = "green" | "yellow" | "red" | "critical";
export type RiskLevel = "low" | "medium" | "high";

export interface WhatIfResult {
  scenario: Scenario;
  canCover: boolean;
  status: WhatIfStatus;
  /** Per-day uncoverable gap at MAXIMUM capacity (required − maximumDrivers). */
  dailyShortages: { day: DayKey; shortage: number }[];
  /** Sum of dailyShortages across the week. */
  weeklyShortage: number;
  /** Additional routes/day still available after the scenario, per tier. */
  comfortableRemaining: number;
  stretchRemaining: number;
  maximumRemaining: number;
  /** Drivers to hire to restore sustainable (Comfortable) coverage on the
   *  worst day. */
  driversNeeded: number;
  recommendedFtHires: number;
  recommendedPtHires: number;
  otRisk: RiskLevel;
  scheduleDisruptionRisk: RiskLevel;
  /** 0–100 heuristic confidence in the "canCover" verdict. */
  confidenceScore: number;
}

// ── Non-mutating scenario application ────────────────────────────────────────

/** Deep clone a driver so scenario edits never touch the caller's objects. */
function cloneDriver(d: FlexDriver): FlexDriver {
  return {
    ...d,
    available: [...d.available],
    preferred: [...d.preferred],
    pto: [...d.pto],
    scheduledDays: [...d.scheduledDays],
    certifications: { ...d.certifications },
    affinity: d.affinity ? { ...d.affinity } : undefined,
  };
}

/**
 * Produce a NEW FlexInput with the scenario's overrides applied. The original
 * input is never mutated (temporary simulation only).
 */
export function applyScenario(input: FlexInput, scenario: Scenario): FlexInput {
  // 1. Roster: clone, drop attrition, then add hires.
  const removed = new Set(scenario.removeDriverIds ?? []);
  let drivers: FlexDriver[] = input.drivers
    .filter((d) => !removed.has(d.id))
    .map(cloneDriver);

  // 2. PTO + callout events → add off-days to the matching drivers.
  const addOffDays = (list: DriverDays[] | undefined) => {
    if (!list) return;
    for (const ev of list) {
      const d = drivers.find((x) => x.id === ev.driverId);
      if (!d) continue;
      for (const day of ev.days) if (!d.pto.includes(day)) d.pto.push(day);
    }
  };
  addOffDays(scenario.ptoDriverDays);
  addOffDays(scenario.calloutDriverDays);

  // 3. Certification loss.
  for (const cl of scenario.certLoss ?? []) {
    const d = drivers.find((x) => x.id === cl.driverId);
    if (d) d.certifications = { ...d.certifications, [cl.cert]: false };
  }

  // 4. Attendance risk → drop high-risk drivers from the simulated pool.
  if (typeof scenario.attendanceRiskThreshold === "number") {
    const thr = scenario.attendanceRiskThreshold;
    drivers = drivers.filter(
      (d) => typeof d.attendanceScore !== "number" || d.attendanceScore >= thr,
    );
  }

  // 5. Hiring plan → append simulated new hires (cloned to be safe).
  if (scenario.addDrivers) drivers.push(...scenario.addDrivers.map(cloneDriver));

  // 6. Demand overrides → multiply then add (peak/prime then growth).
  const mult = scenario.routeMultiplier ?? 1;
  const add = scenario.addRoutesPerDay ?? 0;
  const routes = input.routes.map((r) => ({
    ...r,
    routeTarget: Math.max(0, Math.round(r.routeTarget * mult) + add),
  }));

  return { weekStart: input.weekStart, drivers, routes, config: input.config };
}

// ── Scoring ─────────────────────────────────────────────────────────────────

function tierCoversAllDays(days: DayCapacity[], pick: (d: DayCapacity) => number): boolean {
  return days.every((d) => pick(d) >= d.requiredRoutes);
}

function riskFromStatus(status: WhatIfStatus): RiskLevel {
  switch (status) {
    case "green":
      return "low";
    case "yellow":
      return "medium";
    default:
      return "high"; // red + critical
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}

/**
 * Run a scenario and score it. Pure: applies the scenario to a clone, computes
 * capacity, and derives the planning verdict.
 */
export function runWhatIf(input: FlexInput, scenario: Scenario): WhatIfResult {
  const cfg: FlexConfig = { ...DEFAULT_CONFIG, ...(input.config ?? {}) };
  const simInput = applyScenario(input, scenario);
  const growth = scenario.growthRoutesPerDay ?? scenario.addRoutesPerDay ?? 0;
  const result = computeFlexCapacity(simInput, growth);
  const days = result.days;

  // Coverage at each tier (every day must be covered).
  const coveredComfortable = tierCoversAllDays(days, (d) => d.comfortableDrivers);
  const coveredStretch = tierCoversAllDays(days, (d) => d.stretchDrivers);
  const coveredMaximum = tierCoversAllDays(days, (d) => d.maximumDrivers);

  const status: WhatIfStatus = coveredComfortable
    ? "green"
    : coveredStretch
      ? "yellow"
      : coveredMaximum
        ? "red"
        : "critical";
  const canCover = coveredMaximum;

  // Uncoverable gaps at MAXIMUM capacity (the true shortfall).
  const dailyShortages = days.map((d) => ({
    day: d.day,
    shortage: Math.max(0, d.requiredRoutes - d.maximumDrivers),
  }));
  const weeklyShortage = dailyShortages.reduce((s, x) => s + x.shortage, 0);

  // Drivers needed = worst day's gap to reach SUSTAINABLE (comfortable)
  // coverage — that's the honest hiring trigger (cover the peak comfortably).
  const driversNeeded = days.reduce(
    (m, d) => Math.max(m, Math.max(0, d.requiredRoutes - d.comfortableDrivers)),
    0,
  );
  // Split hires to the 85% FT target (composition only — capacity itself
  // never depends on FT/PT).
  const recommendedFtHires = Math.round(driversNeeded * cfg.hireFullTimeShare);
  const recommendedPtHires = driversNeeded - recommendedFtHires;

  const otRisk = riskFromStatus(status);
  const scheduleDisruptionRisk = riskFromStatus(status);

  // Confidence: anchored on status, nudged by how much MAXIMUM headroom
  // remains over demand (more slack ⇒ more confident in the verdict).
  const base = status === "green" ? 90 : status === "yellow" ? 70 : status === "red" ? 45 : 20;
  const slackBonus = clamp(Math.round(result.weekly.weeklyMaximumRouteIncrease), 0, 10);
  const shortagePenalty = clamp(weeklyShortage, 0, 15);
  const confidenceScore = clamp(base + slackBonus - shortagePenalty, 0, 100);

  return {
    scenario,
    canCover,
    status,
    dailyShortages,
    weeklyShortage,
    comfortableRemaining: result.kpi.comfortableRoutesAvailable,
    stretchRemaining: result.kpi.stretchRoutesAvailable,
    maximumRemaining: result.kpi.maximumRoutesAvailable,
    driversNeeded,
    recommendedFtHires,
    recommendedPtHires,
    otRisk,
    scheduleDisruptionRisk,
    confidenceScore,
  };
}
