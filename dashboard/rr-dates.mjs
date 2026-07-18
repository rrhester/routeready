// Shared date helpers for the dashboard (project-review PR#9/#15).
//
// Extracted from live.js (which had two byte-identical ISO-week
// implementations and a UTC-based fmtIsoDate that computed TOMORROW's date
// for US operators every evening). Pure functions, unit-tested in
// scripts/test-rr-dates.mjs — the cal-tz.mjs / ivcal-layout.js precedent.

// Local-calendar ISO date (YYYY-MM-DD). MUST use local components, not
// toISOString(): the old `d.toISOString().slice(0,10)` returned the UTC
// date, so `fmtIsoDate(new Date())` used as "today" was a day ahead for
// any operator west of UTC after ~7-8pm local — wrong effective dates on
// tasks / attendance / status changes.
export function fmtIsoDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Sunday-anchored start of week (00:00 local). Named startOfWeek because
// that is what it is — the old `startOfWeekMonday` alias lied (it became
// Sunday-anchored at the 0265 convention change) and misled anyone
// touching week math.
export function startOfWeek(d) {
  const date = new Date(d);
  const day = date.getDay();            // 0=Sun … 6=Sat
  date.setDate(date.getDate() - day);   // back up to the prior Sunday
  date.setHours(0, 0, 0, 0);
  return date;
}

export function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

// ISO-8601 week number (weeks start Monday; week 1 contains the first
// Thursday). Was duplicated byte-for-byte as isoWeek() and
// isoWeekNumber() in live.js.
export function isoWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}
