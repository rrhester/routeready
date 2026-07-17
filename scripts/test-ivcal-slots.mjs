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

console.log("property tests · seeded random schedules (#94)");
// Deterministic PRNG so any failure reproduces from its seed.
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
let propFailures = 0;
const dates = ["2026-07-13", "2026-07-14", "2026-07-15", "2026-07-16", "2026-07-17", "2026-07-18", "2026-07-19"];
for (let seed = 1; seed <= 300; seed++) {
  const rnd = mulberry32(seed * 7919);
  // Random weekly schedule.
  const weekly = [];
  const nw = Math.floor(rnd() * 5);
  for (let i = 0; i < nw; i++) {
    const start = 6 * 60 + Math.floor(rnd() * 20) * 30;
    weekly.push({ weekday: Math.floor(rnd() * 7), start_min: start,
                  end_min: start + 30 + Math.floor(rnd() * 12) * 30,
                  capacity: 1 + Math.floor(rnd() * 3) });
  }
  // Random overrides over the fixed week above (weekday of dates[i] = (1+i)%7).
  const overrides = [];
  const no = Math.floor(rnd() * 3);
  for (let i = 0; i < no; i++) {
    const date = dates[Math.floor(rnd() * dates.length)];
    if (overrides.some(o => o.override_date === date)) continue;
    if (rnd() < 0.5) overrides.push({ override_date: date, is_closed: true, windows: null });
    else {
      const s = 8 * 60 + Math.floor(rnd() * 8) * 30;
      overrides.push({ override_date: date, is_closed: false,
                       windows: [{ start_min: s, end_min: s + 60 + Math.floor(rnd() * 6) * 30, capacity: 1 + Math.floor(rnd() * 2) }] });
    }
  }
  const slotMin = [15, 20, 30, 45, 60][Math.floor(rnd() * 5)];
  const bufMin = [0, 5, 10, 15][Math.floor(rnd() * 4)];
  const step = slotMin + bufMin;

  for (let di = 0; di < dates.length; di++) {
    const date = dates[di];
    const weekday = new Date(date + "T12:00:00Z").getUTCDay();
    const wins = effectiveWindows(date, weekday, weekly, overrides);
    const ovr = overrides.find(o => o.override_date === date);

    // Invariant 1: a closed date yields no windows and zero capacity.
    if (isClosedDate(date, overrides) && (wins.length || daySlotCapacity(wins, slotMin, bufMin) !== 0)) {
      propFailures++; console.error(`  seed ${seed} ${date}: closed date produced windows`); continue;
    }
    // Invariant 2: a custom-hours override REPLACES the weekly windows.
    if (ovr && !ovr.is_closed && JSON.stringify(wins.map(w => [w.start_min, w.end_min])) !==
        JSON.stringify((ovr.windows || []).filter(w => w.end_min > w.start_min).map(w => [w.start_min, w.end_min]))) {
      propFailures++; console.error(`  seed ${seed} ${date}: override did not replace weekly windows`);
    }
    let cap = 0;
    for (const w of wins) {
      const starts = slotStarts(w, slotMin, bufMin);
      for (const s of starts) {
        // Invariant 3: every slot is inside its window and on the grid.
        if (s < w.start_min || s + slotMin > w.end_min || (s - w.start_min) % step !== 0) {
          propFailures++; console.error(`  seed ${seed} ${date}: slot ${s} off-grid in [${w.start_min},${w.end_min}] step ${step}`);
        }
      }
      // Invariant 4: slot count matches the closed-form count.
      const expectN = Math.max(0, Math.floor((w.end_min - w.start_min - slotMin) / step) + 1);
      if (starts.length !== expectN) {
        propFailures++; console.error(`  seed ${seed} ${date}: ${starts.length} slots, expected ${expectN}`);
      }
      cap += starts.length * Math.max(1, w.capacity || 1);
    }
    // Invariant 5: daySlotCapacity agrees with per-window sums.
    if (daySlotCapacity(wins, slotMin, bufMin) !== cap) {
      propFailures++; console.error(`  seed ${seed} ${date}: capacity mismatch`);
    }
  }
}
if (propFailures === 0) console.log("  ✓ 300 random schedules × 7 days: all five invariants hold");
else { failures += propFailures; }

if (failures) { console.error(`\n✗ ivcal-slots: ${failures} failure(s)`); process.exit(1); }
console.log("\n✓ ivcal-slots: all tests passed");
