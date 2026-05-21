// Test fixture builders.

import type {
  DriverInput,
  EngineInput,
  RawSettings,
  ShiftInput,
} from "../src/types.ts";

export function shift(
  over: Partial<ShiftInput> & { shift_id: string },
): ShiftInput {
  const date = over.date ?? "2026-05-25";
  return {
    date,
    start_time: `${date}T09:00`,
    route_type: "standard",
    ...over,
  };
}

export function driver(
  over: Partial<DriverInput> & { driver_id: string },
): DriverInput {
  return {
    first_name: "First",
    last_name: over.driver_id,
    status: "active",
    employment_type: "full_time",
    hire_date: "2020-01-01",
    license_expiration_date: "2030-01-01",
    ...over,
  };
}

export function input(over: Partial<EngineInput>): EngineInput {
  return {
    schedule_week_start: "2026-05-24", // a Sunday
    shifts: [],
    drivers: [],
    ...over,
  };
}

export function settings(over: RawSettings): RawSettings {
  return over;
}
