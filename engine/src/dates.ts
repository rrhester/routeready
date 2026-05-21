// Deterministic date/time helpers. All comparisons treat datetimes as
// DSP-local wall-clock values (no timezone math) — see SPEC Open Decision 1.

import { EngineError } from "./types.ts";

export const MS_PER_DAY = 86_400_000;
export const MS_PER_HOUR = 3_600_000;

export const DOW_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/;

export function isValidDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

/** Integer day index (days since epoch) for an ISO date. */
export function epochDay(date: string): number {
  if (!DATE_RE.test(date)) throw new EngineError(`Invalid date: ${date}`);
  const [y, m, d] = date.split("-").map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / MS_PER_DAY);
}

export function fromEpochDay(n: number): string {
  const dt = new Date(n * MS_PER_DAY);
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const d = String(dt.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function addDays(date: string, n: number): string {
  return fromEpochDay(epochDay(date) + n);
}

/** Whole-day difference (b - a). */
export function daysBetween(a: string, b: string): number {
  return epochDay(b) - epochDay(a);
}

/** Day-of-week, 0 = Sunday .. 6 = Saturday. */
export function dayOfWeek(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Start date of the week containing `date` given a configurable week-start. */
export function weekStart(date: string, weekStartDay: number): string {
  const back = (dayOfWeek(date) - weekStartDay + 7) % 7;
  return addDays(date, -back);
}

/** Parse a DSP-local ISO datetime into epoch milliseconds (UTC-keyed). */
export function parseDateTime(s: string): number {
  const m = DATETIME_RE.exec(s);
  if (!m) throw new EngineError(`Invalid datetime: ${s}`);
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], m[6] ? +m[6] : 0);
}

/** Minutes-of-day of a datetime's wall-clock time. */
export function timeOfDayMinutes(s: string): number {
  const m = DATETIME_RE.exec(s);
  if (!m) throw new EngineError(`Invalid datetime: ${s}`);
  return +m[4] * 60 + +m[5];
}

/** Parse "HH:MM" into minutes-of-day. */
export function clockToMinutes(s: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) throw new EngineError(`Invalid time-of-day: ${s}`);
  return +m[1] * 60 + +m[2];
}

/** True when `date` lies within [start, end] inclusive (lexical ISO compare). */
export function inRange(date: string, start: string, end: string): boolean {
  return date >= start && date <= end;
}
