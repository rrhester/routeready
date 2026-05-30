// ============================================================================
// @routeready/flex-capacity — public surface
// ============================================================================
// Import from here. The engine is pure and portable: it runs in a Supabase
// Edge Function today and can move to a Fly.io worker for heavier simulation
// workloads with no code changes (see README "Fly.io Migration Strategy").
// ============================================================================

export * from "./types.ts";
export { canWorkAtTier, passesHardConstraints, isExtraDay, meetsCertForRoute } from "./helpers.ts";
export { computeFlexCapacity, buildKpi, coachingFor } from "./engine.ts";
export {
  applyScenario,
  runWhatIf,
  type Scenario,
  type ScenarioKind,
  type WhatIfResult,
  type WhatIfStatus,
  type RiskLevel,
  type DriverDays,
} from "./whatif.ts";
export {
  buildFlexInput,
  dayKeyFromISO,
  type BuildOptions,
  type DriverRow,
  type TimeOffRow,
  type ShiftRow,
  type DemandRow,
  type SchedulingSettings,
} from "./adapter.ts";
