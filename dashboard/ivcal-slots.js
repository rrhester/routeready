// ─────────────────────────────────────────────────────────────────────────
// ivcal-slots.js · pure slot math for the interview calendar.
//
// Extracted from live.js so the availability logic that drives the
// grid shading and the day-header capacity counts is (a) unit-tested
// (scripts/test-ivcal-slots.mjs, wired into `npm test` → CI) and
// (b) guaranteed to layer Holidays & date overrides over the weekly
// schedule the SAME way the server does (0407 interview_open_slots /
// book_interview_slot): an override row for a date fully replaces that
// date's weekly windows — closed → no windows, custom hours → exactly
// those windows.
//
// No DOM, no Supabase, no Date.now() — everything is passed in.
//
// Shapes (mirroring the DB):
//   weekly windows   [{ weekday: 0-6, start_min, end_min, capacity }]
//   override rows    [{ override_date: "YYYY-MM-DD", is_closed: bool,
//                       windows: [{ start_min, end_min, capacity }] | null }]
// ─────────────────────────────────────────────────────────────────────────

/** Normalize one window row to ints with a >=1 capacity. Returns null
 *  for degenerate rows (missing/reversed times) so bad data can't
 *  produce phantom slots. */
function normWindow(w) {
  if (!w) return null;
  const start = Number(w.start_min), end = Number(w.end_min);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  const cap = Number(w.capacity);
  return { start_min: start, end_min: end, capacity: Number.isFinite(cap) && cap > 1 ? Math.floor(cap) : 1 };
}

/** The windows in force on one calendar date, override-aware.
 *  @param dateISO  "YYYY-MM-DD" (a DSP-timezone local date)
 *  @param weekday  0-6 for that date (caller derives it — keeps this
 *                  module free of timezone logic)
 *  @param weekly   weekly window rows (see shapes above)
 *  @param overrides override rows (see shapes above)
 *  @returns array of { start_min, end_min, capacity } — [] on a closed day
 */
export function effectiveWindows(dateISO, weekday, weekly, overrides) {
  const ovr = (overrides || []).find(o => o && o.override_date === dateISO);
  if (ovr) {
    if (ovr.is_closed) return [];
    return (Array.isArray(ovr.windows) ? ovr.windows : []).map(normWindow).filter(Boolean);
  }
  return (weekly || []).filter(w => w && w.weekday === weekday).map(normWindow).filter(Boolean);
}

/** True when the date is explicitly closed by an override (as opposed
 *  to simply having no weekly windows). Lets the UI say "Closed"
 *  instead of "—". */
export function isClosedDate(dateISO, overrides) {
  const ovr = (overrides || []).find(o => o && o.override_date === dateISO);
  return !!(ovr && ovr.is_closed);
}

/** Slot start minutes for one window at the configured grid:
 *  start_min + k·(slot+buffer), each slot fully inside the window —
 *  identical to the server's generation and off-grid rejection. */
export function slotStarts(win, slotMin, bufferMin) {
  const w = normWindow(win);
  const slot = Number(slotMin) > 0 ? Number(slotMin) : 30;
  const step = Math.max(slot + (Number(bufferMin) > 0 ? Number(bufferMin) : 0), 1);
  const out = [];
  if (!w) return out;
  for (let mm = w.start_min; mm + slot <= w.end_min; mm += step) out.push(mm);
  return out;
}

/** Total bookable-slot capacity across a day's effective windows
 *  (slots per window × window capacity). */
export function daySlotCapacity(windows, slotMin, bufferMin) {
  let cap = 0;
  for (const w of windows || []) {
    const n = slotStarts(w, slotMin, bufferMin).length;
    const c = normWindow(w);
    cap += n * (c ? c.capacity : 0);
  }
  return cap;
}
