// Pure timezone math for the interview calendar (calendar 100-list #78–#80).
// Extracted from live.js so the DST behavior is unit-testable in node
// (scripts/test-cal-tz.mjs) — the calendar promises wall-clock times in the
// DSP's zone, and these conversions are where DST bugs would hide.
//
// No dependencies: everything derives from Intl.DateTimeFormat, the same
// engine the browser uses to render the labels.

// Wall clock of an instant in a zone, as numeric parts.
export function wallClock(instant, tz) {
  const d = instant instanceof Date ? instant : new Date(instant);
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false, year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(d).reduce((a, x) => (a[x.type] = x.value, a), {});
  // Intl renders midnight as "24" in some engines' h23 fallback — normalize.
  const hh = +p.hour === 24 ? 0 : +p.hour;
  return { y: +p.year, mo: +p.month, d: +p.day, h: hh, mi: +p.minute, s: +p.second };
}

// Signed offset (minutes east of UTC) of a zone at an instant.
export function tzOffsetMinutes(tz, instant) {
  const d = instant instanceof Date ? instant : new Date(instant);
  const w = wallClock(d, tz);
  const asUTC = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
  return Math.round((asUTC - d.getTime()) / 60000);
}

// "YYYY-MM-DD" + "HH:MM" wall time in tz → UTC ISO string.
// Two-pass offset resolution: the naive single-pass version (which this
// replaces) guessed the offset at the WRONG instant and landed an hour off
// for wall times in the first hours after a DST transition. DST edges
// (documented by the tests):
//   • a nonexistent spring-forward time maps 1h later (02:30 → 03:30 local);
//   • an ambiguous fall-back time resolves to the FIRST occurrence (DST).
export function localToISO(date, time, tz) {
  const [Y, M, D] = date.split("-").map(Number);
  const [h, m] = time.split(":").map(Number);
  const desired = Date.UTC(Y, M - 1, D, h, m);
  const wallOf = (ms) => {
    const w = wallClock(new Date(ms), tz);
    return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi);
  };
  const off1 = tzOffsetMinutes(tz, new Date(desired));
  let c = desired - off1 * 60000;
  if (wallOf(c) !== desired) {
    const off2 = tzOffsetMinutes(tz, new Date(c));
    const c2 = desired - off2 * 60000;
    // c2 matches ⇒ the first guess straddled the transition. Neither
    // matching ⇒ the time doesn't exist (spring-forward gap): take the
    // later instant, i.e. shift forward by the gap.
    c = wallOf(c2) === desired ? c2 : Math.max(c, c2);
  }
  return new Date(c).toISOString();
}

// All IANA zones the runtime knows, with a small fallback for engines
// without Intl.supportedValuesOf (pre-2022). Used by the settings pickers.
export function allTimeZones() {
  try {
    if (typeof Intl.supportedValuesOf === "function") {
      const z = Intl.supportedValuesOf("timeZone");
      if (Array.isArray(z) && z.length) return z;
    }
  } catch (_) { /* fall through */ }
  return [
    "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles",
    "America/Phoenix", "America/Anchorage", "Pacific/Honolulu", "America/Puerto_Rico",
  ];
}
