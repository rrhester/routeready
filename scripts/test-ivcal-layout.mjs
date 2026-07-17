// Unit + property tests for dashboard/ivcal-layout.js — the overlap-column
// algorithm behind side-by-side events on the calendar's time grids
// (calendar 100-list #90/#94). The invariant that matters: two events that
// overlap in TIME must never overlap in HORIZONTAL space.
import { layoutDay, layStyle } from "../dashboard/ivcal-layout.js";

let failures = 0;
function ok(cond, label, extra = "") {
  if (cond) { console.log("  ✓", label); return; }
  failures++;
  console.error("  ✗", label, extra);
}
const mk = (sm, em, tag) => ({ _sm: sm, _em: em, tag });

console.log("layoutDay · basics");
{
  const items = [];
  layoutDay(items);
  ok(items.length === 0, "empty input stays empty");
}
{
  const items = [mk(60, 120, "a")];
  layoutDay(items);
  ok(items[0]._lx === 0 && items[0]._lw === 100, "single event gets full width");
}
{
  const items = [mk(60, 120, "a"), mk(120, 180, "b")];
  layoutDay(items);
  ok(items.every(i => i._lw === 100), "back-to-back events don't split the column");
}
{
  const items = [mk(60, 120, "a"), mk(90, 150, "b")];
  layoutDay(items);
  ok(items[0]._lw === 50 && items[1]._lw === 50, "two overlapping events split 50/50");
  ok(items[0]._lx !== items[1]._lx, "…in different columns");
}
{
  // Column reuse: c starts after a ends, so it can share a's column even
  // though b is still running.
  const items = [mk(0, 60, "a"), mk(30, 120, "b"), mk(60, 90, "c")];
  layoutDay(items);
  const byTag = Object.fromEntries(items.map(i => [i.tag, i]));
  ok(byTag.a._col === byTag.c._col, "a freed column is reused");
  ok(items.every(i => i._lw === 50), "cluster of 3 with max 2 concurrent uses 2 columns");
}

console.log("layStyle");
ok(layStyle(null) === "", "null lay → empty string");
ok(layStyle({ lx: 0, lw: 100 }).includes("left:calc(0%"), "full-width style anchors left");
ok(/width:calc\(50%/.test(layStyle({ lx: 50, lw: 50 })), "half-width style carries 50%");

console.log("layoutDay · property (seeded random schedules)");
// Deterministic PRNG so failures reproduce.
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
let propFailures = 0;
for (let seed = 1; seed <= 200; seed++) {
  const rnd = mulberry32(seed);
  const n = 1 + Math.floor(rnd() * 12);
  const items = [];
  for (let i = 0; i < n; i++) {
    const sm = Math.floor(rnd() * 22 * 60);
    const dur = 15 + Math.floor(rnd() * 8) * 15;
    items.push(mk(sm, sm + dur, "e" + i));
  }
  layoutDay(items);
  for (const it of items) {
    if (typeof it._lx !== "number" || typeof it._lw !== "number" || it._lw <= 0 || it._lx < 0 || it._lx + it._lw > 100.001) {
      propFailures++; console.error(`  seed ${seed}: bad geometry`, it); break;
    }
  }
  // Core invariant: time overlap ⇒ no horizontal overlap.
  outer:
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i], b = items[j];
      const timeOverlap = a._sm < b._em && b._sm < a._em;
      if (!timeOverlap) continue;
      const xOverlap = a._lx < b._lx + b._lw - 0.001 && b._lx < a._lx + a._lw - 0.001;
      if (xOverlap) {
        propFailures++;
        console.error(`  seed ${seed}: ${a.tag}(${a._sm}-${a._em} @${a._lx}) overlaps ${b.tag}(${b._sm}-${b._em} @${b._lx})`);
        break outer;
      }
    }
  }
}
ok(propFailures === 0, "200 random days: overlapping events never share horizontal space");

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log("\nAll ivcal-layout tests passed.");
