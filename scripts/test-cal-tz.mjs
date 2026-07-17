// DST-transition tests for dashboard/cal-tz.mjs (calendar 100-list #80).
// The calendar's wall-clock ↔ instant conversions must hold across spring-
// forward gaps, fall-back ambiguity, half-hour zones, no-DST zones and the
// southern hemisphere — these are the exact edges where "9:00 AM" quietly
// becomes 8 or 10 and a candidate misses an interview.
import { localToISO, wallClock, tzOffsetMinutes, allTimeZones } from "../dashboard/cal-tz.mjs";

let failures = 0;
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { console.log("  ✓", label); return; }
  failures++;
  console.error("  ✗", label, "\n    expected:", e, "\n    actual:  ", a);
}
const hm = (iso, tz) => { const w = wallClock(iso, tz); return `${String(w.h).padStart(2, "0")}:${String(w.mi).padStart(2, "0")}`; };

console.log("localToISO · plain conversions");
eq(localToISO("2026-07-17", "09:00", "America/Chicago"), "2026-07-17T14:00:00.000Z", "summer CDT is UTC-5");
eq(localToISO("2026-01-15", "09:00", "America/Chicago"), "2026-01-15T15:00:00.000Z", "winter CST is UTC-6");
eq(localToISO("2026-07-17", "09:00", "Asia/Kolkata"), "2026-07-17T03:30:00.000Z", "half-hour zone (UTC+5:30)");
eq(localToISO("2025-12-31", "23:30", "Asia/Tokyo"), "2025-12-31T14:30:00.000Z", "year boundary stays on the right day");

console.log("localToISO · US spring forward (2026-03-08, America/Chicago)");
eq(localToISO("2026-03-08", "01:30", "America/Chicago"), "2026-03-08T07:30:00.000Z", "01:30 is still CST (UTC-6)");
eq(localToISO("2026-03-08", "03:30", "America/Chicago"), "2026-03-08T08:30:00.000Z", "03:30 is CDT (UTC-5)");
// 02:30 does not exist that night; the conversion lands one hour later, and
// the round-trip agrees with itself (no silent hour drift).
eq(localToISO("2026-03-08", "02:30", "America/Chicago"), "2026-03-08T08:30:00.000Z", "nonexistent 02:30 maps forward to 03:30 local");
eq(hm(localToISO("2026-03-08", "01:30", "America/Chicago"), "America/Chicago"), "01:30", "round-trip before the gap");
eq(hm(localToISO("2026-03-08", "03:30", "America/Chicago"), "America/Chicago"), "03:30", "round-trip after the gap");

console.log("localToISO · US fall back (2026-11-01, America/Chicago)");
eq(localToISO("2026-11-01", "01:30", "America/Chicago"), "2026-11-01T06:30:00.000Z", "ambiguous 01:30 resolves to the FIRST occurrence (CDT)");
eq(hm("2026-11-01T06:30:00.000Z", "America/Chicago"), "01:30", "…which still reads 01:30 on the wall");
eq(hm("2026-11-01T07:30:00.000Z", "America/Chicago"), "01:30", "the second 01:30 (CST) also reads 01:30 — ambiguity is real");
eq(localToISO("2026-11-01", "03:00", "America/Chicago"), "2026-11-01T09:00:00.000Z", "post-transition CST is UTC-6 again");

console.log("tzOffsetMinutes");
eq(tzOffsetMinutes("America/Chicago", "2026-01-15T12:00:00Z"), -360, "Chicago January = UTC-6");
eq(tzOffsetMinutes("America/Chicago", "2026-07-15T12:00:00Z"), -300, "Chicago July = UTC-5");
eq(tzOffsetMinutes("America/Phoenix", "2026-01-15T12:00:00Z"), -420, "Phoenix January = UTC-7 (no DST)");
eq(tzOffsetMinutes("America/Phoenix", "2026-07-15T12:00:00Z"), -420, "Phoenix July = UTC-7 (no DST)");
eq(tzOffsetMinutes("Europe/London", "2026-01-15T12:00:00Z"), 0, "London January = UTC");
eq(tzOffsetMinutes("Europe/London", "2026-07-15T12:00:00Z"), 60, "London July = UTC+1");
eq(tzOffsetMinutes("Australia/Sydney", "2026-01-15T12:00:00Z"), 660, "Sydney January = UTC+11 (southern-hemisphere DST)");
eq(tzOffsetMinutes("Australia/Sydney", "2026-07-15T12:00:00Z"), 600, "Sydney July = UTC+10");

console.log("wallClock");
eq(wallClock("2026-07-17T14:00:00Z", "America/Chicago"), { y: 2026, mo: 7, d: 17, h: 9, mi: 0, s: 0 }, "instant → Chicago wall parts");
eq(wallClock("2026-07-17T05:00:00Z", "America/Chicago"), { y: 2026, mo: 7, d: 17, h: 0, mi: 0, s: 0 }, "midnight normalizes to hour 0 (not 24)");
eq(wallClock("2026-07-17T04:59:00Z", "America/Chicago").d, 16, "one minute earlier is still the previous day");

console.log("allTimeZones");
const zones = allTimeZones();
eq(zones.length > 100, true, "full IANA list available (" + zones.length + " zones)");
eq(zones.includes("America/Chicago"), true, "contains America/Chicago");
eq(zones.includes("Asia/Kolkata") || zones.includes("Asia/Calcutta"), true, "contains India (Kolkata/Calcutta by ICU vintage)");

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log("\nAll cal-tz tests passed.");
