// Shared test fixtures.
import type { DayKey, FlexDriver, FlexInput, FlexRouteDay } from "../src/types.ts";

export const WEEKDAYS: DayKey[] = ["mon", "tue", "wed", "thu", "fri"];

/** A fully-flexible weekday driver with sensible defaults. Override as needed. */
export function mkDriver(over: Partial<FlexDriver> & { id: string }): FlexDriver {
  return {
    active: true,
    available: [...WEEKDAYS],
    preferred: [...WEEKDAYS],
    fifthDayOptIn: false,
    pto: [],
    scheduledDays: [],
    scheduledHours: 0,
    weeklyHourCap: 50,
    blockHours: 10,
    maxDaysPerWeek: 5,
    certifications: { dot: false, xl: false, edv: false },
    ...over,
  };
}

/** Build N identical default drivers d0..d{N-1}. */
export function mkDrivers(n: number, over: Partial<FlexDriver> = {}): FlexDriver[] {
  return Array.from({ length: n }, (_, i) => mkDriver({ id: `d${i}`, ...over }));
}

/** Route demand of `target` for each given day. */
export function mkRoutes(target: number, days: DayKey[] = WEEKDAYS, routeType?: string): FlexRouteDay[] {
  return days.map((day) => ({ day, routeTarget: target, routeType: routeType as FlexRouteDay["routeType"] }));
}

export function mkInput(over: Partial<FlexInput> & { drivers: FlexDriver[]; routes: FlexRouteDay[] }): FlexInput {
  return { weekStart: "2026-05-25", ...over };
}
