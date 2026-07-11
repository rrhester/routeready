// Unit tests for dashboard/ivcal-slots.js — the pure availability math
// behind the interview calendar's shading and day-header capacity.
// The invariant that matters: this module must layer Holidays & date
// overrides over the weekly schedule EXACTLY like the server does
// (0407 interview_open_slots / book_interview_slot), because the UI
// paints promises the server has to keep.
import { effectiveWindows, isClosedDate, slotStarts, daySlotCapacity } from "../dashboard/ivcal-slots.js";

let failures = 0;
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { console.log("  ✓", label); return; }
  failures++;
  console.error("  ✗", label, "\n    expected:", e, "\n    actual:  ", a);
}

const WEEKLY = [
  { weekday: 1, start_min: 600, end_min: 840, capacity: 1 },  // Mon 10-14
  { weekday: 3, start_min: 600, end_min: 840, capacity: 2 },  // Wed 10-14 ×2
  { weekday: 3, start_min: 900, end_min: 960, capacity: 1 },  // Wed 15-16
];
const OVERRIDES = [
  { override_date: "2026-07-13", is_closed: true, windows: null },                      // Mon closed (holiday)
  { override_date: "2026-07-15", is_closed: false, windows: [{ start_min: 480, end_min: 600, capacity: 1 }] }, // Wed one-off 8-10
  { override_date: "2026-07-18", is_closed: false, windows: [{ start_min: 540, end_min: 720, capacity: 1 }] }, // Sat opened 9-12
];

console.log("effectiveWindows");
eq(effectiveWindows("2026-07-20", 1, WEEKLY, OVERRIDES),
  [{ start_min: 600, end_min: 840, capacity: 1 }],
  "plain weekday uses the weekly schedule");
eq(effectiveWindows("2026-07-13", 1, WEEKLY, OVERRIDES), [],
  "closed override wipes the weekly windows");
eq(effectiveWindows("2026-07-15", 3, WEEKLY, OVERRIDES),
  [{ start_min: 480, end_min: 600, capacity: 1 }],
  "custom-hours override REPLACES the weekly windows (both of them)");
eq(effectiveWindows("2026-07-18", 6, WEEKLY, OVERRIDES),
  [{ start_min: 540, end_min: 720, capacity: 1 }],
  "override can open a day with no weekly windows at all");
eq(effectiveWindows("2026-07-19", 0, WEEKLY, OVERRIDES), [],
  "no weekly windows + no override = empty");
eq(effectiveWindows("2026-07-20", 1, WEEKLY, null),
  [{ start_min: 600, end_min: 840, capacity: 1 }],
  "null overrides tolerated");
eq(effectiveWindows("2026-07-20", 1, [{ weekday: 1, start_min: 840, end_min: 600 }], []), [],
  "reversed window rows are dropped, not trusted");

console.log("isClosedDate");
eq(isClosedDate("2026-07-13", OVERRIDES), true, "closed override reports closed");
eq(isClosedDate("2026-07-15", OVERRIDES), false, "custom-hours override is not closed");
eq(isClosedDate("2026-07-20", OVERRIDES), false, "no override is not closed");

console.log("slotStarts");
eq(slotStarts({ start_min: 600, end_min: 840 }, 30, 0),
  [600, 630, 660, 690, 720, 750, 780, 810],
  "30-min grid, no buffer: 8 slots in 4 hours");
eq(slotStarts({ start_min: 600, end_min: 840 }, 45, 15),
  [600, 660, 720, 780],
  "45-min slots + 15-min buffer step by 60; last start 780 (ends 825 ≤ 840)");
eq(slotStarts({ start_min: 600, end_min: 620 }, 30, 0), [],
  "window shorter than one slot yields nothing");
eq(slotStarts(null, 30, 0), [], "null window tolerated");

console.log("daySlotCapacity");
eq(daySlotCapacity(effectiveWindows("2026-07-20", 1, WEEKLY, OVERRIDES), 30, 0), 8,
  "Mon weekly: 8 slots");
eq(daySlotCapacity(effectiveWindows("2026-07-22", 3, WEEKLY, OVERRIDES), 30, 0), 18,
  "Wed weekly: 8 slots ×2 capacity + 2 slots ×1");
eq(daySlotCapacity(effectiveWindows("2026-07-13", 1, WEEKLY, OVERRIDES), 30, 0), 0,
  "closed override day: zero capacity");
eq(daySlotCapacity(effectiveWindows("2026-07-15", 3, WEEKLY, OVERRIDES), 30, 0), 4,
  "custom-hours override day: capacity from the override only");

if (failures) { console.error(`\n✗ ivcal-slots: ${failures} failure(s)`); process.exit(1); }
console.log("\n✓ ivcal-slots: all tests passed");
