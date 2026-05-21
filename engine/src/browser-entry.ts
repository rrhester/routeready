// Browser bundle entry point. Bundled by `npm run build:dashboard` into
// dashboard/scheduling-engine.js, which dashboard/live.js imports directly.

export { runEngine } from "./orchestrator.ts";
export { planScheduleWeek } from "./adapters/dashboard.ts";
export { ENGINE_VERSION, EngineError } from "./types.ts";
export type {
  DashboardDriver,
  DashboardPto,
  DashboardRules,
  DashboardShift,
  PlanPayload,
} from "./adapters/dashboard.ts";
export type { ScheduleResult } from "./types.ts";
