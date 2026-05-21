// RouteReady Driver Scheduling Engine — public entry point.
//
// A deterministic, explainable, rule-based engine that assigns drivers to
// existing open shifts. See engine/SPEC.md for the full specification.

export { runEngine } from "./orchestrator.ts";
export { validateSettings } from "./settings.ts";
export { ENGINE_VERSION, EngineError } from "./types.ts";
export type {
  AssignmentSource,
  DriverInput,
  DriverTotal,
  EngineInput,
  HistoryShift,
  RawSettings,
  RouteType,
  ScheduleResult,
  Settings,
  ShiftInput,
  SummaryMetrics,
  Violation,
  Warning,
} from "./types.ts";
