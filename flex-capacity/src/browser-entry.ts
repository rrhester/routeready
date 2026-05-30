// Browser bundle entry for the Flex Capacity Engine.
//
// Bundled to dashboard/flex-capacity.js (esbuild, ESM) so the schedule KPI
// strip uses the EXACT same tested engine as the edge function — no logic
// duplication, no drift. The dashboard builds a FlexInput from the data it
// already has in memory and calls computeFlexCapacity()/runWhatIf().
//
// Rebuild: cd flex-capacity && npm run build:dashboard
export { computeFlexCapacity, buildKpi, coachingFor } from "./engine.ts";
export { runWhatIf, applyScenario } from "./whatif.ts";
export { DAY_KEYS, DEFAULT_CONFIG } from "./types.ts";
export type {
  DayKey,
  FlexDriver,
  FlexInput,
  FlexResult,
  FlexRouteDay,
} from "./types.ts";
export type { Scenario, WhatIfResult } from "./whatif.ts";
